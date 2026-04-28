"use strict";

// server/db/queries.js — V3 Database helpers (envelope-based)
// All amounts in INTEGER CENTS.

const v3 = require("../vera-v3");

// ── PER-USER MUTEX ──────────────────────────────
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

// ── LOAD STATE ──────────────────────────────────
async function loadState(prisma, userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      envelopes: true,
      transactions: { orderBy: { createdAt: "desc" }, take: 500 },
      monthlies: true,
      cycles: { orderBy: { createdAt: "asc" } },
      messages: {
        orderBy: { createdAt: "asc" },
        take: 40,
      },
    },
  });

  if (!user) return v3.createFreshState();

  const envelopes = {};
  for (const e of user.envelopes) {
    envelopes[e.key] = {
      name: e.name,
      rhythm: e.rhythm,
      amountCents: e.amountCents,
      targetCents: e.targetCents,
      fundedCents: e.fundedCents,
      spentCents: e.spentCents,
      fundRate: e.fundRate,
      fundAmountCents: e.fundAmountCents,
      intervalDays: e.intervalDays,
      nextDate: e.nextDate,
      keywords: e.keywords || [],
      priority: e.priority,
      active: e.active,
    };
  }

  const transactions = user.transactions.reverse().map(tx => ({
    id: tx.id,
    type: tx.type,
    amountCents: tx.amountCents,
    description: tx.description,
    envelope: tx.envelope,
    date: tx.date,
    ts: tx.createdAt.getTime(),
  }));

  const monthlySummaries = {};
  for (const m of user.monthlies) {
    if (!monthlySummaries[m.month]) {
      monthlySummaries[m.month] = {};
    }
    monthlySummaries[m.month][m.envelopeKey] = {
      spent: m.spentCents,
      earned: m.earnedCents,
      count: m.txCount,
    };
  }

  const cycleHistory = user.cycles.map(c => ({
    cycleStart: c.cycleStart,
    cycleEnd: c.cycleEnd,
    incomeCents: c.incomeCents,
    totalSpentCents: c.totalSpentCents,
    savedCents: c.savedCents,
    envSpend: c.envelopeSpend || {},
    txCount: c.txCount,
    daysInCycle: c.daysInCycle,
    avgDailySpend: c.avgDailySpend,
  }));

  const conversationHistory = user.messages.map(m => ({
    role: m.role, content: m.content,
  }));

  return {
    setup: user.setup,
    balanceCents: user.balanceCents,
    payday: user.payday,
    cycleStart: user.cycleStart,
    currency: user.currency,
    currencySymbol: user.currencySymbol,
    language: user.language || "en",
    timezone: user.timezone || "UTC",
    envelopes,
    transactions,
    conversationHistory,
    monthlySummaries,
    cycleHistory,
    undoSnapshot: null,
  };
}

// ── SAVE STATE ──────────────────────────────────
async function saveState(prisma, userId, state) {
  await prisma.$transaction(async (tx) => {
    // 1. User core fields
    await tx.user.update({
      where: { id: userId },
      data: {
        setup: state.setup,
        balanceCents: state.balanceCents,
        payday: state.payday,
        cycleStart: state.cycleStart,
        currency: state.currency,
        currencySymbol: state.currencySymbol,
        language: state.language || "en",
        timezone: state.timezone || "UTC",
      },
    });

    // 2. Envelopes
    for (const [key, e] of Object.entries(state.envelopes)) {
      await tx.envelope.upsert({
        where: { userId_key: { userId, key } },
        update: {
          name: e.name,
          rhythm: e.rhythm || "monthly",
          amountCents: e.amountCents || 0,
          targetCents: e.targetCents || null,
          fundedCents: e.fundedCents || 0,
          spentCents: e.spentCents || 0,
          fundRate: e.fundRate || null,
          fundAmountCents: e.fundAmountCents || null,
          intervalDays: e.intervalDays || 30,
          nextDate: e.nextDate || null,
          keywords: e.keywords || [],
          priority: e.priority || "flexible",
          active: e.active !== false,
        },
        create: {
          userId, key,
          name: e.name,
          rhythm: e.rhythm || "monthly",
          amountCents: e.amountCents || 0,
          targetCents: e.targetCents || null,
          fundedCents: e.fundedCents || 0,
          spentCents: e.spentCents || 0,
          fundRate: e.fundRate || null,
          fundAmountCents: e.fundAmountCents || null,
          intervalDays: e.intervalDays || 30,
          nextDate: e.nextDate || null,
          keywords: e.keywords || [],
          priority: e.priority || "flexible",
          active: e.active !== false,
        },
      });
    }

    // 3. Transactions (append + update + delete)
    const existing = await tx.transaction.findMany({
      where: { userId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map(t => t.id));
    const stateIds = new Set(state.transactions.map(t => t.id));
    // Delete transactions removed from state (delete_spend)
    for (const eid of existingIds) {
      if (!stateIds.has(eid)) {
        await tx.transaction.delete({ where: { id: eid } });
      }
    }
    for (const t of state.transactions) {
      if (!existingIds.has(t.id)) {
        // New transaction — create
        await tx.transaction.create({
          data: {
            id: t.id, userId, type: t.type,
            amountCents: t.amountCents,
            description: t.description || "",
            envelope: t.envelope || null,
            date: t.date,
          },
        });
      } else {
        // Existing transaction — update (edit_spend may have changed fields)
        await tx.transaction.update({
          where: { id: t.id },
          data: {
            amountCents: t.amountCents,
            description: t.description || "",
            envelope: t.envelope || null,
          },
        });
      }
    }

    // 4. Monthly summaries
    const ms = state.monthlySummaries;
    for (const [month, envelopes] of Object.entries(ms)) {
      for (const [envelopeKey, data] of Object.entries(envelopes)) {
        await tx.monthlySummary.upsert({
          where: {
            userId_month_envelopeKey: {
              userId, month, envelopeKey,
            },
          },
          update: {
            spentCents: data.spent || 0,
            earnedCents: data.earned || 0,
            txCount: data.count || 0,
          },
          create: {
            userId, month, envelopeKey,
            spentCents: data.spent || 0,
            earnedCents: data.earned || 0,
            txCount: data.count || 0,
          },
        });
      }
    }

    // 5. Cycle history
    await tx.cycleSummary.deleteMany({
      where: { userId },
    });
    for (const c of state.cycleHistory) {
      await tx.cycleSummary.create({
        data: {
          userId,
          cycleStart: c.cycleStart,
          cycleEnd: c.cycleEnd,
          incomeCents: c.incomeCents || 0,
          totalSpentCents: c.totalSpentCents,
          savedCents: c.savedCents || 0,
          envelopeSpend: c.envSpend || {},
          txCount: c.txCount,
          daysInCycle: c.daysInCycle,
          avgDailySpend: c.avgDailySpend,
        },
      });
    }

    // 6. Messages (atomic)
    await tx.message.deleteMany({
      where: { userId },
    });
    const ch = state.conversationHistory || [];
    const keep = ch.slice(-40);
    for (const m of keep) {
      await tx.message.create({
        data: {
          userId, role: m.role,
          content: m.content,
        },
      });
    }
  });
}

// ── GET OR CREATE USER ──────────────────────────
async function getOrCreateWebUser(prisma, webToken) {
  let user = await prisma.user.findUnique({
    where: { webToken },
  });
  if (!user) {
    user = await prisma.user.create({
      data: { webToken },
    });
  }
  return user;
}

module.exports = {
  loadState, saveState,
  getOrCreateWebUser, withUserLock,
};
