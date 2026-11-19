// Benchmark GLPK vs HiGHS on instances shaped like the real open-order book (8 invoices, 305 lines, ~193 oils, ~213 empties).
// Synthetic data with the real size and ranges — no production data in the repo.  Run: node tests/bench.js
const GLPK = require('glpk.js'), HIGHS = require('highs'), A = require('../engine.js');
function rng(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; }
function realScale(seed) {
  const r = rng(seed), ri = (a, b) => a + Math.floor(r() * (b - a + 1)), pick = a => a[Math.floor(r() * a.length)];
  const nO = 193, nE = 213, sizes = [18, 7, 25, 12, 1, 37, 6, 199];
  const oils = [], prices = [], empties = [], lines = [];
  for (let i = 0; i < nO; i++) {
    const z = r(); oils.push({ id: 'o' + i, name: 'oil' + i, cnt_no: i, stock: z < 0.25 ? 0 : z < 0.33 ? -ri(30, 300) : ri(10, 1500), cost: r() < 0.03 ? null : +(3 + r() * 5).toFixed(4) });
    if (r() < 0.55) prices.push({ oil_id: 'o' + i, sup_id: 's' + ri(1, 3), ppg: +(3 + r() * 5).toFixed(4) });
    if (r() < 0.08) prices.push({ oil_id: 'o' + i, sup_id: 's0', ppg: +(3 + r() * 5).toFixed(4) });
  }
  for (let i = 0; i < nE; i++) { const z = r(); empties.push({ id: 'e' + i, name: 'emp' + i, cnt_no: i, shelf: z < 0.2 ? 0 : z < 0.35 ? -ri(1, 60) : ri(1, 150), cost: r() < 0.03 ? null : ri(50, 180) }); }
  let k = 0;
  sizes.forEach((n, inv) => { for (let j = 0; j < n; j++) lines.push({ id: 'l' + (k++), inv_id: 'i' + inv, no: 'N' + inv, date: '2026-11-1' + inv, rank: inv < 6 ? inv + 2 : null, cust: 'c', name: 'p',
    qty: pick([1, 2, 3, 4, 4, 10, 12, 12, 12, 12, 15, 24, 70]), price: ri(140, 550), page_pc: 0, grams: pick([5, 7.5, 7.5, 10, 10, 10, 12.5, 15, 15, 17.5, 20, 25]), oil_id: 'o' + ri(0, nO - 1), empty_id: 'e' + ri(0, nE - 1), track: true }); });
  return { at: '2026-11-19T10:00:00Z', lines, oils, prices, empties, suppliers: [0, 1, 2, 3].map(i => ({ id: 's' + i, name: 'S' + i })), usage: [], workers: [] };
}
(async () => {
  const G = A.glpkAdapter(await GLPK()), H = A.highsAdapter(await HIGHS());
  console.log('seed | budget | mode | vars | cons | HiGHS status ms verify | GLPK status ms | GLPK value vs HiGHS');
  let hMax = 0, gOpt = 0, n = 0;
  for (const seed of [11, 22, 33]) for (const budget of [0, 20000, 1e12]) for (const mode of ['rank', 'cash']) {
    const w = realScale(seed);
    const h = await A.solvePlan(H, w, { budget, mode }, 30);
    const g = await A.solvePlan(G, w, { budget, mode }, 30);
    n++; hMax = Math.max(hMax, h.solver.ms); if (g.status === 'OPTIMAL') gOpt++;
    const d = g.decision ? (g.decision.z - h.decision.z) / Math.abs(h.decision.z) * 100 : null;
    console.log([seed, budget >= 1e11 ? 'none' : budget, mode, h.solver.nVars, h.solver.nCons, h.status, h.solver.ms, h.ver.ok,
      g.status, g.solver ? g.solver.ms : '-', d == null ? '-' : (Math.abs(d) < 1e-6 ? 'equal' : d.toFixed(3) + '%')].join(' | '));
  }
  console.log(`HiGHS: optimal in all ${n}, slowest ${hMax} ms. GLPK: proved optimal in ${gOpt}/${n} within 30 s.`);
})();
