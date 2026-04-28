"use strict";
const m = require("../model");
const { applyIntent } = require("../engine");
const { compute } = require("../view");

const TODAY = "2025-04-28";

function setup(balance, payday) {
  const s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance, payday: payday || "2025-05-28", payFrequency: "monthly" },
  }).state;
}

test("view: green state with no bills", () => {
  const s = setup(3_000_00, "2025-05-28");
  const v = compute(s, TODAY);
  assertEq(v.setup, true);
  assertEq(v.state, "green");
  assertEq(v.obligatedCents, 0);
  assertEq(v.disposableCents, 3_000_00);
  assertEq(v.deficitCents, 0);
  assertEq(v.daysToPayday, 30);
  assertEq(v.dailyPaceCents, 100_00); // 3000 / 30 = 100
});

test("view: bill due before payday counts toward obligated", () => {
  let s = setup(2_000_00, "2025-05-28");
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1_400_00, dueDate: "2025-05-01" },
  }).state;
  const v = compute(s, TODAY);
  assertEq(v.obligatedCents, 1_400_00);
  assertEq(v.disposableCents, 600_00);
});

test("view: bill due AFTER payday does not count toward this cycle", () => {
  let s = setup(2_000_00, "2025-05-28");
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Far Bill", kind: "bill", amountCents: 1_400_00, dueDate: "2025-07-01" },
  }).state;
  const v = compute(s, TODAY);
  assertEq(v.obligatedCents, 0);
  assertEq(v.disposableCents, 2_000_00);
});

test("view: deficit shows when obligations exceed balance, dailyPace is ZERO not negative", () => {
  let s = setup(500_00, "2025-05-28");
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1_400_00, dueDate: "2025-05-01" },
  }).state;
  const v = compute(s, TODAY);
  assertEq(v.state, "over");
  assertEq(v.disposableCents, -900_00);
  assertEq(v.deficitCents, 900_00);
  assertEq(v.dailyPaceCents, 0); // CRITICAL: never negative as a number
});

test("view: tight state when pace under $5/day", () => {
  const s = setup(50_00, "2025-05-28");
  const v = compute(s, TODAY);
  assertEq(v.state, "tight");
  assertTrue(v.dailyPaceCents < 5_00);
  assertTrue(v.dailyPaceCents > 0);
});

test("view: budget envelope reserves remaining amount", () => {
  let s = setup(2_000_00, "2025-05-28");
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Coffee", kind: "budget", amountCents: 100_00 },
  }).state;
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 30_00, envelopeKey: "coffee" },
  }).state;
  const v = compute(s, TODAY);
  // 100 reserved minus 30 spent = 70 still reserved
  assertEq(v.obligatedCents, 70_00);
  assertEq(v.disposableCents, 2_000_00 - 30_00 - 70_00);
});

test("view: invariant balance == obligated + disposable holds always", () => {
  let s = setup(1_000_00, "2025-05-28");
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 600_00, dueDate: "2025-05-10" },
  }).state;
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 25_00 },
  }).state;
  const v = compute(s, TODAY);
  assertTrue(v.invariantOk, "invariant must hold");
  assertEq(v.obligatedCents + v.disposableCents, v.balanceCents);
});

test("view: due bill appears in dueNow", () => {
  let s = setup(2_000_00, "2025-05-28");
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Phone", kind: "bill", amountCents: 60_00, dueDate: "2025-04-15" },
  }).state;
  const v = compute(s, TODAY);
  assertEq(v.dueNow.length, 1);
  assertEq(v.dueNow[0].name, "Phone");
});

test("view: today spending tracked", () => {
  let s = setup(1_000_00, "2025-05-28");
  // Force today by setting timezone-friendly setup; we just inject txs at TODAY date.
  s.transactions.push({ id: "x1", ts: Date.now(), kind: "spend", amountCents: 25_00, note: "", envelopeKey: null, date: TODAY });
  s.balanceCents -= 25_00;
  const v = compute(s, TODAY);
  assertEq(v.todaySpentCents, 25_00);
});

test("view: paydayOverdue flag", () => {
  const s = setup(1_000_00, "2025-04-01"); // payday in past
  const v = compute(s, TODAY);
  assertEq(v.paydayOverdue, true);
});
