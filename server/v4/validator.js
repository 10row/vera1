"use strict";
// v4/validator.js — deterministic verdicts on parsed intents.
// This is the trust boundary between AI (untrusted) and engine (trusted).
// Returns { ok, severity, reason, hint? }.
//   severity: "auto"    → engine may apply without explicit user confirm
//             "confirm" → engine MUST get explicit user yes before applying
//             "reject"  → engine MUST refuse; show reason to user
//
// Rules are intentionally strict and small. Add a rule, don't bend one.

const m = require("./model");

const reject = (reason, hint) => ({ ok: false, severity: "reject", reason, hint });
const confirm = (reason, hint) => ({ ok: true, severity: "confirm", reason, hint });
const auto = (reason) => ({ ok: true, severity: "auto", reason });

const MAX_SANE_BALANCE_CENTS = 100_000_000_00; // $100M sanity cap
const AUTO_SPEND_LIMIT_CENTS = 50_00;          // <$50 auto-applies (with Undo)
const HALF_BALANCE_FACTOR = 0.5;                // spend > 50% of balance = confirm
const TEN_X_FACTOR = 10;                        // envelope amount > 10x balance = confirm

function isFiniteNumber(v) { return typeof v === "number" && Number.isFinite(v); }
function isPositiveCents(v) { return isFiniteNumber(v) && v > 0; }

function validateIntent(state, intent, todayStr) {
  if (!intent || typeof intent.kind !== "string") {
    return reject("Invalid intent shape");
  }
  const today = todayStr || m.today(state.timezone || "UTC");
  const p = intent.params || {};

  switch (intent.kind) {
    case "setup_account": {
      if (!isFiniteNumber(p.balanceCents)) return reject("Need a starting balance");
      if (p.balanceCents <= 0) return reject("Starting balance must be greater than zero");
      if (p.balanceCents > MAX_SANE_BALANCE_CENTS) return reject("That balance seems off — sanity check?");
      if (p.payday) {
        const d = m.normalizeDate(p.payday);
        if (!d) return reject("Couldn't parse the payday");
        const diff = m.daysBetween(today, d);
        if (diff < 0) return confirm("Payday is in the past — confirm?");
        if (diff > 60) return confirm("Payday is more than 60 days out — confirm?");
      }
      if (p.payFrequency && !m.PAY_FREQS.includes(p.payFrequency)) {
        return reject("Pay frequency must be weekly, biweekly, monthly, or irregular");
      }
      if (state.setup) return confirm("You're already set up — overwrite?");
      return confirm("Set up your account?");
    }

    case "adjust_balance": {
      if (!isFiniteNumber(p.newBalanceCents)) return reject("Need a balance amount");
      if (p.newBalanceCents > MAX_SANE_BALANCE_CENTS) return reject("That balance seems off");
      const delta = p.newBalanceCents - state.balanceCents;
      const absDelta = Math.abs(delta);
      const big = absDelta > Math.max(state.balanceCents, 0) * HALF_BALANCE_FACTOR + 5_000_00;
      return confirm(big ? "Big change to balance — confirm?" : "Update balance?");
    }

    case "add_envelope": {
      if (!p.name || typeof p.name !== "string") return reject("Need a name");
      if (!m.ENVELOPE_KINDS.includes(p.kind)) return reject("Pick a kind: bill, budget, or goal");
      if (!isPositiveCents(p.amountCents)) return reject("Need a positive amount");
      if (p.amountCents > MAX_SANE_BALANCE_CENTS) return reject("Amount looks unreasonable");
      const key = m.ekey(p.name);
      if (state.envelopes[key]) return reject("That name is already in use");
      if (state.balanceCents > 0 && p.amountCents > state.balanceCents * TEN_X_FACTOR) {
        return confirm("That's much more than your balance — confirm?");
      }
      if (p.dueDate) {
        const d = m.normalizeDate(p.dueDate);
        if (!d) return reject("Invalid due date");
        const diff = m.daysBetween(today, d);
        if (diff < -14) return reject("That due date is more than 2 weeks in the past");
        if (diff > 730) return reject("That due date is more than 2 years out");
      }
      if (p.recurrence && !m.RECURRENCES.includes(p.recurrence)) {
        return reject("Recurrence must be once, weekly, biweekly, or monthly");
      }
      return confirm("Add this " + p.kind + "?");
    }

    case "update_envelope": {
      const key = m.ekey(p.key || p.name);
      if (!state.envelopes[key]) return reject("I don't see that one");
      if (p.amountCents !== undefined && !isFiniteNumber(p.amountCents)) return reject("Invalid amount");
      if (p.amountCents !== undefined && p.amountCents < 0) return reject("Amount can't be negative");
      if (p.dueDate) {
        const d = m.normalizeDate(p.dueDate);
        if (!d) return reject("Invalid due date");
        const diff = m.daysBetween(today, d);
        if (diff < -14) return reject("That due date is more than 2 weeks in the past");
        if (diff > 730) return reject("That due date is more than 2 years out");
      }
      return confirm("Update?");
    }

    case "remove_envelope": {
      const key = m.ekey(p.key || p.name);
      if (!state.envelopes[key]) return reject("I don't see that one");
      return confirm("Remove?");
    }

    case "record_spend": {
      if (!isFiniteNumber(p.amountCents)) return reject("Need an amount");
      if (p.amountCents === 0) return reject("Amount can't be zero");
      const abs = Math.abs(p.amountCents);
      if (abs > MAX_SANE_BALANCE_CENTS) return reject("That amount looks unreasonable");
      if (p.envelopeKey) {
        const k = m.ekey(p.envelopeKey);
        if (!state.envelopes[k]) return reject("Envelope not found: " + p.envelopeKey);
      }
      if (!state.setup) return reject("Set up your account first");
      // Anomaly tiers
      if (abs > state.balanceCents && state.balanceCents >= 0) {
        return confirm("That's more than your current balance — confirm?");
      }
      if (state.balanceCents > 0 && abs > state.balanceCents * HALF_BALANCE_FACTOR) {
        return confirm("That's over half your balance — confirm?");
      }
      if (abs > AUTO_SPEND_LIMIT_CENTS) return confirm("Confirm spend?");
      return auto("Logged");
    }

    case "record_income": {
      if (!isPositiveCents(p.amountCents)) return reject("Income must be positive");
      if (p.amountCents > MAX_SANE_BALANCE_CENTS) return reject("That amount looks unreasonable");
      if (p.nextPayday) {
        const d = m.normalizeDate(p.nextPayday);
        if (!d) return reject("Invalid next payday");
      }
      return confirm("Record income?");
    }

    case "pay_bill": {
      const key = m.ekey(p.envelopeKey || p.name);
      const env = state.envelopes[key];
      if (!env) return reject("I don't see that bill");
      if (env.kind !== "bill") return reject("That's not a bill");
      if (!env.active) return reject("That bill is inactive");
      if (p.amountCents !== undefined && !isPositiveCents(p.amountCents)) {
        return reject("Amount must be positive");
      }
      return confirm("Mark " + env.name + " paid?");
    }

    case "skip_bill": {
      const key = m.ekey(p.envelopeKey || p.name);
      const env = state.envelopes[key];
      if (!env) return reject("I don't see that bill");
      if (!env.dueDate) return reject("That bill has no due date to skip");
      return confirm("Skip " + env.name + " this cycle?");
    }

    case "delete_transaction": {
      if (!p.txId) return reject("Missing transaction id");
      const tx = state.transactions.find(t => t.id === p.txId);
      if (!tx) return reject("Transaction not found");
      if (tx.kind === "setup") return reject("Can't delete the setup transaction — use reset instead");
      return confirm("Delete this transaction?");
    }

    case "edit_transaction": {
      if (!p.txId) return reject("Missing transaction id");
      const tx = state.transactions.find(t => t.id === p.txId);
      if (!tx) return reject("Transaction not found");
      if (!["spend", "refund", "bill_payment"].includes(tx.kind)) {
        return reject("Only spends and bill payments can be edited");
      }
      if (p.newAmountCents !== undefined && !isFiniteNumber(p.newAmountCents)) {
        return reject("Invalid amount");
      }
      return confirm("Update this transaction?");
    }

    case "update_settings": {
      const ok = ["timezone", "currency", "currencySymbol", "language", "payFrequency", "payday"]
        .some(k => p[k] !== undefined);
      if (!ok) return reject("Nothing to update");
      if (p.payFrequency && !m.PAY_FREQS.includes(p.payFrequency)) {
        return reject("Invalid pay frequency");
      }
      if (p.payday) {
        const d = m.normalizeDate(p.payday);
        if (!d) return reject("Invalid payday");
      }
      return confirm("Update settings?");
    }

    case "reset": {
      return confirm("This will erase everything — confirm?", "All your data will be deleted.");
    }

    default:
      return reject("Unknown intent: " + intent.kind);
  }
}

// Validate a batch from one user turn. Caps cascades.
function validateBatch(state, intents, todayStr) {
  if (!Array.isArray(intents)) return [reject("Intents must be an array")];
  if (intents.length === 0) return [];
  if (intents.length > 3) {
    // Cap cascades to prevent one ambiguous voice transcript turning into
    // a multi-action mass-mutation. Tell user to slow down.
    return [reject("That's too many things at once — let's do one at a time")];
  }
  return intents.map(i => validateIntent(state, i, todayStr));
}

module.exports = { validateIntent, validateBatch };
