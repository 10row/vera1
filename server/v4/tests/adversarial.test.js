"use strict";
// Adversarial tests — simulate the bad outputs the LLM actually produces.
// Every named-bug-scenario the user has hit goes here, with an assertion that
// v4 catches it BEFORE state changes.

const m = require("../model");
const { applyIntent } = require("../engine");
const { validateIntent, validateBatch } = require("../validator");
const { compute } = require("../view");

const TODAY = "2025-04-28";

function freshSetup(balance) {
  const s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance, payday: "2025-05-15", payFrequency: "monthly" },
  }).state;
}

// ── THE VIETNAM SCENARIO (end-to-end reproduction) ─────────
// User said "I want a budget for Vietnam" with starting balance.
// v3 misclassified the balance as a spend, ended at -$700/day.
// In v4, every step where it could go wrong is caught.

test("[VIETNAM] AI tries to setup with NEGATIVE balance → rejected, no state mutation", () => {
  const fresh = m.createFreshState();
  const v = validateIntent(fresh, {
    kind: "setup_account",
    params: { balanceCents: -5_000_00 },
  }, TODAY);
  assertEq(v.ok, false);
  assertEq(v.severity, "reject");
  // State stays clean
  assertEq(fresh.setup, false);
  assertEq(fresh.balanceCents, 0);
});

test("[VIETNAM] AI tries to record initial balance as a SPEND on fresh state → rejected", () => {
  const fresh = m.createFreshState();
  const v = validateIntent(fresh, {
    kind: "record_spend",
    params: { amountCents: 5_000_00, note: "balance" },
  }, TODAY);
  // Must reject because state is not setup yet
  assertEq(v.ok, false);
  assertTrue(/set up/i.test(v.reason));
});

test("[VIETNAM] AI tries to spend MORE than balance → confirm with explicit warning", () => {
  const s = freshSetup(5_000_00);
  const v = validateIntent(s, {
    kind: "record_spend",
    params: { amountCents: 6_000_00, note: "Vietnam trip" },
  }, TODAY);
  assertEq(v.severity, "confirm");
  assertTrue(/balance/i.test(v.reason));
});

test("[VIETNAM] AI tries to add envelope with HALLUCINATED past date → rejected", () => {
  const s = freshSetup(5_000_00);
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: {
      name: "Vietnam Trip",
      kind: "bill",
      amountCents: 1_500_00,
      dueDate: "2024-08-15", // hallucinated last year
    },
  }, TODAY);
  assertEq(v.ok, false);
  assertTrue(/past/i.test(v.reason));
});

test("[VIETNAM] view never shows negative dailyPace, even with absurd unpaid bills", () => {
  let s = freshSetup(500_00); // user has $500
  // Force an obligation bigger than balance directly into state to simulate
  // a hypothetical bypass — view must STILL not lie.
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Mega Bill", kind: "bill", amountCents: 5_000_00, dueDate: "2025-05-10" },
  }).state;
  const v = compute(s, TODAY);
  assertEq(v.state, "over");
  assertEq(v.dailyPaceCents, 0);                 // never negative
  assertTrue(v.deficitCents > 0);                // surfaces as deficit
  assertTrue(v.invariantOk, "obligated + disposable must equal balance");
});

// ── COMMON LLM HALLUCINATIONS ───────────────────────────────

test("AI sends NaN as amount → rejected", () => {
  const s = freshSetup(1_000_00);
  const v = validateIntent(s, { kind: "record_spend", params: { amountCents: NaN } }, TODAY);
  assertEq(v.ok, false);
});

test("AI sends Infinity as amount → rejected", () => {
  const s = freshSetup(1_000_00);
  const v = validateIntent(s, { kind: "record_spend", params: { amountCents: Infinity } }, TODAY);
  assertEq(v.ok, false);
});

test("AI sends string instead of number → rejected", () => {
  const s = freshSetup(1_000_00);
  const v = validateIntent(s, { kind: "record_spend", params: { amountCents: "50" } }, TODAY);
  assertEq(v.ok, false);
});

test("AI sends absurdly large amount → rejected", () => {
  const s = freshSetup(1_000_00);
  const v = validateIntent(s, { kind: "record_spend", params: { amountCents: 999_999_999_999_99 } }, TODAY);
  assertEq(v.ok, false);
});

test("AI sends junk date '2024-13-45' → envelope add rejected", () => {
  const s = freshSetup(1_000_00);
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "X", kind: "bill", amountCents: 100_00, dueDate: "2024-13-45" },
  }, TODAY);
  assertEq(v.ok, false);
});

test("AI sends Feb 30 (real-looking but invalid) → rejected", () => {
  const s = freshSetup(1_000_00);
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "X", kind: "bill", amountCents: 100_00, dueDate: "2025-02-30" },
  }, TODAY);
  assertEq(v.ok, false);
});

test("AI emits 5 intents in a single turn (cascade attack) → rejected wholesale", () => {
  const s = freshSetup(1_000_00);
  const v = validateBatch(s, Array(5).fill({ kind: "record_spend", params: { amountCents: 10_00 } }), TODAY);
  assertEq(v.length, 1);
  assertEq(v[0].ok, false);
});

test("AI tries to delete an envelope that doesn't exist → rejected, no mutation", () => {
  const s = freshSetup(1_000_00);
  const v = validateIntent(s, { kind: "remove_envelope", params: { name: "ghost" } }, TODAY);
  assertEq(v.ok, false);
});

test("AI tries to pay a bill that doesn't exist → rejected", () => {
  const s = freshSetup(1_000_00);
  const v = validateIntent(s, { kind: "pay_bill", params: { name: "ghost" } }, TODAY);
  assertEq(v.ok, false);
});

test("AI tries to mark a budget as 'paid' → rejected (not a bill)", () => {
  let s = freshSetup(1_000_00);
  s = applyIntent(s, { kind: "add_envelope", params: { name: "Coffee", kind: "budget", amountCents: 100_00 } }).state;
  const v = validateIntent(s, { kind: "pay_bill", params: { name: "Coffee" } }, TODAY);
  assertEq(v.ok, false);
  assertTrue(/not a bill/i.test(v.reason));
});

test("AI sends unknown kind 'transmute_money' → rejected", () => {
  const s = freshSetup(1_000_00);
  const v = validateIntent(s, { kind: "transmute_money", params: {} }, TODAY);
  assertEq(v.ok, false);
});

test("AI tries to edit a setup transaction → rejected", () => {
  const s = freshSetup(1_000_00);
  const setupTxId = s.transactions[0].id;
  const v = validateIntent(s, { kind: "edit_transaction", params: { txId: setupTxId, newAmountCents: 9_000_00 } }, TODAY);
  assertEq(v.ok, false);
});

test("AI sends duplicate envelope name → rejected", () => {
  let s = freshSetup(1_000_00);
  s = applyIntent(s, { kind: "add_envelope", params: { name: "Rent", kind: "bill", amountCents: 1000_00 } }).state;
  const v = validateIntent(s, { kind: "add_envelope", params: { name: "rent", kind: "bill", amountCents: 999_00 } }, TODAY);
  assertEq(v.ok, false);
});

test("AI tries record_spend with envelope key it just made up → rejected", () => {
  const s = freshSetup(1_000_00);
  const v = validateIntent(s, {
    kind: "record_spend",
    params: { amountCents: 25_00, envelopeKey: "fake_envelope" },
  }, TODAY);
  assertEq(v.ok, false);
});

test("AI tries record_income with negative amount → rejected", () => {
  const s = freshSetup(1_000_00);
  const v = validateIntent(s, { kind: "record_income", params: { amountCents: -500_00 } }, TODAY);
  assertEq(v.ok, false);
});

// ── EDGE / WEIRDNESS ──────────────────────────────────────

test("Spending exactly $0.01 (smallest unit) works", () => {
  let s = freshSetup(1_000_00);
  const before = s.balanceCents;
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 1 } }).state;
  assertEq(s.balanceCents, before - 1);
});

test("Spending exactly the entire balance is allowed (with confirm)", () => {
  const s = freshSetup(100_00);
  const v = validateIntent(s, { kind: "record_spend", params: { amountCents: 100_00 } }, TODAY);
  assertEq(v.ok, true);
  assertEq(v.severity, "confirm");
});

test("Refund larger than balance results in net positive (confirmed)", () => {
  let s = freshSetup(50_00);
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: -200_00, note: "big refund" } }).state;
  assertEq(s.balanceCents, 50_00 + 200_00);
});

test("Many tiny spends (1000) maintain exact balance", () => {
  let s = freshSetup(1_000_00);
  for (let i = 0; i < 1000; i++) {
    s = applyIntent(s, { kind: "record_spend", params: { amountCents: 1 } }).state;
  }
  assertEq(s.balanceCents, 1_000_00 - 1000);
});

test("Setup, spend, edit, delete cycle leaves correct balance", () => {
  let s = freshSetup(1_000_00);
  const r1 = applyIntent(s, { kind: "record_spend", params: { amountCents: 30_00 } });
  s = r1.state;
  s = applyIntent(s, { kind: "edit_transaction", params: { txId: r1.event.txId, newAmountCents: 50_00 } }).state;
  assertEq(s.balanceCents, 1_000_00 - 50_00);
  s = applyIntent(s, { kind: "delete_transaction", params: { txId: r1.event.txId } }).state;
  assertEq(s.balanceCents, 1_000_00);
});

// ── IMMUTABILITY & DETERMINISM ─────────────────────────────

test("applyIntent twice on same input gives same output (determinism)", () => {
  const s = freshSetup(1_000_00);
  const intent = { kind: "record_spend", params: { amountCents: 25_00, note: "x" } };
  const a = applyIntent(s, intent);
  const b = applyIntent(s, intent);
  // Balances and envelopes must match exactly. (Event ids/ts will differ.)
  assertEq(a.state.balanceCents, b.state.balanceCents);
  assertEq(a.state.envelopes, b.state.envelopes);
});

test("compute(state) is pure: same input → same output", () => {
  let s = freshSetup(1_000_00);
  s = applyIntent(s, { kind: "add_envelope", params: { name: "Rent", kind: "bill", amountCents: 600_00, dueDate: "2025-05-01" } }).state;
  const a = compute(s, TODAY);
  const b = compute(s, TODAY);
  assertEq(a, b);
});

// ── VIEW NEVER LIES ───────────────────────────────────────

test("VIEW LIE CHECK: with $0 balance and no bills, dailyPace is 0 not crazy", () => {
  const s = freshSetup(1);
  const tiny = { ...s, balanceCents: 0 };
  const v = compute(tiny, TODAY);
  assertEq(v.dailyPaceCents, 0);
  assertEq(v.deficitCents, 0);
});

test("VIEW LIE CHECK: huge obligated, tiny balance — deficit shown, no negative pace", () => {
  let s = freshSetup(10_00); // $10
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1_000_00, dueDate: "2025-05-10" },
  }).state;
  const v = compute(s, TODAY);
  assertEq(v.dailyPaceCents, 0);
  assertTrue(v.deficitCents > 0);
  assertEq(v.state, "over");
});

test("Property: 2000 random sequences × 50 steps maintain ALL invariants", () => {
  // High-iteration property test — run separately for confidence.
  const ITER = 2000;
  const STEPS = 50;
  function rng(seed) { let s = seed | 0; return () => { s = (s * 1664525 + 1013904223) | 0; return ((s >>> 0) % 1_000_000) / 1_000_000; }; }
  function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }

  for (let it = 0; it < ITER; it++) {
    const r = rng(it * 97 + 13);
    let state = m.createFreshState();
    state = applyIntent(state, {
      kind: "setup_account",
      params: { balanceCents: Math.floor(r() * 50_000_00) + 100_00, payday: "2099-01-15", payFrequency: "monthly" },
    }).state;

    for (let st = 0; st < STEPS; st++) {
      const choice = r();
      let intent = null;
      const envKeys = Object.keys(state.envelopes).filter(k => state.envelopes[k].active);
      const editableTx = state.transactions.filter(t => ["spend","refund","bill_payment"].includes(t.kind)).map(t => t.id);
      if (choice < 0.5) {
        intent = { kind: "record_spend", params: { amountCents: Math.floor(r() * 500_00) + 1, envelopeKey: r() < 0.3 && envKeys.length ? pick(r, envKeys) : null } };
      } else if (choice < 0.7) {
        intent = { kind: "record_income", params: { amountCents: Math.floor(r() * 5_000_00) + 100_00 } };
      } else if (choice < 0.85) {
        intent = { kind: "add_envelope", params: { name: "e_" + Object.keys(state.envelopes).length + "_" + st, kind: pick(r, ["bill", "budget", "goal"]), amountCents: Math.floor(r() * 500_00) + 100, recurrence: "once" } };
      } else if (editableTx.length > 0 && choice < 0.95) {
        intent = { kind: "edit_transaction", params: { txId: pick(r, editableTx), newAmountCents: Math.floor(r() * 200_00) + 1 } };
      }
      if (!intent) continue;
      try { state = applyIntent(state, intent).state; } catch { continue; }

      // Invariant: balance derivable from transactions
      let computed = 0;
      for (const tx of state.transactions) {
        if (tx.kind === "setup") computed += tx.amountCents;
        else if (tx.kind === "spend" || tx.kind === "refund" || tx.kind === "bill_payment") computed -= tx.amountCents;
        else if (tx.kind === "income") computed += tx.amountCents;
        else if (tx.kind === "correction") computed += tx.amountCents;
      }
      if (computed !== state.balanceCents) {
        throw new Error("BALANCE BREACH iter=" + it + " step=" + st + " computed=" + computed + " stored=" + state.balanceCents);
      }
      // Invariant: view doesn't lie
      const v = compute(state, "2025-04-28");
      if (v.dailyPaceCents < 0) throw new Error("NEGATIVE PACE iter=" + it + " step=" + st);
      if (v.deficitCents < 0) throw new Error("NEGATIVE DEFICIT iter=" + it + " step=" + st);
      if (!v.invariantOk) throw new Error("VIEW INVARIANT BROKEN iter=" + it + " step=" + st);
      // Invariant: no envelope spent < 0
      for (const e of Object.values(state.envelopes)) {
        if (e.spentCents < 0) throw new Error("NEG SPENT iter=" + it + " step=" + st);
      }
    }
  }
});
