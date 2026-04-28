"use strict";
const m = require("../model");
const { applyIntent, applyAll } = require("../engine");

function freshSetup() {
  const s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 5_000_00, payday: "2099-01-15", payFrequency: "monthly" },
  }).state;
}

test("setup_account creates a transaction and sets balance", () => {
  const s = freshSetup();
  assertEq(s.setup, true);
  assertEq(s.balanceCents, 5_000_00);
  assertEq(s.transactions.length, 1);
  assertEq(s.transactions[0].kind, "setup");
  assertTrue(s.events.length === 1);
});

test("record_spend deducts balance and increments envelope spent", () => {
  let s = freshSetup();
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Groceries", kind: "budget", amountCents: 400_00 },
  }).state;
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 25_00, envelopeKey: "groceries", note: "Lunch" },
  }).state;
  assertEq(s.balanceCents, 5_000_00 - 25_00);
  assertEq(s.envelopes.groceries.spentCents, 25_00);
  // transactions: [setup, spend]. add_envelope does not produce a transaction.
  assertEq(s.transactions[1].kind, "spend");
});

test("record_spend without envelope still deducts balance", () => {
  let s = freshSetup();
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 12_50 } }).state;
  assertEq(s.balanceCents, 5_000_00 - 12_50);
  assertEq(s.transactions[1].envelopeKey, null);
});

test("refund (negative spend) increases balance", () => {
  let s = freshSetup();
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: -10_00 } }).state;
  assertEq(s.balanceCents, 5_000_00 + 10_00);
  assertEq(s.transactions[1].kind, "refund");
});

test("record_income increases balance and resets budget envelopes", () => {
  let s = freshSetup();
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Coffee", kind: "budget", amountCents: 100_00 },
  }).state;
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 30_00, envelopeKey: "coffee" } }).state;
  assertEq(s.envelopes.coffee.spentCents, 30_00);
  s = applyIntent(s, { kind: "record_income", params: { amountCents: 3_000_00 } }).state;
  assertEq(s.balanceCents, 5_000_00 - 30_00 + 3_000_00);
  assertEq(s.envelopes.coffee.spentCents, 0); // budget reset
});

test("pay_bill deducts balance, advances dueDate", () => {
  let s = freshSetup();
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1_400_00, dueDate: "2099-02-01", recurrence: "monthly" },
  }).state;
  s = applyIntent(s, { kind: "pay_bill", params: { name: "Rent" } }).state;
  assertEq(s.balanceCents, 5_000_00 - 1_400_00);
  assertEq(s.envelopes.rent.spentCents, 1_400_00);
  assertEq(s.envelopes.rent.dueDate, "2099-03-03"); // +30d (approx monthly)
});

test("pay_bill with once recurrence deactivates the bill", () => {
  let s = freshSetup();
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Vietnam Trip", kind: "bill", amountCents: 1_500_00, dueDate: "2099-08-15", recurrence: "once" },
  }).state;
  s = applyIntent(s, { kind: "pay_bill", params: { name: "Vietnam Trip" } }).state;
  assertEq(s.envelopes.vietnam_trip.active, false);
});

test("delete_transaction reverses balance and envelope", () => {
  let s = freshSetup();
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Food", kind: "budget", amountCents: 500_00 },
  }).state;
  const after = applyIntent(s, { kind: "record_spend", params: { amountCents: 80_00, envelopeKey: "food" } });
  s = after.state;
  const txId = after.event.txId;
  s = applyIntent(s, { kind: "delete_transaction", params: { txId } }).state;
  assertEq(s.balanceCents, 5_000_00);
  assertEq(s.envelopes.food.spentCents, 0);
});

test("edit_transaction adjusts balance by delta", () => {
  let s = freshSetup();
  const after = applyIntent(s, { kind: "record_spend", params: { amountCents: 40_00 } });
  s = after.state;
  const txId = after.event.txId;
  s = applyIntent(s, { kind: "edit_transaction", params: { txId, newAmountCents: 14_00 } }).state;
  // Spent 40, then edited to 14 → balance back to 5000 − 14 = 4986
  assertEq(s.balanceCents, 5_000_00 - 14_00);
});

test("delete_transaction refuses to delete setup", () => {
  const s = freshSetup();
  const setupTxId = s.transactions[0].id;
  assertThrows(() => applyIntent(s, { kind: "delete_transaction", params: { txId: setupTxId } }),
    /cannot delete setup/);
});

test("reset wipes state but preserves event log", () => {
  let s = freshSetup();
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 10_00 } }).state;
  const eventCountBefore = s.events.length;
  s = applyIntent(s, { kind: "reset", params: {} }).state;
  assertEq(s.setup, false);
  assertEq(s.balanceCents, 0);
  assertTrue(s.events.length === eventCountBefore + 1, "events should grow by 1 on reset");
});

test("applyIntent never mutates input state", () => {
  const s1 = freshSetup();
  const snapshot = JSON.stringify(s1);
  applyIntent(s1, { kind: "record_spend", params: { amountCents: 99_00 } });
  assertEq(JSON.stringify(s1), snapshot);
});

test("malformed intent throws", () => {
  const s = freshSetup();
  assertThrows(() => applyIntent(s, null), /intent.kind required/);
  assertThrows(() => applyIntent(s, { kind: "record_spend", params: {} }), /amountCents/);
  assertThrows(() => applyIntent(s, { kind: "record_income", params: { amountCents: -100 } }), /positive/);
  assertThrows(() => applyIntent(s, { kind: "wat", params: {} }), /unknown/);
});

test("date helpers", () => {
  assertEq(m.normalizeDate("2025-01-15"), "2025-01-15");
  assertEq(m.normalizeDate("2024-02-30"), null); // invalid day
  assertEq(m.normalizeDate("not a date"), null);
  assertEq(m.daysBetween("2025-01-01", "2025-01-04"), 3);
  assertEq(m.daysBetween("2025-01-04", "2025-01-01"), -3);
  assertEq(m.addDays("2025-01-30", 5), "2025-02-04");
});

test("toCents handles common inputs", () => {
  assertEq(m.toCents(0), 0);
  assertEq(m.toCents(1.5), 150);
  assertEq(m.toCents("$1,234.56"), 123456);
  assertEq(m.toCents(null), 0);
  assertThrows(() => m.toCents(NaN), /non-finite/);
  assertThrows(() => m.toCents(Infinity), /non-finite/);
});

test("advancePayday calendar-aware monthly", () => {
  // Payday Jan 15, today Mar 1 → next is Mar 15
  assertEq(m.advancePayday("2025-01-15", "monthly", "2025-03-01"), "2025-03-15");
  // Payday already in future → unchanged
  assertEq(m.advancePayday("2099-01-15", "monthly", "2025-01-01"), "2099-01-15");
  // Weekly steps by 7
  assertEq(m.advancePayday("2025-01-01", "weekly", "2025-01-09"), "2025-01-15");
});
