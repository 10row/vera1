"use strict";
// OpenAI Structured Outputs schema for SpendYes
const responseSchema = {
  name: "spendyes_response",
  strict: true,
  schema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Your response message to the user" },
      actions: {
        type: "array",
        description: "Engine actions to perform",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "setup", "add_drain", "remove_drain", "update_drain",
                "confirm_payment", "skip_payment",
                "add_pool", "remove_pool",
                "add_planned", "remove_planned", "confirm_planned",
                "transaction", "income", "correction",
                "set_saving_rate", "set_savings", "withdraw_savings",
                "set_location", "reset", "none"
              ]
            },
            data: {
              type: "object",
              description: "Action data",
              properties: {
                balanceUSD: { type: ["number", "null"] },
                incomeUSD: { type: ["number", "null"] },
                savingRate: { type: ["number", "null"] },
                payday: { type: ["string", "null"] },
                cycleStart: { type: ["string", "null"] },
                savingsUSD: { type: ["number", "null"] },
                recurring: { type: ["boolean", "null"] },
                name: { type: ["string", "null"] },
                amountUSD: { type: ["number", "null"] },
                intervalDays: { type: ["number", "null"] },
                nextDate: { type: ["string", "null"] },
                description: { type: ["string", "null"] },
                poolKey: { type: ["string", "null"] },
                nextPayday: { type: ["string", "null"] },
                rate: { type: ["number", "null"] },
                reason: { type: ["string", "null"] },
                currency: { type: ["string", "null"] },
                symbol: { type: ["string", "null"] },
                localRate: { type: ["number", "null"] },
                date: { type: ["string", "null"] },
                type: { type: ["string", "null"] },
                dailyAmountUSD: { type: ["number", "null"] },
                allocatedUSD: { type: ["number", "null"] },
                keywords: { type: ["array", "null"], items: { type: "string" } }
              },
              required: [
                "balanceUSD", "incomeUSD", "savingRate", "payday",
                "cycleStart", "savingsUSD", "recurring",
                "name", "amountUSD", "intervalDays", "nextDate",
                "description", "poolKey", "nextPayday",
                "rate", "reason", "currency", "symbol", "localRate",
                "date", "type", "dailyAmountUSD", "allocatedUSD", "keywords"
              ],
              additionalProperties: false
            }
          },
          required: ["type", "data"],
          additionalProperties: false
        }
      },
      queries: {
        type: "array",
        description: "Engine queries for data lookup",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["pool_spend", "month_total", "top_pools", "search_spend",
                "daily_average", "projection", "trend", "savings_history", "none"]
            },
            pool: { type: ["string", "null"] },
            month: { type: ["string", "null"] },
            keyword: { type: ["string", "null"] },
            days: { type: ["number", "null"] }
          },
          required: ["type", "pool", "month", "keyword", "days"],
          additionalProperties: false
        }
      }
    },
    required: ["message", "actions", "queries"],
    additionalProperties: false
  }
};
module.exports = { responseSchema };
