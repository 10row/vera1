"use strict";
// ─────────────────────────────────────────────────────────────────────
// AI ENVELOPE COERCION — mode-as-kind defense
//
// gpt-4o-mini occasionally collapses the response envelope and emits:
//     { mode: "record_spend", params: {...} }
// instead of the canonical:
//     { mode: "do", intent: { kind: "record_spend", params: {...} } }
//
// Without defense, this falls through to the "Hmm, didn't catch that"
// fallback and the user's spend is lost. We coerce the broken shape
// into the canonical one, log a warning, and let the rest of the
// pipeline run normally.
//
// Bug-report 0006-mode-as-kind.
// ─────────────────────────────────────────────────────────────────────
const m = require("../model");
const { applyIntent } = require("../engine");
const { processMessage } = require("../pipeline");

const stub = (resp) => async () => typeof resp === "string" ? resp : JSON.stringify(resp);

function fullySetUp(balance) {
  let s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance || 500000, payday: "2026-06-15", payFrequency: "monthly" },
  }).state;
}

// ── Canonical case: legitimate {mode:"do", intent:{...}} still works ──
test("[ai-coerce] canonical {mode:'do', intent:{...}} still works", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "spent 20 on coffee", [], {
    _aiCall: stub({
      mode: "do",
      message: "Logging coffee.",
      intent: { kind: "record_spend", params: { amountCents: 2000, note: "coffee" } },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "record_spend");
  assertEq(r.intent.params.amountCents, 2000);
});

// ── THE BUG: mode-as-kind for record_spend ──
test("[ai-coerce] mode='record_spend' → coerced to do/record_spend", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "spent 20 on coffee", [], {
    _aiCall: stub({
      mode: "record_spend",
      params: { amountCents: 2000, note: "coffee" },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "record_spend");
  assertEq(r.intent.params.amountCents, 2000);
  assertEq(r.intent.params.note, "coffee");
});

// ── Foreign currency variant (the exact user-reported case) ──
test("[ai-coerce] mode='record_spend' with foreign-currency params → coerced + converted", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "i just got a coffee and breakfast at plantiful 760thb", [], {
    _aiCall: stub({
      mode: "record_spend",
      params: {
        amountCents: 0,
        originalAmount: 760,
        originalCurrency: "THB",
        note: "coffee and breakfast at Plantiful",
        category: "food",
        vendor: "Plantiful",
      },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "record_spend");
  // After pipeline conversion, amountCents should be > 0 (THB → base ccy).
  assertTrue(r.intent.params.amountCents > 0, "amountCents should be converted from 760 THB");
  assertEq(r.intent.params.originalAmount, 760);
  assertEq(r.intent.params.originalCurrency, "THB");
});

// ── Same flub on add_bill ──
test("[ai-coerce] mode='add_bill' → coerced to do/add_bill", async () => {
  const s = fullySetUp();
  const futureDate = m.addDays(m.today("UTC"), 14);
  const r = await processMessage(s, "rent 1400 on the 1st", [], {
    _aiCall: stub({
      mode: "add_bill",
      params: { name: "Rent", amountCents: 140000, dueDate: futureDate, recurrence: "monthly" },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "add_bill");
  assertEq(r.intent.params.name, "Rent");
});

// ── Same flub on adjust_balance ──
test("[ai-coerce] mode='adjust_balance' → coerced to do/adjust_balance", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "actually I have 600", [], {
    _aiCall: stub({
      mode: "adjust_balance",
      params: { balanceCents: 60000 },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "adjust_balance");
  assertEq(r.intent.params.balanceCents, 60000);
});

// ── Same flub on record_income ──
test("[ai-coerce] mode='record_income' → coerced to do/record_income", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "got 3000 paycheck", [], {
    _aiCall: stub({
      mode: "record_income",
      params: { amountCents: 300000, note: "paycheck" },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "record_income");
  assertEq(r.intent.params.amountCents, 300000);
});

// ── Coercion ALSO lifts top-level fields when params:{} missing ──
// This is double defense: mode-as-kind AND dropped-params-wrapper.
test("[ai-coerce] mode='record_spend' with NO params wrapper → fields lifted into params", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "spent 15 on lunch", [], {
    _aiCall: stub({
      mode: "record_spend",
      amountCents: 1500,
      note: "lunch",
      category: "food",
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "record_spend");
  assertEq(r.intent.params.amountCents, 1500);
  assertEq(r.intent.params.note, "lunch");
  assertEq(r.intent.params.category, "food");
});

// ── Allow-list: a non-intent mode value falls through to talk ──
test("[ai-coerce] mode='fancy_dance' (not an intent kind) → falls through to talk fallback", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "lol", [], {
    _aiCall: stub({
      mode: "fancy_dance",
      params: { thing: 1 },
    }),
  });
  // Should NOT have been coerced — falls through to talk fallback.
  assertEq(r.kind, "talk");
  // Fallback copy mentions "spent" example (not "delete the cat").
  assertTrue(/spent.*coffee/i.test(r.message), "fallback copy must include example");
  assertTrue(!/delete the cat/i.test(r.message), "fallback copy must NOT include 'delete the cat'");
});

// ── Conflict avoidance: when both mode-as-kind AND intent exist, prefer intent ──
test("[ai-coerce] mode='record_spend' WITH parsed.intent present → coercion skipped (intent wins)", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "spent 20 on coffee", [], {
    _aiCall: stub({
      mode: "record_spend",
      // confusing — also has intent
      intent: { kind: "record_spend", params: { amountCents: 2000, note: "coffee" } },
    }),
  });
  // Coercion path skipped because parsed.intent exists. But because mode
  // isn't "do", the parser still won't extract the intent the normal way.
  // Result: fall through to talk fallback. That's the safe answer — when
  // the AI is internally inconsistent, don't guess.
  assertEq(r.kind, "talk");
});

// ── Setup-account coercion is safe: validator rejects on already-setup ──
test("[ai-coerce] mode='setup_account' on already-setup user → coerced but validator rejects", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "set me up", [], {
    _aiCall: stub({
      mode: "setup_account",
      params: { balanceCents: 999999 },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "setup_account");
  assertEq(r.verdict.ok, false);
  assertTrue(/already set up/i.test(r.verdict.reason));
});

// ── Fallback copy update: "delete the cat" is GONE ──
test("[ai-coerce] talk fallback copy uses sensible examples", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "asdfghjkl", [], {
    _aiCall: stub({ mode: "weird", garbage: true }),
  });
  assertEq(r.kind, "talk");
  assertTrue(!/delete the cat/i.test(r.message), "'delete the cat' must be replaced");
  assertTrue(!/удали кошку/i.test(r.message), "RU 'удали кошку' must be replaced");
});

// ── Variant fix: bare mode-as-kind without ANY other fields ──
test("[ai-coerce] mode='record_spend' alone with no params/message → coerced with empty params", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "x", [], {
    _aiCall: stub({ mode: "record_spend" }),
  });
  // Coerced, but validator should reject (no amountCents).
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "record_spend");
  assertEq(r.verdict.ok, false);
});
