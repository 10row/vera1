"use strict";
// v4/model.js — domain types, helpers, fresh state.
// Pure module: no I/O, no side effects.
// All money is integer cents. All dates are ISO YYYY-MM-DD strings.

const crypto = require("crypto");

// ── MONEY ─────────────────────────────────────────────────────
// toCents accepts a number or numeric string. Throws on non-finite.
// Caller is responsible for trusting strings only from controlled sources;
// the LLM must never write strings here directly — validator strips them.
function toCents(v) {
  if (v == null) return 0;
  let n;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.\-]/g, "");
    n = parseFloat(cleaned);
  } else if (typeof v === "number") {
    n = v;
  } else {
    throw new Error("toCents: expected number or string, got " + typeof v);
  }
  if (!Number.isFinite(n)) throw new Error("toCents: non-finite: " + v);
  return Math.round(n * 100);
}

function toMoney(cents, sym) {
  const s = sym || "$";
  if (cents == null) return s + "0.00";
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const change = String(abs % 100).padStart(2, "0");
  return (neg ? "-" : "") + s + dollars + "." + change;
}

function toShort(cents, sym) {
  const m = toMoney(cents, sym);
  return m.endsWith(".00") ? m.slice(0, -3) : m;
}

// ── DATES ─────────────────────────────────────────────────────
function today(tz) {
  const t = tz || "UTC";
  if (t === "UTC") return new Date().toISOString().slice(0, 10);
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: t });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// daysBetween returns signed integer days from a to b.
// daysBetween("2025-01-01", "2025-01-04") === 3
function daysBetween(a, b) {
  if (!a || !b) return 0;
  const d1 = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const d2 = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((d2 - d1) / 86400000);
}

function daysUntil(date, tz) {
  if (!date) return 0;
  return daysBetween(today(tz), date);
}

// Strict date validator. Returns ISO string or null.
// Round-trips so "2024-02-30" is rejected (would otherwise become 2024-03-01).
function normalizeDate(d) {
  if (!d) return null;
  if (typeof d !== "string") d = String(d);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (m) {
    const dt = new Date(d + "T00:00:00Z");
    if (isNaN(dt.getTime())) return null;
    if (dt.toISOString().slice(0, 10) !== d) return null;
    return d;
  }
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

function addDays(date, n) {
  const y = +date.slice(0, 4), mo = +date.slice(5, 7) - 1, da = +date.slice(8, 10);
  const dt = new Date(Date.UTC(y, mo, da + n));
  return dt.toISOString().slice(0, 10);
}

// Advance payday past today by frequency.
// Monthly is calendar-aware (preserves day-of-month, clamping for short months).
function advancePayday(payday, freq, todayStr) {
  if (!payday) return null;
  if (freq === "irregular") return payday;
  if (freq === "monthly" || !freq) {
    let dt = new Date(payday + "T00:00:00Z");
    const dom = dt.getUTCDate();
    while (dt.toISOString().slice(0, 10) <= todayStr) {
      dt.setUTCDate(1); // avoid overflow when month has fewer days
      dt.setUTCMonth(dt.getUTCMonth() + 1);
      const lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
      dt.setUTCDate(Math.min(dom, lastDay));
    }
    return dt.toISOString().slice(0, 10);
  }
  const step = freq === "weekly" ? 7 : freq === "biweekly" ? 14 : 30;
  let cur = payday;
  while (cur <= todayStr) cur = addDays(cur, step);
  return cur;
}

// ── DOMAIN CONSTANTS ─────────────────────────────────────────
const ENVELOPE_KINDS = ["bill", "budget", "goal"];
// Real humans have bills on cycles other than monthly: car insurance every
// 6 months, gym quarterly, annual subscriptions, weekly groceries. Cover them.
const RECURRENCES = ["once", "weekly", "biweekly", "monthly", "quarterly", "semiannual", "annual"];
const PAY_FREQS = ["weekly", "biweekly", "monthly", "irregular"];

const TX_KINDS = ["setup", "spend", "refund", "income", "bill_payment", "correction"];

// ── KEYS / IDs ───────────────────────────────────────────────
function ekey(name) {
  return String(name || "").toLowerCase().trim().replace(/\s+/g, "_").slice(0, 60);
}

function uid() {
  return crypto.randomBytes(12).toString("hex");
}

// ── FRESH STATE ──────────────────────────────────────────────
function createFreshState() {
  return {
    schema: "v4",
    setup: false,
    balanceCents: 0,
    currency: "USD",
    currencySymbol: "$",
    language: "en",
    timezone: "UTC",
    payday: null,
    payFrequency: null,
    envelopes: {},        // keyed by ekey(name)
    transactions: [],     // append-only [{ id, ts, kind, amountCents, note, envelopeKey, date }]
    events: [],           // append-only audit log [{ id, ts, intent, prevBalance, newBalance, ... }]
    voiceReplies: false,  // when true and incoming message was voice, also send a voice reply
  };
}

module.exports = {
  toCents, toMoney, toShort,
  today, daysBetween, daysUntil, normalizeDate, addDays, advancePayday,
  ENVELOPE_KINDS, RECURRENCES, PAY_FREQS, TX_KINDS,
  ekey, uid,
  createFreshState,
};
