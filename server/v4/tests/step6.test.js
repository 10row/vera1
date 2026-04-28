"use strict";
// Step 6 — Proactive moments tests.
// Three calibrated message types, with mute and rate-limit semantics.

const m = require("../model");
const { applyIntent } = require("../engine");
const { decideProactive, markSent, pickMostImportant } = require("../proactive");

function setup(balance, payday) {
  const s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance || 5_000_00, payday: payday || "2025-05-28", payFrequency: "monthly" },
  }).state;
}

const TODAY = "2025-04-28";

// ── PURITY ──────────────────────────────────────────────
test("[STEP6] decideProactive on !setup returns []", () => {
  const s = m.createFreshState();
  assertEq(decideProactive(s, TODAY), []);
});

test("[STEP6] decideProactive does NOT mutate input state", () => {
  const s = setup(2_000_00);
  const before = JSON.stringify(s);
  decideProactive(s, TODAY);
  assertEq(JSON.stringify(s), before);
});

// ── BILL ANTICIPATION ───────────────────────────────────
test("[STEP6] bill due today fires once", () => {
  let s = setup(2_000_00);
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Phone", kind: "bill", amountCents: 60_00, dueDate: TODAY, recurrence: "monthly" },
  }).state;
  const msgs = decideProactive(s, TODAY);
  const bill = msgs.find(m => m.type === "bill");
  assertTrue(!!bill);
  assertEq(bill.envKey, "phone");
  assertTrue(/today/i.test(bill.text));
});

test("[STEP6] bill due tomorrow fires", () => {
  let s = setup(2_000_00);
  const tomorrow = m.addDays(TODAY, 1);
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1400_00, dueDate: tomorrow, recurrence: "monthly" },
  }).state;
  const msgs = decideProactive(s, TODAY);
  const bill = msgs.find(m => m.type === "bill");
  assertTrue(!!bill);
  assertTrue(/tomorrow/i.test(bill.text));
});

test("[STEP6] bill due in 5 days does NOT fire", () => {
  let s = setup(2_000_00);
  const future = m.addDays(TODAY, 5);
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1400_00, dueDate: future, recurrence: "monthly" },
  }).state;
  const msgs = decideProactive(s, TODAY);
  assertEq(msgs.filter(x => x.type === "bill").length, 0);
});

test("[STEP6] bill already-paid does NOT fire", () => {
  let s = setup(2_000_00);
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Phone", kind: "bill", amountCents: 60_00, dueDate: TODAY, recurrence: "monthly" },
  }).state;
  s = applyIntent(s, { kind: "pay_bill", params: { name: "Phone" } }).state;
  // After pay, dueDate advances, spent matches amount. Should not fire.
  const msgs = decideProactive(s, TODAY);
  assertEq(msgs.filter(x => x.type === "bill").length, 0);
});

test("[STEP6] bill anticipation: same dueDate not re-fired after markSent", () => {
  let s = setup(2_000_00);
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Phone", kind: "bill", amountCents: 60_00, dueDate: TODAY, recurrence: "monthly" },
  }).state;
  const msgs = decideProactive(s, TODAY);
  s = markSent(s, msgs);
  // Now decide again — should be empty (already sent for this dueDate)
  const msgs2 = decideProactive(s, TODAY);
  assertEq(msgs2.filter(x => x.type === "bill").length, 0);
});

test("[STEP6] mute.bills suppresses bill messages", () => {
  let s = setup(2_000_00);
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Phone", kind: "bill", amountCents: 60_00, dueDate: TODAY, recurrence: "monthly" },
  }).state;
  s.mute = { bills: true };
  const msgs = decideProactive(s, TODAY);
  assertEq(msgs.filter(x => x.type === "bill").length, 0);
});

// ── MILESTONES ──────────────────────────────────────────
test("[STEP6] goal at 50% fires milestone", () => {
  let s = setup(2_000_00);
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Vietnam Trip", kind: "goal", amountCents: 0, targetCents: 1000_00 },
  }).state;
  s.envelopes.vietnam_trip.fundedCents = 500_00; // 50%
  const msgs = decideProactive(s, TODAY);
  const ms = msgs.find(x => x.type === "milestone");
  assertTrue(!!ms);
  assertEq(ms.threshold, 50);
});

test("[STEP6] goal at 100% fires milestone with 100 threshold", () => {
  let s = setup(2_000_00);
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Vacation", kind: "goal", amountCents: 0, targetCents: 1000_00 },
  }).state;
  s.envelopes.vacation.fundedCents = 1000_00;
  const msgs = decideProactive(s, TODAY);
  const ms = msgs.find(x => x.type === "milestone");
  assertEq(ms.threshold, 100);
  assertTrue(/100%/.test(ms.text));
});

test("[STEP6] goal at 24% does NOT fire (under threshold)", () => {
  let s = setup(2_000_00);
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Vacation", kind: "goal", amountCents: 0, targetCents: 1000_00 },
  }).state;
  s.envelopes.vacation.fundedCents = 240_00;
  const msgs = decideProactive(s, TODAY);
  assertEq(msgs.filter(x => x.type === "milestone").length, 0);
});

test("[STEP6] milestone fires only when crossing — not re-fired after markSent", () => {
  let s = setup(2_000_00);
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Vacation", kind: "goal", amountCents: 0, targetCents: 1000_00 },
  }).state;
  s.envelopes.vacation.fundedCents = 500_00;
  let msgs = decideProactive(s, TODAY);
  assertEq(msgs.filter(x => x.type === "milestone").length, 1);
  s = markSent(s, msgs);
  msgs = decideProactive(s, TODAY);
  assertEq(msgs.filter(x => x.type === "milestone").length, 0);
});

test("[STEP6] milestone fires NEW threshold when goal advances 50→75", () => {
  let s = setup(2_000_00);
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Vacation", kind: "goal", amountCents: 0, targetCents: 1000_00 },
  }).state;
  s.envelopes.vacation.fundedCents = 500_00;
  s = markSent(s, decideProactive(s, TODAY)); // sent 50%
  // Now advance to 75%
  s.envelopes.vacation.fundedCents = 750_00;
  const msgs = decideProactive(s, TODAY);
  const ms = msgs.find(x => x.type === "milestone");
  assertEq(ms.threshold, 75);
});

test("[STEP6] mute.milestones suppresses milestone messages", () => {
  let s = setup(2_000_00);
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Vacation", kind: "goal", amountCents: 0, targetCents: 1000_00 },
  }).state;
  s.envelopes.vacation.fundedCents = 500_00;
  s.mute = { milestones: true };
  const msgs = decideProactive(s, TODAY);
  assertEq(msgs.filter(x => x.type === "milestone").length, 0);
});

// ── PRIORITY ────────────────────────────────────────────
test("[STEP6] pickMostImportant prefers bill > milestone > pace", () => {
  const messages = [
    { type: "pace", text: "p" },
    { type: "milestone", text: "m" },
    { type: "bill", text: "b" },
  ];
  assertEq(pickMostImportant(messages).type, "bill");
});

test("[STEP6] pickMostImportant returns null on empty", () => {
  assertEq(pickMostImportant([]), null);
  assertEq(pickMostImportant(null), null);
});

// ── markSent ────────────────────────────────────────────
test("[STEP6] markSent updates bills/milestones/pace and is pure", () => {
  const s = setup(2_000_00);
  const before = JSON.stringify(s);
  const next = markSent(s, [
    { type: "bill", envKey: "rent", dueDate: "2025-05-01", text: "" },
    { type: "milestone", envKey: "vacation", threshold: 50, text: "" },
    { type: "pace", cycleStart: "2025-04-01", text: "" },
  ]);
  // Original unchanged
  assertEq(JSON.stringify(s), before);
  // Next has updates
  assertEq(next.proactiveSent.bills.rent, "2025-05-01");
  assertEq(next.proactiveSent.milestones.vacation, 50);
  assertEq(next.proactiveSent.pace, "2025-04-01");
});

// ── 30-DAY SIMULATION ───────────────────────────────────
test("[STEP6] 30-day rolling simulation: bill fires once, milestone fires per crossing", () => {
  let s = setup(3_000_00, m.addDays("2025-04-01", 30));
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1_400_00, dueDate: "2025-04-15", recurrence: "monthly" },
  }).state;
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Vacation", kind: "goal", amountCents: 0, targetCents: 1000_00 },
  }).state;

  let billFires = 0;
  let milestoneFires = 0;

  // Walk 30 days. On day 14 we're 1 day before bill (fires). On day 15 it's
  // due (already-sent for that dueDate, no re-fire).
  // On day 5 fund 25% → milestone fires. Day 10 fund 50% → fires. Day 15 75% → fires.
  for (let i = 0; i < 30; i++) {
    const day = m.addDays("2025-04-01", i);
    if (i === 5) s.envelopes.vacation.fundedCents = 250_00;
    if (i === 10) s.envelopes.vacation.fundedCents = 500_00;
    if (i === 15) s.envelopes.vacation.fundedCents = 750_00;
    const msgs = decideProactive(s, day);
    for (const msg of msgs) {
      if (msg.type === "bill") billFires++;
      if (msg.type === "milestone") milestoneFires++;
    }
    s = markSent(s, msgs);
  }
  // Bill: only fires on day 14 (tomorrow). On day 15 it's "today" but
  // already-sent for this dueDate. So 1 fire.
  assertEq(billFires, 1, "bill should fire exactly once over 30 days");
  // Milestones: 25, 50, 75 → 3 fires.
  assertEq(milestoneFires, 3, "milestones should fire 3 times (25/50/75)");
});
