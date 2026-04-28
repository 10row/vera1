"use strict";
// v4/index.js — Express + Telegram bot entry point.
// Mounts the v4 chat brain. Runs migrate + sets the Mini App menu button.
// Legacy v3 code stays on disk but is NOT mounted here.

require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const prisma = require("../db/client");
const m = require("./model");
const { compute } = require("./view");
const db = require("./db");
const { bot, attach } = require("./bot");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "16kb" }));

// ── INITDATA VALIDATION ─────────────────────────
// IMPORTANT: BOT_TOKEN env vars are commonly pasted with trailing whitespace
// (newline / space / CR). The Telegram Bot API tolerates this on its URL,
// but HMAC validation needs the EXACT bytes Telegram used to sign initData.
// We trim aggressively here — this fixes the #1 cause of "bad-signature".
function getBotToken() {
  return (process.env.BOT_TOKEN || "").trim();
}
function getBotId() {
  const t = getBotToken();
  const colon = t.indexOf(":");
  return colon > 0 ? t.slice(0, colon) : null;
}

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

// ── STATIC ──────────────────────────────────────
app.use("/miniapp", express.static(path.join(__dirname, "../../miniapp")));
app.get("/", (req, res) => res.redirect("/miniapp/"));

// ── DIAGNOSTIC ──────────────────────────────────
app.get("/api/v4/whoami", (req, res) => {
  const initData = req.headers["x-telegram-init-data"];
  const rawToken = process.env.BOT_TOKEN || "";
  const token = getBotToken();
  // botId is the public integer prefix of the token (before the colon).
  // Safe to expose: it's visible in any t.me/<bot>?start link via Telegram.
  const serverBotId = getBotId();
  // initData includes auth_date and user but NOT the signing bot id directly;
  // however the URL params often include the launch context. We surface what
  // we can to help diagnose multi-bot confusion.
  const out = {
    hasBotToken: !!token,
    botTokenHadWhitespace: rawToken !== token, // diagnostic: true if we trimmed something
    serverBotId,
    miniAppUrlSet: !!process.env.MINIAPP_URL,
    miniAppUrl: process.env.MINIAPP_URL || null,
    nodeEnv: process.env.NODE_ENV || "unset",
    receivedInitData: !!initData,
    initDataLength: initData ? initData.length : 0,
  };
  if (!initData) return res.json({ ...out, status: "no-init-data",
    hint: "Mini App didn't send initData. Open from the bot's ≡ Dashboard menu button or send /app." });
  if (!token) return res.json({ ...out, status: "no-bot-token",
    hint: "Server has no BOT_TOKEN — set it in Railway." });
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    const authDate = parseInt(params.get("auth_date") || "0");
    const userStr = params.get("user");
    const userParsed = userStr ? JSON.parse(userStr) : null;
    if (!hash) return res.json({ ...out, status: "malformed", hint: "initData has no hash" });
    params.delete("hash");
    const dcs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + "=" + v).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(token).digest();
    const checkHash = crypto.createHmac("sha256", secretKey).update(dcs).digest("hex");
    const sigOk = checkHash === hash;
    const ageSec = Math.floor(Date.now() / 1000 - authDate);
    return res.json({
      ...out,
      status: sigOk ? (ageSec > 7 * 24 * 60 * 60 ? "stale" : "ok") : "bad-signature",
      sigOk, ageSeconds: ageSec, authDate,
      user: userParsed ? { id: userParsed.id, username: userParsed.username, first_name: userParsed.first_name } : null,
      hint: sigOk
        ? (ageSec > 7 * 24 * 60 * 60 ? "Session older than 7 days — relaunch the Mini App." : "Auth is valid.")
        : "HMAC mismatch. Server bot id " + serverBotId + ". Compare to the bot you launched from (in BotFather, /mybots → token starts with this number). If they match: BOT_TOKEN env var likely has hidden whitespace.",
    });
  } catch (e) {
    return res.json({ ...out, status: "parse-error", error: e.message });
  }
});

// ── VIEW ENDPOINT ───────────────────────────────
app.get("/api/v4/view/:sid", requireTelegramAuth, async (req, res) => {
  try {
    const u = await db.resolveUser(prisma, req.params.sid);
    const state = await db.loadState(prisma, u.id);
    const view = compute(state);
    res.json({ view });
  } catch (e) {
    console.error("[v4 view]", e);
    res.status(500).json({ error: e.message });
  }
});

// ── HEALTH ──────────────────────────────────────
app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", db: "connected", version: "v4", ts: new Date().toISOString() });
  } catch {
    res.status(500).json({ status: "error", db: "disconnected", ts: new Date().toISOString() });
  }
});

// ── BOT WEBHOOK ─────────────────────────────────
if (bot && process.env.BOT_TOKEN) {
  attach(prisma);
  if (process.env.WEBHOOK_URL) {
    app.post("/telegram/webhook", (req, res) => {
      bot.handleUpdate(req.body).catch(e => console.error("[v4 update]", e));
      res.sendStatus(200);
    });
  }
}

// ── DB MIGRATE ON START ─────────────────────────
function migrateDb() {
  try {
    execSync("npx prisma db push --accept-data-loss", { stdio: "inherit" });
    console.log("[v4] prisma db push OK");
  } catch (e) {
    console.error("[v4] prisma db push failed (continuing)");
  }
}

// ── START ───────────────────────────────────────
async function start() {
  // Skip migrate if explicitly disabled (e.g. local dev with manual control).
  if (process.env.SKIP_MIGRATE !== "1") migrateDb();

  app.listen(PORT, async () => {
    console.log("SpendYes v4 listening on :" + PORT);

    if (bot && process.env.BOT_TOKEN) {
      try {
        if (process.env.WEBHOOK_URL) {
          await bot.init();
          await bot.api.setWebhook(process.env.WEBHOOK_URL.replace(/\/$/, "") + "/telegram/webhook");
          console.log("[v4] webhook set: " + process.env.WEBHOOK_URL);
        } else {
          // Polling — Telegram will deliver updates via long-poll.
          bot.start({ onStart: () => console.log("[v4] bot polling…") });
        }

        // Register the persistent ≡ Dashboard menu button per Telegram docs.
        // https://core.telegram.org/bots/api#setchatmenubutton
        if (process.env.MINIAPP_URL && /^https:\/\//.test(process.env.MINIAPP_URL)) {
          try {
            await bot.api.setChatMenuButton({
              menu_button: {
                type: "web_app",
                text: "Dashboard",
                web_app: { url: process.env.MINIAPP_URL },
              },
            });
            console.log("[v4] menu button → " + process.env.MINIAPP_URL);
          } catch (e) {
            console.error("[v4] setChatMenuButton failed:", e.message);
          }
        } else {
          console.warn("[v4] MINIAPP_URL not set — skipping menu button");
        }

        // Set bot commands so the user sees them in Telegram's UI.
        try {
          await bot.api.setMyCommands([
            { command: "start", description: "Start or check status" },
            { command: "app",   description: "Open the dashboard" },
            { command: "reset", description: "Wipe everything and start over" },
          ]);
        } catch (e) {
          console.error("[v4] setMyCommands failed:", e.message);
        }
      } catch (e) {
        console.error("[v4] bot setup err:", e);
      }
    } else {
      console.warn("[v4] BOT_TOKEN missing — running web only");
    }
  });
}

start();
