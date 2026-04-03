// server/vera.js
// Pure logic layer — applyAction() and computePicture()
// Ported from web/vera.jsx. No Express, no DB, no side effects.
// These are pure functions. Test them independently before wiring to DB.
//
// CRITICAL ARCHITECTURE DECISIONS (do not change):
// 1. committed and envelopes keyed by name — upsert by name, no ids
// 2. Four buckets always sum to balance — bucket1+2+3+4 = confirmedBalance
// 3. Ledger is append-only — balance always recomputed, never stored
// 4. Daily settlement — dailyLeft = (remainingBeforeToday / daysLeft) - spentToday

"use strict";

const crypto = require("crypto");

// ── TIME ──────────────────────────────────────────────────────────────────────
const TODAY = () => new Date().toISOString().split("T")[0];

const daysUntil = (ds) => {
  if (!ds) return 30;
  return Math.max(0, Math.ceil(
    (new Date(ds + "T00:00:00") - new Date(TODAY() + "T00:00:00")) / 86400000
  ));
};

const uid = () => crypto.randomBytes(4).toString("hex");

// ── DATE ADVANCE ──────────────────────────────────────────────────────────────
// Auto-advance past-due recurring dates to next future occurrence.
// Called on set_committed and complete_setup.
const advanceDate = (dateStr, frequency) => {
  if (!dateStr) return dateStr;
  const dt = new Date(dateStr + "T00:00:00");
  const tod = new Date(TODAY() + "T00:00:00");
  while (dt < tod) {
    if (frequency === "monthly") dt.setMonth(dt.getMonth() + 1);
    else if (frequency === "weekly") dt.setDate(dt.getDate() + 7);
    else if (frequency === "annual") dt.setFullYear(dt.getFullYear() + 1);
    else break; // "once" — leave as-is
  }
  return dt.toISOString().split("T")[0];
};

// ── BALANCE ───────────────────────────────────────────────────────────────────
// Always recomputed from ledger. Never stored. Ledger is the source of truth.
const confirmedBalanceFromLedger = (ledger) =>
  ledger.reduce((sum, e) => {
    if (e.type === "setup") return e.amountUsd || e.amountUSD || 0;
    if (e.type === "income") return sum + (e.amountUsd || e.amountUSD || 0);
    if (e.type === "transaction") return sum - (e.amountUsd || e.amountUSD || 0);
    if (e.type === "correction") return e.amountUsd || e.amountUSD || 0;
    return sum;
  }, 0);

const mkEntry = (type, data) => ({
  id: uid(),
  type,
  ts: new Date().toISOString(),
  date: TODAY(),
  ...data,
});

// ─────────────────────────────────────────────────────────────────────────────
// APPLY ACTION
// Single entry point for all state mutations.
// State is a plain JS object (assembled from DB in production).
// Returns new state — does not mutate input.
// ─────────────────────────────────────────────────────────────────────────────
function applyAction(state, action) {
  if (!action || action.type === "none") return state;
  const d = action.data || {};

  // Deep copy mutable parts
  const s = {
    ...state,
    ledger: [...(state.ledger || [])],
    committed: { ...(state.committed || {}) },
    envelopes: { ...(state.envelopes || {}) },
    customSubs: [...(state.customSubs || [])],
  };

  switch (action.type) {

    // ── SETUP FLOW ──────────────────────────────────────────────────────────
    case "propose_setup": {
      s.pendingSetup = { ...d, proposedAt: TODAY() };
      break;
    }
    case "confirm_setup": {
      if (!s.pendingSetup) break;
      return applyAction(
        { ...s, pendingSetup: null },
        { type: "complete_setup", data: s.pendingSetup }
      );
    }
    case "cancel_setup": {
      s.pendingSetup = null;
      break;
    }

    case "complete_setup": {
      // Advance payday to future if Claude gave a past date (happens with year confusion)
      let setupPayday = d.payday;
      if (setupPayday) {
        const pd  = new Date(setupPayday + "T00:00:00");
        const tod = new Date(TODAY() + "T00:00:00");
        if (pd <= tod) pd.setFullYear(tod.getFullYear() + (pd.getMonth() < tod.getMonth() || (pd.getMonth() === tod.getMonth() && pd.getDate() <= tod.getDate()) ? 1 : 0));
        if (pd <= tod) pd.setMonth(pd.getMonth() + 1); // safety net
        setupPayday = pd.toISOString().split("T")[0];
      }
      const sd = setupPayday ? { ...d, payday: setupPayday } : d; // sd = resolved setup data
      const daysLeft = sd.payday ? Math.max(1, daysUntil(sd.payday)) : 30;

      // Location
      if (sd.localRate) {
        s.location = {
          spendCurrency: sd.spendCurrency || s.location?.spendCurrency || "USD",
          symbol: sd.spendSymbol || s.location?.symbol || "$",
          localRate: sd.localRate || s.location?.localRate || 1,
          name: sd.location || s.location?.name || "",
          flag: sd.locationFlag || s.location?.flag || "",
          rateUpdated: TODAY(),
        };
      }

      // Ledger
      const setupEntry = mkEntry("setup", {
        amountUSD: sd.balanceUSD || 0,
        note: "Initial setup",
      });
      const txEntries = (sd.transactions || []).map((t) =>
        mkEntry("transaction", {
          description: t.description,
          amountUSD: t.amountUSD,
          localAmount: t.localAmount || null,
          localCurrency: t.localCurrency || null,
          parentId: t.parentId || "other",
          subId: t.subId || "uncategorised",
          date: t.date || TODAY(),
        })
      );
      s.ledger = [setupEntry, ...txEntries];

      // Committed — upsert by lowercase name
      s.committed = {};
      for (const c of sd.committed || []) {
        const key = c.name.toLowerCase();
        const freq = c.frequency || "monthly";
        s.committed[key] = {
          name: c.name,
          amountUSD: c.amountUSD || 0,
          frequency: freq,
          nextDate: advanceDate(c.nextDate, freq),
          autoPay: c.autoPay || false,
          paidThisCycle: false,
          active: true,
          parkedForNextCycle: false,
        };
      }

      // Envelopes — upsert by lowercase name
      s.envelopes = {};
      for (const e of sd.envelopes || []) {
        const key = e.name.toLowerCase();
        const allocatedUSD =
          e.type === "daily" && e.dailyAmountUSD
            ? e.dailyAmountUSD * daysLeft
            : e.allocatedUSD || 0;
        s.envelopes[key] = {
          name: e.name,
          type: e.type || "monthly",
          allocatedUSD,
          dailyAmountUSD:
            e.type === "daily" ? e.dailyAmountUSD || e.allocatedUSD : null,
          linkedParentId: e.linkedParentId || null,
          linkedSubIds: e.linkedSubIds || null,
          reserveFromPool: e.type === "daily" ? false : true,
          rollover: false,
          resetOnIncome: true,
          active: true,
        };
      }

      s.cycle = {
        start: TODAY(),
        payday: sd.payday,
        expectedIncomeUSD: sd.expectedIncomeUSD || 0,
        savingRate: sd.savingRate || 0.10,
      };
      s.savings = 0;
      s.setup = true;
      s.lastDiff = `Setup complete. Balance $${(sd.balanceUSD || 0).toFixed(2)}, payday ${sd.payday}.`;
      break;
    }

    // ── TRANSACTION ─────────────────────────────────────────────────────────
    case "transaction": {
      s.ledger = [
        ...s.ledger,
        mkEntry("transaction", {
          description: d.description,
          amountUSD: d.amountUSD,
          localAmount: d.localAmount || null,
          localCurrency: d.localCurrency || null,
          parentId: d.parentId || "other",
          subId: d.subId || "uncategorised",
          date: d.date || TODAY(),
        }),
      ];
      s.lastDiff = `Transaction: ${d.description} $${(d.amountUSD || 0).toFixed(2)}${d.localAmount ? ` (${d.localCurrency || ""}${d.localAmount})` : ""}`;
      break;
    }

    // ── INCOME — advance cycle, reset envelopes ──────────────────────────────
    case "income": {
      const savingUSD = (d.amountUSD || 0) * (s.cycle?.savingRate || 0.10);
      const net = (d.amountUSD || 0) - savingUSD;
      s.savings = (s.savings || 0) + savingUSD;

      const cycleStart = s.cycle?.start || TODAY();

      // Last cycle spend for summary
      const lastCycleSpend = {};
      s.ledger
        .filter((e) => e.type === "transaction" && e.date >= cycleStart)
        .forEach((e) => {
          const pid = e.parentId || "other";
          lastCycleSpend[pid] = (lastCycleSpend[pid] || 0) + (e.amountUSD || 0);
        });

      s.ledger = [
        ...s.ledger,
        mkEntry("income", {
          amountUSD: net,
          grossAmountUSD: d.amountUSD,
          savingUSD,
          description: d.description || "Income",
          date: d.date || TODAY(),
        }),
      ];

      const newPayday = d.nextPayday || s.cycle?.payday;
      const newDaysLeft = newPayday ? Math.max(1, daysUntil(newPayday)) : 30;
      s.cycle = {
        start: TODAY(),
        payday: newPayday,
        expectedIncomeUSD: d.expectedIncomeUSD || s.cycle?.expectedIncomeUSD,
        savingRate: s.cycle?.savingRate || 0.10,
      };

      // Advance committed dates
      for (const key of Object.keys(s.committed)) {
        const c = s.committed[key];
        if (!c.active) continue;
        if (c.parkedForNextCycle) {
          s.committed[key] = { ...c, parkedForNextCycle: false, active: true };
          continue;
        }
        if (c.frequency === "once" && c.nextDate <= TODAY()) {
          s.committed[key] = { ...c, active: false };
          continue;
        }
        if (c.frequency !== "once") {
          s.committed[key] = {
            ...c,
            paidThisCycle: false,
            nextDate: advanceDate(c.nextDate, c.frequency),
          };
        }
      }

      // Reset/rollover envelopes
      for (const key of Object.keys(s.envelopes)) {
        const env = s.envelopes[key];
        if (!env.active || !env.resetOnIncome) continue;
        const spent = s.ledger
          .filter((e) => {
            if (e.type !== "transaction" || e.date < cycleStart) return false;
            if (env.linkedParentId) return e.parentId === env.linkedParentId;
            return false;
          })
          .reduce((sum, e) => sum + (e.amountUSD || 0), 0);
        const unused = Math.max(0, (env.allocatedUSD || 0) - spent);
        const rolledOver = env.rollover ? unused : 0;
        const newAllocated =
          env.type === "daily" && env.dailyAmountUSD
            ? env.dailyAmountUSD * newDaysLeft
            : env.allocatedUSD || 0;
        s.envelopes[key] = { ...env, allocatedUSD: newAllocated + rolledOver };
      }

      const totalSpent = Object.values(lastCycleSpend).reduce((a, b) => a + b, 0);
      s.lastDiff = `Income $${net.toFixed(2)} landed ($${savingUSD.toFixed(2)} to savings). Last cycle: $${totalSpent.toFixed(2)} spent.`;
      break;
    }

    // ── CORRECTION ───────────────────────────────────────────────────────────
    case "correction": {
      s.ledger = [
        ...s.ledger,
        mkEntry("correction", {
          amountUSD: d.amountUSD,
          note: d.note || "Balance correction",
        }),
      ];
      s.lastDiff = `Balance corrected to $${(d.amountUSD || 0).toFixed(2)}.`;
      break;
    }

    // ── SET_COMMITTED — upsert by name ────────────────────────────────────────
    case "set_committed": {
      const key = (d.name || "").toLowerCase();
      if (!key) break;
      const existing = s.committed[key];
      const freq = d.frequency || existing?.frequency || "monthly";
      const nextDate = d.nextDate
        ? advanceDate(d.nextDate, freq)
        : existing?.nextDate || TODAY();
      const prev = existing ? `$${existing.amountUSD}` : "new";
      s.committed[key] = {
        name: d.name || existing?.name,
        amountUSD: d.amountUSD ?? existing?.amountUSD ?? 0,
        frequency: freq,
        nextDate,
        autoPay: d.autoPay ?? existing?.autoPay ?? false,
        paidThisCycle: d.paidThisCycle ?? existing?.paidThisCycle ?? false,
        active: d.active ?? existing?.active ?? true,
        parkedForNextCycle: d.parkedForNextCycle ?? existing?.parkedForNextCycle ?? false,
      };
      s.lastDiff = existing
        ? `Updated ${d.name}: ${prev} → $${(d.amountUSD || existing.amountUSD).toFixed(2)}`
        : `Added ${d.name}: $${(d.amountUSD || 0).toFixed(2)} ${freq}`;
      break;
    }

    case "remove_committed": {
      const key = (d.name || "").toLowerCase();
      if (s.committed[key]) {
        s.committed[key] = { ...s.committed[key], active: false };
        s.lastDiff = `Removed ${d.name}.`;
      }
      break;
    }

    case "confirm_payment": {
      const key = (d.name || "").toLowerCase();
      if (s.committed[key]) {
        s.committed[key] = { ...s.committed[key], paidThisCycle: true };
        s.lastDiff = `${d.name} marked as paid this cycle.`;
      }
      break;
    }

    // ── SET_ENVELOPE — upsert by name ─────────────────────────────────────────
    case "set_envelope": {
      const key = (d.name || "").toLowerCase();
      if (!key) break;
      const existing = s.envelopes[key];
      const type = d.type || existing?.type || "monthly";
      const daysLeft = s.cycle?.payday ? Math.max(1, daysUntil(s.cycle.payday)) : 30;
      const allocatedUSD =
        type === "daily" && d.dailyAmountUSD
          ? d.dailyAmountUSD * daysLeft
          : d.allocatedUSD ?? existing?.allocatedUSD ?? 0;
      const prev = existing ? `$${existing.allocatedUSD?.toFixed(2)}` : "new";
      s.envelopes[key] = {
        name: d.name || existing?.name,
        type,
        allocatedUSD,
        dailyAmountUSD:
          type === "daily"
            ? d.dailyAmountUSD || existing?.dailyAmountUSD || null
            : null,
        linkedParentId: d.linkedParentId ?? existing?.linkedParentId ?? null,
        linkedSubIds: d.linkedSubIds ?? existing?.linkedSubIds ?? null,
        reserveFromPool:
          type === "daily"
            ? false
            : d.reserveFromPool ?? existing?.reserveFromPool ?? true,
        rollover: d.rollover ?? existing?.rollover ?? false,
        resetOnIncome: d.resetOnIncome ?? existing?.resetOnIncome ?? true,
        active: d.active ?? existing?.active ?? true,
      };
      s.lastDiff = existing
        ? `Updated ${d.name} envelope: ${prev} → $${allocatedUSD.toFixed(2)}`
        : `Added ${d.name} envelope: $${allocatedUSD.toFixed(2)} ${type}`;
      break;
    }

    case "remove_envelope": {
      const key = (d.name || "").toLowerCase();
      if (s.envelopes[key]) {
        s.envelopes[key] = { ...s.envelopes[key], active: false };
        s.lastDiff = `Removed ${d.name} envelope.`;
      }
      break;
    }

    // ── SET_LOCATION ──────────────────────────────────────────────────────────
    case "set_location": {
      const prev = s.location?.localRate;
      s.location = {
        spendCurrency: d.spendCurrency || s.location?.spendCurrency || "USD",
        symbol: d.spendSymbol || s.location?.symbol || "$",
        localRate: d.localRate || s.location?.localRate || 1,
        name: d.location || s.location?.name || "",
        flag: d.locationFlag || s.location?.flag || "",
        rateUpdated: TODAY(),
      };
      s.lastDiff =
        d.localRate && d.localRate !== prev
          ? `Rate updated ${s.location.symbol}${prev}/$ → ${s.location.symbol}${d.localRate}/$`
          : `Location updated to ${s.location.name}`;
      break;
    }

    case "set_saving_rate": {
      if (s.cycle) s.cycle = { ...s.cycle, savingRate: d.rate };
      s.lastDiff = `Saving rate set to ${((d.rate || 0.1) * 100).toFixed(0)}%`;
      break;
    }

    case "create_custom_sub": {
      s.customSubs = [
        ...s.customSubs,
        {
          id: uid(),
          parentId: d.parentId,
          label: d.label,
          keywords: d.keywords || [],
          active: true,
        },
      ];
      break;
    }

    default:
      break;
  }

  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTE PICTURE
// Pure function — called on every request, never cached, always fresh.
// Returns everything the UI and Vera need. Never stored.
// ─────────────────────────────────────────────────────────────────────────────
function computePicture(state) {
  const today = TODAY();
  const { ledger = [], committed = {}, envelopes = {}, cycle, location, savings = 0 } = state;
  const rate = location?.localRate || 1;
  const symbol = location?.symbol || "$";
  const payday = cycle?.payday;
  const cycleStart = cycle?.start || today;
  const daysLeft = payday ? daysUntil(payday) : 30;

  // ── BALANCE ────────────────────────────────────────────────────────────────
  const confirmedBalance = confirmedBalanceFromLedger(ledger);

  // ── BUCKET 1: Bills due ───────────────────────────────────────────────────
  const committedList = Object.values(committed).filter(
    (c) => c.active && !c.parkedForNextCycle
  );

  const upcomingCommitted = committedList.filter((c) => {
    if (!c.nextDate || c.paidThisCycle) return false;
    if (c.frequency === "once" && c.nextDate < today) return false;
    return c.nextDate >= today && (!payday || c.nextDate <= payday);
  });
  const bucket1 = upcomingCommitted.reduce((s, c) => s + (c.amountUSD || 0), 0);

  const staleCommitted = committedList.filter(
    (c) => !c.autoPay && !c.paidThisCycle && c.nextDate && c.nextDate < today
  );
  const imminentBills = upcomingCommitted.filter((c) => daysUntil(c.nextDate) <= 3);

  // ── ENVELOPES — compute spent ──────────────────────────────────────────────
  const envelopeList = Object.values(envelopes).filter((e) => e.active);
  const computedEnvelopes = envelopeList.map((env) => {
    const matchesTx = (e) => {
      if (e.type !== "transaction" || e.date < cycleStart) return false;
      if (env.linkedSubIds?.length)
        return (
          e.parentId === env.linkedParentId &&
          env.linkedSubIds.includes(e.subId)
        );
      if (env.linkedParentId) return e.parentId === env.linkedParentId;
      return false;
    };
    const allTx = ledger.filter(matchesTx);
    const spentTotal = allTx.reduce((s, e) => s + (e.amountUSD || 0), 0);
    const spentBeforeToday = ledger
      .filter((e) => matchesTx(e) && e.date < today)
      .reduce((s, e) => s + (e.amountUSD || 0), 0);
    const spentToday = ledger
      .filter((e) => matchesTx(e) && e.date === today)
      .reduce((s, e) => s + (e.amountUSD || 0), 0);
    const remaining = Math.max(0, (env.allocatedUSD || 0) - spentTotal);

    // Daily settlement — target set at start of day, corrects tomorrow
    let dailyLeft = null;
    if (env.type === "daily" && daysLeft > 0) {
      const remainingBeforeToday = Math.max(
        0,
        (env.allocatedUSD || 0) - spentBeforeToday
      );
      const dailyTarget = remainingBeforeToday / daysLeft;
      dailyLeft = Math.max(0, dailyTarget - spentToday);
    }

    return { ...env, spentUSD: spentTotal, spentToday, remainingUSD: remaining, dailyLeft };
  });

  // ── BUCKET 2: Planned spending ────────────────────────────────────────────
  const bucket2 = computedEnvelopes
    .filter((e) => e.reserveFromPool && e.type !== "daily")
    .reduce((s, env) => s + Math.max(0, (env.allocatedUSD || 0) - (env.spentUSD || 0)), 0);

  // ── BUCKET 3: Daily allowances ────────────────────────────────────────────
  const bucket3 = computedEnvelopes
    .filter((e) => e.type === "daily")
    .reduce((s, e) => s + (e.remainingUSD || 0), 0);

  // ── BUCKET 4: Truly free ──────────────────────────────────────────────────
  const trulyFree = confirmedBalance - bucket1 - bucket2 - bucket3;

  // Free pool spend today = transactions today not matched by any envelope
  const freeSpentToday = ledger.filter(e =>
    e.type === "transaction" && e.date === today &&
    !computedEnvelopes.some(env => {
      if (env.linkedSubIds?.length) return e.parentId === env.linkedParentId && env.linkedSubIds.includes(e.subId);
      if (env.linkedParentId) return e.parentId === env.linkedParentId;
      return false;
    })
  ).reduce((s, e) => s + (e.amountUSD || 0), 0);
  // Mirror food envelope logic: (start-of-day trulyFree / daysLeft) - spent today from free pool
  const freeTodayTarget = daysLeft > 0 ? Math.max(0, trulyFree + freeSpentToday) / daysLeft : 0;
  const freeToday = Math.max(0, freeTodayTarget - freeSpentToday);
  const totalReserved = bucket1 + bucket2 + bucket3;

  // ── CATEGORY SPEND ────────────────────────────────────────────────────────
  const categorySpend = {};
  const subSpend = {};
  ledger
    .filter((e) => e.type === "transaction" && e.date >= cycleStart)
    .forEach((e) => {
      const pid = e.parentId || "other";
      const sid = e.subId || "uncategorised";
      categorySpend[pid] = (categorySpend[pid] || 0) + (e.amountUSD || 0);
      if (!subSpend[pid]) subSpend[pid] = {};
      subSpend[pid][sid] = (subSpend[pid][sid] || 0) + (e.amountUSD || 0);
    });

  // ── CASHFLOW TIMELINE ─────────────────────────────────────────────────────
  const timeline = [];
  let runningBal = confirmedBalance;
  [...upcomingCommitted]
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate))
    .forEach((c) => {
      runningBal -= c.amountUSD || 0;
      timeline.push({
        type: "bill",
        date: c.nextDate,
        name: c.name,
        amount: c.amountUSD || 0,
        balanceAfter: runningBal,
        frequency: c.frequency,
        autoPay: c.autoPay,
      });
    });
  if (payday) {
    const gross = cycle?.expectedIncomeUSD || 0;
    const saving = gross * (cycle?.savingRate || 0.10);
    timeline.push({
      type: "payday",
      date: payday,
      name: "Payday",
      gross,
      saving,
      net: gross - saving,
      balanceAfter: runningBal + gross - saving,
    });
  }

  // ── PREVIOUS CYCLE SUMMARY ────────────────────────────────────────────────
  const incomeEvents = ledger.filter(e => e.type === "income" || e.type === "setup");
  let prevCycleSpend = null;
  if (incomeEvents.length >= 2) {
    const prevCycleStart = incomeEvents[incomeEvents.length - 2].date;
    const prevTx = ledger.filter(e => e.type === "transaction" && e.date >= prevCycleStart && e.date < cycleStart);
    const prevTotal = prevTx.reduce((s, e) => s + (e.amountUSD || 0), 0);
    const prevByCategory = {};
    prevTx.forEach(e => { const pid = e.parentId || "other"; prevByCategory[pid] = (prevByCategory[pid] || 0) + (e.amountUSD || 0); });
    prevCycleSpend = { total: prevTotal, byCategory: prevByCategory };
  }

  // ── CURRENT CYCLE TOTAL SPEND ─────────────────────────────────────────────
  const cycleTx = ledger.filter(e => e.type === "transaction" && e.date >= cycleStart);
  const cycleTotal = cycleTx.reduce((s, e) => s + (e.amountUSD || 0), 0);

  return {
    today,
    payday,
    daysLeft,
    rate,
    symbol,
    spendCurrency: location?.spendCurrency || "USD",
    location: location?.name || "",
    locationFlag: location?.flag || "",
    confirmedBalance,
    savings,
    bucket1,
    bucket2,
    bucket3,
    trulyFree,
    totalReserved,
    freeToday, freeTodayTarget, freeSpentToday,
    upcomingCommitted,
    imminentBills,
    staleCommitted,
    computedEnvelopes,
    committedList,
    categorySpend,
    subSpend,
    timeline,
    prevCycleSpend,
    cycleTotal,
  };
}

module.exports = { applyAction, computePicture, advanceDate, confirmedBalanceFromLedger, TODAY };
