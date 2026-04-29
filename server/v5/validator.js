"use strict";
// v5/validator.js — sanity-check an intent before showing a confirm card.
// Returns { ok, reason } where reason is short, conversational English/Russian.
//
// Validator NEVER mutates state. It's the second line of defense after the
// AI's prompt. Engine throws on bad data — validator catches it earlier
// with a friendly message instead of a 500.

const m = require("./model");

function ok() { return { ok: true }; }
function reject(reason) { return { ok: false, reason }; }

function validateIntent(state, intent, todayStr) {
  if (!intent || typeof intent !== "object") return reject("Empty intent.");
  if (typeof intent.kind !== "string") return reject("Intent missing kind.");
  if (!m.INTENT_KINDS.includes(intent.kind)) return reject("I don't know how to do that.");

  todayStr = todayStr || m.today((state && state.timezone) || "UTC");
  const p = intent.params || {};

  switch (intent.kind) {
    case "setup_account": {
      // The bot's onboarding handles this directly — but defense in depth.
      if (state.setup) return reject("You're already set up. Tell me a balance change with \"actually I have $X\" instead.");
      const bal = Math.round(Number(p.balanceCents) || 0);
      if (!Number.isFinite(bal)) return reject("That doesn't look like a number.");
      if (bal < 0) return reject("Balance can't be negative.");
      if (bal > 100_000_000_00) return reject("That balance is too large to track here.");
      return ok();
    }

    case "adjust_balance": {
      if (!state.setup) return reject("Set up first — what's your starting balance?");
      const bal = Math.round(Number(p.newBalanceCents));
      if (!Number.isFinite(bal)) return reject("That doesn't look like a number.");
      if (bal < 0) return reject("Balance can't be negative.");
      return ok();
    }

    case "add_bill": {
      if (!state.setup) return reject("Set up first.");
      const name = String(p.name || "").trim();
      if (!name) return reject("What's the bill called?");
      const amt = Math.round(Number(p.amountCents));
      if (!Number.isFinite(amt) || amt <= 0) return reject("Need a valid amount for " + name + ".");
      const dueDate = m.normalizeDate(p.dueDate);
      if (!dueDate) return reject("Need a due date for " + name + ".");
      if (dueDate < todayStr) return reject("That date's in the past — pick a future one.");
      const recurrence = p.recurrence;
      if (recurrence && !m.RECURRENCES.includes(recurrence)) return reject("Recurrence should be once/weekly/biweekly/monthly.");
      // Reject duplicate names
      const key = m.billKey(name);
      if (state.bills && state.bills[key]) return reject("You already have a bill named " + name + ".");
      return ok();
    }

    case "remove_bill": {
      if (!state.setup) return reject("Set up first.");
      const key = m.billKey(p.name || p.key);
      if (!key || !state.bills || !state.bills[key]) return reject("No bill by that name.");
      return ok();
    }

    case "record_spend": {
      if (!state.setup) return reject("Set up first.");
      const amt = Math.round(Number(p.amountCents));
      if (!Number.isFinite(amt) || amt <= 0) return reject("Need a valid amount.");
      if (amt > state.balanceCents * 2 && state.balanceCents > 0) {
        // Sanity: spending more than 2x balance is almost always a typo.
        return reject("That's more than your balance — really " + m.toMoney(amt, state.currencySymbol) + "?");
      }
      if (p.billKey) {
        const k = m.billKey(p.billKey);
        if (!state.bills || !state.bills[k]) return reject("No bill matching " + p.billKey + ".");
      }
      return ok();
    }

    case "record_income": {
      if (!state.setup) return reject("Set up first.");
      const amt = Math.round(Number(p.amountCents));
      if (!Number.isFinite(amt) || amt <= 0) return reject("Need a valid amount.");
      return ok();
    }

    case "update_payday": {
      if (!state.setup) return reject("Set up first.");
      if (p.payday) {
        const d = m.normalizeDate(p.payday);
        if (!d) return reject("That date didn't parse — try YYYY-MM-DD.");
      }
      if (p.payFrequency && !m.PAY_FREQS.includes(p.payFrequency)) return reject("Frequency should be weekly/biweekly/monthly/irregular.");
      return ok();
    }

    case "undo_last": {
      if (!state.events || state.events.length === 0) return reject("Nothing to undo.");
      return ok();
    }

    case "reset":
      return ok();

    default:
      return reject("Unknown intent: " + intent.kind);
  }
}

module.exports = { validateIntent };
