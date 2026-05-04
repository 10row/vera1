"use strict";
// ai-debug.js — last-AI-output ring buffer, keyed by user id. Production
// dev tool: `/debug` reads recent raw AI responses without asking the
// user to retest in Telegram. Cross-module so ai.js can record and
// bot.js can read.

const RING_SIZE = 5;
const _byUser = new Map();
// Side-channel: ad-hoc warnings keyed to the LATEST raw entry. These
// are diagnostic tripwires (e.g. "user said 'yesterday' but AI dropped
// the date") surfaced in /debug so we catch silent AI-compliance
// failures without waiting for the user to notice them in production.
const _warnings = new Map(); // userId → array of latest-batch warnings

function recordAiRaw(userId, raw) {
  if (userId == null) return;
  const arr = _byUser.get(userId) || [];
  arr.push({ ts: Date.now(), raw: typeof raw === "string" ? raw : JSON.stringify(raw) });
  if (arr.length > RING_SIZE) arr.shift();
  _byUser.set(userId, arr);
  // New raw → reset the warnings buffer (warnings attach to the most
  // recent turn only).
  _warnings.set(userId, []);
}

function recordWarning(userId, message) {
  if (userId == null || !message) return;
  const arr = _warnings.get(userId) || [];
  arr.push({ ts: Date.now(), message: String(message).slice(0, 240) });
  _warnings.set(userId, arr);
}

function getAiRaw(userId) {
  return _byUser.get(userId) || [];
}

function getWarnings(userId) {
  return _warnings.get(userId) || [];
}

module.exports = { recordAiRaw, recordWarning, getAiRaw, getWarnings };
