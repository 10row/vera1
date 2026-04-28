"use strict";
// v4/engine.js — pure intent → state transformer.
// applyIntent(state, intent) returns { state, event, transaction? }.
// Never mutates input. Throws on malformed intents — validator must run FIRST.
// The engine assumes validated input; it enforces structural invariants only.

const m = require("./model");

function clone(s) { return JSON.parse(JSON.stringify(s)); }

function makeEvent(intent, prevBalance, newBalance, extra) {
  return {
    id: m.uid(),
    ts: Date.now(),
    intent,
    prevBalance,
    newBalance,
    ...(extra || {}),
  };
}

function recurrenceDays(rec) {
  if (rec === "weekly") return 7;
  if (rec === "biweekly") return 14;
  return 30; // monthly approximation; pay_bill bumps by 30 days for now
}

function applyIntent(state, intent) {
  if (!intent || !intent.kind) throw new Error("applyIntent: intent.kind required");
  const s = clone(state);
  const tz = s.timezone || "UTC";
  const todayStr = m.today(tz);
  const prevBalance = s.balanceCents;
  let event;

  switch (intent.kind) {
    case "setup_account": {
      const p = intent.params || {};
      if (typeof p.balanceCents !== "number" || !Number.isFinite(p.balanceCents)) {
        throw new Error("setup_account: balanceCents (number) required");
      }
      s.setup = true;
      s.balanceCents = p.balanceCents;
      if (p.currency) s.currency = p.currency;
      if (p.currencySymbol) s.currencySymbol = p.currencySymbol;
      if (p.language) s.language = p.language;
      if (p.timezone) s.timezone = p.timezone;
      s.payday = p.payday ? m.normalizeDate(p.payday) : m.addDays(todayStr, 30);
      s.payFrequency = p.payFrequency || "monthly";
      s.transactions.push({
        id: m.uid(), ts: Date.now(), kind: "setup",
        amountCents: p.balanceCents,
        note: p.note || "Initial balance",
        envelopeKey: null, date: todayStr,
      });
      event = makeEvent(intent, prevBalance, s.balanceCents);
      break;
    }

    case "adjust_balance": {
      const p = intent.params || {};
      if (typeof p.newBalanceCents !== "number" || !Number.isFinite(p.newBalanceCents)) {
        throw new Error("adjust_balance: newBalanceCents (number) required");
      }
      const delta = p.newBalanceCents - s.balanceCents;
      s.balanceCents = p.newBalanceCents;
      s.transactions.push({
        id: m.uid(), ts: Date.now(), kind: "correction",
        amountCents: delta,
        note: p.note || "Balance correction",
        envelopeKey: null, date: todayStr,
      });
      event = makeEvent(intent, prevBalance, s.balanceCents);
      break;
    }

    case "add_envelope": {
      const p = intent.params || {};
      if (!p.name || !p.kind || !m.ENVELOPE_KINDS.includes(p.kind)) {
        throw new Error("add_envelope: name + valid kind required");
      }
      const key = m.ekey(p.name);
      if (s.envelopes[key]) throw new Error("add_envelope: envelope exists: " + key);
      s.envelopes[key] = {
        key,
        name: p.name,
        kind: p.kind,
        amountCents: typeof p.amountCents === "number" ? p.amountCents : 0,
        spentCents: 0,
        fundedCents: 0,
        targetCents: typeof p.targetCents === "number" ? p.targetCents : null,
        dueDate: p.dueDate ? m.normalizeDate(p.dueDate) : null,
        recurrence: p.recurrence || "once",
        keywords: Array.isArray(p.keywords) ? p.keywords.slice(0, 20) : [],
        active: true,
        createdAt: Date.now(),
      };
      event = makeEvent(intent, prevBalance, s.balanceCents, { envelopeKey: key });
      break;
    }

    case "update_envelope": {
      const p = intent.params || {};
      const key = m.ekey(p.key || p.name);
      const env = s.envelopes[key];
      if (!env) throw new Error("update_envelope: not found: " + key);
      if (p.name !== undefined) env.name = p.name;
      if (typeof p.amountCents === "number") env.amountCents = p.amountCents;
      if (typeof p.targetCents === "number") env.targetCents = p.targetCents;
      if (p.dueDate !== undefined) env.dueDate = p.dueDate ? m.normalizeDate(p.dueDate) : null;
      if (p.recurrence !== undefined) env.recurrence = p.recurrence;
      if (Array.isArray(p.keywords)) env.keywords = p.keywords.slice(0, 20);
      if (typeof p.active === "boolean") env.active = p.active;
      event = makeEvent(intent, prevBalance, s.balanceCents, { envelopeKey: key });
      break;
    }

    case "remove_envelope": {
      const p = intent.params || {};
      const key = m.ekey(p.key || p.name);
      const env = s.envelopes[key];
      if (!env) throw new Error("remove_envelope: not found: " + key);
      env.active = false;
      event = makeEvent(intent, prevBalance, s.balanceCents, { envelopeKey: key });
      break;
    }

    case "record_spend": {
      const p = intent.params || {};
      if (typeof p.amountCents !== "number" || !Number.isFinite(p.amountCents) || p.amountCents === 0) {
        throw new Error("record_spend: amountCents (non-zero number) required");
      }
      const key = p.envelopeKey ? m.ekey(p.envelopeKey) : null;
      if (key && !s.envelopes[key]) throw new Error("record_spend: envelope not found: " + key);
      s.balanceCents -= p.amountCents;
      if (key && s.envelopes[key].active) {
        s.envelopes[key].spentCents += p.amountCents;
      }
      const tx = {
        id: m.uid(), ts: Date.now(),
        kind: p.amountCents < 0 ? "refund" : "spend",
        amountCents: p.amountCents,
        note: p.note || "",
        envelopeKey: key, date: todayStr,
      };
      s.transactions.push(tx);
      event = makeEvent(intent, prevBalance, s.balanceCents, { envelopeKey: key, txId: tx.id });
      break;
    }

    case "record_income": {
      const p = intent.params || {};
      if (typeof p.amountCents !== "number" || p.amountCents <= 0) {
        throw new Error("record_income: amountCents must be a positive number");
      }
      s.balanceCents += p.amountCents;
      // Reset budget envelopes' spent for the new cycle.
      for (const env of Object.values(s.envelopes)) {
        if (env.active && env.kind === "budget") env.spentCents = 0;
      }
      // Advance payday by frequency unless an explicit nextPayday is provided.
      if (p.nextPayday) {
        const np = m.normalizeDate(p.nextPayday);
        if (np) s.payday = np;
      } else if (s.payday) {
        s.payday = m.advancePayday(s.payday, s.payFrequency || "monthly", todayStr);
      }
      s.transactions.push({
        id: m.uid(), ts: Date.now(), kind: "income",
        amountCents: p.amountCents,
        note: p.note || "Income",
        envelopeKey: null, date: todayStr,
      });
      event = makeEvent(intent, prevBalance, s.balanceCents);
      break;
    }

    case "pay_bill": {
      const p = intent.params || {};
      const key = m.ekey(p.envelopeKey || p.name);
      const env = s.envelopes[key];
      if (!env || !env.active) throw new Error("pay_bill: not found or inactive: " + key);
      const amt = typeof p.amountCents === "number" ? p.amountCents : env.amountCents;
      if (amt <= 0) throw new Error("pay_bill: amount must be positive");
      s.balanceCents -= amt;
      env.spentCents += amt;
      if (env.recurrence && env.recurrence !== "once" && env.dueDate) {
        env.dueDate = m.addDays(env.dueDate, recurrenceDays(env.recurrence));
      } else if (env.recurrence === "once") {
        env.active = false;
      }
      const tx = {
        id: m.uid(), ts: Date.now(), kind: "bill_payment",
        amountCents: amt,
        note: "Paid: " + env.name,
        envelopeKey: key, date: todayStr,
      };
      s.transactions.push(tx);
      event = makeEvent(intent, prevBalance, s.balanceCents, { envelopeKey: key, txId: tx.id });
      break;
    }

    case "skip_bill": {
      const p = intent.params || {};
      const key = m.ekey(p.envelopeKey || p.name);
      const env = s.envelopes[key];
      if (!env || !env.active || !env.dueDate) throw new Error("skip_bill: not skippable: " + key);
      env.dueDate = m.addDays(env.dueDate, recurrenceDays(env.recurrence));
      event = makeEvent(intent, prevBalance, s.balanceCents, { envelopeKey: key });
      break;
    }

    case "delete_transaction": {
      const p = intent.params || {};
      const idx = s.transactions.findIndex(t => t.id === p.txId);
      if (idx === -1) throw new Error("delete_transaction: txId not found");
      const tx = s.transactions[idx];
      if (tx.kind === "setup") throw new Error("delete_transaction: cannot delete setup transaction");
      // Reverse balance & envelope effects.
      if (tx.kind === "spend" || tx.kind === "refund" || tx.kind === "bill_payment") {
        s.balanceCents += tx.amountCents;
        if (tx.envelopeKey && s.envelopes[tx.envelopeKey]) {
          s.envelopes[tx.envelopeKey].spentCents -= tx.amountCents;
          if (s.envelopes[tx.envelopeKey].spentCents < 0) s.envelopes[tx.envelopeKey].spentCents = 0;
        }
      } else if (tx.kind === "income") {
        s.balanceCents -= tx.amountCents;
      } else if (tx.kind === "correction") {
        s.balanceCents -= tx.amountCents;
      }
      s.transactions.splice(idx, 1);
      event = makeEvent(intent, prevBalance, s.balanceCents, { txId: p.txId });
      break;
    }

    case "edit_transaction": {
      const p = intent.params || {};
      const tx = s.transactions.find(t => t.id === p.txId);
      if (!tx) throw new Error("edit_transaction: txId not found");
      if (!["spend", "refund", "bill_payment"].includes(tx.kind)) {
        throw new Error("edit_transaction: only spend/refund/bill_payment editable");
      }
      const oldAmt = tx.amountCents;
      const newAmt = typeof p.newAmountCents === "number" ? p.newAmountCents : oldAmt;
      s.balanceCents += oldAmt;
      s.balanceCents -= newAmt;
      if (tx.envelopeKey && s.envelopes[tx.envelopeKey]) {
        const env = s.envelopes[tx.envelopeKey];
        env.spentCents += -oldAmt + newAmt;
        if (env.spentCents < 0) env.spentCents = 0;
      }
      tx.amountCents = newAmt;
      if (typeof p.newNote === "string") tx.note = p.newNote;
      event = makeEvent(intent, prevBalance, s.balanceCents, { txId: p.txId });
      break;
    }

    case "update_settings": {
      const p = intent.params || {};
      if (p.timezone) s.timezone = p.timezone;
      if (p.currency) s.currency = p.currency;
      if (p.currencySymbol) s.currencySymbol = p.currencySymbol;
      if (p.language) s.language = p.language;
      if (p.payFrequency && m.PAY_FREQS.includes(p.payFrequency)) s.payFrequency = p.payFrequency;
      if (p.payday) {
        const np = m.normalizeDate(p.payday);
        if (np) s.payday = np;
      }
      event = makeEvent(intent, prevBalance, s.balanceCents);
      break;
    }

    case "undo_last": {
      // Drop the last event and re-fold remaining events from a fresh state.
      // This makes undo byte-perfect: the resulting state is exactly what
      // you would have had if the undone action never happened.
      // Note: the undo event itself is NOT pushed onto state.events — that
      // would corrupt the next undo. The undone event is gone, period.
      if (!Array.isArray(s.events) || s.events.length <= 1) {
        throw new Error("undo_last: nothing to undo");
      }
      const lastEvent = s.events[s.events.length - 1];
      if (lastEvent && lastEvent.intent && lastEvent.intent.kind === "setup_account") {
        throw new Error("undo_last: cannot undo setup");
      }
      const remaining = s.events.slice(0, -1);
      let fresh = m.createFreshState();
      // Preserve schema label so v4 readers don't fall back to fresh.
      fresh.schema = s.schema;
      for (const ev of remaining) {
        fresh = applyIntent(fresh, ev.intent).state;
      }
      // Return the new state. The 'event' field carries the descriptor
      // of WHAT was undone so the bot can show "↶ Undone: spent $5".
      const undoDescriptor = makeEvent(intent, prevBalance, fresh.balanceCents, { undid: lastEvent });
      return { state: fresh, event: undoDescriptor };
    }

    case "reset": {
      const fresh = m.createFreshState();
      // Preserve event log across resets for audit. State is wiped.
      const carryEvents = s.events.slice();
      const resetEvent = makeEvent(intent, prevBalance, 0);
      carryEvents.push(resetEvent);
      fresh.events = carryEvents;
      return { state: fresh, event: resetEvent };
    }

    default:
      throw new Error("applyIntent: unknown kind: " + intent.kind);
  }

  s.events.push(event);
  return { state: s, event };
}

// Reduce a sequence of intents to final state, throwing on first error.
// Useful for tests and event-log replay.
function applyAll(initial, intents) {
  let s = initial;
  for (const i of intents) {
    s = applyIntent(s, i).state;
  }
  return s;
}

module.exports = { applyIntent, applyAll };
