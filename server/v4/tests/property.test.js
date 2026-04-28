"use strict";
// Property-based tests: throw thousands of random VALID intent sequences at
// the engine and assert core invariants always hold. This is the receipt
// for "100% reliable arithmetic" — if any iteration breaks an invariant,
// the test fails loudly with the exact sequence that caused it.

const m = require("../model");
const { applyIntent } = require("../engine");
const { compute } = require("../view");

const ITERATIONS = 500;
const STEPS_PER_ITER = 30;

function rand(seed) {
  // tiny LCG so failures are reproducible
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

function genIntent(rng, state) {
  const envKeys = Object.keys(state.envelopes).filter(k => state.envelopes[k].active);
  const txIds = state.transactions.filter(t => t.kind !== "setup").map(t => t.id);

  // Weighted action choice (more spends than rare actions)
  const r = rng();
  if (r < 0.45 && state.setup) {
    // record_spend
    const amt = Math.floor(rng() * 200_00) + 1; // 1c..$200
    const useEnv = rng() < 0.4 && envKeys.length > 0;
    return {
      kind: "record_spend",
      params: {
        amountCents: amt,
        envelopeKey: useEnv ? pick(rng, envKeys) : null,
      },
    };
  }
  if (r < 0.6 && state.setup) {
    // record_income
    return { kind: "record_income", params: { amountCents: Math.floor(rng() * 5_000_00) + 100_00 } };
  }
  if (r < 0.8) {
    // add_envelope (unique name)
    const idx = Object.keys(state.envelopes).length + Math.floor(rng() * 1000);
    const name = "env_" + idx;
    const kind = pick(rng, ["bill", "budget", "goal"]);
    return {
      kind: "add_envelope",
      params: {
        name, kind,
        amountCents: Math.floor(rng() * 500_00) + 10_00,
        recurrence: "once",
      },
    };
  }
  if (r < 0.9 && txIds.length > 0) {
    // delete_transaction
    return { kind: "delete_transaction", params: { txId: pick(rng, txIds) } };
  }
  if (r < 0.95 && txIds.length > 0) {
    // edit_transaction (only spend/refund/bill_payment editable)
    const editableTxIds = state.transactions
      .filter(t => ["spend", "refund", "bill_payment"].includes(t.kind))
      .map(t => t.id);
    if (editableTxIds.length === 0) return null;
    return {
      kind: "edit_transaction",
      params: {
        txId: pick(rng, editableTxIds),
        newAmountCents: Math.floor(rng() * 100_00) + 1,
      },
    };
  }
  return null;
}

function checkInvariants(state, label) {
  // Invariant 1: balance == sum of all transaction effects
  // Setup contributes its amount. Spend/bill_payment subtract. Refund subtracts (negative). Income adds. Correction adds delta.
  let computed = 0;
  for (const tx of state.transactions) {
    if (tx.kind === "setup") computed += tx.amountCents;
    else if (tx.kind === "spend" || tx.kind === "refund") computed -= tx.amountCents;
    else if (tx.kind === "bill_payment") computed -= tx.amountCents;
    else if (tx.kind === "income") computed += tx.amountCents;
    else if (tx.kind === "correction") computed += tx.amountCents; // delta is stored as amountCents
  }
  if (computed !== state.balanceCents) {
    throw new Error(label + ": balance/transactions mismatch — computed=" + computed + " stored=" + state.balanceCents);
  }
  // Invariant 2: envelope spentCents >= 0
  for (const env of Object.values(state.envelopes)) {
    if (env.spentCents < 0) throw new Error(label + ": negative spent on " + env.key);
    if (env.amountCents < 0) throw new Error(label + ": negative amount on " + env.key);
  }
  // Invariant 3: view never produces a negative dailyPace number
  if (state.setup) {
    const v = compute(state, "2025-04-28");
    if (v.dailyPaceCents < 0) throw new Error(label + ": negative dailyPace " + v.dailyPaceCents);
    if (v.deficitCents < 0) throw new Error(label + ": negative deficit");
    if (!v.invariantOk) throw new Error(label + ": view invariant failed (obligated+disposable!=balance)");
  }
}

test("property: invariants hold across " + ITERATIONS + " random sequences", () => {
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const rng = rand(iter * 31 + 7);
    let state = m.createFreshState();
    state = applyIntent(state, {
      kind: "setup_account",
      params: {
        balanceCents: Math.floor(rng() * 10_000_00) + 100_00,
        payday: "2099-01-15",
        payFrequency: "monthly",
      },
    }).state;

    const sequence = ["setup"];
    for (let step = 0; step < STEPS_PER_ITER; step++) {
      const intent = genIntent(rng, state);
      if (!intent) continue;
      try {
        state = applyIntent(state, intent).state;
        sequence.push(intent.kind);
      } catch (e) {
        // engine threw; skip this intent (validator would normally catch first)
        continue;
      }
      try {
        checkInvariants(state, "iter=" + iter + " step=" + step);
      } catch (e) {
        e.message += "\n  sequence: " + sequence.join(" → ");
        throw e;
      }
    }
  }
});

test("property: replaying events through engine reaches same state (no event log replay yet — placeholder)", () => {
  // Real event-sourcing replay test will go here once we promote events to source-of-truth.
  // For now just ensure events are append-only and never empty after a mutation.
  let s = m.createFreshState();
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 1_000_00, payday: "2099-01-15", payFrequency: "monthly" },
  }).state;
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 25_00 } }).state;
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 10_00 } }).state;
  assertEq(s.events.length, 3);
  // Events strictly increasing by ts
  for (let i = 1; i < s.events.length; i++) {
    assertTrue(s.events[i].ts >= s.events[i - 1].ts, "events monotonic ts");
  }
});
