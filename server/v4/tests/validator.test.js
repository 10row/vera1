"use strict";
const m = require("../model");
const { applyIntent } = require("../engine");
const { validateIntent, validateBatch } = require("../validator");

function freshSetup() {
  const s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 5_000_00, payday: "2099-01-15", payFrequency: "monthly" },
  }).state;
}

const TODAY = "2025-04-28";

test("setup with negative balance is rejected (Vietnam scenario root cause)", () => {
  const fresh = m.createFreshState();
  const v = validateIntent(fresh, {
    kind: "setup_account",
    params: { balanceCents: -5_000_00 },
  }, TODAY);
  assertEq(v.ok, false);
  assertEq(v.severity, "reject");
});

test("setup with zero balance is rejected", () => {
  const fresh = m.createFreshState();
  const v = validateIntent(fresh, { kind: "setup_account", params: { balanceCents: 0 } }, TODAY);
  assertEq(v.ok, false);
});

test("setup with positive balance requires confirm", () => {
  const fresh = m.createFreshState();
  const v = validateIntent(fresh, {
    kind: "setup_account",
    params: { balanceCents: 5_000_00 },
  }, TODAY);
  assertEq(v.ok, true);
  assertEq(v.severity, "confirm");
});

test("setup with payday in past asks to confirm", () => {
  const fresh = m.createFreshState();
  const v = validateIntent(fresh, {
    kind: "setup_account",
    params: { balanceCents: 5_000_00, payday: "2024-01-01" },
  }, TODAY);
  assertEq(v.ok, true);
  assertEq(v.severity, "confirm");
  assertTrue(/past/i.test(v.reason));
});

test("small spend auto-applies", () => {
  const s = freshSetup();
  const v = validateIntent(s, { kind: "record_spend", params: { amountCents: 10_00 } }, TODAY);
  assertEq(v.severity, "auto");
});

test("spend over $50 needs confirm", () => {
  const s = freshSetup();
  const v = validateIntent(s, { kind: "record_spend", params: { amountCents: 75_00 } }, TODAY);
  assertEq(v.severity, "confirm");
});

test("spend over half balance needs confirm with warning", () => {
  const s = freshSetup(); // 5000
  const v = validateIntent(s, { kind: "record_spend", params: { amountCents: 3_000_00 } }, TODAY);
  assertEq(v.severity, "confirm");
  assertTrue(/half/i.test(v.reason));
});

test("spend > balance needs confirm with explicit warning", () => {
  const s = freshSetup(); // 5000
  const v = validateIntent(s, { kind: "record_spend", params: { amountCents: 6_000_00 } }, TODAY);
  assertEq(v.severity, "confirm");
  assertTrue(/balance/i.test(v.reason));
});

test("envelope with past due date (>14 days) is rejected", () => {
  const s = freshSetup();
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Old Bill", kind: "bill", amountCents: 100_00, dueDate: "2020-01-01" },
  }, TODAY);
  assertEq(v.ok, false);
  assertTrue(/past/i.test(v.reason));
});

test("envelope with future due date >2y is rejected", () => {
  const s = freshSetup();
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Far Bill", kind: "bill", amountCents: 100_00, dueDate: "2030-01-01" },
  }, TODAY);
  assertEq(v.ok, false);
});

test("envelope with amount 10x balance asks to confirm", () => {
  const s = freshSetup(); // 5000
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Mansion", kind: "bill", amountCents: 100_000_00, dueDate: "2099-08-01" },
  }, TODAY);
  assertEq(v.ok, true);
  assertEq(v.severity, "confirm");
  assertTrue(/much more/i.test(v.reason));
});

test("envelope with valid future date and reasonable amount: confirm", () => {
  const s = freshSetup();
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Vietnam Trip", kind: "bill", amountCents: 1_500_00, dueDate: "2026-08-15", recurrence: "once" },
  }, TODAY);
  assertEq(v.ok, true);
  assertEq(v.severity, "confirm");
});

test("duplicate envelope name is rejected", () => {
  let s = freshSetup();
  s = applyIntent(s, { kind: "add_envelope", params: { name: "Rent", kind: "bill", amountCents: 1000_00 } }).state;
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 2000_00 },
  }, TODAY);
  assertEq(v.ok, false);
  assertTrue(/already in use/i.test(v.reason));
});

test("batch with >3 intents rejected", () => {
  const s = freshSetup();
  const v = validateBatch(s, [
    { kind: "record_spend", params: { amountCents: 10_00 } },
    { kind: "record_spend", params: { amountCents: 10_00 } },
    { kind: "record_spend", params: { amountCents: 10_00 } },
    { kind: "record_spend", params: { amountCents: 10_00 } },
  ], TODAY);
  assertEq(v.length, 1);
  assertEq(v[0].ok, false);
  assertTrue(/one at a time/i.test(v[0].reason));
});

test("unknown intent kind rejected", () => {
  const s = freshSetup();
  const v = validateIntent(s, { kind: "wat", params: {} }, TODAY);
  assertEq(v.ok, false);
});

test("malformed intent rejected", () => {
  const s = freshSetup();
  assertEq(validateIntent(s, null, TODAY).ok, false);
  assertEq(validateIntent(s, {}, TODAY).ok, false);
});
