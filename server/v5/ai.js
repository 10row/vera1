"use strict";
// v5/ai.js — extract ONE intent from a user message. POST-SETUP ONLY.
//
// The bot's onboarding state machine handles !setup users. By the time
// this AI runs, state.setup is always true. That eliminates the whole
// class of "setting up your account..." loops.
//
// Output contract (strict):
//   { mode: "do",   message: "...", intent: { kind, params } }
//   { mode: "talk", message: "..." }
//   { mode: "ask_simulate", message: "...", amountCents: N }   // "can I afford X" — read-only
// Anything else → fallback to talk with a generic reply.

const m = require("./model");
const { compute } = require("./view");

const MODEL = "gpt-4o-mini";
const MAX_TOKENS = 500;
const TIMEOUT_MS = 15000;

function buildSystemPrompt(state) {
  const v = compute(state);
  const lang = state.language === "ru" ? "ru" : "en";

  // Snapshot of facts. AI must not invent numbers.
  const snap = {
    balance: v.balanceFormatted,
    disposable: v.disposableFormatted,
    daily_pace: v.dailyPaceFormatted,
    days_to_payday: v.daysToPayday,
    payday: v.payday,
    status: v.status,
    bills: v.bills.map(b => ({ name: b.name, amount: b.amountFormatted, due: b.dueDate, paid: b.paidThisCycle })),
  };

  return [
    "You are SpendYes — a warm, pragmatic money buddy on Telegram.",
    "Your job: extract ONE intent (action) per user message, OR reply conversationally.",
    "",
    "★ HARD RULES ★",
    "1. The user is ALREADY SET UP. NEVER emit setup_account. Use adjust_balance to fix balance.",
    "2. Output STRICT JSON only. One of these shapes:",
    '   { "mode":"do",   "message":"reply text", "intent":{"kind":"...","params":{...}} }',
    '   { "mode":"talk", "message":"reply text" }',
    '   { "mode":"ask_simulate", "message":"reply text", "amountCents":N }',
    "3. NEVER calculate. Quote numbers from STATE only. Don't add daily pace + days; that's the bot's job.",
    "4. ONE intent per message. If user mentions multiple actions, pick the most important and tell them to send the rest separately.",
    "5. Keep replies SHORT — 1-2 sentences. No paragraphs.",
    "6. NEVER say \"setting up your account\" or \"I'll set up\" — they're already set up. Use plain action words: \"logging\", \"adding\", \"recording\".",
    "",
    "INTENT KINDS:",
    '  adjust_balance  — { newBalanceCents:N }              // "actually I have $X now" / balance correction',
    '  add_bill        — { name:"Rent", amountCents:N, dueDate:"YYYY-MM-DD", recurrence:"monthly"|"weekly"|"biweekly"|"once" }',
    '  remove_bill     — { name:"Rent" }',
    '  record_spend    — { amountCents:N, note:"coffee", billKey?:"rent" }   // billKey to mark a bill as paid',
    '  record_income   — { amountCents:N, note:"paycheck" }',
    '  update_payday   — { payday:"YYYY-MM-DD", payFrequency:"monthly" }',
    '  undo_last       — {}',
    '  reset           — {}                                 // wipe everything (RARE)',
    "",
    "INTENT CHOICE GUIDE:",
    "- \"I spent X on Y\"      → record_spend",
    "- \"I got paid\" / \"got X\" → record_income",
    "- \"rent is X due 1st\"   → add_bill (recurrence: monthly, dueDate: next 1st from today)",
    "- \"actually I have X\"   → adjust_balance",
    "- \"can I afford X?\"     → ask_simulate (READ-ONLY — bot does the math)",
    "- \"undo\"                 → undo_last",
    "- vague / chat / question → talk mode",
    "",
    "AMOUNTS:",
    "- amountCents is INTEGER cents. \"$5\" → 500. \"$1,234.56\" → 123456.",
    "- \"5k\" → 500000. \"5.5k\" → 550000.",
    "",
    "DATES:",
    "- ISO YYYY-MM-DD. \"the 15th\" → next 15th from TODAY.",
    "- New bill dueDate must be today or future.",
    "",
    "STATE:",
    JSON.stringify(snap, null, 2),
    "",
    "TODAY: " + m.today(state.timezone || "UTC"),
    "LANGUAGE: " + lang + " (reply in this language).",
  ].join("\n");
}

async function defaultAiCall(messages) {
  const OpenAI = require("openai");
  const openai = new OpenAI();
  const resp = await openai.chat.completions.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    response_format: { type: "json_object" },
    messages,
  }, { timeout: TIMEOUT_MS });
  return resp.choices && resp.choices[0] && resp.choices[0].message
    ? resp.choices[0].message.content || ""
    : "";
}

// parseProposal returns a sanitized Proposal regardless of what the LLM said.
async function parseProposal(state, userMessage, history, options) {
  const opts = options || {};
  const aiCall = opts._aiCall || defaultAiCall;
  const system = buildSystemPrompt(state);
  const msgs = [
    { role: "system", content: system },
    ...((history || []).slice(-8)),
    { role: "user", content: String(userMessage || "") },
  ];

  let raw = "";
  try {
    raw = await aiCall(msgs);
  } catch (e) {
    return {
      mode: "talk",
      message: state.language === "ru" ? "Что-то пошло не так — попробуй ещё раз?" : "Sorry, brain blip — try that again?",
      warnings: ["ai_call_failed: " + e.message],
    };
  }

  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    return {
      mode: "talk",
      message: typeof raw === "string" && raw.length > 0 && raw.length < 400 ? raw : "…",
      warnings: ["json_parse_failed"],
    };
  }

  const message = typeof parsed.message === "string" ? parsed.message : "";

  // ask_simulate: read-only "can I afford X" path.
  if (parsed.mode === "ask_simulate" && Number.isFinite(parsed.amountCents) && parsed.amountCents > 0) {
    return {
      mode: "ask_simulate",
      message: message || "Looking at it.",
      amountCents: Math.round(parsed.amountCents),
      warnings: [],
    };
  }

  // do: a single intent. Drop arrays — strict single-intent contract.
  if (parsed.mode === "do" && parsed.intent && typeof parsed.intent.kind === "string") {
    return {
      mode: "do",
      message: message || (state.language === "ru" ? "Подтверди:" : "Quick check:"),
      intent: { kind: parsed.intent.kind, params: parsed.intent.params || {} },
      warnings: [],
    };
  }

  // Anything else → talk.
  return {
    mode: "talk",
    message: message || "…",
    warnings: [],
  };
}

module.exports = { parseProposal, buildSystemPrompt };
