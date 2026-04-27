"use strict";
function runQuery(state, query, computePicture, toMoney) {
  if (!query || !query.type) return { error: "Invalid query" };
  const sym = state.currencySymbol || "$";
  const M = c => toMoney(c, sym);
  const t = new Date().toISOString().slice(0, 10);
  const mk = t.slice(0, 7);
  switch (query.type) {
    case "envelope_spend": {
      const key = (query.envelope || "").toLowerCase().trim().replace(/\s+/g, "_");
      const mo = query.month || mk, ms = state.monthlySummaries[mo];
      if (ms && ms[key]) return { envelope: key, month: mo, spentCents: ms[key].spent, spentFormatted: M(ms[key].spent), txCount: ms[key].count };
      return { envelope: key, month: mo, spentCents: 0, spentFormatted: M(0), txCount: 0 };
    }
    case "month_total": {
      const mo = query.month || mk, ms = state.monthlySummaries[mo];
      if (ms && ms._total) return { month: mo, spentCents: ms._total.spent, spentFormatted: M(ms._total.spent), earnedCents: ms._total.earned, earnedFormatted: M(ms._total.earned) };
      return { month: mo, spentCents: 0, spentFormatted: M(0), earnedCents: 0, earnedFormatted: M(0) };
    }
    case "top_envelopes": {
      const mo = query.month || mk, ms = state.monthlySummaries[mo] || {};
      const envs = [];
      for (const [k, v] of Object.entries(ms)) {
        if (k.startsWith("_")) continue;
        envs.push({ envelope: k, spentCents: v.spent, spentFormatted: M(v.spent), txCount: v.count });
      }
      envs.sort((a, b) => b.spentCents - a.spentCents);
      return { month: mo, envelopes: envs };
    }
    case "search_spend": {
      const kw = (query.keyword || "").toLowerCase().trim();
      if (!kw) return { keyword: "", days: 0, count: 0, spentCents: 0, spentFormatted: M(0), matches: [], error: "No keyword" };
      const days = query.days || 30;
      const cut = new Date(t + "T00:00:00");
      cut.setDate(cut.getDate() - days);
      const cs = cut.toISOString().slice(0, 10);
      let tot = 0, cnt = 0; const matches = [];
      for (const tx of state.transactions) {
        if (tx.date < cs || (tx.type !== "spend" && tx.type !== "refund")) continue;
        if (tx.description && tx.description.toLowerCase().includes(kw)) {
          tot += tx.amountCents; cnt++;
          matches.push({ date: tx.date, description: tx.description, amountFormatted: M(tx.amountCents), envelope: tx.envelope });
        }
      }
      return { keyword: kw, days, count: cnt, spentCents: tot, spentFormatted: M(tot), matches: matches.slice(-20) };
    }
    case "projection": {
      const pic = computePicture(state);
      if (!pic.setup) return { error: "Not set up" };
      const db = pic.cycleStats.dailyAvg, proj = db * pic.daysLeft;
      const verdict = pic.freeCents <= 0 ? "over_budget" : proj > pic.freeCents ? "tight" : "comfortable";
      return { freeCents: pic.freeCents, freeFormatted: M(pic.freeCents), projectedCents: proj, projectedFormatted: M(proj), verdict };
    }
    case "trend": {
      if (!state.cycleHistory.length) return { trend: "no_history" };
      if (state.cycleHistory.length < 2) return { trend: "insufficient_data", lastCycleFormatted: M(state.cycleHistory[0].totalSpentCents) };
      const last = state.cycleHistory[state.cycleHistory.length - 1];
      const prev = state.cycleHistory[state.cycleHistory.length - 2];
      const pct = prev.totalSpentCents > 0 ? Math.round(((last.totalSpentCents - prev.totalSpentCents) / prev.totalSpentCents) * 100) : 0;
      return { direction: pct > 5 ? "up" : pct < -5 ? "down" : "stable", pctChange: pct, lastCycleFormatted: M(last.totalSpentCents) };
    }
    default: return { error: "Unknown query: " + query.type };
  }
}
module.exports = { runQuery };
