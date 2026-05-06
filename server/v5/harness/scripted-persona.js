"use strict";
// scripted-persona.js — drive a HAND-WRITTEN message list through the
// real bot. No Anthropic, no Claude judge — only OpenAI (which the bot
// already uses for intent extraction).
//
// The benefit vs LLM-driven personas: I (or you) hand-pick messages
// that intentionally probe edges. More adversarial than a "helpful"
// LLM persona that self-corrects mid-conversation.
//
// Usage:
//   node server/v5/harness/scripted-persona.js jenna
//   node server/v5/harness/scripted-persona.js jenna --confirm=auto-yes
//
// Output:
//   server/v5/harness/persona-runs/<id>-scripted-<ts>/
//     transcript.html — chat-styled view
//     transcript.json — full machine log + AI raw output per turn
//     summary.txt     — one-line per turn for quick scanning

require("dotenv").config({ override: true });
const fs = require("fs");
const path = require("path");
const { createMockChat, renderTranscript } = require("./telegram-mock");
const { createMockPrisma } = require("./prisma-mock");
const bot = require("../bot");
const db = require("../db");
const m = require("../model");
const { applyIntent } = require("../engine");

// ── HAND-SCRIPTED MESSAGE LISTS (1 per persona) ─────
// Each list is what a REAL human texts, including:
//   - vague openers
//   - mid-message corrections
//   - questions that don't map to features
//   - life context bleeding into money messages
//   - foreign currency
//   - subscriptions / domain-payment style bills
//   - a /today check
//   - a /reset and re-onboard
const SCRIPTS = {
  jenna: [
    "ok lets do this",
    "i think 6100 in checking but maybe 6200 idk",
    "paid 1st and 15th",
    "rent is 2200 due 1st",
    "actually wait it's 2250",
    "phone bill is 85 monthly on the 12th",
    "my podcast hosting is 19 a month due the 20th",
    "domain renewal coming up, $120 due aug 30",
    "logged a $14 lunch",
    "scratch that it was 12",
    "/today",
    "i'm in vienna for work this week, eur40 on dinner",
    "200000 dong on coffee in vietnam",
    "got engaged this weekend, ring was 2000 oof",
    "should i save more or just enjoy?",
    "what was my biggest spend last month",
    "set up auto-save 200 a month",
    "transfer 500 from checking to savings",
    "im stressed about money btw",
    "/today",
    "paid the phone bill",
    "delete that last one",
    "/undo",
    "/reset",
    "actually nevermind",
  ],
};

async function runScripted(personaId, opts) {
  opts = opts || {};
  const script = SCRIPTS[personaId];
  if (!script) {
    throw new Error("No script for persona: " + personaId + ". Available: " + Object.keys(SCRIPTS).join(", "));
  }
  const personaPath = path.join(__dirname, "personas", personaId + ".json");
  const personaMeta = fs.existsSync(personaPath) ? JSON.parse(fs.readFileSync(personaPath, "utf8")) : { id: personaId, displayName: personaId, language_code: "en" };

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(__dirname, "persona-runs", personaId + "-scripted-" + ts);
  fs.mkdirSync(outDir, { recursive: true });

  const prisma = createMockPrisma();
  const chat = createMockChat({
    userId: 100000 + Math.floor(Math.random() * 999),
    language_code: personaMeta.language_code || "en",
  });

  // Wrap the bot's AI call to capture raw output per turn.
  const turns = [];
  let currentTurn = null;
  const aiOptions = {
    _aiCall: async (msgs) => {
      // Use the real default backend (OpenAI for the bot).
      const OpenAI = require("openai");
      const openai = new OpenAI();
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 700,
        response_format: { type: "json_object" },
        messages: msgs,
      }, { timeout: 15000 });
      const raw = resp.choices && resp.choices[0] && resp.choices[0].message
        ? resp.choices[0].message.content || ""
        : "";
      if (currentTurn) currentTurn.aiRaw.push(raw);
      return raw;
    },
  };

  console.log("=== " + personaMeta.displayName + " (scripted, " + script.length + " turns) ===\n");

  for (let i = 0; i < script.length; i++) {
    const userMsg = script[i];
    currentTurn = { idx: i + 1, user: userMsg, botReplies: [], aiRaw: [], taps: [] };
    turns.push(currentTurn);

    console.log("[" + (i + 1) + "] U: " + userMsg);

    try {
      // Commands route through processCommand; everything else through processText.
      if (userMsg.startsWith("/")) {
        const cmd = userMsg.slice(1).split(/\s+/)[0];
        const knownCmds = ["start", "today", "undo", "reset", "app", "debug"];
        if (knownCmds.includes(cmd)) {
          const ctx = chat.makeIncomingTextCtx(userMsg);
          await bot.processCommand(prisma, ctx, chat.user.id, cmd);
        } else {
          const ctx = chat.makeIncomingTextCtx(userMsg);
          await bot.processText(prisma, ctx, chat.user.id, userMsg, aiOptions);
        }
      } else {
        const ctx = chat.makeIncomingTextCtx(userMsg);
        await bot.processText(prisma, ctx, chat.user.id, userMsg, aiOptions);
      }
    } catch (e) {
      currentTurn.botReplies.push("CRASH: " + e.message);
      console.log("    BOT CRASH: " + e.message);
      continue;
    }

    // Pull the bot replies that came AFTER this user message.
    const newReplies = [];
    for (let j = chat.transcript.length - 1; j >= 0; j--) {
      const e = chat.transcript[j];
      if (e.dir === "→") break;
      if (e.dir === "←" && (e.kind === "reply" || e.kind === "edit")) newReplies.unshift(e);
    }
    for (const r of newReplies) {
      const buttons = (r.inline_keyboard || []).flat().map(b => "[" + b.text + "]").join(" ");
      const text = (r.kind === "edit" ? "(edit) " : "") + r.text + (buttons ? "  " + buttons : "");
      currentTurn.botReplies.push(text);
      console.log("    B: " + text.split("\n").join("\n    B: "));
    }

    // Auto-confirm: if a confirm card showed up, tap Yes (unless we're on
    // a "reset" or "delete" line where we'd want Cancel — those scripts
    // contain the next line themselves so just tap Yes universally).
    const last = chat.lastInlineButtons();
    if (last && last.buttons.length > 0) {
      let target = last.buttons.find(b => /yes|log|да|сохран/i.test(b.text));
      // For reset confirm, ALSO tap yes (the next message in the script
      // continues). If the user wrote "actually nevermind", they handle
      // it textually next turn anyway.
      if (!target) target = last.buttons[0];
      chat.setCurrentEditTarget(last.messageId);
      const cbCtx = chat.makeIncomingCallbackCtx(target, last.messageId);
      try {
        await bot.processCallbackData(prisma, cbCtx, chat.user.id, target.callback_data);
        currentTurn.taps.push(target.text);
        console.log("    [tap " + target.text + "]");
        // Capture follow-up replies after the tap.
        const after = [];
        for (let j = chat.transcript.length - 1; j >= 0; j--) {
          const e = chat.transcript[j];
          if (e.dir === "→") break;
          if (e.dir === "←" && (e.kind === "reply" || e.kind === "edit")) after.unshift(e);
        }
        for (const r of after) {
          const text = (r.kind === "edit" ? "(edit) " : "") + r.text;
          currentTurn.botReplies.push(text);
          console.log("    B: " + text.split("\n").join("\n    B: "));
        }
      } catch (e) {
        console.log("    [tap CRASH: " + e.message + "]");
      }
    }
    console.log("");
  }

  // Final state.
  const u = await db.resolveUser(prisma, "tg_" + chat.user.id);
  const finalState = await db.loadState(prisma, u.id);

  // Write artifacts.
  fs.writeFileSync(path.join(outDir, "transcript.json"), JSON.stringify({
    persona: personaMeta,
    script,
    turns,
    finalState: {
      setup: finalState.setup,
      balanceCents: finalState.balanceCents,
      bills: Object.values(finalState.bills || {}).map(b => ({
        name: b.name, amountCents: b.amountCents, dueDate: b.dueDate, recurrence: b.recurrence,
      })),
      transactionCount: (finalState.transactions || []).length,
      eventCount: (finalState.events || []).length,
    },
    chatTranscript: chat.transcript,
    timestamp: new Date().toISOString(),
  }, null, 2));

  fs.writeFileSync(path.join(outDir, "transcript.html"), renderHtml(personaMeta, chat));

  // One-line-per-turn summary for quick eyeballing.
  const summary = turns.map(t => {
    const b = (t.botReplies[0] || "").slice(0, 90).replace(/\n/g, " / ");
    return "[" + t.idx + "] U: " + t.user.slice(0, 60) + "\n      B: " + b;
  }).join("\n");
  fs.writeFileSync(path.join(outDir, "summary.txt"), summary);

  console.log("\n=== DONE ===");
  console.log("turns: " + turns.length);
  console.log("final.setup: " + finalState.setup);
  console.log("final.bills: " + Object.values(finalState.bills || {}).map(b => b.name).join(", "));
  console.log("final.balanceCents: " + finalState.balanceCents);
  console.log("transactions: " + (finalState.transactions || []).length);
  console.log("→ " + outDir);

  return { outDir, finalState, turns };
}

function renderHtml(persona, chat) {
  const escape = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const bubbles = chat.transcript.map(e => {
    if (e.dir === "→" && e.kind === "text") return `<div class="row me"><div class="bubble me">${escape(e.text)}</div></div>`;
    if (e.dir === "→" && e.kind === "tap") return `<div class="row me-tap"><div class="tap">tapped: ${escape(e.text)}</div></div>`;
    if (e.dir === "←" && (e.kind === "reply" || e.kind === "edit")) {
      const editTag = e.kind === "edit" ? `<span class="edit-tag">(edit)</span>` : "";
      const buttons = (e.inline_keyboard || []).map(row =>
        `<div class="btnrow">${row.map(b => `<span class="btn">${escape(b.text)}</span>`).join("")}</div>`
      ).join("");
      const text = escape(e.text || "").replace(/\n/g, "<br>");
      return `<div class="row bot"><div class="bubble bot">${editTag}${text}${buttons}</div></div>`;
    }
    return "";
  }).join("\n");
  return `<!doctype html><meta charset="utf-8"><title>${escape(persona.displayName || persona.id)}</title>
<style>
body { background:#0F0F0F; color:#EFEFEF; font:14px/1.5 -apple-system,sans-serif; padding:20px; max-width:600px; margin:auto; }
h2 { font-weight:500; color:#888; font-size:14px; }
.row { display:flex; margin:8px 0; }
.row.me, .row.me-tap { justify-content:flex-end; }
.bubble { max-width:80%; padding:10px 14px; border-radius:14px; }
.bubble.me { background:#2B5278; color:#fff; }
.bubble.bot { background:#1f1f1f; color:#EFEFEF; }
.tap { font-size:11px; color:#888; padding:4px 10px; background:#222; border-radius:8px; }
.edit-tag { color:#888; font-size:11px; margin-right:6px; }
.btnrow { display:flex; gap:6px; margin-top:8px; }
.btn { background:#2B5278; padding:6px 12px; border-radius:6px; font-size:12px; }
</style>
<h2>${escape(persona.displayName || persona.id)} · scripted run</h2>
${bubbles}`;
}

(async () => {
  const id = process.argv[2];
  if (!id) {
    console.error("Usage: node scripted-persona.js <id>  (jenna, ...)");
    process.exit(2);
  }
  await runScripted(id);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
