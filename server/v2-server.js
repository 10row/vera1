"use strict";

// server/v2-server.js - SpendYes v2 Production Server
// Postgres persistence via Prisma. Serves web UI. Proxies AI to Claude.
// Deploy to Railway: npm start
// Local dev: npm run v2:dev

require("dotenv").config();

const express = require("express");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk").default;
const v2 = require("./vera-v2");
const prisma = require("./db/client");
const db = require("./db/queries");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// -- Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// -- Session helper: webToken -> userId
const tokenCache = {};

async function resolveUser(webToken) {
  if (tokenCache[webToken]) return tokenCache[webToken];
  const user = await db.getOrCreateWebUser(prisma, webToken);
  tokenCache[webToken] = user.id;
  return user.id;
}

async function persist(userId, state) {
  await db.saveState(prisma, userId, state);
}

// -- Serve the web UI
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../web/vera-v2.html"));
});
app.get("/v2", (req, res) => {
  res.sendFile(path.join(__dirname, "../web/vera-v2.html"));
});

// -- API: Get current picture
app.get("/api/v2/picture/:sessionId", async (req, res) => {
  try {
    const userId = await resolveUser(req.params.sessionId);
    const state = await db.loadState(prisma, userId);
    const pic = v2.computePicture(state);
    res.json({ pic, state: sanitise(state) });
  } catch (err) {
    console.error("Picture error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// -- API: Apply action directly
app.post("/api/v2/action/:sessionId", async (req, res) => {
  const { action } = req.body;
  if (!action || !action.type) return res.status(400).json({ error: "action required" });
  try {
    const userId = await resolveUser(req.params.sessionId);
    const result = await db.withUserLock(userId, async () => {
      const state = await db.loadState(prisma, userId);
      const newState = v2.applyAction(state, action);
      await persist(userId, newState);
      const pic = v2.computePicture(newState);
      return { pic, state: sanitise(newState) };
    });
    res.json(result);
  } catch (err) {
    console.error("Action error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// -- API: Chat with SpendYes (proxied to Claude)
app.post("/api/v2/chat/:sessionId", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  try {
    const userId = await resolveUser(req.params.sessionId);

    const result = await db.withUserLock(userId, async () => {
      let state = await db.loadState(prisma, userId);
      const history = state.conversationHistory.slice(-20);
      history.push({ role: "user", content: message });

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: v2.buildSystemPrompt(state),
        messages: history,
      });

      const text = response.content?.[0]?.text ?? "";
      let parsed;
      const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[1]);
      } else {
        try { parsed = JSON.parse(text); }
        catch { parsed = { message: text, actions: [{ type: "none" }] }; }
      }

      state.conversationHistory.push({ role: "user", content: message });
      state.conversationHistory.push({ role: "assistant", content: text });
      if (state.conversationHistory.length > 40) {
        state.conversationHistory = state.conversationHistory.slice(-30);
      }

      for (const action of (parsed.actions || [])) {
        state = v2.applyAction(state, action);
      }

      const queryResults = {};
      for (const query of (parsed.queries || [])) {
        queryResults[query.type] = v2.runQuery(state, query);
      }

      await persist(userId, state);

      const pic = v2.computePicture(state);
      return {
        message: parsed.message,
        actions: parsed.actions,
        queries: parsed.queries,
        queryResults,
        pic,
        state: sanitise(state),
      };
    });

    res.json(result);
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: "AI error: " + err.message });
  }
});

// -- API: Run query
app.post("/api/v2/query/:sessionId", async (req, res) => {
  const { query } = req.body;
  if (!query || !query.type) return res.status(400).json({ error: "query required" });
  try {
    const userId = await resolveUser(req.params.sessionId);
    const state = await db.loadState(prisma, userId);
    const result = v2.runQuery(state, query);
    res.json({ result });
  } catch (err) {
    console.error("Query error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// -- API: Reset session
app.post("/api/v2/reset/:sessionId", async (req, res) => {
  try {
    const userId = await resolveUser(req.params.sessionId);
    await prisma.$transaction([
      prisma.transaction.deleteMany({ where: { userId } }),
      prisma.drain.deleteMany({ where: { userId } }),
      prisma.pool.deleteMany({ where: { userId } }),
      prisma.plannedPurchase.deleteMany({ where: { userId } }),
      prisma.monthlySummary.deleteMany({ where: { userId } }),
      prisma.cycleSummary.deleteMany({ where: { userId } }),
      prisma.message.deleteMany({ where: { userId } }),
      prisma.user.update({
        where: { id: userId },
        data: { setup: false, balanceCents: 0, incomeCents: 0, savingsCents: 0, savingRateBps: 0, payday: null, cycleStart: null, localRate: 100 },
      }),
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Reset error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// -- Health
app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", db: "connected", ts: new Date().toISOString() });
  } catch {
    res.status(500).json({ status: "error", db: "disconnected", ts: new Date().toISOString() });
  }
});

// -- Sanitise state for client
function sanitise(state) {
  const { conversationHistory, transactions, ...rest } = state;
  return { ...rest, transactionCount: transactions.length };
}

// -- Telegram Bot
const { bot } = require("./telegram");

if (bot && process.env.BOT_TOKEN) {
  if (process.env.WEBHOOK_URL) {
    const webhookPath = "/telegram/webhook";
    app.post(webhookPath, (req, res) => {
      bot.handleUpdate(req.body).catch(err => console.error("Bot update error:", err));
      res.sendStatus(200);
    });
  }
}

// -- START
app.listen(PORT, async () => {
  console.log("SpendYes v2 running on http://localhost:" + PORT);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("  WARNING: No ANTHROPIC_API_KEY set");
  }
  if (bot && process.env.BOT_TOKEN) {
    if (process.env.WEBHOOK_URL) {
      const webhookUrl = process.env.WEBHOOK_URL.replace(/\/$/, "") + "/telegram/webhook";
      try {
        await bot.init();
        await bot.api.setWebhook(webhookUrl);
        console.log("  Telegram webhook: " + webhookUrl);
      } catch (err) {
        console.error("  Telegram webhook error:", err.message);
      }
    } else {
      bot.start({ onStart: () => console.log("  Telegram bot polling...") });
    }
  }
});
