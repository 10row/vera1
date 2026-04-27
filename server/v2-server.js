"use strict";

// server/v2-server.js - SpendYes v2 Server
require("dotenv").config();

const express = require("express");
const path = require("path");
const Anthropic =
  require("@anthropic-ai/sdk").default;
const OpenAI = require("openai");
const v2 = require("./vera-v2");
const prisma = require("./db/client");
const db = require("./db/queries");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});
const openai = new OpenAI();
const tokenCache = {};

async function resolveUser(webToken) {
  if (tokenCache[webToken]) {
    return tokenCache[webToken];
  }
  const user = await db.getOrCreateWebUser(
    prisma, webToken
  );
  tokenCache[webToken] = user.id;
  return user.id;
}
async function persist(userId, state) {
  await db.saveState(prisma, userId, state);
}

app.get("/", (req, res) => {
  const p = path.join(
    __dirname, "../web/vera-v2.html"
  );
  res.sendFile(p);
});
app.get("/v2", (req, res) => {
  const p = path.join(
    __dirname, "../web/vera-v2.html"
  );
  res.sendFile(p);
});

app.get("/api/v2/picture/:sid", async (req, res) => {
  try {
    const uid = await resolveUser(req.params.sid);
    const state = await db.loadState(prisma, uid);
    const pic = v2.computePicture(state);
    res.json({ pic, state: sanitise(state) });
  } catch (err) {
    console.error("Picture error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/v2/action/:sid", async (req, res) => {
  const { action } = req.body;
  if (!action || !action.type) {
    return res.status(400).json({
      error: "action required",
    });
  }
  try {
    const uid = await resolveUser(req.params.sid);
    const result = await db.withUserLock(
      uid,
      async () => {
        const st = await db.loadState(prisma, uid);
        const ns = v2.applyAction(st, action);
        await persist(uid, ns);
        return {
          pic: v2.computePicture(ns),
          state: sanitise(ns),
        };
      }
    );
    res.json(result);
  } catch (err) {
    console.error("Action error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/v2/chat/:sid", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({
      error: "message required",
    });
  }
  try {
    const uid = await resolveUser(req.params.sid);
    const result = await db.withUserLock(
      uid,
      async () => {
        let st = await db.loadState(prisma, uid);
        const hist = st.conversationHistory
          .slice(-10);
        hist.push({ role: "user", content: message });
        const resp = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          max_tokens: 1024,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: v2.buildSystemPrompt(st) },
            ...hist,
          ],
        });
        const text = resp.choices?.[0]?.message?.content ?? "";
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = {
            message: text,
            actions: [{ type: "none" }],
          };
        }
        st.conversationHistory.push({
          role: "user", content: message,
        });
        st.conversationHistory.push({
          role: "assistant", content: text,
        });
        if (st.conversationHistory.length > 40) {
          st.conversationHistory =
            st.conversationHistory.slice(-30);
        }
        const acts = parsed.actions || [];
        for (const a of acts) {
          st = v2.applyAction(st, a);
        }
        const qr = {};
        for (const q of (parsed.queries || [])) {
          qr[q.type] = v2.runQuery(st, q);
        }
        await persist(uid, st);
        return {
          message: parsed.message,
          actions: parsed.actions,
          queries: parsed.queries,
          queryResults: qr,
          pic: v2.computePicture(st),
          state: sanitise(st),
        };
      }
    );
    res.json(result);
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({
      error: "AI error: " + err.message,
    });
  }
});

app.post("/api/v2/query/:sid", async (req, res) => {
  const { query } = req.body;
  if (!query || !query.type) {
    return res.status(400).json({
      error: "query required",
    });
  }
  try {
    const uid = await resolveUser(req.params.sid);
    const st = await db.loadState(prisma, uid);
    res.json({ result: v2.runQuery(st, query) });
  } catch (err) {
    console.error("Query error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/v2/reset/:sid", async (req, res) => {
  try {
    const uid = await resolveUser(req.params.sid);
    await prisma.$transaction([
      prisma.transaction.deleteMany({
        where: { userId: uid },
      }),
      prisma.drain.deleteMany({
        where: { userId: uid },
      }),
      prisma.pool.deleteMany({
        where: { userId: uid },
      }),
      prisma.plannedPurchase.deleteMany({
        where: { userId: uid },
      }),
      prisma.monthlySummary.deleteMany({
        where: { userId: uid },
      }),
      prisma.cycleSummary.deleteMany({
        where: { userId: uid },
      }),
      prisma.message.deleteMany({
        where: { userId: uid },
      }),
      prisma.user.update({
        where: { id: uid },
        data: {
          setup: false,
          balanceCents: 0,
          incomeCents: 0,
          savingsCents: 0,
          savingRateBps: 0,
          payday: null,
          cycleStart: null,
          recurring: true,
          localRate: 100,
          language: "en",
        },
      }),
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Reset error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: "ok", db: "connected",
      ts: new Date().toISOString(),
    });
  } catch {
    res.status(500).json({
      status: "error", db: "disconnected",
      ts: new Date().toISOString(),
    });
  }
});

function sanitise(state) {
  const {
    conversationHistory, transactions, ...rest
  } = state;
  return {
    ...rest,
    transactionCount: transactions.length,
  };
}

const { bot } = require("./telegram");
if (bot && process.env.BOT_TOKEN) {
  if (process.env.WEBHOOK_URL) {
    app.post("/telegram/webhook", (req, res) => {
      bot.handleUpdate(req.body).catch(err =>
        console.error("Bot update error:", err)
      );
      res.sendStatus(200);
    });
  }
}

app.listen(PORT, async () => {
  console.log(
    "SpendYes v2 on http://localhost:" + PORT
  );
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("  WARNING: No ANTHROPIC_API_KEY");
  }
  if (bot && process.env.BOT_TOKEN) {
    if (process.env.WEBHOOK_URL) {
      try {
        await bot.init();
        const wh = process.env.WEBHOOK_URL
          .replace(/\/$/, "")
          + "/telegram/webhook";
        await bot.api.setWebhook(wh);
        console.log("  Telegram webhook set");
      } catch (err) {
        console.error(
          "  Telegram webhook error:",
          err.message
        );
      }
    } else {
      bot.start({
        onStart: () => {
          console.log("  Telegram bot polling...");
        },
      });
    }
  }
});
