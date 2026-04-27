"use strict";
// vera-v2-query.js — Query system (extracted from vera-v2.js)

function runQuery(state, query, computePicture, toMoney) {
  if (!query || !query.type) return { error: "Invalid query" };
  const s = state, mk = s._mk;
  const sym = s.currencySymbol || "$";
  const M = c => toMoney(c, sym);
  const z = sym + "0.00";
  function today() { return new Date().toISOString().slice(0, 10); }
  const t = today();
  if (!mk) { const _mk = t.slice(0,7); }
  const mKey = (t || "").slice(0,7);
  switch (query.type) {
    case "pool_spend": {
      const pk = query.pool ? query.pool.toLowerCase().trim() : "";
      const mo = query.month || mKey, ms = s.monthlySummaries[mo];
      if (ms && ms[pk]) return { pool:pk, month:mo, spentCents:ms[pk].spent, spentUSD:M(ms[pk].spent), txCount:ms[pk].count };
      return { pool:pk, month:mo, spentCents:0, spentUSD:z, txCount:0 };
    }
    case "month_total": {
      const mo = query.month || mKey, ms = s.monthlySummaries[mo];
      if (ms && ms["_total"]) {
        const mt = ms["_total"];
        return { month:mo, spentCents:mt.spent, spentUSD:M(mt.spent), earnedCents:mt.earned, earnedUSD:M(mt.earned), txCount:mt.count };
      }
      return { month:mo, spentCents:0, spentUSD:z, earnedCents:0, earnedUSD:z, txCount:0 };
    }
    case "top_pools": {
      const mo = query.month || mKey, ms = s.monthlySummaries[mo] || {};
      const pools = [];
      for (const [k, v] of Object.entries(ms)) {
        if (k.startsWith("_")) continue;
        pools.push({ pool:k, spentCents:v.spent, spentUSD:M(v.spent), txCount:v.count });
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
          matches.push({ date:tx.date, description:tx.description, amountUSD:M(tx.amountCents) });
        }
      }
      return { keyword:kw, days, count:cnt, spentCents:tot, spentUSD:M(tot), matches:matches.slice(-20) };
    }
    case "daily_average": {
      const txD = new Set(); let tot = 0;
      for (const tx of s.transactions) {
        if (tx.type === "transaction" || tx.type === "refund") {
          tot += tx.amountCents; txD.add(tx.date);
        }
      }
      const nd = Math.max(1, txD.size), avg = Math.round(tot / nd);
      return { avgCents:avg, avgUSD:M(avg), daysTracked:txD.size };
    }
    case "projection": {
      const pic = computePicture(s);
      if (!pic.setup) return { error: "Not set up yet" };
      const dl = pic.daysLeft || 1;
      const db = pic.cycleStats ? pic.cycleStats.dailyAvg : 0;
      const proj = db * dl, free = pic.trulyFreeCents;
      const v = free <= 0 ? "over_budget" : proj > free ? "tight" : "comfortable";
      return { freeCents:free, freeUSD:M(free), projectedSpendCents:proj, projectedSpendUSD:M(proj), dailyBurnCents:db, dailyBurnUSD:M(db), daysLeft:dl, verdict:v };
    }
    case "trend": {
      if (s.cycleHistory.length === 0) return { trend: "no_history" };
      const last = s.cycleHistory[s.cycleHistory.length - 1];
      const pk = query.pool ? query.pool.toLowerCase().trim() : null;
      if (pk) {
        const lp = last.poolSpend[pk] || 0;
        const pv = s.cycleHistory.length > 1 ? (s.cycleHistory[s.cycleHistory.length - 2].poolSpend[pk] || 0) : lp;
        const pc = pv > 0 ? Math.round(((lp - pv) / pv) * 100) : 0;
        return { pool:pk, direction:pc > 5 ? "up" : pc < -5 ? "down" : "stable", pctChange:pc, lastCycleCents:lp, lastCycleUSD:M(lp) };
      }
      const lt = last.totalSpentCents;
      const pv = s.cycleHistory.length > 1 ? s.cycleHistory[s.cycleHistory.length - 2].totalSpentCents : lt;
      const pc = pv > 0 ? Math.round(((lt - pv) / pv) * 100) : 0;
      return { direction:pc > 5 ? "up" : pc < -5 ? "down" : "stable", pctChange:pc, lastCycleCents:lt, lastCycleUSD:M(lt), avgDailyUSD:M(last.avgDailySpend) };
    }
    case "savings_history": {
      const h = s.cycleHistory.map(c => ({ cycleEnd:c.cycleEnd, savedCents:c.savedCents, savedUSD:M(c.savedCents) }));
      return { currentSavingsCents:s.savingsCents, currentSavingsUSD:M(s.savingsCents), rateBps:s.savingRateBps, history:h };
    }
    default: return { error: "Unknown query: " + query.type };
  }
}

module.exports = { runQuery };
