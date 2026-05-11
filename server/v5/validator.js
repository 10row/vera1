"use strict";
// v5/validator.js — sanity-check an intent before showing a confirm card.
//
// Returns one of THREE verdict shapes:
//   { ok: true }                                          — proceed to confirm
//   { ok: false, reason: "..." }                          — hard reject (error msg)
//   { ok: false, clarify: { code, field, question } }     — soft reject (ASK user)
//
// HARD REJECT vs CLARIFY — the architectural distinction that fixes the
// "buttons on a question" bug.
//
// HARD REJECT (reason): the intent shape is structurally invalid and
// can't be fixed by gathering more info — duplicate bill, future date,
// spend > 2x balance. Bot shows the reason; no buttons (nothing to
// confirm). User must rephrase.
//
// CLARIFY: the intent is well-formed in shape but one required FIELD is
// missing. The user MEANT to do this; the AI just didn't have enough
// info to fill it in. Bot asks the question in plain text — NO BUTTONS.
// User types the missing piece; AI re-runs the intent with the field
// supplied.
//
// THE BUG THIS PREVENTS: AI emits add_bill without a dueDate. Old
// validator rejected with "Need a due date for X" — bot showed Yes/No
// buttons over the rejection. Tapping Yes did nothing meaningful. User
// was confused. ROOT FIX: validator returns clarify; bot renders
// question, no buttons. The user supplies the date and the flow resumes.
//
// Validator NEVER mutates state. It's the second line of defense after the
// AI's prompt. Engine throws on bad data — validator catches it earlier
// with a friendly message instead of a 500.
//
// LOCALIZATION (added after a Russian user got 6 lines of English error
// messages — see screenshot from bug report): all reject() messages flow
// through M(lang, code, params). Language inferred from state.language;
// callers can override via the 4th `lang` argument.

const m = require("./model");
const { M } = require("./messages");

function ok() { return { ok: true }; }
function reject(reason) { return { ok: false, reason }; }
// clarify — soft reject for a missing required field. The bot will
// render the question as plain text (no buttons) and wait for the user
// to supply the missing piece. `code` lets callers / tests assert which
// field is missing without string-matching the localized question.
function clarify(code, field, question) {
  return { ok: false, clarify: { code, field, question } };
}

function validateIntent(state, intent, todayStr, lang) {
  // Language: explicit param > state.language > "en".
  const L = lang || (state && state.language) || "en";

  if (!intent || typeof intent !== "object") return reject(M(L, "emptyIntent"));
  if (typeof intent.kind !== "string") return reject(M(L, "missingKind"));
  if (!m.INTENT_KINDS.includes(intent.kind)) return reject(M(L, "unknownIntent"));

  todayStr = todayStr || m.today((state && state.timezone) || "UTC");
  const p = intent.params || {};

  switch (intent.kind) {
    case "setup_account": {
      // The bot's onboarding handles this directly — but defense in depth.
      if (state.setup) return reject(M(L, "alreadySetUp"));
      const bal = Math.round(Number(p.balanceCents) || 0);
      if (!Number.isFinite(bal)) return reject(M(L, "notANumber"));
      if (bal < 0) return reject(M(L, "negativeBalance"));
      if (bal > 100_000_000_00) return reject(M(L, "balanceTooLarge"));
      return ok();
    }

    case "adjust_balance": {
      if (!state.setup) return reject(M(L, "setupFirstAsk"));
      const bal = Math.round(Number(p.newBalanceCents));
      if (!Number.isFinite(bal)) return reject(M(L, "notANumber"));
      if (bal < 0) return reject(M(L, "negativeBalance"));
      return ok();
    }

    case "add_bill": {
      if (!state.setup) return reject(M(L, "setupFirst"));
      const name = String(p.name || "").trim();
      // MISSING NAME — soft clarify ("What should I call this commitment?")
      // not a hard reject. User HAS an intent; they just didn't name it.
      if (!name) return clarify("clarifyBillName", "name", M(L, "clarifyBillName"));
      // MISSING AMOUNT — soft clarify.
      const amt = Math.round(Number(p.amountCents));
      if (!Number.isFinite(amt) || amt <= 0) {
        return clarify("clarifyBillAmount", "amountCents", M(L, "clarifyBillAmount", { name }));
      }
      // MISSING DUE DATE — soft clarify. This is the most common path:
      // user says "200 for friend to store" and the AI dutifully asks
      // "how long do you need it for?" Before this fix that question
      // came wrapped in Log it / Skip buttons (confusing) — now it's
      // a plain text question, no buttons.
      const dueDate = m.normalizeDate(p.dueDate);
      if (!dueDate) return clarify("clarifyBillDueDate", "dueDate", M(L, "clarifyBillDueDate"));
      // HARD REJECTS — structurally bad shape.
      if (dueDate < todayStr) return reject(M(L, "billPastDate"));
      const recurrence = p.recurrence;
      if (recurrence && !m.RECURRENCES.includes(recurrence)) return reject(M(L, "badRecurrence"));
      const key = m.billKey(name);
      if (state.bills && state.bills[key]) return reject(M(L, "dupBillName", { name }));
      return ok();
    }

    case "remove_bill": {
      if (!state.setup) return reject(M(L, "setupFirst"));
      const key = m.billKey(p.name || p.key);
      if (!key || !state.bills || !state.bills[key]) return reject(M(L, "noBillByName"));
      return ok();
    }

    case "record_spend": {
      if (!state.setup) return reject(M(L, "setupFirst"));
      const amt = Math.round(Number(p.amountCents));
      if (!Number.isFinite(amt) || amt <= 0) return reject(M(L, "needValidAmount"));
      if (amt > state.balanceCents * 2 && state.balanceCents > 0) {
        // Sanity: spending more than 2x balance is almost always a typo.
        return reject(M(L, "spendOverBalance", { amount: m.toMoney(amt, state.currencySymbol) }));
      }
      if (p.billKey) {
        const k = m.billKey(p.billKey);
        if (!state.bills || !state.bills[k]) return reject(M(L, "noBillMatch", { name: p.billKey }));
      }
      // Backdate (optional p.date) — must not be in the future or
      // before account setup. resolveTxDate already returns its own
      // string; we pass it through (locale-aware will follow when we
      // upgrade resolveTxDate). For now, keep the existing string.
      const dr = m.resolveTxDate(state, p.date, todayStr);
      if (dr.error) return reject(dr.error);
      return ok();
    }

    case "record_income": {
      if (!state.setup) return reject(M(L, "setupFirst"));
      const amt = Math.round(Number(p.amountCents));
      if (!Number.isFinite(amt) || amt <= 0) return reject(M(L, "needValidAmount"));
      const dr = m.resolveTxDate(state, p.date, todayStr);
      if (dr.error) return reject(dr.error);
      return ok();
    }

    case "update_payday": {
      if (!state.setup) return reject(M(L, "setupFirst"));
      if (p.payday) {
        const d = m.normalizeDate(p.payday);
        if (!d) return reject(M(L, "badDateFormat"));
      }
      if (p.payFrequency && !m.PAY_FREQS.includes(p.payFrequency)) return reject(M(L, "badPayFrequency"));
      return ok();
    }

    case "undo_last": {
      if (!state.events || state.events.length === 0) return reject(M(L, "nothingToUndo"));
      return ok();
    }

    case "delete_transaction": {
      if (!state.setup) return reject(M(L, "setupFirst"));
      const id = String((p.id) || "").trim();
      if (!id) return reject(M(L, "txIdRequired"));
      const tx = (state.transactions || []).find(t => t.id === id);
      if (!tx) return reject(M(L, "txNotFound"));
      if (tx.deletedAt) return reject(M(L, "txAlreadyDeleted"));
      if (tx.kind === "setup") return reject(M(L, "cantDeleteSetup"));
      return ok();
    }

    case "reset":
      return ok();

    default:
      return reject(M(L, "unknownIntent"));
  }
}

module.exports = { validateIntent };
