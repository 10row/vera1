"use strict";
// Step 1 regression tests — Reliability Promise + Undo.
// The promise: "I'll never log without your tap. Anything I do is undoable."

const m = require("../model");
const { applyIntent, applyAll } = require("../engine");
const { validateIntent } = require("../validator");

const TODAY = "2025-04-28";

function freshSetup(balance) {
  const s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance || 5_000_00, payday: "2025-05-15", payFrequency: "monthly" },
  }).state;
}

// ── PROMISE: no auto-tier on record_spend ──────────────────────
test("[STEP1] tiny spend ($1) requires confirm — no auto-tier", () => {
  const s = freshSetup();
  const v = validateIntent(s, { kind: "record_spend", params: { amountCents: 1_00 } }, TODAY);
  assertEq(v.ok, true);
  assertEq(v.severity, "confirm");
});

test("[STEP1] mid spend ($25) requires confirm", () => {
  const s = freshSetup();
  const v = validateIntent(s, { kind: "record_spend", params: { amountCents: 25_00 } }, TODAY);
  assertEq(v.severity, "confirm");
});

test("[STEP1] $0.01 spend still requires confirm", () => {
  const s = freshSetup();
  const v = validateIntent(s, { kind: "record_spend", params: { amountCents: 1 } }, TODAY);
  assertEq(v.severity, "confirm");
});

// ── UNDO: byte-perfect reversal ────────────────────────────────
test("[STEP1] undo_last after a single spend restores exact pre-spend state", () => {
  let s = freshSetup();
  const before = JSON.parse(JSON.stringify(s));
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 50_00, note: "lunch" } }).state;
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  // Compare excluding the events log shape — events should match remaining
  // (i.e. before's events, since the spend's event was dropped).
  assertEq(s.balanceCents, before.balanceCents);
  assertEq(s.transactions.length, before.transactions.length);
  assertEq(JSON.stringify(s.envelopes), JSON.stringify(before.envelopes));
  assertEq(s.events.length, before.events.length);
});

test("[STEP1] undo_last after multiple spends only undoes the last", () => {
  let s = freshSetup();
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 10_00 } }).state;
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 20_00 } }).state;
  const balanceAfterFirst = s.transactions[1].amountCents; // 10_00
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  // Only 20_00 spend was undone; 10_00 spend remains
  assertEq(s.balanceCents, 5_000_00 - 10_00);
  assertEq(s.transactions.length, 2); // setup + 10_00 spend
  assertEq(s.transactions[1].amountCents, 10_00);
});

test("[STEP1] undo cannot remove setup transaction", () => {
  const s = freshSetup();
  // Only setup event in log → undo refuses
  assertThrows(() => applyIntent(s, { kind: "undo_last", params: {} }), /nothing to undo/i);
});

test("[STEP1] undo with empty events refuses", () => {
  const s = m.createFreshState();
  assertThrows(() => applyIntent(s, { kind: "undo_last", params: {} }), /nothing to undo/i);
});

test("[STEP1] undo carries the 'undid' descriptor for UI", () => {
  let s = freshSetup();
  const r1 = applyIntent(s, { kind: "record_spend", params: { amountCents: 30_00, note: "tacos" } });
  s = r1.state;
  const r2 = applyIntent(s, { kind: "undo_last", params: {} });
  assertTrue(!!r2.event.undid, "event must carry undid descriptor");
  assertEq(r2.event.undid.intent.kind, "record_spend");
  assertEq(r2.event.undid.intent.params.amountCents, 30_00);
});

test("[STEP1] consecutive undos walk back through events", () => {
  let s = freshSetup();
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 10_00 } }).state;
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 20_00 } }).state;
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 30_00 } }).state;
  // Three spends applied. Undo three times.
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertEq(s.balanceCents, 5_000_00 - 10_00 - 20_00);
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertEq(s.balanceCents, 5_000_00 - 10_00);
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertEq(s.balanceCents, 5_000_00);
  // Fourth undo would only have setup left → refuse
  assertThrows(() => applyIntent(s, { kind: "undo_last", params: {} }), /nothing to undo/i);
});

test("[STEP1] undo of envelope-bound spend reverses envelope spentCents too", () => {
  let s = freshSetup();
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Coffee", kind: "budget", amountCents: 100_00 },
  }).state;
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 25_00, envelopeKey: "coffee" },
  }).state;
  assertEq(s.envelopes.coffee.spentCents, 25_00);
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertEq(s.envelopes.coffee.spentCents, 0);
});

test("[STEP1] undo of pay_bill restores bill state (spent reset, dueDate restored)", () => {
  let s = freshSetup();
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1_400_00, dueDate: "2099-02-01", recurrence: "monthly" },
  }).state;
  s = applyIntent(s, { kind: "pay_bill", params: { name: "Rent" } }).state;
  const dueAfterPay = s.envelopes.rent.dueDate;
  const balanceAfterPay = s.balanceCents;
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertEq(s.envelopes.rent.dueDate, "2099-02-01"); // restored
  assertEq(s.envelopes.rent.spentCents, 0);          // restored
  assertEq(s.balanceCents, 5_000_00);                // restored
});

// ── VALIDATOR: undo_last verdicts ──────────────────────────────
test("[STEP1] validator: undo_last with no setup → reject", () => {
  const s = m.createFreshState();
  const v = validateIntent(s, { kind: "undo_last", params: {} }, TODAY);
  assertEq(v.ok, false);
});

test("[STEP1] validator: undo_last with only setup event → reject", () => {
  const s = freshSetup();
  const v = validateIntent(s, { kind: "undo_last", params: {} }, TODAY);
  assertEq(v.ok, false);
  assertTrue(/nothing to undo/i.test(v.reason));
});

test("[STEP1] validator: undo_last after a spend → auto severity", () => {
  let s = freshSetup();
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 10_00 } }).state;
  const v = validateIntent(s, { kind: "undo_last", params: {} }, TODAY);
  assertEq(v.ok, true);
  assertEq(v.severity, "auto");
});

// ── PROPERTY: any sequence of N spends + N undos = original state ──
test("[STEP1] property: N spends + N undos = original state (10 iterations × 20 ops)", () => {
  for (let iter = 0; iter < 10; iter++) {
    let s = freshSetup(10_000_00);
    const before = JSON.parse(JSON.stringify(s));
    const N = 20;
    for (let i = 0; i < N; i++) {
      s = applyIntent(s, { kind: "record_spend", params: { amountCents: ((i + 1) * 13) % 100 + 1 } }).state;
    }
    for (let i = 0; i < N; i++) {
      s = applyIntent(s, { kind: "undo_last", params: {} }).state;
    }
    assertEq(s.balanceCents, before.balanceCents);
    assertEq(s.transactions.length, before.transactions.length);
    assertEq(JSON.stringify(s.envelopes), JSON.stringify(before.envelopes));
    assertEq(s.events.length, before.events.length);
  }
});
