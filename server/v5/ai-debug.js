"use strict";
// ai-debug.js — last-AI-output ring buffer, keyed by user id. Production
// dev tool: `/debug` reads recent raw AI responses without asking the
// user to retest in Telegram. Cross-module so ai.js can record and
// bot.js can read.

const RING_SIZE = 5;
const _byUser = new Map();

function recordAiRaw(userId, raw) {
  if (userId == null) return;
  const arr = _byUser.get(userId) || [];
  arr.push({ ts: Date.now(), raw: typeof raw === "string" ? raw : JSON.stringify(raw) });
  if (arr.length > RING_SIZE) arr.shift();
  _byUser.set(userId, arr);
}

function getAiRaw(userId) {
  return _byUser.get(userId) || [];
}

module.exports = { recordAiRaw, getAiRaw };
