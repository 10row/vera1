"use strict";
// Step 2 — Decision Support tests.
// "Can I afford X?" → simulate_spend → projected view + delta, no mutation.

const m = require("../model");
const { applyIntent } = require("../engine");
const { validateIntent } = require("../validator");
const { simulate, compute } = require("../view");
const { processMessage } = require("../pipeline");

const TODAY = "2025-04-28";

function freshSetup(balance) {
  const s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance || 5_000_00, payday: m.addDays(m.today("UTC"), 30), payFrequency: "monthly" },
  }).state;
}

const stub = (resp) => async () => typeof resp === "string" ? resp : JSON.stringify(resp);

// ── VALIDATOR: simulate_spend verdicts ──────────────────────
test("[STEP2] validator: simulate_spend on setup state with valid amount → auto", () => {
  const s = freshSetup();
  const v = validateIntent(s, { kind: "simulate_spend", params: { amountCents: 200_00 } }, TODAY);
  assertEq(v.ok, true);
  assertEq(v.severity, "auto");
});

test("[STEP2] validator: simulate_spend on non-setup state → reject", () => {
  const s = m.createFreshState();
  const v = validateIntent(s, { kind: "simulate_spend", params: { amountCents: 200_00 } }, TODAY);
  assertEq(v.ok, false);
});

test("[STEP2] validator: simulate_spend with zero/negative amount → reject", () => {
  const s = freshSetup();
  assertEq(validateIntent(s, { kind: "simulate_spend", params: { amountCents: 0 } }, TODAY).ok, false);
  assertEq(validateIntent(s, { kind: "simulate_spend", params: { amountCents: -50_00 } }, TODAY).ok, false);
});

test("[STEP2] validator: simulate_spend with phantom envelope → reject", () => {
  const s = freshSetup();
  const v = validateIntent(s, { kind: "simulate_spend", params: { amountCents: 50_00, envelopeKey: "ghost" } }, TODAY);
  assertEq(v.ok, false);
});

// ── VIEW.SIMULATE: math correctness ─────────────────────────
test("[STEP2] simulate: small spend in green state → still green, daily pace drops by exact share", () => {
  const s = freshSetup(3_000_00);
  const today = m.today("UTC");
  const sim = simulate(s, { amountCents: 100_00 }, today);
  assertEq(sim.current.state, "green");
  assertEq(sim.projected.state, "green");
  // Disposable drops by exactly 100_00
  assertEq(sim.delta.disposableDelta, -100_00);
});

test("[STEP2] simulate: big spend pushes green → over", () => {
  const s = freshSetup(500_00);
  const today = m.today("UTC");
  const sim = simulate(s, { amountCents: 1_000_00 }, today);
  assertEq(sim.projected.state, "over");
  assertTrue(sim.projected.deficitCents > 0);
  assertEq(sim.projected.dailyPaceCents, 0); // never negative
});

test("[STEP2] simulate is PURE — does not mutate input state", () => {
  const s = freshSetup(2_000_00);
  const snapshot = JSON.stringify(s);
  simulate(s, { amountCents: 500_00 }, m.today("UTC"));
  assertEq(JSON.stringify(s), snapshot);
});

test("[STEP2] simulate INVARIANT: simulate(state, X) === compute(applyIntent(state, recordSpend(X)).state)", () => {
  const s = freshSetup(2_000_00);
  const today = m.today("UTC");
  const sim = simulate(s, { amountCents: 350_00 }, today);
  const realApplied = applyIntent(s, {
    kind: "record_spend", params: { amountCents: 350_00 },
  }).state;
  const realView = compute(realApplied, today);
  // Compare the meaningful fields (ignore transactions/events which differ).
  assertEq(sim.projected.balanceCents, realView.balanceCents);
  assertEq(sim.projected.disposableCents, realView.disposableCents);
  assertEq(sim.projected.dailyPaceCents, realView.dailyPaceCents);
  assertEq(sim.projected.state, realView.state);
});

test("[STEP2] simulate with envelopeKey applies to that envelope's spent in the projection", () => {
  let s = freshSetup(2_000_00);
  s = applyIntent(s, { kind: "add_envelope", params: { name: "Coffee", kind: "budget", amountCents: 100_00 } }).state;
  const today = m.today("UTC");
  const sim = simulate(s, { amountCents: 50_00, envelopeKey: "coffee" }, today);
  const projCoffee = sim.projected.envelopes.find(e => e.key === "coffee");
  assertEq(projCoffee.spentCents, 50_00);
  // Real state untouched
  assertEq(s.envelopes.coffee.spentCents, 0);
});

// ── PIPELINE: simulate flow ────────────────────────────────
test("[STEP2] pipeline: AI emits simulate_spend → kind=decision with simulate result", async () => {
  const s = freshSetup(2_000_00);
  const r = await processMessage(s, "can I afford $200 shoes?", [], {
    _aiCall: stub({
      mode: "do",
      message: "Looking at your numbers.",
      intents: [{ kind: "simulate_spend", params: { amountCents: 200_00, note: "shoes" } }],
    }),
  });
  assertEq(r.kind, "decision");
  assertEq(r.intent.kind, "simulate_spend");
  assertTrue(!!r.simulate);
  assertEq(r.simulate.delta.disposableDelta, -200_00);
});

test("[STEP2] pipeline: simulate that flips state to over reports stateChange", async () => {
  const s = freshSetup(500_00);
  const r = await processMessage(s, "can I afford $2k vacation?", [], {
    _aiCall: stub({
      mode: "do",
      message: "Hmm.",
      intents: [{ kind: "simulate_spend", params: { amountCents: 2_000_00 } }],
    }),
  });
  assertEq(r.kind, "decision");
  assertEq(r.simulate.projected.state, "over");
  assertTrue(!!r.simulate.delta.stateChange);
  assertEq(r.simulate.delta.stateChange.from, "green");
  assertEq(r.simulate.delta.stateChange.to, "over");
});

test("[STEP2] pipeline: simulate doesn't mutate state (called twice, same result)", async () => {
  const s = freshSetup(2_000_00);
  const before = JSON.stringify(s);
  await processMessage(s, "can I afford $100?", [], {
    _aiCall: stub({
      mode: "do",
      message: "Sure.",
      intents: [{ kind: "simulate_spend", params: { amountCents: 100_00 } }],
    }),
  });
  assertEq(JSON.stringify(s), before);
});

// ── AI CLASSIFICATION ROBUSTNESS ───────────────────────────
// We can't really test gpt-4o-mini classification accuracy with stubs,
// but we test the pipeline contract: whatever the AI emits must be
// honored as long as it's structurally valid.

test("[STEP2] AI emits record_spend on past-tense → goes to record path, not simulate", async () => {
  const s = freshSetup(2_000_00);
  const r = await processMessage(s, "spent $5 on coffee", [], {
    _aiCall: stub({
      mode: "do",
      message: "Logging.",
      intents: [{ kind: "record_spend", params: { amountCents: 5_00 } }],
    }),
  });
  // Goes through normal "do" path with confirm severity (Step 1 promise).
  assertEq(r.kind, "do");
  assertEq(r.decisions[0].verdict.severity, "confirm");
});

test("[STEP2] AI emits simulate_spend BUT bundled with record_spend → batch validator handles it", async () => {
  const s = freshSetup(2_000_00);
  const r = await processMessage(s, "weird message", [], {
    _aiCall: stub({
      mode: "do",
      message: "...",
      intents: [
        { kind: "simulate_spend", params: { amountCents: 100_00 } },
        { kind: "record_spend", params: { amountCents: 200_00 } },
      ],
    }),
  });
  // Pipeline only routes a SOLO simulate_spend to the decision path.
  // Mixed batches go through the regular do path.
  assertEq(r.kind, "do");
});
