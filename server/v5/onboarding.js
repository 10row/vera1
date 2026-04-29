"use strict";
// v5/onboarding.js — deterministic first-run flow. NO AI involved.
//
// While state.setup === false, every user message routes here. Two questions:
//   1. What's your balance?
//   2. When's your next paycheck? (or "skip")
// When both collected → emit setup_account, hand off to AI for the rest.
//
// This kills the entire class of "bot loops asking the same question" bugs.

const m = require("./model");

const GREETING_RE = /^\s*(\/start|hi+|hello+|hey+|yo+|sup|hola|namaste|howdy|hii+|heya|good\s*(morning|afternoon|evening|day|night)|what['s ]*up|h r u|hru|привет|здравствуй(те)?|здарова|hellooo)\s*[!.?]*\s*$/i;

const SKIP_RE = /^\s*(skip|none|no|n\/a|na|later|not\s*sure|nope|idk|don'?t\s*know|whatever|doesn'?t\s*matter|irregular|varies|пропусти(ть)?|нет|неважно)\s*[!.?]*\s*$/i;

// Word-numbers for "five thousand" etc. Coverage is rough — most users just type digits.
const WORD_NUMBERS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100, thousand: 1000, million: 1000000,
};

// parseAmount — natural-language money → cents. Returns null if no number.
//   "5000" → 500000
//   "$5,000.50" → 500050
//   "5k" → 500000
//   "five thousand" → 500000
//   "about 5k please" → 500000
function parseAmount(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();

  // Strip currency words / symbols, leave digits + suffixes.
  // Try: optional currency mark, digits, optional decimal, optional k/m suffix.
  const num = s.replace(/,/g, "").match(/(?:\$|usd|gbp|eur|rub|₽|£|€)?\s*(\d+(?:\.\d+)?)\s*(k|m|thousand|million|grand)?/);
  if (num) {
    let n = parseFloat(num[1]);
    const sfx = num[2];
    if (sfx === "k" || sfx === "thousand" || sfx === "grand") n *= 1000;
    if (sfx === "m" || sfx === "million") n *= 1000000;
    if (Number.isFinite(n) && n >= 0 && n < 100000000) {
      return Math.round(n * 100);
    }
  }

  // Word-number fallback: "five thousand", "two hundred"
  const tokens = s.replace(/[^a-z\s]/g, " ").split(/\s+/).filter(t => WORD_NUMBERS[t] != null);
  if (tokens.length > 0) {
    let total = 0, current = 0;
    for (const tok of tokens) {
      const v = WORD_NUMBERS[tok];
      if (v === 100) {
        current = (current || 1) * 100;
      } else if (v === 1000 || v === 1000000) {
        current = (current || 1) * v;
        total += current;
        current = 0;
      } else {
        current += v;
      }
    }
    total += current;
    if (total > 0 && total < 100000000) return Math.round(total * 100);
  }

  return null;
}

// parsePayday — natural-language date → ISO YYYY-MM-DD or null.
//   "the 15th" / "15th" → next 15th from today
//   "April 30" / "may 1" → next occurrence
//   "tomorrow" / "today" / "in 2 weeks"
//   "2025-05-15" (ISO)
//   "next friday"
function parsePayday(text, todayStr) {
  if (!text || !todayStr) return null;
  const s = String(text).toLowerCase().trim();

  // ISO date
  const iso = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) {
    const d = m.normalizeDate(iso[1]);
    if (d) return d;
  }

  // tomorrow / today
  if (/\btomorrow\b/.test(s) || /\bзавтра\b/.test(s)) return m.addDays(todayStr, 1);
  if (/\btoday\b/.test(s) || /\bсегодня\b/.test(s)) return todayStr;

  // "in N days/weeks/months"
  const inN = s.match(/\bin\s+(\d+)\s*(day|week|month)s?\b/);
  if (inN) {
    const n = parseInt(inN[1], 10);
    const days = inN[2] === "day" ? n : inN[2] === "week" ? n * 7 : n * 30;
    return m.addDays(todayStr, days);
  }

  // Month name + day: "April 30" / "Jan 5" / "May 1st"
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const monthRe = new RegExp("\\b(" + months.join("|") + "|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\.?\\s+(\\d{1,2})", "i");
  const mn = s.match(monthRe);
  if (mn) {
    const short = mn[1].toLowerCase().replace(".", "").slice(0, 3);
    const monIdx = months.findIndex(M => M.startsWith(short));
    if (monIdx !== -1) {
      const day = parseInt(mn[2], 10);
      if (day >= 1 && day <= 31) {
        const t = new Date(todayStr + "T00:00:00Z");
        let year = t.getUTCFullYear();
        let candidate = new Date(Date.UTC(year, monIdx, day));
        if (candidate < t) candidate = new Date(Date.UTC(year + 1, monIdx, day));
        return candidate.toISOString().slice(0, 10);
      }
    }
  }

  // "next friday"
  const dows = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const dowMatch = s.match(/\b(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (dowMatch) {
    const targetDow = dows[dowMatch[1]];
    const t = new Date(todayStr + "T00:00:00Z");
    const curDow = t.getUTCDay();
    let add = (targetDow - curDow + 7) % 7;
    if (add === 0) add = 7;
    return m.addDays(todayStr, add);
  }

  // Day of month: "the 15th", "15th", "the 1st", "on the 5th"
  const dom = s.match(/\b(?:the\s+|on\s+the\s+)?(\d{1,2})(st|nd|rd|th)?\b/);
  if (dom) {
    const d = parseInt(dom[1], 10);
    if (d >= 1 && d <= 31) {
      return nextDayOfMonth(d, todayStr);
    }
  }

  return null;
}

function nextDayOfMonth(targetDay, todayStr) {
  const t = new Date(todayStr + "T00:00:00Z");
  const tod = t.getUTCDate();
  let y = t.getUTCFullYear(), mo = t.getUTCMonth();
  if (targetDay <= tod) {
    mo++;
    if (mo > 11) { mo = 0; y++; }
  }
  const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const dt = new Date(Date.UTC(y, mo, Math.min(targetDay, lastDay)));
  return dt.toISOString().slice(0, 10);
}

// handle(state, text, todayStr) → decision
// Decision shape:
//   { reply: "...", intent?: setup_account, draft?: { balanceCents }, clearDraft?: bool, done: bool }
function handle(state, text, todayStr) {
  todayStr = todayStr || m.today((state && state.timezone) || "UTC");
  const draft = (state && state.onboardingDraft) || {};
  const t = String(text || "").trim();
  const lang = (state && state.language === "ru") ? "ru" : "en";
  const isGreeting = GREETING_RE.test(t);

  // PHASE 1: collect balance.
  if (draft.balanceCents == null) {
    if (isGreeting || !t) {
      return { reply: copy.askBalance(lang), done: false };
    }
    const amount = parseAmount(t);
    if (amount === null || amount === 0) {
      return { reply: copy.tryAgainBalance(lang), done: false };
    }
    // Try to grab payday from the same message — supports "I have 5k paid on the 15th".
    const payday = parsePayday(t, todayStr);
    if (payday) {
      return {
        intent: {
          kind: "setup_account",
          params: { balanceCents: amount, payday, payFrequency: "monthly" },
        },
        clearDraft: true,
        reply: copy.allSet(lang, amount, payday),
        done: true,
      };
    }
    return {
      draft: { balanceCents: amount },
      reply: copy.gotBalanceAskPayday(lang, amount),
      done: false,
    };
  }

  // PHASE 2: collect payday (or skip).
  if (SKIP_RE.test(t)) {
    return {
      intent: {
        kind: "setup_account",
        params: {
          balanceCents: draft.balanceCents,
          payday: m.addDays(todayStr, 30),
          payFrequency: "irregular",
        },
      },
      clearDraft: true,
      reply: copy.allSetSkipped(lang, draft.balanceCents),
      done: true,
    };
  }

  const payday = parsePayday(t, todayStr);
  if (payday) {
    return {
      intent: {
        kind: "setup_account",
        params: {
          balanceCents: draft.balanceCents,
          payday,
          payFrequency: "monthly",
        },
      },
      clearDraft: true,
      reply: copy.allSet(lang, draft.balanceCents, payday),
      done: true,
    };
  }

  return { reply: copy.tryAgainPayday(lang), done: false };
}

// Localized copy. Two languages, kept short. No emoji parade.
const copy = {
  askBalance(L) {
    return L === "ru"
      ? "Привет 👋 Я SpendYes. Сколько примерно сейчас на основном счёте? Просто число."
      : "Hey 👋 I'm SpendYes — your money buddy.\n\nWhat's the rough balance in your main account right now? Just say a number.";
  },
  tryAgainBalance(L) {
    return L === "ru"
      ? "Просто число — например *5000* или *5к*. Сколько на счёте?"
      : "Just a number — like *5000* or *$5k*. What's roughly in your main account?";
  },
  gotBalanceAskPayday(L, amt) {
    const fmt = m.toMoney(amt);
    return L === "ru"
      ? "Записал — " + fmt + ".\n\nКогда следующая зарплата? Скажи дату (\"15-го\" или \"30 апреля\") или *пропустить*, если зарплата нерегулярная."
      : "Got it — " + fmt + " saved.\n\nWhen's your next paycheck? Say a date like *\"the 15th\"* or *\"April 30\"* — or *\"skip\"* if it's irregular.";
  },
  tryAgainPayday(L) {
    return L === "ru"
      ? "Не понял дату. Попробуй *15-го*, *1 мая* или *пропустить*."
      : "Couldn't pick a date. Try *\"the 15th\"*, *\"May 1\"*, or *\"skip\"*.";
  },
  allSet(L, amt, payday) {
    const fmt = m.toMoney(amt);
    return L === "ru"
      ? "Готово — " + fmt + ", зарплата " + payday + "."
      : "Done — " + fmt + " saved, payday " + payday + ".";
  },
  allSetSkipped(L, amt) {
    const fmt = m.toMoney(amt);
    return L === "ru"
      ? "Готово — " + fmt + ", зарплата нерегулярная."
      : "Done — " + fmt + " saved, irregular pay.";
  },
};

module.exports = { handle, parseAmount, parsePayday, GREETING_RE, SKIP_RE };
