"use strict";
// openai-schema-v3.js — Structured output schema for V3 envelope actions

const responseSchema = {
  name: "spendyes_response",
  strict: true,
  schema: {
    type: "object",
    required: ["message", "actions", "queries", "verify"],
    additionalProperties: false,
    properties: {
      message: {
        type: "string",
        description: "The response message to the user. Warm, concise. Must include hero number after state changes."
      },
      verify: {
        type: "boolean",
        description: "Set true if an amount seems anomalous for the description (e.g. $400 for coffee). When true, message should ask for confirmation instead of logging."
      },
      actions: {
        type: "array",
        items: {
          type: "object",
          required: ["type", "data"],
          additionalProperties: false,
          properties: {
            type: {
              type: "string",
              enum: [
                "setup", "create_envelope", "update_envelope", "remove_envelope",
                "spend", "pay_envelope", "skip_envelope",
                "income", "fund_envelope", "correction",
                "undo", "reset", "none"
              ]
            },
            data: {
              type: "object",
              properties: {
                // setup
                balanceUSD: { type: ["number", "null"] },
                payday: { type: ["string", "null"] },
                currency: { type: ["string", "null"] },
                symbol: { type: ["string", "null"] },
                cycleStart: { type: ["string", "null"] },
                // envelope
                name: { type: ["string", "null"] },
                newName: { type: ["string", "null"] },
                amountUSD: { type: ["number", "null"] },
                rhythm: {
                  type: ["string", "null"],
                  enum: ["daily", "weekly", "monthly", "on_income", "once", "ongoing", null]
                },
                intervalDays: { type: ["integer", "null"] },
                nextDate: { type: ["string", "null"] },
                keywords: {
                  type: ["array", "null"],
                  items: { type: "string" }
                },
                targetUSD: { type: ["number", "null"] },
                fundRate: { type: ["number", "null"] },
                fundAmountUSD: { type: ["number", "null"] },
                fundedUSD: { type: ["number", "null"] },
                addFundedUSD: { type: ["number", "null"] },
                priority: {
                  type: ["string", "null"],
                  enum: ["essential", "flexible", null]
                },
                active: { type: ["boolean", "null"] },
                // spend
                description: { type: ["string", "null"] },
                envelope: { type: ["string", "null"] },
                // income
                nextPayday: { type: ["string", "null"] },
              },
              required: [],
              additionalProperties: false,
            }
          }
        }
      },
      queries: {
        type: "array",
        items: {
          type: "object",
          required: ["type"],
          additionalProperties: false,
          properties: {
            type: {
              type: "string",
              enum: ["envelope_spend", "month_total", "top_envelopes", "search_spend", "projection", "trend"]
            },
            envelope: { type: ["string", "null"] },
            month: { type: ["string", "null"] },
            keyword: { type: ["string", "null"] },
            days: { type: ["integer", "null"] },
          }
        }
      }
    }
  }
};

module.exports = { responseSchema };
