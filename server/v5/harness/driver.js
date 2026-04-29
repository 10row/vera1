"use strict";
// driver.js — runs a scenario through the actual v5 bot using mock Telegram + mock prisma.
// A scenario describes what a user does. The driver:
//   1. Creates a fresh mock chat + prisma.
//   2. Plays each user action (text or button tap) through the bot.
//   3. Returns the final transcript + state for grading.
//
// Real OpenAI calls are made unless _aiCall is stubbed. We do not stub by
// default — the whole point is to test against the real model.

const path = require("path");
const { createMockChat, renderTranscript } = require("./telegram-mock");
const { createMockPrisma } = require("./prisma-mock");
const { getBackend } = require("./ai-backend");
const bot = require("../bot");
const db = require("../db");

// Run a scenario.
// scenario shape:
//   {
//     name: "string",
//     user: { language_code?: "en"|"ru", id?: 123 },
//     steps: [
//       { type: "text",    text: "hi" },
//       { type: "command", command: "start" },
//       { type: "tap",     match: /yes|log it/i },     // tap matching button
//       { type: "wait",    ms: 100 },                  // (rare)
//     ],
//   }
async function runScenario(scenario, options) {
  options = options || {};
  const prisma = createMockPrisma();
  const chat = createMockChat({
    userId: (scenario.user && scenario.user.id) || 100001,
    language_code: (scenario.user && scenario.user.language_code) || "en",
  });

  const log = options.log === undefined ? false : options.log;
  const aiCall = options._aiCall || getBackend();
  const aiOptions = { _aiCall: aiCall };

  for (const step of scenario.steps) {
    try {
      if (step.type === "text") {
        const ctx = chat.makeIncomingTextCtx(step.text);
        await bot.processText(prisma, ctx, chat.user.id, step.text, aiOptions);
      } else if (step.type === "command") {
        const ctx = chat.makeIncomingTextCtx("/" + step.command);
        await bot.processCommand(prisma, ctx, chat.user.id, step.command);
      } else if (step.type === "tap") {
        const last = chat.lastInlineButtons();
        if (!last || last.buttons.length === 0) {
          chat.transcript.push({ dir: "·", kind: "tap_skip", text: "no buttons available; skipping" });
          continue;
        }
        let target = null;
        for (const b of last.buttons) {
          if (step.match instanceof RegExp ? step.match.test(b.text) : b.text.toLowerCase().includes(String(step.match || "").toLowerCase())) {
            target = b;
            break;
          }
        }
        if (!target) target = last.buttons[0]; // fallback: first button
        chat.setCurrentEditTarget(last.messageId);
        const ctx = chat.makeIncomingCallbackCtx(target, last.messageId);
        await bot.processCallbackData(prisma, ctx, chat.user.id, target.callback_data);
      } else if (step.type === "wait") {
        await new Promise(r => setTimeout(r, step.ms || 50));
      }
    } catch (e) {
      chat.transcript.push({ dir: "·", kind: "error", text: e.message + " @ " + step.type });
    }
    if (log) {
      console.log("\n--- after " + step.type + " " + (step.text || step.command || step.match || "") + " ---");
      console.log(renderTranscript(chat));
    }
  }

  // Final state snapshot.
  let finalState = null;
  try {
    const u = await db.resolveUser(prisma, "tg_" + chat.user.id);
    finalState = await db.loadState(prisma, u.id);
  } catch {}

  return {
    name: scenario.name,
    transcript: chat.transcript,
    rendered: renderTranscript(chat),
    finalState,
  };
}

module.exports = { runScenario };
