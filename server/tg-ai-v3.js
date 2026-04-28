"use strict";
// tg-ai-v3.js — V3 AI call functions (callSpendYes, callReview)

const OpenAI = require("openai");
const v3 = require("./vera-v3");
const { buildSystemPrompt } = require("./system-prompt");


const openai = new OpenAI();

// ── RETRY WRAPPER WITH SDK TIMEOUT ────────────
// Voice-first UX: fail fast. Max 2 attempts with short backoff.
const MAX_ATTEMPTS = 2;
const RETRY_DELAY = 1000; // 1s between attempts
const TIMEOUT_MS = 15000; // 15s per attempt — uses SDK timeout, not AbortController

async function withRetry(fn, label = "AI call") {
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = attempt === MAX_ATTEMPTS - 1;
      if (isLast) break;
      const isRetryable =
        err.status === 429 || err.status === 500 || err.status === 502 ||
        err.status === 503 || err.status === 504 ||
        err.code === "ECONNRESET" || err.code === "ETIMEDOUT" ||
        err.code === "ECONNABORTED";
      if (!isRetryable) break;
      console.warn(`${label} attempt ${attempt + 1} failed (${err.message}), retrying in ${RETRY_DELAY}ms...`);
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
  }
  throw lastErr;
}

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
  const systemContent = buildSystemPrompt(state);
  const msgs = [
    { role: "system", content: systemContent },
    ...history,
  ];
  const response = await withRetry(() => openai.chat.completions.create(
    {
      model: "gpt-4o-mini",
      max_tokens: 1024,
      response_format: { type: "json_object" },
      messages: msgs,
    },
    { timeout: TIMEOUT_MS }
  ), "callSpendYes");
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

  const isRu = lang === "ru";

  // Envelope summary
  const envList = (pic.envelopes || []).map(e => {
    let info = `${e.name}: ${e.amountFormatted || M(e.amountCents)}`;
    if (e.rhythm === "ongoing" && e.targetCents) {
      info += ` (${M(e.fundedCents)} / ${M(e.targetCents)})`;
    } else if (e.spentCents > 0) {
      info += isRu ? ` (потрачено ${M(e.spentCents)})` : ` (spent ${M(e.spentCents)})`;
    }
    if (e.isDue) info += isRu ? " ⚠ К ОПЛАТЕ" : " ⚠ DUE";
    return info;
  }).join(", ");

  const systemPrompt = isRu
    ? `Ты SpendYes — умный друг, который хорошо разбирается в деньгах. Пользователь спрашивает как у него дела с финансами.

ЗАДАЧА: Дай тёплый, честный обзор за 3-6 предложений. Хвали когда всё хорошо, мягко предупреждай когда туго. Говори как друг — на ты, неформально, не как робот.

ГОТОВЫЕ ЦИФРЫ (используй их, НИКОГДА не считай сам):
- Баланс: ${M(pic.balanceCents)}
- Свободно: ${pic.freeFormatted || M(pic.freeCents)}
- Сегодня свободно: ${pic.freeRemainingTodayFormatted || M(pic.freeRemainingTodayCents || 0)}
- Темп: ${pic.dailyPaceFormatted || M(pic.dailyPaceCents || 0)}/день
- Неделя: ${pic.weeklyPaceFormatted || M(pic.weeklyPaceCents || 0)}/нед
- Потрачено сегодня: ${pic.todaySpentFormatted || M(pic.todaySpentCents || 0)}
- За неделю: ${pic.thisWeekSpentFormatted || M(pic.thisWeekSpentCents || 0)}
- За месяц: ${pic.thisMonthSpentFormatted || M(pic.thisMonthSpentCents || 0)}
- Дней до зарплаты: ${pic.daysLeft ?? "?"}
- Зарезервировано: ${M(pic.totalReservedCents || 0)}
- Накоплено: ${pic.totalSavedCents ? M(pic.totalSavedCents) : "нет"}
- Валюта: ${state.currency || "USD"}
- Цикл: ${pic.cycleStats ? `потрачено ${M(pic.cycleStats.totalSpent)}, в среднем ${M(pic.cycleStats.dailyAvg)}/день` : "данных пока нет"}
- Конверты: ${envList || "нет"}

Последние траты:
${recentTxs || "  (пока нет)"}

ПРАВИЛА:
- Используй готовые цифры. НИКОГДА не считай сам.
- До 100 слов. Без кодовых блоков.
- Не перечисляй все цифры — выбери 2-3 самых важных.
- Если есть цели/накопления, упомяни прогресс.
- Заканчивай: *Сегодня: X₽*`
    : `You are SpendYes, a sharp and honest money friend. The user is asking how they're doing financially.

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

  const response = await withRetry(() => openai.chat.completions.create(
    {
      model: "gpt-4o-mini",
      max_tokens: 300,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
    },
    { timeout: TIMEOUT_MS }
  ), "callReview");
  const usage = response.usage || {};
  logApiCall(userId || null, "gpt-4o-mini", usage.prompt_tokens || 0, usage.completion_tokens || 0, "review").catch(() => {});
  return response.choices?.[0]?.message?.content ?? "...";
}

module.exports = { callSpendYes, callReview };
