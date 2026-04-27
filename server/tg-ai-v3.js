"use strict";
// tg-ai-v3.js — V3 AI call functions (callSpendYes, callReview)

const OpenAI = require("openai");
const v3 = require("./vera-v3");
const { buildSystemPrompt } = require("./system-prompt");
const { responseSchema } = require("./openai-schema-v3");

const openai = new OpenAI();

// Safe import of API logger
let logApiCall = async () => {};
try {
  const admin = require("./admin");
  if (admin && typeof admin.logApiCall === "function") {
    logApiCall = admin.logApiCall;
  }
} catch (e) {
  console.warn("Admin module not available for API logging:", e.message);
}

// ── CALL SPENDYES (structured outputs) ─────────
async function callSpendYes(state, userMessage, userId) {
  const history = (state.conversationHistory || []).slice(-10);
  history.push({ role: "user", content: userMessage });
  const langNote = state.language === "ru"
    ? "\n\nIMPORTANT: The user speaks Russian. Respond in Russian. All message text must be in Russian."
    : "";
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 1024,
    response_format: { type: "json_schema", json_schema: responseSchema },
    messages: [
      { role: "system", content: buildSystemPrompt(state) + langNote },
      ...history,
    ],
  });
  const text = response.choices?.[0]?.message?.content ?? "";
  const usage = response.usage || {};
  logApiCall(userId || null, "gpt-4o-mini", usage.prompt_tokens || 0, usage.completion_tokens || 0, "chat").catch(() => {});
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { parsed = { message: text, actions: [{ type: "none", data: {} }], queries: [], verify: false }; }
  return { text, parsed };
}

// ── CALL REVIEW (free-text, V3 computePicture) ─
async function callReview(state, userId) {
  const pic = v3.computePicture(state);
  const lang = state.language || "en";
  const sym = state.currencySymbol || "$";
  const M = c => v3.toMoney(c, sym);

  // Recent transactions
  const recentTxs = (state.transactions || []).slice(-8).reverse().map(tx =>
    `  ${tx.date} | ${M(tx.amountCents)} | ${tx.description || "unnamed"} | ${tx.envelope || "free"}`
  ).join("\n");

  // Envelope summary
  const envList = (pic.envelopes || []).map(e => {
    let info = `${e.name}: ${e.amountFormatted || M(e.amountCents)}`;
    if (e.rhythm === "ongoing" && e.targetCents) {
      info += ` (${M(e.fundedCents)} / ${M(e.targetCents)})`;
    } else if (e.spentCents > 0) {
      info += ` (spent ${M(e.spentCents)})`;
    }
    if (e.isDue) info += " ⚠ DUE";
    return info;
  }).join(", ");

  const langInstruction = lang === "ru"
    ? "IMPORTANT: Respond entirely in Russian.\n\n"
    : "";

  const systemPrompt = `${langInstruction}You are SpendYes, a sharp and honest money friend. The user is asking how they're doing financially.

YOUR JOB: Give a warm, honest 3-6 sentence check-in. Be encouraging when things are good, gently honest when they're tight. Talk like a smart friend who's great with money — not a robot listing numbers.

PRE-COMPUTED FACTS (use these, NEVER recalculate):
- Balance: ${M(pic.balanceCents)}
- Free to spend: ${pic.freeFormatted || M(pic.freeCents)}
- Free today: ${pic.freeRemainingTodayFormatted || M(pic.freeRemainingTodayCents || 0)}
- Daily pace: ${pic.dailyPaceFormatted || M(pic.dailyPaceCents || 0)}/day
- Weekly pace: ${pic.weeklyPaceFormatted || M(pic.weeklyPaceCents || 0)}/week
- Spent today: ${pic.todaySpentFormatted || M(pic.todaySpentCents || 0)}
- Spent this week: ${pic.thisWeekSpentFormatted || M(pic.thisWeekSpentCents || 0)}
- Spent this month: ${pic.thisMonthSpentFormatted || M(pic.thisMonthSpentCents || 0)}
- Days left in cycle: ${pic.daysLeft ?? "?"}
- Total reserved: ${M(pic.totalReservedCents || 0)}
- Total saved: ${pic.totalSavedCents ? M(pic.totalSavedCents) : "none"}
- Currency: ${state.currency || "USD"}
- Cycle stats: ${pic.cycleStats ? `spent ${M(pic.cycleStats.totalSpent)}, avg ${M(pic.cycleStats.dailyAvg)}/day` : "no data yet"}
- Envelopes: ${envList || "none"}

Recent transactions:
${recentTxs || "  (none yet)"}

RULES:
- Quote the pre-computed numbers above. NEVER do arithmetic.
- Keep it under 100 words. No monospace blocks.
- Don't list every number — pick the 2-3 most relevant insights.
- If savings/goals exist, mention progress.
- End with the hero line: *Free today: $X*`;

  const userMsg = lang === "ru" ? "Как у меня дела?" : "How am I doing?";

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 300,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMsg },
    ],
  });
  const usage = response.usage || {};
  logApiCall(userId || null, "gpt-4o-mini", usage.prompt_tokens || 0, usage.completion_tokens || 0, "review").catch(() => {});
  return response.choices?.[0]?.message?.content ?? "...";
}

module.exports = { callSpendYes, callReview };
