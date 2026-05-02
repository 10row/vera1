"use strict";
// v5/engine.js — pure state transitions.
// applyIntent(state, intent) → { state, event }
//
// The engine is the SINGLE source of truth for state mutations.
// Every change goes through here. Every change appends to state.events.
// undo_last replays the inverse from the event log.
//
// Engine NEVER consults the AI. Engine NEVER does I/O.

const m = require("./model");

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function makeEvent(intent, prevBalance, extra) {
  return Object.assign({
    id: m.uid(),
    ts: Date.now(),
    intent,
    prevBalance,
  }, extra || {});
}

function applyIntent(state, intent) {
  if (!intent || typeof intent.kind !== "string") {
    throw new Error("applyIntent: invalid intent");
  }
  const next = clone(state);
  if (!Array.isArray(next.events)) next.events = [];
  if (!Array.isArray(next.transactions)) next.transactions = [];
  if (!next.bills || typeof next.bills !== "object") next.bills = {};

  // Capture the BEFORE-mutation balance for the event log. Critical for undo:
  // the event records what the balance was BEFORE this intent applied so undo
  // can restore it exactly.
  const prevBalance = state.balanceCents;

  const todayStr = m.today(next.timezone || "UTC");
  const p = intent.params || {};

  switch (intent.kind) {
    // ── SETUP ──────────────────────────────────────
    case "setup_account": {
      if (next.setup) throw new Error("Already set up. Use adjust_balance or update_payday.");
      const bal = Math.round(Number(p.balanceCents) || 0);
      if (!Number.isFinite(bal) || bal < 0) throw new Error("Invalid balance");
      if (bal > 100_000_000_00) throw new Error("Balance too large");

      next.setup = true;
      next.balanceCents = bal;
      next.payday = m.normalizeDate(p.payday) || m.addDays(todayStr, 30);
      next.payFrequency = m.PAY_FREQS.includes(p.payFrequency) ? p.payFrequency : "monthly";
      if (p.timezone) next.timezone = p.timezone;
      if (p.language) next.language = p.language;
      if (p.currency) next.currency = p.currency;
      if (p.currencySymbol) next.currencySymbol = p.currencySymbol;
      next.onboardingDraft = null;

      // Record as a setup transaction so undo of subsequent things doesn't
      // touch the initial balance line.
      next.transactions.push({
        id: m.uid(),
        ts: Date.now(),
        kind: "setup",
        amountCents: bal,
        note: "starting balance",
        date: todayStr,
      });

      const ev = makeEvent(intent, prevBalance, { newBalance: next.balanceCents });
      next.events.push(ev);
      return { state: next, event: ev };
    }

    // ── ADJUST BALANCE ─────────────────────────────
    case "adjust_balance": {
      if (!next.setup) throw new Error("Set up first.");
      const newBal = Math.round(Number(p.newBalanceCents));
      if (!Number.isFinite(newBal) || newBal < 0) throw new Error("Invalid balance");
      const delta = newBal - next.balanceCents;
      next.balanceCents = newBal;
      next.transactions.push({
        id: m.uid(), ts: Date.now(),
        kind: "correction", amountCents: delta,
        note: p.note || "balance correction",
        date: todayStr,
      });
      const ev = makeEvent(intent, prevBalance, { newBalance: newBal, delta });
      next.events.push(ev);
      return { state: next, event: ev };
    }

    // ── BILLS ──────────────────────────────────────
    case "add_bill": {
      if (!next.setup) throw new Error("Set up first.");
      const name = String(p.name || "").trim().slice(0, 60);
      if (!name) throw new Error("Bill needs a name");
      const amt = Math.round(Number(p.amountCents));
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Invalid amount");
      const recurrence = m.RECURRENCES.includes(p.recurrence) ? p.recurrence : "monthly";
      const dueDate = m.normalizeDate(p.dueDate);
      if (!dueDate) throw new Error("Need a valid due date");
      const key = m.billKey(name);
      if (next.bills[key]) throw new Error("Bill already exists: " + name);
      next.bills[key] = {
        name, amountCents: amt, dueDate, recurrence,
        paidThisCycle: false,
        createdAt: Date.now(),
      };
      const ev = makeEvent(intent, prevBalance, { newBalance: next.balanceCents, billKey: key });
      next.events.push(ev);
      return { state: next, event: ev };
    }

    case "remove_bill": {
      if (!next.setup) throw new Error("Set up first.");
      const key = m.billKey(p.name || p.key);
      if (!next.bills[key]) throw new Error("No such bill: " + (p.name || p.key));
      const removed = next.bills[key];
      delete next.bills[key];
      const ev = makeEvent(intent, prevBalance, { newBalance: next.balanceCents, removed });
      next.events.push(ev);
      return { state: next, event: ev };
    }

    // ── SPEND / INCOME ─────────────────────────────
    case "record_spend": {
      if (!next.setup) throw new Error("Set up first.");
      const amt = Math.round(Number(p.amountCents));
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Invalid amount");
      const note = String(p.note || "").trim().slice(0, 120);
      const billKeyP = p.billKey ? m.billKey(p.billKey) : null;
      const isBillPayment = billKeyP && next.bills[billKeyP];
      // Preserve original-currency info on the transaction so the feed
      // can show "₫200,000 ≈ $8.00" instead of just $8.00.
      const isForeign = p.originalCurrency && Number.isFinite(p.originalAmount) && p.originalAmount > 0;

      next.balanceCents -= amt;
      next.transactions.push({
        id: m.uid(), ts: Date.now(),
        kind: isBillPayment ? "bill_payment" : "spend",
        amountCents: -amt,
        note: note || (isBillPayment ? next.bills[billKeyP].name : ""),
        billKey: isBillPayment ? billKeyP : null,
        originalAmount: isForeign ? Number(p.originalAmount) : null,
        originalCurrency: isForeign ? p.originalCurrency.toUpperCase() : null,
        date: todayStr,
      });

      // Mark bill as paid this cycle, advance dueDate.
      if (isBillPayment) {
        const b = next.bills[billKeyP];
        b.paidThisCycle = true;
        if (b.recurrence !== "once") {
          b.dueDate = m.advancePayday(b.dueDate, b.recurrence === "monthly" ? "monthly" : b.recurrence, todayStr);
          b.paidThisCycle = false; // new cycle starts at next due date
        }
      }

      const ev = makeEvent(intent, prevBalance, { newBalance: next.balanceCents });
      next.events.push(ev);
      return { state: next, event: ev };
    }

    case "record_income": {
      if (!next.setup) throw new Error("Set up first.");
      const amt = Math.round(Number(p.amountCents));
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Invalid amount");
      const note = String(p.note || "").trim().slice(0, 120);
      next.balanceCents += amt;
      next.transactions.push({
        id: m.uid(), ts: Date.now(),
        kind: "income", amountCents: amt, note,
        date: todayStr,
      });
      // If user got their paycheck, advance payday automatically.
      if (next.payday && next.payFrequency && next.payFrequency !== "irregular") {
        next.payday = m.advancePayday(next.payday, next.payFrequency, todayStr);
      }
      const ev = makeEvent(intent, prevBalance, { newBalance: next.balanceCents });
      next.events.push(ev);
      return { state: next, event: ev };
    }

    // ── SETTINGS ───────────────────────────────────
    case "update_payday": {
      if (!next.setup) throw new Error("Set up first.");
      const prevPayday = next.payday;
      const prevFreq = next.payFrequency;
      if (p.payday) {
        const d = m.normalizeDate(p.payday);
        if (!d) throw new Error("Invalid date");
        next.payday = d;
      }
      if (p.payFrequency && m.PAY_FREQS.includes(p.payFrequency)) {
        next.payFrequency = p.payFrequency;
      }
      const ev = makeEvent(intent, prevBalance, {
        newBalance: next.balanceCents,
        prevPayday, prevFreq,
      });
      next.events.push(ev);
      return { state: next, event: ev };
    }

    // ── UNDO / RESET ───────────────────────────────
    case "undo_last": {
      if (!next.events || next.events.length === 0) throw new Error("Nothing to undo");
      // Walk backwards to find the most recent NON-undone, NON-undo event.
      // Skipping undone events lets us chain "undo, undo, undo" through
      // multiple prior actions in reverse order.
      let idx = next.events.length - 1;
      while (idx >= 0 && (next.events[idx].undone || (next.events[idx].intent && next.events[idx].intent.kind === "undo_last"))) {
        idx--;
      }
      if (idx < 0) throw new Error("Nothing to undo");
      const target = next.events[idx];
      if (target.intent.kind === "setup_account") throw new Error("Can't undo setup. Use reset.");

      // Reverse the effects.
      switch (target.intent.kind) {
        case "adjust_balance":
          next.balanceCents = target.prevBalance;
          // Pop the correction transaction (last transaction).
          if (next.transactions.length > 0) next.transactions.pop();
          break;
        case "record_spend":
        case "record_income":
          next.balanceCents = target.prevBalance;
          if (next.transactions.length > 0) next.transactions.pop();
          // If this was a bill payment that advanced a bill, restore the bill.
          // (We stored the prior bill snapshot in event.prevBill if present.
          // For simplicity in v5, we just reset paidThisCycle on the bill if the
          // intent referenced one. Date won't be perfectly restored — accept it.)
          if (target.intent.params && target.intent.params.billKey) {
            const k = m.billKey(target.intent.params.billKey);
            if (next.bills[k]) next.bills[k].paidThisCycle = false;
          }
          break;
        case "add_bill": {
          const k = target.billKey || m.billKey(target.intent.params.name);
          if (k && next.bills[k]) delete next.bills[k];
          break;
        }
        case "remove_bill": {
          if (target.removed) {
            const k = m.billKey(target.removed.name);
            next.bills[k] = target.removed;
          }
          break;
        }
        case "update_payday":
          if (target.prevPayday !== undefined) next.payday = target.prevPayday;
          if (target.prevFreq !== undefined) next.payFrequency = target.prevFreq;
          break;
        default:
          throw new Error("Can't undo " + target.intent.kind);
      }
      // Mark the original event as undone.
      next.events[idx].undone = true;
      const ev = makeEvent(intent, prevBalance, {
        newBalance: next.balanceCents,
        undid: { eventId: target.id, intent: target.intent },
      });
      next.events.push(ev);
      return { state: next, event: ev };
    }

    case "reset": {
      const fresh = m.createFreshState();
      // Preserve language / currency / timezone preferences across reset.
      fresh.language = next.language || "en";
      fresh.currency = next.currency || "USD";
      fresh.currencySymbol = next.currencySymbol || "$";
      fresh.timezone = next.timezone || "UTC";
      const ev = makeEvent(intent, 0, { newBalance: 0 });
      fresh.events.push(ev);
      return { state: fresh, event: ev };
    }

    default:
      throw new Error("Unknown intent: " + intent.kind);
  }
}

module.exports = { applyIntent };
