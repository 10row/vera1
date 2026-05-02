"use strict";
// v5/model.js — pure types, helpers, fresh state.
// Money is integer cents. Dates are ISO YYYY-MM-DD strings.
// NO I/O, NO side effects.

const crypto = require("crypto");

// ── MONEY ─────────────────────────────────────────
function toCents(v) {
  if (v == null) return 0;
  let n;
  if (typeof v === "string") {
    n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
  } else if (typeof v === "number") {
    n = v;
  } else {
    throw new Error("toCents: expected number or string");
  }
  if (!Number.isFinite(n)) throw new Error("toCents: non-finite");
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

// ── DATES ─────────────────────────────────────────
function today(tz) {
  const t = tz || "UTC";
  if (t === "UTC") return new Date().toISOString().slice(0, 10);
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: t });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

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

function addDays(date, n) {
  const y = +date.slice(0, 4), mo = +date.slice(5, 7) - 1, da = +date.slice(8, 10);
  const dt = new Date(Date.UTC(y, mo, da + n));
  return dt.toISOString().slice(0, 10);
}

// Strict ISO date validator. Returns ISO string or null.
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
  return null;
}

// Advance payday past today. Monthly is calendar-aware.
function advancePayday(payday, freq, todayStr) {
  if (!payday) return null;
  if (freq === "irregular") return payday;
  if (freq === "monthly" || !freq) {
    let dt = new Date(payday + "T00:00:00Z");
    const dom = dt.getUTCDate();
    while (dt.toISOString().slice(0, 10) <= todayStr) {
      dt.setUTCDate(1);
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

// ── DOMAIN ────────────────────────────────────────
const RECURRENCES = ["once", "weekly", "biweekly", "monthly"];
const PAY_FREQS = ["weekly", "biweekly", "monthly", "irregular"];

// All intents we accept. Tight set.
const INTENT_KINDS = [
  "setup_account",   // first-run only (engine still rejects on already-setup)
  "adjust_balance",  // correct balance after a mistake
  "add_bill",        // recurring obligation: rent, phone, etc
  "remove_bill",
  "record_spend",    // money out
  "record_income",   // money in (paycheck, refund)
  "undo_last",       // pop last event
  "reset",           // wipe everything (confirm-gated)
  "update_payday",   // change payday/frequency
];

function billKey(name) {
  return String(name || "").toLowerCase().trim().replace(/\s+/g, "_").slice(0, 60);
}

function uid() {
  return crypto.randomBytes(12).toString("hex");
}

// Escape Telegram Markdown special chars in user-supplied strings.
function escapeMd(s) {
  if (s == null) return "";
  return String(s).replace(/([_*`\[\]])/g, "\\$1");
}

// ── FRESH STATE ───────────────────────────────────
function createFreshState() {
  return {
    schema: "v5",
    setup: false,
    balanceCents: 0,
    currency: "USD",
    currencySymbol: "$",
    language: "en",
    timezone: "UTC",
    payday: null,
    payFrequency: null,
    bills: {},          // keyed by billKey(name): { name, amountCents, dueDate, recurrence, paidThisCycle }
    transactions: [],   // { id, ts, kind, amountCents, note, billKey?, date }
    events: [],         // audit log: { id, ts, intent, prevBalance, newBalance, undid? }
    onboardingDraft: null, // { balanceCents? } during the deterministic flow
    // Daily pace is FROZEN per day per the user's mental model:
    //   "spending eats today's bucket, not the month."
    // Recomputed at: cycle events (setup/adjust/update_payday/bill changes)
    // and at the first state event of a new day (day-rollover).
    // record_spend does NOT recompute — that's the entire point.
    dailyPaceCents: 0,
    dailyPaceComputedDate: null,
  };
}

module.exports = {
  toCents, toMoney, toShort,
  today, daysBetween, daysUntil, addDays, normalizeDate, advancePayday,
  RECURRENCES, PAY_FREQS, INTENT_KINDS,
  billKey, uid, escapeMd,
  createFreshState,
};
