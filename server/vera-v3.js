"use strict";
// SpendYes V3 Engine — One equation: balance = reserves + free
// All money in integer cents. No floating point.
const crypto = require("crypto");

// ── UTILS ──────────────────────────────────────────────────────
function toCents(v) {
  if (v == null) return 0;
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.\-]/g, "")) : v;
  return (isNaN(n) || !isFinite(n)) ? 0 : Math.round(n * 100);
}
function toMoney(cents, sym) {
  if (cents == null) return (sym || "$") + "0.00";
  const neg = cents < 0, abs = Math.abs(cents);
  return (neg ? "-" : "") + (sym || "$") + Math.floor(abs / 100).toLocaleString() + "." + String(abs % 100).padStart(2, "0");
}
function toShort(cents, sym) {
  const s = toMoney(cents, sym);
  return s.endsWith(".00") ? s.slice(0, -3) : s;
}
function today() { return new Date().toISOString().slice(0, 10); }
function daysUntil(ds) {
  if (!ds) return 30;
  return Math.max(1, Math.ceil((new Date(ds + "T00:00:00") - new Date(today() + "T00:00:00")) / 86400000));
}
function daysBetween(a, b) {
  return Math.max(1, Math.ceil((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000));
}
function uid() { return crypto.randomBytes(12).toString("hex"); }
function ekey(name) { return (name ?? "").toLowerCase().trim().replace(/\s+/g, "_"); }
function monthKey(d) { return d && d.length >= 7 ? d.slice(0, 7) : null; }
function normalizeDate(d) {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return isNaN(new Date(d + "T00:00:00").getTime()) ? null : d;
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

// ── STATE ──────────────────────────────────────────────────────
function createFreshState() {
  return {
    setup: false, balanceCents: 0, currency: "USD", currencySymbol: "$",
    language: "en", payday: null, cycleStart: null,
    envelopes: {}, transactions: [], conversationHistory: [],
    monthlySummaries: {}, cycleHistory: [], undoSnapshot: null,
  };
}

// ── MONTHLY ────────────────────────────────────────────────────
function updateMonthly(s, date, ek, amt, type) {
  const mk = monthKey(date); if (!mk) return;
  if (!s.monthlySummaries[mk]) s.monthlySummaries[mk] = {};
  const m = s.monthlySummaries[mk], nk = ek || "_free";
  if (!m[nk]) m[nk] = { spent: 0, earned: 0, count: 0 };
  if (type === "income") m[nk].earned += amt;
  else { m[nk].spent += amt; m[nk].count += (amt >= 0 ? 1 : -1); }
  if (!m._total) m._total = { spent: 0, earned: 0, count: 0 };
  if (type === "income") m._total.earned += amt;
  else { m._total.spent += amt; m._total.count += (amt >= 0 ? 1 : -1); }
}

// ── CYCLE ──────────────────────────────────────────────────────
function archiveCycle(s) {
  if (!s.cycleStart || !s.setup) return;
  let tot = 0, txC = 0; const es = {};
  for (const [k, e] of Object.entries(s.envelopes)) {
    if (e.active && e.spentCents > 0) { es[k] = e.spentCents; tot += e.spentCents; }
  }
  for (const tx of s.transactions) {
    if (tx.date < s.cycleStart) continue;
    if (tx.type === "spend" || tx.type === "refund") { txC++; if (!tx.envelope || tx.envelope === "free") tot += tx.amountCents; }
  }
  const ce = today(), days = daysBetween(s.cycleStart, ce);
  s.cycleHistory.push({ cycleStart: s.cycleStart, cycleEnd: ce, totalSpentCents: tot, envSpend: es, txCount: txC, daysInCycle: days, avgDailySpend: days > 0 ? Math.round(tot / days) : 0 });
  if (s.cycleHistory.length > 12) s.cycleHistory = s.cycleHistory.slice(-12);
}

// ── ENVELOPE HELPERS ───────────────────────────────────────────
function matchEnvelope(s, desc) {
  if (!desc) return null;
  const lower = desc.toLowerCase();
  let best = null, bestLen = 0;
  for (const [key, e] of Object.entries(s.envelopes)) {
    if (!e.active) continue;
    for (const kw of (e.keywords || [])) {
      if (lower.includes(kw.toLowerCase()) && kw.length > bestLen) { best = key; bestLen = kw.length; }
    }
    if (lower.includes(key) && key.length > bestLen) { best = key; bestLen = key.length; }
  }
  return best;
}
function countOccurrences(nd, iv, end) {
  if (!nd || !end) return 1;
  let c = 0, d = new Date(nd + "T00:00:00"); const e = new Date(end + "T00:00:00"); iv = iv || 30;
  while (d <= e && c < 100) { c++; d.setDate(d.getDate() + iv); }
  return Math.max(c, 0);
}
function envelopeReserve(env, daysLeft, payday) {
  if (!env.active) return 0;
  switch (env.rhythm) {
    case "daily": return Math.max(0, (env.amountCents * daysLeft) - env.spentCents);
    case "weekly": return Math.max(0, (env.amountCents * Math.ceil(daysLeft / 7)) - env.spentCents);
    case "monthly": case "on_income": return Math.max(0, env.amountCents - env.spentCents);
    case "once": return env.amountCents;
    case "ongoing": return env.fundedCents || 0;
    default:
      if (env.nextDate) return env.amountCents * countOccurrences(env.nextDate, env.intervalDays, payday);
      return env.amountCents;
  }
}
function todaySpendOn(s, ek) {
  const t = today(); let c = 0;
  for (const tx of s.transactions) { if (tx.date === t && tx.envelope === ek && tx.type === "spend") c += tx.amountCents; }
  return c;
}
function todayUnmatched(s) {
  const t = today(); let c = 0;
  for (const tx of s.transactions) {
    if (tx.date === t && (tx.type === "spend" || tx.type === "refund") && (!tx.envelope || tx.envelope === "free")) c += tx.amountCents;
  }
  return c;
}
function todayTotal(s) {
  const t = today(); let c = 0;
  for (const tx of s.transactions) { if (tx.date === t && (tx.type === "spend" || tx.type === "refund")) c += tx.amountCents; }
  return c;
}

// ── APPLY ACTION ───────────────────────────────────────────────
function applyAction(state, action) {
  if (!action || !action.type) return state;
  const s = JSON.parse(JSON.stringify(state));
  const d = action.data || {};
  switch (action.type) {
    case "setup": {
      if (d.balanceUSD == null) return s;
      s.setup = true; s.balanceCents = toCents(d.balanceUSD);
      let pd = d.payday ? normalizeDate(d.payday) : null;
      if (pd) { const now = new Date(today() + "T00:00:00"); let dt = new Date(pd + "T00:00:00"); while (dt <= now) dt.setMonth(dt.getMonth() + 1); pd = dt.toISOString().slice(0, 10); }
      s.payday = pd || (() => { const f = new Date(today() + "T00:00:00"); f.setDate(f.getDate() + 30); return f.toISOString().slice(0, 10); })();
      s.cycleStart = d.cycleStart || today();
      if (d.currency) s.currency = d.currency;
      if (d.symbol) s.currencySymbol = d.symbol;
      s.transactions.push({ id: uid(), type: "setup", amountCents: s.balanceCents, description: "Initial balance", envelope: null, date: today(), ts: Date.now() });
      return s;
    }
    case "create_envelope": {
      const key = ekey(d.name); if (!key) return s;
      s.envelopes[key] = {
        name: d.name || key, amountCents: toCents(d.amountUSD || 0),
        targetCents: d.targetUSD ? toCents(d.targetUSD) : null,
        fundedCents: d.fundedUSD ? toCents(d.fundedUSD) : 0, spentCents: 0,
        fundRate: d.fundRate != null ? Math.min(10000, Math.max(0, Math.round(d.fundRate * 10000))) : null,
        fundAmountCents: d.fundAmountUSD ? toCents(d.fundAmountUSD) : null,
        intervalDays: d.intervalDays || 30, nextDate: d.nextDate ? normalizeDate(d.nextDate) : null,
        keywords: d.keywords || [], rhythm: d.rhythm || "monthly",
        priority: d.priority || "flexible", active: true,
      };
      return s;
    }
    case "update_envelope": {
      const key = ekey(d.name), env = s.envelopes[key]; if (!env) return s;
      if (d.amountUSD !== undefined) env.amountCents = toCents(d.amountUSD);
      if (d.targetUSD !== undefined) env.targetCents = toCents(d.targetUSD);
      if (d.addFundedUSD !== undefined) env.fundedCents = Math.max(0, env.fundedCents + toCents(d.addFundedUSD));
      if (d.fundRate !== undefined) env.fundRate = Math.min(10000, Math.max(0, Math.round(d.fundRate * 10000)));
      if (d.fundAmountUSD !== undefined) env.fundAmountCents = toCents(d.fundAmountUSD);
      if (d.keywords !== undefined) env.keywords = d.keywords;
      if (d.rhythm !== undefined) env.rhythm = d.rhythm;
      if (d.priority !== undefined) env.priority = d.priority;
      if (d.nextDate !== undefined) env.nextDate = normalizeDate(d.nextDate);
      if (d.intervalDays !== undefined) env.intervalDays = d.intervalDays;
      if (d.active !== undefined) env.active = d.active;
      return s;
    }
    case "remove_envelope": {
      const key = ekey(d.name); if (s.envelopes[key]) s.envelopes[key].active = false; return s;
    }
    case "spend": {
      const amt = toCents(d.amountUSD); if (amt === 0) return s;
      s.balanceCents -= amt;
      const ek = d.envelope ? ekey(d.envelope) : matchEnvelope(s, d.description || "");
      if (ek && s.envelopes[ek] && s.envelopes[ek].active) s.envelopes[ek].spentCents += amt;
      const txType = amt < 0 ? "refund" : "spend", txDate = today();
      s.transactions.push({ id: uid(), type: txType, amountCents: amt, description: d.description || "", envelope: ek || "free", date: txDate, ts: Date.now() });
      updateMonthly(s, txDate, ek, amt, txType);
      return s;
    }
    case "pay_envelope": {
      const key = ekey(d.name), env = s.envelopes[key]; if (!env || !env.active) return s;
      const payAmt = d.amountUSD !== undefined ? toCents(d.amountUSD) : env.amountCents;
      s.balanceCents -= payAmt; env.amountCents = payAmt;
      const txDate = today();
      s.transactions.push({ id: uid(), type: "envelope_payment", amountCents: payAmt, description: "Paid: " + env.name, envelope: key, date: txDate, ts: Date.now() });
      updateMonthly(s, txDate, "_bills", payAmt, "envelope_payment");
      if (env.nextDate) { const dt = new Date(env.nextDate + "T00:00:00"); dt.setDate(dt.getDate() + (env.intervalDays || 30)); env.nextDate = dt.toISOString().slice(0, 10); }
      return s;
    }
    case "skip_envelope": {
      const key = ekey(d.name), env = s.envelopes[key];
      if (!env || !env.active || !env.nextDate) return s;
      const dt = new Date(env.nextDate + "T00:00:00"); dt.setDate(dt.getDate() + (env.intervalDays || 30)); env.nextDate = dt.toISOString().slice(0, 10);
      return s;
    }
    case "income": {
      const amt = Math.max(0, toCents(d.amountUSD)); if (amt === 0) return s;
      archiveCycle(s); s.balanceCents += amt;
      // Auto-fund: pct first, then fixed. Essential before flexible.
      const pctE = [], fixE = [];
      for (const [k, e] of Object.entries(s.envelopes)) {
        if (!e.active) continue;
        if (e.fundRate > 0) pctE.push([k, e]);
        else if (e.fundAmountCents > 0) fixE.push([k, e]);
      }
      const sp = (a, b) => (a[1].priority === "essential" ? 0 : 1) - (b[1].priority === "essential" ? 0 : 1);
      pctE.sort(sp); fixE.sort(sp);
      let funded = 0; const fundLog = [];
      for (const [k, e] of pctE) { const c = Math.round(amt * e.fundRate / 10000); e.fundedCents += c; funded += c; fundLog.push({ name: e.name, amount: c }); }
      for (const [k, e] of fixE) { const want = e.fundAmountCents, avail = amt - funded, c = Math.min(want, Math.max(0, avail)); if (c > 0) { e.fundedCents += c; funded += c; fundLog.push({ name: e.name, amount: c }); } }
      // Reset all budget envelopes
      for (const [k, e] of Object.entries(s.envelopes)) { if (e.active && ["daily", "weekly", "monthly", "on_income"].includes(e.rhythm)) e.spentCents = 0; }
      if (d.nextPayday) { const np = normalizeDate(d.nextPayday); if (np) s.payday = np; }
      s.cycleStart = today();
      s.transactions.push({ id: uid(), type: "income", amountCents: amt, description: d.description || "Income", envelope: null, date: today(), ts: Date.now() });
      updateMonthly(s, today(), null, amt, "income");
      s._lastFundLog = fundLog; s._lastIncome = amt;
      return s;
    }
    case "fund_envelope": {
      const key = ekey(d.name), env = s.envelopes[key]; if (!env || !env.active) return s;
      const amt = toCents(d.amountUSD); if (amt <= 0) return s;
      env.fundedCents += amt; return s;
    }
    case "correction": {
      s.balanceCents = toCents(d.balanceUSD);
      s.transactions.push({ id: uid(), type: "correction", amountCents: s.balanceCents, description: d.description || "Balance correction", envelope: null, date: today(), ts: Date.now() });
      return s;
    }
    case "undo": { return s.undoSnapshot ? JSON.parse(JSON.stringify(s.undoSnapshot)) : s; }
    case "reset": return createFreshState();
    default: return s;
  }
}

// ── COMPUTE PICTURE ────────────────────────────────────────────
function computePicture(state) {
  const s = JSON.parse(JSON.stringify(state));
  if (!s.setup) return { setup: false };
  const sym = s.currencySymbol || "$", M = c => toMoney(c, sym), dl = daysUntil(s.payday), t = today();

  // Due envelopes
  const dueEnvelopes = [];
  for (const [k, e] of Object.entries(s.envelopes)) {
    if (e.active && e.nextDate && e.nextDate <= t) { e._isDue = true; dueEnvelopes.push({ key: k, name: e.name, amountCents: e.amountCents, nextDate: e.nextDate }); }
  }

  // Reserves + envelope list
  let totalReserved = 0; const envList = [];
  for (const [key, e] of Object.entries(s.envelopes)) {
    if (!e.active) continue;
    const reserved = envelopeReserve(e, dl, s.payday);
    totalReserved += reserved;
    let todayRem = null;
    if (e.rhythm === "daily") todayRem = Math.max(0, e.amountCents - todaySpendOn(s, key));
    envList.push({
      key, name: e.name, rhythm: e.rhythm, priority: e.priority,
      amountCents: e.amountCents, targetCents: e.targetCents,
      fundedCents: e.fundedCents, spentCents: e.spentCents,
      reservedCents: reserved, remainingCents: Math.max(0, reserved),
      todayRemainingCents: todayRem,
      nextDate: e.nextDate, isDue: e._isDue || false,
      daysUntilDue: e.nextDate ? daysUntil(e.nextDate) : null,
      intervalDays: e.intervalDays, keywords: e.keywords || [], active: true,
      amountFormatted: toShort(e.amountCents, sym), reservedFormatted: toShort(reserved, sym),
      spentFormatted: toShort(e.spentCents, sym),
      fundedFormatted: e.fundedCents > 0 ? toShort(e.fundedCents, sym) : null,
      targetFormatted: e.targetCents ? toShort(e.targetCents, sym) : null,
    });
  }

  // THE EQUATION
  const free = s.balanceCents - totalReserved;
  const checksumOk = (totalReserved + free) === s.balanceCents;
  const dailyPace = dl > 0 ? Math.floor(free / dl) : free;
  const freeToday = dailyPace - todayUnmatched(s);

  // Aggregates
  const wcs = (() => { const d = new Date(t + "T00:00:00"); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10); })();
  let weekSpent = 0;
  for (const tx of s.transactions) { if (tx.date >= wcs && (tx.type === "spend" || tx.type === "refund")) weekSpent += tx.amountCents; }
  const mk = monthKey(t), mSnap = s.monthlySummaries[mk] || {};
  const monthSpent = mSnap._total ? mSnap._total.spent : 0;

  // Cycle stats
  const cyCut = s.cycleStart || t; let cySpent = 0, cyTxC = 0;
  for (const tx of s.transactions) {
    if (tx.date < cyCut) continue;
    if (tx.type === "spend" || tx.type === "refund") { cySpent += tx.amountCents; cyTxC++; }
    if (tx.type === "envelope_payment") cySpent += tx.amountCents;
  }
  const cyDays = Math.max(1, daysBetween(cyCut, t));

  // Savings
  let totalSaved = 0; const savingsEnvs = [];
  for (const e of envList) {
    if ((e.rhythm === "ongoing" || e.targetCents) && e.fundedCents > 0) { totalSaved += e.fundedCents; savingsEnvs.push(e); }
  }

  const upcoming = envList.filter(e => e.daysUntilDue != null && e.daysUntilDue > 0 && e.daysUntilDue <= 7);

  return {
    setup: true, currency: s.currency || "USD", currencySymbol: sym,
    balanceCents: s.balanceCents, balanceFormatted: M(s.balanceCents),
    freeCents: free, freeFormatted: M(free),
    dailyPaceCents: dailyPace, dailyPaceFormatted: M(dailyPace),
    freeRemainingTodayCents: freeToday, freeRemainingTodayFormatted: M(freeToday),
    daysLeft: dl, payday: s.payday, cycleStart: s.cycleStart,
    totalReservedCents: totalReserved, totalReservedFormatted: M(totalReserved),
    envelopes: envList,
    todaySpentCents: todayTotal(s),
    thisWeekSpentCents: weekSpent, thisWeekSpentFormatted: M(weekSpent),
    thisMonthSpentCents: monthSpent, thisMonthSpentFormatted: M(monthSpent),
    weeklyPaceCents: dailyPace * 7, weeklyPaceFormatted: M(dailyPace * 7),
    cycleStats: { totalSpent: cySpent, totalSpentFormatted: M(cySpent), dailyAvg: Math.round(cySpent / cyDays), dailyAvgFormatted: M(Math.round(cySpent / cyDays)), txCount: cyTxC, daysInCycle: cyDays },
    dueEnvelopes, upcomingEnvelopes: upcoming,
    totalSavedCents: totalSaved, totalSavedFormatted: M(totalSaved), savingsEnvelopes: savingsEnvs,
    transactions: s.transactions.slice(-20).reverse(),
    monthlySnapshot: mSnap, checksumOk,
  };
}

// ── QUERY (delegated) ──────────────────────────────────────────
const { runQuery: _runQuery } = require("./vera-v3-query");
function runQuery(state, query) { return _runQuery(state, query, computePicture, toMoney); }

// ── EXPORTS ────────────────────────────────────────────────────
module.exports = {
  toCents, toMoney, toShort, today, daysUntil, daysBetween, monthKey, uid, ekey,
  createFreshState, applyAction, computePicture, runQuery,
  matchEnvelope, envelopeReserve, countOccurrences,
  updateMonthly, archiveCycle, todayUnmatched, todayTotal,
};
