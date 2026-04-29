"use strict";
// Harness AI backend. Production uses OpenAI; the harness uses whatever
// key is locally available — Anthropic Claude here, since OPENAI_API_KEY
// is set on Railway env but not in local .env.
//
// Both backends emit the same JSON contract (do | talk | ask_simulate),
// so v5/ai.js's parser doesn't care which one answered.

let cached = null;

function getBackend() {
  if (cached) return cached;
  if (process.env.OPENAI_API_KEY) {
    const OpenAI = require("openai");
    const openai = new OpenAI();
    cached = async function aiCall(messages) {
      const r = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 500,
        response_format: { type: "json_object" },
        messages,
      }, { timeout: 20000 });
      return r.choices[0].message.content || "";
    };
    cached.label = "openai/gpt-4o-mini";
    return cached;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require("@anthropic-ai/sdk").default;
    const ant = new Anthropic();
    cached = async function aiCall(messages) {
      // Convert OpenAI message shape ({role, content}) to Anthropic's.
      // Anthropic separates the system prompt from the messages array.
      let system = "";
      const conv = [];
      for (const m of messages) {
        if (m.role === "system") system += (system ? "\n" : "") + m.content;
        else conv.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
      }
      // Append a JSON nudge so Claude emits a clean JSON object.
      const nudge = "\n\nRespond with a single JSON object only — no prose, no code fences.";
      const r = await ant.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 600,
        system: system + nudge,
        messages: conv,
      });
      // Claude returns content blocks; concat text blocks.
      const text = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
      // If Claude wrapped in code fences, strip them.
      return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
    };
    cached.label = "anthropic/claude-haiku-4-5";
    return cached;
  }
  throw new Error("No AI key set. Need OPENAI_API_KEY or ANTHROPIC_API_KEY.");
}

module.exports = { getBackend };
