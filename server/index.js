// server/index.js
// Express server entry point.
// Handles Telegram webhook, Mini App API, health check.

"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");
const prisma = require("./db/client");
const { bot, sendMorningBriefing, sendBillAlert } = require("./telegram");
const { getState, saveAction, getOrCreateUser, getAllUsers } = require("./db/queries");
const { computePicture } = require("./vera");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── STATIC — Mini App ─────────────────────────────────────────────────────────
app.use("/miniapp", express.static(path.join(__dirname, "../miniapp")));

// ── WEB APP — local dev UI (serves vera.jsx with API key injected) ─────────────
app.get("/app", (req, res) => {
  const fs = require("fs");
  const jsx = fs.readFileSync(path.join(__dirname, "../web/vera.jsx"), "utf8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vera</title>
  <style>* { box-sizing: border-box; margin: 0; padding: 0; } html, body { height: 100%; background: #f9f7f4; }</style>
</head>
<body>
  <div id="root" style="height:100%"></div>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script>window.ANTHROPIC_API_KEY = ${JSON.stringify(process.env.ANTHROPIC_API_KEY)};</script>
  <script type="text/babel">
${jsx}
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(App));
  </script>
</body>
</html>`);
});
app.use("/web", express.static(path.join(__dirname, "../web")));

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

// ── TELEGRAM WEBHOOK ──────────────────────────────────────────────────────────
app.post("/telegram/webhook", async (req, res) => {
  if (!bot) return res.sendStatus(200);
  try {
    await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(200); // Always 200 to Telegram or they'll retry
  }
});

// ── MINI APP API ──────────────────────────────────────────────────────────────
// Used by the Mini App (vera-tg.jsx) to read state and apply actions.

// GET /api/picture/:telegramId — current picture for Mini App
app.get("/api/picture/:telegramId", async (req, res) => {
  try {
    const { telegramId } = req.params;
    const user = await getOrCreateUser(prisma, telegramId);
    const state = await getState(prisma, user.id);
    const pic = computePicture(state);
    res.json({ pic, state: sanitiseState(state) });
  } catch (err) {
    console.error("Picture API error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/action/:telegramId — apply action from Mini App
app.post("/api/action/:telegramId", async (req, res) => {
  try {
    const { telegramId } = req.params;
    const { action } = req.body;
    if (!action) return res.status(400).json({ error: "action required" });

    const user = await getOrCreateUser(prisma, telegramId);
    const newState = await saveAction(prisma, user.id, action);
    const pic = computePicture(newState);
    res.json({ pic, state: sanitiseState(newState), lastDiff: newState.lastDiff });
  } catch (err) {
    console.error("Action API error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vera/:telegramId — full Vera conversation from Mini App
app.post("/api/vera/:telegramId", async (req, res) => {
  try {
    const { telegramId } = req.params;
    const { messages } = req.body;
    if (!messages?.length) return res.status(400).json({ error: "messages required" });

    const user = await getOrCreateUser(prisma, telegramId);
    const state = await getState(prisma, user.id);

    // Delegate to telegram.js callVera — same function used by bot
    const { callVera, enrichActionWithRate } = require("./telegram");
    const r = await callVera(messages, state);

    // Apply actions (enrich with live rate for set_location / propose_setup)
    // Mini App has no separate confirm step — propose_setup completes immediately
    let newState = state;
    for (const action of (r.actions || [])) {
      await enrichActionWithRate(action);
      const effective = action.type === "propose_setup"
        ? { type: "complete_setup", data: action.data }
        : action;
      newState = await saveAction(prisma, user.id, effective);
    }

    const pic = computePicture(newState);
    res.json({ message: r.message, followup: r.followup, pic, state: sanitiseState(newState) });
  } catch (err) {
    console.error("Vera API error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── SANITISE STATE ────────────────────────────────────────────────────────────
// Remove sensitive/internal fields before sending to client
function sanitiseState(state) {
  const { lastDiff, ...rest } = state;
  return rest;
}

// ── CRON JOBS ─────────────────────────────────────────────────────────────────
function startCrons() {
  if (!bot) {
    console.log("⚠ No BOT_TOKEN — cron jobs skipped");
    return;
  }
  const cron = require("node-cron");

  // Morning briefing — 8:00am daily (server timezone)
  cron.schedule("0 8 * * *", async () => {
    console.log("[cron] Sending morning briefings…");
    const users = await getAllUsers(prisma);
    for (const u of users) {
      await sendMorningBriefing(u.telegramId);
    }
  });

  // Bill alerts — 9:00am daily, checks for bills due tomorrow
  cron.schedule("0 9 * * *", async () => {
    console.log("[cron] Checking bill alerts…");
    const users = await getAllUsers(prisma);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);

    for (const u of users) {
      try {
        const state = await getState(prisma, u.id);
        if (!state.setup) continue;
        for (const [key, bill] of Object.entries(state.committed || {})) {
          if (
            bill.active &&
            !bill.paidThisCycle &&
            bill.nextDate === tomorrowStr
          ) {
            await sendBillAlert(u.telegramId, key);
          }
        }
      } catch (err) {
        console.error(`[cron] Bill alert error for ${u.telegramId}:`, err.message);
      }
    }
  });

  console.log("✓ Cron jobs scheduled (morning briefing 8am, bill alerts 9am)");
}

// ── STARTUP ───────────────────────────────────────────────────────────────────
async function start() {
  // Initialise bot (required before handling webhook updates)
  if (bot) {
    try {
      await bot.init();
      console.log("✓ Bot initialised:", bot.botInfo.username);
    } catch (err) {
      console.error("✗ Bot init failed:", err.message);
    }
  }

  // Register Telegram webhook
  if (process.env.WEBHOOK_URL && bot) {
    try {
      await bot.api.setWebhook(process.env.WEBHOOK_URL);
      console.log("✓ Telegram webhook registered:", process.env.WEBHOOK_URL);
    } catch (err) {
      console.error("✗ Webhook registration failed:", err.message);
    }
  }

  // Test DB connection
  try {
    await prisma.$connect();
    console.log("✓ Database connected");
  } catch (err) {
    console.error("✗ Database connection failed:", err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`✓ Vera server running on port ${PORT}`);
    console.log(`  Health:   http://localhost:${PORT}/health`);
    console.log(`  Web App:  http://localhost:${PORT}/app`);
    console.log(`  Mini App: http://localhost:${PORT}/miniapp`);
    console.log(`  Webhook:  http://localhost:${PORT}/telegram/webhook`);
  });

  startCrons();
}

start();
