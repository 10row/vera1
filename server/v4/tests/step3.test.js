"use strict";
// Step 3 — Onboarding flow tests.
// Goal: setup-flow enforced even when the AI is misbehaving.

const m = require("../model");
const { applyIntent } = require("../engine");
const { validateIntent } = require("../validator");
const { processMessage } = require("../pipeline");

const TODAY = "2025-04-28";
const stub = (resp) => async () => typeof resp === "string" ? resp : JSON.stringify(resp);

// ── ONBOARDING ORDER GUARD: envelopes can't be added before setup ─────
test("[STEP3] add_envelope on fresh state → rejected with friendly hint", () => {
  const fresh = m.createFreshState();
  const v = validateIntent(fresh, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1400_00, recurrence: "monthly", dueDate: m.addDays(m.today("UTC"), 30) },
  }, TODAY);
  assertEq(v.ok, false);
  assertTrue(/balance/i.test(v.reason), "hint should mention balance");
});

test("[STEP3] AI tries to add Rent before setup → pipeline returns reject with friendly copy", async () => {
  const fresh = m.createFreshState();
  const r = await processMessage(fresh, "rent is 1400", [], {
    _aiCall: stub({
      mode: "do",
      message: "Adding rent.",
      intents: [{
        kind: "add_envelope",
        params: { name: "Rent", kind: "bill", amountCents: 1400_00, recurrence: "monthly", dueDate: m.addDays(m.today("UTC"), 30) },
      }],
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.decisions[0].verdict.ok, false);
});

// ── SETUP DEFAULTS: balance only → engine fills sane defaults ─────────
test("[STEP3] setup_account with just balanceCents → engine applies sensible defaults", () => {
  const fresh = m.createFreshState();
  const r = applyIntent(fresh, {
    kind: "setup_account",
    params: { balanceCents: 5_000_00 },
  });
  assertEq(r.state.setup, true);
  assertEq(r.state.balanceCents, 5_000_00);
  assertEq(r.state.payFrequency, "monthly");
  assertTrue(!!r.state.payday, "payday should default");
  // Default payday should be ~30 days out
  const daysOut = m.daysBetween(m.today(r.state.timezone), r.state.payday);
  assertTrue(daysOut >= 28 && daysOut <= 32, "default payday should be ~30 days out, got " + daysOut);
});

// ── PHASE 1 → PHASE 2 PROGRESSION ─────────────────────────────────
test("[STEP3] Phase 1: balance-only setup applies cleanly", async () => {
  const fresh = m.createFreshState();
  const r = await processMessage(fresh, "I have 5000", [], {
    _aiCall: stub({
      mode: "do",
      message: "Got it. When's your next paycheck?",
      intents: [{ kind: "setup_account", params: { balanceCents: 5_000_00 } }],
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.decisions[0].verdict.ok, true);
  assertEq(r.decisions[0].verdict.severity, "confirm");
});

test("[STEP3] Phase 1+2 combined: balance + payday in one message → single setup_account", async () => {
  const fresh = m.createFreshState();
  const futureDate = m.addDays(m.today("UTC"), 15);
  const r = await processMessage(fresh, "5000, get paid the 15th", [], {
    _aiCall: stub({
      mode: "do",
      message: "Got it.",
      intents: [{
        kind: "setup_account",
        params: { balanceCents: 5_000_00, payday: futureDate, payFrequency: "monthly" },
      }],
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.decisions[0].verdict.ok, true);
});

// ── ATOMIC SETUP: bundling setup with extras still rejected ───────
test("[STEP3] AI bundles setup+envelope → batch reject (Step 1's solo rule)", async () => {
  const fresh = m.createFreshState();
  const r = await processMessage(fresh, "5000 balance, rent 1400", [], {
    _aiCall: stub({
      mode: "do",
      message: "Setting up.",
      intents: [
        { kind: "setup_account", params: { balanceCents: 5_000_00 } },
        { kind: "add_envelope", params: { name: "Rent", kind: "bill", amountCents: 1400_00, recurrence: "monthly", dueDate: m.addDays(m.today("UTC"), 30) } },
      ],
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.decisions[0].verdict.ok, false);
  assertTrue(/setup first/i.test(r.decisions[0].verdict.reason));
});

// ── PHASE 3: BILLS LOOP ───────────────────────────────────────────
test("[STEP3] After setup, single add_envelope with monthly recurrence → confirm", () => {
  const fresh = m.createFreshState();
  const setupState = applyIntent(fresh, { kind: "setup_account", params: { balanceCents: 5_000_00 } }).state;
  const v = validateIntent(setupState, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1400_00, recurrence: "monthly", dueDate: m.addDays(m.today("UTC"), 30) },
  }, TODAY);
  assertEq(v.ok, true);
  assertEq(v.severity, "confirm");
});

test("[STEP3] After setup, single add_envelope with goal kind → confirm", () => {
  const fresh = m.createFreshState();
  const setupState = applyIntent(fresh, { kind: "setup_account", params: { balanceCents: 5_000_00 } }).state;
  const v = validateIntent(setupState, {
    kind: "add_envelope",
    params: { name: "Vietnam Trip", kind: "goal", amountCents: 1500_00, recurrence: "once" },
  }, TODAY);
  assertEq(v.ok, true);
});

// ── EDGE: USER CHANGES BALANCE LATER ─────────────────────────
test("[STEP3] After setup, AI emits adjust_balance to fix balance (correct path) → confirm", () => {
  const fresh = m.createFreshState();
  const s = applyIntent(fresh, { kind: "setup_account", params: { balanceCents: 5_000_00 } }).state;
  const v = validateIntent(s, { kind: "adjust_balance", params: { newBalanceCents: 4_700_00 } }, TODAY);
  assertEq(v.ok, true);
  assertEq(v.severity, "confirm");
});

test("[STEP3] After setup, AI tries setup_account again → still rejected (Step 1's hardening)", () => {
  const fresh = m.createFreshState();
  const s = applyIntent(fresh, { kind: "setup_account", params: { balanceCents: 5_000_00 } }).state;
  const v = validateIntent(s, { kind: "setup_account", params: { balanceCents: 6_000_00 } }, TODAY);
  assertEq(v.ok, false);
});

// ── EDGE: VAGUE/SKIP HANDLING (TALK mode) ────────────────────
test("[STEP3] User says 'skip' during onboarding → AI returns talk mode, no intent", async () => {
  const fresh = m.createFreshState();
  const setupState = applyIntent(fresh, { kind: "setup_account", params: { balanceCents: 5_000_00 } }).state;
  const r = await processMessage(setupState, "skip", [], {
    _aiCall: stub({
      mode: "talk",
      message: "All set then. $5,000 free, $166/day for 30 days. Easy.",
      intents: [],
    }),
  });
  assertEq(r.kind, "talk");
});

test("[STEP3] User says 'idk maybe like 5k' → AI emits setup_account with 5000", async () => {
  const fresh = m.createFreshState();
  const r = await processMessage(fresh, "idk maybe like 5k", [], {
    _aiCall: stub({
      mode: "do",
      message: "$5,000, got it. When's payday?",
      intents: [{ kind: "setup_account", params: { balanceCents: 5_000_00 } }],
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.decisions[0].verdict.ok, true);
});

// ── INVALID SETUP INPUTS ──────────────────────────────────────
test("[STEP3] Setup with negative balance → rejected (Vietnam class)", () => {
  const fresh = m.createFreshState();
  const v = validateIntent(fresh, { kind: "setup_account", params: { balanceCents: -5_000_00 } }, TODAY);
  assertEq(v.ok, false);
});

test("[STEP3] Setup with absurd balance → rejected", () => {
  const fresh = m.createFreshState();
  const v = validateIntent(fresh, { kind: "setup_account", params: { balanceCents: 999_999_999_999_99 } }, TODAY);
  assertEq(v.ok, false);
});
