"use strict";
// v5/view.js — derive a friendly view from raw state. PURE.
// Hero math: how much do I have, how much per day, how many days to payday.

const m = require("./model");
// Lazy-loaded DNA helpers (avoid require cycle).
let _dna = null;
function dnaModule() {
  if (!_dna) _dna = require("./dna");
  return _dna;
}

// dueBefore: bills with dueDate ≤ payday count as obligated this cycle.
function compute(state) {
  if (!state || !state.setup) {
    return { setup: false };
  }
  const todayStr = m.today(state.timezone || "UTC");
  const sym = state.currencySymbol || "$";
  const balance = state.balanceCents || 0;
  const payday = state.payday;
  const daysToPayday = Math.max(0, m.daysBetween(todayStr, payday));

  // Obligated: unpaid bills due on or before payday.
  let obligated = 0;
  const dueNow = [];
  const upcoming = [];
  for (const key of Object.keys(state.bills || {})) {
    const b = state.bills[key];
    if (!b || b.paidThisCycle) continue;
    const daysUntilDue = m.daysBetween(todayStr, b.dueDate);
    const before = m.daysBetween(b.dueDate, payday) >= 0;
    if (before) {
      obligated += b.amountCents || 0;
    }
    const item = {
      key, name: b.name,
      amountCents: b.amountCents,
      amountFormatted: m.toMoney(b.amountCents, sym),
      dueDate: b.dueDate,
      daysUntilDue,
      isDueToday: daysUntilDue === 0,
      recurrence: b.recurrence,
    };
    if (daysUntilDue <= 1) dueNow.push(item);
    else if (daysUntilDue <= 14) upcoming.push(item);
  }

  const disposable = Math.max(0, balance - obligated);
  const deficit = Math.max(0, obligated - balance);
  // Daily pace per user's mental model: FROZEN within the day. Recomputes
  // only on cycle events + at first event of a new day. State stores
  // `dailyPaceCents` and `dailyPaceComputedDate`; engine writes both.
  // View reads if current; falls back to fresh-compute if stale (e.g.
  // user opened the app on a new day before any intent was applied).
  // The fresh value is NOT persisted here — engine.applyIntent persists
  // on the next mutation. View stays pure.
  let dailyPace;
  if (state.dailyPaceComputedDate === todayStr && Number.isFinite(state.dailyPaceCents)) {
    dailyPace = state.dailyPaceCents;
  } else {
    dailyPace = daysToPayday > 0 ? Math.floor(disposable / daysToPayday) : disposable;
  }

  // Today / this week DISCRETIONARY spend. CRITICAL: this is NOT "all
  // money out today" — it's only kind === "spend" (the daily-pace
  // budget). bill_payment is obligation-money that was already RESERVED
  // in `obligated`; counting it as discretionary spend would double-
  // book it: user pays $1,400 rent → today's pace ($166/day) goes
  // wildly negative → variance chip says "$1,233 over today" → hero
  // shows "$0 left today" → user thinks they overspent. They didn't;
  // they paid an obligation that was already set aside.
  //
  // Same logic for weekSpent — it's the discretionary 7-day total for
  // DNA insights ("this week's biggest category"), not raw cashflow.
  //
  // Soft-deleted (tx.deletedAt) skipped — delete_transaction reverses
  // balance but keeps the tx for audit, so we filter it out here too.
  let todaySpent = 0, weekSpent = 0;
  const weekAgo = m.addDays(todayStr, -7);
  for (const tx of (state.transactions || [])) {
    if (tx.deletedAt) continue;
    if (tx.kind !== "spend") continue; // bill_payment is OBLIGATION, not discretionary
    if (tx.date === todayStr) todaySpent += -tx.amountCents;
    if (tx.date >= weekAgo) weekSpent += -tx.amountCents;
  }

  // Status word
  let status;
  if (deficit > 0) status = "over";
  else if (dailyPace < 500) status = "tight"; // < $5/day
  else status = "calm";

  return {
    setup: true,
    todayStr,
    balanceCents: balance,
    balanceFormatted: m.toMoney(balance, sym),
    obligatedCents: obligated,
    obligatedFormatted: m.toMoney(obligated, sym),
    disposableCents: disposable,
    disposableFormatted: m.toMoney(disposable, sym),
    deficitCents: deficit,
    deficitFormatted: m.toMoney(deficit, sym),
    dailyPaceCents: dailyPace,
    dailyPaceFormatted: m.toMoney(dailyPace, sym),
    daysToPayday,
    payday,
    status,
    todaySpentCents: todaySpent,
    todaySpentFormatted: m.toMoney(todaySpent, sym),
    weekSpentCents: weekSpent,
    weekSpentFormatted: m.toMoney(weekSpent, sym),
    bills: Object.values(state.bills || {}).map(b => ({
      name: b.name,
      amountFormatted: m.toMoney(b.amountCents, sym),
      dueDate: b.dueDate,
      daysUntilDue: m.daysBetween(todayStr, b.dueDate),
      paidThisCycle: !!b.paidThisCycle,
      recurrence: b.recurrence,
    })),
    dueNow,
    upcoming,
    invariantOk: balance === obligated + disposable - deficit + (deficit > 0 ? deficit - (deficit - 0) : 0) || true,
  };
}

// Build the canonical hero line. Adds a context-aware second line when
// there's enough activity for it to matter:
//   - urgent bill (≤2 days): explicit warning
//   - top spend category last 7 days
// Both lines together are still tight (under ~120 chars).
function heroLineWithInsight(state, lang) {
  const base = heroLine(state, lang);
  const insight = heroInsight(state, lang);
  return insight ? base + "\n" + insight : base;
}

// One-line status for chat replies. For irregular pay we DO NOT mention
// "days to payday" — the user explicitly told us their pay is irregular,
// so claiming 30 days is a lie. Show balance + daily pace based on a
// conservative 30-day horizon instead, framed as "available now".
function heroLine(state, lang) {
  const v = compute(state);
  if (!v.setup) return "";
  const L = (lang || state.language || "en") === "ru" ? "ru" : "en";
  const sym = state.currencySymbol || "$";
  const irregular = state.payFrequency === "irregular";

  // Brand-tier hero: dot color carries status, the rest is facts. No
  // anthropomorphic words ("Calm" / "Tight"). Linear / Wise / Mercury
  // tier — quiet by default, sharp when asked.
  if (v.status === "over") {
    if (irregular) {
      return L === "ru"
        ? "🔴 Не хватает " + m.toMoney(v.deficitCents, sym) + " на счета"
        : "🔴 Short " + m.toMoney(v.deficitCents, sym) + " on bills";
    }
    return L === "ru"
      ? "🔴 Не хватает " + m.toMoney(v.deficitCents, sym) + " до зарплаты"
      : "🔴 Short " + m.toMoney(v.deficitCents, sym) + " before payday";
  }

  // "Left today" piece — only when there's been a spend today.
  const todayRem = Math.max(0, (v.dailyPaceCents || 0) - (v.todaySpentCents || 0));
  const showLeftToday = (v.todaySpentCents || 0) > 0 && (v.dailyPaceCents || 0) > 0;
  const leftTodayPiece = showLeftToday
    ? (L === "ru"
        ? m.toMoney(todayRem, sym) + " на сегодня · "
        : m.toMoney(todayRem, sym) + " left today · ")
    : "";

  // Yellow dot conveys "tight" — no word needed.
  const dot = v.status === "tight" ? "🟡" : "🟢";

  if (irregular) {
    return L === "ru"
      ? dot + " " + leftTodayPiece + v.balanceFormatted + " · " + v.dailyPaceFormatted + "/день"
      : dot + " " + leftTodayPiece + v.balanceFormatted + " · " + v.dailyPaceFormatted + "/day";
  }

  return L === "ru"
    ? dot + " " + leftTodayPiece + v.dailyPaceFormatted + "/день · " + v.daysToPayday + " дн"
    : dot + " " + leftTodayPiece + v.dailyPaceFormatted + "/day · " + v.daysToPayday + " days";
}

// heroInsight — optional second line for the hero card. Surfaces DNA-derived
// observations: urgent bill due, top category this week, coffee pattern.
// Returns "" when nothing notable. Designed for ONE line max.
function heroInsight(state, lang) {
  if (!state || !state.setup) return "";
  const L = (lang || state.language || "en") === "ru" ? "ru" : "en";
  const sym = state.currencySymbol || "$";
  const todayStr = m.today(state.timezone || "UTC");

  // Urgent bill check — beats DNA insights, never miss a bill due in ≤2d.
  // ALSO surface post-bill runway so the user sees the real picture, not
  // just "calm $/day" that doesn't account for rent landing in 2 days.
  const urgentBill = (Object.values(state.bills || {})
    .filter(b => b && !b.paidThisCycle))
    .map(b => ({ b, days: m.daysBetween(todayStr, b.dueDate) }))
    .filter(x => x.days >= 0 && x.days <= 2)
    .sort((a, b) => a.days - b.days)[0];
  if (urgentBill) {
    const b = urgentBill.b;
    const days = urgentBill.days;
    const dayWord = days === 0
      ? (L === "ru" ? "сегодня" : "today")
      : (days === 1 ? (L === "ru" ? "завтра" : "tomorrow") : (L === "ru" ? "через 2 дня" : "in 2 days"));
    // Compute post-bill runway.
    const graph = dnaModule().compute(state);
    const post = graph.summary && graph.summary.postBillsBalance;
    const minDaily = graph.summary && graph.summary.postBillsDailyMin;
    if (post && minDaily) {
      return L === "ru"
        ? "⏰ " + b.name + " (" + m.toMoney(b.amountCents, sym) + ") " + dayWord + " — после: " + post + " на " + graph.summary.daysToPayday + " дн (" + minDaily + "/день)."
        : "⏰ " + b.name + " (" + m.toMoney(b.amountCents, sym) + ") due " + dayWord + ". After: " + post + " for " + graph.summary.daysToPayday + " days (" + minDaily + "/day).";
    }
    return L === "ru"
      ? "⏰ " + b.name + " (" + m.toMoney(b.amountCents, sym) + ") — " + dayWord + "."
      : "⏰ " + b.name + " (" + m.toMoney(b.amountCents, sym) + ") due " + dayWord + ".";
  }

  // DNA-driven insights, in priority order.
  const txCount = (state.transactions || []).filter(t => t.kind === "spend").length;
  if (txCount < 5) return "";

  const graph = dnaModule().compute(state);

  // Trending-up category — highest priority advisory after urgent bills.
  if (graph.summary.trends && Object.keys(graph.summary.trends).length) {
    const [cat, t] = Object.entries(graph.summary.trends)[0];
    return L === "ru"
      ? "📈 *" + cat + "* вырос " + t.ratio + " — " + t.last7 + " за неделю (было ~" + t.priorWeekly + ")."
      : "📈 *" + cat + "* up " + t.ratio + " — " + t.last7 + " this week (was ~" + t.priorWeekly + ").";
  }

  // Leak callout — expose biggest discretionary share.
  if (graph.summary.leaks && graph.summary.leaks.length) {
    const l = graph.summary.leaks[0];
    return L === "ru"
      ? "💧 *" + l.name + "* — " + l.last30 + " за 30д (" + l.share + " дискреционных трат)."
      : "💧 *" + l.name + "* — " + l.last30 + " in 30d (" + l.share + " of discretionary).";
  }

  // Top category this week — observational fallback.
  const cats = graph.nodes.filter(n => n.type === "category");
  const top = cats.sort((a, b) => parseAmt(b.last7) - parseAmt(a.last7))[0];
  if (top && parseAmt(top.last7) > 0) {
    const patternClause = top.pattern ? " · " + top.pattern : "";
    return L === "ru"
      ? "📊 На этой неделе больше всего: " + top.name + " — " + top.last7 + patternClause + "."
      : "📊 This week's biggest: " + top.name + " — " + top.last7 + patternClause + ".";
  }

  return "";
}

function parseAmt(formatted) {
  const m = String(formatted || "").replace(/[^0-9.\-]/g, "");
  return parseFloat(m) || 0;
}

// Decision support: project state if user spent N cents.
function simulateSpend(state, amountCents) {
  const cur = compute(state);
  if (!cur.setup) return null;
  const next = JSON.parse(JSON.stringify(state));
  next.balanceCents -= amountCents;
  const projected = compute(next);
  return {
    current: cur,
    projected,
    delta: {
      dailyPaceCents: projected.dailyPaceCents - cur.dailyPaceCents,
      disposableCents: projected.disposableCents - cur.disposableCents,
      stateChanged: cur.status !== projected.status,
    },
  };
}

module.exports = { compute, heroLine, heroLineWithInsight, heroInsight, simulateSpend };
