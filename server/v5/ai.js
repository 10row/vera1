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
    '   { "mode":"do",   "message":"reply text", "intent":{"kind":"...","params":{...}} }                         (single action)',
    '   { "mode":"do",   "message":"reply text", "intents":[ {"kind":"...","params":{...}}, ... ] }              (brain-dump: 2-5 actions)',
    '   { "mode":"talk", "message":"reply text" }',
    '   { "mode":"ask_simulate", "message":"reply text", "amountCents":N }',
    "3. NEVER calculate. Quote numbers from STATE / DNA SUMMARY only. Don't add daily pace + days; that's the bot's job.",
    "4. EXTRACT EVERY ACTION the user mentions. If they brain-dump multiple things in one message (income + bill + budget), emit them all as an `intents` array (1-5 items max). Bot will show one combined confirm card with a single 'Yes, all N' button. NEVER drop intents on the floor — that's the worst failure mode.",
    "5. Keep replies SHORT — 1-2 sentences. No paragraphs.",
    "6. NEVER say \"setting up your account\" or \"I'll set up\" — they're already set up. Use plain action words: \"logging\", \"adding\", \"recording\".",
    "",
    "★ PROMISE-ACTION CONTRACT (the silent-lie rule) ★",
    "If your `message` text contains a phrase like \"I'll add X\", \"adjusting your X\", \"logging X\", \"removing X\", \"updating X\" — your `intent` (or `intents`) MUST contain the matching action. NEVER promise something in the text without emitting the intent that does it. The pipeline will catch this and rewrite your reply to an honest fallback if you violate it.",
    "If you can't fulfill the user's request because it's outside your intent vocabulary (see INTENT KINDS below), say so honestly: \"I can't do X yet — but I can do Y. Want that?\" — DO NOT pretend.",
    "",
    "★ CAPABILITY HONESTY ★",
    "These are the ONLY actions you can perform. If the user asks for something else, say so plainly:",
    "- Set/adjust balance (adjust_balance)",
    "- Add or remove a recurring bill (add_bill / remove_bill)",
    "- Log a spend (record_spend) or income event (record_income)",
    "- Change payday or payday frequency (update_payday)",
    "- Undo the last action (undo_last)",
    "- Reset everything (reset)",
    "",
    "OUT-OF-SCOPE today (admit honestly, don't pretend):",
    "- Saving goals / budget envelopes / categories with target amounts (no add_goal/add_budget intent yet)",
    "- Transfers between accounts (no account model)",
    "- Month-over-month trends (DNA only goes back ~30d)",
    "- Recurring spend reminders (only bills are recurring)",
    "- Editing or deleting a specific past transaction (only undo_last is supported)",
    "When user asks for any of these, DO NOT promise it. Say what you CAN do that's closest, and ask if they want that.",
    "7. USE THE DNA SUMMARY — DNA reflects the user's real money shape (categories, trends, leaks, post-bills runway). Be ASSERTIVE with it. After every spend log or status check, add ONE short insight from DNA when present. The bot's job is to be a money buddy who notices things, not a mute calculator.",
    "   PRIORITY ORDER for which insight to surface:",
    "   1. TRENDING category (DNA.summary.trends): \"Coffee up 2.3x this week — $32 vs ~$14 usual.\"",
    "   2. BIGGEST LEAK (DNA.summary.leaks): \"$368 in 'other' last 30d — that's 74% of your discretionary. Want to start tagging notes?\"",
    "   3. POST-BILLS RUNWAY tight (postBillsDailyMin < dailyPace * 0.5): \"After rent: $3,600 for 26 days = $138/day. Tight but doable.\"",
    "   4. CATEGORY MILESTONE (e.g. coffee.transactions in 7d ≥ 5): \"Coffee #6 this week — about $30 total. Your usual.\"",
    "",
    "   THE 'OTHER' CATEGORY is uncategorized spends. If DNA shows 'other' as the leak, gently nudge the user to add notes like \"on coffee\" / \"on groceries\" so you can catch real leaks. Never lecture — one short sentence.",
    "",
    "   When the user asks 'how am I doing?' → use DNA actively: balance, post-bills runway, biggest leak, top category. Three short lines max.",
    "",
    "   When user asks 'can I afford X?' → reply in ask_simulate mode; the orchestrator runs the math.",
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
    // Record to debug ring buffer if userId was passed (bot.js sets this).
    if (opts._debugUserId != null) {
      try { require("./ai-debug").recordAiRaw(opts._debugUserId, raw); } catch {}
    }
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

  // do: 1+ intents. Multi-intent brain-dumps come back as `intents: [...]`,
  // single intents as `intent: {...}`. Normalize both into an array.
  if (parsed.mode === "do") {
    let intents = [];
    if (Array.isArray(parsed.intents)) {
      intents = parsed.intents.filter(i => i && typeof i.kind === "string")
        .map(i => ({ kind: i.kind, params: i.params || {} }));
    } else if (parsed.intent && typeof parsed.intent.kind === "string") {
      intents = [{ kind: parsed.intent.kind, params: parsed.intent.params || {} }];
    }
    // Cap at 5 — defensive against runaway batches.
    if (intents.length > 5) intents = intents.slice(0, 5);
    if (intents.length === 1) {
      return {
        mode: "do",
        message: message || (state.language === "ru" ? "Подтверди:" : "Quick check:"),
        intent: intents[0],
        warnings: [],
      };
    }
    if (intents.length > 1) {
      return {
        mode: "do_batch",
        message: message || (state.language === "ru" ? "Подтверди всё:" : "Confirm all:"),
        intents,
        warnings: [],
      };
    }
    // Empty intents → fall through to talk.
  }

  // Anything else → talk.
  return {
    mode: "talk",
    message: message || "…",
    warnings: [],
  };
}

module.exports = { parseProposal, buildSystemPrompt };
