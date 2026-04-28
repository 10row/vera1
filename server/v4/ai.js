"use strict";
// v4/ai.js — AI parser. Returns a typed Proposal. NEVER mutates state.
//
// Two modes the LLM can return:
//   talk → conversation only. intents MUST be empty. Bot replies with message.
//   do   → propose intents. Bot routes through validator + confirmation.
//
// All persistent decisions are made downstream (validator + bot confirm flow).
// Even if the LLM hallucinates, this layer sanitizes the contract:
//   - mode==talk + intents present → intents dropped
//   - mode==do + intents empty → fall back to talk
//   - non-JSON output → safe talk fallback
// The validator is the second line of defence.

// openai is loaded lazily inside defaultAiCall so tests don't pull it in.
const m = require("./model");
const { compute } = require("./view");

const MODEL = "gpt-4o-mini";
const MAX_TOKENS = 700;
const TIMEOUT_MS = 15000;

function buildSystemPrompt(state) {
  const view = state && state.setup ? compute(state) : { setup: false };
  const lang = (state && state.language) || "en";
  const isRu = lang === "ru";

  // Snapshot the user's facts. THE LLM MUST NOT COMPUTE; quote from here only.
  const snap = state && state.setup ? {
    setup: true,
    currency: state.currency,
    balance: view.balanceFormatted,
    disposable: view.disposableFormatted,
    daily_pace: view.dailyPaceFormatted,
    today_remaining: view.todayRemainingFormatted,
    days_to_payday: view.daysToPayday,
    payday: view.payday,
    state_color: view.state, // green | tight | over
    deficit: view.deficitCents > 0 ? view.deficitFormatted : null,
    today_spent: view.todaySpentFormatted,
    week_spent: view.weekSpentFormatted,
    saved_toward: view.savedTowardCents > 0 ? view.savedTowardFormatted : null,
    envelopes: view.envelopes.map(e => ({
      key: e.key, name: e.name, kind: e.kind,
      amount: e.amountFormatted, spent: e.spentFormatted,
      due_date: e.dueDate, days_until_due: e.daysUntilDue,
      is_due: e.isDue,
    })),
    due_now: view.dueNow.map(d => ({ name: d.name, amount: d.amountFormatted, due: d.dueDate })),
    upcoming: view.upcoming.map(u => ({ name: u.name, amount: u.amountFormatted, due: u.dueDate, in_days: u.daysUntilDue })),
  } : { setup: false };

  const today = m.today((state && state.timezone) || "UTC");

  const lines = [
    "You are SpendYes — a smart, warm money friend on Telegram.",
    "Two modes: TALK (conversation, advice, planning) and DO (record an action).",
    "",
    "RULES (strict — violations are caught downstream and rejected):",
    "1. Default to TALK. Use DO only when the user clearly asks to RECORD or CHANGE something.",
    "2. NEVER calculate or estimate. Quote ONLY numbers from the STATE snapshot.",
    "3. Be a friend, not a robot. 1–3 short sentences usually.",
    "4. If the user is vague (no clear amount/date or unclear meaning), use TALK to ask one question.",
    "5. NEVER classify a balance statement as a spend. \"I have $5000\" → setup_account or adjust_balance, not record_spend.",
    "6. Maximum ONE intent per turn. Two only if the user explicitly named both actions in one message.",
    "7. The bot will ALWAYS show a confirm card before applying a DO intent. So you propose, never commit.",
    "8. *** IF state.setup IS TRUE: NEVER emit setup_account. Use adjust_balance to fix balance, update_settings for schedule/timezone, reset to wipe. ***",
    "9. *** setup_account MUST BE EMITTED ALONE in its turn — never bundle it with other intents. ***",
    "10. RECURRING BILLS MUST CARRY recurrence. Rent/insurance/phone/internet/utilities/subscriptions/gym/loan/mortgage/membership → recurrence:\"monthly\". One-off purchases (\"new laptop\", \"vietnam trip\") → recurrence:\"once\".",
    "11. NEW bill dueDate must be today or future. Past dates are forbidden (the engine rejects them). For \"rent on the 1st\" pick the next 1st from today.",
    "",
    isRu ? "LANGUAGE: respond in Russian. Use ты, casual." : "LANGUAGE: respond in English.",
    "",
    "STATE:",
    JSON.stringify(snap, null, 2),
    "",
    "TODAY: " + today,
    "",
    "OUTPUT FORMAT (strict JSON only — no prose outside this object):",
    '{"mode":"talk"|"do","message":"reply to the user","intents":[ ...optional, only in DO mode... ]}',
    "",
    "INTENT KINDS (use these exact param shapes):",
    'setup_account: { kind:"setup_account", params:{ balanceCents:N, payday:"YYYY-MM-DD", payFrequency:"monthly"|"weekly"|"biweekly"|"irregular", currency?:"USD", currencySymbol?:"$", timezone?:"Europe/London" } }',
    'add_envelope: { kind:"add_envelope", params:{ name:"Vietnam Trip", kind:"bill"|"budget"|"goal", amountCents:N, dueDate?:"YYYY-MM-DD", recurrence?:"once"|"weekly"|"biweekly"|"monthly", targetCents?:N, keywords?:[] } }',
    'record_spend: { kind:"record_spend", params:{ amountCents:N, note?:"coffee", envelopeKey?:"groceries" } }',
    'record_income: { kind:"record_income", params:{ amountCents:N, note?:"paycheck", nextPayday?:"YYYY-MM-DD" } }',
    'pay_bill: { kind:"pay_bill", params:{ name:"Rent" } }',
    'skip_bill: { kind:"skip_bill", params:{ name:"Phone" } }',
    'adjust_balance: { kind:"adjust_balance", params:{ newBalanceCents:N, note?:"reconciled with bank" } }',
    'remove_envelope: { kind:"remove_envelope", params:{ name:"Coffee" } }',
    'update_envelope: { kind:"update_envelope", params:{ key:"coffee", amountCents?:N, dueDate?:"YYYY-MM-DD" } }',
    'update_settings: { kind:"update_settings", params:{ timezone?:"...", payday?:"YYYY-MM-DD", payFrequency?:"...", language?:"..." } }',
    'reset: { kind:"reset", params:{} }',
    "",
    "AMOUNT RULES:",
    "- amountCents is integer cents. \"$5\" → 500. \"$1,234.56\" → 123456.",
    "- Never send floats, NaN, Infinity, strings.",
    "- For currencies other than USD, convert with rough estimate to user's currency cents.",
    "",
    "DATE RULES:",
    "- ISO YYYY-MM-DD only.",
    "- Bills must have dueDate in [today−14d, today+730d].",
    "- If user says \"the 1st\" → next 1st of the month from today.",
    "- If user is vague (\"sometime in summer\") → ask in TALK mode, don't guess.",
    "",
    "FIRST-TIME SETUP:",
    "- If state.setup is false: warmly invite them to share their balance, payday, and any bills/budgets.",
    "- One concrete intent at a time. setup_account FIRST. Then add_envelope on the next turn(s) when user mentions a bill.",
    "- If they only give a balance → setup_account, then ask about bills in TALK on next turn.",
  ];
  return lines.join("\n");
}

async function defaultAiCall(messages) {
  const OpenAI = require("openai"); // lazy load — production only
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

// parseProposal returns a sanitized Proposal regardless of LLM behaviour.
// Options: { _aiCall } injects a function for tests; default uses real OpenAI.
async function parseProposal(state, userMessage, history, options) {
  const opts = options || {};
  const aiCall = opts._aiCall || defaultAiCall;
  const system = buildSystemPrompt(state);
  const msgs = [
    { role: "system", content: system },
    ...((history || []).slice(-10)),
    { role: "user", content: String(userMessage || "") },
  ];

  let raw = "";
  try {
    raw = await aiCall(msgs);
  } catch (e) {
    return {
      mode: "talk",
      message: "Sorry, I had a brain blip — try again?",
      intents: [],
      transcript: userMessage,
      warnings: ["ai_call_failed: " + e.message],
    };
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    return {
      mode: "talk",
      message: typeof raw === "string" && raw.length > 0 && raw.length < 400 ? raw : "Hmm, didn't catch that — say it another way?",
      intents: [],
      transcript: userMessage,
      warnings: ["json_parse_failed"],
    };
  }

  // Sanitize: enforce contract regardless of what the model returned.
  let mode = parsed.mode === "do" ? "do" : "talk";
  let message = typeof parsed.message === "string" ? parsed.message : "";
  let intents = Array.isArray(parsed.intents) ? parsed.intents : [];

  // Talk mode never carries intents.
  if (mode === "talk" && intents.length > 0) {
    intents = [];
  }
  // Do mode without intents is just a chatty reply — call it talk.
  if (mode === "do" && intents.length === 0) {
    mode = "talk";
  }
  // Cap to 3 intents per turn (validator will hard-reject 4+ anyway).
  if (intents.length > 3) intents = intents.slice(0, 3);

  // Drop any intent that isn't an object with a kind string.
  intents = intents.filter(i => i && typeof i.kind === "string");

  return {
    mode,
    message: message || (mode === "do" ? "Got it — let me confirm." : ""),
    intents,
    transcript: userMessage,
    warnings: [],
  };
}

module.exports = { parseProposal, buildSystemPrompt };
