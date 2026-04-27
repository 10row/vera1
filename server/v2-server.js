"use strict";
require("dotenv").config();
const express = require("express");
const path = require("path");
const OpenAI = require("openai");
const v2 = require("./vera-v2");
const { responseSchema } = require("./openai-schema");
const prisma = require("./db/client");
const db = require("./db/queries");
const { router: adminRouter, logApiCall } = require("./admin");
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
const openai = new OpenAI();
const tokenCache = {};

async function resolveUser(wt) {
  if (tokenCache[wt]) return tokenCache[wt];
  const u = await db.getOrCreateWebUser(prisma, wt);
  tokenCache[wt] = u.id; return u.id;
}
async function persist(uid, st) { await db.saveState(prisma, uid, st); }

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "../web/vera-v2.html")));
app.get("/v2", (req, res) => res.sendFile(path.join(__dirname, "../web/vera-v2.html")));

app.get("/api/v2/picture/:sid", async (req, res) => {
  try {
    const uid = await resolveUser(req.params.sid);
    const st = await db.loadState(prisma, uid);
    res.json({ pic: v2.computePicture(st), state: sanitise(st) });
  } catch (e) { console.error("Picture err:", e.message); res.status(500).json({ error: e.message }); }
});

app.post("/api/v2/action/:sid", async (req, res) => {
  const { action } = req.body;
  if (!action || !action.type) return res.status(400).json({ error: "action required" });
  try {
    const uid = await resolveUser(req.params.sid);
    const result = await db.withUserLock(uid, async () => {
      const st = await db.loadState(prisma, uid);
      const ns = v2.applyAction(st, action);
      await persist(uid, ns);
      return { pic: v2.computePicture(ns), state: sanitise(ns) };
    });
    res.json(result);
  } catch (e) { console.error("Action err:", e.message); res.status(500).json({ error: e.message }); }
});

app.post("/api/v2/chat/:sid", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  try {
    const uid = await resolveUser(req.params.sid);
    const result = await db.withUserLock(uid, async () => {
      let st = await db.loadState(prisma, uid);
      const hist = st.conversationHistory.slice(-10);
      hist.push({ role: "user", content: message });
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini", max_tokens: 1024,
        response_format: { type: "json_schema", json_schema: responseSchema },
        messages: [{ role: "system", content: v2.buildSystemPrompt(st) }, ...hist],
      });
      const text = resp.choices?.[0]?.message?.content ?? "";
      const usage = resp.usage || {};
      logApiCall(uid, "gpt-4o-mini", usage.prompt_tokens||0, usage.completion_tokens||0, "chat").catch(()=>{});
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { message: text, actions: [{ type: "none" }] }; }
      st.conversationHistory.push({ role: "user", content: message });
      st.conversationHistory.push({ role: "assistant", content: text });
      if (st.conversationHistory.length > 40) st.conversationHistory = st.conversationHistory.slice(-30);
      for (const a of (parsed.actions || [])) st = v2.applyAction(st, a);
      const qr = {};
      for (const q of (parsed.queries || [])) qr[q.type] = v2.runQuery(st, q);
      await persist(uid, st);
      return { message: parsed.message, actions: parsed.actions, queries: parsed.queries, queryResults: qr, pic: v2.computePicture(st), state: sanitise(st) };
    });
    res.json(result);
  } catch (e) { console.error("Chat err:", e.message); res.status(500).json({ error: "AI error: " + e.message }); }
});

app.post("/api/v2/query/:sid", async (req, res) => {
  const { query } = req.body;
  if (!query || !query.type) return res.status(400).json({ error: "query required" });
  try {
    const uid = await resolveUser(req.params.sid);
    const st = await db.loadState(prisma, uid);
    res.json({ result: v2.runQuery(st, query) });
  } catch (e) { console.error("Query err:", e.message); res.status(500).json({ error: e.message }); }
});

app.post("/api/v2/reset/:sid", async (req, res) => {
  try {
    const uid = await resolveUser(req.params.sid);
    await prisma.$transaction([
      prisma.transaction.deleteMany({ where: { userId: uid } }),
      prisma.drain.deleteMany({ where: { userId: uid } }),
      prisma.pool.deleteMany({ where: { userId: uid } }),
      prisma.plannedPurchase.deleteMany({ where: { userId: uid } }),
      prisma.monthlySummary.deleteMany({ where: { userId: uid } }),
      prisma.cycleSummary.deleteMany({ where: { userId: uid } }),
      prisma.message.deleteMany({ where: { userId: uid } }),
      prisma.user.update({ where: { id: uid }, data: { setup: false, balanceCents: 0, incomeCents: 0, savingsCents: 0, savingRateBps: 0, payday: null, cycleStart: null, recurring: true, localRate: 100, language: "en" } }),
    ]);
    res.json({ ok: true });
  } catch (e) { console.error("Reset err:", e.message); res.status(500).json({ error: e.message }); }
});

app.use("/admin", adminRouter);

app.get("/health", async (req, res) => {
  try { await prisma.$queryRaw`SELECT 1`; res.json({ status: "ok", db: "connected", ts: new Date().toISOString() }); }
  catch { res.status(500).json({ status: "error", db: "disconnected", ts: new Date().toISOString() }); }
});

function sanitise(st) {
  const { conversationHistory, transactions, ...rest } = st;
  return { ...rest, transactionCount: transactions.length };
}

const { bot, runDailyBriefings, runBillAlerts } = require("./telegram");
if (bot && process.env.BOT_TOKEN) {
  if (process.env.WEBHOOK_URL) {
    app.post("/telegram/webhook", (req, res) => {
      bot.handleUpdate(req.body).catch(e => console.error("Bot update err:", e));
      res.sendStatus(200);
    });
  }
}

app.listen(PORT, async () => {
  console.log("SpendYes v2 on http://localhost:" + PORT);
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
  let lastBD = "";
  setInterval(async () => {
    const now = new Date(), h = now.getUTCHours(), day = now.toISOString().slice(0, 10);
    if (h === 8 && day !== lastBD) { lastBD = day; await runDailyBriefings(); }
    if (h % 6 === 0) await runBillAlerts();
  }, 3600000);
  console.log("  Scheduler: briefings 8AM UTC, bills q6h");
  console.log("  Admin dashboard: /admin");
});
