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

// Word-numbers for "five thousand", "пять тысяч" etc. Most users type digits;
// these handle the long-tail phrasings (especially mid-onboarding voice notes).
const WORD_NUMBERS = {
  // English
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100, thousand: 1000, million: 1000000,
  // Russian — masculine + feminine variants where forms differ in money context
  ноль: 0, "один": 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6,
  семь: 7, восемь: 8, девять: 9, десять: 10,
  одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15,
  шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70,
  восемьдесят: 80, девяносто: 90, сто: 100,
  тысяч: 1000, тысячи: 1000, тысяча: 1000, тыс: 1000,
  миллион: 1000000, миллионов: 1000000, млн: 1000000,
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
  // Suffix alternates include English (k, m, grand) AND Russian
  // (к/тыс/тысяч/млн). The "к" Cyrillic-K is anchored after a digit so
  // it can't match arbitrary words.
  const num = s.replace(/,/g, "").match(/(?:\$|usd|gbp|eur|rub|₽|£|€)?\s*(\d+(?:\.\d+)?)\s*(k|m|thousand|million|grand|к|тыс(?:\.|яч|яча|ячи)?|млн)?\b/);
  if (num) {
    let n = parseFloat(num[1]);
    const sfx = num[2];
    if (sfx === "k" || sfx === "thousand" || sfx === "grand" || sfx === "к"
        || (sfx && /^тыс/.test(sfx))) n *= 1000;
    if (sfx === "m" || sfx === "million" || sfx === "млн") n *= 1000000;
    if (Number.isFinite(n) && n >= 0 && n < 100000000) {
      return Math.round(n * 100);
    }
  }

  // Word-number fallback: "five thousand", "two hundred", "пять тысяч",
  // "около пяти тыс". Tokenizer keeps Latin AND Cyrillic letters so
  // Russian word-numbers survive into the lookup.
  const tokens = s.replace(/[^a-zа-яё\s]/g, " ").split(/\s+/).filter(t => WORD_NUMBERS[t] != null);
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

  // Day of month — STRICT. Bare digits ("5") are NOT a date in our flow:
  // the user is more likely giving a balance. Require explicit ordinal /
  // date marker so "у меня 5000 рублей" doesn't get parsed as "5th".
  // English: "the 15th" / "15th" / "on the 1st"
  // Russian: "15-го" / "15го" / "15 числа" / "пятнадцатого"
  // Note on \b: JavaScript \b uses \w = [A-Za-z0-9_] by default, so it
  // does NOT see Cyrillic word boundaries. Russian patterns use the /u
  // flag + Unicode property escape \p{L} (or explicit non-letter
  // lookaround) to fire correctly. English patterns keep \b.
  const dom =
    s.match(/\b(?:the\s+|on\s+the\s+)(\d{1,2})(?:st|nd|rd|th)?\b/) ||
    s.match(/\b(\d{1,2})(st|nd|rd|th)\b/) ||
    s.match(/(?:^|\s|-)(\d{1,2})[-\s]?(?:го|ое|е|ого)(?=\s|$|[^\p{L}])/u) ||
    s.match(/(?:^|\s)(\d{1,2})\s+числа(?=\s|$|[^\p{L}])/u);
  if (dom) {
    const d = parseInt(dom[1], 10);
    if (d >= 1 && d <= 31) {
      return nextDayOfMonth(d, todayStr);
    }
  }

  // Russian ordinal-word days: "пятого" / "пятнадцатого" / "первого".
  const RU_ORDINAL_DAY = {
    "первого": 1, "второго": 2, "третьего": 3, "четвертого": 4, "четвёртого": 4,
    "пятого": 5, "шестого": 6, "седьмого": 7, "восьмого": 8, "девятого": 9,
    "десятого": 10, "одиннадцатого": 11, "двенадцатого": 12, "тринадцатого": 13,
    "четырнадцатого": 14, "пятнадцатого": 15, "шестнадцатого": 16,
    "семнадцатого": 17, "восемнадцатого": 18, "девятнадцатого": 19,
    "двадцатого": 20, "тридцатого": 30,
  };
  for (const word of Object.keys(RU_ORDINAL_DAY)) {
    // Cyrillic-aware boundaries via lookarounds (\b doesn't work for ru).
    if (new RegExp("(?:^|[^\\p{L}])" + word + "(?=$|[^\\p{L}])", "u").test(s)) {
      return nextDayOfMonth(RU_ORDINAL_DAY[word], todayStr);
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
//   { reply: "...", intent?: setup_account, draft?: { balanceCents, balanceAttempts? }, clearDraft?: bool, done: bool }
//
// Repeat-attempt tracking: each phase remembers how many consecutive non-answers
// we got. After 2 misses, the bot offers help / skip. After 3 it offers a way out.
// This kills the "form-feel" the LLM judge flagged.
function handle(state, text, todayStr) {
  todayStr = todayStr || m.today((state && state.timezone) || "UTC");
  const draft = (state && state.onboardingDraft) || {};
  const t = String(text || "").trim();
  const lang = (state && state.language === "ru") ? "ru" : "en";
  // Currency symbol must follow language. Without this, RU users see
  // "$120,000" in onboarding because state.currencySymbol defaults to "$"
  // (persona test 0003.1).
  const sym = (state && state.currencySymbol) || (lang === "ru" ? "₽" : "$");
  const isGreeting = GREETING_RE.test(t);

  // PHASE 1: collect balance.
  if (draft.balanceCents == null) {
    if (isGreeting || !t) {
      return {
        reply: copy.askBalance(lang),
        draft: { balanceAttempts: 0 },
        done: false,
      };
    }
    // Reset escape (also catches users who keep typing "reset" as text).
    if (/^\s*(reset|restart|start over|начать заново|сброс|сбросить)\s*[!.?]*\s*$/i.test(t)) {
      return {
        reply: lang === "ru"
          ? "Чтобы начать заново — напиши /reset (со слешем)."
          : "To start over, type /reset (with the slash).",
        done: false,
      };
    }
    // Early skip — user wants out before giving a balance. Setup with
    // balance=0, irregular pay. They can fill it in later with
    // "actually I have X" / "got 5000".
    if (SKIP_RE.test(t)) {
      return {
        intent: {
          kind: "setup_account",
          params: { balanceCents: 0, payday: m.addDays(todayStr, 30), payFrequency: "irregular" },
        },
        clearDraft: true,
        reply: copy.skippedSetup(lang),
        done: true,
      };
    }
    const amount = parseAmount(t);
    if (amount === null || amount === 0) {
      const attempts = (draft.balanceAttempts || 0) + 1;
      // Escalate copy: 1st miss → friendly nudge, 2nd → reassure + permission to be rough, 3rd → reassure + offer skip.
      let reply;
      if (attempts === 1) reply = copy.balanceMissOnce(lang);
      else if (attempts === 2) reply = copy.balanceMissTwice(lang);
      else reply = copy.balanceMissThrice(lang);
      return {
        reply,
        draft: { balanceAttempts: attempts },
        done: false,
      };
    }
    // Try to grab payday from the same message.
    const payday = parsePayday(t, todayStr);
    if (payday) {
      return {
        intent: { kind: "setup_account", params: { balanceCents: amount, payday, payFrequency: "monthly" } },
        clearDraft: true,
        reply: copy.allSet(lang, amount, payday, sym),
        done: true,
      };
    }
    return {
      draft: { balanceCents: amount, paydayAttempts: 0 },
      reply: copy.gotBalanceAskPayday(lang, amount, sym),
      done: false,
    };
  }

  // PHASE 2: collect payday (or skip).
  // Goal-Layer fix: explicit recognition of "reset / start over / restart"
  // mid-onboarding so the user isn't trapped trying to escape. Also
  // greetings like "hi / hey" — re-show the current question with
  // context rather than the dry miss-message.
  const RESET_RE = /^\s*(reset|restart|start over|начать заново|сброс|сбросить)\s*[!.?]*\s*$/i;
  if (RESET_RE.test(t)) {
    return {
      reply: lang === "ru"
        ? "Чтобы начать заново — напиши /reset (со слешем)."
        : "To start over, type /reset (with the slash).",
      done: false,
    };
  }
  if (isGreeting) {
    // User said "hi" — they're saying hello, not answering. Re-show the
    // current question with full context.
    return {
      reply: copy.gotBalanceAskPayday(lang, draft.balanceCents, sym),
      done: false,
    };
  }
  if (SKIP_RE.test(t)) {
    return {
      intent: {
        kind: "setup_account",
        params: { balanceCents: draft.balanceCents, payday: m.addDays(todayStr, 30), payFrequency: "irregular" },
      },
      clearDraft: true,
      reply: copy.allSetSkipped(lang, draft.balanceCents, sym),
      done: true,
    };
  }

  const payday = parsePayday(t, todayStr);
  if (payday) {
    return {
      intent: {
        kind: "setup_account",
        params: { balanceCents: draft.balanceCents, payday, payFrequency: "monthly" },
      },
      clearDraft: true,
      reply: copy.allSet(lang, draft.balanceCents, payday),
      done: true,
    };
  }

  const attempts = (draft.paydayAttempts || 0) + 1;
  let reply;
  if (attempts === 1) reply = copy.paydayMissOnce(lang);
  else reply = copy.paydayMissTwice(lang); // 2+ → strong skip nudge
  return {
    reply,
    draft: Object.assign({}, draft, { paydayAttempts: attempts }),
    done: false,
  };
}

// Localized copy. Manifesto-led tone: frames the product before asking
// for data. The user should know WHY they're typing a number before
// they're asked to. This is the difference between a form and a
// product. (Pre-rewrite copy was cold "Just a number" / mid-rewrite
// was warm "no stress" — both functional, neither communicated the
// vision. This version leads with the brand and earns the inputs.)
//
// Voice rules:
//   - Lead with the promise ("one number a day"), then ask
//   - "Probably means you're guessing" — name the problem
//   - Keep messages SHORT (Telegram is a tight surface)
//   - Italics for the example phrasings (Markdown)
//   - Skip path always available (no bullying)
// Localized copy. WHAT-led: state what's happening, ask the next thing.
// The PHILOSOPHY ("no budgets, no categories") is discovered through
// use, not explained upfront. The cycle concept ("spend down to ~$0
// by payday, bills protected") lands in step 3, where it actually
// matters for the user's mental model.
//
// Voice rules:
//   - One frame sentence at the start ("I tell you one number a day")
//   - Then immediately the ask
//   - Tiny italic clarifier on each ask (savings/credit don't count, etc.)
//   - Cycle concept introduced ONCE, in step 3, after they have a payday
//   - Skip path always available
const copy = {
  askBalance(L) {
    return L === "ru"
      ? "Привет 👋 Я *Spendkitty*. Покажу тебе одно число в день — сколько можешь потратить.\n\nТри быстрых вопроса. Первый — *сколько в твоём счёте для трат?*\n_(Без сбережений и кредиток. Только повседневные деньги.)_"
      : "Hey 👋 I'm *Spendkitty*. I'll show you one number a day — what you can spend.\n\nThree quick things. First — *what's in your spending account?*\n_(Savings or credit cards don't count. Just the day-to-day money.)_";
  },
  balanceMissOnce(L) {
    return L === "ru"
      ? "Никаких связей с банком — это просто для расчёта. Хватит и примерной суммы. *Сколько в твоём счёте?*"
      : "No bank link — just for the math. A rough figure is plenty. *What's in your spending account?*";
  },
  balanceMissTwice(L) {
    return L === "ru"
      ? "Не парься — скажи *пропустить* и продолжим. Добавишь баланс позже."
      : "No stress — just say *skip* and we'll move on. You can add it later.";
  },
  balanceMissThrice(L) {
    return L === "ru"
      ? "Не парься — скажи *пропустить*."
      : "No rush — just say *skip*.";
  },
  gotBalanceAskPayday(L, amt, sym) {
    const fmt = m.toMoney(amt, sym);
    return L === "ru"
      ? "Записал, *" + fmt + "*.\n\nДальше — *когда следующая зарплата?*\n_(Дата типа «15-го» или «30 апреля». Или скажи «irregular», если фрилансер/подрядчик — покажу сколько хватит денег.)_"
      : "Got it, *" + fmt + "*.\n\nNext — *when's your next paycheck?*\n_(A date like \"the 15th\" or \"April 30\". Or say \"irregular\" if you're a contractor/freelancer — I'll show you runway days.)_";
  },
  paydayMissOnce(L) {
    return L === "ru"
      ? "_(нужна дата)_ Попробуй _«15-го»_, _«1 мая»_, или *«irregular»* для нерегулярной."
      : "_(need a date)_ Try _\"the 15th\"_, _\"May 1\"_, or *\"irregular\"* for variable income.";
  },
  paydayMissTwice(L) {
    return L === "ru"
      ? "_(дата или «irregular» — или /reset чтобы начать заново)_"
      : "_(a date or \"irregular\" — or /reset to start over)_";
  },
  // Step 3 — THE CYCLE CONCEPT LANDS HERE.
  // After the user has given balance + payday, they need the mental
  // model: spend down to ~0 by payday, bills are protected, paycheck
  // refills. This is the only place we explain it — and only in 2
  // short sentences. The bills ask comes right after.
  allSet(L, amt, payday, sym) {
    const fmt = m.toMoney(amt, sym);
    return L === "ru"
      ? "*" + fmt + "* до *" + payday + "* ✓\n\nКак это работает: я даю тебе число на день. *Тратишь до ~0 к зарплате — так и задумано.* Счета держу отдельно, чтобы случайно не съел рент.\n\nПоследнее — *есть счета?* Аренда, телефон, подписки, что-то одноразовое впереди. Или скажи *пропустить*."
      : "*" + fmt + "* until *" + payday + "* ✓\n\nHow it works: I give you a number for today. *You spend down to ~$0 by payday — that's the whole point.* Bills get reserved so they can't be accidentally eaten. Next paycheck refills the cycle.\n\nLast — *got any bills?* Rent, phone, subscriptions, anything one-time coming up. Or say *skip*.";
  },
  // Same idea but for irregular pay — no payday, so "runway" replaces
  // "spend down by payday" framing.
  allSetSkipped(L, amt, sym) {
    const fmt = m.toMoney(amt, sym);
    return L === "ru"
      ? "*" + fmt + "*, нерегулярная зарплата ✓\n\nКак это работает: я даю тебе число на день. *Покажу сколько дней ещё хватит* при текущей трате. Когда придёт зарплата — скажи мне, и время продлится.\n\nПоследнее — *есть счета?* Аренда, подписки, что впереди. Или *пропустить*."
      : "*" + fmt + "*, irregular pay ✓\n\nHow it works: I give you a number for today. *I'll show you runway days* — how long the money lasts at this pace. When income lands, tell me and the runway extends.\n\nLast — *got any bills?* Rent, subscriptions, anything upcoming. Or *skip*.";
  },
  skippedSetup(L) {
    return L === "ru"
      ? "Без проблем — пропускаю настройку. Когда будешь готов(а): _«у меня 5000»_, _«получил 3к»_, _«потратил 50 на обед»_."
      : "All good — skipping setup. When you're ready: _\"I have 5000\"_, _\"got 3k\"_, _\"spent 50 on lunch\"_.";
  },
};

module.exports = { handle, parseAmount, parsePayday, GREETING_RE, SKIP_RE };
