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
        // Judge calls produce verbose JSON (critique[] + opportunities[]);
        // 600 was too tight and truncated responses mid-string. 1500 fits
        // every judge call we've seen with headroom.
        max_tokens: 1500,
        system: system + nudge,
        messages: conv,
      });
      // Claude returns content blocks; concat text blocks.
      let text = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
      // Strip code fences if present.
      text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
      // If Claude added explanatory prose before/after the JSON, extract
      // the first {…} block. Brace-matching that handles nested objects.
      const start = text.indexOf("{");
      if (start > 0) text = text.slice(start);
      if (text.startsWith("{")) {
        let depth = 0, inStr = false, esc = false, end = -1;
        for (let i = 0; i < text.length; i++) {
          const c = text[i];
          if (esc) { esc = false; continue; }
          if (inStr) { if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
          if (c === '"') inStr = true;
          else if (c === "{") depth++;
          else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end > 0) text = text.slice(0, end + 1);
      }
      return text;
    };
    cached.label = "anthropic/claude-haiku-4-5";
    return cached;
  }
  throw new Error("No AI key set. Need OPENAI_API_KEY or ANTHROPIC_API_KEY.");
}

module.exports = { getBackend };
