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
const dna = require("./dna");

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
    "3. NEVER calculate. Quote numbers from STATE / DNA SUMMARY only. Don't add daily pace + days; that's the bot's job.",
    "4. ONE intent per message. If user mentions multiple actions, pick the most important and tell them to send the rest separately.",
    "5. Keep replies SHORT — 1-2 sentences. No paragraphs.",
    "6. NEVER say \"setting up your account\" or \"I'll set up\" — they're already set up. Use plain action words: \"logging\", \"adding\", \"recording\".",
    "7. USE THE DNA SUMMARY — it shows the user's recent spend patterns, top categories, recurring habits. When logging a spend or answering a question, ADD a tiny insight from DNA when relevant. Examples:",
    "   - User logs 'coffee 5' and DNA shows coffee already 4 txs at $20 in 7d → \"Logging coffee. That's 5 this week, $25 total — your usual.\"",
    "   - User asks 'how am I doing?' → quote spendLast7 + top category + bills load.",
    "   - User asks 'can I afford X?' → bot replies in ask_simulate mode; the orchestrator runs the math, but in your message hint at the post-balance feel.",
    "   Keep insights to ONE short sentence. Don't lecture. Don't always add an insight — only when it's meaningfully present in DNA.",
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
    "- \"I spent X on Y\" / \"X on Y\" / \"paid X for Y\" → record_spend",
    "- \"I got paid\" / \"got X\" / \"paycheck X\"        → record_income",
    "- \"rent is X due 1st\" / \"phone bill X monthly\" → add_bill",
    "- \"can I afford X?\" / \"is X ok?\" / \"could I X?\" → ask_simulate (READ-ONLY)",
    "- \"undo\"                                       → undo_last",
    "",
    "WHEN IN DOUBT BETWEEN do AND talk: pick do.",
    "- If the user mentions a number paired with a money concept (rent 1400, spent 25 on coffee, got 3000 paycheck, $50 on lunch), EXTRACT THE INTENT. Don't \"just acknowledge\" — the user is telling you to record something.",
    "- BAD: user says \"rent is 1400 due the 1st\" → you reply \"Got it, noted!\" (no intent). The bot can't act on that. The user's data is lost.",
    "- GOOD: same input → emit add_bill with name=Rent, amountCents=140000, dueDate=<next 1st>, recurrence=monthly. Reply \"Adding rent — $1,400 monthly.\"",
    "- If the user message has MULTIPLE actionable items (\"rent 1400 due 1st AND I spent 25 on coffee\"), pick the MOST IMPORTANT one (bills > income > big spend > small spend) and in your message acknowledge the rest: \"Adding rent. Heard you also spent 25 on coffee — send that as a separate note and I'll log it.\"",
    "",
    "BALANCE CORRECTION GUIDE — IMPORTANT:",
    "- adjust_balance is ONLY for explicit corrections, signaled by words like:",
    "  \"actually I have X\" / \"I now have X\" / \"my balance is now X\" / \"correction\" / \"update my balance to X\".",
    "- BARE restatements like \"I have 5000\" or \"I've got 5k\" — when the bot's STATE already shows that balance — are CONVERSATION, not a correction. Reply in talk mode: acknowledge that you have it on file (\"Yep, $5k is what I see — anything you want to change?\").",
    "- If the user states a number that DIFFERS clearly from STATE.balance (>= $100 difference) AND uses correction language → adjust_balance. Otherwise → talk.",
    "",
    "SETUP IS DONE. THE USER IS ALREADY SET UP.",
    "- NEVER emit setup_account.",
    "- NEVER use the words \"setting up\", \"set up your account\", \"set you up\". Use \"logging\", \"recording\", \"adding\", \"updating\".",
    "- If the user says \"set up my account\" → reply in talk mode: \"You're already all set! What do you need?\"",
    "",
    "VAGUE / CHAT / QUESTION → talk mode (always).",
    "",
    "AMOUNTS — READ CAREFULLY:",
    "- amountCents is INTEGER cents (1/100 of a dollar/ruble/etc.).",
    "- BARE numbers in money contexts are DOLLARS (or whatever the user's currency is), NOT cents.",
    "  \"spent 25 on coffee\"   → amountCents: 2500   (twenty-five DOLLARS, not 25 cents)",
    "  \"got 3000 paycheck\"    → amountCents: 300000 (three thousand DOLLARS)",
    "  \"$5\"                  → amountCents: 500",
    "  \"$1,234.56\"           → amountCents: 123456",
    "  \"5k\" / \"5K\"           → amountCents: 500000",
    "  \"5.5k\"                → amountCents: 550000",
    "  \"twenty bucks\"        → amountCents: 2000",
    "  \"50 cents\" / \"$0.50\"  → amountCents: 50",
    "- If the user says ONLY a small number like \"25\" or \"3\" with no cents context, ALWAYS interpret as dollars unless they explicitly say \"cents\".",
    "",
    "DATES:",
    "- ISO YYYY-MM-DD. \"the 15th\" → next 15th from TODAY.",
    "- New bill dueDate must be today or future.",
    "",
    "STATE:",
    JSON.stringify(snap, null, 2),
    "",
    // ── USER DNA ──
    // Goldratt-style compact picture of the user's money shape: spend
    // categories, patterns, recent rates. Lets the AI answer "how much do
    // I spend on coffee?" and "what's draining my budget?" without
    // walking the raw transaction list.
    dna.renderForPrompt(dna.compute(state)),
    "",
    "TODAY: " + m.today(state.timezone || "UTC"),
    "LANGUAGE: " + lang + " (reply in this language).",
  ].filter(Boolean).join("\n");
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
