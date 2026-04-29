"use strict";
const m = require("../model");
const { applyIntent } = require("../engine");
const { compute, heroLine, simulateSpend } = require("../view");

function setup(balance) {
  let s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance || 500000, payday: m.addDays(m.today("UTC"), 30), payFrequency: "monthly" },
  }).state;
}

test("[view] !setup returns { setup: false }", () => {
  const v = compute(m.createFreshState());
  assertEq(v.setup, false);
});
test("[view] basic setup gives positive dailyPace", () => {
  const v = compute(setup(500000));
  assertEq(v.setup, true);
  assertTrue(v.dailyPaceCents > 0);
});
test("[view] dailyPace never negative even with massive obligations", () => {
  let s = setup(50000); // $500
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Big", amountCents: 500000, dueDate: m.addDays(m.today("UTC"), 5), recurrence: "monthly" },
  }).state;
  const v = compute(s);
  assertEq(v.dailyPaceCents, 0); // floored at 0
  assertEq(v.status, "over");
  assertTrue(v.deficitCents > 0);
});
test("[view] heroLine includes pace + days", () => {
  const s = setup(500000);
  const line = heroLine(s, "en");
  assertTrue(line.length > 0);
  assertTrue(/day/.test(line));
});
test("[view] simulateSpend reduces projected balance", () => {
  const s = setup(500000);
  const sim = simulateSpend(s, 10000);
  assertEq(sim.projected.balanceCents, 490000);
});
test("[view] simulateSpend doesn't mutate source state", () => {
  const s = setup(500000);
  const before = JSON.stringify(s);
  simulateSpend(s, 10000);
  assertEq(JSON.stringify(s), before);
});
