// Mathematical tests for the AF Group decision engine.
// Run: cd decision && npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const GLPK = require('glpk.js');
const HIGHS = require('highs');
const A = require('../engine.js');

// HiGHS is the production solver; GLPK is kept as an independent second solver for cross-checking.
let glpk, G, H;
test.before(async () => { G = await GLPK(); glpk = A.glpkAdapter(G); H = A.highsAdapter(await HIGHS()); });

// ---- tiny hand-checkable world ----
// oil o1: 60 g on hand, 2 EGP/g from supplier s1. empty e1: 100 on shelf, 5 EGP each.
// line a (invoice i1, rank 1): 10 pcs x 5 g = 50 g, price 100
// line b (invoice i2, rank 2): 10 pcs x 5 g = 50 g, price 100
function world(over) {
  return Object.assign({
    at: '2026-11-19T10:00:00Z',
    lines: [
      { id: 'a', inv_id: 'i1', no: 'T-1', date: '2026-11-18', rank: 1, cust: 'x', name: 'p', qty: 10, price: 100, page_pc: 0, grams: 5, oil_id: 'o1', empty_id: 'e1', track: true },
      { id: 'b', inv_id: 'i2', no: 'T-2', date: '2026-11-18', rank: 2, cust: 'y', name: 'q', qty: 10, price: 100, page_pc: 0, grams: 5, oil_id: 'o1', empty_id: 'e1', track: true },
    ],
    oils: [{ id: 'o1', name: 'oil1', cnt_no: 1, stock: 60, cost: 2 }],
    prices: [{ oil_id: 'o1', sup_id: 's1', ppg: 2, date: '2026-11-01', inv_no: '1' }],
    empties: [{ id: 'e1', name: 'emp1', cnt_no: 1, shelf: 100, cost: 5 }],
    suppliers: [{ id: 's1', name: 'S1' }], usage: [], workers: [],
  }, over || {});
}
const ids = r => r.decision.filledIds.slice().sort();

test('no budget: only the higher-ranked line is filled, nothing bought', async () => {
  const r = await A.solvePlan(H, world(), { budget: 0 });
  assert.equal(r.status, 'OPTIMAL');
  assert.deepEqual(ids(r), ['a']);
  assert.equal(r.decision.buys.length, 0);
  assert.equal(r.ver.ok, true);
});

test('enough budget: both filled, buys exactly one 125 g lot, cost and value match hand calc', async () => {
  const r = await A.solvePlan(H, world(), { budget: 1000 });
  assert.equal(r.status, 'OPTIMAL');
  assert.deepEqual(ids(r), ['a', 'b']);
  // need 100 g, have 60 -> short 40 -> 1 lot of 125 g at 2 EGP/g = 250
  assert.equal(r.decision.buys.length, 1);
  assert.equal(r.decision.buys[0].qty, 125);
  assert.equal(r.p.buyCost, 250);
  // value = 10*(100+1000*2) + 10*(100+1000*1) + 0.2*(1000+1000) - 250
  assert.equal(Math.round(r.decision.z), 21000 + 11000 + 400 - 250);
  assert.equal(r.ver.ok, true);
});

test('budget one pound short of the lot: second line is not filled', async () => {
  const r = await A.solvePlan(H, world(), { budget: 249 });
  assert.deepEqual(ids(r), ['a']);
  assert.equal(r.p.buyCost, 0);
});

test('cash mode picks the more valuable line regardless of rank', async () => {
  const w = world(); w.lines[1].price = 300;
  const r = await A.solvePlan(H, w, { budget: 0, mode: 'cash' });
  assert.deepEqual(ids(r), ['b']);
});

test('negative stock is treated as zero and reported', async () => {
  const w = world({ oils: [{ id: 'o1', name: 'oil1', cnt_no: 1, stock: -30, cost: 2 }] });
  const r = await A.solvePlan(H, w, { budget: 0 });
  assert.deepEqual(ids(r), []);
  assert.ok(r.m.warn.some(x => x.includes('سالب')));
});

test('oil with no recorded price is never bought and no price is invented', async () => {
  const w = world({ prices: [], oils: [{ id: 'o1', name: 'oil1', cnt_no: 1, stock: 60, cost: null }] });
  const r = await A.solvePlan(H, w, { budget: 1e6 });
  assert.deepEqual(ids(r), ['a']);
  assert.equal(r.decision.buys.length, 0);
  assert.deepEqual(r.m.noPrice, ['o1']);
  // owner-approved price for this analysis unlocks the purchase
  const r2 = await A.solvePlan(H, w, { budget: 1e6, priceOverride: { o1: 3 } });
  assert.deepEqual(ids(r2), ['a', 'b']);
  assert.equal(r2.p.buyCost, 375);
});

test('purchase unit per oil: inferred from recorded purchases, owner override wins, default otherwise', async () => {
  const mk = (qty, unit) => world({ prices: [{ oil_id: 'o1', sup_id: 's1', ppg: 2, src_qty: qty, src_unit: unit }] });
  assert.deepEqual(A.lotOf(mk(2, 'kg'), {}, 'o1').lot, 1000);
  assert.deepEqual(A.lotOf(mk(375, 'g'), {}, 'o1').lot, 125);
  assert.deepEqual(A.lotOf(mk(731, 'g'), {}, 'o1').lot, 1);
  assert.deepEqual(A.lotOf(mk(1.5, 'kg'), {}, 'o1').lot, 500);
  assert.equal(A.lotOf(world(), {}, 'o1').src, 'default');
  assert.equal(A.lotOf(mk(2, 'kg'), { lotByOil: { o1: 50 } }, 'o1').lot, 50);
  // short 40 g: by the kilo -> 1000 g (2000 EGP); by the gram -> exactly 40 g (80 EGP)
  const kg = await A.solvePlan(H, mk(2, 'kg'), { budget: 1e6 });
  assert.equal(kg.decision.buys[0].qty, 1000); assert.equal(kg.p.buyCost, 2000); assert.equal(kg.ver.ok, true);
  const g = await A.solvePlan(H, mk(731, 'g'), { budget: 1e6 });
  assert.equal(g.decision.buys[0].qty, 40); assert.equal(g.p.buyCost, 80); assert.equal(g.ver.ok, true);
  // a decision that ignores the oil's unit is rejected by the verifier
  const v = A.verify(mk(2, 'kg'), { budget: 1e6 }, { filledIds: ['a', 'b'], buys: [{ kind: 'oil', id: 'o1', sup: 's1', qty: 125, lot: 125, ppg: 2 }], z: 0 });
  assert.ok(v.checks.some(c => !c.ok && c.name.includes('وحدة شراء')));
});

test('empty with no cost is never bought', async () => {
  const w = world({ empties: [{ id: 'e1', name: 'emp1', cnt_no: 1, shelf: 10, cost: null }] });
  const r = await A.solvePlan(H, w, { budget: 1e6 });
  assert.deepEqual(ids(r), ['a']);
  assert.deepEqual(r.m.noCost, ['e1']);
});

test('disabled supplier is not used', async () => {
  const w = world({ oils: [{ id: 'o1', name: 'oil1', cnt_no: 1, stock: 60, cost: null }] });
  const r = await A.solvePlan(H, w, { budget: 1e6, supOn: { s1: false } });
  assert.deepEqual(ids(r), ['a']);
});

test('supplier spend cap is respected', async () => {
  const r = await A.solvePlan(H, world(), { budget: 1e6, supCap: { s1: 100 } });
  assert.deepEqual(ids(r), ['a']);
});

test('line without grams is modelled without oil and flagged', async () => {
  const w = world(); w.lines[1].grams = null;
  const r = await A.solvePlan(H, w, { budget: 0 });
  assert.deepEqual(ids(r), ['a', 'b']);
  assert.ok(r.m.warn.some(x => x.includes('من غير جرامات')));
});

test('verifier rejects a tampered decision', async () => {
  const w = world();
  const r = await A.solvePlan(H, w, { budget: 0 });
  const forged = { filledIds: ['a', 'b'], buys: [], z: r.decision.z };
  const v = A.verify(w, { budget: 0 }, forged);
  assert.equal(v.ok, false);
  assert.ok(v.checks.some(c => !c.ok && c.name.startsWith('الزيت')));
});

test('verifier rejects overspending the budget and a wrong price', async () => {
  const w = world();
  const over = A.verify(w, { budget: 100 }, { filledIds: ['a', 'b'], buys: [{ kind: 'oil', id: 'o1', sup: 's1', qty: 125, lot: 125, ppg: 2 }], z: 0 });
  assert.ok(over.checks.some(c => !c.ok && c.name.includes('الميزانية')));
  const cheap = A.verify(w, { budget: 1000 }, { filledIds: ['a', 'b'], buys: [{ kind: 'oil', id: 'o1', sup: 's1', qty: 125, lot: 125, ppg: 1 }], z: 0 });
  assert.ok(cheap.checks.some(c => !c.ok && c.name.includes('أسعار')));
});

test('model validation catches a non-finite coefficient', async () => {
  const w = world(); w.lines[0].price = 'abc';
  const m = A.buildPlan(w, {});
  // pos() coerces bad input to 0, so the model stays finite; a NaN injected directly must be caught
  m.lp.objective.vars[0].coef = NaN;
  assert.ok(A.validateModel(m.lp).length > 0);
});

test('no open lines -> INVALID_MODEL, not a crash', async () => {
  const r = await A.solvePlan(H, world({ lines: [] }), {});
  assert.equal(r.status, 'INVALID_MODEL');
});

test('solver states: infeasible and unbounded are detected by both solvers (LP and MILP)', async () => {
  const mk = (name, ubs, extra) => Object.assign({ name, objective: { direction: 2, name: 'o', vars: [{ name: 'x', coef: 1 }, { name: 'w', coef: 0 }] },
    subjectTo: ubs.map((c, k) => ({ name: 'c' + k, vars: c.vars, bnds: { type: 3, ub: c.ub, lb: 0 } })), bounds: [], binaries: [], generals: [] }, extra || {});
  // x <= 1 and -x <= -2  -> infeasible.   -x + w <= 0 with max x -> unbounded.
  const inf = [{ vars: [{ name: 'x', coef: 1 }], ub: 1 }, { vars: [{ name: 'x', coef: -1 }], ub: -2 }];
  const unb = [{ vars: [{ name: 'x', coef: -1 }, { name: 'w', coef: 1 }], ub: 0 }];
  for (const [lp, want] of [[mk('inf', inf), 'INFEASIBLE'], [mk('infI', inf, { generals: ['x'] }), 'INFEASIBLE'], [mk('unb', unb), 'UNBOUNDED'], [mk('unbI', unb, { generals: ['x'] }), 'UNBOUNDED']])
    for (const S of [H, glpk]) assert.equal((await S.solve(lp, 10)).status, want, lp.name + ' / ' + S.name);
});

// ---- independent brute force: enumerate every subset of lines ----
function brute(snap, P) {
  P = A.defaults(P);
  const L = snap.lines, n = L.length;
  const invIds = [...new Set(L.map(l => l.inv_id))];
  const first = new Map(); for (const l of L) if (!first.has(l.inv_id)) first.set(l.inv_id, l);
  const order = [...first.values()].sort((a, b) => (a.rank ?? 1e6) - (b.rank ?? 1e6) || String(a.date).localeCompare(String(b.date)) || String(a.no).localeCompare(String(b.no)));
  const rk = new Map(order.map((l, i) => [l.inv_id, i + 1])); const R = invIds.length;
  const cheapest = new Map();
  for (const p of snap.prices) if (!cheapest.has(p.oil_id) || p.ppg < cheapest.get(p.oil_id)) cheapest.set(p.oil_id, +p.ppg);
  for (const o of snap.oils) if (!cheapest.has(o.id) && o.cost != null && +o.cost > 0) cheapest.set(o.id, +o.cost);
  let best = -Infinity, bestSet = null;
  for (let mask = 0; mask < (1 << n); mask++) {
    const on = L.filter((_, i) => mask >> i & 1);
    const needO = new Map(), needE = new Map();
    for (const l of on) {
      if (l.oil_id && +l.grams) needO.set(l.oil_id, (needO.get(l.oil_id) || 0) + l.qty * l.grams);
      if (l.track && l.empty_id) needE.set(l.empty_id, (needE.get(l.empty_id) || 0) + l.qty);
    }
    let cost = 0, ok = true;
    for (const [oid, need] of needO) {
      const o = snap.oils.find(x => x.id === oid) || { stock: 0 };
      const short = need - Math.max(0, +o.stock || 0);
      if (short > 1e-9) { if (!cheapest.has(oid)) { ok = false; break; } { const LT = A.lotOf(snap, P, oid).lot; cost += Math.ceil(short / LT - 1e-9) * LT * cheapest.get(oid); } }
    }
    if (ok) for (const [eid, need] of needE) {
      const e = snap.empties.find(x => x.id === eid) || { shelf: 0 };
      const short = need - Math.max(0, +e.shelf || 0);
      if (short > 1e-9) { if (!P.buyEmpties || e.cost == null) { ok = false; break; } cost += short * +e.cost; }
    }
    if (!ok || cost > P.budget + 1e-9) continue;
    let v = -cost;
    for (const l of on) v += l.qty * ((+l.price - (+l.page_pc || 0)) + (P.mode === 'rank' ? A.PRIO * (R + 1 - rk.get(l.inv_id)) : 0));
    if (P.wholeInv) for (const iid of invIds) {
      const all = L.filter(l => l.inv_id === iid);
      if (all.every(l => on.includes(l))) v += A.WHOLE * all.reduce((s, l) => s + l.qty * (+l.price - (+l.page_pc || 0)), 0);
    }
    if (v > best + 1e-9) { best = v; bestSet = mask; }
  }
  return { best, bestSet };
}

function rng(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; }
function randomWorld(seed) {
  const r = rng(seed), ri = (a, b) => a + Math.floor(r() * (b - a + 1));
  const nO = ri(1, 3), nE = ri(1, 3), nI = ri(1, 4), nL = ri(3, 9);
  const oils = [], prices = [], empties = [], lines = [];
  for (let i = 0; i < nO; i++) {
    oils.push({ id: 'o' + i, name: 'oil' + i, cnt_no: i, stock: ri(-50, 400), cost: r() < 0.15 ? null : ri(1, 6) });
    if (r() < 0.8) prices.push(Object.assign({ oil_id: 'o' + i, sup_id: 's1', ppg: ri(1, 6) }, r() < 0.7 ? { src_qty: [1, 2, 0.5, 250, 375, 731, 40][ri(0, 6)], src_unit: r() < 0.5 ? 'kg' : 'g' } : {}));
    if (r() < 0.4) prices.push({ oil_id: 'o' + i, sup_id: 's2', ppg: ri(1, 6) });
  }
  for (let i = 0; i < nE; i++) empties.push({ id: 'e' + i, name: 'emp' + i, cnt_no: i, shelf: ri(-5, 40), cost: r() < 0.15 ? null : ri(5, 60) });
  for (let i = 0; i < nL; i++) {
    const inv = ri(0, nI - 1);
    lines.push({ id: 'l' + i, inv_id: 'i' + inv, no: 'N' + inv, date: '2026-11-1' + inv, rank: inv + 1, cust: 'c', name: 'p' + i,
      qty: ri(1, 30), price: ri(40, 400), page_pc: ri(0, 10), grams: r() < 0.1 ? null : ri(3, 15), oil_id: 'o' + ri(0, nO - 1), empty_id: 'e' + ri(0, nE - 1), track: r() < 0.9 });
  }
  return { at: '2026-11-19T10:00:00Z', lines, oils, prices, empties, suppliers: [{ id: 's1', name: 'S1' }, { id: 's2', name: 'S2' }], usage: [], workers: [] };
}

test('HiGHS = GLPK = exhaustive enumeration on 120 random instances (both modes, with and without budget)', async () => {
  let n = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const w = randomWorld(seed * 7919);
    for (const P of [{ budget: [0, 300, 1500, 1e12][seed % 4], mode: 'rank', wholeInv: seed % 3 !== 0 }, { budget: [1e12, 800, 0, 2500][seed % 4], mode: 'cash', buyEmpties: seed % 5 !== 0 }]) {
      const ref = brute(w, P);
      const r = await A.solvePlan(H, w, P, 20);
      assert.equal(r.status, 'OPTIMAL', `seed ${seed}`);
      const g = await A.solvePlan(glpk, w, P, 20);
      assert.equal(g.status, 'OPTIMAL', `glpk seed ${seed}`);
      assert.ok(Math.abs(g.decision.z - r.decision.z) <= 1e-6 * Math.max(1, Math.abs(r.decision.z)), `seed ${seed}: GLPK ${g.decision.z} vs HiGHS ${r.decision.z}`);
      assert.ok(Math.abs(r.decision.z - ref.best) <= 1e-6 * Math.max(1, Math.abs(ref.best)), `seed ${seed} ${JSON.stringify(P)}: solver ${r.decision.z} vs brute ${ref.best}`);
      assert.equal(r.ver.ok, true, `seed ${seed}: verifier ` + JSON.stringify(r.ver.checks.filter(c => !c.ok)));
      n++;
    }
  }
  assert.equal(n, 120);
});

// ---- Monte Carlo ----
test('simulation is reproducible and behaves at the extremes', () => {
  const w = world({ usage: [{ oil_id: 'o1', d: '2026-11-10', g: 100 }, { oil_id: 'o1', d: '2026-11-12', g: 50 }], lines: [] });
  const a = A.simulate(w, { horizon: 7, runs: 2000 }), b = A.simulate(w, { horizon: 7, runs: 2000 });
  assert.deepEqual(a.rows, b.rows);
  const row = a.rows.find(x => x.id === 'o1');
  assert.ok(row.pOut >= 0 && row.pOut <= 1);
  // mean daily use = 150 g over 9 full days
  assert.ok(Math.abs(row.avgDay - 150 / a.nDays) < 1e-9);
  // huge stock -> zero risk; zero stock with usage -> risk close to 1 over a long horizon
  const safe = A.simulate(world({ lines: [], usage: w.usage, oils: [{ id: 'o1', name: 'o', cnt_no: 1, stock: 1e9, cost: 2 }] }), {}).rows[0];
  assert.equal(safe.pOut, 0);
  const risky = A.simulate(world({ lines: [], usage: w.usage, oils: [{ id: 'o1', name: 'o', cnt_no: 1, stock: 0, cost: 2 }] }), { horizon: 60 }).rows[0];
  assert.ok(risky.pOut > 0.99);
});

// ---- today plan: batching + work distribution ----
test('batches merge the same product across orders; distribution is complete, balanced and respects started work', () => {
  const L = [];
  let k = 0;
  const add = (oil, emp, qty, rk, no) => L.push({ id: 'l' + (k++), name: 'p' + oil, oil_id: 'o' + oil, empty_id: 'e' + emp, qty, rk, no, cust: 'c' });
  add(1, 1, 12, 1, 'A'); add(1, 1, 24, 2, 'B'); add(1, 1, 4, 3, 'C');   // same product in 3 orders -> one batch of 40
  for (let i = 2; i <= 13; i++) add(i, i, 3 + (i * 7) % 20, 1 + i % 3, 'A');
  const B = A.makeBatches(L);
  assert.equal(B.length, 13);
  const big = B.find(b => b.key === 'o1|e1|?');
  assert.equal(big.qty, 40); assert.equal(big.lines.length, 3); assert.equal(big.rank, 1);
  const workers = [{ id: 'w1', name: 'a' }, { id: 'w2', name: 'b' }, { id: 'w3', name: 'c' }];
  const timing = { n: 148, setup: 18.57, per_pc: 1.088 };
  const claims = [{ line: 'l5', by: 'w3' }, { line: 'l6', by: 'gone' }];
  const R = A.assignWork(B, workers, claims, timing);
  assert.equal(R.timed, true);
  // every batch assigned exactly once
  const all = R.workers.flatMap(w => w.batches.map(b => b.key)).sort();
  assert.deepEqual(all, B.map(b => b.key).sort());
  // started line stays with its worker; a claim by someone not on the list is ignored
  assert.ok(R.workers.find(w => w.id === 'w3').batches.some(b => b.held && b.lines.some(l => l.id === 'l5')));
  // minutes follow the measured model, and totals add up
  const tot = B.reduce((s, b) => s + 18.57 + 1.088 * b.qty, 0);
  assert.ok(Math.abs(R.workers.reduce((s, w) => s + w.mins, 0) - tot) < 1e-6);
  // balance: the gap between the busiest and the least busy worker never exceeds the biggest single batch
  const loads = R.workers.map(w => w.mins), maxB = Math.max(...B.map(b => 18.57 + 1.088 * b.qty));
  assert.ok(Math.max(...loads) - Math.min(...loads) <= maxB + 1e-9);
  // every batch carries its reason; a worker's minutes = batches x setup + pieces x per-piece (shown to the owner)
  assert.ok(R.workers.every(w => w.batches.every(b => b.why && (b.why.type === 'held' || (b.why.type === 'balance' && b.why.others.length === 2)))));
  for (const w of R.workers) assert.ok(Math.abs(w.mins - (w.setupMins + w.pieceMins)) < 1e-9);
  // 'balance' reason is true: when it was given, nobody else had a smaller load
  for (const w of R.workers) for (const b of w.batches) if (b.why.type === 'balance') assert.ok(b.why.others.every(o => o.load >= b.why.before - 1e-9));
  // deterministic
  assert.deepEqual(A.assignWork(B, workers, claims, timing), R);
  // not enough measured data -> no minutes are shown, balance by pieces instead
  const R2 = A.assignWork(B, workers, [], { n: 5, setup: 18, per_pc: 1 });
  assert.equal(R2.timed, false); assert.ok(R2.workers.every(w => w.mins === 0 && w.batches.every(b => b.mins === null)));
  // no workers selected -> nothing is silently dropped
  assert.equal(A.assignWork(B, [], [], timing).unassigned.length, 13);
});

test('same item at two concentrations is never merged into one batch', () => {
  const L = [
    { id: 'a', no: 'EB-249', qty: 12, grams: 7.5, oil_id: 'o1', empty_id: 'e1', name: 'جان بول لابيلا' },
    { id: 'b', no: 'EB-249', qty: 12, grams: 15, oil_id: 'o1', empty_id: 'e1', name: 'جان بول لابيلا' },
    { id: 'c', no: 'EB-250', qty: 6, grams: 15, oil_id: 'o1', empty_id: 'e1', name: 'جان بول لابيلا' },
    { id: 'd', no: 'EB-249', qty: 12, grams: 10, oil_id: 'o2', empty_id: 'e2', name: 'ماي سليف' },
  ];
  const B = A.makeBatches(L);
  assert.equal(B.length, 3);
  const g15 = B.find(b => b.grams === 15), g75 = B.find(b => b.grams === 7.5), solo = B.find(b => b.name === 'ماي سليف');
  assert.equal(g15.qty, 18); assert.equal(g15.lines.length, 2); // same concentration across orders still merges
  assert.equal(g75.qty, 12);
  assert.ok(g15.otherConc && g75.otherConc); assert.ok(!solo.otherConc);
  assert.equal(B.reduce((s, b) => s + b.qty, 0), 42); // nothing lost
});

// ---------- capacity plan: nobody gets more than he can really do ----------
const capBatches = () => {
  const L = []; let k = 0;
  const add = (oil, qty, rk, no, w) => L.push({ id: 'l' + (k++), name: 'p' + oil, oil_id: 'o' + oil, empty_id: 'e' + oil, grams: 10, qty, rk, no, cust: 'c', w });
  for (let i = 1; i <= 30; i++) add(i, 12, i, 'A' + i, 12 * (1000 * (31 - i) + 200));  // 360 pieces, strictly decreasing priority
  return { L, B: A.makeBatches(L) };
};
const capWorkers = [{ id: 'w1', name: 'a' }, { id: 'w2', name: 'b' }, { id: 'w3', name: 'c' }];
const capRates = [{ id: 'w1', days: 6, pcs_day: 60 }, { id: 'w2', days: 5, pcs_day: 36 }, { id: 'w3', days: 1, pcs_day: 500 }];

test('worker rates: measured needs 2+ days, owner figure wins, unknown worker gets the median and is labelled', () => {
  const r = A.workerRates(capWorkers, capRates, { w2: 40 });
  assert.deepEqual(r.map(x => [x.perDay, x.src]), [[60, 'measured'], [40, 'owner'], [36, 'estimate']]);
  assert.equal(A.workerRates(capWorkers, [], {})[0].src, 'unknown');
  assert.equal(A.workerRates(capWorkers, [], {})[0].perDay, null);
});

test('capacity plan: respects each worker\'s capacity, takes the highest priority work, defers the rest, loses nothing', async () => {
  const highs = await HIGHS(); const solver = A.highsAdapter(highs);
  const { B } = capBatches();
  const P = await A.planCapacity(solver, B, A.workerRates(capWorkers, capRates, {}), [], { n: 148, setup: 18.57, per_pc: 1.088 }, 1);
  assert.equal(P.status, 'OK'); assert.ok(P.ok); assert.ok(P.choice.proven);
  for (const w of P.workers) assert.ok(w.pcs <= w.cap, `${w.name} over capacity`);
  assert.equal(P.assigned + P.deferredPcs, 360);
  assert.equal(P.assigned, 132);                         // 60 + 36 + 36 = 132 = 11 batches of 12
  const got = P.workers.flatMap(w => w.batches.map(b => b.rank)).sort((a, b) => a - b);
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]); // exactly the 11 highest-priority orders
  assert.ok(P.deferred.every(b => b.rank > 11));
  assert.ok(Math.abs(P.daysForAll - 360 / 132) < 1e-9);
  // brute-force check on a small case: the solver's choice equals the best subset
  const small = B.slice(0, 12).map((b, i) => Object.assign({}, b, { qty: [5, 9, 12, 7, 3, 14, 6, 8, 11, 4, 10, 13][i] }));
  const cap = 41, P2 = await A.planCapacity(solver, small, [{ id: 'x', name: 'x', perDay: cap, src: 'owner', days: 0 }], [], {}, 1);
  let best = 0;
  for (let m = 0; m < 1 << 12; m++) { let q = 0, v = 0; for (let i = 0; i < 12; i++) if (m >> i & 1) { q += small[i].qty; v += small[i].val; } if (q <= cap && v > best) best = v; }
  assert.equal(P2.workers[0].batches.reduce((s, b) => s + b.val, 0), best);
});

test('capacity plan: more days -> more work; enough days -> everything fits and it says so', async () => {
  const highs = await HIGHS(); const solver = A.highsAdapter(highs);
  const { B } = capBatches(); const R = A.workerRates(capWorkers, capRates, {});
  const p1 = await A.planCapacity(solver, B, R, [], {}, 1), p2 = await A.planCapacity(solver, B, R, [], {}, 2), p3 = await A.planCapacity(solver, B, R, [], {}, 3);
  assert.ok(p2.assigned > p1.assigned);
  assert.equal(p3.deferredPcs, 0); assert.equal(p3.assigned, 360); assert.ok(p3.ok);
});

test('capacity plan: started work stays with its worker and counts against his capacity', async () => {
  const highs = await HIGHS(); const solver = A.highsAdapter(highs);
  const { L, B } = capBatches();
  const claims = [{ line: L[29].id, by: 'w2' }, { line: L[28].id, by: 'w2' }, { line: L[27].id, by: 'w2' }, { line: L[26].id, by: 'w2' }]; // 48 pcs of the LOWEST priority, cap is 36
  const P = await A.planCapacity(solver, B, A.workerRates(capWorkers, capRates, {}), claims, {}, 1);
  const w2 = P.workers.find(w => w.id === 'w2');
  assert.equal(w2.batches.filter(b => b.held).length, 4); assert.ok(w2.over); assert.equal(w2.pcs, 48);
  assert.equal(w2.batches.filter(b => !b.held).length, 0);            // no extra work on top
  assert.ok(P.ok); assert.equal(P.assigned + P.deferredPcs, 360);
});

test('capacity plan: says "no plan" instead of guessing', async () => {
  const highs = await HIGHS(); const solver = A.highsAdapter(highs);
  const { B } = capBatches();
  const none = await A.planCapacity(solver, B, [], [], {}, 1);
  assert.equal(none.status, 'NO_WORKERS'); assert.equal(none.assigned, 0); assert.equal(none.deferredPcs, 360);
  const unk = await A.planCapacity(solver, B, A.workerRates(capWorkers, [], {}), [], {}, 1);
  assert.equal(unk.status, 'NO_RATE'); assert.equal(unk.assigned, 0); assert.deepEqual(unk.errors, ['a', 'b', 'c']);
  // a single item bigger than anyone's capacity is deferred and flagged, never forced on a worker
  const big = [Object.assign({}, B[0], { qty: 500 })];
  const P = await A.planCapacity(solver, big, A.workerRates(capWorkers, capRates, {}), [], {}, 1);
  assert.equal(P.assigned, 0); assert.equal(P.deferred[0].why.type, 'toobig');
  // zero capacity
  const z = await A.planCapacity(solver, B, [{ id: 'x', name: 'x', perDay: 0, src: 'owner', days: 0 }], [], {}, 1);
  assert.equal(z.assigned, 0); assert.ok(z.ok);
});
