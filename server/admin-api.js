"use strict";
// admin-api.js — API cost logging utility
const prisma = require("./db/client");

// Cost per token in hundredths of a cent (divide by 100 for cents, by 10000 for dollars)
const COST_MAP = {
  "gpt-4o-mini": { prompt: 15, output: 60 },
  "claude-sonnet-4-20250514": { prompt: 300, output: 1500 },
  "claude-haiku-4-5-20251001": { prompt: 80, output: 400 },
};

async function logApiCall(userId, model, promptTokens, outputTokens, endpoint) {
  const rates = COST_MAP[model] || { prompt: 10, output: 40 };
  const costCents = Math.round(promptTokens * rates.prompt / 100 + outputTokens * rates.output / 100);
  try {
    await prisma.apiLog.create({
      data: { userId, model, promptTokens, outputTokens, totalTokens: promptTokens + outputTokens, costCents, endpoint },
    });
  } catch (e) { console.error("ApiLog err:", e.message); }
}

module.exports = { logApiCall };
