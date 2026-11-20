// Test harness: serves the site from the repo and replaces Supabase with an in-memory fake,
// so the real app runs in a real browser without touching production data.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm', '.css': 'text/css' };

function serve() {
  return new Promise(ok => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      if (p === '/decision') p = '/decision/index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => ok({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const USERS = {
  owner: { id: '00000000-0000-0000-0000-00000000000a', name: 'فارس', role: 'owner', page_id: null, active: true, maker: false },
  billing: { id: '00000000-0000-0000-0000-00000000000c', name: 'محاسب', role: 'billing', page_id: null, active: true, maker: false },
  maker: { id: '00000000-0000-0000-0000-0000000000b1', name: 'صلاح', role: 'stock', page_id: null, active: true, maker: true },
};

// Empty-but-correctly-shaped answers for functions that return an object, not a list.
const RPC_SHAPES = { shortage_report: { empties: [], oils: [], invoices: [] }, short_lines: {}, work_progress: { workers: [], declined: [] } };

// Fake Supabase. `rpc` maps a function name to a handler (body, state) -> result; tables return [] unless given.
async function fakeSupabase(page, { user, rpc = {}, tables = {} }) {
  const jwt = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: user.id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, email: 'x@pages.local' }) + '.sig';
  const calls = [];
  const J = (r, o, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
  await page.route(/fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/, r => r.abort());
  await page.route(/supabase\.co\/auth\/v1\/token/, r => J(r, { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r',
    user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: 'x@pages.local', app_metadata: {}, user_metadata: {} } }));
  await page.route(/supabase\.co\/auth\/v1\/(user|logout)/, r => J(r, { id: user.id, aud: 'authenticated', role: 'authenticated', email: 'x@pages.local' }));
  await page.route(/supabase\.co\/(realtime|functions)/, r => r.abort());
  await page.route(/supabase\.co\/rest\/v1\//, async r => {
    const u = new URL(r.request().url());
    const name = u.pathname.replace('/rest/v1/', '');
    let body = {};
    try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) { /* GET */ }
    calls.push({ name, body, method: r.request().method() });
    if (name === 'profiles') return J(r, (r.request().headers().accept || '').includes('pgrst.object') ? user : [user]);
    if (name.startsWith('rpc/')) {
      const fn = name.slice(4);
      if (rpc[fn]) { const out = await rpc[fn](body); return out && out.__status ? J(r, out.body, out.__status) : J(r, out); }
      return J(r, fn in RPC_SHAPES ? RPC_SHAPES[fn] : []);
    }
    return J(r, tables[name] || []);
  });
  return calls;
}

async function login(page, base) {
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.fill('#lgU', '01000000000');
  await page.fill('#lgP', 'x');
  await page.click('#lgBtn');
  await page.waitForFunction(() => typeof ME !== 'undefined' && ME && document.querySelector('#main') && document.querySelector('#main').innerText.length > 20, null, { timeout: 30000 });
  await page.evaluate(() => { for (const id of ['wlc', 'pvPad']) { const e = document.getElementById(id); if (e) e.hidden = true; } });
}

async function browser() { return chromium.launch(); }
async function newPage(b, vp = { width: 390, height: 844 }) {
  const ctx = await b.newContext({ viewport: vp, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  return { ctx, page, errors };
}
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

module.exports = { ROOT, serve, USERS, fakeSupabase, login, browser, newPage, overflow };
