"use strict";
// v4/proactive.js — three calibrated moments where the bot reaches out
// unprompted, and zero others. Pure module: never mutates state.
//
// Three message types:
//   bill      — bill due today or tomorrow. Once per (envKey, dueDate).
//   pace      — 7-day rolling spend > 25% above the safe daily pace.
//                Once per cycleStart.
//   milestone — goal crosses 25/50/75/100%. Once per (envKey, threshold).
//
// State tracking:
//   state.proactiveSent = {
//     bills: { [envKey]: dueDate },          // notified for this exact dueDate
//     pace:  cycleStart,                       // notified during this cycle
//     milestones: { [envKey]: maxThreshold },  // highest threshold celebrated
//   }
//   state.mute = { bills, pace, milestones }   // booleans, all default false

const m = require("./model");
const { compute, heroLine } = require("./view");

// Returns an array of message descriptors. Pure.
//   { type: "bill"|"pace"|"milestone", text, ...metadata }
function decideProactive(state, todayStr) {
  if (!state || !state.setup) return [];
  const today = todayStr || m.today(state.timezone || "UTC");
  const view = compute(state, today);
  const sent = state.proactiveSent || {};
  const mute = state.mute || {};
  const sym = state.currencySymbol || "$";
  const M = (c) => m.toMoney(c, sym);
  const messages = [];

  // 1. BILL ANTICIPATION: bills due today or tomorrow that we haven't paid.
  if (!mute.bills) {
    for (const env of view.envelopes) {
      if (env.kind !== "bill" || !env.dueDate) continue;
      if (env.spentCents >= env.amountCents) continue; // already covered this cycle
      const days = m.daysBetween(today, env.dueDate);
      if (days < 0 || days > 1) continue;
      const alreadySent = sent.bills && sent.bills[env.key] === env.dueDate;
      if (alreadySent) continue;
      messages.push({
        type: "bill",
        envKey: env.key,
        dueDate: env.dueDate,
        text: days === 0
          ? "Heads up — *" + env.name + "* due today, " + env.amountFormatted + "."
          : "*" + env.name + "* due tomorrow, " + env.amountFormatted + ".",
      });
    }
  }

  // 2. OFF-PACE WARNING: 7-day rolling spend > 1.25× the safe daily pace.
  if (!mute.pace && view.dailyPaceCents > 0) {
    const weekAgo = m.addDays(today, -6);
    let rolling7 = 0;
    let countedDays = 0;
    const dayBuckets = new Set();
    for (const tx of state.transactions || []) {
      if (!tx.date || tx.date < weekAgo) continue;
      if (tx.kind !== "spend" && tx.kind !== "refund") continue;
      rolling7 += tx.amountCents;
      dayBuckets.add(tx.date);
    }
    countedDays = Math.min(7, Math.max(1, dayBuckets.size));
    const dailyRate = rolling7 / countedDays;
    const safePace = view.dailyPaceCents;
    if (dailyRate > safePace * 1.25 && countedDays >= 3) {
      const cycleStart = state.cycleStart || view.payday || today;
      if (sent.pace !== cycleStart) {
        const ratioPct = Math.round((dailyRate / safePace) * 100);
        messages.push({
          type: "pace",
          cycleStart,
          text: "Spending at " + ratioPct + "% of your safe pace this week (" + M(Math.round(dailyRate)) + "/day vs " + view.dailyPaceFormatted + "/day). Want to look at it?",
        });
      }
    }
  }

  // 3. MILESTONES: goals crossing 25/50/75/100%.
  if (!mute.milestones) {
    for (const env of view.envelopes) {
      if (env.kind !== "goal" || !env.targetCents || env.targetCents <= 0) continue;
      const pct = Math.floor((env.fundedCents / env.targetCents) * 100);
      const lastSent = (sent.milestones && sent.milestones[env.key]) || 0;
      let crossed = 0;
      for (const t of [25, 50, 75, 100]) {
        if (pct >= t && t > lastSent) crossed = t;
      }
      if (crossed === 0) continue;
      let text;
      if (crossed === 100) {
        text = "🎉 *" + env.name + "* hit 100% — goal reached.";
      } else {
        const remaining = env.targetCents - env.fundedCents;
        text = "Nice — *" + env.name + "* at " + crossed + "%. " + (remaining > 0 ? M(remaining) + " to go." : "Almost there.");
      }
      messages.push({ type: "milestone", envKey: env.key, threshold: crossed, text });
    }
  }

  return messages;
}

// markSent(state, messages) returns updated state. Pure.
function markSent(state, messages) {
  const s = JSON.parse(JSON.stringify(state));
  if (!s.proactiveSent) s.proactiveSent = {};
  for (const msg of messages || []) {
    if (msg.type === "bill") {
      if (!s.proactiveSent.bills) s.proactiveSent.bills = {};
      s.proactiveSent.bills[msg.envKey] = msg.dueDate;
    } else if (msg.type === "pace") {
      s.proactiveSent.pace = msg.cycleStart;
    } else if (msg.type === "milestone") {
      if (!s.proactiveSent.milestones) s.proactiveSent.milestones = {};
      s.proactiveSent.milestones[msg.envKey] = msg.threshold;
    }
  }
  return s;
}

// Pick the single most-important message when several are eligible.
// Bill > Milestone > Pace. Hard cap of 1 proactive message per user per call.
function pickMostImportant(messages) {
  if (!messages || messages.length === 0) return null;
  const priority = { bill: 1, milestone: 2, pace: 3 };
  const sorted = messages.slice().sort((a, b) => (priority[a.type] || 9) - (priority[b.type] || 9));
  return sorted[0];
}

// Get user-local hour for scheduling. Returns 0-23 or null on parse error.
function localHour(tz) {
  try {
    const h = new Date().toLocaleString("en-US", { timeZone: tz || "UTC", hour: "numeric", hour12: false });
    const n = parseInt(h, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

module.exports = { decideProactive, markSent, pickMostImportant, localHour };
