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

// ── BILL NAME → CATEGORY ─────────────────────────────────────────────────────
// Maps a committed bill name to the most likely taxonomy category.
// e.g. "Gym" → health_body/gym, "Netflix" → entertainment/streaming
const BILL_CATEGORY_MAP = {
  // health_body
  gym: { parentId: "health_body", subId: "gym" },
  fitness: { parentId: "health_body", subId: "gym" },
  crossfit: { parentId: "health_body", subId: "gym" },
  yoga: { parentId: "health_body", subId: "gym" },
  pilates: { parentId: "health_body", subId: "gym" },
  muay: { parentId: "health_body", subId: "gym" },
  boxing: { parentId: "health_body", subId: "gym" },
  supplements: { parentId: "health_body", subId: "supplements" },
  protein: { parentId: "health_body", subId: "supplements" },
  medical: { parentId: "health_body", subId: "medical" },
  dentist: { parentId: "health_body", subId: "medical" },
  insurance: { parentId: "health_body", subId: "medical" },
  // home
  rent: { parentId: "home", subId: "rent" },
  electric: { parentId: "home", subId: "utilities" },
  electricity: { parentId: "home", subId: "utilities" },
  water: { parentId: "home", subId: "utilities" },
  internet: { parentId: "home", subId: "utilities" },
  wifi: { parentId: "home", subId: "utilities" },
  phone: { parentId: "home", subId: "utilities" },
  mobile: { parentId: "home", subId: "utilities" },
  // entertainment
  netflix: { parentId: "entertainment", subId: "streaming" },
  spotify: { parentId: "entertainment", subId: "streaming" },
  youtube: { parentId: "entertainment", subId: "streaming" },
  disney: { parentId: "entertainment", subId: "streaming" },
  hbo: { parentId: "entertainment", subId: "streaming" },
  apple: { parentId: "entertainment", subId: "streaming" },
  // work_business
  cursor: { parentId: "work_business", subId: "software" },
  github: { parentId: "work_business", subId: "software" },
  notion: { parentId: "work_business", subId: "software" },
  figma: { parentId: "work_business", subId: "software" },
  slack: { parentId: "work_business", subId: "software" },
  claude: { parentId: "work_business", subId: "software" },
  anthropic: { parentId: "work_business", subId: "software" },
  openai: { parentId: "work_business", subId: "software" },
  chatgpt: { parentId: "work_business", subId: "software" },
  coworking: { parentId: "work_business", subId: "coworking" },
  // education
  udemy: { parentId: "education", subId: "courses" },
  coursera: { parentId: "education", subId: "courses" },
  // transport
  grab: { parentId: "transport", subId: "rideshare" },
};

function guessBillCategory(billName) {
  const lower = (billName || "").toLowerCase();
  // Direct match first
  if (BILL_CATEGORY_MAP[lower]) return BILL_CATEGORY_MAP[lower];
  // Partial match — check if any key is contained in the bill name
  for (const [keyword, cat] of Object.entries(BILL_CATEGORY_MAP)) {
    if (lower.includes(keyword)) return cat;
  }
  return { parentId: "financial", subId: "fees" };
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
      const rate     = state.location?.localRate ?? 1;
      const currency = state.location?.spendCurrency ?? "USD";
      const cat      = guessBillCategory(committed.name || name);
      return [
        {
          type: "transaction",
          data: {
            description: name,
            amountUSD: committed.amountUSD,
            localAmount: rate !== 1 ? Math.round(committed.amountUSD * rate) : null,
            localCurrency: rate !== 1 ? currency : null,
            parentId: cat.parentId,
            subId: cat.subId,
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
