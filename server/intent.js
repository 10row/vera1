// server/intent.js
// Fast intent extraction using Haiku + tool use.
// Tool schemas enforce parentId/subId as enums — no hallucinated categories.
// Falls back to "conversation" (no tool called) for complex inputs → callVera handles it.

"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic();

// ── INTENT TOOLS ──────────────────────────────────────────────────────────────
// Subset of all actions — only the ones Haiku can reliably detect from short messages.
// Complex setup / multi-step → "conversation" fallback.
const INTENT_TOOLS = [
  {
    name: "transaction",
    description: "User spent money — a purchase, bill payment, or expense",
    input_schema: {
      type: "object",
      required: ["description", "amountUSD", "parentId", "subId", "date"],
      properties: {
        description: { type: "string", description: "Short label, e.g. 'Lunch', 'Grab ride'" },
        amountUSD:   { type: "number" },
        localAmount: { type: "number" },
        localCurrency: { type: "string", description: "e.g. THB, EUR, JPY, GEL" },
        parentId: {
          type: "string",
          enum: ["food_drink","transport","home","health_body","clothing","work_business","entertainment","education","travel","financial"]
        },
        subId: {
          type: "string",
          enum: ["cafes","groceries","restaurants","bars","meal_plan","rideshare","public","flights","fuel","rent","utilities","laundry","supplies","gym","supplements","medical","grooming","activewear","everyday","software","equipment","coworking","streaming","events","hobbies","courses","books","accommodation","visas","investment","fees"]
        },
        date: { type: "string", description: "YYYY-MM-DD" }
      }
    }
  },
  {
    name: "income",
    description: "User received money — salary, payment, freelance income",
    input_schema: {
      type: "object",
      required: ["amountUSD", "date"],
      properties: {
        amountUSD: { type: "number" },
        description: { type: "string" },
        date: { type: "string" },
        nextPayday: { type: "string", description: "YYYY-MM-DD" },
        expectedIncomeUSD: { type: "number" }
      }
    }
  },
  {
    name: "set_committed",
    description: "Register a recurring bill or obligation — NOT a payment, just recording it exists",
    input_schema: {
      type: "object",
      required: ["name", "amountUSD", "frequency"],
      properties: {
        name: { type: "string" },
        amountUSD: { type: "number" },
        frequency: { type: "string", enum: ["monthly","weekly","annual","once"] },
        nextDate: { type: "string", description: "YYYY-MM-DD" },
        autoPay: { type: "boolean" }
      }
    }
  },
  {
    name: "confirm_payment",
    description: "Mark a committed bill as paid this cycle. Use when user says 'paid gym', 'rent done', etc. The fast path automatically adds the matching transaction.",
    input_schema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } }
    }
  },
  {
    name: "set_location",
    description: "Update spending location and/or exchange rate",
    input_schema: {
      type: "object",
      properties: {
        localRate: { type: "number", description: "Local currency units per 1 USD" },
        spendCurrency: { type: "string", description: "e.g. THB, EUR, JPY" },
        spendSymbol: { type: "string", description: "e.g. ฿, €, ¥" },
        location: { type: "string", description: "Country or city name" },
        locationFlag: { type: "string", description: "Flag emoji" }
      }
    }
  },
  {
    name: "correction",
    description: "Correct balance to match bank statement",
    input_schema: {
      type: "object",
      required: ["amountUSD"],
      properties: {
        amountUSD: { type: "number", description: "The actual current balance" },
        note: { type: "string" }
      }
    }
  },
  {
    name: "show_picture",
    description: "User wants to see their financial picture / balance summary",
    input_schema: { type: "object", properties: {} }
  }
];

const INTENT_SYSTEM = (rate, symbol, currency, location) => `Extract financial intent from a short user message. Call the matching tool.
If the message is complex, multi-step, a question, or ambiguous — call NO tool (leave the full conversation to Vera).

Current rate: 1 USD = ${rate} ${currency} | Symbol: ${symbol} | Location: ${location || "unknown"}
Today: ${new Date().toISOString().split("T")[0]}

Quick reference:
- "${symbol}200 lunch" → transaction(food_drink, restaurants, localAmount:200, localCurrency:"${currency}", amountUSD:200/${rate})
- "coffee ${symbol}80" → transaction(food_drink, cafes)
- "$45 Grab" → transaction(transport, rideshare, amountUSD:45, no localAmount if already USD)
- "paid gym" → confirm_payment — the system adds the transaction automatically
- "gym is 2000 monthly" → set_committed — NOT a payment, just recording the obligation
- "rate is 32" or "I'm in Japan" → set_location
- "my balance is $420" → correction
- "how much have I got" / "show my picture" → show_picture
- Anything complex, a question, or multi-part → call NO tool`;

async function extractIntent(message, state) {
  const rate    = state.location?.localRate || 1;
  const symbol  = state.location?.symbol || "$";
  const currency = state.location?.spendCurrency || "USD";
  const location = state.location?.name || "";

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: INTENT_SYSTEM(rate, symbol, currency, location),
      messages: [{ role: "user", content: message }],
      tools: INTENT_TOOLS,
      tool_choice: { type: "auto" },
    });

    const toolUse = response.content.find(b => b.type === "tool_use");
    if (!toolUse) return { type: "conversation" };
    return { type: toolUse.name, data: toolUse.input };
  } catch (err) {
    console.error("Intent extraction error:", err.message);
    return { type: "conversation" };
  }
}

// ── INTENT → ACTIONS ──────────────────────────────────────────────────────────
// Some intents expand to multiple actions (e.g. confirm_payment = transaction + mark paid).
function intentToActions(intent, state) {
  if (!intent || intent.type === "conversation") return null;
  if (intent.type === "show_picture") return null;

  // "paid gym" → transaction + confirm_payment
  if (intent.type === "confirm_payment") {
    const name = intent.data?.name;
    const committed = state.committed?.[name?.toLowerCase()];
    if (committed) {
      const rate     = state.location?.localRate || 1;
      const currency = state.location?.spendCurrency || "USD";
      return [
        {
          type: "transaction",
          data: {
            description: name,
            amountUSD: committed.amountUSD,
            localAmount: rate !== 1 ? Math.round(committed.amountUSD * rate) : null,
            localCurrency: rate !== 1 ? currency : null,
            parentId: "financial",
            subId: "fees",
            date: new Date().toISOString().split("T")[0],
          },
        },
        { type: "confirm_payment", data: { name } },
      ];
    }
  }

  return [{ type: intent.type, data: intent.data }];
}

module.exports = { extractIntent, intentToActions };
