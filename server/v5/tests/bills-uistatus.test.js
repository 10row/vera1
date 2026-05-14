"use strict";
// ─────────────────────────────────────────────────────────────────────
// CANONICAL BILL UI STATUS
//
// computeBillUiStatus(b, daysUntilDue, cycleStatus) is the SINGLE
// source of truth for "what should the UI show for this bill?".
// Every mini app consumer reads ONLY this field. No consumer is
// permitted to recompute urgency from raw daysUntilDue + paidThisCycle.
//
// This suite locks the canonical table so future changes can't silently
// revert to the "three forgetful readers" bug.
// ─────────────────────────────────────────────────────────────────────
const m = require("../model");
const { applyIntent } = require("../engine");
const { computeBillUiStatus } = require("../view");

// Inline mini-version of v5ToV4View's bill-envelope mapping. Mirrors
// server/v5/index.js so we can test the integration without booting
// express (which transitively loads broken raw-body / iconv-lite in
// this environment). Keep in sync with v5ToV4View.
function billEnvelope(state, billKey) {
  const b = state.bills[billKey];
  if (!b) return null;
  const todayStr = m.today(state.timezone || "UTC");
  const daysUntilDue = m.daysBetween(todayStr, b.dueDate);
  const beforePayday = state.payday ? m.daysBetween(b.dueDate, state.payday) >= 0 : true;
  const cycleStatus = (b.paidThisCycle || beforePayday) ? "this" : "next";
  return {
    key: billKey,
    name: b.name,
    paidThisCycle: !!b.paidThisCycle,
    daysUntilDue,
    cycleStatus,
    uiStatus: computeBillUiStatus(b, daysUntilDue, cycleStatus),
  };
}

// ── PAID: paidThisCycle === true wins over EVERYTHING ──
test("[uiStatus] paid bill with stale past dueDate → 'paid' (NOT 'overdue')", () => {
  assertEq(computeBillUiStatus({ paidThisCycle: true }, -5, "this"), "paid");
});
test("[uiStatus] paid bill due today → 'paid'", () => {
  assertEq(computeBillUiStatus({ paidThisCycle: true }, 0, "this"), "paid");
});
test("[uiStatus] paid bill due tomorrow → 'paid'", () => {
  assertEq(computeBillUiStatus({ paidThisCycle: true }, 1, "this"), "paid");
});
test("[uiStatus] paid bill 30 days out → 'paid'", () => {
  assertEq(computeBillUiStatus({ paidThisCycle: true }, 30, "this"), "paid");
});
test("[uiStatus] paid bill marked 'next cycle' → 'paid' (paid still wins)", () => {
  assertEq(computeBillUiStatus({ paidThisCycle: true }, 35, "next"), "paid");
});

// ── NEXT CYCLE: dueDate after payday, not yet paid ──
test("[uiStatus] unpaid bill in next cycle → 'next_cycle' regardless of daysUntilDue", () => {
  assertEq(computeBillUiStatus({ paidThisCycle: false }, 35, "next"), "next_cycle");
  assertEq(computeBillUiStatus({ paidThisCycle: false }, 14, "next"), "next_cycle");
});

// ── OVERDUE: past due AND unpaid ──
test("[uiStatus] daysUntilDue === -1 + unpaid → 'overdue'", () => {
  assertEq(computeBillUiStatus({ paidThisCycle: false }, -1, "this"), "overdue");
});
test("[uiStatus] daysUntilDue === -30 + unpaid → 'overdue'", () => {
  assertEq(computeBillUiStatus({ paidThisCycle: false }, -30, "this"), "overdue");
});

// ── DUE TODAY ──
test("[uiStatus] daysUntilDue === 0 + unpaid → 'due_today'", () => {
  assertEq(computeBillUiStatus({ paidThisCycle: false }, 0, "this"), "due_today");
});

// ── DUE TOMORROW ──
test("[uiStatus] daysUntilDue === 1 + unpaid → 'due_tomorrow'", () => {
  assertEq(computeBillUiStatus({ paidThisCycle: false }, 1, "this"), "due_tomorrow");
});

// ── DUE SOON (2-7 days) ──
test("[uiStatus] daysUntilDue === 2 + unpaid → 'due_soon'", () => {
  assertEq(computeBillUiStatus({ paidThisCycle: false }, 2, "this"), "due_soon");
});
test("[uiStatus] daysUntilDue === 7 + unpaid → 'due_soon'", () => {
  assertEq(computeBillUiStatus({ paidThisCycle: false }, 7, "this"), "due_soon");
});

// ── UPCOMING (8+ days, this cycle) ──
test("[uiStatus] daysUntilDue === 8 + unpaid + this cycle → 'upcoming'", () => {
  assertEq(computeBillUiStatus({ paidThisCycle: false }, 8, "this"), "upcoming");
});
test("[uiStatus] daysUntilDue === 14 + unpaid + this cycle → 'upcoming'", () => {
  assertEq(computeBillUiStatus({ paidThisCycle: false }, 14, "this"), "upcoming");
});

// ── DEFENSIVE: daysUntilDue null → 'upcoming' (not crash) ──
test("[uiStatus] daysUntilDue null → 'upcoming' (defensive)", () => {
  assertEq(computeBillUiStatus({ paidThisCycle: false }, null, "this"), "upcoming");
});

// ── INTEGRATION: one-time bill marked paid → uiStatus === 'paid' ──
// THE bug scenario from the user. Paid bill must NOT show as overdue/due.
test("[uiStatus] integration: one-time bill marked paid → envelope.uiStatus === 'paid'", () => {
  let s = m.createFreshState();
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(m.today("UTC"), 15), payFrequency: "monthly" },
  }).state;
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Dry cleaning", amountCents: 8500, dueDate: m.today("UTC"), recurrence: "once" },
  }).state;
  const billKey = m.billKey("Dry cleaning");
  // Mark paid — bill_payment via record_spend with billKey.
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 8500, billKey, note: "Dry cleaning" },
  }).state;
  const env = billEnvelope(s, billKey);
  assertEq(env.paidThisCycle, true);
  assertEq(env.uiStatus, "paid", "paid bill must NOT render as overdue/due");
});

// ── INTEGRATION: undo restores correct status ──
test("[uiStatus] integration: undo bill_payment restores 'due_today' (not stuck on 'paid')", () => {
  let s = m.createFreshState();
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(m.today("UTC"), 15), payFrequency: "monthly" },
  }).state;
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Rent", amountCents: 140000, dueDate: m.today("UTC"), recurrence: "once" },
  }).state;
  const billKey = m.billKey("Rent");
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 140000, billKey, note: "Rent" },
  }).state;
  // Pre-undo: paid.
  assertEq(billEnvelope(s, billKey).uiStatus, "paid");
  // Undo via undo_last (most-recent event reversal).
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  const env = billEnvelope(s, billKey);
  assertEq(env.paidThisCycle, false, "undo must restore unpaid");
  assertEq(env.uiStatus, "due_today", "undo must restore correct urgency");
});

// ── INTEGRATION: recurring bill payment advances dueDate ──
test("[uiStatus] recurring bill paid → next dueDate, status reflects new position", () => {
  let s = m.createFreshState();
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(m.today("UTC"), 25), payFrequency: "monthly" },
  }).state;
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Phone", amountCents: 5000, dueDate: m.today("UTC"), recurrence: "monthly" },
  }).state;
  const billKey = m.billKey("Phone");
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 5000, billKey, note: "Phone" },
  }).state;
  // After payment: dueDate advanced ~30d, paidThisCycle reset to false.
  // The next dueDate (~30d) is past payday (~25d) → "next_cycle".
  const env = billEnvelope(s, billKey);
  assertEq(env.paidThisCycle, false);
  assertTrue(env.uiStatus === "next_cycle" || env.uiStatus === "upcoming",
    "expected next_cycle or upcoming, got " + env.uiStatus);
});
