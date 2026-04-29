"use strict";
// Real-human scenarios + edge cases. Each test simulates a realistic
// first-message dump, irregular pay, weird recurrences, mid-queue
// behavior. The bot's expected behavior is the AAA bar.

const m = require("../model");
const { applyIntent } = require("../engine");
const { validateIntent, validateBatch } = require("../validator");
const { processMessage } = require("../pipeline");

const stub = (resp) => async () => typeof resp === "string" ? resp : JSON.stringify(resp);

function freshSetup(balance, payday, freq) {
  let s = m.createFreshState();
  s = applyIntent(s, {
    kind: "setup_account",
    params: {
      balanceCents: balance || 5_000_00,
      payday: payday || m.addDays(m.today("UTC"), 30),
      payFrequency: freq || "monthly",
    },
  }).state;
  return s;
}

// ── REAL HUMAN: comprehensive first message ──────────────
test("[HUMAN-1] \"$5790 + hotel 1000 tomorrow + paid 25th of 13k\" → setup is step 1, queueAfter has 2", async () => {
  const fresh = m.createFreshState();
  const tomorrow = m.addDays(m.today("UTC"), 1);
  const r = await processMessage(fresh, "I have 5790 and have to pay vietnam hotel 1000 tomorrow, getting paid 13k on the 25th", [], {
    _aiCall: stub({
      mode: "do",
      message: "Got it — let's walk through these.",
      intents: [
        { kind: "setup_account", params: { balanceCents: 5790_00, payday: m.addDays(m.today("UTC"), 7), payFrequency: "monthly" } },
        { kind: "add_envelope", params: { name: "Vietnam Hotel", kind: "bill", amountCents: 1000_00, dueDate: tomorrow, recurrence: "once" } },
        { kind: "update_settings", params: { payday: m.addDays(m.today("UTC"), 7) } },
      ],
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.decisions.length, 1);
  assertEq(r.decisions[0].intent.kind, "setup_account");
  assertEq(r.decisions[0].verdict.ok, true);
  assertEq(r.queueTotal, 3);
  assertEq(r.queueIndex, 1);
  assertEq(r.queueAfter.length, 2);
  assertEq(r.queueAfter[0].kind, "add_envelope");
  assertEq(r.queueAfter[1].kind, "update_settings");
});

test("[HUMAN-1] orchestration even if AI puts setup in the middle of the batch", async () => {
  const fresh = m.createFreshState();
  const r = await processMessage(fresh, "...", [], {
    _aiCall: stub({
      mode: "do",
      message: "Sequencing.",
      intents: [
        { kind: "add_envelope", params: { name: "Rent", kind: "bill", amountCents: 1400_00, dueDate: m.addDays(m.today("UTC"), 30), recurrence: "monthly" } },
        { kind: "setup_account", params: { balanceCents: 5000_00 } },
        { kind: "add_envelope", params: { name: "Coffee", kind: "budget", amountCents: 100_00 } },
      ],
    }),
  });
  // Pipeline lifts setup_account to the front
  assertEq(r.decisions[0].intent.kind, "setup_account");
  assertEq(r.queueTotal, 3);
});

test("[HUMAN-1] solo intent unchanged — no queue overhead", async () => {
  const s = freshSetup();
  const r = await processMessage(s, "spent 5 on coffee", [], {
    _aiCall: stub({
      mode: "do",
      message: "Logging.",
      intents: [{ kind: "record_spend", params: { amountCents: 5_00, note: "coffee" } }],
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.decisions.length, 1);
  assertTrue(!r.queueAfter || r.queueAfter.length === 0);
});

// ── EDGE: IRREGULAR PAY ─────────────────────────────────
test("[HUMAN-2] freelancer with irregular pay: setup with payFrequency=irregular is valid", () => {
  const fresh = m.createFreshState();
  const v = validateIntent(fresh, {
    kind: "setup_account",
    params: { balanceCents: 8000_00, payFrequency: "irregular" },
  });
  assertEq(v.ok, true);
});

test("[HUMAN-2] irregular-pay user receives income — payday is unchanged (no auto-advance)", () => {
  let s = freshSetup(8000_00, "2099-01-15", "irregular");
  const before = s.payday;
  s = applyIntent(s, { kind: "record_income", params: { amountCents: 3000_00 } }).state;
  // payday stays — for irregular, system doesn't advance until user says
  assertEq(s.payday, before);
  assertEq(s.balanceCents, 11000_00);
});

// ── EDGE: WEIRD RECURRENCES ─────────────────────────────
test("[HUMAN-3] quarterly bill: car insurance every 3 months", () => {
  const s = freshSetup();
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Car Insurance", kind: "bill", amountCents: 600_00, dueDate: m.addDays(m.today("UTC"), 30), recurrence: "quarterly" },
  });
  assertEq(v.ok, true);
});

test("[HUMAN-3] quarterly pay_bill advances dueDate by ~91 days", () => {
  let s = freshSetup();
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Insurance", kind: "bill", amountCents: 300_00, dueDate: "2099-03-01", recurrence: "quarterly" },
  }).state;
  s = applyIntent(s, { kind: "pay_bill", params: { name: "Insurance" } }).state;
  // Original dueDate 2099-03-01 + 91 days = 2099-05-31
  assertEq(s.envelopes.insurance.dueDate, "2099-05-31");
});

test("[HUMAN-3] annual bill: domain renewal once a year", () => {
  let s = freshSetup();
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Domain", kind: "bill", amountCents: 15_00, dueDate: "2099-08-15", recurrence: "annual" },
  }).state;
  s = applyIntent(s, { kind: "pay_bill", params: { name: "Domain" } }).state;
  // 2099-08-15 + 365 days = 2100-08-15
  assertEq(s.envelopes.domain.dueDate, "2100-08-15");
});

test("[HUMAN-3] semiannual bill validates and applies cleanly", () => {
  const s = freshSetup();
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Vehicle Reg", kind: "bill", amountCents: 200_00, dueDate: m.addDays(m.today("UTC"), 60), recurrence: "semiannual" },
  });
  assertEq(v.ok, true);
});

test("[HUMAN-3] weekly groceries budget — not a bill", () => {
  const s = freshSetup();
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Groceries", kind: "budget", amountCents: 400_00 },
  });
  assertEq(v.ok, true);
});

// ── EDGE: BIG BATCHES ───────────────────────────────────
test("[HUMAN-4] 5-intent batch is sequenced (not rejected)", async () => {
  const fresh = m.createFreshState();
  const r = await processMessage(fresh, "lots of stuff", [], {
    _aiCall: stub({
      mode: "do",
      message: "Walk through.",
      intents: [
        { kind: "setup_account", params: { balanceCents: 10_000_00 } },
        { kind: "add_envelope", params: { name: "Rent", kind: "bill", amountCents: 1400_00, dueDate: m.addDays(m.today("UTC"), 30), recurrence: "monthly" } },
        { kind: "add_envelope", params: { name: "Phone", kind: "bill", amountCents: 60_00, dueDate: m.addDays(m.today("UTC"), 15), recurrence: "monthly" } },
        { kind: "add_envelope", params: { name: "Groceries", kind: "budget", amountCents: 400_00 } },
        { kind: "add_envelope", params: { name: "Vacation", kind: "goal", amountCents: 0, targetCents: 3000_00 } },
      ],
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.queueTotal, 5);
  assertEq(r.queueIndex, 1);
  assertEq(r.queueAfter.length, 4);
});

test("[HUMAN-4] 6-intent batch is trimmed to 5 (defensive cap)", async () => {
  const fresh = m.createFreshState();
  const r = await processMessage(fresh, "everything", [], {
    _aiCall: stub({
      mode: "do",
      message: "Hmm.",
      intents: [
        { kind: "setup_account", params: { balanceCents: 5000_00 } },
        { kind: "add_envelope", params: { name: "A", kind: "budget", amountCents: 100_00 } },
        { kind: "add_envelope", params: { name: "B", kind: "budget", amountCents: 100_00 } },
        { kind: "add_envelope", params: { name: "C", kind: "budget", amountCents: 100_00 } },
        { kind: "add_envelope", params: { name: "D", kind: "budget", amountCents: 100_00 } },
        { kind: "add_envelope", params: { name: "E", kind: "budget", amountCents: 100_00 } },
      ],
    }),
  });
  assertEq(r.queueTotal, 5);
});

// ── EDGE: ORCHESTRATION CORRECTNESS ─────────────────────
test("[HUMAN-5] queue advances correctly through engine apply", () => {
  // Simulate the queue walk that the bot's callback handler performs.
  let s = m.createFreshState();
  const queue = [
    { kind: "setup_account", params: { balanceCents: 5000_00 } },
    { kind: "add_envelope", params: { name: "Rent", kind: "bill", amountCents: 1400_00, dueDate: m.addDays(m.today("UTC"), 30), recurrence: "monthly" } },
    { kind: "add_envelope", params: { name: "Coffee", kind: "budget", amountCents: 100_00 } },
  ];
  for (const intent of queue) {
    const v = validateIntent(s, intent);
    assertEq(v.ok, true, "step should validate ok: " + intent.kind);
    s = applyIntent(s, intent).state;
  }
  assertEq(s.balanceCents, 5000_00);
  assertEq(s.envelopes.rent.kind, "bill");
  assertEq(s.envelopes.coffee.kind, "budget");
});

test("[HUMAN-5] queue: if an item rejects mid-walk, prior applies remain (no rollback needed)", () => {
  let s = m.createFreshState();
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 5000_00 },
  }).state;
  // user already has Rent
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1400_00, dueDate: m.addDays(m.today("UTC"), 30), recurrence: "monthly" },
  }).state;
  // queue tries to add another Rent (collision) + a Coffee budget
  const candidate1 = { kind: "add_envelope", params: { name: "Rent", kind: "bill", amountCents: 1500_00, dueDate: m.addDays(m.today("UTC"), 30), recurrence: "monthly" } };
  const candidate2 = { kind: "add_envelope", params: { name: "Coffee", kind: "budget", amountCents: 100_00 } };
  const v1 = validateIntent(s, candidate1);
  const v2 = validateIntent(s, candidate2);
  assertEq(v1.ok, false); // duplicate
  assertEq(v2.ok, true);
  // After the bot logs the skip and advances, Coffee applies cleanly
  s = applyIntent(s, candidate2).state;
  assertEq(s.envelopes.coffee.kind, "budget");
  // Rent's amount unchanged (the dup intent was skipped, not applied)
  assertEq(s.envelopes.rent.amountCents, 1400_00);
});

// ── EDGE: CANCEL MID-QUEUE ──────────────────────────────
test("[HUMAN-6] mid-queue cancel: user state matches what was already applied", () => {
  // Simulate: bot applies setup + Rent, then user cancels on Coffee step.
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 5000_00 } }).state;
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1400_00, dueDate: m.addDays(m.today("UTC"), 30), recurrence: "monthly" },
  }).state;
  // User cancels Coffee step. State has setup + Rent only — that's correct.
  assertTrue(s.setup);
  assertEq(s.envelopes.rent.amountCents, 1400_00);
  assertEq(s.envelopes.coffee, undefined);
});

// ── ALREADY-SETUP USER + COMPREHENSIVE MESSAGE ──────────
test("[HUMAN-7] already-setup user sends \"add rent + coffee + groceries\" → 3 sequenced confirms, NO setup", async () => {
  const s = freshSetup(5000_00);
  const r = await processMessage(s, "rent 1400 monthly, coffee 100, groceries 400", [], {
    _aiCall: stub({
      mode: "do",
      message: "Lining these up.",
      intents: [
        { kind: "add_envelope", params: { name: "Rent", kind: "bill", amountCents: 1400_00, dueDate: m.addDays(m.today("UTC"), 30), recurrence: "monthly" } },
        { kind: "add_envelope", params: { name: "Coffee", kind: "budget", amountCents: 100_00 } },
        { kind: "add_envelope", params: { name: "Groceries", kind: "budget", amountCents: 400_00 } },
      ],
    }),
  });
  assertEq(r.queueTotal, 3);
  assertEq(r.decisions[0].intent.kind, "add_envelope");
  // No setup_account in there
  assertTrue(!r.queueAfter.some(i => i.kind === "setup_account"));
});
