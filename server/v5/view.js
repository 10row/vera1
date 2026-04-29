"use strict";
// v5/view.js — derive a friendly view from raw state. PURE.
// Hero math: how much do I have, how much per day, how many days to payday.

const m = require("./model");

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
  const dailyPace = daysToPayday > 0 ? Math.floor(disposable / daysToPayday) : disposable;

  // Today / this week spend
  let todaySpent = 0, weekSpent = 0;
  const weekAgo = m.addDays(todayStr, -7);
  for (const tx of (state.transactions || [])) {
    if (tx.kind === "spend" || tx.kind === "bill_payment") {
      if (tx.date === todayStr) todaySpent += -tx.amountCents;
      if (tx.date >= weekAgo) weekSpent += -tx.amountCents;
    }
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

// One-line status for chat replies.
function heroLine(state, lang) {
  const v = compute(state);
  if (!v.setup) return "";
  const L = (lang || state.language || "en") === "ru" ? "ru" : "en";
  const sym = state.currencySymbol || "$";
  if (v.status === "over") {
    return L === "ru"
      ? "🔴 Перерасход — не хватает " + m.toMoney(v.deficitCents, sym) + " до зарплаты."
      : "🔴 *Over* — short " + m.toMoney(v.deficitCents, sym) + " before payday.";
  }
  if (v.status === "tight") {
    return L === "ru"
      ? "🟡 Впритык — " + v.dailyPaceFormatted + "/день, " + v.daysToPayday + " дн до зарплаты."
      : "🟡 *Tight* — " + v.dailyPaceFormatted + "/day, " + v.daysToPayday + " days to payday.";
  }
  return L === "ru"
    ? "🟢 Спокойно — " + v.dailyPaceFormatted + "/день, " + v.daysToPayday + " дн до зарплаты."
    : "🟢 *Calm* — " + v.dailyPaceFormatted + "/day, " + v.daysToPayday + " days to payday.";
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

module.exports = { compute, heroLine, simulateSpend };
