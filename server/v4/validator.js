"use strict";
// v4/validator.js — deterministic verdicts on parsed intents.
// This is the trust boundary between AI (untrusted) and engine (trusted).
//
// Returns { ok, severity, code, context, reason }.
//   severity: "auto"    → engine may apply without explicit user confirm
//             "confirm" → engine MUST get explicit user yes before applying
//             "reject"  → engine MUST refuse; show reason to user
//
// CRITICAL: rejection messages are NEVER hardcoded here. We emit a
// machine-readable `code` (e.g. "alreadySetup", "envBillNeedsRecurrence")
// plus a `context` object. The bot's render layer translates the code
// to a conversational, locale-aware sentence via t("v." + code, lang, ctx).
// This is the structural seam between engineering rules and user voice.

const m = require("./model");
const currency = require("./currency");
const { t } = require("./locales");

function _verdict(severity, ok, code, context) {
  const ctx = context || {};
  const v = { ok, severity, code, context: ctx };
  // Cheap English fallback for tests / logs / AI conversation history.
  v.reason = t("v." + code, "en", ctx);
  return v;
}
const reject = (code, ctx) => _verdict("reject", false, code, ctx);
const confirm = (code, ctx) => _verdict("confirm", true, code, ctx);
const auto = (code, ctx) => _verdict("auto", true, code, ctx);

// If the intent specifies originalAmountCents + originalCurrency in a
// non-base currency, convert to base BEFORE the validator does sanity
// checks. Mutates intent.params in place to add amountCents (base-currency).
function ensureBaseAmount(state, intent) {
  if (!intent || !intent.params) return;
  const p = intent.params;
  if (typeof p.originalAmountCents !== "number") return;
  if (!p.originalCurrency) return;
  const baseCode = (state && state.currency) || "USD";
  const fromCode = String(p.originalCurrency).toUpperCase();
  if (typeof p.amountCents !== "number" || !Number.isFinite(p.amountCents)) {
    p.amountCents = currency.convertSync(p.originalAmountCents, fromCode, baseCode);
  }
}

const MAX_SANE_BALANCE_CENTS = 100_000_000_00;
const HALF_BALANCE_FACTOR = 0.5;
const TEN_X_FACTOR = 10;
const MAX_INTENTS_PER_TURN = 5;

const MONTHLY_BILL_NAMES = /\b(rent|mortgage|insurance|phone|mobile|cell|internet|wifi|broadband|cable|electric|electricity|water|gas|utilit|subscription|netflix|spotify|hulu|disney|prime|youtube|gym|membership|tuition|loan|car payment|childcare|daycare|hoa)\b/i;

function isFiniteNumber(v) { return typeof v === "number" && Number.isFinite(v); }
function isPositiveCents(v) { return isFiniteNumber(v) && v > 0; }

function validateIntent(state, intent, todayStr) {
  if (!intent || typeof intent.kind !== "string") return reject("invalidIntentShape");
  ensureBaseAmount(state, intent);
  const today = todayStr || m.today(state.timezone || "UTC");
  const p = intent.params || {};
  const sym = (state && state.currencySymbol) || "$";
  const M = (c) => m.toMoney(c, sym);

  switch (intent.kind) {
    case "setup_account": {
      if (state.setup) return reject("alreadySetup");
      if (!isFiniteNumber(p.balanceCents)) return reject("balanceRequired");
      if (p.balanceCents <= 0) return reject("balanceNonPositive");
      if (p.balanceCents > MAX_SANE_BALANCE_CENTS) return reject("balanceUnreasonable");
      if (p.payday) {
        const d = m.normalizeDate(p.payday);
        if (!d) return reject("paydayInvalid");
        const diff = m.daysBetween(today, d);
        if (diff < 0) return confirm("confirmSetupPaydayPast");
        if (diff > 60) return confirm("confirmSetupPaydayFar");
      }
      if (p.payFrequency && !m.PAY_FREQS.includes(p.payFrequency)) {
        return reject("payFreqInvalid");
      }
      return confirm("confirmSetup");
    }

    case "adjust_balance": {
      if (!isFiniteNumber(p.newBalanceCents)) return reject("adjustBalanceRequired");
      if (p.newBalanceCents > MAX_SANE_BALANCE_CENTS) return reject("balanceUnreasonable");
      const delta = p.newBalanceCents - state.balanceCents;
      const absDelta = Math.abs(delta);
      const big = absDelta > Math.max(state.balanceCents, 0) * HALF_BALANCE_FACTOR + 5_000_00;
      return confirm(big ? "confirmAdjustBalanceBig" : "confirmAdjustBalance");
    }

    case "add_envelope": {
      if (!state.setup) return reject("envNeedSetup");
      if (!p.name || typeof p.name !== "string") return reject("envNeedName");
      if (!m.ENVELOPE_KINDS.includes(p.kind)) return reject("envInvalidKind");
      if (!isPositiveCents(p.amountCents)) return reject("envAmountRequired");
      if (p.amountCents > MAX_SANE_BALANCE_CENTS) return reject("envAmountUnreasonable");
      const key = m.ekey(p.name);
      const existing = state.envelopes[key];
      if (existing && existing.active) {
        return reject("envDuplicate", {
          name: existing.name,
          amount: M(existing.amountCents),
        });
      }
      if (state.balanceCents > 0 && p.amountCents > state.balanceCents * TEN_X_FACTOR) {
        return confirm("confirmAddOverBalance");
      }
      if (p.dueDate) {
        const d = m.normalizeDate(p.dueDate);
        if (!d) return reject("envDateInvalid");
        const diff = m.daysBetween(today, d);
        if (p.kind === "bill" && diff < 0) return reject("envDatePastForBill");
        if (diff > 730) return reject("envDateTooFar");
      }
      if (p.recurrence && !m.RECURRENCES.includes(p.recurrence)) {
        return reject("envInvalidRecurrence");
      }
      if (p.kind === "bill" && MONTHLY_BILL_NAMES.test(p.name)) {
        const rec = p.recurrence || "once";
        if (rec === "once") return reject("envBillNeedsRecurrence", { name: p.name });
      }
      if (p.kind === "bill") return confirm("confirmAddBill");
      if (p.kind === "budget") return confirm("confirmAddBudget");
      if (p.kind === "goal") return confirm("confirmAddGoal");
      return confirm("confirmAddBill");
    }

    case "update_envelope": {
      const key = m.ekey(p.key || p.name);
      if (!state.envelopes[key]) return reject("envNotFound");
      if (p.amountCents !== undefined && !isFiniteNumber(p.amountCents)) return reject("updateAmountInvalid");
      if (p.amountCents !== undefined && p.amountCents < 0) return reject("updateAmountNegative");
      if (p.dueDate) {
        const d = m.normalizeDate(p.dueDate);
        if (!d) return reject("envDateInvalid");
        const diff = m.daysBetween(today, d);
        if (diff < -14) return reject("envDatePastForBill");
        if (diff > 730) return reject("envDateTooFar");
      }
      return confirm("confirmUpdateEnv");
    }

    case "remove_envelope": {
      const key = m.ekey(p.key || p.name);
      if (!state.envelopes[key]) return reject("envNotFound");
      return confirm("confirmRemove");
    }

    case "record_spend": {
      if (!isFiniteNumber(p.amountCents)) return reject("spendAmountRequired");
      if (p.amountCents === 0) return reject("spendAmountZero");
      const abs = Math.abs(p.amountCents);
      if (abs > MAX_SANE_BALANCE_CENTS) return reject("spendAmountUnreasonable");
      if (p.envelopeKey) {
        const k = m.ekey(p.envelopeKey);
        if (!state.envelopes[k]) return reject("spendEnvelopeNotFound", { key: p.envelopeKey });
      }
      if (!state.setup) return reject("spendNotSetUp");
      if (abs > state.balanceCents && state.balanceCents >= 0) return confirm("spendOverBalance");
      if (state.balanceCents > 0 && abs > state.balanceCents * HALF_BALANCE_FACTOR) return confirm("spendOverHalfBalance");
      return confirm("confirmSpend");
    }

    case "simulate_spend": {
      if (!state.setup) return reject("simulateNotSetUp");
      if (!isPositiveCents(p.amountCents)) return reject("simulateAmountRequired");
      if (p.amountCents > MAX_SANE_BALANCE_CENTS) return reject("envAmountUnreasonable");
      if (p.envelopeKey && !state.envelopes[m.ekey(p.envelopeKey)]) return reject("envNotFound");
      return auto("autoSimulated");
    }

    case "undo_last": {
      if (!state.setup) return reject("undoNeedsSetup");
      if (!Array.isArray(state.events) || state.events.length <= 1) return reject("nothingToUndo");
      const last = state.events[state.events.length - 1];
      if (last && last.intent && last.intent.kind === "setup_account") return reject("cantUndoSetup");
      return auto("autoUndo");
    }

    case "record_income": {
      if (!isPositiveCents(p.amountCents)) return reject("incomeAmountRequiredPositive");
      if (p.amountCents > MAX_SANE_BALANCE_CENTS) return reject("incomeAmountUnreasonable");
      if (p.nextPayday) {
        const d = m.normalizeDate(p.nextPayday);
        if (!d) return reject("incomeInvalidNextPayday");
      }
      return confirm("confirmIncome");
    }

    case "fund_envelope": {
      const key = m.ekey(p.envelopeKey || p.name);
      const env = state.envelopes[key];
      if (!env) return reject("fundEnvNotFound");
      if (!env.active) return reject("fundEnvInactive");
      if (!isPositiveCents(p.amountCents)) return reject("fundAmountRequired");
      if (p.amountCents > MAX_SANE_BALANCE_CENTS) return reject("fundAmountUnreasonable");
      if (state.balanceCents > 0 && p.amountCents > state.balanceCents) return confirm("fundOverBalance");
      return confirm("confirmFund", { amount: M(p.amountCents), name: env.name });
    }

    case "pay_bill": {
      const key = m.ekey(p.envelopeKey || p.name);
      const env = state.envelopes[key];
      if (!env) return reject("billNotFound");
      if (env.kind !== "bill") return reject("notABill");
      if (!env.active) return reject("billInactive");
      if (p.amountCents !== undefined && !isPositiveCents(p.amountCents)) return reject("billAmountInvalid");
      return confirm("confirmPayBill", { name: env.name });
    }

    case "skip_bill": {
      const key = m.ekey(p.envelopeKey || p.name);
      const env = state.envelopes[key];
      if (!env) return reject("billNotFound");
      if (!env.dueDate) return reject("skipBillNoDate");
      return confirm("confirmSkipBill", { name: env.name });
    }

    case "delete_transaction": {
      if (!p.txId) return reject("txIdMissing");
      const tx = state.transactions.find((t) => t.id === p.txId);
      if (!tx) return reject("txNotFound");
      if (tx.kind === "setup") return reject("cantDeleteSetup");
      return confirm("confirmDeleteTx");
    }

    case "edit_transaction": {
      if (!p.txId) return reject("txIdMissing");
      const tx = state.transactions.find((t) => t.id === p.txId);
      if (!tx) return reject("txNotFound");
      if (!["spend", "refund", "bill_payment"].includes(tx.kind)) return reject("onlyEditableSpend");
      if (p.newAmountCents !== undefined && !isFiniteNumber(p.newAmountCents)) return reject("txAmountInvalid");
      return confirm("confirmEditTx");
    }

    case "update_settings": {
      const ok = ["timezone", "currency", "currencySymbol", "language", "payFrequency", "payday", "voiceReplies"]
        .some((k) => p[k] !== undefined);
      if (!ok) return reject("settingsNothingToUpdate");
      if (p.payFrequency && !m.PAY_FREQS.includes(p.payFrequency)) return reject("payFreqInvalid");
      if (p.payday) {
        const d = m.normalizeDate(p.payday);
        if (!d) return reject("paydayInvalid");
      }
      return confirm("confirmUpdateSettings");
    }

    case "reset": {
      return confirm("confirmReset");
    }

    default:
      return reject("unknownKind", { kind: intent.kind });
  }
}

function validateBatch(state, intents, todayStr) {
  if (!Array.isArray(intents)) return [reject("batchNotArray")];
  if (intents.length === 0) return [];
  if (intents.length > MAX_INTENTS_PER_TURN) return [reject("batchTooMany")];
  return intents.map((i) => validateIntent(state, i, todayStr));
}

module.exports = { validateIntent, validateBatch };
