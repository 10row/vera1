"use strict";
// tg-ai.js — AI call functions (callSpendYes, callReview)

const OpenAI = require("openai");
const v2 = require("./vera-v2");
const { responseSchema } = require("./openai-schema");

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
async function callSpendYes(state, userMessage) {
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
      { role: "system", content: v2.buildSystemPrompt(state) + langNote },
      ...history,
    ],
  });
  const text = response.choices?.[0]?.message?.content ?? "";
  const usage = response.usage || {};
  logApiCall(null, "gpt-4o-mini", usage.prompt_tokens || 0, usage.completion_tokens || 0, "chat").catch(() => {});
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { parsed = { message: text, actions: [{ type: "none", data: {} }] }; }
  return { text, parsed };
}

// ── CALL REVIEW (free-text, well-structured prompt) ─
async function callReview(state) {
  const pic = v2.computePicture(state);
  const lang = state.language || "en";

  // Recent transactions — clean readable list
  const recentTxs = (pic.transactions || []).slice(0, 8).map(tx =>
    `  ${tx.date} | ${v2.toUSD(tx.amountCents)} | ${tx.description || "unnamed"}`
  ).join("\n");

  // Bills summary
  const billsList = (pic.drains || []).map(d =>
    `${d.name}: ${d.amountUSD}` + (d.daysUntilNext != null ? ` (${d.daysUntilNext} days)` : "")
  ).join(", ");

  const langInstruction = lang === "ru"
    ? "IMPORTANT: Respond entirely in Russian.\n\n"
    : "";

  const systemPrompt = `${langInstruction}You are SpendYes, a sharp and honest money friend. The user is asking how they're doing financially.

YOUR JOB: Give a warm, honest 3-6 sentence check-in. Be encouraging when things are good, gently honest when they're tight. Talk like a smart friend who's great with money — not a robot listing numbers.

PRE-COMPUTED FACTS (use these, NEVER recalculate):
- Balance: ${pic.balanceUSD}
- Truly free to spend: ${pic.trulyFreeUSD}
- Daily pace: ${pic.dailyFreePaceUSD}/day
- Weekly pace: ${pic.weeklyFreePaceUSD}/week
- Spent today: ${pic.todaySpentUSD}
- Free remaining today: ${pic.freeRemainingTodayUSD}
- Spent this week: ${pic.thisWeekSpentUSD}
- Spent this month: ${pic.thisMonthSpentUSD}
- Average transaction: ${pic.avgTransactionUSD}
- Days left in cycle: ${pic.daysLeft} (Day ${pic.dayOfCycle} of ${pic.daysInCycle})
- Cycle total spent: ${pic.cycleStats ? pic.cycleStats.totalSpentUSD : "$0"}
- Cycle daily average: ${pic.cycleStats ? pic.cycleStats.dailyAvgUSD : "$0"}/day
- Bills: ${billsList || "none"}

Recent transactions:
${recentTxs || "  (none yet)"}

RULES:
- Quote the pre-computed numbers above. NEVER do arithmetic.
- Keep it under 100 words.
- Don't list every number — pick the 2-3 most relevant insights.
- End with something actionable or encouraging.`;

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
  logApiCall(null, "gpt-4o-mini", usage.prompt_tokens || 0, usage.completion_tokens || 0, "review").catch(() => {});
  return response.choices?.[0]?.message?.content ?? "...";
}

module.exports = { callSpendYes, callReview };
