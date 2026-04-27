"use strict";
const responseSchema = {
  name: "spendyes_response",
  strict: true,
  schema: {
    type: "object",
    required: ["message", "actions", "queries", "verify"],
    additionalProperties: false,
    properties: {
      message: { type: "string", description: "Response message to the user." },
      verify: { type: "boolean", description: "Set true if amount seems anomalous." },
      actions: {
        type: "array",
        items: {
          type: "object", required: ["type", "data"], additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["setup","create_envelope","update_envelope","remove_envelope","spend","pay_envelope","skip_envelope","income","fund_envelope","correction","undo","reset","none"] },
            data: {
              type: "object", required: [], additionalProperties: false,
              properties: {
                balanceUSD: { type: ["number","null"] }, payday: { type: ["string","null"] },
                currency: { type: ["string","null"] }, symbol: { type: ["string","null"] },
                cycleStart: { type: ["string","null"] }, name: { type: ["string","null"] },
                amountUSD: { type: ["number","null"] },
                rhythm: { type: ["string","null"], enum: ["daily","weekly","monthly","on_income","once","ongoing",null] },
                intervalDays: { type: ["number","null"] }, nextDate: { type: ["string","null"] },
                keywords: { type: ["array","null"], items: { type: "string" } },
                targetUSD: { type: ["number","null"] }, fundRate: { type: ["number","null"] },
                fundAmountUSD: { type: ["number","null"] }, fundedUSD: { type: ["number","null"] },
                addFundedUSD: { type: ["number","null"] },
                priority: { type: ["string","null"], enum: ["essential","flexible",null] },
                active: { type: ["boolean","null"] },
                description: { type: ["string","null"] }, envelope: { type: ["string","null"] },
                nextPayday: { type: ["string","null"] },
              }
            }
          }
        }
      },
      queries: {
        type: "array",
        items: {
          type: "object", required: ["type"], additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["envelope_spend","month_total","top_envelopes","search_spend","projection","trend"] },
            envelope: { type: ["string","null"] }, month: { type: ["string","null"] },
            keyword: { type: ["string","null"] }, days: { type: ["number","null"] },
          }
        }
      }
    }
  }
};
module.exports = { responseSchema };
