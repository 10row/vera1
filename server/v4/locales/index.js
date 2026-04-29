"use strict";
// Locale registry. Add new languages here. Every key in en.js MUST exist
// in every other locale (parity test enforces this in tests/locales.test.js).

const en = require("./en");
const ru = require("./ru");

const LOCALES = { en, ru };

// Pick a locale by language code. Falls back to English if unknown
// or if a key is missing in the requested locale.
//
// Telegram's language_code can include region (e.g. "en-US", "pt-BR").
// We strip to base lang for lookup. For "zh-CN" / "zh-TW" we'd add
// regional variants in LOCALES later if needed.
function resolveLocale(lang) {
  if (!lang || typeof lang !== "string") return en;
  const base = lang.toLowerCase().split("-")[0];
  return LOCALES[base] || en;
}

// t(key, lang, params) — single user-facing string source. NEVER returns
// a hardcoded English fallback string from the calling code; it routes
// through here so missing keys fall back to English visibly (and a CI
// test catches the gap).
function t(key, lang, params) {
  const locale = resolveLocale(lang);
  let str = locale[key];
  if (str === undefined) {
    str = en[key];
    if (str === undefined) {
      // Last resort: return the key itself so the gap is visible.
      console.warn("[locale] missing key in en + " + (lang || "?") + ": " + key);
      return key;
    }
  }
  if (params) {
    Object.keys(params).forEach((k) => {
      str = str.split("{" + k + "}").join(params[k] == null ? "" : String(params[k]));
    });
  }
  return str;
}

// Map a language code to a default currency. Overridable via update_settings.
// Conservative: when in doubt, USD. The user can always say "switch to euros".
const DEFAULT_CURRENCY_BY_LANG = {
  en: { code: "USD", symbol: "$" },
  ru: { code: "RUB", symbol: "₽" },
  uk: { code: "UAH", symbol: "₴" }, // Ukrainian
  es: { code: "EUR", symbol: "€" }, // Spain default; LatAm users override
  pt: { code: "BRL", symbol: "R$" },
  fr: { code: "EUR", symbol: "€" },
  de: { code: "EUR", symbol: "€" },
  it: { code: "EUR", symbol: "€" },
  nl: { code: "EUR", symbol: "€" },
  pl: { code: "PLN", symbol: "zł" },
  tr: { code: "TRY", symbol: "₺" },
  ja: { code: "JPY", symbol: "¥" },
  zh: { code: "CNY", symbol: "¥" },
  ko: { code: "KRW", symbol: "₩" },
  ar: { code: "USD", symbol: "$" }, // many Arabic-speaking countries; default to USD
  hi: { code: "INR", symbol: "₹" },
  vi: { code: "VND", symbol: "₫" },
  th: { code: "THB", symbol: "฿" },
};

function defaultCurrencyForLang(lang) {
  if (!lang || typeof lang !== "string") return DEFAULT_CURRENCY_BY_LANG.en;
  const base = lang.toLowerCase().split("-")[0];
  return DEFAULT_CURRENCY_BY_LANG[base] || DEFAULT_CURRENCY_BY_LANG.en;
}

// Normalize Telegram language_code → base language we have a locale for.
// Returns one of LOCALES keys, or "en" as fallback.
function normalizeLang(lang) {
  if (!lang || typeof lang !== "string") return "en";
  const base = lang.toLowerCase().split("-")[0];
  return LOCALES[base] ? base : "en";
}

module.exports = { t, resolveLocale, normalizeLang, defaultCurrencyForLang, LOCALES };
