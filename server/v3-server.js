"use strict";
require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const OpenAI = require("openai");
const v3 = require("./vera-v3");
const { runQuery } = require("./vera-v3-query");
const { buildSystemPrompt } = require("./system-prompt");
// Schema file kept for reference but not used in API calls
const prisma = require("./db/client");
const db = require("./db/queries");
const { router: adminRouter, logApiCall } = require("./admin");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "16kb" }));
const openai = new OpenAI();

// ── TELEGRAM INITDATA VALIDATION ─────────────
function validateTelegramInitData(initData) {
  if (!initData || !process.env.BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const dataCheckString = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => k+"="+v).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN).digest();
    const checkHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (checkHash !== hash) return null;
    // Check auth_date is not too old (24 hours)
    const authDate = parseInt(params.get("auth_date") || "0");
    if (Date.now() / 1000 - authDate > 86400) return null;
    const user = params.get("user");
    return user ? JSON.parse(user) : null;
  } catch { return null; }
}

// Middleware: validate tg_ requests have valid initData
// Also upgrades non-tg_ requests to tg_ if valid initData is present
function requireTelegramAuth(req, res, next) {
  const sid = req.params.sid;
  const initData = req.headers["x-telegram-init-data"];

  if (initData) {
    // If initData is present, always validate it and attach the authenticated user
    const user = validateTelegramInitData(initData);
    if (!user) return res.status(401).json({ error: "Invalid Telegram auth" });

    if (sid && sid.startsWith("tg_")) {
      // Ensure the authenticated user matches the requested session
      if (String(user.id) !== sid.slice(3)) return res.status(403).json({ error: "User mismatch" });
    } else {
      // Client sent initData but wrong/missing sid — override sid with authenticated user
      req.params.sid = "tg_" + String(user.id);
    }
    req.telegramUser = user;
    return next();
  }

  // No initData
  if (sid && sid.startsWith("tg_")) {
    // tg_ requests MUST have initData
    return res.status(401).json({ error: "Missing Telegram auth" });
  }
  // Non-telegram requests pass through
  next();
}

// Token cache for web sessions
const tokenCache = new Map();
const TOKEN_CACHE_MAX = 500;

async function resolveUser(sid) {
  if (tokenCache.has(sid)) return tokenCache.get(sid);
  let u;
  if (sid.startsWith("tg_")) {
    // Mini app: look up by Telegram user ID (same user as the bot)
    const telegramId = sid.slice(3);
    u = await prisma.user.findUnique({ where: { telegramId } });
    if (!u) u = await prisma.user.create({ data: { telegramId } });
  } else {
    u = await db.getOrCreateWebUser(prisma, sid);
  }
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const first = tokenCache.keys().next().value;
    tokenCache.delete(first);
  }
  tokenCache.set(sid, u.id);
  return u.id;
}

async function persist(uid, st) {
  await db.saveState(prisma, uid, st);
}

function sanitise(st) {
  const { conversationHistory, transactions, undoSnapshot, ...rest } = st;
  return { ...rest, transactionCount: transactions.length };
}

// ── STATIC FILES ──────────────────────────────
app.use("/miniapp", express.static(path.join(__dirname, "../miniapp")));

// ── API: PICTURE ──────────────────────────────
app.get("/api/v3/picture/:sid", requireTelegramAuth, async (req, res) => {
  try {
    const uid = await resolveUser(req.params.sid);
    const st = await db.loadState(prisma, uid);
    res.json({ pic: v3.computePicture(st), state: sanitise(st) });
  } catch (e) {
    console.error("Picture err:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: ACTION ───────────────────────────────
app.post("/api/v3/action/:sid", requireTelegramAuth, async (req, res) => {
  const { action } = req.body;
  if (!action || !action.type) return res.status(400).json({ error: "action required" });
  try {
    const uid = await resolveUser(req.params.sid);
    const result = await db.withUserLock(uid, async () => {
      const st = await db.loadState(prisma, uid);
      const ns = v3.applyAction(st, action);
      await persist(uid, ns);
      return { pic: v3.computePicture(ns), state: sanitise(ns) };
    });
    res.json(result);
  } catch (e) {
    console.error("Action err:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: CHAT ─────────────────────────────────
app.post("/api/v3/chat/:sid", requireTelegramAuth, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  if (message.length > 2000) return res.status(400).json({ error: "message too long" });
  try {
    const uid = await resolveUser(req.params.sid);
    const result = await db.withUserLock(uid, async () => {
      let st = await db.loadState(prisma, uid);
      const hist = st.conversationHistory.slice(-10);
      hist.push({ role: "user", content: message });
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: buildSystemPrompt(st) }, ...hist],
      });
      const text = resp.choices?.[0]?.message?.content ?? "";
      const usage = resp.usage || {};
      logApiCall(uid, "gpt-4o-mini", usage.prompt_tokens || 0, usage.completion_tokens || 0, "chat").catch(() => {});
      let parsed;
      try { parsed = JSON.parse(text); }
      catch { parsed = { message: text, actions: [{ type: "none" }], queries: [], verify: false }; }

      st.conversationHistory.push({ role: "user", content: message });
      st.conversationHistory.push({ role: "assistant", content: text });
      if (st.conversationHistory.length > 40) st.conversationHistory = st.conversationHistory.slice(-30);

      // If verify flag is set, save conversation but don't apply actions
      if (parsed.verify) {
        await persist(uid, st);
        return {
          message: parsed.message,
          verify: true,
          actions: parsed.actions,
          queries: [],
          queryResults: {},
          pic: v3.computePicture(st),
          state: sanitise(st),
        };
      }

      // Save undo snapshot before applying actions
      const hasChange = (parsed.actions || []).some(a => a.type !== "none");
      if (hasChange) {
        st.undoSnapshot = JSON.parse(JSON.stringify(st));
        delete st.undoSnapshot.undoSnapshot;
      }

      for (const a of (parsed.actions || [])) {
        if (a.type !== "none") st = v3.applyAction(st, a);
      }

      const qr = {};
      for (const q of (parsed.queries || [])) {
        qr[q.type] = runQuery(st, q, v3.computePicture, v3.toMoney);
      }

      await persist(uid, st);
      return {
        message: parsed.message,
        verify: parsed.verify,
        actions: parsed.actions,
        queries: parsed.queries,
        queryResults: qr,
        pic: v3.computePicture(st),
        state: sanitise(st),
      };
    });
    res.json(result);
  } catch (e) {
    console.error("Chat err:", e.message);
    res.status(500).json({ error: "AI error: " + e.message });
  }
});

// ── API: QUERY ────────────────────────────────
app.post("/api/v3/query/:sid", requireTelegramAuth, async (req, res) => {
  const { query } = req.body;
  if (!query || !query.type) return res.status(400).json({ error: "query required" });
  try {
    const uid = await resolveUser(req.params.sid);
    const st = await db.loadState(prisma, uid);
    res.json({ result: runQuery(st, query, v3.computePicture, v3.toMoney) });
  } catch (e) {
    console.error("Query err:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: RESET ────────────────────────────────
app.post("/api/v3/reset/:sid", requireTelegramAuth, async (req, res) => {
  try {
    const uid = await resolveUser(req.params.sid);
    await prisma.$transaction(async (tx) => {
      await tx.transaction.deleteMany({ where: { userId: uid } });
      await tx.envelope.deleteMany({ where: { userId: uid } });
      await tx.monthlySummary.deleteMany({ where: { userId: uid } });
      await tx.cycleSummary.deleteMany({ where: { userId: uid } });
      await tx.message.deleteMany({ where: { userId: uid } });
      await tx.user.update({
        where: { id: uid },
        data: {
          setup: false, balanceCents: 0,
          payday: null, cycleStart: null, language: "en",
        },
      });
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("Reset err:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN ─────────────────────────────────────
app.use("/admin", adminRouter);

// ── HEALTH ────────────────────────────────────
app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", db: "connected", ts: new Date().toISOString() });
  } catch {
    res.status(500).json({ status: "error", db: "disconnected", ts: new Date().toISOString() });
  }
});

// ── TELEGRAM BOT ──────────────────────────────
const { bot, runDailyBriefings, runEnvelopeAlerts, runReconciliation } = require("./telegram-v3");
if (bot && process.env.BOT_TOKEN) {
  if (process.env.WEBHOOK_URL) {
    app.post("/telegram/webhook", (req, res) => {
      bot.handleUpdate(req.body).catch(e => console.error("Bot update err:", e));
      res.sendStatus(200);
    });
  }
}

// ── START ─────────────────────────────────────
app.listen(PORT, async () => {
  console.log("SpendYes V3 on http://localhost:" + PORT);

  if (bot && process.env.BOT_TOKEN) {
    if (process.env.WEBHOOK_URL) {
      try {
        await bot.init();
        await bot.api.setWebhook(process.env.WEBHOOK_URL.replace(/\/$/, "") + "/telegram/webhook");
        console.log("  Telegram webhook set");
      } catch (e) { console.error("  Webhook err:", e.message); }
    } else {
      bot.start({ onStart: () => console.log("  Telegram bot polling...") });
    }
  }

  // Scheduler: briefings (per-user timezone), envelope alerts, reconciliation
  let lastRecon = "";
  setInterval(async () => {
    const now = new Date();
    const h = now.getUTCHours();
    const day = now.toISOString().slice(0, 10);
    const dow = now.getUTCDay();

    // Briefings: run every hour, sends only to users whose local time is 8am
    await runDailyBriefings();
    // Envelope alerts every 6 hours
    if (h % 6 === 0) await runEnvelopeAlerts();
    // Weekly reconciliation on Sundays at 18:00 UTC
    if (dow === 0 && h === 18 && day !== lastRecon) {
      lastRecon = day;
      await runReconciliation();
    }
  }, 3600000);

  console.log("  Scheduler: briefings per-user 8AM local, alerts q6h, reconciliation Sun 6PM UTC");
  console.log("  Admin dashboard: /admin");
  console.log("  Mini App: /miniapp");
});
