"use strict";
// Pipeline + integration tests. The killer scenario: AI emits setup_account
// on an already-setup user. Onboarding handles it deterministically. The AI
// is never asked about setup. Cannot loop.

const m = require("../model");
const { applyIntent } = require("../engine");
const { processMessage } = require("../pipeline");

const stub = (resp) => async () => typeof resp === "string" ? resp : JSON.stringify(resp);

function fullySetUp(balance) {
  let s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance || 500000, payday: "2025-05-15", payFrequency: "monthly" },
  }).state;
}

// ── ONBOARDING ROUTE: AI is bypassed ──────────────
test("[pipeline] virgin state + 'hi' → onboarding kind, no AI call", async () => {
  let aiCalled = false;
  const r = await processMessage(m.createFreshState(), "hi", [], {
    _aiCall: async () => { aiCalled = true; return ""; },
  });
  assertEq(r.kind, "onboarding");
  assertEq(aiCalled, false);
});
test("[pipeline] virgin state + '5000' → onboarding draft, no AI call", async () => {
  let aiCalled = false;
  const r = await processMessage(m.createFreshState(), "5000", [], {
    _aiCall: async () => { aiCalled = true; return ""; },
  });
  assertEq(r.kind, "onboarding");
  assertEq(aiCalled, false);
  assertEq(r.draft.balanceCents, 500000);
});
test("[pipeline] virgin + '5000 paid the 15th' → onboarding intent, no AI call", async () => {
  let aiCalled = false;
  const r = await processMessage(m.createFreshState(), "5000 paid the 15th", [], {
    _aiCall: async () => { aiCalled = true; return ""; },
  });
  assertEq(r.kind, "onboarding");
  assertEq(aiCalled, false);
  assertEq(r.intent.kind, "setup_account");
});

// ── POST-SETUP: AI extracts intent ────────────────
test("[pipeline] post-setup spend → do mode with confirm verdict", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "spent 20 on coffee", [], {
    _aiCall: stub({
      mode: "do",
      message: "Logging that.",
      intent: { kind: "record_spend", params: { amountCents: 2000, note: "coffee" } },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "record_spend");
  assertEq(r.verdict.ok, true);
});
test("[pipeline] post-setup income → do mode", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "got 3000 paycheck", [], {
    _aiCall: stub({
      mode: "do",
      message: "Adding that.",
      intent: { kind: "record_income", params: { amountCents: 300000, note: "paycheck" } },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "record_income");
});
test("[pipeline] post-setup add bill → do mode", async () => {
  const s = fullySetUp();
  const futureDate = m.addDays(m.today("UTC"), 14);
  const r = await processMessage(s, "rent 1400 due the 1st", [], {
    _aiCall: stub({
      mode: "do",
      message: "Adding rent.",
      intent: { kind: "add_bill", params: { name: "Rent", amountCents: 140000, dueDate: futureDate, recurrence: "monthly" } },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "add_bill");
  assertEq(r.verdict.ok, true);
});

// ── KILLER: AI emits setup_account on already-setup ─────
test("[pipeline] post-setup: AI emits setup_account → validator REJECTS (defense in depth)", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "fancy something", [], {
    _aiCall: stub({
      mode: "do",
      message: "Setting up.",
      intent: { kind: "setup_account", params: { balanceCents: 999999 } },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.verdict.ok, false);
  assertTrue(/already set up/i.test(r.verdict.reason));
});

// ── DECISION SUPPORT ──────────────────────────────
test("[pipeline] post-setup 'can I afford 200?' → decision kind with sim", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "can I afford 200?", [], {
    _aiCall: stub({
      mode: "ask_simulate",
      message: "Looking at it.",
      amountCents: 20000,
    }),
  });
  assertEq(r.kind, "decision");
  assertTrue(!!r.simulate);
  assertEq(r.simulate.projected.balanceCents, s.balanceCents - 20000);
});

// ── UNKNOWN INTENT FROM AI ────────────────────────
test("[pipeline] AI emits unknown intent kind → validator REJECTS", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "do weird stuff", [], {
    _aiCall: stub({
      mode: "do",
      message: "ok",
      intent: { kind: "transfer_to_attacker", params: {} },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.verdict.ok, false);
});

// ── TALK FALLBACK ─────────────────────────────────
test("[pipeline] AI returns talk → talk kind", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "how are you", [], {
    _aiCall: stub({ mode: "talk", message: "Doing alright. What's up?" }),
  });
  assertEq(r.kind, "talk");
});
test("[pipeline] AI returns garbage JSON → talk fallback, no crash", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "hi", [], { _aiCall: async () => "not json at all" });
  assertEq(r.kind, "talk");
});
test("[pipeline] AI throws → talk fallback with apology", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "hi", [], { _aiCall: async () => { throw new Error("network"); } });
  assertEq(r.kind, "talk");
});

// ── THE LOOP TEST: virgin + 'ok' should never crash or loop ─
test("[pipeline] virgin + 10 random inputs → never produces a setup_account intent without a balance (excluding skip words)", async () => {
  let s = m.createFreshState();
  // Inputs MUST not contain numbers (else parseAmount picks them up) and
  // MUST not be skip words (else early-skip exits onboarding intentionally).
  const inputs = ["hi", "ok", "lol", "what", "huh", "yes", "?", "🚀", "hmm", "ehh"];
  for (const inp of inputs) {
    const r = await processMessage(s, inp, [], { _aiCall: async () => { throw new Error("AI shouldn't be called"); } });
    assertEq(r.kind, "onboarding");
    assertEq(r.intent, null);
  }
  assertEq(s.setup, false);
});

// ── SILENT-LIE DETECTION (regression for the cat-undo bug) ──
// User reported: "I didn't really buy it" → bot said "Undoing it now" → nothing happened.
// The AI returned mode:"talk" with an action verb but no intent. Pipeline must catch this.

const { detectSilentLie } = require("../pipeline");

test("[silent-lie] talk mode 'Undoing it now' with no intent → fallback", () => {
  const out = detectSilentLie({ mode: "talk", message: "Undoing it now." }, "en");
  assertTrue(out !== null, "should detect the silent lie");
  assertTrue(/didn't actually|couldn't pin/i.test(out), "should be honest fallback");
});

test("[silent-lie] talk mode 'I'll undo' with no intent → fallback", () => {
  const out = detectSilentLie({ mode: "talk", message: "I'll undo that for you." }, "en");
  assertTrue(out !== null);
});

test("[silent-lie] do mode with undo_last intent + 'Undoing it' → consistent (no fallback)", () => {
  const out = detectSilentLie({
    mode: "do",
    message: "Undoing it now.",
    intent: { kind: "undo_last", params: {} },
  }, "en");
  assertEq(out, null);
});

test("[silent-lie] talk mode 'adjusting your balance' with no intent → fallback", () => {
  const out = detectSilentLie({ mode: "talk", message: "Adjusting your balance to $500." }, "en");
  assertTrue(out !== null);
});

test("[silent-lie] talk mode 'logging that' with no intent → fallback", () => {
  const out = detectSilentLie({ mode: "talk", message: "Logging that for you." }, "en");
  assertTrue(out !== null);
});

test("[silent-lie] talk mode 'removing that bill' with no intent → fallback", () => {
  const out = detectSilentLie({ mode: "talk", message: "Removing that for you." }, "en");
  assertTrue(out !== null);
});

// CRITICAL: false-positive checks. These should NOT fire — they're legit conversational.
test("[silent-lie-fp] 'I'll add support for that feature' (meta) → no fallback", () => {
  const out = detectSilentLie({ mode: "talk", message: "I'll add support for that feature later." }, "en");
  assertEq(out, null);
});

test("[silent-lie-fp] 'You'd be saving 30 a week' (calculation) → no fallback", () => {
  const out = detectSilentLie({ mode: "talk", message: "You'd be saving 30 a week if you cut coffee." }, "en");
  assertEq(out, null);
});

test("[silent-lie-fp] 'How much did you spend on that?' (question) → no fallback", () => {
  const out = detectSilentLie({ mode: "talk", message: "How much did you spend on that?" }, "en");
  assertEq(out, null);
});

test("[silent-lie-fp] 'Got it, $50 logged' (post-confirm ack — different verb form) → no fallback", () => {
  const out = detectSilentLie({
    mode: "do",
    message: "Got it, $50 logged.",
    intent: { kind: "record_spend", params: { amountCents: 5000 } },
  }, "en");
  assertEq(out, null);
});

test("[silent-lie] Russian: 'Отменяю это' with no intent → fallback", () => {
  const out = detectSilentLie({ mode: "talk", message: "Отменяю это сейчас." }, "ru");
  assertTrue(out !== null);
});

test("[silent-lie] full pipeline: talk mode undo lie → user sees fallback, not bot's lie", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "I didn't really buy it", [], {
    _aiCall: stub({ mode: "talk", message: "Undoing it now for you." }),
  });
  assertEq(r.kind, "talk");
  assertTrue(/didn't actually|couldn't pin/i.test(r.message), "user should see honest fallback, not the AI's lie");
});

// ── PARAMS-WRAPPER ROBUSTNESS (regression for the 30000 VND taxi bug) ──
// User reported: "I just got taxi back to hotel was 30,000 vnd" → "Need a
// valid amount." /debug showed AI emitted fields at top-level instead of
// inside params:{}. parseProposal must lift them automatically.

test("[params-lift] AI emits fields at top-level → pipeline lifts them", async () => {
  const s = fullySetUp();
  // Replicate the EXACT shape user saw in /debug — no params wrapper.
  const r = await processMessage(s, "30,000 vnd taxi", [], {
    _aiCall: stub({
      mode: "do",
      message: "Logging your spend.",
      intent: {
        kind: "record_spend",
        amountCents: 0,
        originalAmount: 30000,
        originalCurrency: "VND",
        note: "taxi",
      },
    }),
  });
  assertEq(r.kind, "do");
  assertTrue(r.intent !== undefined, "should have an intent");
  assertEq(r.intent.kind, "record_spend");
  // The fields should now be inside params.
  assertEq(r.intent.params.originalAmount, 30000);
  assertEq(r.intent.params.originalCurrency, "VND");
  assertEq(r.intent.params.note, "taxi");
  // Pipeline conversion ran: amountCents now reflects USD-converted VND.
  assertTrue(r.intent.params.amountCents > 0, "conversion should have filled amountCents");
});

test("[params-lift] AI emits proper params wrapper → pipeline preserves it", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "spent 25 on coffee", [], {
    _aiCall: stub({
      mode: "do",
      message: "Logging.",
      intent: {
        kind: "record_spend",
        params: { amountCents: 2500, note: "coffee" },
      },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.params.amountCents, 2500);
  assertEq(r.intent.params.note, "coffee");
});

test("[params-lift] AI batch with mixed shapes → all normalized", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "rent 1400 + 30000 vnd taxi", [], {
    _aiCall: stub({
      mode: "do",
      message: "Two things.",
      intents: [
        // properly wrapped
        { kind: "add_bill", params: { name: "Rent", amountCents: 140000, dueDate: "2025-06-01", recurrence: "monthly" } },
        // wrapper-less (the bug)
        { kind: "record_spend", amountCents: 0, originalAmount: 30000, originalCurrency: "VND", note: "taxi" },
      ],
    }),
  });
  assertEq(r.kind, "do_batch");
  assertEq(r.items.length, 2);
  // Both should have params accessible.
  assertEq(r.items[0].intent.params.name, "Rent");
  assertEq(r.items[1].intent.params.originalAmount, 30000);
  assertTrue(r.items[1].intent.params.amountCents > 0);
});

// ── DELETE_TRANSACTION AMBIGUITY HANDLING ──
// User reported concern: "if i say undo taxi and there are 5 taxis,
// how does the bot know which?" Tests below verify that the pipeline
// + engine handle the AI's various behaviors correctly.

test("[delete-amb] AI returns valid id from recent → applies cleanly", async () => {
  let s = fullySetUp();
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 5000, note: "cat" } }).state;
  const catId = s.transactions[s.transactions.length - 1].id;
  const r = await processMessage(s, "didn't get the cat", [], {
    _aiCall: stub({
      mode: "do",
      message: "Removing the cat purchase.",
      intent: { kind: "delete_transaction", params: { id: catId } },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "delete_transaction");
  assertEq(r.intent.params.id, catId);
  assertTrue(r.verdict.ok, "valid delete should pass validation");
});

test("[delete-amb] AI hallucinates id (not in state) → validator rejects with friendly msg", async () => {
  let s = fullySetUp();
  const r = await processMessage(s, "delete the cat", [], {
    _aiCall: stub({
      mode: "do",
      message: "Deleting the cat.",
      intent: { kind: "delete_transaction", params: { id: "tx_doesnotexist" } },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.verdict.ok, false);
  assertTrue(/find/i.test(r.verdict.reason), "should say couldn't find the tx");
});

test("[delete-amb] AI in talk mode asking 'which one' → user sees clarification, no silent action", async () => {
  let s = fullySetUp();
  // Three taxi spends, all real.
  for (let i = 0; i < 3; i++) {
    s = applyIntent(s, { kind: "record_spend", params: { amountCents: 1000 + i * 100, note: "taxi", vendor: "Taxi" } }).state;
  }
  const r = await processMessage(s, "undo taxi", [], {
    _aiCall: stub({
      mode: "talk",
      message: "You have 3 taxi entries — which one?\n  1. $10 May 1\n  2. $11 May 1\n  3. $12 May 1",
    }),
  });
  assertEq(r.kind, "talk");
  assertTrue(/which|3 taxi/i.test(r.message), "user should see the disambiguation prompt");
});

test("[delete-amb] AI says 'I don't see that' for out-of-context tx → no silent lie", async () => {
  let s = fullySetUp();
  const r = await processMessage(s, "delete the dinner from last month", [], {
    _aiCall: stub({
      mode: "talk",
      message: "I don't see that in your recent transactions. Got a date or amount?",
    }),
  });
  assertEq(r.kind, "talk");
  // Silent-lie check should NOT fire — no action verb in talk mode.
  // (The message says "I don't see" which is honest, not a promise.)
  assertTrue(!/I said I'd do it/.test(r.message), "honest reply should not be rewritten by silent-lie check");
});

test("[delete-amb] valid id with graph-field tx passes validation", async () => {
  // Verifies the pipeline path for a tx that has all the rich graph
  // fields. (Confirm-card formatting via bot.describeIntent is
  // production-exercised; not unit-tested here to avoid loading the
  // bot module which requires OPENAI_API_KEY at startup.)
  let s = fullySetUp();
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 5000, note: "cat", vendor: "PetStore", category: "personal" },
  }).state;
  const txId = s.transactions[s.transactions.length - 1].id;
  const r = await processMessage(s, "delete that cat", [], {
    _aiCall: stub({
      mode: "do",
      message: "Removing that cat purchase.",
      intent: { kind: "delete_transaction", params: { id: txId } },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.verdict.ok, true);
});

test("[delete-amb] AI emits silent-lie 'I'll delete it' with no intent → caught", async () => {
  let s = fullySetUp();
  const r = await processMessage(s, "delete that cat", [], {
    _aiCall: stub({
      mode: "talk",
      message: "I'll delete that for you.",
    }),
  });
  assertEq(r.kind, "talk");
  // The silent-lie check should rewrite this to honest fallback.
  assertTrue(/didn't actually|couldn't pin|I said I'd/i.test(r.message), "silent-lie 'I'll delete' should be caught");
});

test("[delete-amb] full chain: AI valid → pipeline → engine applies + balance correct", async () => {
  let s = fullySetUp();
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 5000, note: "cat" } }).state;
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 400, note: "juice" } }).state;
  assertEq(s.balanceCents, 494600);
  const catTx = s.transactions.find(t => t.note === "cat");

  const r = await processMessage(s, "didn't get the cat", [], {
    _aiCall: stub({
      mode: "do",
      message: "Removing the cat purchase.",
      intent: { kind: "delete_transaction", params: { id: catTx.id } },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.verdict.ok, true);
  // Apply via engine to verify final state
  const r2 = applyIntent(s, r.intent);
  assertEq(r2.state.balanceCents, 499600); // juice still applied, cat removed
});

// ── BACKDATE TRIPWIRE — diagnostic tripwire records a warning when the
// user's message clearly references a past time but the AI's intent
// has no date param. Tests cover EN + RU + the no-trigger case.
test("[pipeline] backdate tripwire fires when user says yesterday but AI drops date", async () => {
  const debug = require("../ai-debug");
  const s = fullySetUp(500000);
  await processMessage(s,
    "yesterday i forgot to tell you i got dinner for 780k vnd",
    [],
    {
      _debugUserId: "tripwire-test-1",
      _aiCall: stub({
        mode: "do",
        message: "Adding dinner.",
        // INTENT WITHOUT date — the bug we're catching
        intent: { kind: "record_spend", params: { amountCents: 0, originalAmount: 780000, originalCurrency: "VND", note: "dinner" } },
      }),
    });
  const warnings = debug.getWarnings("tripwire-test-1");
  assertTrue(warnings.length >= 1, "expected at least one warning");
  assertTrue(/yesterday/i.test(warnings[0].message), "warning mentions 'yesterday'");
  assertTrue(/AI dropped the date/i.test(warnings[0].message), "warning explains the miss");
});

test("[pipeline] backdate tripwire does NOT fire when AI emitted date correctly", async () => {
  const debug = require("../ai-debug");
  const s = fullySetUp(500000);
  await processMessage(s,
    "yesterday i bought coffee for 5",
    [],
    {
      _debugUserId: "tripwire-test-2",
      _aiCall: stub({
        mode: "do",
        message: "Adding.",
        intent: { kind: "record_spend", params: { amountCents: 500, note: "coffee", date: m.addDays(m.today("UTC"), -1) } },
      }),
    });
  const warnings = debug.getWarnings("tripwire-test-2");
  assertEq(warnings.length, 0, "AI did its job — no tripwire");
});

test("[pipeline] backdate tripwire fires for Russian 'вчера'", async () => {
  const debug = require("../ai-debug");
  const s = fullySetUp(500000);
  await processMessage(s,
    "вчера купил кофе за 200 руб",
    [],
    {
      _debugUserId: "tripwire-test-3",
      _aiCall: stub({
        mode: "do",
        message: "Добавляю.",
        intent: { kind: "record_spend", params: { amountCents: 0, originalAmount: 200, originalCurrency: "RUB", note: "кофе" } },
      }),
    });
  const warnings = debug.getWarnings("tripwire-test-3");
  assertTrue(warnings.length >= 1, "Russian past-time should trip");
  assertTrue(/вчера/.test(warnings[0].message));
});

test("[pipeline] backdate tripwire does NOT fire for present-tense 'today'", async () => {
  const debug = require("../ai-debug");
  const s = fullySetUp(500000);
  await processMessage(s,
    "today i bought lunch for 15",
    [],
    {
      _debugUserId: "tripwire-test-4",
      _aiCall: stub({
        mode: "do",
        message: "Adding.",
        intent: { kind: "record_spend", params: { amountCents: 1500, note: "lunch" } },
      }),
    });
  const warnings = debug.getWarnings("tripwire-test-4");
  assertEq(warnings.length, 0, "no past-time reference, no tripwire");
});
