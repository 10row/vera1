"use strict";

// server/db/queries.js — v2 Database helpers
// Reads/writes the v2 schema (User, Drain, Pool, Transaction, MonthlySummary, CycleSummary, Message).
// All amounts in INTEGER CENTS.

const v2 = require("../vera-v2");

// ── LOAD STATE ───────────────────────────────────────────────────────
// Assembles a full v2 engine state object from the database.
async function loadState(prisma, userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      drains: true,
      pools: true,
      transactions: { orderBy: { createdAt: "asc" } },
      monthlies: true,
      cycles: { orderBy: { createdAt: "asc" } },
      messages: { orderBy: { createdAt: "asc" }, take: 40 },
    },
  });

  if (!user) return v2.createFreshState();

  // Rebuild drains as key->object map
  const drains = {};
  for (const d of user.drains) {
    drains[d.key] = {
      name: d.name,
      amountCents: d.amountCents,
      intervalDays: d.intervalDays,
      nextDate: d.nextDate,
      active: d.active,
    };
  }

  // Rebuild pools as key->object map
  const pools = {};
  for (const p of user.pools) {
    pools[p.key] = {
      name: p.name,
      type: p.type,
      dailyCents: p.dailyCents,
      allocatedCents: p.allocatedCents,
      keywords: p.keywords || [],
      spentCents: p.spentCents,
      active: p.active,
    };
  }

  // Rebuild transactions as array
  const transactions = user.transactions.map(tx => ({
    id: tx.id,
    type: tx.type,
    amountCents: tx.amountCents,
    description: tx.description,
    node: tx.node,
    date: tx.date,
    ts: tx.createdAt.getTime(),
  }));

  // Rebuild monthly summaries as nested map
  const monthlySummaries = {};
  for (const m of user.monthlies) {
    if (!monthlySummaries[m.month]) monthlySummaries[m.month] = {};
    monthlySummaries[m.month][m.poolKey] = {
      spent: m.spentCents,
      earned: m.earnedCents,
      count: m.txCount,
    };
  }

  // Rebuild cycle history as array
  const cycleHistory = user.cycles.map(c => ({
    cycleStart: c.cycleStart,
    cycleEnd: c.cycleEnd,
    incomeCents: c.incomeCents,
    totalSpentCents: c.totalSpentCents,
    savedCents: c.savedCents,
    poolSpend: c.poolSpend || {},
    drainsPaid: c.drainsPaid || {},
    txCount: c.txCount,
    daysInCycle: c.daysInCycle,
    avgDailySpend: c.avgDailySpend,
  }));

  // Rebuild conversation history
  const conversationHistory = user.messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  return {
    setup: user.setup,
    balanceCents: user.balanceCents,
    incomeCents: user.incomeCents,
    savingsCents: user.savingsCents,
    savingRateBps: user.savingRateBps,
    payday: user.payday,
    cycleStart: user.cycleStart,
    currency: user.currency,
    currencySymbol: user.currencySymbol,
    drains,
    pools,
    plannedPurchases: {},  // TODO: add PlannedPurchase model if needed
    transactions,
    conversationHistory,
    monthlySummaries,
    cycleHistory,
  };
}

// ── SAVE STATE ───────────────────────────────────────────────────────
// Persists the full state back to the database atomically.
async function saveState(prisma, userId, state) {
  await prisma.$transaction(async (tx) => {
    // 1. Update user core fields
    await tx.user.update({
      where: { id: userId },
      data: {
        setup: state.setup,
        balanceCents: state.balanceCents,
        incomeCents: state.incomeCents,
        savingsCents: state.savingsCents,
        savingRateBps: state.savingRateBps,
        payday: state.payday,
        cycleStart: state.cycleStart,
        currency: state.currency,
        currencySymbol: state.currencySymbol,
      },
    });

    // 2. Sync drains — upsert active, deactivate removed
    for (const [key, d] of Object.entries(state.drains)) {
      await tx.drain.upsert({
        where: { userId_key: { userId, key } },
        update: {
          name: d.name,
          amountCents: d.amountCents,
          intervalDays: d.intervalDays || 30,
          nextDate: d.nextDate || null,
          active: d.active !== false,
        },
        create: {
          userId, key,
          name: d.name,
          amountCents: d.amountCents,
          intervalDays: d.intervalDays || 30,
          nextDate: d.nextDate || null,
          active: d.active !== false,
        },
      });
    }

    // 3. Sync pools
    for (const [key, p] of Object.entries(state.pools)) {
      await tx.pool.upsert({
        where: { userId_key: { userId, key } },
        update: {
          name: p.name,
          type: p.type || "daily",
          dailyCents: p.dailyCents || 0,
          allocatedCents: p.allocatedCents || 0,
          keywords: p.keywords || [],
          spentCents: p.spentCents || 0,
          active: p.active !== false,
        },
        create: {
          userId, key,
          name: p.name,
          type: p.type || "daily",
          dailyCents: p.dailyCents || 0,
          allocatedCents: p.allocatedCents || 0,
          keywords: p.keywords || [],
          spentCents: p.spentCents || 0,
          active: p.active !== false,
        },
      });
    }

    // 4. Append new transactions (compare by ID)
    const existingTxIds = new Set(
      (await tx.transaction.findMany({ where: { userId }, select: { id: true } }))
        .map(t => t.id)
    );
    for (const t of state.transactions) {
      if (!existingTxIds.has(t.id)) {
        await tx.transaction.create({
          data: {
            id: t.id,
            userId,
            type: t.type,
            amountCents: t.amountCents,
            description: t.description || "",
            node: t.node || null,
            date: t.date,
          },
        });
      }
    }

    // 5. Sync monthly summaries
    for (const [month, pools] of Object.entries(state.monthlySummaries)) {
      for (const [poolKey, data] of Object.entries(pools)) {
        await tx.monthlySummary.upsert({
          where: { userId_month_poolKey: { userId, month, poolKey } },
          update: {
            spentCents: data.spent || 0,
            earnedCents: data.earned || 0,
            txCount: data.count || 0,
          },
          create: {
            userId, month, poolKey,
            spentCents: data.spent || 0,
            earnedCents: data.earned || 0,
            txCount: data.count || 0,
          },
        });
      }
    }

    // 6. Sync cycle history — delete old, write current list
    await tx.cycleSummary.deleteMany({ where: { userId } });
    for (const c of state.cycleHistory) {
      await tx.cycleSummary.create({
        data: {
          userId,
          cycleStart: c.cycleStart,
          cycleEnd: c.cycleEnd,
          incomeCents: c.incomeCents,
          totalSpentCents: c.totalSpentCents,
          savedCents: c.savedCents,
          poolSpend: c.poolSpend || {},
          drainsPaid: c.drainsPaid || {},
          txCount: c.txCount,
          daysInCycle: c.daysInCycle,
          avgDailySpend: c.avgDailySpend,
        },
      });
    }
  });
}

// ── SAVE MESSAGES ────────────────────────────────────────────────────
async function saveMessages(prisma, userId, history) {
  // Keep last 40 messages. Delete old, insert new.
  await prisma.message.deleteMany({ where: { userId } });
  const keep = history.slice(-40);
  for (const m of keep) {
    await prisma.message.create({
      data: { userId, role: m.role, content: m.content },
    });
  }
}

// ── GET OR CREATE USER (by webToken) ─────────────────────────────────
async function getOrCreateWebUser(prisma, webToken) {
  let user = await prisma.user.findUnique({ where: { webToken } });
  if (!user) {
    user = await prisma.user.create({ data: { webToken } });
  }
  return user;
}

module.exports = { loadState, saveState, saveMessages, getOrCreateWebUser };
