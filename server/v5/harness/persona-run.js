"use strict";
// persona-run.js — multi-turn conversation harness.
//
// Loads a persona JSON, drives a conversation for N turns where the
// persona LLM acts as the user. Each turn:
//   1. Persona generates the next user message based on profile + goals
//      + conversation so far + bot's last reply.
//   2. Bot processes via real AI + pipeline + mock Telegram.
//   3. If a confirm card appears, persona decides yes/no based on the
//      `confirmBehavior` rule.
//
// Outputs:
//   harness/persona-runs/<persona>-<ts>/transcript.html
//   harness/persona-runs/<persona>-<ts>/transcript.json
//   harness/persona-runs/<persona>-<ts>/judge.json (run via persona-judge.js after)
//
// Usage:
//   node server/v5/harness/persona-run.js alex 20
//   node server/v5/harness/persona-run.js olga 15
//   node server/v5/harness/persona-run.js all 20

require("dotenv").config({ override: true });

const fs = require("fs");
const path = require("path");
const { createMockChat, renderTranscript } = require("./telegram-mock");
const { createMockPrisma } = require("./prisma-mock");
const { getBackend } = require("./ai-backend");
const bot = require("../bot");
const db = require("../db");

const PERSONA_DIR = path.join(__dirname, "personas");
const RUN_DIR = path.join(__dirname, "persona-runs");

function loadPersona(id) {
  const p = path.join(PERSONA_DIR, id + ".json");
  if (!fs.existsSync(p)) throw new Error("Persona not found: " + id);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Persona LLM: generates the NEXT user message given persona profile,
// agenda, recent conversation, and what the bot just said.
async function generatePersonaTurn(persona, conversation, turnNum) {
  const ai = getBackend();
  const recent = conversation.slice(-10).map(c =>
    c.role === "user" ? "USER: " + c.text : "BOT: " + c.text
  ).join("\n");

  const sys = [
    "You are role-playing a real person texting a personal-finance Telegram bot called SpendYes.",
    "STAY 100% IN CHARACTER — every message must match the persona's voice exactly.",
    "",
    "PERSONA PROFILE:",
    JSON.stringify(persona.profile, null, 2),
    "",
    "MONEY SITUATION (your real life):",
    JSON.stringify(persona.money, null, 2),
    "",
    "VOICE STYLE:",
    JSON.stringify(persona.voice, null, 2),
    "",
    "AGENDA over ~20 turns (soft goal — improvise around it):",
    persona.agenda,
    "",
    "RULES:",
    "1. Reply in your character's LANGUAGE: " + persona.language_code + " — never switch.",
    "2. Match the voice samples exactly — same casing, slang, terseness, punctuation habits.",
    "3. If the bot replied confused or wrong, react in character (frustration, retry, clarify).",
    "4. Don't invent fake balance numbers — use the money situation above.",
    "5. Keep messages SHORT — like real texting. 1-3 lines max usually.",
    "6. Output JSON: { \"text\": \"the message\", \"confirmDecision\": \"yes\"|\"no\"|null }",
    "   - text: what you (as the persona) say next",
    "   - confirmDecision: only meaningful if the bot's last reply showed a confirm card. yes/no based on whether the card matches what you meant. null otherwise.",
    "",
    "CURRENT TURN: " + turnNum + " of ~20",
    "",
    "RECENT CONVERSATION (last 10 messages):",
    recent || "(none yet — this is your opening message)",
    "",
    "Generate your next message as the persona.",
  ].join("\n");

  const raw = await ai([
    { role: "system", content: sys },
    { role: "user", content: "Your turn. Output strict JSON." },
  ]);
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    // Fallback: try to extract the first quoted string.
    const m = raw.match(/"([^"]{2,200})"/);
    parsed = { text: m ? m[1] : raw.slice(0, 200), confirmDecision: null };
  }
  return {
    text: String(parsed.text || "").slice(0, 600),
    confirmDecision: parsed.confirmDecision === "yes" || parsed.confirmDecision === "no" ? parsed.confirmDecision : null,
  };
}

async function runConversation(personaId, turns) {
  const persona = loadPersona(personaId);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(RUN_DIR, personaId + "-" + ts);
  fs.mkdirSync(outDir, { recursive: true });

  const prisma = createMockPrisma();
  const chat = createMockChat({
    userId: 100000 + Math.floor(Math.random() * 999),
    language_code: persona.language_code || "en",
  });

  // Capture raw AI outputs from inside the bot too — useful for diagnostics.
  const botAi = getBackend();
  const botRawCaptures = [];
  const wrappedBotAi = async (msgs) => {
    const r = await botAi(msgs);
    botRawCaptures.push({ turn: conversation.length + 1, raw: typeof r === "string" ? r : JSON.stringify(r) });
    return r;
  };
  const aiOptions = { _aiCall: wrappedBotAi };

  // Conversation array — what the persona LLM sees (user/bot messages).
  const conversation = [];

  console.log("=== " + persona.displayName + " (" + persona.language_code + ") — " + turns + " turns ===\n");

  for (let turn = 1; turn <= turns; turn++) {
    let personaMsg;
    try {
      personaMsg = await generatePersonaTurn(persona, conversation, turn);
    } catch (e) {
      console.log("[turn " + turn + "] persona LLM failed: " + e.message);
      break;
    }

    console.log("[" + turn + "] USER: " + personaMsg.text);
    conversation.push({ role: "user", text: personaMsg.text });

    // Send to the bot.
    const ctx = chat.makeIncomingTextCtx(personaMsg.text);
    try {
      await bot.processText(prisma, ctx, chat.user.id, personaMsg.text, aiOptions);
    } catch (e) {
      console.log("    BOT CRASH: " + e.message);
      conversation.push({ role: "bot", text: "(crash: " + e.message + ")" });
      continue;
    }

    // Capture all bot replies since last user message.
    const newReplies = [];
    for (let i = chat.transcript.length - 1; i >= 0; i--) {
      const e = chat.transcript[i];
      if (e.dir === "→") break;
      if (e.dir === "←" && (e.kind === "reply" || e.kind === "edit")) newReplies.unshift(e);
    }
    let botCombined = "";
    for (const r of newReplies) {
      const buttons = r.inline_keyboard ? "  [buttons: " + r.inline_keyboard.flat().map(b => b.text).join(" / ") + "]" : "";
      botCombined += (botCombined ? "\n" : "") + (r.kind === "edit" ? "(edit) " : "") + r.text + buttons;
    }
    if (botCombined) {
      console.log("    BOT: " + botCombined.split("\n").join("\n    BOT: "));
      conversation.push({ role: "bot", text: botCombined });
    }

    // If a confirm card is showing, decide based on persona behavior.
    const last = chat.lastInlineButtons();
    if (last && last.buttons.length > 0) {
      const decision = personaMsg.confirmDecision || autoDecide(persona, last.buttons);
      const target = pickButton(last.buttons, decision);
      if (target) {
        chat.setCurrentEditTarget(last.messageId);
        const cbCtx = chat.makeIncomingCallbackCtx(target, last.messageId);
        try {
          await bot.processCallbackData(prisma, cbCtx, chat.user.id, target.callback_data);
          console.log("    [tap " + target.text + "]");
          conversation.push({ role: "user", text: "(tapped: " + target.text + ")" });
          // Capture follow-up replies after the tap.
          const followUps = [];
          for (let i = chat.transcript.length - 1; i >= 0; i--) {
            const e = chat.transcript[i];
            if (e.dir === "→") break;
            if (e.dir === "←" && (e.kind === "reply" || e.kind === "edit")) followUps.unshift(e);
          }
          let combined = "";
          for (const r of followUps) {
            combined += (combined ? "\n" : "") + (r.kind === "edit" ? "(edit) " : "") + r.text;
          }
          if (combined) {
            console.log("    BOT: " + combined.split("\n").join("\n    BOT: "));
            conversation.push({ role: "bot", text: combined });
          }
        } catch (e) {
          console.log("    [tap CRASH: " + e.message + "]");
        }
      }
    }
  }

  // Snapshot final state.
  const u = await db.resolveUser(prisma, "tg_" + chat.user.id);
  const finalState = await db.loadState(prisma, u.id);

  // Write artifacts.
  fs.writeFileSync(path.join(outDir, "transcript.json"), JSON.stringify({
    persona: { id: persona.id, name: persona.displayName, lang: persona.language_code },
    turns,
    conversation,
    finalState: {
      setup: finalState.setup,
      balanceCents: finalState.balanceCents,
      bills: Object.values(finalState.bills || {}).map(b => ({ name: b.name, amountCents: b.amountCents, due: b.dueDate })),
      transactionCount: (finalState.transactions || []).length,
      eventCount: (finalState.events || []).length,
    },
    chatTranscript: chat.transcript,
    botAiRaw: botRawCaptures,
    timestamp: new Date().toISOString(),
  }, null, 2));
  fs.writeFileSync(path.join(outDir, "transcript.html"), renderHtml(persona, chat));
  console.log("\n→ " + outDir);
  return { outDir, persona, finalState };
}

function autoDecide(persona, buttons) {
  // Default: tap "yes" / "log it" / "да". Sam often blindly says yes.
  const yesPatterns = /yes|log|да|сохран|подтверд/i;
  if (buttons.some(b => yesPatterns.test(b.text))) return "yes";
  return "yes";
}
function pickButton(buttons, decision) {
  const yesRe = /yes|log|да|сохран|подтверд/i;
  const noRe = /cancel|skip|no|отмен|пропусти|нет/i;
  if (decision === "no") return buttons.find(b => noRe.test(b.text)) || null;
  return buttons.find(b => yesRe.test(b.text)) || buttons[0];
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
  return `<!doctype html><meta charset="utf-8"><title>${escape(persona.displayName)} (${persona.id})</title>
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
<h2>${escape(persona.displayName)} · ${persona.language_code}</h2>
${bubbles}`;
}

(async () => {
  const args = process.argv.slice(2);
  const personaId = args[0];
  const turns = parseInt(args[1] || "20", 10);
  if (!personaId) {
    console.error("Usage: node persona-run.js <alex|olga|sam|all> [turns]");
    process.exit(2);
  }
  if (personaId === "all") {
    // Auto-discover all *.json in personas/ so new ones get included.
    const fs2 = require("fs"), path2 = require("path");
    const dir = path2.join(__dirname, "personas");
    const ids = fs2.readdirSync(dir).filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, ""));
    for (const id of ids) {
      try { await runConversation(id, turns); } catch (e) { console.error("[" + id + "] " + e.message); }
      console.log("\n");
    }
  } else {
    await runConversation(personaId, turns);
  }
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
