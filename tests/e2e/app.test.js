// End-to-end tests for AF Group: the real pages in a real browser, against a fake Supabase.
// Nothing here talks to production. Run: npm test (in tests/e2e)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./harness');

let S, B;
test.before(async () => { S = await H.serve(); B = await H.browser(); });
test.after(async () => { await B.close(); S.srv.close(); });

const read = f => fs.readFileSync(path.join(H.ROOT, f), 'utf8');
const inline = html => [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);

// ---------- 1) static checks: catch a broken or outdated upload before anyone opens it ----------
test('every inline script in every page parses', () => {
  for (const f of ['index.html', 'decision/index.html']) {
    const sc = inline(read(f));
    assert.ok(sc.length > 0, f + ' has no inline script');
    sc.forEach((s, i) => assert.doesNotThrow(() => new Function(s), `${f} script #${i} has a syntax error`));
  }
  assert.doesNotThrow(() => new Function(read('sw.js')), 'sw.js syntax');
  assert.doesNotThrow(() => new Function(read('decision/engine.js')), 'engine.js syntax');
});

test('no secret keys shipped to the browser', () => {
  const pub = ['index.html', 'decision/index.html', 'sw.js', 'decision/engine.js', 'manifest.json'].map(read).join('\n');
  // a Supabase service_role JWT carries "role":"service_role" in its payload
  for (const m of pub.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)) {
    let payload = '';
    try { payload = Buffer.from(m[1], 'base64url').toString(); } catch (e) { /* not a JWT */ }
    assert.ok(!/service_role/.test(payload), 'service_role key found in a public file');
  }
  assert.ok(!/sb_secret_[A-Za-z0-9]/.test(pub), 'Supabase secret key found in a public file');
  assert.ok(!/sk-ant-[A-Za-z0-9]/.test(pub), 'Anthropic key found in a public file');
  assert.ok(!/vapid_private\s*[:=]\s*['"]|hook_secret\s*[:=]\s*['"][^'"]{8,}/.test(pub), 'push secret found in a public file');
});

// Features already shipped. If a manual upload of an older index.html removes one, this fails.
test('shipped features are still in the code (guards against uploading an old file)', () => {
  const src = { 'index.html': read('index.html'), 'decision/index.html': read('decision/index.html'), 'decision/engine.js': read('decision/engine.js') };
  const must = {
    'index.html': [['planBox(', 'شغلك النهارده'], ['asgWarn(', 'تحذير صنف متوزع على عامل تاني'], ['shWAText(', 'رسالة واتساب النواقص'],
      ['dclink', 'زرار مركز القرار'], ['request_override', 'طلب سماح'], ['loadAssign(', 'تحميل التكليفات']],
    'decision/index.html': [['sendWork(', 'إرسال التوزيع'], ['loadProgress(', 'متابعة العمال'], ['whyBatch(', 'شرح سبب التوزيع'], ['متخلطهمش', 'تحذير التركيزات']],
    'decision/engine.js': [['otherConc', 'فصل التركيزات'], ['function assignWork', 'توزيع الشغل'], ['function verify', 'المدقق']],
  };
  for (const [f, list] of Object.entries(must)) for (const [needle, what] of list) assert.ok(src[f].includes(needle), `${f}: missing "${what}" (${needle})`);
});

test('money formatting rounds to 2 decimals and groups thousands', async () => {
  const { ctx, page } = await H.newPage(B);
  await page.goto(S.url + '/', { waitUntil: 'load' });
  const r = await page.evaluate(() => [fmt(1234567.891), fmt(0.1 + 0.2), fmt(-1500), fmt(''), fmt(null), fmt('12.5')]);
  assert.deepEqual(r, ['1,234,567.89', '0.3', '-1,500', '0', '0', '12.5']);
  await ctx.close();
});

// ---------- 2) every screen of every role opens without a script error ----------
const ROLE_RUNS = [['owner', { width: 390, height: 844 }], ['owner', { width: 1366, height: 900 }], ['billing', { width: 390, height: 844 }], ['maker', { width: 390, height: 844 }]];
for (const [role, vp] of ROLE_RUNS) {
  test(`${role} @${vp.width}px: every tab opens with no error and no sideways scroll`, async () => {
    const { ctx, page, errors } = await H.newPage(B, vp);
    await H.fakeSupabase(page, { user: H.USERS[role] });
    await H.login(page, S.url);
    const tabs = await page.evaluate(() => [...document.querySelectorAll('#tabs a[data-tab]')].map(a => a.dataset.tab));
    assert.ok(tabs.length > 0, 'no tabs rendered');
    const bad = [];
    for (const t of tabs) {
      await page.evaluate(k => go(k), t);
      await page.waitForTimeout(150);
      if (await H.overflow(page)) bad.push(t + ': sideways scroll');
      const txt = await page.evaluate(() => document.querySelector('#main').innerText.length);
      if (!txt) bad.push(t + ': empty screen');
    }
    assert.deepEqual(errors, [], 'script errors: ' + errors.join(' | '));
    assert.deepEqual(bad, []);
    await ctx.close();
  });
}

test('role limits: billing and maker never see the decision center or cost data', async () => {
  for (const role of ['billing', 'maker']) {
    const { ctx, page } = await H.newPage(B);
    const calls = await H.fakeSupabase(page, { user: H.USERS[role] });
    await H.login(page, S.url);
    const seen = await page.evaluate(() => !!document.querySelector('a.dclink, .dcard'));
    assert.equal(seen, false, role + ' can see the decision center entry');
    assert.ok(!calls.some(c => c.name === 'product_costs' || c.name === 'invoice_line_costs'), role + ' requested cost tables');
    assert.ok(!calls.some(c => c.name === 'rpc/work_progress' || c.name === 'rpc/assign_work'), role + ' called owner-only work functions');
    await ctx.close();
  }
});

// ---------- 3) worker flow: today's assignments ----------
function workerWorld() {
  const now = new Date().toISOString();
  const L = (lid, pid, name, qty, g, x = {}) => ({ lid, pid, name, qty, price: 0, track: true, g, oil: 'زيت ' + name, oid: 'o' + pid, ck: false, rd: false, ck_by: null, ck_at: null, cl_by: null, cl_at: null, cl_me: false, ...x });
  const me = H.USERS.maker.id, other = '00000000-0000-0000-0000-0000000000b2';
  const queue = [{ id: 'i1', no: 'EB-249', page: 'EB', date: '2026-11-19', cust: 'عميل', done: false, lines: [
    L('l1', 'p1', 'جان بول لابيلا', 12, 15), L('l2', 'p1', 'جان بول لابيلا', 12, 7.5), L('l3', 'p2', 'سبانش توباكو', 12, 10), L('l4', 'p3', 'ماي سليف', 12, 15)] }];
  const A = (line, worker, name, pos) => ({ line, worker, name, pos, mins: 31.6, qty: 12, at: now, done: false, done_by: null });
  return { queue, asg: [A('l1', me, 'صلاح', 1), A('l3', me, 'صلاح', 2), A('l2', other, 'حسين', 1)] };
}

test('worker: sees his list in order, starts an item, hands one back, is warned before taking another worker\'s item', async () => {
  const W = workerWorld();
  const { ctx, page, errors } = await H.newPage(B);
  const dialogs = [];
  page.removeAllListeners('dialog');
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  const calls = await H.fakeSupabase(page, { user: H.USERS.maker, rpc: {
    fulfillment_queue: () => W.queue,
    work_assignments_active: () => W.asg,
    claim_lines: b => { for (const l of W.queue[0].lines) if (b.p_lines.includes(l.lid)) { l.cl_me = b.p_on; l.cl_by = b.p_on ? 'صلاح' : null; } return { skipped: [] }; },
    unassign_work: b => { const n = W.asg.length; W.asg = W.asg.filter(a => !(b.p_lines.includes(a.line) && a.worker === H.USERS.maker.id)); return { released: n - W.asg.length }; },
    short_lines: () => ({}),
  } });
  await H.login(page, S.url);
  const rows = await page.$$eval('#main .plan .pit .pn b', e => e.map(x => x.textContent));
  assert.deepEqual(rows, ['جان بول لابيلا', 'سبانش توباكو']);
  const first = await page.$eval('#main .plan .pit', e => e.innerText);
  assert.match(first, /تركيز 15 جم/);
  assert.match(first, /بتركيز تاني/);

  await page.click('#main .plan .pit.now [data-x="wkClaimB"]');
  await page.waitForTimeout(800);
  const claim = calls.find(c => c.name === 'rpc/claim_lines');
  assert.deepEqual(claim.body, { p_lines: ['l1'], p_on: true }, 'start must claim exactly the assigned line');

  await page.locator('#main .plan .pit', { hasText: 'سبانش توباكو' }).locator('[data-x="wkNo"]').click();
  await page.waitForTimeout(800);
  assert.deepEqual(calls.find(c => c.name === 'rpc/unassign_work').body.p_lines, ['l3']);

  const before = dialogs.length;
  // l2 (same item, 7.5 g) is assigned to حسين; after l1 was started it shows inside the worker's own card
  await page.click('#main [data-x="wkClaim"][data-lid="l2"]');
  await page.waitForTimeout(600);
  assert.ok(dialogs.slice(before).some(m => m.includes('حسين')), 'no warning before taking an item assigned to another worker');
  // the warning was accepted, so the claim goes through (warning, not a block)
  assert.deepEqual(calls.filter(c => c.name === 'rpc/claim_lines').pop().body, { p_lines: ['l2'], p_on: true });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('worker: if the assignments service is down, the work screen still works as before', async () => {
  const W = workerWorld();
  const { ctx, page, errors } = await H.newPage(B);
  await H.fakeSupabase(page, { user: H.USERS.maker, rpc: {
    fulfillment_queue: () => W.queue, short_lines: () => ({}),
    work_assignments_active: () => ({ __status: 500, body: { message: 'boom' } }),
  } });
  await H.login(page, S.url);
  assert.equal(await page.$('#main .plan'), null);
  assert.ok((await page.$$('#main .wcard')).length > 0, 'work cards missing');
  assert.deepEqual(errors, []);
  await ctx.close();
});
