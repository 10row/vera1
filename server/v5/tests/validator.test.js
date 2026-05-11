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

// ── LOCALIZATION (the Russian-user-got-English-error bug) ──
// User reported a screenshot showing 6 lines of "You already have a
// bill named X" in English to a Russian-only user. The validator was
// hardcoded EN. These tests lock the lang-aware behavior in.

test("[validator] returns RUSSIAN message when lang=ru (dup bill)", () => {
  const s = setup(500000);
  // Use m.billKey to compute the correct storage key (lowercase + slug).
  s.bills = {};
  s.bills[m.billKey("Аренда")] = { name: "Аренда", amountCents: 100000, dueDate: "2025-05-01", paidThisCycle: false, recurrence: "monthly" };
  const v = validateIntent(s,
    { kind: "add_bill", params: { name: "Аренда", amountCents: 100000, dueDate: "2025-06-01", recurrence: "monthly" } },
    TODAY, "ru"
  );
  assertEq(v.ok, false);
  assertTrue(/уже есть|Счёт/.test(v.reason), "Russian message expected, got: " + v.reason);
});

test("[validator] returns ENGLISH message when lang=en", () => {
  const s = setup(500000);
  s.bills = {};
  s.bills[m.billKey("Rent")] = { name: "Rent", amountCents: 100000, dueDate: "2025-05-01", paidThisCycle: false, recurrence: "monthly" };
  const v = validateIntent(s,
    { kind: "add_bill", params: { name: "Rent", amountCents: 100000, dueDate: "2025-06-01", recurrence: "monthly" } },
    TODAY, "en"
  );
  assertEq(v.ok, false);
  assertTrue(/already have a bill/i.test(v.reason));
});

test("[validator] lang inferred from state.language when not explicit", () => {
  const s = setup(500000);
  s.language = "ru";
  s.bills = {};
  s.bills[m.billKey("Аренда")] = { name: "Аренда", amountCents: 100000, dueDate: "2025-05-01", paidThisCycle: false, recurrence: "monthly" };
  const v = validateIntent(s,
    { kind: "add_bill", params: { name: "Аренда", amountCents: 100000, dueDate: "2025-06-01", recurrence: "monthly" } },
    TODAY
  );
  assertEq(v.ok, false);
  assertTrue(/уже есть/.test(v.reason), "should infer Russian from state.language");
});

test("[validator] every reject message has both EN and RU translations available", () => {
  const { MESSAGES } = require("../messages");
  // Loosely check that every defined message has both en + ru — guards
  // against partial translations leaking English to Russian users.
  for (const code of Object.keys(MESSAGES)) {
    assertTrue(typeof MESSAGES[code].en === "string" && MESSAGES[code].en.length > 0,
               "missing en for " + code);
    assertTrue(typeof MESSAGES[code].ru === "string" && MESSAGES[code].ru.length > 0,
               "missing ru for " + code);
  }
});

test("[engine] thrown errors carry .code for caller translation", () => {
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 500000, payday: "2025-06-01", payFrequency: "monthly" } }).state;
  // Add bill, then try to add same name again → engine should throw with .code
  s = applyIntent(s, { kind: "add_bill", params: { name: "Rent", amountCents: 100000, dueDate: "2025-06-15", recurrence: "monthly" } }).state;
  let caught = null;
  try {
    applyIntent(s, { kind: "add_bill", params: { name: "Rent", amountCents: 100000, dueDate: "2025-06-15", recurrence: "monthly" } });
  } catch (e) { caught = e; }
  assertTrue(!!caught, "engine should throw on dup bill");
  assertEq(caught.code, "engineDupBill", "thrown error should carry the code");
  assertEq(caught.params && caught.params.name, "Rent");
});

// ── update_bill — edit existing bill (move date, change amount, etc.) ─
test("[validator] update_bill on non-existent bill REJECTED", () => {
  const v = validateIntent(setup(), {
    kind: "update_bill",
    params: { name: "DoesNotExist", dueDate: "2025-12-01" },
  }, TODAY);
  assertEq(v.ok, false);
});

test("[validator] update_bill with no fields to change REJECTED", () => {
  let s = setup();
  s = applyIntent(s, { kind: "add_bill", params: { name: "Rent", amountCents: 100000, dueDate: "2025-05-01", recurrence: "monthly" } }).state;
  const v = validateIntent(s, { kind: "update_bill", params: { name: "Rent" } }, TODAY);
  assertEq(v.ok, false, "no fields to update should reject");
});

test("[validator] update_bill with valid new dueDate PASSES", () => {
  let s = setup();
  s = applyIntent(s, { kind: "add_bill", params: { name: "Rent", amountCents: 100000, dueDate: "2025-05-01", recurrence: "monthly" } }).state;
  const v = validateIntent(s, { kind: "update_bill", params: { name: "Rent", dueDate: "2025-05-15" } }, TODAY);
  assertEq(v.ok, true);
});

test("[validator] update_bill with past dueDate REJECTED", () => {
  let s = setup();
  s = applyIntent(s, { kind: "add_bill", params: { name: "Rent", amountCents: 100000, dueDate: "2025-05-01", recurrence: "monthly" } }).state;
  const v = validateIntent(s, { kind: "update_bill", params: { name: "Rent", dueDate: "2025-04-01" } }, TODAY);
  assertEq(v.ok, false);
});

test("[engine] update_bill changes the bill in place + preserves snapshot for undo", () => {
  let s = setup();
  s = applyIntent(s, { kind: "add_bill", params: { name: "Rent", amountCents: 100000, dueDate: "2025-05-01", recurrence: "monthly" } }).state;
  const oldPace = s.dailyPaceCents;
  // Update: change amount and date
  s = applyIntent(s, { kind: "update_bill", params: { name: "Rent", amountCents: 150000, dueDate: "2025-05-15" } }).state;
  const key = m.billKey("Rent");
  assertEq(s.bills[key].amountCents, 150000, "amount updated");
  assertEq(s.bills[key].dueDate, "2025-05-15", "dueDate updated");
  // Today is locked — pace must NOT change
  assertEq(s.dailyPaceCents, oldPace, "today's pace stays locked after update_bill");
  // Undo restores
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertEq(s.bills[key].amountCents, 100000, "amount restored");
  assertEq(s.bills[key].dueDate, "2025-05-01", "dueDate restored");
});
