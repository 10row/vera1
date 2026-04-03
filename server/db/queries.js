// server/db/queries.js
// Database read/write helpers.
// getState() assembles the full state object from DB tables.
// saveAction() applies an action and persists atomically.
//
// NOTE TO CLAUDE CODE: This file is a scaffold. Wire up Prisma client
// from db/client.js. Every write should be in a transaction.

"use strict";

const { applyAction } = require("../vera");

// ── GET STATE ─────────────────────────────────────────────────────────────────
// Assembles full state object from DB tables.
// Called before every Vera API call to get current state.
async function getState(prisma, userId) {
  const [ledger, committedRows, envelopeRows, cycle, location, customSubs] =
    await Promise.all([
      prisma.ledgerEntry.findMany({
        where: { userId },
        orderBy: { ts: "asc" },
      }),
      prisma.committedItem.findMany({
        where: { userId },
      }),
      prisma.envelope.findMany({
        where: { userId },
      }),
      prisma.userCycle.findUnique({ where: { userId } }),
      prisma.userLocation.findUnique({ where: { userId } }),
      prisma.customSub.findMany({ where: { userId, active: true } }),
    ]);

  // Normalise ledger entries (DB uses camelCase, state uses amountUSD)
  const normLedger = ledger.map((e) => ({
    ...e,
    amountUSD: e.amountUsd,
  }));

  // Rebuild committed as name-keyed object
  const committed = {};
  for (const c of committedRows) {
    committed[c.nameKey] = {
      name: c.name,
      amountUSD: c.amountUsd,
      frequency: c.frequency,
      nextDate: c.nextDate,
      autoPay: c.autoPay,
      paidThisCycle: c.paidThisCycle,
      active: c.active,
      parkedForNextCycle: c.parkedForNextCycle,
    };
  }

  // Rebuild envelopes as name-keyed object
  const envelopes = {};
  for (const e of envelopeRows) {
    envelopes[e.nameKey] = {
      name: e.name,
      type: e.type,
      allocatedUSD: e.allocatedUsd,
      dailyAmountUSD: e.dailyAmountUsd,
      linkedParentId: e.linkedParentId,
      linkedSubIds: e.linkedSubIds ? JSON.parse(e.linkedSubIds) : null,
      reserveFromPool: e.reserveFromPool,
      rollover: e.rollover,
      resetOnIncome: e.resetOnIncome,
      active: e.active,
    };
  }

  return {
    setup: !!cycle,
    pendingSetup: null,
    committed,
    envelopes,
    ledger: normLedger,
    cycle: cycle
      ? {
          start: cycle.startDate,
          payday: cycle.payday,
          expectedIncomeUSD: cycle.expectedIncomeUsd,
          savingRate: cycle.savingRate,
        }
      : null,
    location: location
      ? {
          spendCurrency: location.spendCurrency,
          symbol: location.symbol,
          localRate: location.localRate,
          name: location.name,
          flag: location.flag,
          rateUpdated: location.rateUpdated,
        }
      : null,
    savings: cycle?.savingsUsd || 0,
    lastDiff: location?.lastDiff || null,
    customSubs: customSubs.map((s) => ({
      id: s.id,
      parentId: s.parentId,
      label: s.label,
      keywords: JSON.parse(s.keywords),
      active: s.active,
    })),
  };
}

// ── SAVE ACTION ───────────────────────────────────────────────────────────────
// Applies action to state, persists all changes atomically.
// Returns new state.
async function saveAction(prisma, userId, action) {
  const state = await getState(prisma, userId);
  const newState = applyAction(state, action);

  // Persist in a transaction
  await prisma.$transaction(async (tx) => {
    // Ledger — only append new entries
    const newEntries = newState.ledger.slice(state.ledger.length);
    for (const e of newEntries) {
      await tx.ledgerEntry.create({
        data: {
          id: e.id,
          userId,
          type: e.type,
          date: e.date,
          ts: new Date(e.ts),
          amountUsd: e.amountUSD ?? null,
          description: e.description ?? null,
          localAmount: e.localAmount ?? null,
          localCurrency: e.localCurrency ?? null,
          parentId: e.parentId ?? null,
          subId: e.subId ?? null,
          note: e.note ?? null,
        },
      });
    }

    // Committed — upsert by (userId, nameKey)
    for (const [nameKey, c] of Object.entries(newState.committed)) {
      await tx.committedItem.upsert({
        where: { userId_nameKey: { userId, nameKey } },
        update: {
          name: c.name,
          amountUsd: c.amountUSD,
          frequency: c.frequency,
          nextDate: c.nextDate,
          autoPay: c.autoPay,
          paidThisCycle: c.paidThisCycle,
          active: c.active,
          parkedForNextCycle: c.parkedForNextCycle,
        },
        create: {
          userId,
          nameKey,
          name: c.name,
          amountUsd: c.amountUSD,
          frequency: c.frequency,
          nextDate: c.nextDate,
          autoPay: c.autoPay,
          paidThisCycle: c.paidThisCycle,
          active: c.active,
          parkedForNextCycle: c.parkedForNextCycle,
        },
      });
    }

    // Envelopes — upsert by (userId, nameKey)
    for (const [nameKey, e] of Object.entries(newState.envelopes)) {
      await tx.envelope.upsert({
        where: { userId_nameKey: { userId, nameKey } },
        update: {
          name: e.name,
          type: e.type,
          allocatedUsd: e.allocatedUSD,
          dailyAmountUsd: e.dailyAmountUSD ?? null,
          linkedParentId: e.linkedParentId ?? null,
          linkedSubIds: e.linkedSubIds ? JSON.stringify(e.linkedSubIds) : null,
          reserveFromPool: e.reserveFromPool,
          rollover: e.rollover,
          resetOnIncome: e.resetOnIncome,
          active: e.active,
        },
        create: {
          userId,
          nameKey,
          name: e.name,
          type: e.type,
          allocatedUsd: e.allocatedUSD,
          dailyAmountUsd: e.dailyAmountUSD ?? null,
          linkedParentId: e.linkedParentId ?? null,
          linkedSubIds: e.linkedSubIds ? JSON.stringify(e.linkedSubIds) : null,
          reserveFromPool: e.reserveFromPool,
          rollover: e.rollover,
          resetOnIncome: e.resetOnIncome,
          active: e.active,
        },
      });
    }

    // Cycle — upsert one row per user
    if (newState.cycle) {
      await tx.userCycle.upsert({
        where: { userId },
        update: {
          startDate: newState.cycle.start,
          payday: newState.cycle.payday,
          expectedIncomeUsd: newState.cycle.expectedIncomeUSD,
          savingRate: newState.cycle.savingRate,
          savingsUsd: newState.savings || 0,
        },
        create: {
          userId,
          startDate: newState.cycle.start,
          payday: newState.cycle.payday,
          expectedIncomeUsd: newState.cycle.expectedIncomeUSD,
          savingRate: newState.cycle.savingRate,
          savingsUsd: newState.savings || 0,
        },
      });
    }

    // Location — upsert one row per user
    if (newState.location) {
      await tx.userLocation.upsert({
        where: { userId },
        update: {
          spendCurrency: newState.location.spendCurrency,
          symbol: newState.location.symbol,
          localRate: newState.location.localRate,
          name: newState.location.name,
          flag: newState.location.flag,
          rateUpdated: newState.location.rateUpdated ?? null,
          lastDiff: newState.lastDiff ?? null,
        },
        create: {
          userId,
          spendCurrency: newState.location.spendCurrency,
          symbol: newState.location.symbol,
          localRate: newState.location.localRate,
          name: newState.location.name,
          flag: newState.location.flag,
          rateUpdated: newState.location.rateUpdated ?? null,
          lastDiff: newState.lastDiff ?? null,
        },
      });
    }
  });

  return newState;
}

// ── GET OR CREATE USER ─────────────────────────────────────────────────────────
async function getOrCreateUser(prisma, telegramId) {
  return prisma.user.upsert({
    where: { telegramId: String(telegramId) },
    update: {},
    create: { telegramId: String(telegramId) },
  });
}

// ── GET ALL USERS ──────────────────────────────────────────────────────────────
// Used by cron jobs to send proactive messages to all users.
async function getAllUsers(prisma) {
  return prisma.user.findMany({ select: { id: true, telegramId: true } });
}

module.exports = { getState, saveAction, getOrCreateUser, getAllUsers };
