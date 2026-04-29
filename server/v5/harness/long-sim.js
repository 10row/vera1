"use strict";
// long-sim.js — multi-day realistic-activity simulation.
//
// Drives the bot through N days of typical user activity:
//   - 0-3 spends per day (realistic distribution)
//   - bills hit on their due dates
//   - paychecks land on payday
//   - occasional "can I afford?" queries
//   - occasional undo/correction
//
// At every checkpoint (default: every 3 days) we ask the LLM judge:
//   "Imagine you are this user opening the bot today. Look at the hero,
//    the recent transcript, and the DNA summary. Does the bot understand
//    you? Is it useful? Where would you feel let down?"
//
// The simulator uses the SAME bot.processText / processCallbackData
// path as production. AI calls are real. State accumulates. DNA grows.
//
// Run:
//   node server/v5/harness/long-sim.js --days=10
//   node server/v5/harness/long-sim.js --days=100 --checkpoint=10

require("dotenv").config({ override: true });
const fs = require("fs");
const path = require("path");
const { createMockChat, renderTranscript } = require("./telegram-mock");
const { createMockPrisma } = require("./prisma-mock");
const { getBackend } = require("./ai-backend");
const m = require("../model");
const bot = require("../bot");
const db = require("../db");
const dna = require("../dna");
const { compute, heroLine } = require("../view");

const ARGS = process.argv.slice(2);
const DAYS = parseInt((ARGS.find(a => a.startsWith("--days="))  || "--days=10").split("=")[1], 10);
const CHECKPOINT = parseInt((ARGS.find(a => a.startsWith("--checkpoint=")) || "--checkpoint=3").split("=")[1], 10);
const SEED_NUM = parseInt((ARGS.find(a => a.startsWith("--seed=")) || "--seed=42").split("=")[1], 10);

// Deterministic PRNG so a 10-day run is reproducible.
function mulberry(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry(SEED_NUM);
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }

// ── REALISTIC SPEND TEMPLATES ──
const SPEND_TEMPLATES = [
  // [probability weight, message generator, tendency note]
  { w: 4,  fn: () => "spent " + pick([4, 5, 6, 7]) + " on coffee" },
  { w: 4,  fn: () => "got coffee, " + pick([4, 5, 6]) + " bucks" },
  { w: 2,  fn: () => "groceries " + pick([35, 42, 60, 78, 90]) },
  { w: 2,  fn: () => "lunch " + pick([12, 15, 18, 22]) + " at work" },
  { w: 1,  fn: () => "dinner out " + pick([35, 50, 65, 80]) },
  { w: 1,  fn: () => "uber home, " + pick([12, 18, 25]) },
  { w: 1,  fn: () => "gas " + pick([40, 50, 65]) },
  { w: 1,  fn: () => "spent " + pick([15, 25, 30]) + " on lunch delivery" },
  { w: 0.5, fn: () => pick([28, 35, 45]) + " for haircut" },
  { w: 0.5, fn: () => "amazon order " + pick([22, 35, 80, 110]) },
  { w: 0.3, fn: () => "movie tickets " + pick([18, 24, 30]) },
];
const TOTAL_W = SPEND_TEMPLATES.reduce((s, t) => s + t.w, 0);
function pickSpendMessage() {
  let r = rand() * TOTAL_W;
  for (const t of SPEND_TEMPLATES) {
    r -= t.w;
    if (r <= 0) return t.fn();
  }
  return SPEND_TEMPLATES[0].fn();
}

const AFFORD_QUERIES = [
  "can I afford a $200 jacket?",
  "is a $50 dinner ok?",
  "could I do a $300 weekend trip?",
  "should I get a $80 keyboard?",
];

// ── MAIN ──
(async () => {
  const aiBackend = getBackend();
  console.log("Long-sim: " + DAYS + " days, checkpoint every " + CHECKPOINT + " days, AI=" + (aiBackend.label || "?") + ", seed=" + SEED_NUM);

  const prisma = createMockPrisma();
  const chat = createMockChat({ userId: 200001, language_code: "en" });
  const aiOptions = { _aiCall: aiBackend };

  const reportDir = path.join(__dirname, "reports", "long-sim-" + new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(reportDir, { recursive: true });

  // Day-zero: onboarding. User dumps everything in one message.
  const setupMsg = "I have about 5000 in checking, get paid the 25th of each month";
  const ctx0 = chat.makeIncomingTextCtx(setupMsg);
  await bot.processText(prisma, ctx0, chat.user.id, setupMsg, aiOptions);

  // Add a recurring bill on day 1.
  const billMsg = "rent is 1400 due the 1st";
  const ctxBill = chat.makeIncomingTextCtx(billMsg);
  await bot.processText(prisma, ctxBill, chat.user.id, billMsg, aiOptions);
  await tapButton(chat, prisma, /yes/i);

  console.log("Day 0 setup done. Balance:", await readBalance(prisma, chat));

  const checkpoints = [];

  for (let day = 1; day <= DAYS; day++) {
    // 1-3 events most days (active user). Distribution skews to 1-2.
    const r = rand();
    const events = r < 0.15 ? 0 : r < 0.55 ? 1 : r < 0.85 ? 2 : 3;
    for (let e = 0; e < events; e++) {
      const eventType = rand();
      let msg;
      if (eventType < 0.85) {
        msg = pickSpendMessage();
      } else if (eventType < 0.92) {
        msg = pick(AFFORD_QUERIES);
      } else {
        msg = pick(["how am I doing?", "what's my balance?", "today"]);
      }
      try {
        const ctx = chat.makeIncomingTextCtx(msg);
        await bot.processText(prisma, ctx, chat.user.id, msg, aiOptions);
        // Auto-tap any [Yes] button that appears (user is committed to log).
        // For [Skip]/[No], leave them — represents user just looking.
        if (eventType < 0.85) {
          await tapButton(chat, prisma, /yes/i);
        } else if (eventType < 0.92) {
          // 50/50 to log or skip on "afford" check.
          await tapButton(chat, prisma, rand() < 0.5 ? /log it/i : /skip|нет/i);
        }
      } catch (err) {
        chat.transcript.push({ dir: "·", kind: "sim_error", text: "day " + day + ": " + err.message });
      }
    }

    // Periodically: paycheck on payday.
    const balance = await readBalance(prisma, chat);
    const state = await currentState(prisma, chat);
    if (state.payday && m.daysBetween(m.today("UTC"), state.payday) === -1) {
      // Yesterday was payday — bot should have advanced it. Simulate income event.
      const payMsg = "got paid 4000";
      const ctx = chat.makeIncomingTextCtx(payMsg);
      await bot.processText(prisma, ctx, chat.user.id, payMsg, aiOptions);
      await tapButton(chat, prisma, /yes/i);
    }

    // Bill payment day (when rent becomes due today)
    if (state.bills) {
      for (const bk of Object.keys(state.bills)) {
        const b = state.bills[bk];
        if (m.daysBetween(m.today("UTC"), b.dueDate) === 0 && !b.paidThisCycle) {
          const payBill = "paid rent";
          const ctx = chat.makeIncomingTextCtx(payBill);
          await bot.processText(prisma, ctx, chat.user.id, payBill, aiOptions);
          await tapButton(chat, prisma, /yes/i);
        }
      }
    }

    // Checkpoint: render the user's view, ask the judge how it feels.
    if (day % CHECKPOINT === 0) {
      const cp = await runCheckpoint(prisma, chat, day, aiBackend);
      checkpoints.push(cp);
      console.log("Day " + day + " checkpoint score: " + cp.score + "/10  (" + cp.summary + ")");
      fs.writeFileSync(path.join(reportDir, "checkpoint-day-" + String(day).padStart(3, "0") + ".txt"),
        "# Checkpoint day " + day + "\n# score=" + cp.score + "/10\n\n" +
        "## RECENT TRANSCRIPT (last 20 events)\n" + cp.recent + "\n\n" +
        "## HERO LINE\n" + cp.hero + "\n\n" +
        "## DNA\n" + cp.dnaText + "\n\n" +
        "## STATE SUMMARY\n" + JSON.stringify(cp.stateSummary, null, 2) + "\n\n" +
        "## JUDGE VERDICT\n" + JSON.stringify(cp.judgeRaw, null, 2));
    }
  }

  // Final report
  const final = {
    days: DAYS,
    checkpoints,
    averageScore: checkpoints.length > 0
      ? (checkpoints.reduce((s, c) => s + (c.score || 0), 0) / checkpoints.length).toFixed(2)
      : "n/a",
    finalState: await currentState(prisma, chat),
  };
  fs.writeFileSync(path.join(reportDir, "final-summary.json"), JSON.stringify(final, null, 2));
  fs.writeFileSync(path.join(reportDir, "full-transcript.txt"), renderTranscript(chat));

  console.log("\n=== LONG SIM DONE ===");
  console.log("Days: " + DAYS);
  console.log("Average checkpoint score: " + final.averageScore + "/10");
  console.log("Final balance: " + m.toMoney(final.finalState.balanceCents));
  console.log("Total transactions: " + (final.finalState.transactions || []).length);
  console.log("Reports: " + reportDir);
})().catch(e => { console.error(e); process.exit(1); });

// ── HELPERS ──
async function tapButton(chat, prisma, matchRe) {
  const last = chat.lastInlineButtons();
  if (!last || last.buttons.length === 0) return false;
  let target = null;
  for (const b of last.buttons) {
    if (matchRe.test(b.text)) { target = b; break; }
  }
  if (!target) return false;
  chat.setCurrentEditTarget(last.messageId);
  const ctx = chat.makeIncomingCallbackCtx(target, last.messageId);
  await bot.processCallbackData(prisma, ctx, chat.user.id, target.callback_data);
  return true;
}

async function currentState(prisma, chat) {
  const u = await db.resolveUser(prisma, "tg_" + chat.user.id);
  return await db.loadState(prisma, u.id);
}

async function readBalance(prisma, chat) {
  const s = await currentState(prisma, chat);
  return m.toMoney(s.balanceCents || 0);
}

// Slice the last N transcript events for the checkpoint judge.
function tailTranscript(chat, n) {
  const tail = chat.transcript.slice(Math.max(0, chat.transcript.length - n));
  // Render just this slice.
  const fakeChat = { transcript: tail };
  return renderTranscript(fakeChat);
}

async function runCheckpoint(prisma, chat, day, aiCall) {
  const state = await currentState(prisma, chat);
  const view = compute(state);
  const hero = heroLine(state, "en");
  const graph = dna.compute(state);
  const dnaText = dna.renderForPrompt(graph);
  const recent = tailTranscript(chat, 30);

  const stateSummary = {
    day,
    setup: state.setup,
    balance: m.toMoney(state.balanceCents),
    payday: state.payday,
    payFrequency: state.payFrequency,
    bills: Object.keys(state.bills || {}),
    txCount: (state.transactions || []).length,
    eventCount: (state.events || []).length,
    status: view.status,
    dailyPace: view.dailyPaceFormatted,
    daysToPayday: view.daysToPayday,
  };

  const system = [
    "You are evaluating a personal-finance Telegram bot named SpendYes from a USER'S perspective on day " + day + " of usage.",
    "Imagine you are the user. You opened the bot. You see the hero line, you remember recent interactions, and the bot has a 'DNA summary' it could use to give you smart insights.",
    "",
    "ASK YOURSELF:",
    "1. Does the bot UNDERSTAND ME by now? Has it picked up my patterns?",
    "2. Is the hero line USEFUL or just numbers?",
    "3. Has the bot ever felt confused, repeated itself, or lost context?",
    "4. Would I trust this bot with my real money decisions tomorrow?",
    "5. What's missing — something that would make me say \"this gets me\"?",
    "",
    "OUTPUT STRICT JSON:",
    '{"score":N,"summary":"5-15 word verdict","critique":["..."],"opportunities":["..."],"trustworthy":true|false}',
    "Score: 1 (would uninstall) → 10 (financial best friend).",
  ].join("\n");
  const userMsg = [
    "DAY " + day + " STATE:",
    JSON.stringify(stateSummary, null, 2),
    "",
    "HERO LINE THE USER SEES:",
    hero,
    "",
    "DNA SUMMARY THE BOT KNOWS:",
    dnaText || "(empty)",
    "",
    "RECENT INTERACTIONS:",
    recent || "(none)",
  ].join("\n");

  let raw = "";
  try {
    raw = await aiCall([{ role: "system", content: system }, { role: "user", content: userMsg }]);
  } catch (e) {
    return { day, score: 0, summary: "judge call failed: " + e.message, recent, hero, dnaText, stateSummary, judgeRaw: { error: e.message } };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { parsed = { score: 0, summary: "judge JSON parse failed", critique: [raw.slice(0, 200)], opportunities: [] }; }

  return {
    day,
    score: parsed.score || 0,
    summary: parsed.summary || "",
    trustworthy: !!parsed.trustworthy,
    critique: parsed.critique || [],
    opportunities: parsed.opportunities || [],
    recent, hero, dnaText, stateSummary, judgeRaw: parsed,
  };
}
