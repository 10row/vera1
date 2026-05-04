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

// Compute the canonical daily pace from current state. Identical formula
// to view.compute() — duplicated here to keep engine pure (no view import,
// no require cycle). Returns the integer cents per day.
function computePaceFor(state, todayStr) {
  if (!state || !state.setup) return 0;
  const balance = state.balanceCents || 0;
  const payday = state.payday;
  const daysToPayday = Math.max(0, m.daysBetween(todayStr, payday));
  let obligated = 0;
  for (const k of Object.keys(state.bills || {})) {
    const b = state.bills[k];
    if (!b || b.paidThisCycle) continue;
    if (m.daysBetween(b.dueDate, payday) >= 0) obligated += b.amountCents || 0;
  }
  const disposable = Math.max(0, balance - obligated);
  return daysToPayday > 0 ? Math.floor(disposable / daysToPayday) : disposable;
}

// Refresh the FROZEN daily pace. Called on cycle events (setup, adjust,
// update_payday, bill add/remove) AND at the top of every applyIntent
// when the date has changed since the stored pace (day-rollover).
//
// IMPORTANT: this does NOT fire from inside record_spend. Spending
// reduces balance but pace stays at today's stored value — that's the
// whole point of the rolling-pace fix.
function refreshPace(state, todayStr) {
  state.dailyPaceCents = computePaceFor(state, todayStr);
  state.dailyPaceComputedDate = todayStr;
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

  // ── DAY-ROLLOVER PACE REFRESH ──
  // First mutation of a new day → recompute pace once, then leave it
  // alone for the rest of the day. Spending within the day eats
  // todayLeft (= pace - todaySpent) but never the pace itself.
  if (next.setup && next.dailyPaceComputedDate !== todayStr) {
    refreshPace(next, todayStr);
  }

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

      // CYCLE EVENT: lock pace from the new baseline.
      refreshPace(next, todayStr);

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
      // CYCLE EVENT: balance correction = re-baseline.
      refreshPace(next, todayStr);
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
      // CYCLE EVENT: a new bill changes "obligated" → re-baseline pace.
      refreshPace(next, todayStr);
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
      // CYCLE EVENT: removing a bill changes "obligated" → re-baseline.
      refreshPace(next, todayStr);
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

      // Resolve the EVENT date. p.date allows "I forgot to log this
      // yesterday" — tx is stamped with the past date for heatmap /
      // history accuracy. Balance still mutates NOW (the money's gone
      // either way; we're learning about it now). See CLAUDE.md "Two
      // dates on a transaction" for the model.
      const dateRes = m.resolveTxDate(next, p.date, todayStr);
      if (dateRes.error) throw new Error(dateRes.error);
      const txDate = dateRes.date;
      // Preserve original-currency info on the transaction so the feed
      // can show "₫200,000 ≈ $8.00" instead of just $8.00.
      const isForeign = p.originalCurrency && Number.isFinite(p.originalAmount) && p.originalAmount > 0;

      // ── GRAPH-FLAVORED FIELDS (option B from the design discussion) ──
      // Each spend can carry: vendor (entity name like "Lighthouse"),
      // category (one of a known list), tags[] (free-form), context
      // (e.g. "vietnam trip"). All optional. The graph is COMPUTED at
      // query time by DNA aggregating across these fields. No separate
      // node storage — this stays backward-compatible and low-risk.
      //
      // Sanitization: trim, length-cap, lowercase the canonical keys.
      // Display preserves user-spoken casing where it matters (vendor,
      // context). Categories normalize to a fixed list.
      const VALID_CATEGORIES = new Set([
        "coffee","groceries","restaurant","delivery","transport","subscription",
        "clothing","health","alcohol","personal","home","entertainment","travel","other",
      ]);
      const sanStr = (s, max) => {
        if (s == null) return null;
        const t = String(s).trim().slice(0, max);
        return t.length > 0 ? t : null;
      };
      const vendor = sanStr(p.vendor, 60);
      const rawCat = sanStr(p.category, 30);
      const category = rawCat && VALID_CATEGORIES.has(rawCat.toLowerCase()) ? rawCat.toLowerCase() : null;
      const context = sanStr(p.context, 60);
      let tags = null;
      if (Array.isArray(p.tags)) {
        tags = p.tags.map(t => sanStr(t, 30)).filter(Boolean).slice(0, 5);
        if (tags.length === 0) tags = null;
      }

      next.balanceCents -= amt;

      // Snapshot pre-payment bill state BEFORE we mutate it. Without
      // this, delete_transaction / undo_last cannot restore the bill
      // cleanly — the original dueDate is lost when advancePayday
      // moves it forward, and a half-restored bill (paidThisCycle=
      // false but dueDate=next-month) silently drifts to "next cycle"
      // in the engine's obligation math, blowing a hole in pace.
      const prevBill = isBillPayment ? {
        dueDate: next.bills[billKeyP].dueDate,
        paidThisCycle: !!next.bills[billKeyP].paidThisCycle,
      } : null;

      next.transactions.push({
        id: m.uid(), ts: Date.now(),
        kind: isBillPayment ? "bill_payment" : "spend",
        amountCents: -amt,
        note: note || (isBillPayment ? next.bills[billKeyP].name : ""),
        billKey: isBillPayment ? billKeyP : null,
        // prevDueDate / prevPaidThisCycle live ON the transaction so
        // delete_transaction can restore the bill exactly. Both null
        // for non-bill spends.
        prevDueDate: prevBill ? prevBill.dueDate : null,
        prevPaidThisCycle: prevBill ? prevBill.paidThisCycle : null,
        originalAmount: isForeign ? Number(p.originalAmount) : null,
        originalCurrency: isForeign ? p.originalCurrency.toUpperCase() : null,
        // Graph fields (all optional, null when absent — backward-compatible).
        vendor, category, context, tags,
        date: txDate, // EVENT date — may be backdated; balance mutated NOW.
      });

      // Mark bill as paid this cycle, advance dueDate by one cycle.
      //
      // CRITICAL FIX: prior code used advancePayday(), which only
      // fast-forwards past TODAY. If a user paid a recurring bill
      // EARLY (dueDate still in the future), advancePayday was a
      // no-op — dueDate stayed unchanged, paidThisCycle flipped to
      // false, and the bill was STILL in obligation math. Engine
      // double-reserved: balance went down by the payment, AND the
      // bill amount was still obligated. Pace dropped silently for
      // no reason.
      //
      // Now: addBillCycle ALWAYS advances by exactly one period
      // (monthly/biweekly/weekly), regardless of whether early/on-
      // time/late. paidThisCycle is then false at the new dueDate.
      if (isBillPayment) {
        const b = next.bills[billKeyP];
        if (b.recurrence === "once") {
          b.paidThisCycle = true;
        } else {
          b.dueDate = m.addBillCycle(b.dueDate, b.recurrence);
          b.paidThisCycle = false;
        }
      }

      // CYCLE EVENT for BACKDATED spends only.
      //
      // Per Model B, today-dated record_spend does NOT refresh pace —
      // spending today eats today's bucket, not the month. But a
      // BACKDATED spend is a CORRECTION, not a current spend: the
      // bot just learned about historical activity. Today's frozen
      // pace was computed this morning from a balance that didn't
      // include this spend (because the bot didn't know yet), so the
      // pace is stale relative to actual current state. Refresh it.
      //
      // Same conceptual class as delete_transaction / undo_last —
      // those are also corrections and refresh pace too. Today-dated
      // spends keep Model B intact.
      const isBackdated = txDate !== todayStr;
      if (isBackdated) {
        refreshPace(next, todayStr);
      }

      // Also snapshot prevBill on the EVENT for undo_last (which reads
      // events, not transactions). Belt-and-suspenders: same data on
      // both, since undo and delete reach for different sources.
      const ev = makeEvent(intent, prevBalance, {
        newBalance: next.balanceCents,
        prevBill,
        billKey: isBillPayment ? billKeyP : null,
      });
      next.events.push(ev);
      return { state: next, event: ev };
    }

    case "record_income": {
      if (!next.setup) throw new Error("Set up first.");
      const amt = Math.round(Number(p.amountCents));
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Invalid amount");
      const note = String(p.note || "").trim().slice(0, 120);

      // Resolve EVENT date (paycheck might've actually landed yesterday).
      // See record_spend / model.resolveTxDate for the model.
      const dateRes = m.resolveTxDate(next, p.date, todayStr);
      if (dateRes.error) throw new Error(dateRes.error);
      const txDate = dateRes.date;

      next.balanceCents += amt;
      next.transactions.push({
        id: m.uid(), ts: Date.now(),
        kind: "income", amountCents: amt, note,
        date: txDate,
      });
      // If user got their paycheck, advance payday automatically.
      const prevPaydayForCycle = next.payday;
      if (next.payday && next.payFrequency && next.payFrequency !== "irregular") {
        next.payday = m.advancePayday(next.payday, next.payFrequency, todayStr);
      }
      // CYCLE EVENT — refresh pace if EITHER:
      //   1. Payday advanced (paycheck arrived; new cycle begins), OR
      //   2. Income is BACKDATED (correction — see record_spend rationale).
      // Today-dated mid-cycle income leaves pace alone (next day rollover
      // picks up the new balance naturally).
      const isBackdated = txDate !== todayStr;
      if (next.payday !== prevPaydayForCycle || isBackdated) {
        refreshPace(next, todayStr);
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
      // CYCLE EVENT: payday or frequency change → re-baseline.
      refreshPace(next, todayStr);
      const ev = makeEvent(intent, prevBalance, {
        newBalance: next.balanceCents,
        prevPayday, prevFreq,
      });
      next.events.push(ev);
      return { state: next, event: ev };
    }

    // ── DELETE TRANSACTION (by id) ─────────────────
    // For "I didn't really get the cat" style requests where the user
    // wants to remove a SPECIFIC past transaction, not the most recent
    // (which is what undo_last would do).
    //
    // Journaling design: the original tx stays in transactions[] with
    // a `deletedAt` timestamp (history preserved). Balance and bill
    // state are reversed via a delete_transaction event that captures
    // pre-delete snapshots so undo can restore everything cleanly.
    case "delete_transaction": {
      if (!next.setup) throw new Error("Set up first.");
      const txId = String(p.id || "").trim();
      if (!txId) throw new Error("Need a transaction id");
      const tx = next.transactions.find(t => t.id === txId);
      if (!tx) throw new Error("Transaction not found");
      if (tx.deletedAt) throw new Error("Already deleted");
      if (tx.kind === "setup") throw new Error("Cannot delete the starting balance");

      // Reverse balance impact based on tx kind.
      // amountCents convention: negative for spend/bill_payment, positive
      // for income; correction is delta (signed). Reversing = subtract.
      next.balanceCents -= tx.amountCents;

      // For bill payments, restore the bill's dueDate AND paidThisCycle
      // from the snapshot on the original transaction.
      //
      // CRITICAL FIX (was a bug): prior code only reset paidThisCycle
      // and accepted that dueDate stayed advanced. That left the bill
      // in a silent "next cycle" state (paidThisCycle=false but
      // dueDate>payday), so the engine's obligation math no longer
      // counted it. Pace would over-estimate "free per day" by the
      // bill amount → user's reservation invisibly evaporated.
      //
      // Backward-compat: txs created before the prevDueDate snapshot
      // existed have null prevDueDate/prevPaidThisCycle. For those we
      // fall back to the old behavior (just reset paidThisCycle) so
      // historic deletes still apply cleanly.
      let billRevert = null;
      if (tx.kind === "bill_payment" && tx.billKey && next.bills[tx.billKey]) {
        const b = next.bills[tx.billKey];
        billRevert = {
          key: tx.billKey,
          paidThisCycle: !!b.paidThisCycle,
          dueDate: b.dueDate,
        };
        b.paidThisCycle = (tx.prevPaidThisCycle != null) ? !!tx.prevPaidThisCycle : false;
        if (tx.prevDueDate) b.dueDate = tx.prevDueDate;
      }

      // Mark deleted (journaling — never destroy data).
      tx.deletedAt = Date.now();

      // CYCLE EVENT: deleting a bill_payment changes obligation
      // (bill flips back to this-cycle when dueDate restores). Even
      // for non-bill spends, balance changes — refresh so pace stays
      // consistent with state instead of waiting for day-rollover.
      refreshPace(next, todayStr);

      const ev = makeEvent(intent, prevBalance, {
        newBalance: next.balanceCents,
        deletedTxId: txId,
        billRevert,
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
          // If this was a bill payment that advanced a bill, restore the
          // bill EXACTLY (both paidThisCycle AND dueDate) from the
          // snapshot we now persist on the event.
          //
          // CRITICAL FIX: prior code only reset paidThisCycle and left
          // dueDate stuck at the advanced value. Same bug as
          // delete_transaction had — bill silently slipped to next
          // cycle and engine reservation lost the bill amount.
          //
          // Backward-compat: events from before prevBill existed have
          // no snapshot. We fall back to the old "just reset
          // paidThisCycle" behavior so historic undos still work.
          if (target.intent.params && target.intent.params.billKey) {
            const k = m.billKey(target.intent.params.billKey);
            if (next.bills[k]) {
              if (target.prevBill && target.prevBill.dueDate) {
                next.bills[k].dueDate = target.prevBill.dueDate;
                next.bills[k].paidThisCycle = !!target.prevBill.paidThisCycle;
              } else {
                next.bills[k].paidThisCycle = false;
              }
            }
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
        case "delete_transaction": {
          // Undo of a delete = restore the deleted transaction.
          // Balance restores via prevBalance assignment below (we set it
          // explicitly here for safety even though the default does it).
          next.balanceCents = target.prevBalance;
          if (target.deletedTxId) {
            const tx = next.transactions.find(t => t.id === target.deletedTxId);
            if (tx) delete tx.deletedAt;
          }
          if (target.billRevert && target.billRevert.key && next.bills[target.billRevert.key]) {
            next.bills[target.billRevert.key].paidThisCycle = !!target.billRevert.paidThisCycle;
          }
          break;
        }
        default:
          throw new Error("Can't undo " + target.intent.kind);
      }
      // Mark the original event as undone.
      next.events[idx].undone = true;

      // CYCLE EVENT: undoing changes balance and (for bill events)
      // obligation. Refresh pace so it stays consistent with the
      // post-undo state, otherwise frozen pace can carry stale
      // assumptions about bills/balance until day rollover.
      refreshPace(next, todayStr);

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
