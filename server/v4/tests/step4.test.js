"use strict";
// Step 4 — Hero polish tests.
// statusWord/Emoji on view; day-stable variant phrasing; /today command.

const m = require("../model");
const { applyIntent } = require("../engine");
const { compute, heroLine, HERO_VARIANTS } = require("../view");

const TODAY = "2025-04-28";

function setup(balance, payday) {
  const s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance, payday: payday || "2025-05-28", payFrequency: "monthly" },
  }).state;
}

// ── statusWord / statusEmoji on view.compute ─────────────
test("[STEP4] view emits statusWord 'Calm' for green state", () => {
  const s = setup(3_000_00);
  const v = compute(s, TODAY);
  assertEq(v.state, "green");
  assertEq(v.statusWord, "Calm");
  assertEq(v.statusEmoji, "🟢");
});

test("[STEP4] view emits statusWord 'Tight' when pace under $5/day", () => {
  const s = setup(50_00); // tiny balance, 30 days → ~$1.66/day
  const v = compute(s, TODAY);
  assertEq(v.state, "tight");
  assertEq(v.statusWord, "Tight");
  assertEq(v.statusEmoji, "🟡");
});

test("[STEP4] view emits statusWord 'Over' when disposable < 0", () => {
  let s = setup(500_00);
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1_400_00, dueDate: "2025-05-01", recurrence: "monthly" },
  }).state;
  const v = compute(s, TODAY);
  assertEq(v.state, "over");
  assertEq(v.statusWord, "Over");
  assertEq(v.statusEmoji, "🔴");
});

// ── heroLine returns variant strings ─────────────────────
test("[STEP4] heroLine on !setup returns empty", () => {
  const v = { setup: false };
  assertEq(heroLine(v, TODAY), "");
});

test("[STEP4] heroLine for green state contains pace formatting and days", () => {
  const v = compute(setup(3_000_00), TODAY);
  const line = heroLine(v, TODAY);
  assertTrue(line.length > 0);
  assertTrue(line.includes("🟢"), "expected green emoji");
  assertTrue(line.includes(v.dailyPaceFormatted) || line.includes(String(v.daysToPayday)),
    "should include pace or days");
});

test("[STEP4] heroLine for over state mentions deficit", () => {
  let s = setup(500_00);
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1_400_00, dueDate: "2025-05-01", recurrence: "monthly" },
  }).state;
  const v = compute(s, TODAY);
  const line = heroLine(v, TODAY);
  assertTrue(line.includes("🔴"));
  assertTrue(line.includes(v.deficitFormatted), "expected deficit amount");
});

// ── DAY-STABLE: same day → same phrasing ────────────────
test("[STEP4] heroLine is day-stable: same view + same today → same string", () => {
  const v = compute(setup(3_000_00), TODAY);
  const a = heroLine(v, TODAY);
  const b = heroLine(v, TODAY);
  assertEq(a, b);
});

test("[STEP4] heroLine varies across days (at least sometimes)", () => {
  // Run heroLine for the same state across 30 different days. It should
  // produce more than one distinct string (variants rotate).
  const v = compute(setup(3_000_00), TODAY);
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const day = m.addDays("2025-01-01", i);
    seen.add(heroLine(v, day));
  }
  assertTrue(seen.size > 1, "variants should rotate across 60 days, got " + seen.size);
});

// ── HERO_VARIANTS: each variant produces non-empty output ───
test("[STEP4] every HERO_VARIANT produces a non-empty string", () => {
  const greenView = compute(setup(3_000_00), TODAY);
  for (const fn of HERO_VARIANTS.green) {
    const s = fn(greenView);
    assertTrue(typeof s === "string" && s.length > 0);
  }
  // Tight
  const tightView = compute(setup(50_00), TODAY);
  for (const fn of HERO_VARIANTS.tight) {
    const s = fn(tightView);
    assertTrue(typeof s === "string" && s.length > 0);
  }
  // Over
  let overState = setup(500_00);
  overState = applyIntent(overState, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1_400_00, dueDate: "2025-05-01", recurrence: "monthly" },
  }).state;
  const overView = compute(overState, TODAY);
  for (const fn of HERO_VARIANTS.over) {
    const s = fn(overView);
    assertTrue(typeof s === "string" && s.length > 0);
  }
});

test("[STEP4] HERO_VARIANTS counts: green=5, tight=3, over=3", () => {
  assertEq(HERO_VARIANTS.green.length, 5);
  assertEq(HERO_VARIANTS.tight.length, 3);
  assertEq(HERO_VARIANTS.over.length, 3);
});
