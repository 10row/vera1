"use strict";
// admin-api.js — API cost logging utility
const prisma = require("./db/client");

// Rates: costCents = tokens * rate / 100; dollars = costCents / 10000
// GPT-4o-mini: $0.15/M input, $0.60/M output
const COST_MAP = {
  "gpt-4o-mini": { prompt: 0.15, output: 0.60 },
};

async function logApiCall(userId, model, promptTokens, outputTokens, endpoint) {
  const rates = COST_MAP[model] || { prompt: 0.15, output: 0.60 };
  const costCents = Math.round(promptTokens * rates.prompt / 100 + outputTokens * rates.output / 100);
  try {
    await prisma.apiLog.create({
      data: { userId, model, promptTokens, outputTokens, totalTokens: promptTokens + outputTokens, costCents, endpoint },
    });
  } catch (e) { console.error("ApiLog err:", e.message); }
}

module.exports = { logApiCall };
