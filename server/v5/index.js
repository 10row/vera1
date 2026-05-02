"use strict";
// v5/index.js — Express + Telegram bot entry point.

require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const prisma = require("../db/client");
const m = require("./model");
const { compute, simulateSpend, heroLine } = require("./view");
const { applyIntent } = require("./engine");
const { validateIntent } = require("./validator");
const db = require("./db");
const { bot, attach } = require("./bot");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "16kb" }));

// ── INITDATA VALIDATION ──────────────────────────
function getBotToken() { return (process.env.BOT_TOKEN || "").trim(); }

function validateInitData(initData) {
  const token = getBotToken();
  if (!initData || !token) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const dcs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + "=" + v).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(token).digest();
    const checkHash = crypto.createHmac("sha256", secretKey).update(dcs).digest("hex");
    if (checkHash !== hash) return null;
    const authDate = parseInt(params.get("auth_date") || "0");
    if (Date.now() / 1000 - authDate > 7 * 24 * 60 * 60) return null;
    const user = params.get("user");
    return user ? JSON.parse(user) : null;
  } catch { return null; }
}

function requireTelegramAuth(req, res, next) {
  const sid = req.params.sid;
  const initData = req.headers["x-telegram-init-data"];
  if (initData) {
    const user = validateInitData(initData);
    if (!user) return res.status(401).json({ error: "Invalid Telegram auth" });
    if (sid && sid.startsWith("tg_")) {
      if (String(user.id) !== sid.slice(3)) return res.status(403).json({ error: "User mismatch" });
    } else {
      req.params.sid = "tg_" + String(user.id);
    }
    req.tgUser = user;
    return next();
  }
  if (sid && sid.startsWith("tg_")) return res.status(401).json({ error: "Missing Telegram auth" });
  next();
}

// ── STATIC ────────────────────────────────────────
app.use("/miniapp", express.static(path.join(__dirname, "../../miniapp")));
app.get("/", (req, res) => res.redirect("/miniapp/"));
app.get("/health", (req, res) => res.json({ status: "ok", schema: "v5", ts: new Date().toISOString() }));

// ── DIAGNOSTIC ────────────────────────────────────
function whoami(req, res) {
  const initData = req.headers["x-telegram-init-data"];
  const token = getBotToken();
  if (!initData) return res.json({ ok: false, why: "no initData" });
  const user = validateInitData(initData);
  res.json({ ok: !!user, user: user || null, hasToken: !!token });
}
app.get("/api/v5/whoami", whoami);
app.get("/api/v4/whoami", whoami);

// ── MINI APP COMPATIBILITY (v4 endpoints, v5 backend) ─────────
// The Mini App was built against v4's view shape. v5 has fewer concepts
// (bills only, no envelopes/budgets/goals split). We translate v5 state
// into the v4-compatible view shape so the Mini App keeps rendering.
function v5ToV4View(state) {
  const view = compute(state); // v5 view
  const sym = state.currencySymbol || "$";
  const todayStr = m.today(state.timezone || "UTC");

  if (!view.setup) return { setup: false, language: state.language || "en", currency: state.currency || "USD", currencySymbol: sym };

  // Map v5 bills → v4 envelopes shape (kind: "bill").
  const envelopes = Object.values(state.bills || {}).map(b => ({
    key: m.billKey(b.name),
    name: b.name,
    kind: "bill",
    amountCents: b.amountCents,
    amountFormatted: m.toMoney(b.amountCents, sym),
    spentCents: 0,
    spentFormatted: m.toMoney(0, sym),
    dueDate: b.dueDate,
    daysUntilDue: m.daysBetween(todayStr, b.dueDate),
    recurrence: b.recurrence,
    paidThisCycle: !!b.paidThisCycle,
    isDue: m.daysBetween(todayStr, b.dueDate) <= 1 && !b.paidThisCycle,
    createdAt: b.createdAt,
  }));

  // Today's remaining = dailyPace - what they've spent today.
  const todayRem = Math.max(0, view.dailyPaceCents - view.todaySpentCents);

  // Variance = today's spend vs today's pace.
  // Positive = under pace (saved). Negative = over pace.
  // Used by hero variance chip (informational only — does NOT change pace).
  const varianceCents = view.dailyPaceCents > 0
    ? (view.dailyPaceCents - view.todaySpentCents)
    : 0;

  return {
    setup: true,
    state: view.status,
    language: state.language || "en",
    currency: state.currency || "USD",
    currencySymbol: sym,
    timezone: state.timezone || "UTC",
    payday: state.payday,
    payFrequency: state.payFrequency,
    daysToPayday: view.daysToPayday,

    balanceCents: view.balanceCents,
    balanceFormatted: view.balanceFormatted,
    balanceShort: m.toShort(view.balanceCents, sym),
    obligatedCents: view.obligatedCents,
    obligatedFormatted: view.obligatedFormatted,
    disposableCents: view.disposableCents,
    disposableFormatted: view.disposableFormatted,
    deficitCents: view.deficitCents,
    deficitFormatted: view.deficitFormatted,
    dailyPaceCents: view.dailyPaceCents,
    dailyPaceFormatted: view.dailyPaceFormatted,
    dailyPaceShort: m.toShort(view.dailyPaceCents, sym),

    todaySpentCents: view.todaySpentCents,
    todaySpentFormatted: view.todaySpentFormatted,
    weekSpentCents: view.weekSpentCents,
    weekSpentFormatted: view.weekSpentFormatted,
    todayRemainingCents: todayRem,
    todayRemainingFormatted: m.toMoney(todayRem, sym),

    // Hero variance chip — under/over today's pace.
    varianceCents,
    varianceShort: m.toShort(Math.abs(varianceCents), sym),

    envelopes,
    dueNow: view.dueNow.map(d => ({ key: d.key, name: d.name, amountFormatted: d.amountFormatted, dueDate: d.dueDate, daysUntilDue: d.daysUntilDue })),
    upcoming: view.upcoming.map(d => ({ key: d.key, name: d.name, amountFormatted: d.amountFormatted, dueDate: d.dueDate, daysUntilDue: d.daysUntilDue })),
    statusWord: view.status,

    invariantOk: true,
  };
}

// buildHeatmap — last-30-days daily spend totals, the shape Mini App
// expects. Each cell: { date: "YYYY-MM-DD", spentCents: N }.
function buildHeatmap(state) {
  const tz = state.timezone || "UTC";
  const today = m.today(tz);
  const out = [];
  // Walk back 29 days (so we get 30 cells ending today).
  // Two bug fixes:
  //   1. The kind value is "spend" (set by engine record_spend), NOT
  //      "record_spend". Old check used the wrong string so the heatmap
  //      never showed any data — long-standing bug.
  //   2. Skip soft-deleted txs (deletedAt set) — same reason as view.
  for (let offset = 29; offset >= 0; offset--) {
    const date = m.addDays(today, -offset);
    let cents = 0;
    for (const t of state.transactions || []) {
      if (t.deletedAt) continue;
      // Discretionary spend only — exclude bill payments (obligations).
      if (t.kind !== "spend") continue;
      if (t.date === date) cents += Math.abs(t.amountCents || 0);
    }
    out.push({ date, spentCents: cents });
  }
  return out;
}

// recentTransactionsForApp — last 50 spends/incomes formatted for the
// feed. Skips soft-deleted (journaling), exposes ALL graph fields so
// the Mini App detail modal can show vendor/category/tags/context/
// foreign-currency without re-fetching.
function recentTransactionsForApp(state) {
  const txs = state.transactions || [];
  return txs.filter(t => !t.deletedAt).slice(-50).reverse().map(t => ({
    id: t.id,
    kind: t.kind,
    amountCents: t.amountCents,
    note: t.note || "",
    envelopeKey: t.billKey || null,
    date: t.date,
    ts: t.ts,
    // Graph fields (any may be null for older or AI-omitted txs).
    vendor: t.vendor || null,
    category: t.category || null,
    tags: t.tags || null,
    context: t.context || null,
    // Foreign-currency display fields.
    originalAmount: t.originalAmount || null,
    originalCurrency: t.originalCurrency || null,
  }));
}

// Mini App GET /api/v4/view/:sid — returns { view, recentTransactions, heatmap }.
// Mini App reads d.view, d.recentTransactions, d.heatmap. Keep that shape.
app.get("/api/v4/view/:sid", requireTelegramAuth, async (req, res) => {
  try {
    const u = await db.resolveUser(prisma, req.params.sid);
    const state = await db.loadState(prisma, u.id);
    const view = v5ToV4View(state);
    res.json({
      view,
      recentTransactions: recentTransactionsForApp(state),
      heatmap: buildHeatmap(state),
    });
  } catch (e) {
    console.error("[v5 v4-view alias]", e);
    res.status(500).json({ error: "Internal" });
  }
});

// Mini App POST /api/v4/action/:sid — body shape: { intent: { kind, params } }.
// Supports the intents Mini App still triggers (pay_bill via "mark paid").
// Anything else returns { ok: false, error: "..." }. Mini App expects
// { ok, view } on success.
app.post("/api/v4/action/:sid", requireTelegramAuth, async (req, res) => {
  try {
    const intent = req.body && req.body.intent;
    if (!intent || !intent.kind) return res.status(400).json({ ok: false, error: "Missing intent" });
    const u = await db.resolveUser(prisma, req.params.sid);
    let result = null;
    await db.withUserLock(u.id, async () => {
      const state = await db.loadState(prisma, u.id);
      // Translate v4 pay_bill → v5 record_spend on the matching bill.
      let translated = intent;
      if (intent.kind === "pay_bill" && intent.params && intent.params.name) {
        const targetKey = m.billKey(intent.params.name);
        const bill = state.bills && state.bills[targetKey];
        if (!bill) { result = { ok: false, error: "no such bill" }; return; }
        translated = {
          kind: "record_spend",
          params: {
            amountCents: bill.amountCents,
            note: bill.name,
            billKey: targetKey,
          },
        };
      }
      const v = validateIntent(state, translated, m.today(state.timezone || "UTC"));
      if (!v.ok) { result = { ok: false, error: v.reason }; return; }
      try {
        const r = applyIntent(state, translated);
        await db.saveState(prisma, u.id, r.state);
        result = {
          ok: true,
          view: v5ToV4View(r.state),
          recentTransactions: recentTransactionsForApp(r.state),
          heatmap: buildHeatmap(r.state),
        };
      } catch (e) {
        result = { ok: false, error: e.message };
      }
    });
    res.json(result);
  } catch (e) {
    console.error("[v5 v4-action alias]", e);
    res.status(500).json({ ok: false, error: "Internal" });
  }
});

// Mini App locale endpoint — uses v4's locale files (still in repo with
// the keys the Mini App expects).
const _v4Locales = require("../v4/locales");
app.get("/api/v4/locale", (req, res) => {
  try {
    const lang = (req.query.lang || "en").toString();
    const base = (_v4Locales.normalizeLang ? _v4Locales.normalizeLang(lang) : "en");
    const strings = (_v4Locales.LOCALES && _v4Locales.LOCALES[base]) || (_v4Locales.LOCALES && _v4Locales.LOCALES.en) || {};
    res.json({ lang: base, strings });
  } catch (e) {
    console.error("[v5 locale alias]", e);
    res.json({ lang: "en", strings: {} });
  }
});

// ── MINI APP API ──────────────────────────────────
app.get("/api/v5/view/:sid", requireTelegramAuth, async (req, res) => {
  try {
    const u = await db.resolveUser(prisma, req.params.sid);
    const state = await db.loadState(prisma, u.id);
    const view = compute(state);
    res.json({ view, hero: heroLine(state, state.language) });
  } catch (e) {
    console.error("[v5 view]", e);
    res.status(500).json({ error: "Internal" });
  }
});

app.post("/api/v5/action/:sid", requireTelegramAuth, async (req, res) => {
  try {
    const intent = req.body.intent;
    if (!intent || typeof intent.kind !== "string") return res.status(400).json({ error: "Invalid intent" });
    const u = await db.resolveUser(prisma, req.params.sid);
    let result;
    await db.withUserLock(u.id, async () => {
      const state = await db.loadState(prisma, u.id);
      const verdict = validateIntent(state, intent, m.today(state.timezone || "UTC"));
      if (!verdict.ok) {
        result = { ok: false, error: verdict.reason };
        return;
      }
      try {
        const r = applyIntent(state, intent);
        await db.saveState(prisma, u.id, r.state);
        result = { ok: true, view: compute(r.state) };
      } catch (e) {
        result = { ok: false, error: e.message };
      }
    });
    res.json(result);
  } catch (e) {
    console.error("[v5 action]", e);
    res.status(500).json({ error: "Internal" });
  }
});

app.get("/api/v5/simulate/:sid", requireTelegramAuth, async (req, res) => {
  try {
    const amt = Math.round(Number(req.query.amountCents));
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "amountCents required" });
    const u = await db.resolveUser(prisma, req.params.sid);
    const state = await db.loadState(prisma, u.id);
    const sim = simulateSpend(state, amt);
    res.json({ simulate: sim });
  } catch (e) {
    console.error("[v5 simulate]", e);
    res.status(500).json({ error: "Internal" });
  }
});

// ── TELEGRAM ──────────────────────────────────────
attach(prisma);

app.post("/telegram/webhook", async (req, res) => {
  if (!bot) return res.sendStatus(200);
  try {
    await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("[v5 webhook]", err);
    res.sendStatus(200);
  }
});

// ── DB MIGRATE ON START ──────────────────────────
function migrateDb() {
  try {
    execSync("npx prisma db push --accept-data-loss", { stdio: "inherit" });
    console.log("[v5] prisma db push OK");
  } catch {
    console.error("[v5] prisma db push failed (continuing)");
  }
}

// ── STARTUP ───────────────────────────────────────
async function start() {
  if (process.env.SKIP_MIGRATE !== "1") migrateDb();

  try { await prisma.$connect(); console.log("[v5] db connected"); }
  catch (err) { console.error("[v5] db:", err.message); process.exit(1); }

  app.listen(PORT, async () => {
    console.log("SpendYes v5 listening on :" + PORT);

    if (!bot || !process.env.BOT_TOKEN) {
      console.warn("[v5] BOT_TOKEN missing — bot disabled");
      return;
    }

    try {
      await bot.init();
      console.log("[v5] bot:", bot.botInfo && bot.botInfo.username);
    } catch (err) {
      console.error("[v5] bot init:", err.message);
      return;
    }

    // Webhook URL — Telegram must point at /telegram/webhook on our host.
    if (process.env.WEBHOOK_URL) {
      try {
        const base = process.env.WEBHOOK_URL.replace(/\/$/, "");
        const target = /\/telegram\/webhook$/.test(base) ? base : base + "/telegram/webhook";
        await bot.api.setWebhook(target);
        console.log("[v5] webhook:", target);
      } catch (err) {
        console.error("[v5] webhook set:", err.message);
      }
    } else {
      // Polling fallback for local dev / Railway misconfiguration.
      bot.start({ onStart: () => console.log("[v5] bot polling…") });
    }

    // Persistent ≡ Dashboard menu button → opens Mini App.
    if (process.env.MINIAPP_URL && /^https:\/\//.test(process.env.MINIAPP_URL)) {
      try {
        await bot.api.setChatMenuButton({
          menu_button: {
            type: "web_app",
            text: "Dashboard",
            web_app: { url: process.env.MINIAPP_URL },
          },
        });
        console.log("[v5] menu button →", process.env.MINIAPP_URL);
      } catch (err) {
        console.error("[v5] menu button:", err.message);
      }
    }

    // Slash-command menu shown in Telegram's UI.
    try {
      await bot.api.setMyCommands([
        { command: "start", description: "Start or check status" },
        { command: "today", description: "Today's hero line" },
        { command: "undo",  description: "Undo last action" },
        { command: "app",   description: "Open the dashboard" },
        { command: "reset", description: "Wipe everything and start over" },
      ]);
    } catch (err) {
      console.error("[v5] setMyCommands:", err.message);
    }
  });
}

start();
