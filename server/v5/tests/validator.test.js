"use strict";
const m = require("../model");
const { applyIntent } = require("../engine");
const { validateIntent } = require("../validator");

const TODAY = "2025-04-28";

function setup(balance) {
  let s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance || 500000, payday: "2025-05-15", payFrequency: "monthly" },
  }).state;
}

test("[validator] setup_account on already-setup REJECTED", () => {
  const v = validateIntent(setup(), { kind: "setup_account", params: { balanceCents: 100 } }, TODAY);
  assertEq(v.ok, false);
  assertTrue(/already set up/i.test(v.reason));
});
test("[validator] setup_account negative balance REJECTED", () => {
  const v = validateIntent(m.createFreshState(), { kind: "setup_account", params: { balanceCents: -100 } }, TODAY);
  assertEq(v.ok, false);
});
test("[validator] add_bill past dueDate REJECTED", () => {
  const v = validateIntent(setup(), {
    kind: "add_bill",
    params: { name: "Rent", amountCents: 1000, dueDate: "2025-04-01", recurrence: "monthly" },
  }, TODAY);
  assertEq(v.ok, false);
  assertTrue(/past/i.test(v.reason));
});
test("[validator] add_bill duplicate name REJECTED", () => {
  let s = setup();
  s = applyIntent(s, { kind: "add_bill", params: { name: "Rent", amountCents: 1000, dueDate: "2025-05-01", recurrence: "monthly" } }).state;
  const v = validateIntent(s, { kind: "add_bill", params: { name: "rent", amountCents: 999, dueDate: "2025-05-01", recurrence: "monthly" } }, TODAY);
  assertEq(v.ok, false);
});
test("[validator] record_spend > 2x balance REJECTED (typo guard)", () => {
  const v = validateIntent(setup(50000), { kind: "record_spend", params: { amountCents: 200000 } }, TODAY);
  assertEq(v.ok, false);
});
test("[validator] record_spend valid PASSES", () => {
  const v = validateIntent(setup(500000), { kind: "record_spend", params: { amountCents: 2000 } }, TODAY);
  assertEq(v.ok, true);
});
test("[validator] unknown intent REJECTED", () => {
  const v = validateIntent(setup(), { kind: "transfer_to_attacker", params: {} }, TODAY);
  assertEq(v.ok, false);
});
test("[validator] add_bill before setup REJECTED", () => {
  const v = validateIntent(m.createFreshState(), { kind: "add_bill", params: { name: "X", amountCents: 1000, dueDate: "2025-05-01", recurrence: "monthly" } }, TODAY);
  assertEq(v.ok, false);
  assertTrue(/set up first/i.test(v.reason));
});

// ── BACKDATING (record_spend / record_income with date param) ─
test("[validator] record_spend with valid backdate PASSES", () => {
  const s = setup(500000);
  // Setup tx is on TODAY by default; widen the window.
  s.transactions[0].date = "2025-04-20";
  const v = validateIntent(s, { kind: "record_spend", params: { amountCents: 1000, date: "2025-04-25" } }, TODAY);
  assertEq(v.ok, true);
});
test("[validator] record_spend with future date REJECTED", () => {
  const v = validateIntent(setup(500000), { kind: "record_spend", params: { amountCents: 1000, date: "2025-04-29" } }, TODAY);
  assertEq(v.ok, false);
  assertTrue(/future/i.test(v.reason));
});
test("[validator] record_spend with date before setup REJECTED", () => {
  const v = validateIntent(setup(500000), { kind: "record_spend", params: { amountCents: 1000, date: "2024-12-31" } }, TODAY);
  assertEq(v.ok, false);
  assertTrue(/before account setup/i.test(v.reason));
});
test("[validator] record_spend with malformed date REJECTED", () => {
  const v = validateIntent(setup(500000), { kind: "record_spend", params: { amountCents: 1000, date: "yesterday" } }, TODAY);
  assertEq(v.ok, false);
  assertTrue(/format/i.test(v.reason));
});
test("[validator] record_income with valid backdate PASSES", () => {
  const s = setup(500000);
  s.transactions[0].date = "2025-04-20";
  const v = validateIntent(s, { kind: "record_income", params: { amountCents: 50000, date: "2025-04-26" } }, TODAY);
  assertEq(v.ok, true);
});
