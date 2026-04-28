"use strict";
// v4/view.js — pure derivation of display values from state.
// The single source of truth for what the user sees.
// Never mutates state. Never lies about negative numbers.

const m = require("./model");

// Display states:
//   green — comfortable, > $5/day pace
//   tight — disposable >= 0 but pace < $5/day
//   over  — disposable < 0 (deficit). UI shows deficit, not negative pace.
const TIGHT_THRESHOLD_CENTS = 5_00;

function compute(state, todayStr) {
  if (!state || !state.setup) return { setup: false };

  const tz = state.timezone || "UTC";
  const today = todayStr || m.today(tz);
  const sym = state.currencySymbol || "$";
  const M = c => m.toMoney(c, sym);
  const Sh = c => m.toShort(c, sym);

  const daysToPayday = state.payday ? Math.max(1, m.daysBetween(today, state.payday)) : 30;
  const paydayOverdue = state.payday ? m.daysBetween(today, state.payday) < 0 : false;

  const envList = [];
  let obligated = 0;     // sum reserved for bills+budgets remaining this cycle
  let savedToward = 0;   // sum of goal funded
  const dueNow = [];
  const upcoming = [];

  for (const env of Object.values(state.envelopes || {})) {
    if (!env.active) continue;
    let unpaid = 0;
    let reservedHere = 0;

    if (env.kind === "bill") {
      const remaining = Math.max(0, env.amountCents - env.spentCents);
      // Only count toward obligation if it falls due on or before payday.
      const dueByPayday = env.dueDate
        ? (state.payday ? env.dueDate <= state.payday : true)
        : true;
      if (dueByPayday) {
        obligated += remaining;
        reservedHere = remaining;
      }
      unpaid = remaining;
      if (env.dueDate && env.dueDate <= today && remaining > 0) {
        dueNow.push({ key: env.key, name: env.name, amountCents: remaining, amountFormatted: M(remaining), dueDate: env.dueDate });
      } else if (env.dueDate) {
        const d = m.daysBetween(today, env.dueDate);
        if (d > 0 && d <= 7 && remaining > 0) {
          upcoming.push({ key: env.key, name: env.name, amountCents: remaining, amountFormatted: M(remaining), dueDate: env.dueDate, daysUntilDue: d });
        }
      }
    } else if (env.kind === "budget") {
      const remaining = Math.max(0, env.amountCents - env.spentCents);
      obligated += remaining;
      reservedHere = remaining;
    } else if (env.kind === "goal") {
      savedToward += env.fundedCents;
    }

    envList.push({
      key: env.key, name: env.name, kind: env.kind,
      amountCents: env.amountCents, amountFormatted: Sh(env.amountCents),
      spentCents: env.spentCents, spentFormatted: Sh(env.spentCents),
      reservedCents: reservedHere, reservedFormatted: Sh(reservedHere),
      fundedCents: env.fundedCents,
      targetCents: env.targetCents,
      dueDate: env.dueDate,
      daysUntilDue: env.dueDate ? m.daysBetween(today, env.dueDate) : null,
      isDue: env.dueDate ? env.dueDate <= today : false,
      unpaidCents: unpaid,
      keywords: env.keywords || [],
    });
  }

  const disposable = state.balanceCents - obligated;
  const deficit = disposable < 0 ? -disposable : 0;
  // dailyPace is NEVER negative as a display number. If disposable<0 the UI
  // surfaces deficit instead and switches into the "over" state.
  const dailyPace = disposable > 0 ? Math.floor(disposable / daysToPayday) : 0;

  let displayState;
  if (disposable < 0) displayState = "over";
  else if (dailyPace < TIGHT_THRESHOLD_CENTS) displayState = "tight";
  else displayState = "green";

  // Today's spend totals (for "you've spent X today" + remaining-today calc).
  let todayTotal = 0;
  let todayUnmatched = 0; // not assigned to any envelope
  for (const tx of state.transactions || []) {
    if (tx.date !== today) continue;
    if (tx.kind !== "spend" && tx.kind !== "refund") continue;
    todayTotal += tx.amountCents;
    if (!tx.envelopeKey) todayUnmatched += tx.amountCents;
  }
  const todayRemaining = Math.max(0, dailyPace - todayUnmatched);

  // Week and month totals (rolling window for week, calendar for month).
  let weekTotal = 0;
  const weekFloor = m.addDays(today, -6);
  for (const tx of state.transactions || []) {
    if (!tx.date || tx.date < weekFloor) continue;
    if (tx.kind === "spend" || tx.kind === "refund") weekTotal += tx.amountCents;
  }
  let monthTotal = 0;
  const monthPrefix = today.slice(0, 7);
  for (const tx of state.transactions || []) {
    if (!tx.date || !tx.date.startsWith(monthPrefix)) continue;
    if (tx.kind === "spend" || tx.kind === "refund") monthTotal += tx.amountCents;
  }

  // Invariant check (cheap): obligated + disposable === balanceCents
  const invariantOk = (obligated + disposable) === state.balanceCents;

  return {
    setup: true,
    state: displayState,
    currency: state.currency || "USD",
    currencySymbol: sym,
    balanceCents: state.balanceCents, balanceFormatted: M(state.balanceCents),
    obligatedCents: obligated, obligatedFormatted: M(obligated),
    disposableCents: disposable, disposableFormatted: M(disposable),
    deficitCents: deficit, deficitFormatted: M(deficit),
    dailyPaceCents: dailyPace, dailyPaceFormatted: M(dailyPace),
    daysToPayday,
    payday: state.payday,
    paydayOverdue,
    todaySpentCents: todayTotal, todaySpentFormatted: M(todayTotal),
    todayRemainingCents: todayRemaining, todayRemainingFormatted: M(todayRemaining),
    weekSpentCents: weekTotal, weekSpentFormatted: M(weekTotal),
    monthSpentCents: monthTotal, monthSpentFormatted: M(monthTotal),
    savedTowardCents: savedToward, savedTowardFormatted: M(savedToward),
    envelopes: envList,
    dueNow,
    upcoming,
    invariantOk,
  };
}

// simulate(state, simulatedSpend) returns the view AS IF the simulated
// spend had been applied — without mutating state. Used by Decision
// Support: "Can I afford $200 shoes?" → simulate, show the new view,
// offer to record it.
//
// simulatedSpend: { amountCents, envelopeKey?, note? }
// Returns: { current, projected, delta }
//   current   — view of the real state today
//   projected — view as if the spend had happened
//   delta     — { dailyPaceDelta, disposableDelta, stateChange }
function simulate(state, simulatedSpend, todayStr) {
  const current = compute(state, todayStr);
  if (!current.setup) return { current, projected: current, delta: null };

  // Apply the spend to a clone WITHOUT going through engine — pure read.
  const clone = JSON.parse(JSON.stringify(state));
  const amt = Math.round(simulatedSpend && simulatedSpend.amountCents || 0);
  if (amt > 0) {
    clone.balanceCents -= amt;
    const ek = simulatedSpend.envelopeKey ? simulatedSpend.envelopeKey : null;
    if (ek && clone.envelopes[ek] && clone.envelopes[ek].active) {
      clone.envelopes[ek].spentCents += amt;
    }
  }
  const projected = compute(clone, todayStr);
  return {
    current,
    projected,
    delta: {
      dailyPaceDelta: projected.dailyPaceCents - current.dailyPaceCents,
      disposableDelta: projected.disposableCents - current.disposableCents,
      stateChange: current.state !== projected.state ? { from: current.state, to: projected.state } : null,
    },
  };
}

module.exports = { compute, simulate };
