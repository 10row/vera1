"use strict";
// SpendYes v2 Engine — INTEGER CENTS
function toCents(usd) {
  if (usd === null || usd === undefined) return 0;
  const n = typeof usd === "string" ? parseFloat(usd) : usd;
  if (isNaN(n) || !isFinite(n)) return 0;
  return Math.round(n * 100);
}
function toUSD(cents) {
  if (cents === null || cents === undefined) return "$0.00";
  const neg = cents < 0, abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100, sign = neg ? "-" : "";
  return sign + "$" + dollars.toLocaleString() + "." + String(rem).padStart(2, "0");
}
function toUSDShort(c) {
  const s = toUSD(c);
  return s.endsWith(".00") ? s.slice(0, -3) : s;
}
function today() { return new Date().toISOString().slice(0, 10); }
function daysUntil(dateStr) {
  if (!dateStr) return 30;
  const t = new Date(today() + "T00:00:00");
  const d = new Date(dateStr + "T00:00:00");
  return Math.max(1, Math.ceil((d - t) / 86400000));
}
function daysBetween(a, b) {
  const da = new Date(a + "T00:00:00"), db = new Date(b + "T00:00:00");
  return Math.max(1, Math.ceil((db - da) / 86400000));
}
function uid() { return require("crypto").randomBytes(12).toString("hex"); }
function d_key(name) { return (name ?? "").toLowerCase().trim(); }
function safeDate(d) {
  if (!d) return null;
  const dt = new Date(d + "T00:00:00");
  return isNaN(dt.getTime()) ? null : dt;
}
function normalizeDate(d) {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d) && safeDate(d)) return d;
  const dt = new Date(d);
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return null;
}
function monthKey(dateStr) {
  if (!dateStr || dateStr.length < 7) return null;
  return dateStr.slice(0, 7);
}
function todaySpent(state, poolKey) {
  const t = today(); let cents = 0;
  for (const tx of state.transactions) {
    if (tx.date === t && tx.node === poolKey && tx.type === "transaction")
      cents += tx.amountCents;
  }
  return cents;
}
function todayUnallocatedSpend(state) {
  const t = today(); let cents = 0;
  for (const tx of state.transactions) {
    if (tx.date === t && (tx.type === "transaction" || tx.type === "refund")
      && (tx.node === "free" || !tx.node))
      cents += tx.amountCents;
  }
  return cents;
}
function todayTotalSpend(state) {
  const t = today(); let cents = 0;
  for (const tx of state.transactions) {
    if (tx.date === t && (tx.type === "transaction" || tx.type === "refund"))
      cents += tx.amountCents;
  }
  return cents;
}
function matchPool(state, description) {
  if (!description) return null;
  const lower = description.toLowerCase();
  let bestKey = null, bestScore = 0;
  for (const [key, pool] of Object.entries(state.pools)) {
    if (!pool.active) continue;
    for (const kw of pool.keywords) {
      if (lower.includes(kw.toLowerCase()) && kw.length > bestScore) {
        bestKey = key; bestScore = kw.length;
      }
    }
    if (lower.includes(key) && key.length > bestScore) {
      bestKey = key; bestScore = key.length;
    }
  }
  return bestKey;
}
function countOccurrences(nd, intDays, end) {
  if (!nd || !end) return 1;
  let count = 0, d = new Date(nd + "T00:00:00");
  const e = new Date(end + "T00:00:00"), iv = intDays || 30;
  while (d <= e && count < 100) { count++; d.setDate(d.getDate() + iv); }
  return Math.max(count, 0);
}
function createFreshState() {
  return {
    setup: false, balanceCents: 0, incomeCents: 0, savingsCents: 0,
    savingRateBps: 0, payday: null, cycleStart: null, recurring: true,
    currency: "USD", currencySymbol: "$", localRate: 100, language: "en",
    drains: {}, pools: {}, plannedPurchases: {},
    transactions: [], conversationHistory: [],
    monthlySummaries: {}, cycleHistory: [],
  };
}
function updateMonthly(s, dateStr, pk, amt, ty) {
  const mk = monthKey(dateStr);
  if (!mk) return;
  if (!s.monthlySummaries[mk]) s.monthlySummaries[mk] = {};
  const m = s.monthlySummaries[mk], nk = pk || "_free";
  if (!m[nk]) m[nk] = { spent: 0, earned: 0, count: 0 };
  if (ty === "income") { m[nk].earned += amt; }
  else { m[nk].spent += amt; m[nk].count += (amt >= 0 ? 1 : -1); }
  if (!m["_total"]) m["_total"] = { spent: 0, earned: 0, count: 0 };
  if (ty === "income") { m["_total"].earned += amt; }
  else { m["_total"].spent += amt; m["_total"].count += (amt >= 0 ? 1 : -1); }
}
function archiveCycle(s) {
  if (!s.cycleStart || !s.setup) return;
  let tot = 0, txC = 0;
  const ps = {}, dp = {};
  for (const [k, p] of Object.entries(s.pools)) {
    if (p.spentCents > 0) ps[k] = p.spentCents;
    tot += p.spentCents;
  }
  for (const tx of s.transactions) {
    if (tx.date >= s.cycleStart && tx.type === "transaction") {
      txC++;
      if (tx.node === "free" || !tx.node) tot += tx.amountCents;
    }
    if (tx.date >= s.cycleStart && tx.type === "refund") txC++;
    if (tx.date >= s.cycleStart && tx.type === "bill_payment") {
      dp[tx.node] = (dp[tx.node] || 0) + tx.amountCents;
    }
  }
  const ce = today(), days = daysBetween(s.cycleStart, ce);
  s.cycleHistory.push({
    cycleStart: s.cycleStart, cycleEnd: ce, incomeCents: s.incomeCents,
    totalSpentCents: tot, savedCents: s.savingsCents,
    poolSpend: ps, drainsPaid: dp, txCount: txC, daysInCycle: days,
    avgDailySpend: days > 0 ? Math.round(tot / days) : 0,
  });
  if (s.cycleHistory.length > 12) s.cycleHistory = s.cycleHistory.slice(-12);
}
function applyAction(state, action) {
  if (!action || !action.type) return state;
  const s = JSON.parse(JSON.stringify(state));
  switch (action.type) {
    case "setup": {
      const d = action.data;
      if (!d.balanceUSD && !d.incomeUSD && !d.payday) return s;
      if (!d.payday) return s;
      s.setup = true;
      s.balanceCents = toCents(d.balanceUSD);
      s.incomeCents = toCents(d.incomeUSD);
      s.savingRateBps = Math.min(10000, Math.max(0, Math.round((d.savingRate ?? 0) * 10000)));
      if (d.recurring !== undefined) s.recurring = d.recurring;
      let pd = d.payday ? normalizeDate(d.payday) : null;
      if (pd) {
        const todayMs = new Date(today() + "T00:00:00").getTime();
        let dt = new Date(pd + "T00:00:00");
        while (dt.getTime() <= todayMs) dt.setMonth(dt.getMonth() + 1);
        pd = dt.toISOString().slice(0, 10);
      }
      s.payday = pd;
      s.cycleStart = d.cycleStart ?? today();
      if (!pd && !s.recurring) {
        const fb = new Date(today() + "T00:00:00");
        fb.setDate(fb.getDate() + 30);
        s.payday = fb.toISOString().slice(0, 10);
      }
      if (d.savingsUSD !== undefined) s.savingsCents = toCents(d.savingsUSD);
      s.transactions.push({
        id: uid(), type: "setup", amountCents: s.balanceCents,
        description: "Initial balance", date: today(), ts: Date.now(),
      });
      return s;
    }
    case "add_drain": {
      const d = action.data;
      const key = d.name ? d.name.toLowerCase().trim() : "";
      if (!key) return s;
      s.drains[key] = {
        name: d.name, amountCents: toCents(d.amountUSD),
        intervalDays: d.intervalDays ?? 30, nextDate: d.nextDate ?? null, active: true,
      };
      return s;
    }
    case "remove_drain": {
      const key = d_key(action.data.name);
      if (s.drains[key]) s.drains[key].active = false;
      return s;
    }
    case "update_drain": {
      const d = action.data, key = d_key(d.name);
      if (s.drains[key]) {
        if (d.amountUSD !== undefined) s.drains[key].amountCents = toCents(d.amountUSD);
        if (d.intervalDays !== undefined) s.drains[key].intervalDays = d.intervalDays;
        if (d.nextDate !== undefined) s.drains[key].nextDate = d.nextDate;
      }
      return s;
    }
    case "confirm_payment": {
      const key = d_key(action.data.name);
      if (s.drains[key] && s.drains[key].active) {
        const dr = s.drains[key];
        dr.isDue = false;
        s.balanceCents -= dr.amountCents;
        if (action.data.amountUSD !== undefined) {
          const nA = toCents(action.data.amountUSD);
          s.balanceCents += dr.amountCents - nA;
          dr.amountCents = nA;
        }
        const txD = today();
        s.transactions.push({
          id: uid(), type: "bill_payment", amountCents: dr.amountCents,
          description: "Bill: " + dr.name, node: key, date: txD, ts: Date.now(),
        });
        updateMonthly(s, txD, "_bills", dr.amountCents, "bill_payment");
        if (dr.nextDate) {
          const dt = new Date(dr.nextDate + "T00:00:00");
          dt.setDate(dt.getDate() + (dr.intervalDays || 30));
          dr.nextDate = dt.toISOString().slice(0, 10);
        }
      }
      return s;
    }
    case "skip_payment": {
      const key = d_key(action.data.name);
      if (s.drains[key] && s.drains[key].active && s.drains[key].nextDate) {
        const dr = s.drains[key];
        dr.isDue = false;
        const dt = new Date(dr.nextDate + "T00:00:00");
        dt.setDate(dt.getDate() + (dr.intervalDays || 30));
        dr.nextDate = dt.toISOString().slice(0, 10);
      }
      return s;
    }
    case "add_pool": {
      const d = action.data, key = d.name.toLowerCase().trim();
      s.pools[key] = {
        name: d.name, type: d.type ?? "daily",
        dailyCents: d.type === "daily" ? toCents(d.dailyAmountUSD ?? 0) : 0,
        allocatedCents: d.type === "monthly" ? toCents(d.allocatedUSD ?? 0) : 0,
        keywords: d.keywords ?? [], spentCents: 0, active: true,
      };
      return s;
    }
    case "remove_pool": {
      const key = d_key(action.data.name);
      if (s.pools[key]) s.pools[key].active = false;
      return s;
    }
    case "add_planned": {
      const d = action.data;
      const key = d.name ? d.name.toLowerCase().trim() : "";
      if (!key) return s;
      s.plannedPurchases[key] = {
        name: d.name, amountCents: toCents(d.amountUSD),
        date: d.date ? normalizeDate(d.date) : null, confirmed: false, active: true,
      };
      return s;
    }
    case "remove_planned": {
      const key = d_key(action.data.name);
      if (s.plannedPurchases[key]) s.plannedPurchases[key].active = false;
      return s;
    }
    case "confirm_planned": {
      const key = d_key(action.data.name);
      const pp = s.plannedPurchases[key];
      if (pp && !pp.confirmed) {
        pp.confirmed = true;
        s.balanceCents -= pp.amountCents;
        const txD = today();
        s.transactions.push({
          id: uid(), type: "planned_purchase", amountCents: pp.amountCents,
          description: "Planned: " + pp.name, node: "_planned", date: txD, ts: Date.now(),
        });
        updateMonthly(s, txD, "_planned", pp.amountCents, "planned_purchase");
      }
      return s;
    }
    case "transaction": {
      const d = action.data, amt = toCents(d.amountUSD);
      if (amt === 0) return s;
      s.balanceCents -= amt;
      const pk = d.poolKey ? d_key(d.poolKey) : matchPool(s, d.description ?? "");
      if (pk && s.pools[pk] && s.pools[pk].active) s.pools[pk].spentCents += amt;
      const txT = amt < 0 ? "refund" : "transaction";
      const txD = today();
      s.transactions.push({
        id: uid(), type: txT, amountCents: amt,
        description: d.description ?? "", node: pk ?? "free", date: txD, ts: Date.now(),
      });
      updateMonthly(s, txD, pk, amt, txT);
      return s;
    }
    case "income": {
      const d = action.data;
      const amt = Math.max(0, toCents(d.amountUSD));
      const sav = Math.round(amt * s.savingRateBps / 10000);
      archiveCycle(s);
      s.savingsCents += sav;
      s.balanceCents += (amt - sav);
      if (d.nextPayday) { let np = normalizeDate(d.nextPayday); if (np) s.payday = np; }
      s.cycleStart = today();
      for (const key of Object.keys(s.pools)) {
        if (s.pools[key].active) s.pools[key].spentCents = 0;
      }
      const txD = today();
      s.transactions.push({
        id: uid(), type: "income", amountCents: amt,
        description: d.description ?? "Income", date: txD, ts: Date.now(),
      });
      updateMonthly(s, txD, null, amt, "income");
      return s;
    }
    case "correction": {
      s.balanceCents = toCents(action.data.amountUSD);
      s.transactions.push({
        id: uid(), type: "correction", amountCents: s.balanceCents,
        description: "Balance correction", date: today(), ts: Date.now(),
      });
      return s;
    }
    case "set_saving_rate": {
      s.savingRateBps = Math.min(10000, Math.max(0, Math.round((action.data.rate ?? 0) * 10000)));
      return s;
    }
    case "set_savings": {
      s.savingsCents = Math.max(0, toCents(action.data.amountUSD));
      return s;
    }
    case "withdraw_savings": {
      const amt = toCents(action.data.amountUSD);
      s.savingsCents = Math.max(0, s.savingsCents - amt);
      s.balanceCents += amt;
      const reason = action.data.reason ? ": " + action.data.reason : "";
      s.transactions.push({
        id: uid(), type: "savings_withdrawal", amountCents: amt,
        description: "Savings withdrawal" + reason, date: today(), ts: Date.now(),
      });
      return s;
    }
    case "set_location": {
      const d = action.data;
      s.currency = d.currency ?? s.currency;
      s.currencySymbol = d.symbol ?? s.currencySymbol;
      s.localRate = d.localRate ? Math.round(d.localRate * 100) : s.localRate;
      return s;
    }
    case "reset": return createFreshState();
    case "none": return s;
    default: return s;
  }
}
function tickState(state) {
  const s = JSON.parse(JSON.stringify(state));
  const t = today();
  s._dueBills = []; s._duePlanned = [];
  for (const [k, d] of Object.entries(s.drains)) {
    if (!d.active || !d.nextDate) continue;
    if (d.nextDate <= t) {
      d.isDue = true;
      s._dueBills.push({ name: d.name, amountCents: d.amountCents, nextDate: d.nextDate });
    }
  }
  const pp = s.plannedPurchases || {};
  for (const [k, p] of Object.entries(pp)) {
    if (!p.active || p.confirmed || !p.date) continue;
    if (p.date <= t) {
      p.isDue = true;
      s._duePlanned.push({ name: p.name, amountCents: p.amountCents, date: p.date });
    }
  }
  return s;
}
function runQuery(state, query) {
  if (!query || !query.type) return { error: "Invalid query" };
  const s = state, t = today(), mk = monthKey(t);
  switch (query.type) {
    case "pool_spend": {
      const pk = query.pool ? query.pool.toLowerCase().trim() : "";
      const mo = query.month || mk, ms = s.monthlySummaries[mo];
      if (ms && ms[pk]) return { pool:pk, month:mo, spentCents:ms[pk].spent, spentUSD:toUSD(ms[pk].spent), txCount:ms[pk].count };
      return { pool:pk, month:mo, spentCents:0, spentUSD:"$0.00", txCount:0 };
    }
    case "month_total": {
      const mo = query.month || mk, ms = s.monthlySummaries[mo];
      if (ms && ms["_total"]) {
        const mt = ms["_total"];
        return { month:mo, spentCents:mt.spent, spentUSD:toUSD(mt.spent), earnedCents:mt.earned, earnedUSD:toUSD(mt.earned), txCount:mt.count };
      }
      return { month:mo, spentCents:0, spentUSD:"$0.00", earnedCents:0, earnedUSD:"$0.00", txCount:0 };
    }
    case "top_pools": {
      const mo = query.month || mk, ms = s.monthlySummaries[mo] || {};
      const pools = [];
      for (const [k, v] of Object.entries(ms)) {
        if (k.startsWith("_")) continue;
        pools.push({ pool:k, spentCents:v.spent, spentUSD:toUSD(v.spent), txCount:v.count });
      }
      pools.sort((a, b) => b.spentCents - a.spentCents);
      return { month:mo, pools };
    }
    case "search_spend": {
      const kw = (query.keyword || "").toLowerCase(), days = query.days || 30;
      const cut = new Date(t + "T00:00:00");
      cut.setDate(cut.getDate() - days);
      const cs = cut.toISOString().slice(0, 10);
      let tot = 0, cnt = 0; const matches = [];
      for (const tx of s.transactions) {
        if (tx.date < cs) continue;
        if (tx.type !== "transaction" && tx.type !== "refund") continue;
        if (tx.description && tx.description.toLowerCase().includes(kw)) {
          tot += tx.amountCents; cnt++;
          matches.push({ date:tx.date, description:tx.description, amountUSD:toUSD(tx.amountCents) });
        }
      }
      return { keyword:kw, days, count:cnt, spentCents:tot, spentUSD:toUSD(tot), matches:matches.slice(-20) };
    }
    case "daily_average": {
      const txD = new Set(); let tot = 0;
      for (const tx of s.transactions) {
        if (tx.type === "transaction" || tx.type === "refund") {
          tot += tx.amountCents; txD.add(tx.date);
        }
      }
      const nd = Math.max(1, txD.size), avg = Math.round(tot / nd);
      return { avgCents:avg, avgUSD:toUSD(avg), daysTracked:txD.size };
    }
    case "projection": {
      const pic = computePicture(s);
      if (!pic.setup) return { error: "Not set up yet" };
      const dl = pic.daysLeft || 1;
      const db = pic.cycleStats ? pic.cycleStats.dailyAvg : 0;
      const proj = db * dl, free = pic.trulyFreeCents;
      const v = free <= 0 ? "over_budget" : proj > free ? "tight" : "comfortable";
      return { freeCents:free, freeUSD:toUSD(free), projectedSpendCents:proj, projectedSpendUSD:toUSD(proj), dailyBurnCents:db, dailyBurnUSD:toUSD(db), daysLeft:dl, verdict:v };
    }
    case "trend": {
      if (s.cycleHistory.length === 0) return { trend: "no_history" };
      const last = s.cycleHistory[s.cycleHistory.length - 1];
      const pk = query.pool ? query.pool.toLowerCase().trim() : null;
      if (pk) {
        const lp = last.poolSpend[pk] || 0;
        const pv = s.cycleHistory.length > 1 ? (s.cycleHistory[s.cycleHistory.length - 2].poolSpend[pk] || 0) : lp;
        const pc = pv > 0 ? Math.round(((lp - pv) / pv) * 100) : 0;
        return { pool:pk, direction:pc > 5 ? "up" : pc < -5 ? "down" : "stable", pctChange:pc, lastCycleCents:lp, lastCycleUSD:toUSD(lp) };
      }
      const lt = last.totalSpentCents;
      const pv = s.cycleHistory.length > 1 ? s.cycleHistory[s.cycleHistory.length - 2].totalSpentCents : lt;
      const pc = pv > 0 ? Math.round(((lt - pv) / pv) * 100) : 0;
      return { direction:pc > 5 ? "up" : pc < -5 ? "down" : "stable", pctChange:pc, lastCycleCents:lt, lastCycleUSD:toUSD(lt), avgDailyUSD:toUSD(last.avgDailySpend) };
    }
    case "savings_history": {
      const h = s.cycleHistory.map(c => ({ cycleEnd:c.cycleEnd, savedCents:c.savedCents, savedUSD:toUSD(c.savedCents) }));
      return { currentSavingsCents:s.savingsCents, currentSavingsUSD:toUSD(s.savingsCents), rateBps:s.savingRateBps, history:h };
    }
    default: return { error: "Unknown query: " + query.type };
  }
}
function computePicture(state) {
  const s = tickState(state);
  if (!s.setup) return { setup: false };
  const dl = daysUntil(s.payday);
  const dic = s.cycleStart ? daysBetween(s.cycleStart, s.payday) : dl;
  const doc = Math.max(1, dic - dl + 1);
  let billsRes = 0; const drainList = [];
  for (const [key, d] of Object.entries(s.drains)) {
    if (!d.active) continue;
    const occ = countOccurrences(d.nextDate, d.intervalDays, s.payday);
    const res = d.amountCents * occ;
    billsRes += res;
    const dTo = d.nextDate ? daysUntil(d.nextDate) : null;
    drainList.push({
      name:d.name, amountCents:d.amountCents, amountUSD:toUSDShort(d.amountCents),
      nextDate:d.nextDate, daysUntilNext:dTo, isDue:d.isDue||false,
      intervalDays:d.intervalDays||30, occurrences:occ, reservedCents:res, reservedUSD:toUSDShort(res),
    });
  }
  let plannedTot = 0; const plannedList = [];
  const pps = s.plannedPurchases || {};
  for (const [key, pp] of Object.entries(pps)) {
    if (!pp.active) continue;
    if (!pp.confirmed) plannedTot += pp.amountCents;
    plannedList.push({
      name:pp.name, amountCents:pp.amountCents, amountUSD:toUSDShort(pp.amountCents),
      date:pp.date, confirmed:pp.confirmed, isDue:pp.isDue||false,
    });
  }
  let poolRes = 0; const poolList = [];
  for (const [key, p] of Object.entries(s.pools)) {
    if (!p.active) continue;
    const tot = p.type === "daily" ? p.dailyCents * Math.max(1, dl) : p.allocatedCents;
    const rem = Math.max(0, tot - p.spentCents);
    const st = todaySpent(s, key);
    const tr = p.type === "daily" ? Math.max(0, p.dailyCents - st) : (dl > 0 ? Math.round(rem / dl) : 0);
    poolRes += rem;
    poolList.push({
      name:p.name, key, type:p.type, totalCents:tot, remainingCents:rem,
      spentCents:p.spentCents, spentTodayCents:st, todayRemainingCents:tr,
      totalUSD:toUSDShort(tot), remainingUSD:toUSDShort(rem), keywords:p.keywords,
    });
  }
  const free = s.balanceCents - billsRes - plannedTot - poolRes;
  const dailyPace = dl > 0 ? Math.floor(free / dl) : free;
  const todayUn = todayUnallocatedSpend(s);
  const freeToday = dailyPace - todayUn;
  const todayTot = todayTotalSpend(s);
  let cySpent = 0, cyTxC = 0;
  const cyCut = s.cycleStart || today();
  for (const tx of s.transactions) {
    if (tx.date >= cyCut && (tx.type === "transaction" || tx.type === "refund")) {
      cySpent += tx.amountCents; cyTxC++;
    }
    if (tx.date >= cyCut && tx.type === "bill_payment") cySpent += tx.amountCents;
  }
  const cyDays = Math.max(1, daysBetween(cyCut, today()));
  const dAvg = cyDays > 0 ? Math.round(cySpent / cyDays) : 0;
  const wkPace = dailyPace * 7;
  const weekCut = new Date(today() + "T00:00:00");
  weekCut.setDate(weekCut.getDate() - 7);
  const wcs = weekCut.toISOString().slice(0, 10);
  let wkSpent = 0;
  for (const tx of s.transactions) {
    if (tx.date >= wcs && (tx.type === "transaction" || tx.type === "refund"))
      wkSpent += tx.amountCents;
  }
  const mk = monthKey(today()), mSnap = s.monthlySummaries[mk] || {};
  const moSpent = mSnap["_total"] ? mSnap["_total"].spent : 0;
  const avgTx = cyTxC > 0 ? Math.round(cySpent / cyTxC) : 0;
  const upBills = [];
  for (const dr of drainList) {
    if (dr.daysUntilNext !== null && dr.daysUntilNext <= 7)
      upBills.push({ name:dr.name, amt:dr.amountUSD, days:dr.daysUntilNext });
  }
  return {
    setup: true,
    balanceCents:s.balanceCents, balanceUSD:toUSD(s.balanceCents),
    savingsCents:s.savingsCents, savingsUSD:toUSD(s.savingsCents),
    savingRateBps:s.savingRateBps,
    trulyFreeCents:free, trulyFreeUSD:toUSD(free),
    dailyFreePaceCents:dailyPace, dailyFreePaceUSD:toUSD(dailyPace),
    freeRemainingTodayCents:freeToday, freeRemainingTodayUSD:toUSD(freeToday),
    todaySpentCents:todayTot, todaySpentUSD:toUSD(todayTot), todayUnallocCents:todayUn,
    billsReservedCents:billsRes, billsReservedUSD:toUSD(billsRes),
    plannedTotalCents:plannedTot, plannedPurchasesUSD:toUSD(plannedTot),
    poolReserveCents:poolRes, poolReserveUSD:toUSD(poolRes),
    daysLeft:dl, dayOfCycle:doc, daysInCycle:dic, payday:s.payday,
    drains:drainList, plannedPurchases:plannedList, pools:poolList,
    weeklyFreePaceCents:wkPace, weeklyFreePaceUSD:toUSD(wkPace),
    thisWeekSpentCents:wkSpent, thisWeekSpentUSD:toUSD(wkSpent),
    thisMonthSpentCents:moSpent, thisMonthSpentUSD:toUSD(moSpent),
    avgTransactionCents:avgTx, avgTransactionUSD:toUSD(avgTx),
    upcomingBills:upBills,
    checksumOk: (billsRes + plannedTot + poolRes + free) === s.balanceCents,
    cycleStats: { totalSpent:cySpent, totalSpentUSD:toUSD(cySpent), dailyAvg:dAvg, dailyAvgUSD:toUSD(dAvg), txCount:cyTxC, daysInCycle:cyDays },
    monthlySnapshot:mSnap,
    transactions: s.transactions.slice(-20).reverse(),
  };
}
function buildSystemPrompt(state) {
  const pic = computePicture(state), s = state;
  const ad = (a) => a.filter(x => x.active);
  const drn = Object.values(s.drains);
  const pps = Object.values(s.plannedPurchases || {});
  const pls = Object.values(s.pools);
  const snap = JSON.stringify({
    setup:s.setup, recurring:s.recurring,
    balance:toUSD(s.balanceCents), savings:toUSD(s.savingsCents),
    savingRate:(s.savingRateBps/100)+"%", payday:s.payday,
    daysLeft:pic.daysLeft??"?",
    drains:ad(drn).map(d=>({name:d.name,amt:toUSD(d.amountCents),isDue:d.isDue||false,next:d.nextDate,interval:d.intervalDays})),
    planned:ad(pps).map(p=>({name:p.name,amt:toUSD(p.amountCents),done:p.confirmed,date:p.date,isDue:p.isDue||false})),
    dueBills:(s._dueBills||[]), duePlanned:(s._duePlanned||[]),
    pools:ad(pls).map(p=>({name:p.name,type:p.type,daily:p.type==="daily"?toUSD(p.dailyCents):undefined,spent:toUSD(p.spentCents),kw:p.keywords})),
    free:pic.trulyFreeCents!==undefined?toUSD(pic.trulyFreeCents):"?",
    pace:pic.dailyFreePaceCents!==undefined?toUSD(pic.dailyFreePaceCents):"?",
    freeToday:pic.freeRemainingTodayCents!==undefined?toUSD(pic.freeRemainingTodayCents):"?",
    spentToday:pic.todaySpentCents!==undefined?toUSD(pic.todaySpentCents):"?",
    weeklyPace:pic.weeklyFreePaceUSD||"?",
    thisWeekSpent:pic.thisWeekSpentUSD||"$0.00",
    thisMonthSpent:pic.thisMonthSpentUSD||"$0.00",
    avgTx:pic.avgTransactionUSD||"$0.00",
    upcomingBills:pic.upcomingBills||[],
    cycleStats:pic.cycleStats||null,
  });
  const P = [
    "You are SpendYes, a spending confidence engine. Show what users CAN spend freely.",
    "Be warm, concise, never judgmental. Sharp friend great with money.",
    "","STATE:", snap, "",
    "TODAY:" + today(), "",
    "JOB: If not set up: need balance, income, payday. Ask for missing ones only.",
    "Users give multiple in one msg. 'I earn 13k on 25th monthly'=income+payday.",
    "Send setup ONLY with ALL THREE. After setup: ask bills, then categories.",
    "If set up: log spending, check free, manage finances.",
    "","ACTIONS (unused data=null):",
    "setup:balanceUSD,incomeUSD,savingRate(0-1),payday(YYYY-MM-DD future),recurring",
    "transaction:amountUSD(+spent,-refund),description",
    "add_drain:name,amountUSD,intervalDays(def 30),nextDate|remove_drain:name",
    "confirm_payment:name|skip_payment:name",
    "add_pool:name,type(daily/monthly),dailyAmountUSD/allocatedUSD,keywords|remove_pool:name",
    "add_planned:name,amountUSD,date|remove_planned:name|confirm_planned:name",
    "income:amountUSD,description,nextPayday|correction:amountUSD",
    "set_saving_rate:rate(0-1)|reset|none",
    "","WATERFALL:Balance-Bills-Planned-Pools=Free. Bills reserve til payday.",
    "isDue:true? ask confirm. NEVER calculate—engine does ALL math. Read numbers from state only.",
    "weeklyPace,thisWeekSpent,thisMonthSpent,avgTx are pre-computed. Just quote them.",
    "EX:'balance $2k'->none,ask income.'$5k/mo on 15th'->setup.'coffee $4.50'->transaction.",
  ];
  return P.join("\n");
}
module.exports = {
  toCents, toUSD, toUSDShort,
  today, daysUntil, daysBetween,
  monthKey, matchPool, countOccurrences,
  createFreshState, applyAction,
  runQuery, computePicture, buildSystemPrompt,
  updateMonthly, archiveCycle, tickState,
  todayUnallocatedSpend, todayTotalSpend,
};
