"use strict";

// server/db/queries.js — v2 Database helpers
// All amounts in INTEGER CENTS.

const v2 = require("../vera-v2");

// ── PER-USER MUTEX ───────────────────────────────────────────────────
// Prevents concurrent load-process-save from clobbering each other.
const locks = new Map();
async function withUserLock(userId, fn) {
  while (locks.get(userId)) {
    await locks.get(userId);
  }
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  locks.set(userId, promise);
  try {
    return await fn();
  } finally {
    locks.delete(userId);
    resolve();
  }
}

// ── LOAD STATE ───────────────────────────────────────────────────────
async function loadState(prisma, userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      drains: true,
      pools: true,
      plannedPurchases: true,
      transactions: { orderBy: { createdAt: "asc" } },
      monthlies: true,
      cycles: { orderBy: { createdAt: "asc" } },
      messages: { orderBy: { createdAt: "asc" }, take: 40 },
    },
  });

  if (!user) return v2.createFreshState();

  const drains = {};
  for (const d of user.drains) {
    drains[d.key] = {
      name: d.name, amountCents: d.amountCents, intervalDays: d.intervalDays,
      nextDate: d.nextDate, active: d.active,
    };
  }

  const pools = {};
  for (const p of user.pools) {
    pools[p.key] = {
      name: p.name, type: p.type, dailyCents: p.dailyCents,
      allocatedCents: p.allocatedCents, keywords: p.keywords || [],
      spentCents: p.spentCents, active: p.active,
    };
  }

  const plannedPurchases = {};
  for (const pp of user.plannedPurchases) {
    plannedPurchases[pp.key] = {
      name: pp.name, amountCents: pp.amountCents, date: pp.date,
      confirmed: pp.confirmed, active: pp.active,
    };
  }

  const transactions = user.transactions.map(tx => ({
    id: tx.id, type: tx.type, amountCents: tx.amountCents,
    description: tx.description, node: tx.node, date: tx.date,
    ts: tx.createdAt.getTime(),
  }));

  const monthlySummaries = {};
  for (const m of user.monthlies) {
    if (!monthlySummaries[m.month]) monthlySummaries[m.month] = {};
    monthlySummaries[m.month][m.poolKey] = { spent: m.spentCents, earned: m.earnedCents, count: m.txCount };
  }

  const cycleHistory = user.cycles.map(c => ({
    cycleStart: c.cycleStart, cycleEnd: c.cycleEnd, incomeCents: c.incomeCents,
    totalSpentCents: c.totalSpentCents, savedCents: c.savedCents,
    poolSpend: c.poolSpend || {}, drainsPaid: c.drainsPaid || {},
    txCount: c.txCount, daysInCycle: c.daysInCycle, avgDailySpend: c.avgDailySpend,
  }));

  const conversationHistory = user.messages.map(m => ({ role: m.role, content: m.content }));

  return {
    setup: user.setup, balanceCents: user.balanceCents, incomeCents: user.incomeCents,
    savingsCents: user.savingsCents, savingRateBps: user.savingRateBps,
    payday: user.payday, cycleStart: user.cycleStart,
    currency: user.currency, currencySymbol: user.currencySymbol, localRate: user.localRate,
    drains, pools, plannedPurchases, transactions,
    conversationHistory, monthlySummaries, cycleHistory,
  };
}

// ── SAVE STATE ───────────────────────────────────────────────────────
async function saveState(prisma, userId, state) {
  await prisma.$transaction(async (tx) => {
    // 1. User core fields
    await tx.user.update({
      where: { id: userId },
      data: {
        setup: state.setup, balanceCents: state.balanceCents,
        incomeCents: state.incomeCents, savingsCents: state.savingsCents,
        savingRateBps: state.savingRateBps, payday: state.payday,
        cycleStart: state.cycleStart, currency: state.currency,
        currencySymbol: state.currencySymbol, localRate: state.localRate || 100,
      },
    });

    // 2. Drains
    for (const [key, d] of Object.entries(state.drains)) {
      await tx.drain.upsert({
        where: { userId_key: { userId, key } },
        update: { name: d.name, amountCents: d.amountCents, intervalDays: d.intervalDays || 30, nextDate: d.nextDate || null, active: d.active !== false },
        create: { userId, key, name: d.name, amountCents: d.amountCents, intervalDays: d.intervalDays || 30, nextDate: d.nextDate || null, active: d.active !== false },
      });
    }

    // 3. Pools
    for (const [key, p] of Object.entries(state.pools)) {
      await tx.pool.upsert({
        where: { userId_key: { userId, key } },
        update: { name: p.name, type: p.type || "daily", dailyCents: p.dailyCents || 0, allocatedCents: p.allocatedCents || 0, keywords: p.keywords || [], spentCents: p.spentCents || 0, active: p.active !== false },
        create: { userId, key, name: p.name, type: p.type || "daily", dailyCents: p.dailyCents || 0, allocatedCents: p.allocatedCents || 0, keywords: p.keywords || [], spentCents: p.spentCents || 0, active: p.active !== false },
      });
    }

    // 4. Planned Purchases
    for (const [key, pp] of Object.entries(state.plannedPurchases || {})) {
      await tx.plannedPurchase.upsert({
        where: { userId_key: { userId, key } },
        update: { name: pp.name, amountCents: pp.amountCents, date: pp.date || null, confirmed: pp.confirmed || false, active: pp.active !== false },
        create: { userId, key, name: pp.name, amountCents: pp.amountCents, date: pp.date || null, confirmed: pp.confirmed || false, active: pp.active !== false },
      });
    }

    // 5. Transactions (append only)
    const existingTxIds = new Set(
      (await tx.transaction.findMany({ where: { userId }, select: { id: true } })).map(t => t.id)
    );
    for (const t of state.transactions) {
      if (!existingTxIds.has(t.id)) {
        await tx.transaction.create({
          data: { id: t.id, userId, type: t.type, amountCents: t.amountCents, description: t.description || "", node: t.node || null, date: t.date },
        });
      }
    }

    // 6. Monthly summaries
    for (const [month, pools] of Object.entries(state.monthlySummaries)) {
      for (const [poolKey, data] of Object.entries(pools)) {
        await tx.monthlySummary.upsert({
          where: { userId_month_poolKey: { userId, month, poolKey } },
          update: { spentCents: data.spent || 0, earnedCents: data.earned || 0, txCount: data.count || 0 },
          create: { userId, month, poolKey, spentCents: data.spent || 0, earnedCents: data.earned || 0, txCount: data.count || 0 },
        });
      }
    }

    // 7. Cycle history
    await tx.cycleSummary.deleteMany({ where: { userId } });
    for (const c of state.cycleHistory) {
      await tx.cycleSummary.create({
        data: { userId, cycleStart: c.cycleStart, cycleEnd: c.cycleEnd, incomeCents: c.incomeCents,
          totalSpentCents: c.totalSpentCents, savedCents: c.savedCents,
          poolSpend: c.poolSpend || {}, drainsPaid: c.drainsPaid || {},
          txCount: c.txCount, daysInCycle: c.daysInCycle, avgDailySpend: c.avgDailySpend },
      });
    }

    // 8. Messages (inside same transaction — atomic)
    await tx.message.deleteMany({ where: { userId } });
    const keep = (state.conversationHistory || []).slice(-40);
    for (const m of keep) {
      await tx.message.create({ data: { userId, role: m.role, content: m.content } });
    }
  });
}

// ── GET OR CREATE USER (by webToken) ─────────────────────────────────
async function getOrCreateWebUser(prisma, webToken) {
  let user = await prisma.user.findUnique({ where: { webToken } });
  if (!user) user = await prisma.user.create({ data: { webToken } });
  return user;
}

module.exports = { loadState, saveState, getOrCreateWebUser, withUserLock };
