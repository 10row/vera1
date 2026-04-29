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
// Legacy alias — existing Mini App still calls /api/v4/whoami.
app.get("/api/v4/whoami", whoami);
// Mini App is being migrated to v5; placeholder so it shows "set up via chat"
// instead of 500-ing.
app.get("/api/v4/view/:sid", requireTelegramAuth, async (req, res) => {
  try {
    const u = await db.resolveUser(prisma, req.params.sid);
    const state = await db.loadState(prisma, u.id);
    res.json({
      pic: { setup: state.setup, miniAppNeedsUpdate: true },
      state: { setup: state.setup, language: state.language || "en" },
    });
  } catch (e) {
    res.status(500).json({ error: "Internal" });
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
