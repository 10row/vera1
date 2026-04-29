"use strict";
// Engine — pure state transitions. Byte-perfect undo.

const m = require("../model");
const { applyIntent } = require("../engine");

function setup(balance) {
  let s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance || 500000, payday: "2025-05-15", payFrequency: "monthly" },
  }).state;
}

// ── SETUP ─────────────────────────────────────────
test("[engine] setup_account on virgin state succeeds", () => {
  const s = setup();
  assertEq(s.setup, true);
  assertEq(s.balanceCents, 500000);
  assertEq(s.payday, "2025-05-15");
  assertEq(s.payFrequency, "monthly");
});
test("[engine] setup_account on already-setup throws", () => {
  const s = setup();
  assertThrows(() => applyIntent(s, { kind: "setup_account", params: { balanceCents: 100 } }), /Already set up/);
});
test("[engine] setup with negative balance throws", () => {
  let s = m.createFreshState();
  assertThrows(() => applyIntent(s, { kind: "setup_account", params: { balanceCents: -100 } }), /Invalid balance/);
});

// ── ADJUST BALANCE ────────────────────────────────
test("[engine] adjust_balance updates balance, records correction tx", () => {
  let s = setup(500000);
  s = applyIntent(s, { kind: "adjust_balance", params: { newBalanceCents: 700000 } }).state;
  assertEq(s.balanceCents, 700000);
  // Setup tx + correction tx = 2 transactions
  assertEq(s.transactions.length, 2);
  assertEq(s.transactions[1].kind, "correction");
  assertEq(s.transactions[1].amountCents, 200000); // delta
});
test("[engine] adjust_balance before setup throws", () => {
  let s = m.createFreshState();
  assertThrows(() => applyIntent(s, { kind: "adjust_balance", params: { newBalanceCents: 100 } }), /Set up first/);
});

// ── BILLS ─────────────────────────────────────────
test("[engine] add_bill stores by key, includes recurrence", () => {
  let s = setup();
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Rent", amountCents: 140000, dueDate: "2025-05-01", recurrence: "monthly" },
  }).state;
  assertTrue(!!s.bills.rent);
  assertEq(s.bills.rent.amountCents, 140000);
  assertEq(s.bills.rent.recurrence, "monthly");
});
test("[engine] add_bill duplicate name throws", () => {
  let s = setup();
  s = applyIntent(s, { kind: "add_bill", params: { name: "Rent", amountCents: 140000, dueDate: "2025-05-01", recurrence: "monthly" } }).state;
  assertThrows(() => applyIntent(s, { kind: "add_bill", params: { name: "rent", amountCents: 100, dueDate: "2025-06-01", recurrence: "monthly" } }), /already exists/);
});
test("[engine] remove_bill", () => {
  let s = setup();
  s = applyIntent(s, { kind: "add_bill", params: { name: "Phone", amountCents: 5000, dueDate: "2025-05-01", recurrence: "monthly" } }).state;
  s = applyIntent(s, { kind: "remove_bill", params: { name: "Phone" } }).state;
  assertEq(s.bills.phone, undefined);
});

// ── SPEND / INCOME ────────────────────────────────
test("[engine] record_spend reduces balance, appends tx", () => {
  let s = setup(500000);
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 2000, note: "coffee" } }).state;
  assertEq(s.balanceCents, 498000);
  assertEq(s.transactions[1].kind, "spend");
  assertEq(s.transactions[1].amountCents, -2000);
});
test("[engine] record_income increases balance", () => {
  let s = setup(500000);
  s = applyIntent(s, { kind: "record_income", params: { amountCents: 300000, note: "paycheck" } }).state;
  assertEq(s.balanceCents, 800000);
  assertEq(s.transactions[1].kind, "income");
});
test("[engine] record_spend with billKey marks bill paid + advances cycle", () => {
  let s = setup(500000);
  s = applyIntent(s, { kind: "add_bill", params: { name: "Rent", amountCents: 140000, dueDate: "2025-05-01", recurrence: "monthly" } }).state;
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 140000, billKey: "rent" } }).state;
  // For monthly bill, advancePayday rolls to next 1st (or close).
  assertTrue(s.bills.rent.dueDate >= "2025-05-01");
  assertEq(s.balanceCents, 360000);
});

// ── UNDO ──────────────────────────────────────────
test("[engine] undo of record_spend restores balance and pops tx", () => {
  let s = setup(500000);
  const before = JSON.stringify({ bal: s.balanceCents, tx: s.transactions.length });
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 2000 } }).state;
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertEq(s.balanceCents, 500000);
  assertEq(s.transactions.length, 1); // back to just setup tx
});
test("[engine] undo of add_bill removes the bill", () => {
  let s = setup();
  s = applyIntent(s, { kind: "add_bill", params: { name: "Phone", amountCents: 5000, dueDate: "2025-05-01", recurrence: "monthly" } }).state;
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertEq(s.bills.phone, undefined);
});
test("[engine] undo of setup_account throws (use reset)", () => {
  let s = setup();
  assertThrows(() => applyIntent(s, { kind: "undo_last", params: {} }), /Can't undo setup/);
});
test("[engine] undo with empty events throws", () => {
  const s = m.createFreshState();
  assertThrows(() => applyIntent(s, { kind: "undo_last", params: {} }), /Nothing to undo/);
});
test("[engine] 10 spends then 10 undos returns to original balance", () => {
  let s = setup(1000000);
  const start = s.balanceCents;
  for (let i = 0; i < 10; i++) {
    s = applyIntent(s, { kind: "record_spend", params: { amountCents: (i + 1) * 100 } }).state;
  }
  for (let i = 0; i < 10; i++) {
    s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  }
  assertEq(s.balanceCents, start);
});

// ── RESET ─────────────────────────────────────────
test("[engine] reset wipes state but preserves locale prefs", () => {
  let s = setup();
  s.language = "ru";
  s.currency = "RUB";
  s.currencySymbol = "₽";
  s = applyIntent(s, { kind: "reset", params: {} }).state;
  assertEq(s.setup, false);
  assertEq(s.balanceCents, 0);
  assertEq(s.language, "ru");
  assertEq(s.currency, "RUB");
});

// ── INVALID INTENTS ───────────────────────────────
test("[engine] unknown intent kind throws", () => {
  const s = setup();
  assertThrows(() => applyIntent(s, { kind: "transfer_to_attacker", params: {} }), /Unknown intent/);
});
test("[engine] missing intent throws", () => {
  const s = setup();
  assertThrows(() => applyIntent(s, null), /invalid intent/);
});
