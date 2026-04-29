"use strict";
// v5/db.js — Prisma adapter. Stores v5 state in the v4State JSON column
// (same column, fresh schema marker — v5 ignores anything that's not v5).
//
// Per-user mutex prevents races within a single process.

const m = require("./model");

const locks = new Map();
async function withUserLock(userId, fn) {
  while (locks.get(userId)) await locks.get(userId);
  let resolve;
  const p = new Promise(r => { resolve = r; });
  locks.set(userId, p);
  try { return await fn(); }
  finally { locks.delete(userId); resolve(); }
}

async function resolveUser(prisma, sid) {
  if (!sid) throw new Error("resolveUser: sid required");
  if (sid.startsWith("tg_")) {
    const tid = sid.slice(3);
    let u = await prisma.user.findUnique({ where: { telegramId: tid } });
    if (!u) u = await prisma.user.create({ data: { telegramId: tid } });
    return u;
  }
  let u = await prisma.user.findUnique({ where: { webToken: sid } });
  if (!u) u = await prisma.user.create({ data: { webToken: sid } });
  return u;
}

async function loadState(prisma, userId) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { v4State: true },
  });
  if (!u || !u.v4State) return m.createFreshState();
  // Treat anything that's not v5 as a fresh start. Prior v3/v4 users will
  // re-onboard. Live data was v3 + small v4 set; clean break is acceptable.
  if (typeof u.v4State !== "object" || u.v4State.schema !== "v5") {
    return m.createFreshState();
  }
  return u.v4State;
}

async function saveState(prisma, userId, state) {
  // Trim event log to last 1000 entries.
  if (Array.isArray(state.events) && state.events.length > 1000) {
    state.events = state.events.slice(-1000);
  }
  await prisma.user.update({
    where: { id: userId },
    data: { v4State: state },
  });
}

async function loadHistory(prisma, userId) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { v4History: true },
  });
  if (!u || !Array.isArray(u.v4History)) return [];
  return u.v4History;
}

async function appendHistory(prisma, userId, role, content) {
  const hist = await loadHistory(prisma, userId);
  hist.push({ role, content });
  // Keep last 16 messages.
  const trimmed = hist.slice(-16);
  await prisma.user.update({
    where: { id: userId },
    data: { v4History: trimmed },
  });
  return trimmed;
}

module.exports = { withUserLock, resolveUser, loadState, saveState, loadHistory, appendHistory };
