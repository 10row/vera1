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

// ── BACKDATE AUTO-INJECT — deterministic safety net. The AI is
// non-deterministic about emitting the date param (verified with two
// back-to-back real-AI calls — one had date, one didn't). Pipeline
// now resolves the date from the user's raw message and injects it
// when the AI drops it. Tests verify EN, RU, and no-false-positives.
test("[pipeline] auto-injects date when AI drops it for 'yesterday i ...' (EN leading)", async () => {
  const debug = require("../ai-debug");
  const s = fullySetUp(500000);
  s.transactions[0].date = m.addDays(m.today("UTC"), -10); // widen backdate window
  const r = await processMessage(s,
    "yesterday i forgot to tell you i got dinner for 780k vnd",
    [],
    {
      _debugUserId: "auto-inject-1",
      _aiCall: stub({
        mode: "do",
        message: "Adding dinner.",
        intent: { kind: "record_spend", params: { amountCents: 0, originalAmount: 780000, originalCurrency: "VND", note: "dinner" } },
      }),
    });
  // Date MUST now be injected on the intent.
  assertEq(r.intent.params.date, m.addDays(m.today("UTC"), -1), "date injected from 'yesterday'");
  // Diagnostic breadcrumb appears in /debug.
  const warnings = debug.getWarnings("auto-inject-1");
  assertTrue(warnings.length >= 1, "auto-inject leaves a breadcrumb");
  assertTrue(/auto-injected/i.test(warnings[0].message), "breadcrumb explains what happened");
});

test("[pipeline] does NOT override AI-emitted date when AI got it right", async () => {
  const debug = require("../ai-debug");
  const s = fullySetUp(500000);
  s.transactions[0].date = m.addDays(m.today("UTC"), -10);
  const yesterdayISO = m.addDays(m.today("UTC"), -1);
  const r = await processMessage(s,
    "yesterday i bought coffee for 5",
    [],
    {
      _debugUserId: "auto-inject-2",
      _aiCall: stub({
        mode: "do",
        message: "Adding.",
        intent: { kind: "record_spend", params: { amountCents: 500, note: "coffee", date: yesterdayISO } },
      }),
    });
  // AI emitted date — we MUST NOT override it.
  assertEq(r.intent.params.date, yesterdayISO, "AI's date is respected");
  const warnings = debug.getWarnings("auto-inject-2");
  // No auto-inject breadcrumb (nothing was injected).
  assertEq(warnings.filter(w => /auto-injected/i.test(w.message)).length, 0);
});

test("[pipeline] auto-injects for Russian 'вчера'", async () => {
  const s = fullySetUp(500000);
  s.transactions[0].date = m.addDays(m.today("UTC"), -10);
  const r = await processMessage(s,
    "вчера купил кофе за 200 руб",
    [],
    {
      _debugUserId: "auto-inject-3",
      _aiCall: stub({
        mode: "do",
        message: "Добавляю.",
        intent: { kind: "record_spend", params: { amountCents: 0, originalAmount: 200, originalCurrency: "RUB", note: "кофе" } },
      }),
    });
  assertEq(r.intent.params.date, m.addDays(m.today("UTC"), -1), "Russian вчера resolves to yesterday");
});

test("[pipeline] does NOT auto-inject for present-tense 'today'", async () => {
  const s = fullySetUp(500000);
  const r = await processMessage(s,
    "today i bought lunch for 15",
    [],
    {
      _debugUserId: "auto-inject-4",
      _aiCall: stub({
        mode: "do",
        message: "Adding.",
        intent: { kind: "record_spend", params: { amountCents: 1500, note: "lunch" } },
      }),
    });
  assertEq(r.intent.params.date, undefined, "today reference → no inject");
});

// REGRESSION — AI sometimes emits the literal word "yesterday" as a date.
// Pre-fix: auto-inject saw a truthy params.date and respected it. Then
// validator threw "Invalid date format — use YYYY-MM-DD." User reported
// this bug after writing a 2-spend message where AI emitted both with
// date:"yesterday" instead of ISO. Tests now lock this in.
test("[pipeline] auto-inject overrides AI's literal 'yesterday' string with valid ISO", async () => {
  const s = fullySetUp(500000);
  s.transactions[0].date = m.addDays(m.today("UTC"), -10);
  const r = await processMessage(s,
    "yesterday gym 10 usd and food indian 40 usd",
    [],
    {
      _debugUserId: "junk-date-1",
      _aiCall: stub({
        mode: "do",
        message: "Adding both yesterday.",
        intents: [
          { kind: "record_spend", params: { amountCents: 1000, note: "gym", date: "yesterday" } },     // junk
          { kind: "record_spend", params: { amountCents: 4000, note: "indian food", date: "yesterday" } }, // junk
        ],
      }),
    });
  // Both intents must have ISO dates after auto-inject.
  const yesterdayISO = m.addDays(m.today("UTC"), -1);
  assertEq(r.items[0].intent.params.date, yesterdayISO, "first intent: junk 'yesterday' replaced with ISO");
  assertEq(r.items[1].intent.params.date, yesterdayISO, "second intent: junk 'yesterday' replaced with ISO");
  // Both must validate cleanly (not throw "Invalid date format").
  assertTrue(r.items[0].verdict.ok, "first verdict OK");
  assertTrue(r.items[1].verdict.ok, "second verdict OK");
});

test("[pipeline] auto-inject also overrides other malformed date attempts", async () => {
  const s = fullySetUp(500000);
  s.transactions[0].date = m.addDays(m.today("UTC"), -10);
  const malformed = ["yesterday", "last week", "May 6", "2026/05/06", ""];
  for (const bad of malformed) {
    const r = await processMessage(s,
      "yesterday i bought stuff for 5",
      [],
      {
        _debugUserId: "junk-date-loop",
        _aiCall: stub({
          mode: "do",
          message: "Adding.",
          intent: { kind: "record_spend", params: { amountCents: 500, note: "stuff", date: bad } },
        }),
      });
    const yesterdayISO = m.addDays(m.today("UTC"), -1);
    assertEq(r.intent.params.date, yesterdayISO, "junk date '" + bad + "' replaced with ISO");
  }
});

test("[pipeline] resolves 'N days ago' deterministically", async () => {
  const s = fullySetUp(500000);
  s.transactions[0].date = m.addDays(m.today("UTC"), -10);
  const r = await processMessage(s,
    "3 days ago i had a 50 dinner",
    [],
    {
      _debugUserId: "auto-inject-5",
      _aiCall: stub({
        mode: "do",
        message: "Adding.",
        intent: { kind: "record_spend", params: { amountCents: 5000, note: "dinner" } },
      }),
    });
  assertEq(r.intent.params.date, m.addDays(m.today("UTC"), -3));
});

// ── FABRICATED-NUMBER SCRUBBER (the trust-killer fix) ──
// User reported a screenshot: bot replied to "if I spend 200 how much
// is my daily rate?" with TWO conflicting numbers ($140.54 AI fiction
// + $131.69 bot truth) in the same reply. Root cause: AI prompt
// examples showed the AI writing fabricated projection numbers; the
// orchestrator then appended its own computed line. Two numbers, only
// one true. Tests below lock in the fix.
test("[pipeline] ask_simulate: strips AI's fabricated '$X/day' from message", async () => {
  const s = fullySetUp(500000);
  const r = await processMessage(s, "if i spend 200 how much is my daily rate?", [], {
    _aiCall: stub({
      mode: "ask_simulate",
      message: "You'd drop to $140.54/day after, still calm.",
      amountCents: 20000,
    }),
  });
  assertEq(r.kind, "decision");
  // The fabricated-number message MUST be stripped — bot's computed
  // simulate line is the real answer.
  assertEq(r.message, "", "AI's fictional message stripped (bot's computed line carries the truth)");
  assertTrue(!!r.simulate, "real simulate result attached");
});

test("[pipeline] ask_simulate: strips '$X less/day' phrasing", async () => {
  const s = fullySetUp(500000);
  const r = await processMessage(s, "can i afford 200 jacket?", [], {
    _aiCall: stub({
      mode: "ask_simulate",
      message: "Yes — $20 less/day after, still calm.",
      amountCents: 20000,
    }),
  });
  assertEq(r.message, "", "fabricated '$20 less/day' triggers strip");
});

test("[pipeline] ask_simulate: strips 'drop to $X' phrasing", async () => {
  const s = fullySetUp(500000);
  const r = await processMessage(s, "afford 100?", [], {
    _aiCall: stub({
      mode: "ask_simulate",
      message: "Sure — you'd drop to $150/day after.",
      amountCents: 10000,
    }),
  });
  assertEq(r.message, "");
});

test("[pipeline] ask_simulate: PASSES THROUGH clean messages without numbers", async () => {
  const s = fullySetUp(500000);
  const r = await processMessage(s, "can i afford 200?", [], {
    _aiCall: stub({
      mode: "ask_simulate",
      message: "Yes — manageable.",
      amountCents: 20000,
    }),
  });
  assertEq(r.message, "Yes — manageable.", "clean message preserved verbatim");
});

test("[pipeline] ask_simulate: clean Russian message preserved", async () => {
  const s = fullySetUp(500000);
  const r = await processMessage(s, "могу позволить 200?", [], {
    _aiCall: stub({
      mode: "ask_simulate",
      message: "Да — норм.",
      amountCents: 20000,
    }),
  });
  assertEq(r.message, "Да — норм.");
});

test("[pipeline] ask_simulate: strips Russian 'упадёт до $X/день' phrasing", async () => {
  const s = fullySetUp(500000);
  const r = await processMessage(s, "потяну 200?", [], {
    _aiCall: stub({
      mode: "ask_simulate",
      message: "Да — упадёт до $124/день, всё норм.",
      amountCents: 20000,
    }),
  });
  assertEq(r.message, "", "Russian fabricated number stripped");
});

test("[pipeline] do mode: AI numbers in confirm message NOT stripped (user-spoken amount is legitimate)", async () => {
  const s = fullySetUp(500000);
  const r = await processMessage(s, "spent 30 coffee", [], {
    _aiCall: stub({
      mode: "do",
      message: "Logging $30 coffee.",
      intent: { kind: "record_spend", params: { amountCents: 3000, note: "coffee" } },
    }),
  });
  // do mode is NOT scrubbed — AI echoing user's spoken amount is fine.
  assertEq(r.message, "Logging $30 coffee.");
});

// ── CLARIFY PATH (the ROOT FIX for buttons-on-questions) ─────────
// User reported: typing "i need to get 200 euro budget for friend to
// store - how much will that affect" → AI replied "reserving 200 euros
// for your friend - how long do you need it for?" wrapped in Log it /
// Skip buttons. The buttons were confusing because the user hadn't
// actually supplied enough info to confirm anything.
//
// ROOT FIX: validator returns { clarify } for missing required fields;
// pipeline forwards as kind:"clarify"; bot renders as plain text, NO
// BUTTONS. These tests lock the boundary in.

test("[clarify] add_bill without dueDate → kind:'clarify', NOT 'do'", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "200 budget for friend to store", [], {
    _aiCall: stub({
      mode: "do",
      message: "Reserving for friend.",
      intent: { kind: "add_bill", params: { name: "Friend", amountCents: 20000, recurrence: "once" } },
    }),
  });
  assertEq(r.kind, "clarify", "missing dueDate must surface as clarify, never 'do'");
  assertEq(r.field, "dueDate");
  assertEq(r.code, "clarifyBillDueDate");
  assertTrue(typeof r.message === "string" && r.message.length > 0, "clarify must carry a question");
});

test("[clarify] add_bill without name → kind:'clarify' code clarifyBillName", async () => {
  const s = fullySetUp();
  const futureDate = m.addDays(m.today("UTC"), 7);
  const r = await processMessage(s, "set aside 200 by friday", [], {
    _aiCall: stub({
      mode: "do",
      message: "Setting aside.",
      intent: { kind: "add_bill", params: { amountCents: 20000, dueDate: futureDate, recurrence: "once" } },
    }),
  });
  assertEq(r.kind, "clarify");
  assertEq(r.field, "name");
  assertEq(r.code, "clarifyBillName");
});

test("[clarify] add_bill without amount → kind:'clarify' code clarifyBillAmount", async () => {
  const s = fullySetUp();
  const futureDate = m.addDays(m.today("UTC"), 7);
  const r = await processMessage(s, "save for the trip by next friday", [], {
    _aiCall: stub({
      mode: "do",
      message: "Got it.",
      intent: { kind: "add_bill", params: { name: "Trip", dueDate: futureDate, recurrence: "once" } },
    }),
  });
  assertEq(r.kind, "clarify");
  assertEq(r.field, "amountCents");
  assertEq(r.code, "clarifyBillAmount");
});

test("[clarify] complete add_bill (name + amount + dueDate) → 'do', NOT clarify", async () => {
  const s = fullySetUp();
  const futureDate = m.addDays(m.today("UTC"), 7);
  const r = await processMessage(s, "reserve 200 for friend by friday", [], {
    _aiCall: stub({
      mode: "do",
      message: "Reserving for friend.",
      intent: { kind: "add_bill", params: { name: "Friend", amountCents: 20000, dueDate: futureDate, recurrence: "once" } },
    }),
  });
  assertEq(r.kind, "do", "complete intent must NOT trip clarify");
  assertEq(r.verdict.ok, true);
});

test("[clarify] hard reject (dup bill) returns 'do' with ok:false — NOT clarify", async () => {
  // Hard rejects (dup name, past date, etc.) stay on the 'do' path with
  // verdict.ok=false. Bot renders the reason as italic text. Clarify is
  // ONLY for missing required fields, not for structural failures.
  let s = fullySetUp();
  const futureDate = m.addDays(m.today("UTC"), 14);
  s = applyIntent(s, { kind: "add_bill", params: { name: "Rent", amountCents: 100000, dueDate: futureDate, recurrence: "monthly" } }).state;
  const r = await processMessage(s, "rent 1400 monthly", [], {
    _aiCall: stub({
      mode: "do",
      message: "Adding rent.",
      intent: { kind: "add_bill", params: { name: "Rent", amountCents: 140000, dueDate: futureDate, recurrence: "monthly" } },
    }),
  });
  assertEq(r.kind, "do", "dup-name is a hard reject, stays on 'do'");
  assertEq(r.verdict.ok, false);
  assertTrue(!r.verdict.clarify, "dup-name must NOT come back as clarify");
});

test("[clarify] localizes to Russian when state.language = 'ru'", async () => {
  let s = fullySetUp();
  s.language = "ru";
  const r = await processMessage(s, "отложить 200 для друга", [], {
    _aiCall: stub({
      mode: "do",
      message: "Откладываю.",
      intent: { kind: "add_bill", params: { name: "Друг", amountCents: 20000, recurrence: "once" } },
    }),
  });
  assertEq(r.kind, "clarify");
  assertTrue(/числу|числa|пятницу|когда/i.test(r.message), "Russian clarify question expected: " + r.message);
});

test("[clarify] do_batch with a clarify-needing intent → entire batch surfaces clarify", async () => {
  // If a brain-dump includes an add_bill missing dueDate alongside valid
  // intents, we cannot show a confirm card (one of the items is
  // incomplete). Surface the clarify so the user supplies the missing
  // piece — then on retry the whole batch resubmits.
  const s = fullySetUp();
  const r = await processMessage(s, "spent 20 on coffee + set aside 200 for friend", [], {
    _aiCall: stub({
      mode: "do",
      message: "Got it.",
      intents: [
        { kind: "record_spend", params: { amountCents: 2000, note: "coffee" } },
        { kind: "add_bill", params: { name: "Friend", amountCents: 20000, recurrence: "once" } }, // missing dueDate
      ],
    }),
  });
  assertEq(r.kind, "clarify");
  assertEq(r.field, "dueDate");
});

test("[clarify] do_batch with all-complete intents → 'do_batch' (not clarify)", async () => {
  const s = fullySetUp();
  const futureDate = m.addDays(m.today("UTC"), 7);
  const r = await processMessage(s, "spent 20 coffee + reserve 200 for friend by friday", [], {
    _aiCall: stub({
      mode: "do",
      message: "Got both.",
      intents: [
        { kind: "record_spend", params: { amountCents: 2000, note: "coffee" } },
        { kind: "add_bill", params: { name: "Friend", amountCents: 20000, dueDate: futureDate, recurrence: "once" } },
      ],
    }),
  });
  assertEq(r.kind, "do_batch");
  assertEq(r.items.length, 2);
  assertTrue(r.items.every(i => i.verdict.ok), "all items should pass when complete");
});

// ── VALIDATOR CLARIFY SHAPE (unit-level) ────────────────────────
// Even without the pipeline, validator's three-state output is the
// architectural primitive. These lock in the shape.

const { validateIntent } = require("../validator");

test("[validator-clarify] add_bill missing name → clarify shape", () => {
  const s = fullySetUp();
  const v = validateIntent(s, { kind: "add_bill", params: { amountCents: 5000, dueDate: m.addDays(m.today("UTC"), 7), recurrence: "once" } }, m.today("UTC"));
  assertEq(v.ok, false);
  assertTrue(!!v.clarify, "must be a clarify, not a hard reject");
  assertEq(v.clarify.code, "clarifyBillName");
  assertEq(v.clarify.field, "name");
});

test("[validator-clarify] add_bill missing amount → clarify shape", () => {
  const s = fullySetUp();
  const v = validateIntent(s, { kind: "add_bill", params: { name: "Friend", dueDate: m.addDays(m.today("UTC"), 7), recurrence: "once" } }, m.today("UTC"));
  assertEq(v.ok, false);
  assertEq(v.clarify.code, "clarifyBillAmount");
});

test("[validator-clarify] add_bill missing dueDate → clarify shape (THE USER-REPORTED BUG)", () => {
  const s = fullySetUp();
  const v = validateIntent(s, { kind: "add_bill", params: { name: "Friend", amountCents: 20000, recurrence: "once" } }, m.today("UTC"));
  assertEq(v.ok, false);
  assertEq(v.clarify.code, "clarifyBillDueDate");
  assertEq(v.clarify.field, "dueDate");
});

test("[validator-clarify] add_bill complete → ok:true, no clarify", () => {
  const s = fullySetUp();
  const v = validateIntent(s, {
    kind: "add_bill",
    params: { name: "Friend", amountCents: 20000, dueDate: m.addDays(m.today("UTC"), 7), recurrence: "once" },
  }, m.today("UTC"));
  assertEq(v.ok, true);
  assertTrue(!v.clarify);
});

test("[validator-clarify] add_bill past date → hard reject (reason), NOT clarify", () => {
  // Past dates are structural — the user CAN'T fix this by supplying a
  // missing field; the field they DID supply is wrong. Hard reject.
  const s = fullySetUp();
  const v = validateIntent(s,
    { kind: "add_bill", params: { name: "Friend", amountCents: 20000, dueDate: "2020-01-01", recurrence: "once" } },
    m.today("UTC")
  );
  assertEq(v.ok, false);
  assertTrue(!!v.reason, "past date is a hard reject with reason");
  assertTrue(!v.clarify, "past date is NOT a clarify");
});

test("[validator-clarify] add_bill dup name → hard reject (reason), NOT clarify", () => {
  let s = fullySetUp();
  const futureDate = m.addDays(m.today("UTC"), 14);
  s = applyIntent(s, { kind: "add_bill", params: { name: "Rent", amountCents: 100000, dueDate: futureDate, recurrence: "monthly" } }).state;
  const v = validateIntent(s,
    { kind: "add_bill", params: { name: "rent", amountCents: 100000, dueDate: futureDate, recurrence: "monthly" } },
    m.today("UTC")
  );
  assertEq(v.ok, false);
  assertTrue(!!v.reason);
  assertTrue(!v.clarify);
});
