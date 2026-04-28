"use strict";
// v4/db.js — Prisma adapter for v4 state.
// Stores entire v4 state as a JSON column on User. Per-user mutex prevents races.
// Independent of v3 columns; existing v3 data is preserved but unused.

const m = require("./model");

// Per-user mutex (in-memory; per-process is fine for one Railway dyno).
const locks = new Map();
async function withUserLock(userId, fn) {
  while (locks.get(userId)) await locks.get(userId);
  let resolve;
  const p = new Promise(r => { resolve = r; });
  locks.set(userId, p);
  try { return await fn(); }
  finally { locks.delete(userId); resolve(); }
}

// Resolve a session id (telegramId-prefixed) to a User row, creating if needed.
async function resolveUser(prisma, sid) {
  if (!sid) throw new Error("resolveUser: sid required");
  if (sid.startsWith("tg_")) {
    const tid = sid.slice(3);
    let u = await prisma.user.findUnique({ where: { telegramId: tid } });
    if (!u) u = await prisma.user.create({ data: { telegramId: tid } });
    return u;
  }
  // Web fallback (token-based) — match v3 helper behaviour.
  let u = await prisma.user.findUnique({ where: { webToken: sid } });
  if (!u) u = await prisma.user.create({ data: { webToken: sid } });
  return u;
}

// Load v4 state for a user. Returns a fresh state if not yet initialised.
// Always returns a complete state object — never null.
async function loadState(prisma, userId) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { v4State: true },
  });
  if (!u || !u.v4State) return m.createFreshState();
  // Defensive: if somehow malformed JSON, fall back to fresh.
  if (typeof u.v4State !== "object" || !u.v4State.schema) return m.createFreshState();
  return u.v4State;
}

async function saveState(prisma, userId, state) {
  // Trim events to last 1000 (audit log; rolls forward indefinitely otherwise).
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
  // Keep only last 20 messages (10 exchanges) for prompt budget.
  const trimmed = hist.slice(-20);
  await prisma.user.update({
    where: { id: userId },
    data: { v4History: trimmed },
  });
  return trimmed;
}

module.exports = { withUserLock, resolveUser, loadState, saveState, loadHistory, appendHistory };
