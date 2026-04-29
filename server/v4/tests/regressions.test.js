"use strict";
// Regression tests — each test corresponds to a real bug a user reported.
// Bug = description of what happened in production.
// Once shipped, these stop the bug from coming back.

const m = require("../model");
const { applyIntent } = require("../engine");
const { validateIntent, validateBatch } = require("../validator");
const { processMessage } = require("../pipeline");

const TODAY = "2025-04-28";

function freshSetup(balance) {
  const s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance || 5_000_00, payday: "2025-05-15", payFrequency: "monthly" },
  }).state;
}

const stub = (resp) => async () => typeof resp === "string" ? resp : JSON.stringify(resp);

// ── BUG 1: AI re-emits setup_account on already-setup user ─────────
// Symptom: user with $5000 balance sent voice about rent. Bot responded
// with "I'll set up your account with $5000" + confirm card asking to
// overwrite — even though they were already set up.
test("[BUG-1] setup_account on already-setup state is rejected, never confirm-overwrite", () => {
  const s = freshSetup();
  const v = validateIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 5_000_00 },
  }, TODAY);
  assertEq(v.ok, false);
  assertEq(v.severity, "reject");
  assertTrue(/already set up/i.test(v.reason));
});

test("[BUG-1] pipeline: AI emits setup on already-setup user with same balance → silent rewrite to talk (no rejection)", async () => {
  // Pipeline now REWRITES setup_account on an already-set-up user.
  // If params are no-ops (same balance, no schedule changes), the
  // rewriter drops the intent and the user sees a TALK reply rather
  // than a rejection card. The "already set up" message is gone.
  const s = freshSetup();
  const r = await processMessage(s, "rent is 1400 due 1st", [], {
    _aiCall: stub({
      mode: "do",
      message: "Let's add that.",
      intents: [{ kind: "setup_account", params: { balanceCents: 5_000_00 } }],
    }),
  });
  // Rewriter dropped the intent → falls back to talk
  assertEq(r.kind, "talk");
});

test("[BUG-1] pipeline: AI emits setup with NEW balance on set-up user → rewritten to adjust_balance", async () => {
  const s = freshSetup();
  const r = await processMessage(s, "actually I have 7000 now", [], {
    _aiCall: stub({
      mode: "do",
      message: "Updating.",
      intents: [{ kind: "setup_account", params: { balanceCents: 7_000_00 } }],
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.decisions[0].intent.kind, "adjust_balance");
  assertEq(r.decisions[0].intent.params.newBalanceCents, 7_000_00);
});

test("[BUG-1] pipeline: AI emits setup with NEW payday on set-up user → rewritten to update_settings", async () => {
  const s = freshSetup();
  const futurePayday = m.addDays(m.today("UTC"), 12);
  const r = await processMessage(s, "I get paid on the 12th now", [], {
    _aiCall: stub({
      mode: "do",
      message: "Got it.",
      intents: [{ kind: "setup_account", params: { balanceCents: 5_000_00, payday: futurePayday } }],
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.decisions[0].intent.kind, "update_settings");
  assertEq(r.decisions[0].intent.params.payday, futurePayday);
});

// ── BUG 2: rent envelope without recurrence: monthly ──────────────
// Symptom: user said "rent" — bot added it as recurrence:"once" because
// the AI omitted the field. Rent silently disappears after one payment.
test("[BUG-2] add_envelope 'Rent' without recurrence is rejected — must be monthly", () => {
  const s = freshSetup();
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1400_00, dueDate: "2025-05-01" },
  }, TODAY);
  assertEq(v.ok, false);
  // Verdict now uses code-based rendering. Original text was about
  // recurrence — the new wording asks "does Rent repeat every month?"
  assertEq(v.code, "envBillNeedsRecurrence");
  assertTrue(/repeat|month/i.test(v.reason));
});

test("[BUG-2] add_envelope 'Rent' with recurrence:once is rejected", () => {
  const s = freshSetup();
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1400_00, dueDate: "2025-05-01", recurrence: "once" },
  }, TODAY);
  assertEq(v.ok, false);
});

test("[BUG-2] add_envelope 'Rent' with recurrence:monthly passes", () => {
  const s = freshSetup();
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1400_00, dueDate: "2025-05-01", recurrence: "monthly" },
  }, TODAY);
  assertEq(v.ok, true);
});

test("[BUG-2] common monthly bills must specify recurrence (insurance, phone, internet, gym, netflix, …)", () => {
  const s = freshSetup();
  for (const name of ["Car Insurance", "Phone Bill", "Internet", "Spotify", "Gym Membership", "Mortgage"]) {
    const v = validateIntent(s, {
      kind: "add_envelope",
      params: { name, kind: "bill", amountCents: 100_00, dueDate: "2025-05-01" },
    }, TODAY);
    assertEq(v.ok, false);
  }
});

test("[BUG-2] non-monthly-pattern bill 'Vietnam Trip' with recurrence:once passes", () => {
  const s = freshSetup();
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Vietnam Trip", kind: "bill", amountCents: 1500_00, dueDate: "2025-08-15", recurrence: "once" },
  }, TODAY);
  assertEq(v.ok, true);
});

// ── BUG 3 / BUG 4: setup_account must be solo ─────────────────────
// Symptom: bot tried to setup AND add envelope in the same turn, sending
// two confirm cards. Setup must be its own atomic step.
test("[BUG-4] setup_account bundled with add_envelope: pipeline now SEQUENCES (not rejects). validateBatch returns per-intent verdicts.", () => {
  // Old behavior was a wholesale reject. New behavior is orchestration:
  // pipeline lifts setup to step 1, queues envelope as step 2.
  const s = m.createFreshState();
  const v = validateBatch(s, [
    { kind: "setup_account", params: { balanceCents: 5000_00 } },
    { kind: "add_envelope", params: { name: "Rent", kind: "bill", amountCents: 1400_00, recurrence: "monthly", dueDate: m.addDays(m.today("UTC"), 30) } },
  ], TODAY);
  // validateBatch now returns 2 verdicts (one per intent) — pipeline does
  // the sequencing. Both should be ok individually given the right state.
  assertEq(v.length, 2);
  assertEq(v[0].ok, true); // setup ok on fresh state
  // envelope is rejected at this point because state.setup is still false
  // (pipeline applies setup FIRST, then re-validates envelope against new state)
  assertEq(v[1].ok, false);
});

test("[BUG-4] setup_account alone passes through validateBatch", () => {
  const s = m.createFreshState();
  const v = validateBatch(s, [
    { kind: "setup_account", params: { balanceCents: 5000_00 } },
  ], TODAY);
  assertEq(v.length, 1);
  assertEq(v[0].ok, true);
});

// ── BUG 5: new bill with past due date ────────────────────────────
// Old behavior: dates within last 14 days allowed. New: past dates rejected.
test("[BUG-5] new bill with past due date is rejected", () => {
  const s = freshSetup();
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Rent", kind: "bill", amountCents: 1400_00, dueDate: "2025-04-20", recurrence: "monthly" },
  }, TODAY);
  assertEq(v.ok, false);
  assertTrue(/past/i.test(v.reason));
});

test("[BUG-5] new bill with today's date is allowed", () => {
  const s = freshSetup();
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Vietnam Trip", kind: "bill", amountCents: 1500_00, dueDate: TODAY, recurrence: "once" },
  }, TODAY);
  assertEq(v.ok, true);
});

// ── BUG 6: cascade cap moved to 5; orchestration sequences the rest ─
// Pipeline now sequences multi-intent batches into "1 of N" confirms.
// Validator returns per-intent verdicts; only > 5 in one turn is rejected.
test("[BUG-6] batch of 3 intents now passes (validator cap is 5; orchestrated)", () => {
  const s = freshSetup();
  const v = validateBatch(s, [
    { kind: "record_spend", params: { amountCents: 100 } },
    { kind: "record_spend", params: { amountCents: 200 } },
    { kind: "record_spend", params: { amountCents: 300 } },
  ], TODAY);
  assertEq(v.length, 3);
  v.forEach(x => assertEq(x.ok, true));
});

test("[BUG-6] batch of 6 intents IS rejected wholesale (the new cap is 5)", () => {
  const s = freshSetup();
  const v = validateBatch(s, Array(6).fill({ kind: "record_spend", params: { amountCents: 100 } }), TODAY);
  assertEq(v.length, 1);
  assertEq(v[0].ok, false);
});

// ── INTEGRATION via pipeline ──────────────────────────────────────
test("[ALL BUGS] AI emits setup+add_envelope on already-setup user → batch reject", async () => {
  const s = freshSetup();
  const r = await processMessage(s, "rent 1400 1st", [], {
    _aiCall: stub({
      mode: "do",
      message: "Setting up.",
      intents: [
        { kind: "setup_account", params: { balanceCents: 5000_00 } },
        { kind: "add_envelope", params: { name: "Rent", kind: "bill", amountCents: 1400_00, dueDate: "2025-05-01", recurrence: "monthly" } },
      ],
    }),
  });
  assertEq(r.kind, "do");
  // Whole batch is rejected because setup must be solo
  assertEq(r.decisions[0].verdict.ok, false);
});

test("[ALL BUGS] AI emits add_envelope alone for rent with monthly → confirm", async () => {
  const s = freshSetup();
  // Date is computed relative to real today so the test stays valid forever
  // (unlike literal "2025-05-01", which would silently fall in the past).
  const futureDate = m.addDays(m.today("UTC"), 14);
  const r = await processMessage(s, "rent 1400 due the 1st", [], {
    _aiCall: stub({
      mode: "do",
      message: "Adding rent.",
      intents: [
        { kind: "add_envelope", params: { name: "Rent", kind: "bill", amountCents: 1400_00, dueDate: futureDate, recurrence: "monthly" } },
      ],
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.decisions.length, 1);
  assertEq(r.decisions[0].verdict.ok, true);
  assertEq(r.decisions[0].verdict.severity, "confirm");
});
