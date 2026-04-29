"use strict";
// Structural test for the validator → bot decoupling.
// Every verdict has a `code` (machine-readable) + `context`. The bot
// renders user-facing text via t("v." + code, lang, context). This test
// proves: (1) every verdict uses the new shape, (2) every code has a
// locale entry in en + ru, (3) no rendered message leaks schema vocab.

const m = require("../model");
const { applyIntent } = require("../engine");
const { validateIntent, validateBatch } = require("../validator");
const en = require("../locales/en");
const ru = require("../locales/ru");

function freshSetup() {
  let s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 5_000_00, payday: m.addDays(m.today("UTC"), 30), payFrequency: "monthly" },
  }).state;
}

// ── DECOUPLE STRUCTURE ─────────────────────────────
test("[DECOUPLE] every verdict has a `code` field (machine-readable)", () => {
  const fresh = m.createFreshState();
  const setup = freshSetup();
  // Sample a representative spread of intents
  const samples = [
    { state: fresh, intent: { kind: "setup_account", params: { balanceCents: 5000_00 } } },
    { state: fresh, intent: { kind: "setup_account", params: { balanceCents: -100 } } },
    { state: fresh, intent: { kind: "wat", params: {} } },
    { state: setup, intent: { kind: "setup_account", params: { balanceCents: 5000_00 } } },
    { state: setup, intent: { kind: "record_spend", params: { amountCents: 50_00 } } },
    { state: setup, intent: { kind: "record_spend", params: { amountCents: 0 } } },
    { state: setup, intent: { kind: "add_envelope", params: { name: "Rent", kind: "bill", amountCents: 1400_00, dueDate: m.addDays(m.today("UTC"), 30) } } },
    { state: setup, intent: { kind: "pay_bill", params: { name: "Ghost" } } },
    { state: setup, intent: { kind: "fund_envelope", params: { name: "Ghost", amountCents: 100 } } },
  ];
  for (const { state, intent } of samples) {
    const v = validateIntent(state, intent);
    assertTrue(typeof v.code === "string" && v.code.length > 0,
      "verdict missing code for intent " + intent.kind + ": " + JSON.stringify(v));
    assertTrue(typeof v.context === "object", "verdict missing context");
  }
});

// ── LOCALE COVERAGE ────────────────────────────────
test("[DECOUPLE] every verdict code emitted has a locale entry in en + ru", () => {
  // Walk every reject/confirm/auto in the validator by exercising every
  // code path. Then check both locales contain a matching v.* key.
  const fresh = m.createFreshState();
  const setup = freshSetup();
  const codes = new Set();

  function record(verdict) { if (verdict && verdict.code) codes.add(verdict.code); }

  // Comprehensive code coverage exerciser
  record(validateIntent(fresh, null));
  record(validateIntent(fresh, { kind: "setup_account", params: {} }));
  record(validateIntent(fresh, { kind: "setup_account", params: { balanceCents: -1 } }));
  record(validateIntent(fresh, { kind: "setup_account", params: { balanceCents: 999_999_999_999_99 } }));
  record(validateIntent(fresh, { kind: "setup_account", params: { balanceCents: 5000_00, payday: "not-a-date" } }));
  record(validateIntent(fresh, { kind: "setup_account", params: { balanceCents: 5000_00, payFrequency: "garbage" } }));
  record(validateIntent(fresh, { kind: "setup_account", params: { balanceCents: 5000_00 } }));
  record(validateIntent(fresh, { kind: "setup_account", params: { balanceCents: 5000_00, payday: "2020-01-01" } }));
  record(validateIntent(fresh, { kind: "setup_account", params: { balanceCents: 5000_00, payday: m.addDays(m.today("UTC"), 90) } }));
  record(validateIntent(setup, { kind: "setup_account", params: { balanceCents: 5000_00 } }));
  record(validateIntent(setup, { kind: "adjust_balance", params: {} }));
  record(validateIntent(setup, { kind: "adjust_balance", params: { newBalanceCents: 4000_00 } }));
  record(validateIntent(setup, { kind: "adjust_balance", params: { newBalanceCents: 100_000_00 } }));
  record(validateIntent(fresh, { kind: "add_envelope", params: { name: "X", kind: "bill", amountCents: 100 } }));
  record(validateIntent(setup, { kind: "add_envelope", params: { kind: "bill", amountCents: 100 } }));
  record(validateIntent(setup, { kind: "add_envelope", params: { name: "X", kind: "bogus", amountCents: 100 } }));
  record(validateIntent(setup, { kind: "add_envelope", params: { name: "X", kind: "bill" } }));
  record(validateIntent(setup, { kind: "add_envelope", params: { name: "X", kind: "bill", amountCents: 100, dueDate: "garbage" } }));
  record(validateIntent(setup, { kind: "add_envelope", params: { name: "X", kind: "bill", amountCents: 100, dueDate: m.addDays(m.today("UTC"), 30), recurrence: "weird" } }));
  record(validateIntent(setup, { kind: "add_envelope", params: { name: "Rent", kind: "bill", amountCents: 1400_00, dueDate: m.addDays(m.today("UTC"), 30) } }));
  record(validateIntent(setup, { kind: "add_envelope", params: { name: "X", kind: "bill", amountCents: 1, dueDate: m.addDays(m.today("UTC"), 30), recurrence: "monthly" } }));
  record(validateIntent(setup, { kind: "add_envelope", params: { name: "Y", kind: "budget", amountCents: 100_00 } }));
  record(validateIntent(setup, { kind: "add_envelope", params: { name: "Z", kind: "goal", amountCents: 100_00 } }));
  record(validateIntent(setup, { kind: "update_envelope", params: { name: "ghost" } }));
  record(validateIntent(setup, { kind: "remove_envelope", params: { name: "ghost" } }));
  record(validateIntent(setup, { kind: "record_spend", params: {} }));
  record(validateIntent(setup, { kind: "record_spend", params: { amountCents: 0 } }));
  record(validateIntent(setup, { kind: "record_spend", params: { amountCents: 999_999_999_999_99 } }));
  record(validateIntent(setup, { kind: "record_spend", params: { amountCents: 50_00, envelopeKey: "ghost" } }));
  record(validateIntent(fresh, { kind: "record_spend", params: { amountCents: 50_00 } }));
  record(validateIntent(setup, { kind: "record_spend", params: { amountCents: 6000_00 } }));
  record(validateIntent(setup, { kind: "record_spend", params: { amountCents: 4000_00 } }));
  record(validateIntent(setup, { kind: "record_spend", params: { amountCents: 50_00 } }));
  record(validateIntent(fresh, { kind: "simulate_spend", params: { amountCents: 100 } }));
  record(validateIntent(setup, { kind: "simulate_spend", params: { amountCents: 100 } }));
  record(validateIntent(fresh, { kind: "undo_last", params: {} }));
  record(validateIntent(setup, { kind: "undo_last", params: {} }));
  record(validateIntent(setup, { kind: "record_income", params: {} }));
  record(validateIntent(setup, { kind: "record_income", params: { amountCents: 999_999_999_999_99 } }));
  record(validateIntent(setup, { kind: "record_income", params: { amountCents: 1000_00 } }));
  record(validateIntent(setup, { kind: "record_income", params: { amountCents: 1000_00, nextPayday: "garbage" } }));
  record(validateIntent(setup, { kind: "fund_envelope", params: { name: "ghost", amountCents: 100 } }));
  record(validateIntent(setup, { kind: "pay_bill", params: { name: "ghost" } }));
  record(validateIntent(setup, { kind: "skip_bill", params: { name: "ghost" } }));
  record(validateIntent(setup, { kind: "delete_transaction", params: {} }));
  record(validateIntent(setup, { kind: "delete_transaction", params: { txId: "ghost" } }));
  record(validateIntent(setup, { kind: "edit_transaction", params: { txId: "ghost" } }));
  record(validateIntent(setup, { kind: "update_settings", params: {} }));
  record(validateIntent(setup, { kind: "update_settings", params: { language: "ru" } }));
  record(validateIntent(setup, { kind: "reset", params: {} }));
  record(validateIntent(setup, { kind: "wat", params: {} }));
  record(validateBatch(setup, Array(99).fill({ kind: "record_spend", params: { amountCents: 100 } }))[0]);
  record(validateBatch(setup, "not-an-array")[0]);

  for (const code of codes) {
    const enKey = "v." + code;
    assertTrue(enKey in en, "en missing locale key: " + enKey);
    assertTrue(enKey in ru, "ru missing locale key: " + enKey);
  }
});

// ── NO SCHEMA LEAKS in localized text ──────────────
test("[DECOUPLE] rendered verdict text never leaks schema words", () => {
  // Walk every v.* key in en. Assert no internal vocabulary appears in
  // the user-facing strings.
  const banned = [
    "amountCents", "originalAmountCents", "envelopeKey", "intent shape",
    "update_settings", "record_spend", "setup_account", "fund_envelope",
    "add_envelope", "pay_bill", "skip_bill", "edit_transaction",
    "delete_transaction", "record_income", "simulate_spend", "undo_last",
    "record_spend",
  ];
  for (const [key, val] of Object.entries(en)) {
    if (!key.startsWith("v.")) continue;
    for (const bad of banned) {
      assertTrue(!val.includes(bad),
        "Schema word '" + bad + "' leaked in en[" + key + "]: " + val);
    }
  }
});

// ── RESET-WORD HYGIENE ─────────────────────────────
test("[DECOUPLE] casual error/help copy does not mention 'reset' or 'wipe'", () => {
  // 'reset' should ONLY appear when the user explicitly asked. Most
  // verdicts shouldn't tell users to type 'reset'.
  const allowToMentionReset = new Set([
    "v.cantUndoSetup",     // explicit hint about how to nuke
    "v.cantDeleteSetup",   // same
    "v.confirmReset",      // the reset confirm itself
  ]);
  for (const [key, val] of Object.entries(en)) {
    if (!key.startsWith("v.")) continue;
    if (allowToMentionReset.has(key)) continue;
    assertTrue(!/\breset\b/i.test(val),
      "Surprise 'reset' mention in en[" + key + "]: " + val);
    assertTrue(!/\bwipe\b/i.test(val),
      "Surprise 'wipe' mention in en[" + key + "]: " + val);
  }
});

// ── CONTEXT INTERPOLATION ──────────────────────────
test("[DECOUPLE] envDuplicate verdict carries name + amount in context", () => {
  let s = freshSetup();
  s = applyIntent(s, { kind: "add_envelope", params: { name: "Vietnam Hotel", kind: "goal", amountCents: 1000_00 } }).state;
  const v = validateIntent(s, { kind: "add_envelope", params: { name: "Vietnam Hotel", kind: "goal", amountCents: 700_00 } });
  assertEq(v.code, "envDuplicate");
  assertEq(v.context.name, "Vietnam Hotel");
  assertTrue(typeof v.context.amount === "string");
  // Rendered en text contains the name
  assertTrue(/Vietnam Hotel/.test(v.reason));
});
