// AF Group decision engine — explainable MILP for purchasing + filling, Monte Carlo stock risk,
// workforce estimate, and an independent verifier. Pure functions shared by the page and node tests.
(function (root) {
  const pos = v => Math.max(0, +v || 0);
  const PRIO = 1000; // priority weight per piece per rank step (rank mode)
  const WHOLE = 0.2; // whole-invoice bonus = 20% of invoice net value

  function defaults(prm) {
    return Object.assign({
      budget: 1e12, mode: 'rank', lotOil: 125, lotEmpty: 1, wholeInv: true, buyEmpties: true,
      supOn: {}, supCap: {}, supUp: {}, priceOverride: {}, lotByOil: {}
    }, prm || {});
  }
  function netPrice(l) { return pos(l.price) - pos(l.page_pc); }

  // Purchase unit per oil (grams). The owner buys some oils by the gram, some in 125 g packs, some by the kilo.
  // Order: owner's value for this analysis -> inferred from the recorded supplier purchases of that oil -> default.
  const LOTS = [1000, 500, 250, 125, 100, 50, 25, 10, 5, 1];
  function lotOf(snap, prm, oid) {
    const P = defaults(prm);
    const ov = P.lotByOil[oid];
    if (ov != null && ov !== '' && isFinite(+ov) && +ov >= 1) return { lot: Math.round(+ov), src: 'manual' };
    const gs = (snap.prices || []).filter(p => p.oil_id === oid && +p.src_qty > 0 && (p.src_unit === 'kg' || p.src_unit === 'g'))
      .map(p => Math.round(+p.src_qty * (p.src_unit === 'kg' ? 1000 : 1))).filter(g => g > 0);
    if (gs.length) return { lot: LOTS.find(L => gs.every(g => g % L === 0)), src: 'history', from: gs };
    return { lot: Math.max(1, Math.round(+P.lotOil || 125)), src: 'default' };
  }

  // ---------- model ----------
  function buildPlan(snap, prm) {
    const P = defaults(prm);
    const warn = [];
    const oilById = new Map(snap.oils.map(o => [o.id, o]));
    const empById = new Map(snap.empties.map(e => [e.id, e]));
    const supName = new Map(snap.suppliers.map(s => [s.id, s.name]));
    const lines = snap.lines.map(l => Object.assign({}, l, { g: +l.grams || 0, qty: +l.qty }));

    // invoice order: work_rank first, unranked after (by date)
    const firstOf = new Map();
    for (const l of lines) if (!firstOf.has(l.inv_id)) firstOf.set(l.inv_id, l);
    const invOrder = [...firstOf.values()].sort((a, b) =>
      (a.rank ?? 1e6) - (b.rank ?? 1e6) || String(a.date).localeCompare(String(b.date)) || String(a.no).localeCompare(String(b.no)));
    const invRank = new Map(invOrder.map((l, i) => [l.inv_id, i + 1]));
    const R = invOrder.length || 1;

    const needOil = new Map(), needEmp = new Map();
    for (const l of lines) {
      if (l.oil_id && !l.g) warn.push(`سطر "${l.name}" في ${l.no} من غير جرامات — اتحسب من غير زيت`);
      if (l.oil_id && l.g) needOil.set(l.oil_id, (needOil.get(l.oil_id) || 0) + l.qty * l.g);
      if (l.track && l.empty_id) needEmp.set(l.empty_id, (needEmp.get(l.empty_id) || 0) + l.qty);
    }
    for (const [oid] of needOil) { const o = oilById.get(oid); if (o && +o.stock < 0) warn.push(`زيت "${o.name}" رصيده سالب (${Math.round(o.stock)}) — اتحسب صفر، محتاج جرد`); }
    for (const [eid] of needEmp) { const e = empById.get(eid); if (e && +e.shelf < 0) warn.push(`فارغة "${e.name}" رصيدها سالب (${e.shelf}) — اتحسبت صفر، محتاجة جرد`); }

    // purchase options: last price per supplier; fallback = material cost (supplier unknown)
    const opts = new Map(), allOpts = new Map(), noPrice = [], noCost = [], lots = new Map();
    for (const p of snap.prices) {
      if (!needOil.has(p.oil_id)) continue;
      const up = 1 + (+P.supUp[p.sup_id] || 0) / 100;
      const o = Object.assign({}, p, { base: +p.ppg, ppg: +p.ppg * up, off: P.supOn[p.sup_id] === false });
      if (!allOpts.has(p.oil_id)) allOpts.set(p.oil_id, []);
      allOpts.get(p.oil_id).push(o);
      if (o.off) continue;
      if (!opts.has(p.oil_id)) opts.set(p.oil_id, []);
      opts.get(p.oil_id).push(o);
    }
    // dominance: without a spend cap, a pricier supplier can always be swapped for the cheapest one
    // (same grams, less money) — so only the cheapest uncapped option (+ cheaper capped ones) is kept.
    const capped = sid => P.supCap[sid] !== undefined && P.supCap[sid] !== '' && !isNaN(+P.supCap[sid]);
    for (const [oid, list] of opts) {
      list.sort((a, b) => a.ppg - b.ppg);
      const k = list.findIndex(o => !capped(o.sup_id));
      opts.set(oid, k < 0 ? list : list.slice(0, k + 1));
      for (const o of list.slice(k + 1)) if (k >= 0) o.dominated = true;
    }
    for (const [oid] of needOil) {
      if (opts.has(oid) && opts.get(oid).length) continue;
      const o = oilById.get(oid);
      let c = null, src = null;
      if (P.priceOverride[oid] != null && P.priceOverride[oid] !== '' && isFinite(+P.priceOverride[oid]) && +P.priceOverride[oid] > 0) { c = +P.priceOverride[oid]; src = 'سعر أدخله المالك لهذا التحليل'; }
      else if (o && o.cost != null && +o.cost > 0) { c = +o.cost; src = 'آخر تكلفة مسجلة للزيت'; }
      if (c == null) { noPrice.push(oid); opts.set(oid, []); warn.push(`زيت "${o ? o.name : oid}" مالوش سعر مسجل — مش هيتشرى في الخطة لحد ما تدخل سعره`); continue; }
      const op = { oil_id: oid, sup_id: null, ppg: c, base: c, src };
      opts.set(oid, [op]);
      if (!allOpts.has(oid)) allOpts.set(oid, []);
      allOpts.get(oid).push(op);
    }

    const objV = [], bounds = [], binaries = [], generals = [], cons = [];
    lines.forEach((l, i) => {
      l.var = 'y' + i;
      l.rk = invRank.get(l.inv_id);
      l.prio = P.mode === 'rank' ? PRIO * (R + 1 - l.rk) : 0;
      l.w = l.qty * (netPrice(l) + l.prio);
      objV.push({ name: l.var, coef: l.w });
      binaries.push(l.var);
    });
    const invs = new Map();
    for (const l of lines) { if (!invs.has(l.inv_id)) invs.set(l.inv_id, []); invs.get(l.inv_id).push(l); }
    const zmap = new Map(); let zi = 0;
    if (P.wholeInv) for (const [iid, ls] of invs) {
      const z = 'z' + (zi++); zmap.set(iid, z); binaries.push(z);
      objV.push({ name: z, coef: WHOLE * ls.reduce((s, l) => s + l.qty * netPrice(l), 0) });
      for (const l of ls) cons.push({ name: 'inv_' + z + '_' + l.var, vars: [{ name: z, coef: 1 }, { name: l.var, coef: -1 }], bnds: { type: 3, ub: 0, lb: 0 } });
    }
    const buyVars = []; let bi = 0;
    const consMeta = new Map();
    for (const [oid] of needOil) {
      const o = oilById.get(oid) || { stock: 0, name: '?' };
      const vars = lines.filter(l => l.oil_id === oid && l.g).map(l => ({ name: l.var, coef: l.qty * l.g }));
      const LT = lotOf(snap, P, oid); lots.set(oid, LT);
      for (const op of opts.get(oid)) {
        const b = 'x' + (bi++);
        buyVars.push({ name: b, kind: 'oil', id: oid, sup: op.sup_id, ppg: op.ppg, lot: LT.lot, lotSrc: LT.src, unitCost: op.ppg * LT.lot, src: op });
        vars.push({ name: b, coef: -LT.lot });
        objV.push({ name: b, coef: -op.ppg * LT.lot });
        generals.push(b); bounds.push({ name: b, type: 2, lb: 0, ub: 0 });
      }
      const cn = 'oil_' + (o.cnt_no ?? oid);
      consMeta.set(cn, { kind: 'oil', id: oid });
      cons.push({ name: cn, vars, bnds: { type: 3, ub: pos(o.stock), lb: 0 } });
    }
    for (const [eid] of needEmp) {
      const e = empById.get(eid) || { shelf: 0, name: '?' };
      const vars = lines.filter(l => l.track && l.empty_id === eid).map(l => ({ name: l.var, coef: l.qty }));
      let c = P.priceOverride[eid] != null && isFinite(+P.priceOverride[eid]) && +P.priceOverride[eid] > 0 ? +P.priceOverride[eid] : (e.cost != null && +e.cost > 0 ? +e.cost : null);
      if (P.buyEmpties && c == null) { noCost.push(eid); warn.push(`فارغة "${e.name}" مالهاش تكلفة مسجلة — مش هتتشرى في الخطة لحد ما تدخل تكلفتها`); }
      if (P.buyEmpties && c != null) {
        const b = 'e' + (bi++);
        buyVars.push({ name: b, kind: 'empty', id: eid, sup: 'empties', ppg: c, lot: P.lotEmpty, unitCost: c * P.lotEmpty });
        vars.push({ name: b, coef: -P.lotEmpty });
        objV.push({ name: b, coef: -c * P.lotEmpty });
        generals.push(b); bounds.push({ name: b, type: 2, lb: 0, ub: 0 });
      }
      const cn = 'emp_' + (e.cnt_no ?? eid);
      consMeta.set(cn, { kind: 'empty', id: eid });
      cons.push({ name: cn, vars, bnds: { type: 3, ub: pos(e.shelf), lb: 0 } });
    }
    if (buyVars.length && P.budget < 1e11)
      cons.push({ name: 'budget', vars: buyVars.map(b => ({ name: b.name, coef: b.unitCost })), bnds: { type: 3, ub: Math.max(0, +P.budget), lb: 0 } });
    for (const [sid, cap] of Object.entries(P.supCap)) {
      if (cap === '' || cap == null || isNaN(+cap)) continue;
      const bv = buyVars.filter(b => b.sup === sid);
      if (bv.length) cons.push({ name: 'cap_' + sid.slice(0, 8), vars: bv.map(b => ({ name: b.name, coef: b.unitCost })), bnds: { type: 3, ub: +cap, lb: 0 } });
    }
    const lp = { name: 'af_plan', objective: { direction: 2, name: 'value', vars: objV }, subjectTo: cons, bounds, binaries, generals };
    return { lp, lines, buyVars, needOil, needEmp, oilById, empById, supName, invs, zmap, invRank, R, opts, allOpts, warn: [...new Set(warn)], P, consMeta, noPrice, noCost, lots };
  }

  function relaxed(lp) { return Object.assign({}, lp, { binaries: [], generals: [],
    bounds: [...(lp.bounds || []), ...(lp.binaries || []).map(n => ({ name: n, type: 4, lb: 0, ub: 1 }))] }); }

  // ---------- read + explain ----------
  function readPlan(m, res) {
    const val = res.result.vars;
    const on = l => val[l.var] > 0.5;
    const filled = m.lines.filter(on);
    const buys = m.buyVars.map(b => Object.assign({}, b, { lots: Math.round(val[b.name] || 0) }))
      .filter(b => b.lots > 0).map(b => Object.assign(b, { qty: b.lots * b.lot, cost: b.lots * b.unitCost }));
    const buyCost = buys.reduce((s, b) => s + b.cost, 0);
    const revenue = filled.reduce((s, l) => s + l.qty * netPrice(l), 0);
    const allRev = m.lines.reduce((s, l) => s + l.qty * netPrice(l), 0);

    const oilRows = [];
    for (const [oid, need] of m.needOil) {
      const o = m.oilById.get(oid) || {};
      const bought = buys.filter(b => b.kind === 'oil' && b.id === oid).reduce((s, b) => s + b.qty, 0);
      const used = filled.filter(l => l.oil_id === oid).reduce((s, l) => s + l.qty * l.g, 0);
      oilRows.push({ id: oid, name: o.name, cnt: o.cnt_no, stock: +o.stock || 0, avail: pos(o.stock), need, bought, used,
        left: pos(o.stock) + bought - used, gap: Math.max(0, need - pos(o.stock)) });
    }
    const empRows = [];
    for (const [eid, need] of m.needEmp) {
      const e = m.empById.get(eid) || {};
      const bought = buys.filter(b => b.kind === 'empty' && b.id === eid).reduce((s, b) => s + b.qty, 0);
      const used = filled.filter(l => l.track && l.empty_id === eid).reduce((s, l) => s + l.qty, 0);
      empRows.push({ id: eid, name: e.name, cnt: e.cnt_no, shelf: +e.shelf || 0, avail: pos(e.shelf), need, bought, used, left: pos(e.shelf) + bought - used, gap: Math.max(0, need - pos(e.shelf)) });
    }
    const budgetLeft = m.P.budget < 1e11 ? m.P.budget - buyCost : null;

    // why each buy: quantity math + supplier comparison
    for (const b of buys) {
      if (b.kind === 'oil') {
        const r = oilRows.find(x => x.id === b.id);
        const alts = (m.allOpts.get(b.id) || []).slice().sort((a, c) => a.ppg - c.ppg);
        b.why = {
          need: r.used, avail: r.avail, short: Math.max(0, r.used - r.avail), lot: b.lot, lots: b.lots,
          alts: alts.map(a => ({ sup: a.sup_id, ppg: a.ppg, base: a.base, date: a.date, inv_no: a.inv_no, off: !!a.off, dominated: !!a.dominated, chosen: a.sup_id === b.sup, src: a.src }))
        };
      } else {
        const r = empRows.find(x => x.id === b.id);
        b.why = { need: r.used, avail: r.avail, short: Math.max(0, r.used - r.avail), lot: b.lot, lots: b.lots };
      }
    }
    // why each unfilled line
    const unfilled = m.lines.filter(l => !on(l)).map(l => {
      const r = [];
      const os = oilRows.find(x => x.id === l.oil_id);
      if (os && os.left + 1e-9 < l.qty * l.g) r.push({ t: 'oil', txt: `زيت ${os.name} (Z${os.cnt ?? '-'}): محتاج ${Math.round(l.qty * l.g)} جم، والمتاح بعد الخطة ${Math.round(os.left)} جم` });
      if (l.track && l.empty_id) {
        const er = empRows.find(x => x.id === l.empty_id);
        if (er && er.left + 1e-9 < l.qty) r.push({ t: 'empty', txt: `فوارغ ${er.name} (F${er.cnt ?? '-'}): محتاج ${l.qty}، والمتاح بعد الخطة ${Math.round(er.left)}` });
      }
      let why;
      if (!r.length) why = 'الخامات تكفي بس السطر ده اتأجل عشان مايكسرش قيد تاني (غالباً حد مورد)';
      else if (budgetLeft != null) why = r.map(x => x.txt).join(' · ') + ` — والشراء متوقف لأن الميزانية الباقية ${Math.round(budgetLeft)} ج، والأولوية لفواتير ترتيبها أعلى`;
      else if (!m.P.buyEmpties && r.some(x => x.t === 'empty')) why = r.map(x => x.txt).join(' · ') + ' — وشراء الفوارغ مقفول في الإعدادات';
      else why = r.map(x => x.txt).join(' · ') + ' — وتكلفة شرائه أعلى من قيمة السطر أو المورد واقف';
      return Object.assign({}, l, { why, reasons: r });
    });
    const invDone = [...m.invs.entries()].map(([iid, ls]) => ({
      inv_id: iid, no: ls[0].no, cust: ls[0].cust, page: ls[0].page_id, rank: m.invRank.get(iid), wr: ls[0].rank,
      lines: ls.length, filled: ls.filter(on).length,
      pcs: ls.reduce((s, l) => s + l.qty, 0), pcsFilled: ls.filter(on).reduce((s, l) => s + l.qty, 0),
      value: ls.reduce((s, l) => s + l.qty * netPrice(l), 0), valueFilled: ls.filter(on).reduce((s, l) => s + l.qty * netPrice(l), 0)
    })).sort((a, b) => a.rank - b.rank);
    return { status: res.result.status, z: res.result.z, filled, unfilled, buys, buyCost, revenue, allRev, oilRows, empRows, invDone, budgetLeft, time: res.time };
  }

  // ---------- independent verifier (does NOT use the solver model) ----------
  // Rebuilds every constraint from the raw snapshot + params + the decisions, and recomputes the value.
  function verify(snap, prm, decision) {
    const P = defaults(prm);
    const filledIds = new Set(decision.filledIds);
    const lines = snap.lines.filter(l => filledIds.has(l.id));
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, detail });
    // oils
    const used = new Map(), bought = new Map();
    for (const l of lines) if (l.oil_id && +l.grams) used.set(l.oil_id, (used.get(l.oil_id) || 0) + l.qty * l.grams);
    for (const b of decision.buys) if (b.kind === 'oil') bought.set(b.id, (bought.get(b.id) || 0) + b.qty);
    let bad = [], worst = Infinity;
    for (const [oid, u] of used) {
      const o = snap.oils.find(x => x.id === oid) || { stock: 0, name: oid };
      const slack = pos(o.stock) + (bought.get(oid) || 0) - u;
      worst = Math.min(worst, slack);
      if (slack < -1e-6) bad.push(`${o.name}: ناقص ${Math.round(-slack)} جم`);
    }
    add(`الزيت: المستخدم ≤ الموجود + المشترى (${used.size} زيت)`, !bad.length, bad.length ? bad.join('، ') : `أقل فايض ${isFinite(worst) ? Math.round(worst) : 0} جم`);
    // empties
    const uE = new Map(), bE = new Map();
    for (const l of lines) if (l.track && l.empty_id) uE.set(l.empty_id, (uE.get(l.empty_id) || 0) + +l.qty);
    for (const b of decision.buys) if (b.kind === 'empty') bE.set(b.id, (bE.get(b.id) || 0) + b.qty);
    bad = []; worst = Infinity;
    for (const [eid, u] of uE) {
      const e = snap.empties.find(x => x.id === eid) || { shelf: 0, name: eid };
      const slack = pos(e.shelf) + (bE.get(eid) || 0) - u;
      worst = Math.min(worst, slack);
      if (slack < -1e-6) bad.push(`${e.name}: ناقص ${-slack}`);
    }
    add(`الفوارغ: المستخدم ≤ الموجود + المشترى (${uE.size} فارغة)`, !bad.length, bad.length ? bad.join('، ') : `أقل فايض ${isFinite(worst) ? Math.round(worst) : 0} قطعة`);
    if (!P.buyEmpties) add('مفيش شراء فوارغ (مقفول في الإعدادات)', !decision.buys.some(b => b.kind === 'empty'), '');
    // budget
    const spend = decision.buys.reduce((s, b) => s + b.qty * b.ppg, 0);
    if (P.budget < 1e11) add('إجمالي الشراء ≤ الميزانية', spend <= P.budget + 1e-6, `${Math.round(spend)} ≤ ${Math.round(P.budget)} ج`);
    // supplier caps / disabled
    for (const [sid, cap] of Object.entries(P.supCap)) {
      if (cap === '' || cap == null || isNaN(+cap)) continue;
      const s = decision.buys.filter(b => b.sup === sid).reduce((a, b) => a + b.qty * b.ppg, 0);
      const nm = (snap.suppliers.find(x => x.id === sid) || {}).name || sid;
      add(`حد صرف ${nm}`, s <= +cap + 1e-6, `${Math.round(s)} ≤ ${Math.round(+cap)} ج`);
    }
    const offUsed = decision.buys.filter(b => b.kind === 'oil' && b.sup && P.supOn[b.sup] === false);
    add('مفيش شراء من مورد واقف', !offUsed.length, offUsed.length ? `${offUsed.length} شراء` : '');
    // purchase prices are the recorded ones (± what-if %)
    let pbad = 0;
    for (const b of decision.buys.filter(x => x.kind === 'oil' && x.sup)) {
      const p = snap.prices.find(x => x.oil_id === b.id && x.sup_id === b.sup);
      const exp = p ? +p.ppg * (1 + (+P.supUp[b.sup] || 0) / 100) : null;
      if (exp == null || Math.abs(exp - b.ppg) > 1e-6) pbad++;
    }
    add('أسعار الشراء = آخر سعر مسجل في فواتير الموردين', !pbad, pbad ? `${pbad} سعر مختلف` : 'كل الأسعار مطابقة');
    // lots
    const lotBad = decision.buys.filter(b => {
      const L = b.kind === 'oil' ? lotOf(snap, P, b.id).lot : P.lotEmpty;
      return b.lot !== L || Math.abs(b.qty / L - Math.round(b.qty / L)) > 1e-9 || b.qty <= 0;
    }).length;
    add('الكميات مضاعفات وحدة شراء كل صنف (جرام / 125 جم / كيلو)', !lotBad, lotBad ? `${lotBad} كمية مش مظبوطة` : '');
    // whole lines only
    add('كل سطر يا يتعبّى كله يا لأ (مفيش أنصاص)', true, `${lines.length} سطر متعبّي`);
    // value recompute
    const R = new Set(snap.lines.map(l => l.inv_id)).size || 1;
    const firstOf = new Map(); for (const l of snap.lines) if (!firstOf.has(l.inv_id)) firstOf.set(l.inv_id, l);
    const order = [...firstOf.values()].sort((a, b) => (a.rank ?? 1e6) - (b.rank ?? 1e6) || String(a.date).localeCompare(String(b.date)) || String(a.no).localeCompare(String(b.no)));
    const rk = new Map(order.map((l, i) => [l.inv_id, i + 1]));
    let val = 0;
    for (const l of lines) val += l.qty * (netPrice(l) + (P.mode === 'rank' ? PRIO * (R + 1 - rk.get(l.inv_id)) : 0));
    if (P.wholeInv) for (const [iid] of firstOf) {
      const all = snap.lines.filter(l => l.inv_id === iid);
      if (all.every(l => filledIds.has(l.id))) val += WHOLE * all.reduce((s, l) => s + l.qty * netPrice(l), 0);
    }
    val -= spend;
    const dv = Math.abs(val - decision.z);
    add('القيمة المحسوبة يدوي = قيمة الـ Solver', dv <= Math.max(1, Math.abs(val) * 1e-7), `${Math.round(val).toLocaleString('en-US')} مقابل ${Math.round(decision.z).toLocaleString('en-US')}`);
    return { ok: checks.every(c => c.ok), checks, value: val };
  }

  // ---------- Monte Carlo ----------
  function simulate(snap, prm) {
    const P = Object.assign({ horizon: 7, runs: 2000, mult: 1, service: 0.9 }, prm || {});
    const today = new Date(String(snap.at).slice(0, 10) + 'T00:00:00Z');
    const series = new Map();
    let first = null;
    for (const u of snap.usage) {
      if (!series.has(u.oil_id)) series.set(u.oil_id, new Map());
      series.get(u.oil_id).set(u.d, +u.g);
      if (!first || u.d < first) first = u.d;
    }
    const start = first ? new Date(first + 'T00:00:00Z') : new Date(today.getTime() - 30 * 864e5);
    const nDays = Math.max(1, Math.round((today - start) / 864e5)); // full days before today
    const openNeed = new Map();
    for (const l of snap.lines) if (l.oil_id && +l.grams) openNeed.set(l.oil_id, (openNeed.get(l.oil_id) || 0) + l.qty * l.grams);
    let seed = 1234567;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const rows = [];
    for (const o of snap.oils) {
      const s = series.get(o.id);
      const hist = [];
      for (let i = 0; i < nDays; i++) hist.push((s && s.get(new Date(start.getTime() + i * 864e5).toISOString().slice(0, 10))) || 0);
      const total = hist.reduce((a, b) => a + b, 0);
      const need = openNeed.get(o.id) || 0;
      if (!total && !need) continue;
      const free = (+o.stock || 0) - need;
      const sims = new Float64Array(P.runs); let outs = 0;
      for (let r = 0; r < P.runs; r++) {
        let d = 0;
        for (let k = 0; k < P.horizon; k++) d += hist[Math.floor(rnd() * hist.length)] * P.mult;
        sims[r] = d; if (d > free) outs++;
      }
      sims.sort();
      const q = sims[Math.min(P.runs - 1, Math.floor(P.service * P.runs))];
      const avg = total / nDays * P.mult;
      rows.push({ id: o.id, name: o.name, cnt: o.cnt_no, stock: +o.stock || 0, need, free, avgDay: avg,
        activeDays: hist.filter(x => x > 0).length, maxDay: Math.max(...hist), p50: sims[Math.floor(.5 * P.runs)], q,
        cover: avg > 0 ? Math.max(0, free) / avg : (free >= 0 ? Infinity : 0), pOut: outs / P.runs,
        order: Math.max(0, q - free), cost: Math.max(0, q - free) * (+o.cost || 0) });
    }
    rows.sort((a, b) => b.pOut - a.pOut || a.cover - b.cover);
    return { rows, nDays, P };
  }

  function workforce(snap) {
    const w = (snap.workers || []).map(x => ({ name: x.name, pcs: +x.pcs, hrs: +x.hrs, days: +x.days,
      perDay: x.days ? x.pcs / x.days : 0, perHr: x.hrs ? x.pcs / x.hrs : 0 })).sort((a, b) => b.perDay - a.perDay);
    const teamDay = w.reduce((s, x) => s + x.perDay, 0);
    const openPcs = snap.lines.reduce((s, l) => s + +l.qty, 0);
    return { w, teamDay, openPcs, daysToFinish: teamDay ? openPcs / teamDay : null };
  }

  // ---------- model sanity (before any solver sees it) ----------
  function validateModel(lp) {
    const errs = [];
    const fin = v => typeof v === 'number' && isFinite(v);
    const names = new Set();
    for (const v of lp.objective.vars) { if (!fin(v.coef)) errs.push('objective coef ' + v.name); names.add(v.name); }
    for (const c of lp.subjectTo) {
      if (!fin(c.bnds.ub) || !fin(c.bnds.lb)) errs.push('bound ' + c.name);
      if (!c.vars.length) errs.push('empty constraint ' + c.name);
      for (const v of c.vars) { if (!fin(v.coef)) errs.push('coef ' + c.name + '/' + v.name); if (!names.has(v.name)) errs.push('unknown var ' + v.name + ' in ' + c.name); }
    }
    return errs;
  }
  // ---------- solver adapters: every solver returns { status, z, vars, ms } with one of the 8 engine states ----------
  // Model -> CPLEX LP text (all rows are "<= ub"; variables are >= 0 by default).
  function toLP(lp) {
    const num = v => { const t = String(+v); return t.includes('e') ? (+v).toFixed(12).replace(/0+$/, '').replace(/\.$/, '') : t; };
    const expr = vars => {
      const out = []; let line = '';
      vars.forEach((v, k) => {
        const c = +v.coef, term = (c < 0 ? '- ' : (k ? '+ ' : '')) + num(Math.abs(c)) + ' ' + v.name;
        if (line.length + term.length > 200) { out.push(line); line = ''; }
        line += (line ? ' ' : '') + term;
      });
      if (line) out.push(line);
      return out.join('\n   ');
    };
    const L = [lp.objective.direction === 2 ? 'Maximize' : 'Minimize', ' obj: ' + expr(lp.objective.vars), 'Subject To'];
    for (const c of lp.subjectTo) L.push(' ' + c.name + ': ' + expr(c.vars) + ' <= ' + num(c.bnds.ub));
    if (lp.generals && lp.generals.length) { L.push('General'); for (let k = 0; k < lp.generals.length; k += 20) L.push(' ' + lp.generals.slice(k, k + 20).join(' ')); }
    if (lp.binaries && lp.binaries.length) { L.push('Binary'); for (let k = 0; k < lp.binaries.length; k += 20) L.push(' ' + lp.binaries.slice(k, k + 20).join(' ')); }
    L.push('End');
    return L.join('\n') + '\n';
  }
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function highsAdapter(highs) {
    const run = (text, opt) => highs.solve(text, opt);
    return { name: 'HiGHS', version: 'highs-js',
      async solve(lp, tmlim) {
        const text = toLP(lp), t0 = now();
        let r;
        try { r = run(text, { time_limit: tmlim, mip_rel_gap: 0, mip_abs_gap: 1e-6, output_flag: false }); }
        catch (e) { return { status: 'NUMERICAL_ERROR', error: String(e && e.message || e), ms: now() - t0 }; }
        let st = r.Status;
        if (st === 'Primal infeasible or unbounded') {
          try { st = run(text, { time_limit: tmlim, presolve: 'off', output_flag: false }).Status; } catch (e) { /* keep */ }
        }
        const ms = now() - t0, vars = {};
        for (const [n, c] of Object.entries(r.Columns || {})) vars[n] = c.Primal;
        const has = isFinite(r.ObjectiveValue) && Object.keys(vars).length > 0;
        const status = st === 'Optimal' ? 'OPTIMAL'
          : st === 'Infeasible' ? 'INFEASIBLE'
          : st === 'Unbounded' ? 'UNBOUNDED'
          : st === 'Time limit reached' ? (has ? 'FEASIBLE' : 'TIME_LIMIT')
          : st === 'Primal infeasible or unbounded' ? 'INFEASIBLE'
          : 'UNKNOWN';
        return { status, z: r.ObjectiveValue, vars, ms, raw: st };
      } };
  }

  function glpkAdapter(glpk) {
    const map = (st, timedOut) => st === glpk.GLP_OPT ? 'OPTIMAL' : st === glpk.GLP_FEAS ? 'FEASIBLE'
      : (st === glpk.GLP_NOFEAS || st === glpk.GLP_INFEAS) ? 'INFEASIBLE' : st === glpk.GLP_UNBND ? 'UNBOUNDED'
      : st === glpk.GLP_UNDEF ? (timedOut ? 'TIME_LIMIT' : 'UNKNOWN') : 'UNKNOWN';
    return { name: 'GLPK', version: String(glpk.version),
      async solve(lp, tmlim) {
        const t0 = now();
        let res;
        try { res = await glpk.solve(lp, { msglev: glpk.GLP_MSG_OFF, presol: true, tmlim, mipgap: 0 }); }
        catch (e) { return { status: 'NUMERICAL_ERROR', error: String(e && e.message || e), ms: now() - t0 }; }
        const ms = now() - t0;
        let status = map(res.result.status, ms >= tmlim * 1000 * 0.95);
        // GLPK's presolver reports infeasible/unbounded as "undefined": re-solve the LP relaxation without it for the reason.
        if (status === 'UNKNOWN') {
          try { const s2 = map((await glpk.solve(relaxed(lp), { msglev: glpk.GLP_MSG_OFF, presol: false })).result.status, false);
            if (s2 === 'INFEASIBLE' || s2 === 'UNBOUNDED') status = s2; } catch (e) { status = 'NUMERICAL_ERROR'; }
        }
        return { status, z: res.result.z, vars: res.result.vars, ms };
      } };
  }

  // one entry point for the page and the tests: build -> validate -> solve -> read -> verify
  async function solvePlan(solver, snap, prm, tmlim) {
    tmlim = tmlim || 10;
    const m = buildPlan(snap, prm);
    const bad = validateModel(m.lp);
    if (bad.length) return { status: 'INVALID_MODEL', errors: bad, m };
    if (!m.lp.objective.vars.length) return { status: 'INVALID_MODEL', errors: ['no open lines'], m };
    const s = await solver.solve(m.lp, tmlim);
    if (s.status !== 'OPTIMAL' && s.status !== 'FEASIBLE') return { status: s.status, errors: s.error ? [s.error] : [], m, ms: s.ms };
    if (!isFinite(s.z)) return { status: 'NUMERICAL_ERROR', errors: ['objective not finite'], m };
    // integrality: a solver answer with fractional binaries/integers is not a decision
    const frac = [...m.lp.binaries, ...m.lp.generals].filter(n => Math.abs((s.vars[n] || 0) - Math.round(s.vars[n] || 0)) > 1e-6);
    if (frac.length) return { status: 'NUMERICAL_ERROR', errors: ['non-integer values: ' + frac.slice(0, 5).join(',')], m };
    const p = readPlan(m, { result: { vars: s.vars, z: s.z, status: s.status }, time: s.ms / 1000 });
    const decision = { filledIds: p.filled.map(l => l.id), buys: p.buys.map(b => ({ kind: b.kind, id: b.id, sup: b.sup, qty: b.qty, lot: b.lot, ppg: b.ppg })), z: s.z };
    const ver = verify(snap, m.P, decision);
    const solver_ = { name: solver.name, version: solver.version, status: s.status, proven: s.status === 'OPTIMAL', z: s.z, ms: Math.round(s.ms), tmlim,
      nVars: m.lp.objective.vars.length, nBin: m.lp.binaries.length, nInt: m.lp.generals.length, nCons: m.lp.subjectTo.length };
    return { status: s.status, m, p, P: m.P, decision, ver, solver: solver_ };
  }

  const api = { buildPlan, relaxed, readPlan, verify, simulate, workforce, defaults, validateModel, toLP, lotOf, highsAdapter, glpkAdapter, solvePlan, PRIO, WHOLE };
  if (typeof module !== 'undefined') module.exports = api; else root.AFOpt = api;
})(this);

