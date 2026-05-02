"use strict";
// v5/ai-vision.js — receipt photo → record_spend intent.
//
// Uses gpt-4o (vision-capable) to extract amount, vendor, currency,
// category, and items from a receipt photo. Returns the same intent
// shape as the text-AI path so the bot's confirm-card flow handles
// it identically.
//
// Currency-from-context: when a receipt has no symbol (Vietnamese
// receipt with bare numbers), the model uses receipt language,
// vendor name, and amount magnitude to infer the currency. Confirm
// card always shows the result so user catches mistakes.

const m = require("./model");
const { recordAiRaw } = require("./ai-debug");

const VISION_MODEL = "gpt-4o-mini"; // gpt-4o-mini supports vision and is cheap
const MAX_TOKENS = 600;
const TIMEOUT_MS = 25000;

function buildSystemPrompt(state) {
  const lang = state.language === "ru" ? "ru" : "en";
  // Last 3 currencies user has spent in (helps disambiguate when
  // receipt has no symbol).
  const recentCcys = (state.transactions || [])
    .filter(t => t.originalCurrency)
    .slice(-5)
    .map(t => t.originalCurrency);
  const recentCcySet = Array.from(new Set(recentCcys));

  return [
    "You are a receipt OCR + extractor. Given a photo of a receipt, return a record_spend intent.",
    "",
    "OUTPUT — strict JSON, ONE of:",
    '  { "ok": true,  "intent": { "kind":"record_spend", "params":{ "amountCents":N, "originalAmount":N, "originalCurrency":"VND", "vendor":"...", "category":"...", "note":"...", "tags":[], "context":null } } }',
    '  { "ok": false, "reason": "short human reason — receipt unreadable / not a receipt / unclear amount" }',
    "",
    "AMOUNT RULES:",
    "- Extract the FINAL TOTAL (not subtotals, tip lines, item totals — the actual paid amount).",
    "- originalAmount = the natural number on the receipt (no scaling). \"50,000\" → 50000.",
    "- originalCurrency = ISO 3-letter code. If the receipt has no symbol, infer from:",
    "    1. Receipt language (Vietnamese → VND, Thai → THB, Russian → RUB, etc.)",
    "    2. Vendor name patterns (chains, regional brands)",
    "    3. Amount magnitude (50,000 looks like VND/IDR; 50.00 looks like USD/EUR)",
    "    4. The user's recent currencies (see CONTEXT below)",
    "- amountCents: leave 0 (pipeline converts originalAmount → base currency).",
    "- For currencies with no decimals (VND/JPY/KRW/IDR), do NOT add decimals.",
    "",
    "VENDOR: extract the merchant name from the header. Title case. \"LIGHTHOUSE COFFEE 24/7\" → \"Lighthouse Coffee\".",
    "",
    "CATEGORY: pick ONE from {coffee, groceries, restaurant, delivery, transport, subscription, clothing, health, alcohol, personal, home, entertainment, travel, other}.",
    "  Coffee shop receipt → coffee. Restaurant/cafe receipt with food items → restaurant.",
    "  Supermarket / minimart → groceries. Pharmacy → health. Gas/petrol → transport.",
    "",
    "NOTE: a SHORT human description summarizing items (\"coffee + croissant\", \"groceries\", \"gas\").",
    "  Don't transcribe every line item.",
    "",
    "TAGS: include \"travel\" if the receipt is clearly from a different country than the user's base.",
    "",
    "WHEN UNSURE: return {ok:false, reason:\"...\"} rather than guessing. The user can re-photo or type the spend.",
    "",
    "EXAMPLES:",
    "- Vietnamese receipt with \"100.000\" total, vendor \"PHO 24\":",
    '  → {"ok":true, "intent":{"kind":"record_spend","params":{"amountCents":0,"originalAmount":100000,"originalCurrency":"VND","vendor":"Pho 24","category":"restaurant","note":"pho dinner","tags":["travel"]}}}',
    "- US receipt with \"$24.50\" total, vendor \"STARBUCKS\":",
    '  → {"ok":true, "intent":{"kind":"record_spend","params":{"amountCents":0,"originalAmount":24.50,"originalCurrency":"USD","vendor":"Starbucks","category":"coffee","note":"coffee"}}}',
    "- Blurry / unreadable photo:",
    '  → {"ok":false, "reason":"can\'t read this clearly — could you re-photo or type the amount?"}',
    "- Photo of something that's not a receipt:",
    '  → {"ok":false, "reason":"this doesn\'t look like a receipt — type or voice the spend instead."}',
    "",
    "CONTEXT:",
    "- User base currency: " + (state.currency || "USD"),
    "- User language: " + lang,
    "- User's recent currencies (most-recent-first): " + (recentCcySet.length ? recentCcySet.join(", ") : "(none)"),
    "- Today: " + m.today(state.timezone || "UTC"),
  ].filter(Boolean).join("\n");
}

// Extract a record_spend intent from a receipt photo.
// imageBuffer: a Node Buffer of the image (jpg/png/webp).
// state: user state for context (recent currencies, base ccy, language).
// Returns: { ok: true, intent: {...} } | { ok: false, reason: "..." }
async function extractFromReceipt(imageBuffer, state, options) {
  options = options || {};
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, reason: "Photo extraction not configured." };

  const OpenAI = require("openai");
  const openai = new OpenAI({ apiKey });

  const system = buildSystemPrompt(state);
  // Detect mime type by magic bytes (cheap, no deps).
  const mime = detectImageMime(imageBuffer);
  const dataUrl = "data:" + mime + ";base64," + imageBuffer.toString("base64");

  let raw = "";
  try {
    const resp = await openai.chat.completions.create({
      model: VISION_MODEL,
      max_tokens: MAX_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract a record_spend intent from this receipt. Return JSON." },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          ],
        },
      ],
    }, { timeout: TIMEOUT_MS });
    raw = resp.choices && resp.choices[0] && resp.choices[0].message
      ? resp.choices[0].message.content || ""
      : "";
    // Record for /debug.
    if (state && state.id != null) {
      try { recordAiRaw(state.id, raw); } catch {}
    }
  } catch (e) {
    return { ok: false, reason: "Vision API failed: " + e.message };
  }

  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    return { ok: false, reason: "Couldn't parse the photo result. Try again or type it." };
  }

  if (parsed.ok === false) {
    return { ok: false, reason: String(parsed.reason || "Couldn't read the receipt.") };
  }
  if (!parsed.intent || typeof parsed.intent.kind !== "string") {
    return { ok: false, reason: "Photo didn't produce a valid spend." };
  }
  // Normalize wrapper just like text path.
  let intent = parsed.intent;
  if (!intent.params || typeof intent.params !== "object") {
    const params = {};
    for (const k of Object.keys(intent)) if (k !== "kind") params[k] = intent[k];
    intent = { kind: intent.kind, params };
  }
  return { ok: true, intent, raw };
}

function detectImageMime(buf) {
  if (!buf || buf.length < 12) return "image/jpeg";
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "image/jpeg";
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "image/png";
  // WEBP: 'RIFF' .... 'WEBP'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  // HEIC/HEIF: 'ftypheic' or 'ftypheix' or 'ftypmif1' etc — rare on Telegram (gets converted to jpg server-side).
  return "image/jpeg";
}

module.exports = { extractFromReceipt, buildSystemPrompt, detectImageMime };
