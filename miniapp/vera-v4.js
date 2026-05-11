"use strict";
// SpendYes v4 Mini App — AAA redesign.
// Reads /api/v4/view/:sid. Read-only. All state changes happen in chat.
//
// The product compressed: open the app, see ONE number, feel calm,
// close. Everything below the hero exists to support that moment.
//
// React 18, no JSX, no build step. Single file ~700 LOC.

var h = React.createElement;
var useState = React.useState;
var useEffect = React.useEffect;
var useRef = React.useRef;
var useCallback = React.useCallback;
var useMemo = React.useMemo;

var API_BASE = "";

// Subtle haptic feedback on Telegram clients that support it. Hoisted
// to file scope so EVERY component can call it (TodayTxList,
// TxDetailModal, Heatmap, PayBill, etc.). Previous nested definitions
// would cause a ReferenceError → blank-screen crash when a sibling
// component called it on tap.
function tapHaptic() {
  try {
    var hf = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.HapticFeedback;
    if (hf && hf.impactOccurred) hf.impactOccurred("light");
  } catch (e) { /* ignore */ }
}

// ── i18n ─────────────────────────────────────────────────────
// Mini App locale layer. Strings are fetched once per session from
// /api/v4/locale?lang=X (X comes from view.language). English is the
// fallback. NEVER hardcode user-facing strings in components — always
// call t(key, params).
var _strings = {};       // active locale strings
var _fallback = {};      // English fallback
var _activeLang = "en";

function t(key, params) {
  var str = _strings[key];
  if (str === undefined) str = _fallback[key];
  if (str === undefined) {
    if (typeof console !== "undefined") console.warn("[locale] missing: " + key);
    return key;
  }
  if (params) {
    Object.keys(params).forEach(function(k) {
      str = str.split("{" + k + "}").join(params[k] == null ? "" : String(params[k]));
    });
  }
  return str;
}

function loadLocale(lang, cb) {
  if (!lang) lang = "en";
  if (lang === _activeLang && Object.keys(_strings).length > 0) { cb && cb(); return; }
  fetch(API_BASE + "/api/v4/locale?lang=" + encodeURIComponent(lang))
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d && d.strings) _strings = d.strings;
      if (d && d.fallback) _fallback = d.fallback;
      _activeLang = (d && d.lang) || "en";
      if (cb) cb();
    })
    .catch(function() { if (cb) cb(); });
}

// ── DESIGN TOKENS ────────────────────────────────────────────
var C = {
  bg: "#0F0F0F", card: "#171717", cardHi: "#1F1F1F",
  border: "#262626", borderHi: "#333",
  text: "#EFEAE2", sub: "#9A9A9A", muted: "#5A5A5A",
  green: "#4FB888", amber: "#F0A050", red: "#E45656",
  greenSoft: "rgba(79,184,136,0.14)",
  amberSoft: "rgba(240,160,80,0.14)",
  redSoft: "rgba(228,86,86,0.14)",
};

// ── HELPERS ──────────────────────────────────────────────────
function authHeaders() {
  var initData = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp.initData : "";
  if (!initData && window.TG_INIT_DATA) initData = window.TG_INIT_DATA;
  var headers = { "Content-Type": "application/json" };
  if (initData) headers["X-Telegram-Init-Data"] = initData;
  return headers;
}

function fmtMoney(cents, sym) {
  var s = sym || "$";
  if (cents == null) return s + "0";
  var neg = cents < 0;
  var abs = Math.abs(cents);
  var dollars = Math.floor(abs / 100);
  var change = abs % 100;
  // Compact: hide cents on whole-dollar values for readability.
  var str = dollars.toLocaleString("en-US") + (change ? "." + String(change).padStart(2, "0") : "");
  return (neg ? "-" : "") + s + str;
}

function fmtMoneyFull(cents, sym) {
  var s = sym || "$";
  if (cents == null) return s + "0.00";
  var neg = cents < 0;
  var abs = Math.abs(cents);
  return (neg ? "-" : "") + s + Math.floor(abs / 100).toLocaleString("en-US") + "." + String(abs % 100).padStart(2, "0");
}

function colorForState(s) {
  if (s === "over") return C.red;
  if (s === "tight") return C.amber;
  return C.green;
}

function softColorForState(s) {
  if (s === "over") return C.redSoft;
  if (s === "tight") return C.amberSoft;
  return C.greenSoft;
}

// Build a map of envelope key → friendly name. Used everywhere we
// might otherwise leak the internal ekey ("vietnam_trip") to the user.
function buildNameMap(envelopes) {
  var map = {};
  (envelopes || []).forEach(function(e) { if (e && e.key) map[e.key] = e.name || e.key; });
  return map;
}

// Pretty label for a transaction. Returns { primary, secondary }.
//   primary   — the main line of text in the transaction row
//   secondary — small muted label below (or null)
// Rules:
//   - If a note exists → note is primary; envelope name (if any) is
//     secondary. Never show ekey.
//   - If no note but envelope exists → envelope name is primary,
//     no secondary.
//   - Otherwise → "—".
// Small visual chip rendered next to bill-payment transactions in
// every list view (today / heatmap day-detail / history). Distinguishes
// bill payments from discretionary spends so the user reads the list
// correctly: the "$1,400 rent" row is clearly a bill, not a $1,400
// today-spend. Bill payments are still listed (they happened today),
// just visually labeled.
function billChip() {
  return h("span", {
    style: {
      fontSize: 9, color: C.muted, marginLeft: 6,
      padding: "1px 5px", border: "1px solid " + C.border,
      borderRadius: 4, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: "0.06em",
      fontFamily: "'Inter',sans-serif",
      verticalAlign: "1px",
    },
  }, "bill");
}

function txLabel(tx, nameMap) {
  var note = (tx.note || "").trim();
  var envName = tx.envelopeKey && nameMap ? (nameMap[tx.envelopeKey] || null) : null;
  // Graph fields (optional, may be absent on older transactions).
  var vendor = (tx.vendor || "").trim();
  var category = (tx.category || "").trim();

  // Title rules — vendor (entity) takes precedence over raw note for cleanliness.
  // The note still appears as secondary so the user's original phrasing is
  // preserved. Category renders as a tiny tag.
  // Examples:
  //   { vendor:"Lighthouse", note:"coffee at Lighthouse", category:"coffee" }
  //     → primary: "Lighthouse"   secondary: "coffee · #coffee"
  //   { vendor:"Taxi", note:"taxi back to hotel", category:"transport" }
  //     → primary: "Taxi"  secondary: "back to hotel · #transport"
  //   { note:"5 coffee" } (no graph fields — older tx)
  //     → primary: "5 coffee"  secondary: null
  if (vendor) {
    // Strip the vendor name from the note if present, so we don't repeat it.
    var residual = note;
    if (vendor && residual && residual.toLowerCase().indexOf(vendor.toLowerCase()) !== -1) {
      residual = residual.replace(new RegExp("\\b" + vendor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "ig"), "").replace(/\s+at\s*$|^\s*at\s+|\s{2,}/gi, " ").trim();
    }
    var sec = "";
    if (residual && residual !== note) sec = residual;
    if (category && category !== "other") sec = (sec ? sec + " · " : "") + "#" + category;
    return { primary: vendor, secondary: sec || null };
  }
  if (note && category && category !== "other") {
    return { primary: note, secondary: "#" + category };
  }
  if (note && envName) return { primary: note, secondary: envName };
  if (note) return { primary: note, secondary: null };
  if (envName) return { primary: envName, secondary: null };
  return { primary: "—", secondary: null };
}

// "5m ago" / "2h ago" / "today" / "yesterday" / "Apr 28"
function relativeTime(ts, now) {
  if (!ts) return "";
  var n = (typeof now === "number" ? now : Date.now());
  var diff = n - ts;
  if (diff < 30000) return t("time.justNow");
  if (diff < 60000 * 60) return t("time.minAgo", { n: Math.round(diff / 60000) });
  if (diff < 60000 * 60 * 24) return t("time.hAgo", { n: Math.round(diff / (60000 * 60)) });
  if (diff < 60000 * 60 * 24 * 2) return t("time.yesterday");
  if (diff < 60000 * 60 * 24 * 7) return t("time.daysAgo", { n: Math.round(diff / (60000 * 60 * 24)) });
  try {
    var d = new Date(ts);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch (e) { return ""; }
}

// Highlight envelopes/transactions added recently (last hour).
function isRecent(ts, now) {
  if (!ts) return false;
  const n = (typeof now === "number" ? now : Date.now());
  return (n - ts) < 60 * 60 * 1000; // 1 hour
}

// Pretty due-date label, localized.
function dueDateLabel(daysUntilDue) {
  if (daysUntilDue == null) return t("miniapp.bills.due.noDate");
  if (daysUntilDue < 0) return t("miniapp.bills.due.overdue");
  if (daysUntilDue === 0) return t("miniapp.bills.due.today");
  if (daysUntilDue === 1) return t("miniapp.bills.due.tomorrow");
  return t("miniapp.bills.due.inDays", { days: daysUntilDue });
}

// Format an arrival-date ISO string into "by Jul 15" style — bare date,
// the surrounding template (miniapp.goals.arrival) wraps it.
function arrivalLabel(dateStr) {
  if (!dateStr) return null;
  try {
    var d = new Date(dateStr + "T12:00:00Z");
    var locale = _activeLang === "ru" ? "ru-RU" : "en-US";
    return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
  } catch (e) { return null; }
}

// Safe localStorage wrapper — privacy modes / embedded webviews can throw.
function lsGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, v); return true; } catch { return false; }
}

// Format a transaction's display amount. If the tx has originalAmount +
// originalCurrency in a foreign currency, return "€50 (≈$54)".
function fmtTxAmount(tx, baseSymbol, baseCode) {
  if (tx && typeof tx.originalAmountCents === "number" && tx.originalCurrency
      && String(tx.originalCurrency).toUpperCase() !== String(baseCode || "").toUpperCase()) {
    return fmtCurrencySymbol(tx.originalCurrency) + (Math.abs(tx.originalAmountCents) / 100).toLocaleString("en-US")
      + " (≈" + fmtMoney(Math.abs(tx.amountCents), baseSymbol) + ")";
  }
  return fmtMoney(Math.abs(tx.amountCents), baseSymbol);
}

// Currency symbol lookup mirroring server/currency.js. Best-effort.
var CURRENCY_SYMBOLS = {
  USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", RUB: "₽", INR: "₹",
  BRL: "R$", VND: "₫", THB: "฿", KRW: "₩", PLN: "zł", CZK: "Kč", TRY: "₺",
  AUD: "A$", CAD: "C$", NZD: "NZ$", SGD: "S$", HKD: "HK$", MXN: "$",
  CHF: "CHF", SEK: "kr", NOK: "kr", DKK: "kr", ZAR: "R", HUF: "Ft",
  ILS: "₪", AED: "د.إ", SAR: "﷼", PHP: "₱", IDR: "Rp", MYR: "RM",
  UAH: "₴", RON: "lei", BGN: "лв", CLP: "$", COP: "$", ARS: "$",
  EGP: "E£", PKR: "₨", BDT: "৳", NGN: "₦",
};
function fmtCurrencySymbol(code) {
  if (!code) return "$";
  var u = String(code).toUpperCase();
  return CURRENCY_SYMBOLS[u] || u + " ";
}

function relativeDay(dateStr, today) {
  if (!dateStr) return "";
  if (dateStr === today) return "Today";
  var d1 = new Date(dateStr + "T00:00:00Z").getTime();
  var d2 = new Date(today + "T00:00:00Z").getTime();
  var diff = Math.round((d1 - d2) / 86400000);
  if (diff === -1) return "Yesterday";
  if (diff < -1 && diff >= -6) return Math.abs(diff) + " days ago";
  var d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── HERO ─────────────────────────────────────────────────────
// Sacred. Just the status pill, the big number, and one line of context.
// No inputs, no buttons, no decisions. The morning glance.
// Decision support ("can I afford X?") lives in chat — the right place
// for conversation. The hero stays calm.
// ── HERO ─────────────────────────────────────────────────────
// AAA polish: today's-left as headline (answers "can I afford this
// right now?" — the single most-asked question). Pace + days as
// supporting context. Bank balance + available as reference, smallest.
// Variance and pace-impact chips below for in-the-moment feedback.
//
// Hierarchy (size + opacity, top to bottom):
//   1. Status pill (only when tight or over — calm is silent)
//   2. BIG serif — today's-left
//   3. Small label — "left today"
//   4. Mid context — "$X/day · Nd to payday"
//   5. Reference (muted) — "$X available · $Y in account"
//   6. Variance chip — "●$X over today" (only when spent today)
//   7. Pace-impact line — "≈ $Y/day less rest of cycle" (only when variance ≠ 0)
//
// Over-state has its own shape: deficit becomes the headline.
//
// The user's question this answers is THE ONLY question that matters
// in a daily-allowance tool: "Can I spend this right now without
// breaking later?" Today's-left is the only number that resolves it
// without the user doing any math.
function Hero(props) {
  var v = props.view;
  var col = colorForState(v.state);

  // Status indicator — colored dot only, no word. The previous "Calm"
  // / "Tight" labels read off-brand for a tool that *tells you to
  // spend*. Color carries the meaning: green = healthy (no dot rendered),
  // amber = pace is tight, red = cycle deficit. The big number's color
  // double-codes it for color-blind users. No anthropomorphic labels.
  var pill = (v.state === "calm") ? null : h("div", {
    style: {
      display: "inline-flex", alignItems: "center",
      background: softColorForState(v.state),
      padding: "6px 10px", borderRadius: 999,
      marginBottom: 14,
    },
  },
    h("span", { style: { width: 8, height: 8, borderRadius: "50%", background: col } })
  );

  // OVER STATE — surface the deficit. The user's question in this
  // state is "how bad?", not "what can I spend today?"
  if (v.state === "over") {
    var overSub = (v.daysToPayday === 1)
      ? t("miniapp.hero.overSubBillsSingleDay", { balance: v.balanceShort || v.balanceFormatted })
      : t("miniapp.hero.overSubBills", { balance: v.balanceShort || v.balanceFormatted, days: v.daysToPayday });
    return h("div", { style: { padding: "32px 20px 22px", textAlign: "center" } },
      pill,
      h("div", {
        style: {
          fontFamily: "'Lora',serif", fontSize: 60, fontWeight: 500,
          color: col, lineHeight: 1.0, letterSpacing: "-0.02em",
          transition: "color 0.4s ease",
        },
      }, t("miniapp.hero.overDeficit", { amount: v.deficitFormatted })),
      h("div", { style: { fontSize: 12, color: C.muted, marginTop: 12 } }, overSub)
    );
  }

  // CALM / TIGHT STATE — today's-left is the headline.
  var todayRemCents = (typeof v.todayRemainingCents === "number") ? v.todayRemainingCents : 0;
  var todayOver = todayRemCents < 0;
  // The big number reflects reality: positive = left to spend, negative
  // = went over today's pace. Color shifts to amber when over (gentle
  // warning, not punishing red — red is reserved for cycle-level over).
  // Label adapts to match the sign so the user reads it correctly.
  var todayLeftText = v.todayRemainingFormatted || "";
  var todayLabel = todayOver
    ? t("miniapp.hero.overToday")
    : t("miniapp.hero.leftToday");
  var todayHeroColor = todayOver ? C.amber : col;
  var paceShort = v.dailyPaceShort || v.dailyPaceFormatted || "";
  var availShort = v.disposableShort || v.disposableFormatted || "";
  var balanceShort = v.balanceShort || v.balanceFormatted || "";
  var hasBills = (v.obligatedCents || 0) > 0;

  // Pace + days context line (mid tier).
  // CONTRACTOR / IRREGULAR: show "runway" days (how long balance lasts
  // at current pace) instead of "days to payday" — which is meaningless
  // for variable-income users.
  var paceDaysContext;
  if (v.isIrregular) {
    var runway = (typeof v.runwayDays === "number") ? v.runwayDays : 0;
    var runwayKey = (runway === 1)
      ? "miniapp.hero.runwaySingle"
      : "miniapp.hero.runway";
    paceDaysContext = t(runwayKey, { pace: paceShort, runway: runway });
  } else {
    var paceLineKey = (v.daysToPayday === 1)
      ? "miniapp.hero.subNoBillsSingleDay"
      : "miniapp.hero.subNoBills";
    paceDaysContext = t(paceLineKey, { pace: paceShort, days: v.daysToPayday });
  }

  // Reference line (smallest, muted). When bills exist: "$X available ·
  // $Y in account". When no bills: balance == available, so just show
  // balance — no redundancy.
  var refLine;
  if (hasBills) {
    refLine = t("miniapp.hero.refWithBills", { available: availShort, balance: balanceShort });
  } else {
    refLine = t("miniapp.hero.refNoBills", { balance: balanceShort });
  }

  // VARIANCE CHIP — informational ("today vs pace"), passive.
  // CRITICAL: this does NOT change the headline (pace stays frozen per
  // Model B; today's-left = pace − todaySpent). It just acknowledges
  // today's running delta so the user FEELS the win/cost without the
  // goalpost moving.
  // Hidden when there's no signal: no pace (over state — handled above),
  // no spend yet today, or variance is exactly 0 (rare; not worth the row).
  var varianceCents = v.varianceCents || 0;
  var todaySpent = v.todaySpentCents || 0;
  var paceCents = v.dailyPaceCents || 0;
  var showVariance = paceCents > 0 && todaySpent > 0 && varianceCents !== 0;
  var varianceChip = null;
  if (showVariance) {
    var isUnder = varianceCents > 0;
    var chipColor = isUnder ? C.green : C.amber;
    var chipBg = isUnder ? C.greenSoft : C.amberSoft;
    var chipText = isUnder
      ? t("miniapp.hero.under", { amount: v.varianceShort })
      : t("miniapp.hero.over", { amount: v.varianceShort });
    varianceChip = h("div", {
      style: {
        display: "inline-flex", alignItems: "center", gap: 6,
        background: chipBg, color: chipColor,
        fontSize: 11, fontWeight: 600,
        padding: "5px 11px", borderRadius: 999,
        marginTop: 14, letterSpacing: "0.02em",
      },
    },
      h("span", { style: { width: 5, height: 5, borderRadius: "50%", background: chipColor } }),
      chipText
    );
  }

  // PACE-IMPACT LINE — today's overspend doesn't vanish; it's
  // redistributed across the remaining days of the cycle (tomorrow's
  // pace recomputes at day rollover). Without surfacing this, the user
  // has no signal that today's variance has consequences. With it,
  // they see the cause-effect chain in one glance. The "tomorrow signal."
  //
  // Color matches the variance chip. Hidden when no signal OR when the
  // per-day delta is 0 (e.g. payday tomorrow → no projection possible).
  var paceDelta = v.paceDeltaCents || 0;
  var showPaceImpact = showVariance && paceDelta !== 0;
  var paceImpactLine = null;
  if (showPaceImpact) {
    var deltaShort = v.paceDeltaShort || "";
    var deltaIsUp = paceDelta > 0; // tomorrow's pace HIGHER → user under-spent
    var impactColor = deltaIsUp ? C.green : C.amber;
    var impactKey = deltaIsUp ? "miniapp.hero.tomorrowMore" : "miniapp.hero.tomorrowLess";
    paceImpactLine = h("div", {
      style: {
        fontSize: 10, color: impactColor, marginTop: 6,
        letterSpacing: "0.02em", opacity: 0.9,
      },
    }, t(impactKey, { delta: deltaShort }));
  }

  return h("div", { style: { padding: "32px 20px 22px", textAlign: "center" } },
    pill,
    // BIG: today's-left (the answer to "can I spend this?")
    h("div", {
      style: {
        fontFamily: "'Lora',serif", fontSize: 60, fontWeight: 500,
        color: todayHeroColor, lineHeight: 1.0, letterSpacing: "-0.02em",
        transition: "color 0.4s ease",
      },
    }, todayLeftText),
    // Label (adapts to sign: "left today" vs "over today")
    h("div", { style: { fontSize: 13, color: C.sub, marginTop: 10, letterSpacing: "0.02em" } },
      todayLabel),
    // Mid context: pace + days
    h("div", { style: { fontSize: 12, color: C.muted, marginTop: 6 } }, paceDaysContext),
    // Reference (smallest, dimmest): bank balance + available
    h("div", { style: { fontSize: 11, color: C.muted, marginTop: 4, opacity: 0.75 } }, refLine),
    varianceChip,
    paceImpactLine
  );
}

// ── HEATMAP CALENDAR ─────────────────────────────────────────
// 30 days as colored squares. Color from spend vs that day's safe
// pace. Tap a square → expand inline showing that day's transactions.
function Heatmap(props) {
  var heatmap = props.heatmap || [];
  var dailyPace = props.dailyPaceCents || 0;
  // Selected day is now controlled by Dashboard so the detail panel
  // can render as a sibling card BELOW the heatmap (not nested inside).
  var open = props.selectedDay || null;
  var onSelectDay = props.onSelectDay || function() {};
  // tapHaptic is now file-scope (top of file).

  // Color thresholds (tightened — user reported "very over shows
  // orange not red"):
  //   ratio ≤ 0.5  → light green ("comfortable")
  //   ratio ≤ 1.0  → green       ("on track / right at pace")
  //   ratio ≤ 1.25 → amber       ("a bit over")
  //   ratio > 1.25 → red         ("notable overspend")
  //
  // PER-DAY PACE: each cell carries its OWN paceCents (set by engine
  // when pace was refreshed THAT day, written into state.paceHistory).
  // Falls back to the global `dailyPace` prop for cells from before
  // paceHistory existed. This is the historical-accuracy fix.
  function colorForDay(spent, dayPace) {
    if (spent === 0) return { bg: C.cardHi, fg: C.muted };
    var paceToUse = (dayPace != null && dayPace > 0) ? dayPace : dailyPace;
    if (paceToUse <= 0) return { bg: C.cardHi, fg: C.muted };
    var ratio = spent / paceToUse;
    if (ratio <= 0.5) return { bg: "rgba(79,184,136,0.55)", fg: "#0F0F0F" };
    if (ratio <= 1.0) return { bg: "rgba(79,184,136,0.85)", fg: "#0F0F0F" };
    if (ratio <= 1.25) return { bg: "rgba(240,160,80,0.85)", fg: "#0F0F0F" };
    return { bg: "rgba(228,86,86,0.85)", fg: "#FFFFFF" };
  }

  function dayLabel(d) { return d.slice(8); /* day-of-month */ }

  return h("div", { style: { padding: "8px 16px 0" } },
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 } },
      h("div", { style: { fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 } }, t("miniapp.heatmap.last30")),
      h("div", { style: { display: "flex", gap: 6, alignItems: "center", fontSize: 10, color: C.muted } },
        h("div", { style: { width: 8, height: 8, borderRadius: 2, background: "rgba(79,184,136,0.55)" } }),
        h("span", null, t("miniapp.heatmap.under")),
        h("div", { style: { width: 8, height: 8, borderRadius: 2, background: "rgba(240,160,80,0.85)", marginLeft: 4 } }),
        h("span", null, t("miniapp.heatmap.over"))
      )
    ),
    h("div", {
      style: {
        display: "grid",
        gridTemplateColumns: "repeat(10, 1fr)",
        gap: 4,
      },
    },
      heatmap.map(function(d, i) {
        var col = colorForDay(d.spentCents, d.paceCents);
        var isOpen = open === d.date;
        return h("div", {
          key: d.date,
          onClick: function() { onSelectDay(d.date); },
          style: {
            aspectRatio: "1 / 1",
            background: isOpen ? C.text : col.bg,
            color: isOpen ? "#0F0F0F" : col.fg,
            borderRadius: 4,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 9, fontWeight: 600,
            cursor: "pointer",
            border: isOpen ? "2px solid " + C.text : "none",
            transition: "all 0.15s ease",
          },
        }, dayLabel(d.date));
      })
    )
    // Detail card is rendered by Dashboard as a sibling below the
    // heatmap (not nested) so it gets full-width treatment matching
    // TodayStrip styling — proper drawer feel, no scroll surprises.
  );
}

// DayDetailCard — full-width drawer below the heatmap showing the
// selected day's spends. Styled to match TodayStrip so the visual
// rhythm is consistent (the user sees TodayStrip → Heatmap → DayDetail
// as the same family of cards). Animates in with fadeIn.
function DayDetailCard(props) {
  var dayTxs = (props.txs || []).filter(function(tx) { return tx.date === props.date; });
  // Day total = DISCRETIONARY spend only (matches the heatmap color
  // calc + view.compute todaySpentCents). Bill payments are obligation
  // money already reserved out of disposable, so summing them here
  // would double-book — user paid $1,400 rent + $5 coffee → header
  // shows "$1,405 spent" but their actual discretionary was $5. The
  // bill payments still appear in the LIST below with a "bill" chip
  // so the day's full activity is visible.
  var total = dayTxs.reduce(function(a, tx) {
    if (tx.kind === "spend") return a + tx.amountCents;
    if (tx.kind === "refund") return a - Math.abs(tx.amountCents);
    return a; // skip bill_payment, income, etc.
  }, 0);
  var dateLabel = props.today ? relativeDay(props.date, props.today) : props.date;
  var isEmpty = dayTxs.length === 0;
  return h("div", {
    style: { padding: "14px 16px 0", animation: "fadeIn 200ms ease" },
  },
    h("div", {
      style: {
        background: C.card, border: "1px solid " + C.border, borderRadius: 12,
        padding: "12px 14px",
      },
    },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: isEmpty ? 0 : 10 } },
        h("div", null,
          h("div", { style: { fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 } }, dateLabel)
        ),
        // Hide the "$X spent" chip when the day genuinely has nothing —
        // it would pretend activity where there wasn't any. Empty state
        // below conveys the truth.
        isEmpty
          ? null
          : h("div", {
              style: {
                fontFamily: "'Lora',serif", fontSize: 16, color: C.text,
              },
            }, fmtMoney(total, props.sym))
      ),
      isEmpty
        ? h("div", { style: { fontSize: 12, color: C.muted, padding: "8px 0 4px", fontStyle: "italic" } }, t("miniapp.heatmap.empty"))
        : dayTxs.map(function(tx) {
            var lbl = txLabel(tx, props.nameMap);
            return h("div", {
              key: tx.id,
              style: { display: "flex", justifyContent: "space-between", padding: "9px 0", fontSize: 13, borderTop: "1px solid " + C.border, alignItems: "center" },
            },
              h("div", { style: { flex: 1, overflow: "hidden", marginRight: 10 } },
                h("div", { style: { color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                  lbl.primary,
                  tx.kind === "bill_payment" ? billChip() : null
                ),
                lbl.secondary ? h("div", { style: { color: C.muted, fontSize: 11, marginTop: 2 } }, lbl.secondary) : null
              ),
              h("div", { style: { color: tx.kind === "refund" ? C.green : C.text, fontFamily: "'Lora',serif" } },
                (tx.kind === "refund" ? "+" : "") + fmtMoney(Math.abs(tx.amountCents), props.sym)
              )
            );
          })
    )
  );
}

// ── TODAY STRIP ──────────────────────────────────────────────
// AAA design (bug-reports/0004-today-strip-AAA): the most important
// question is "am I on track?" — answered with a progress bar + two
// numbers + status color. Then the transactions list is "what did I
// spend on today?" for retrospect.
function TodayStrip(props) {
  var v = props.view;
  var sym = v.currencySymbol || "$";
  var nameMap = props.nameMap || {};
  var todayTxs = (props.txs || []).filter(function(tx) {
    if (tx.date !== props.today) return false;
    return tx.kind === "spend" || tx.kind === "refund" || tx.kind === "bill_payment";
  });

  // Math comes from the view (already computed server-side in
  // v5ToV4View): dailyPaceCents = "today's budget"; todaySpentCents =
  // discretionary spend logged today; todayRemainingCents = max(0, pace - spent).
  var paceCents = Math.max(0, v.dailyPaceCents || 0);
  var spentCents = Math.max(0, v.todaySpentCents || 0);
  var remainingCents = Math.max(0, paceCents - spentCents);
  var pctSpent = paceCents > 0 ? Math.min(100, (spentCents / paceCents) * 100) : 0;

  // Color tier: green if >50% pace remains, amber 20-50%, red <20% or over.
  // Edge: paceCents=0 (over status from hero) → always red.
  var statusColor;
  if (paceCents <= 0) statusColor = C.red;
  else if (pctSpent < 50) statusColor = C.green;
  else if (pctSpent < 80) statusColor = C.amber;
  else statusColor = C.red;

  // Friendly date label like "Mon, May 1".
  var dateLabel = (function() {
    try {
      var d = new Date(props.today + "T12:00:00Z");
      return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    } catch { return props.today || ""; }
  })();

  return h("div", { style: { padding: "20px 16px 0" } },
    // ── HEADER: label + date ──
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 } },
      h("div", { style: { fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 } }, t("miniapp.today.label")),
      h("div", { style: { fontSize: 11, color: C.muted } }, dateLabel)
    ),
    // ── AAA SUMMARY CARD: spent / left / bar ──
    h("div", {
      style: {
        background: C.card, border: "1px solid " + C.border, borderRadius: 12,
        padding: "12px 14px", marginBottom: 10,
      },
    },
      h("div", {
        style: {
          display: "flex", justifyContent: "space-between", alignItems: "baseline",
          marginBottom: 8, fontFamily: "'Lora',serif",
        },
      },
        h("div", null,
          h("span", { style: { color: C.muted, fontSize: 11, fontWeight: 500, fontFamily: "'Inter',sans-serif", letterSpacing: "0.04em", textTransform: "uppercase" } }, "Spent"),
          h("div", { style: { fontSize: 18, color: C.text, marginTop: 2 } }, fmtMoney(spentCents, sym))
        ),
        h("div", { style: { textAlign: "right" } },
          h("span", { style: { color: C.muted, fontSize: 11, fontWeight: 500, fontFamily: "'Inter',sans-serif", letterSpacing: "0.04em", textTransform: "uppercase" } },
            paceCents <= 0 ? "Over" : "Left today"),
          h("div", { style: { fontSize: 18, color: statusColor, marginTop: 2 } },
            paceCents <= 0 ? "—" : fmtMoney(remainingCents, sym))
        )
      ),
      // Bar
      h("div", {
        style: {
          width: "100%", height: 6, background: C.border, borderRadius: 3, overflow: "hidden",
        },
      },
        h("div", {
          style: {
            width: pctSpent + "%", height: "100%", background: statusColor,
            transition: "width 200ms ease",
          },
        })
      ),
      // Sub-label: "$120/day pace" or "no pace today" when over
      h("div", {
        style: {
          fontSize: 10, color: C.muted, marginTop: 6, display: "flex", justifyContent: "space-between",
          fontFamily: "'Inter',sans-serif", letterSpacing: "0.02em",
        },
      },
        h("span", null, paceCents <= 0
          ? "no pace today — bills exceed balance"
          : Math.round(pctSpent) + "% of " + fmtMoney(paceCents, sym) + "/day"),
        h("span", null, "")
      )
    ),
    todayTxs.length === 0
      ? h("div", {
          style: {
            background: C.card, border: "1px dashed " + C.border, borderRadius: 12,
            padding: "16px 14px", textAlign: "center", fontSize: 12, color: C.muted,
          },
        }, t("miniapp.today.empty"))
      : h(TodayTxList, { txs: todayTxs, sym: sym, nameMap: nameMap })
  );
}

// Cap-and-expand list. Real-world AAA UX requirement: heavy spending
// days were pushing the heatmap and bills off-screen because every
// transaction added a fixed-height row. Now: show the most-recent 3,
// rest collapsed under a "+N more" tap to expand. Heatmap stays
// visible. User-reported polish item.
var TODAY_DEFAULT_VISIBLE = 3;
function TodayTxList(props) {
  var expandedState = useState(false);
  var expanded = expandedState[0], setExpanded = expandedState[1];
  // Read-only detail modal: tap a row → see all the rich info. Edit/delete
  // is via chat ("delete the lighthouse coffee"), not in-app — keeps the
  // Mini App calm and the AI as the single edit channel.
  var openTxState = useState(null);
  var openTx = openTxState[0], setOpenTx = openTxState[1];

  var txs = props.txs || [];
  var sym = props.sym;
  var nameMap = props.nameMap;
  var visibleTxs = expanded ? txs : txs.slice(0, TODAY_DEFAULT_VISIBLE);
  var hidden = txs.length - visibleTxs.length;

  return h("div", null,
    h("div", { style: { background: C.card, border: "1px solid " + C.border, borderRadius: 12, overflow: "hidden" } },
      visibleTxs.map(function(tx, i) {
        var lbl = txLabel(tx, nameMap);
        return h("div", {
          key: tx.id,
          onClick: function() { tapHaptic && tapHaptic(); setOpenTx(tx); },
          style: {
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "11px 14px", borderTop: i === 0 ? "none" : "1px solid " + C.border,
            cursor: "pointer",
            transition: "background 100ms ease",
          },
          onMouseDown: function(e) { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; },
          onMouseUp: function(e) { e.currentTarget.style.background = "transparent"; },
          onMouseLeave: function(e) { e.currentTarget.style.background = "transparent"; },
          onTouchStart: function(e) { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; },
          onTouchEnd: function(e) { e.currentTarget.style.background = "transparent"; },
        },
          h("div", { style: { flex: 1, overflow: "hidden" } },
            h("div", { style: { fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              lbl.primary,
              tx.kind === "bill_payment" ? billChip() : null
            ),
            h("div", { style: { fontSize: 10, color: C.muted, marginTop: 2, display: "flex", gap: 6 } },
              lbl.secondary ? h("span", null, lbl.secondary) : null,
              lbl.secondary && tx.ts ? h("span", { style: { color: C.muted } }, "·") : null,
              tx.ts ? h("span", null, relativeTime(tx.ts)) : null
            )
          ),
          h("div", {
            style: {
              fontFamily: "'Lora',serif", fontSize: 14,
              color: tx.kind === "refund" ? C.green : C.text, marginLeft: 8,
            },
          }, (tx.kind === "refund" ? "+" : "") + fmtMoney(Math.abs(tx.amountCents), sym))
        );
      }),
      // "+N more" / "show fewer" toggle row — keeps heatmap visible on
      // heavy days (Goal-Layer fix: at-a-glance preserved, full list
      // optional).
      txs.length > TODAY_DEFAULT_VISIBLE
        ? h("div", {
            onClick: function() { tapHaptic && tapHaptic(); setExpanded(!expanded); },
            style: {
              padding: "10px 14px", borderTop: "1px solid " + C.border,
              fontSize: 12, color: C.sub, textAlign: "center", cursor: "pointer",
              background: "rgba(255,255,255,0.02)",
              fontFamily: "'Inter',sans-serif", letterSpacing: "0.02em",
            },
          }, expanded
            ? "▴ show fewer"
            : "+" + hidden + " more · tap to expand")
        : null
    ),
    openTx ? h(TxDetailModal, { tx: openTx, sym: sym, onClose: function() { setOpenTx(null); } }) : null
  );
}

// ── TX DETAIL MODAL ──────────────────────────────────────────
// Tap on any transaction → slide-up sheet with all the rich info.
// Read-only by design: edits / deletes happen via chat with the bot
// ("delete the lighthouse coffee"). One channel, one mental model.
// Closes on backdrop tap, X button, or ESC.
function TxDetailModal(props) {
  var tx = props.tx;
  var sym = props.sym;
  var onClose = props.onClose;

  // Close on Escape key.
  useEffect(function() {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return function() { document.removeEventListener("keydown", onKey); };
  }, []);

  var isForeign = tx.originalCurrency && tx.originalAmount && tx.originalAmount > 0;
  var bigAmount = (tx.kind === "refund" || tx.kind === "income" ? "+" : "") + fmtMoney(Math.abs(tx.amountCents), sym);
  var foreignLine = isForeign
    ? fmtForeignAmount(tx.originalAmount, tx.originalCurrency)
    : null;

  // Row helper: label on the left, value on the right.
  function row(label, value, opts) {
    if (value == null || value === "") return null;
    var color = (opts && opts.muted) ? C.muted : C.text;
    return h("div", {
      style: {
        display: "flex", justifyContent: "space-between", alignItems: "baseline",
        padding: "10px 0", borderTop: "1px solid " + C.border,
        fontSize: 13,
      },
    },
      h("div", { style: { color: C.sub, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 } }, label),
      h("div", { style: { color: color, fontSize: 13, textAlign: "right", maxWidth: "70%", overflowWrap: "break-word" } }, value)
    );
  }

  // Friendly relative date ("Today" / "Yesterday" / Mar 25).
  var dateLabel = tx.date;
  try {
    var todayStr = new Date().toISOString().slice(0, 10);
    if (tx.date === todayStr) dateLabel = "Today";
    else {
      var diff = Math.round((new Date(todayStr + "T00:00:00Z") - new Date(tx.date + "T00:00:00Z")) / 86400000);
      if (diff === 1) dateLabel = "Yesterday";
      else if (diff > 1 && diff <= 6) dateLabel = diff + " days ago";
      else dateLabel = new Date(tx.date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }
  } catch {}
  var timeLabel = "";
  if (tx.ts) {
    try { timeLabel = " · " + new Date(tx.ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); } catch {}
  }

  return h("div", {
    onClick: function(e) { if (e.target === e.currentTarget) onClose(); },
    style: {
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.72)",
      zIndex: 1000,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
      animation: "fadeIn 150ms ease",
    },
  },
    h("div", {
      onClick: function(e) { e.stopPropagation(); },
      style: {
        background: "#1a1a1a",
        borderTopLeftRadius: 18, borderTopRightRadius: 18,
        width: "100%", maxWidth: 520,
        maxHeight: "85vh", overflow: "auto",
        padding: "20px 22px 28px",
        boxShadow: "0 -10px 40px rgba(0,0,0,0.5)",
        animation: "slideUp 200ms ease",
      },
    },
      // Drag handle (visual only)
      h("div", {
        style: {
          width: 36, height: 4, background: "rgba(255,255,255,0.18)",
          borderRadius: 2, margin: "0 auto 18px",
        },
      }),
      // Big amount headline. For foreign-currency txs we show the
      // original-currency line below + a tiny "mid-market" hint that
      // sets expectation: this is a daily ECB rate, not the user's
      // bank-card rate which can differ ~1-3%. Honest signal.
      h("div", { style: { textAlign: "center", marginBottom: foreignLine ? 4 : 18 } },
        h("div", { style: { fontFamily: "'Lora',serif", fontSize: 34, color: tx.kind === "refund" || tx.kind === "income" ? C.green : C.text, fontWeight: 400 } }, bigAmount),
        foreignLine ? h("div", { style: { fontFamily: "'Lora',serif", fontSize: 14, color: C.muted, marginTop: 4 } }, foreignLine + " · " + tx.originalCurrency) : null,
        foreignLine ? h("div", { style: { fontSize: 9, color: C.muted, marginTop: 2, textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "'Inter',sans-serif", opacity: 0.7 } }, "mid-market rate") : null
      ),
      foreignLine ? h("div", { style: { height: 14 } }) : null,
      // Vendor — primary identifier
      tx.vendor
        ? h("div", { style: { textAlign: "center", fontSize: 18, color: C.text, fontWeight: 500, marginBottom: 4 } }, tx.vendor)
        : null,
      // Note (only if it adds info beyond vendor)
      tx.note && tx.note.toLowerCase() !== (tx.vendor || "").toLowerCase()
        ? h("div", { style: { textAlign: "center", fontSize: 13, color: C.sub, marginBottom: 14, padding: "0 12px" } }, tx.note)
        : null,
      // Tags + category as chips
      (tx.category || (tx.tags && tx.tags.length > 0))
        ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", marginBottom: 16 } },
            tx.category && tx.category !== "other" ? h("span", { style: { fontSize: 11, padding: "4px 10px", borderRadius: 12, background: "rgba(79,184,136,0.12)", color: C.green, fontWeight: 500 } }, "#" + tx.category) : null,
            (tx.tags || []).map(function(tag) {
              return h("span", { key: tag, style: { fontSize: 11, padding: "4px 10px", borderRadius: 12, background: "rgba(255,255,255,0.06)", color: C.sub } }, tag);
            })
          )
        : null,
      // Detail rows
      h("div", { style: { marginTop: 10 } },
        row("Date", dateLabel + timeLabel),
        row("Context", tx.context),
        row("Type", tx.kind === "bill_payment" ? "Bill payment" : (tx.kind === "income" ? "Income" : tx.kind === "refund" ? "Refund" : "Spend"))
      ),
      // Hint about how to fix/remove
      h("div", {
        style: {
          marginTop: 22, padding: "12px 14px", borderRadius: 10,
          background: "rgba(255,255,255,0.04)", fontSize: 11, lineHeight: 1.5,
          color: C.muted, textAlign: "center",
        },
      },
        "Want to fix or remove this? Just message me — ",
        h("span", { style: { color: C.sub, fontStyle: "italic" } }, tx.vendor ? "\"delete the " + tx.vendor.toLowerCase() + " one\"" : "\"delete that\"")
      ),
      // Close button
      h("button", {
        onClick: function() { tapHaptic && tapHaptic(); onClose(); },
        style: {
          marginTop: 18, width: "100%", padding: "12px",
          background: "rgba(255,255,255,0.06)", color: C.text,
          border: "none", borderRadius: 10, fontSize: 14,
          cursor: "pointer", fontFamily: "'Inter',sans-serif",
        },
      }, "Close")
    )
  );
}

// Small helper: format a foreign amount with its native symbol +
// thousands separator, respecting per-currency decimals.
function fmtForeignAmount(amount, code) {
  var symbols = { USD: "$", EUR: "€", GBP: "£", RUB: "₽", JPY: "¥", VND: "₫", AUD: "A$", CAD: "C$", INR: "₹", CNY: "¥", THB: "฿", IDR: "Rp", MYR: "RM", SGD: "S$", HKD: "HK$", KRW: "₩", TRY: "₺", MXN: "MX$", BRL: "R$" };
  var noDecimals = { VND: true, JPY: true, KRW: true, IDR: true };
  var sym = symbols[code] || (code + " ");
  if (noDecimals[code]) {
    return sym + Math.round(amount).toLocaleString("en-US");
  }
  return sym + amount.toFixed(2);
}

// ── FIRST-TIME CELEBRATION CARD ──────────────────────────────
// Shows once per device after first successful dashboard load.
// Persisted via localStorage (gracefully no-op if blocked).
function FirstTimeCard(props) {
  var seenState = useState(true);
  var seen = seenState[0], setSeen = seenState[1];

  useEffect(function() {
    var key = "spendyes_first_seen_v1";
    var alreadySeen = lsGet(key);
    if (!alreadySeen) {
      setSeen(false);
      lsSet(key, "1"); // mark immediately so refresh doesn't re-show
    }
  }, []);

  if (seen) return null;
  return h("div", {
    style: {
      margin: "10px 16px 0", padding: "14px 16px",
      background: C.greenSoft, border: "1px solid rgba(79,184,136,0.3)",
      borderRadius: 12, position: "relative",
    },
  },
    h("div", { style: { fontSize: 13, fontWeight: 600, color: C.green, marginBottom: 4 } }, t("miniapp.firstTime.title")),
    h("div", { style: { fontSize: 12, color: C.text, lineHeight: 1.5 } }, t("miniapp.firstTime.body")),
    h("div", {
      onClick: function() { setSeen(true); },
      style: {
        position: "absolute", top: 10, right: 12,
        fontSize: 14, color: C.muted, cursor: "pointer", padding: 4,
      },
    }, "×")
  );
}

// ── ANTICIPATION STRIP ─────────────────────────────────────
// Above Today, shows the next 1-2 imminent obligations: "Coming up · X tomorrow · $1,000"
function AnticipationStrip(props) {
  var bills = (props.envelopes || []).filter(function(e) {
    return e.kind === "bill" && e.daysUntilDue != null
      && e.daysUntilDue >= 0 && e.daysUntilDue <= 7
      && e.amountCents > 0;
  });
  if (bills.length === 0) return null;
  bills.sort(function(a, b) { return a.daysUntilDue - b.daysUntilDue; });
  var top = bills.slice(0, 2);
  var sym = props.sym || "$";

  return h("div", { style: { padding: "20px 16px 0" } },
    h("div", {
      style: {
        background: C.card, border: "1px solid " + C.border, borderRadius: 12,
        padding: "10px 14px",
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
      },
    },
      h("div", {
        style: { fontSize: 10, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 },
      }, t("miniapp.comingUp")),
      top.map(function(e) {
        return h("div", {
          key: e.key,
          style: { fontSize: 12, color: C.text, display: "inline-flex", gap: 6 },
        },
          h("span", { style: { color: C.text } }, e.name),
          h("span", { style: { color: C.muted } }, "·"),
          h("span", { style: { color: e.daysUntilDue <= 1 ? C.amber : C.text } }, dueDateLabel(e.daysUntilDue)),
          h("span", { style: { color: C.muted } }, "·"),
          h("span", { style: { fontFamily: "'Lora',serif" } }, fmtMoney(e.amountCents, sym))
        );
      })
    )
  );
}

// ── DUE-NOW BANNER ─────────────────────────────────────────
// Above Bills, only when something is overdue / today / tomorrow. Loud.
function DueBanner(props) {
  var bills = (props.envelopes || []).filter(function(e) {
    return e.kind === "bill" && e.daysUntilDue != null && e.daysUntilDue <= 1;
  });
  if (bills.length === 0) return null;
  bills.sort(function(a, b) { return a.daysUntilDue - b.daysUntilDue; });
  var first = bills[0];
  var col = first.daysUntilDue < 0 ? C.red : C.amber;
  var soft = first.daysUntilDue < 0 ? C.redSoft : C.amberSoft;
  var icon = first.daysUntilDue < 0 ? "⚠️" : "⏰";
  var label = dueDateLabel(first.daysUntilDue);
  var sym = props.sym || "$";

  return h("div", { style: { padding: "8px 16px 0" } },
    h("div", {
      style: {
        background: soft, border: "1px solid " + col, borderRadius: 12,
        padding: "10px 14px",
        display: "flex", alignItems: "center", gap: 10,
      },
    },
      h("div", { style: { fontSize: 16 } }, icon),
      h("div", { style: { flex: 1, overflow: "hidden" } },
        h("div", { style: { fontSize: 13, fontWeight: 600, color: col, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
          first.name + " " + label),
        bills.length > 1
          ? h("div", { style: { fontSize: 10, color: C.sub, marginTop: 2 } },
              "+ " + (bills.length - 1) + " more")
          : null
      ),
      h("div", { style: { fontFamily: "'Lora',serif", fontSize: 16, color: col } },
        fmtMoney(first.amountCents, sym))
    )
  );
}

// ── ENVELOPE SECTIONS (Bills / Budgets / Goals) ─────────────
function SectionHeader(props) {
  // Subtitle (optional) sits as a second row in muted text — used by
  // the bills section to show "$X set aside · $Y next cycle" so the
  // engine's bill-reservation math stops being invisible. Keeps the
  // tight existing visual rhythm: title row + thin context row.
  return h("div", { style: { padding: "20px 16px 8px" } },
    h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
      h("div", { style: { fontSize: 16 } }, props.icon),
      h("div", { style: { fontSize: 12, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 } }, props.title),
      props.count != null ? h("div", { style: { fontSize: 12, color: C.muted } }, "· " + props.count) : null
    ),
    props.subtitle
      ? h("div", { style: { fontSize: 11, color: C.muted, marginTop: 5, letterSpacing: "0.01em" } }, props.subtitle)
      : null
  );
}

function BillCard(props) {
  var e = props.env;
  var sym = props.sym;
  var sid = props.sid;
  var onPaid = props.onPaid;
  var col = C.text;
  if (e.daysUntilDue != null) {
    if (e.daysUntilDue < 0) col = C.red;
    else if (e.daysUntilDue <= 1) col = C.amber;
    else if (e.daysUntilDue <= 7) col = C.amber;
  }
  var label = dueDateLabel(e.daysUntilDue);

  // Two-tap confirm: tap shows confirm chip, second tap fires the action.
  var confirmState = useState(false);
  var showConfirm = confirmState[0], setShowConfirm = confirmState[1];
  var busyState = useState(false);
  var busy = busyState[0], setBusy = busyState[1];
  var errState = useState(null);
  var err = errState[0], setErr = errState[1];
  // tapHaptic is now file-scope (top of file).

  // V5 Mark Paid: send a record_spend intent with billKey set. The engine
  // recognizes billKey as a bill_payment — clears the obligation, debits
  // balance, leaves pace UNCHANGED (carve-out was already in the math).
  // Preserves originalAmount/Currency so history shows the foreign-
  // currency phrase ("€200 ≈ $216") on the resulting transaction.
  function markPaid() {
    if (!sid || busy) return;
    setBusy(true); setErr(null);
    var intent = {
      kind: "record_spend",
      params: {
        amountCents: e.amountCents,
        billKey: e.key,
        note: e.name,
      },
    };
    if (e.originalCurrency && typeof e.originalAmount === "number" && e.originalAmount > 0) {
      intent.params.originalAmount = e.originalAmount;
      intent.params.originalCurrency = e.originalCurrency;
    }
    fetch(API_BASE + "/api/v5/apply/" + sid, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ intent: intent }),
    })
      .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, body: d }; }); })
      .then(function(res) {
        if (res.ok && res.body && res.body.ok) {
          tapHaptic();
          setShowConfirm(false);
          if (onPaid) onPaid(res.body.view);
        } else {
          var failArr = res.body && res.body.failed;
          var first = Array.isArray(failArr) && failArr.length ? failArr[0] : null;
          setErr(first || (res.body && (res.body.error || res.body.reason)) || t("miniapp.bills.couldntPay"));
        }
      })
      .catch(function(e2) { setErr(e2.message); })
      .then(function() { setBusy(false); });
  }

  var newGlow = isRecent(e.createdAt) ? "0 0 0 1px " + C.green : "none";

  return h("div", {
    style: {
      background: C.card,
      border: "1px solid " + C.border,
      borderRadius: 12,
      padding: "12px 14px", marginBottom: 8,
      boxShadow: newGlow,
      transition: "box-shadow 0.4s",
    },
  },
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
      h("div", null,
        h("div", { style: { fontSize: 14, fontWeight: 500 } },
          e.name,
          isRecent(e.createdAt) ? h("span", {
            style: { fontSize: 9, color: C.green, marginLeft: 6, padding: "1px 6px", borderRadius: 999, background: C.greenSoft, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" },
          }, t("miniapp.newBadge")) : null
        ),
        h("div", { style: { fontSize: 11, color: col, marginTop: 3, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
          h("span", null, label),
          // Commitment-type chip — visually distinguish recurring obligations
          // from one-time set-asides. Same underlying primitive (add_bill),
          // different surface label to match the user's mental model.
          //   recurrence !== "once" → "MONTHLY" / "WEEKLY" / "BIWEEKLY"
          //   recurrence === "once" → "ONE-TIME" (set aside)
          e.recurrence && e.recurrence !== "once"
            ? h("span", { style: { color: C.muted } }, "· " + e.recurrence)
            : h("span", {
                style: {
                  fontSize: 9, color: C.muted, padding: "2px 7px", borderRadius: 999,
                  background: C.cardHi, fontWeight: 500, textTransform: "uppercase",
                  letterSpacing: "0.04em", whiteSpace: "nowrap",
                },
              }, "one-time"),
          // "next cycle" chip — quiet pill marking bills due AFTER payday.
          // The next paycheck handles them, so they're NOT in this cycle's
          // engine reservation. Helps user understand why the daily pace
          // doesn't reserve for them yet.
          e.cycleStatus === "next" && !e.paidThisCycle ? h("span", {
            style: {
              fontSize: 9, color: C.muted, padding: "2px 7px", borderRadius: 999,
              background: C.cardHi, fontWeight: 500, textTransform: "uppercase",
              letterSpacing: "0.04em", whiteSpace: "nowrap",
            },
          }, t("miniapp.bills.nextCycle")) : null
        )
      ),
      h("div", { style: { fontFamily: "'Lora',serif", fontSize: 16 } }, e.amountFormatted)
    ),
    // Action area — Mark Paid two-tap confirm. Only show on UNPAID bills
    // (recurring or one-time). Paid bills don't need the button. The
    // 30-day-ahead gate was removed: AAA UX means every unpaid bill is
    // markable from the card itself, regardless of due-date proximity.
    !e.paidThisCycle && sid ? h("div", { style: { marginTop: 10, paddingTop: 10, borderTop: "1px solid " + C.border } },
      !showConfirm
        ? h("div", {
            onClick: function() { setShowConfirm(true); setErr(null); },
            style: {
              fontSize: 12, color: C.sub, cursor: "pointer",
              display: "inline-flex", alignItems: "center", gap: 6,
            },
          }, t("miniapp.bills.markPaid"))
        : h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
            h("div", { style: { fontSize: 12, color: C.sub } }, t("miniapp.bills.confirmPay", { amount: e.amountFormatted })),
            h("button", {
              onClick: markPaid,
              disabled: busy,
              style: {
                background: C.green, color: "#0F0F0F", border: "none", borderRadius: 8,
                padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer",
                fontFamily: "'Inter',sans-serif",
                opacity: busy ? 0.6 : 1,
              },
            }, busy ? "…" : t("miniapp.bills.yesPaid")),
            h("button", {
              onClick: function() { setShowConfirm(false); setErr(null); },
              disabled: busy,
              style: {
                background: "transparent", color: C.sub, border: "1px solid " + C.border, borderRadius: 8,
                padding: "6px 12px", fontSize: 12, cursor: "pointer", fontFamily: "'Inter',sans-serif",
              },
            }, t("miniapp.bills.cancel"))
          ),
      err ? h("div", { style: { fontSize: 11, color: C.red, marginTop: 6 } }, err) : null
    ) : null
  );
}

function BudgetCard(props) {
  var e = props.env;
  var sym = props.sym;
  var amt = e.amountCents || 0;
  var spent = e.spentCents || 0;
  var pct = amt > 0 ? Math.min(100, Math.round((spent / amt) * 100)) : 0;
  var col = pct >= 100 ? C.red : pct >= 80 ? C.amber : C.green;
  return h("div", {
    style: {
      background: C.card, border: "1px solid " + C.border, borderRadius: 12,
      padding: "12px 14px", marginBottom: 8,
    },
  },
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
      h("div", { style: { fontSize: 14, fontWeight: 500 } }, e.name),
      h("div", { style: { fontFamily: "'Lora',serif", fontSize: 14 } },
        fmtMoney(spent, sym) + " / " + e.amountFormatted)
    ),
    h("div", {
      style: {
        height: 4, background: C.border, borderRadius: 2,
        overflow: "hidden", marginTop: 8,
      },
    },
      h("div", {
        style: {
          height: "100%", width: pct + "%", background: col,
          transition: "width 0.4s ease",
        },
      })
    ),
    h("div", { style: { fontSize: 10, color: C.muted, marginTop: 4 } }, t("miniapp.budgets.percentUsed", { pct: pct }))
  );
}

function GoalCard(props) {
  var e = props.env;
  var sym = props.sym;
  var target = e.targetCents || e.amountCents || 0;
  var funded = e.fundedCents || 0;
  var pct = target > 0 ? Math.min(100, Math.round((funded / target) * 100)) : 0;
  var col = pct >= 100 ? C.green : C.green;
  var remaining = Math.max(0, target - funded);
  var arrival = arrivalLabel(e.arrivalDate);
  var newGlow = isRecent(e.createdAt) ? "0 0 0 1px " + C.green : "none";

  return h("div", {
    style: {
      background: C.card, border: "1px solid " + C.border, borderRadius: 12,
      padding: "14px 14px", marginBottom: 8,
      boxShadow: newGlow, transition: "box-shadow 0.4s",
    },
  },
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 } },
      h("div", null,
        h("div", { style: { fontSize: 14, fontWeight: 500 } },
          e.name,
          isRecent(e.createdAt) ? h("span", {
            style: { fontSize: 9, color: C.green, marginLeft: 6, padding: "1px 6px", borderRadius: 999, background: C.greenSoft, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" },
          }, t("miniapp.newBadge")) : null
        ),
        h("div", { style: { fontSize: 11, color: C.muted, marginTop: 2 } },
          t("miniapp.goals.ofTarget", { funded: fmtMoney(funded, sym), target: fmtMoney(target, sym) }))
      ),
      h("div", { style: { textAlign: "right" } },
        h("div", { style: { fontFamily: "'Lora',serif", fontSize: 18, color: col, lineHeight: 1 } }, pct + "%"),
        remaining > 0
          ? h("div", { style: { fontSize: 10, color: C.muted, marginTop: 4 } }, t("miniapp.goals.toGo", { amount: fmtMoney(remaining, sym) }))
          : h("div", { style: { fontSize: 10, color: C.green, marginTop: 4, fontWeight: 600 } }, t("miniapp.goals.reached"))
      )
    ),
    h("div", {
      style: {
        height: 6, background: C.border, borderRadius: 3,
        overflow: "hidden",
      },
    },
      h("div", {
        style: {
          height: "100%", width: pct + "%", background: col,
          transition: "width 0.4s ease",
          boxShadow: pct >= 100 ? "0 0 8px " + C.green : "none",
        },
      })
    ),
    // Arrival estimate — only when there's funding history AND target not yet hit.
    arrival && remaining > 0
      ? h("div", { style: { fontSize: 10, color: C.muted, marginTop: 8, textAlign: "right" } },
          t("miniapp.goals.arrival", { date: arrival, rate: e.monthlyFundingFormatted || "—" }))
      : (remaining > 0 && !arrival
          ? h("div", { style: { fontSize: 10, color: C.muted, marginTop: 8, textAlign: "right" } },
              t("miniapp.goals.fundToProject"))
          : null)
  );
}

// ── HISTORY (collapsed; chip filters) ───────────────────────
function History(props) {
  var openState = useState(false);
  var open = openState[0], setOpen = openState[1];
  var filterState = useState("all");
  var filter = filterState[0], setFilter = filterState[1];
  var nameMap = props.nameMap || {};

  var allTxs = (props.txs || []).filter(function(tx) {
    return tx.kind === "spend" || tx.kind === "refund" || tx.kind === "bill_payment";
  });

  // Filter chips
  var today = props.today;
  function applyFilter(txs) {
    if (filter === "all") return txs;
    if (filter === "week") {
      var wkAgo = props.dateMinusN ? props.dateMinusN(today, 6) : today;
      return txs.filter(function(tx) { return tx.date >= wkAgo; });
    }
    if (filter === "month") return txs.filter(function(tx) { return tx.date.startsWith(today.slice(0, 7)); });
    if (filter === "big") return txs.filter(function(tx) { return Math.abs(tx.amountCents) >= 50_00; });
    return txs;
  }

  var filtered = applyFilter(allTxs);

  // Group by date
  var groups = [];
  var byDate = {};
  filtered.forEach(function(tx) {
    if (!byDate[tx.date]) { byDate[tx.date] = []; groups.push(tx.date); }
    byDate[tx.date].push(tx);
  });

  return h("div", { style: { padding: "20px 16px 0" } },
    !open
      ? h("button", {
          onClick: function() { setOpen(true); },
          style: {
            width: "100%", background: C.card, border: "1px solid " + C.border,
            borderRadius: 12, padding: "12px", cursor: "pointer",
            fontSize: 13, color: C.text, fontFamily: "'Inter',sans-serif",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          },
        }, h("span", { style: { fontSize: 14 } }, "📜"), t("miniapp.history.viewHistory", { count: allTxs.length }))
      : h("div", null,
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 } },
            h("div", { style: { fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 } }, t("miniapp.history.title")),
            h("div", {
              onClick: function() { setOpen(false); },
              style: { fontSize: 11, color: C.sub, cursor: "pointer", padding: "2px 8px" },
            }, t("miniapp.history.close"))
          ),
          // Chips
          h("div", { style: { display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" } },
            ["all", "week", "month", "big"].map(function(c) {
              var on = c === filter;
              return h("div", {
                key: c, onClick: function() { setFilter(c); },
                style: {
                  padding: "5px 12px", borderRadius: 999, fontSize: 11,
                  background: on ? C.text : C.card, color: on ? "#0F0F0F" : C.sub,
                  border: "1px solid " + (on ? C.text : C.border),
                  fontWeight: on ? 600 : 500, cursor: "pointer",
                  textTransform: "capitalize",
                },
              }, c === "big" ? "50+" : t("miniapp.history.chip." + c));
            })
          ),
          // Groups
          filtered.length === 0
            ? h("div", { style: { textAlign: "center", padding: "24px 0", color: C.muted, fontSize: 12 } }, t("miniapp.history.empty"))
            : groups.map(function(date) {
                return h("div", { key: date, style: { marginBottom: 14 } },
                  h("div", { style: { fontSize: 11, color: C.muted, marginBottom: 4 } },
                    relativeDay(date, today) + (date === today ? "" : " · " + date)),
                  h("div", { style: { background: C.card, border: "1px solid " + C.border, borderRadius: 10, overflow: "hidden" } },
                    byDate[date].map(function(tx, i) {
                      var lbl = txLabel(tx, nameMap);
                      return h("div", {
                        key: tx.id,
                        style: {
                          display: "flex", justifyContent: "space-between", padding: "10px 12px",
                          fontSize: 12, borderTop: i === 0 ? "none" : "1px solid " + C.border, alignItems: "center",
                        },
                      },
                        h("div", { style: { flex: 1, overflow: "hidden", marginRight: 8 } },
                          h("div", { style: { color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                            lbl.primary,
                            tx.kind === "bill_payment" ? billChip() : null
                          ),
                          lbl.secondary ? h("div", { style: { color: C.muted, fontSize: 10, marginTop: 1 } }, lbl.secondary) : null
                        ),
                        h("div", { style: { fontFamily: "'Lora',serif", color: tx.kind === "refund" ? C.green : C.text } },
                          (tx.kind === "refund" ? "+" : "") + fmtMoney(Math.abs(tx.amountCents), props.sym))
                      );
                    })
                  )
                );
              })
        )
  );
}

// ── ERROR / EMPTY STATES ────────────────────────────────────
function Skeleton() {
  var sh = {
    background: "linear-gradient(90deg," + C.card + " 25%," + C.border + " 50%," + C.card + " 75%)",
    backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite", borderRadius: 12,
  };
  return h("div", { style: { padding: 20 } },
    h("style", null,
      "@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } } " +
      "@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } } " +
      "@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } } " +
      "@keyframes fabIn { 0% { opacity: 0; transform: translateY(20px) scale(0.5); } 60% { opacity: 1; } 100% { opacity: 1; transform: translateY(0) scale(1); } } " +
      "@keyframes tabIn { 0% { opacity: 0; transform: scale(0.985); } 100% { opacity: 1; transform: scale(1); } } " +
      "@keyframes modalIn { 0% { opacity: 0; transform: translateY(40px); } 100% { opacity: 1; transform: translateY(0); } } " +
      "@keyframes pressCompress { 0% { transform: scale(1); } 50% { transform: scale(0.94); } 100% { transform: scale(1); } }"
    ),
    h("div", { style: Object.assign({}, sh, { width: 80, height: 22, margin: "20px auto", borderRadius: 999 }) }),
    h("div", { style: Object.assign({}, sh, { width: "60%", height: 56, margin: "0 auto 8px" }) }),
    h("div", { style: Object.assign({}, sh, { width: "40%", height: 14, margin: "0 auto 24px" }) }),
    h("div", { style: Object.assign({}, sh, { height: 60, marginBottom: 16 }) }),
    h("div", { style: Object.assign({}, sh, { height: 100, marginBottom: 12 }) }),
    h("div", { style: Object.assign({}, sh, { height: 70, marginBottom: 8 }) }),
    h("div", { style: Object.assign({}, sh, { height: 70, marginBottom: 8 }) })
  );
}

function statusLabel(s) {
  return ({
    "ok": "Authenticated", "no-init-data": "No Telegram session",
    "bad-signature": "Server token mismatch", "stale": "Session expired",
    "no-bot-token": "Bot not configured", "malformed": "Malformed session",
    "parse-error": "Couldn't read session",
  })[s] || (s || "Unknown");
}

function ErrorState(props) {
  var diagState = useState(null);
  var diag = diagState[0], setDiag = diagState[1];
  var loadState = useState(false);
  var loadingDiag = loadState[0], setLoadingDiag = loadState[1];

  function fetchDiag() {
    setLoadingDiag(true);
    fetch(API_BASE + "/api/v4/whoami", { headers: authHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(d) { setDiag(d); })
      .catch(function(e) { setDiag({ status: "network", hint: e.message }); })
      .then(function() { setLoadingDiag(false); });
  }

  var isAuthIssue = /telegram|identity/i.test(props.errMsg || "");
  return h("div", {
    style: {
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      flex: 1, padding: "48px 24px", minHeight: "70vh",
    },
  },
    h("div", { style: { fontSize: 32, marginBottom: 16 } }, "·  ·"),
    h("div", { style: { fontFamily: "'Lora',serif", fontSize: 22, fontWeight: 500, textAlign: "center", marginBottom: 10 } },
      t(isAuthIssue ? "miniapp.error.cantSeeTitle" : "miniapp.error.couldntLoadTitle")),
    h("div", { style: { color: C.sub, fontSize: 14, lineHeight: 1.5, textAlign: "center", maxWidth: 300, marginBottom: 24 } },
      t(isAuthIssue ? "miniapp.error.cantSeeBody" : "miniapp.error.couldntLoadBody")),
    h("button", {
      onClick: props.onRetry,
      style: {
        background: C.green, color: "#0F0F0F", border: "none", borderRadius: 10,
        padding: "12px 28px", fontSize: 14, fontWeight: 600, cursor: "pointer",
        fontFamily: "'Inter',sans-serif",
      },
    }, t("miniapp.error.tryAgain")),
    !diag && !loadingDiag
      ? h("div", { onClick: fetchDiag, style: { marginTop: 28, color: C.muted, fontSize: 12, cursor: "pointer", borderBottom: "1px dotted " + C.muted } }, t("miniapp.error.diagnostics"))
      : null,
    loadingDiag ? h("div", { style: { marginTop: 28, color: C.muted, fontSize: 12 } }, t("miniapp.error.checking")) : null,
    diag ? h("div", { style: { marginTop: 24, padding: "14px 16px", maxWidth: 320, width: "100%", background: C.card, border: "1px solid " + C.border, borderRadius: 12, fontSize: 12, lineHeight: 1.5 } },
      h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
        h("div", { style: { width: 8, height: 8, borderRadius: "50%", background: diag.status === "ok" ? C.green : (diag.status === "stale" ? C.amber : C.red) } }),
        h("div", { style: { fontWeight: 600 } }, statusLabel(diag.status))
      ),
      diag.hint ? h("div", { style: { color: C.sub } }, diag.hint) : null,
      diag.user ? h("div", { style: { color: C.muted, fontSize: 11, marginTop: 8 } }, "Signed in as " + (diag.user.first_name || "user") + " · id " + diag.user.id) : null
    ) : null
  );
}

function NotSetUpState() {
  return h("div", {
    style: {
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      flex: 1, padding: "48px 24px", minHeight: "70vh",
    },
  },
    h("div", {
      style: {
        width: 72, height: 72, borderRadius: "50%", background: C.card,
        border: "1px solid " + C.border, display: "flex", alignItems: "center",
        justifyContent: "center", marginBottom: 22, fontSize: 32,
      },
    }, "👋"),
    h("div", { style: { fontFamily: "'Lora',serif", fontSize: 24, fontWeight: 500, marginBottom: 10, textAlign: "center" } }, t("miniapp.notSetUp.title")),
    h("div", { style: { color: C.sub, fontSize: 14, lineHeight: 1.55, textAlign: "center", maxWidth: 280 } }, t("miniapp.notSetUp.body"))
  );
}

// ── DASHBOARD ────────────────────────────────────────────────
// ── DASHBOARD — tab-based navigation ──
// Three focused screens, each answers ONE question:
//   TODAY  → "Am I OK right now?"     (Hero + TodayStrip + mini heatmap)
//   PULSE  → "Where is my money going?" (aggregations by bucket + vendor)
//   BILLS  → "What's coming up?"      (bills + goals)
//
// Each screen fits within a viewport without scroll for the primary
// info. Scrolling reveals MORE detail (history, expanded heatmap)
// but the critical numbers are above the fold.
//
// Bottom tab bar persists; FAB persists; transition between tabs has
// spring physics (cross-fade + tiny scale) — premium feel without
// jarring slide.
function Dashboard(props) {
  var v = props.view;
  var sym = v.currencySymbol || "$";
  var txs = props.txs || [];
  var heatmap = props.heatmap || [];
  var today = (heatmap.length ? heatmap[heatmap.length - 1].date : "");

  var envs = v.envelopes || [];
  var bills = envs.filter(function(e) { return e.kind === "bill"; });
  var budgets = envs.filter(function(e) { return e.kind === "budget"; });
  var goals = envs.filter(function(e) { return e.kind === "goal"; });
  var nameMap = buildNameMap(envs);

  bills.sort(function(a, b) {
    var da = a.daysUntilDue == null ? 9999 : a.daysUntilDue;
    var db = b.daysUntilDue == null ? 9999 : b.daysUntilDue;
    return da - db;
  });

  function dateMinusN(d, n) {
    var dt = new Date(d + "T00:00:00Z");
    dt.setUTCDate(dt.getUTCDate() - n);
    return dt.toISOString().slice(0, 10);
  }

  // Tab state lives at this level so FAB + TabBar can persist across renders.
  var tabState = useState("today");
  var tab = tabState[0], setTab = tabState[1];

  // Each screen is its own component so re-renders stay scoped.
  var content;
  if (tab === "today") {
    content = h(TodayScreen, {
      view: v, txs: txs, heatmap: heatmap, today: today,
      bills: bills, nameMap: nameMap, sym: sym, sid: props.sid,
      onViewUpdate: props.onViewUpdate, dateMinusN: dateMinusN,
    });
  } else if (tab === "pulse") {
    content = h(PulseScreen, {
      view: v, txs: txs, today: today, nameMap: nameMap, sym: sym,
    });
  } else {
    content = h(BillsScreen, {
      view: v, bills: bills, budgets: budgets, goals: goals,
      sym: sym, sid: props.sid, onViewUpdate: props.onViewUpdate,
    });
  }

  return h("div", null,
    // Animated content area — fade + tiny scale on tab change via key change.
    h("div", {
      key: tab, // forces remount → CSS animation triggers
      style: { paddingBottom: 78, animation: "tabIn 280ms cubic-bezier(0.34, 1.56, 0.64, 1)" },
    }, content),
    h(TabBar, { active: tab, onChange: setTab })
  );
}

// ── TODAY SCREEN ──
// Compact "am I OK?" view. Hero + TodayStrip + mini heatmap + a peek
// at upcoming bills (if any) + recent activity. NO long history feed
// (that's accessible via "View all" → modal). Primary info above
// fold; scrolling reveals detail.
function TodayScreen(props) {
  var v = props.view, txs = props.txs, heatmap = props.heatmap, today = props.today;
  var bills = props.bills || [];
  var nameMap = props.nameMap, sym = props.sym, sid = props.sid;
  var selectedDayState = useState(null);
  var selectedDay = selectedDayState[0], setSelectedDay = selectedDayState[1];
  function handleSelectDay(d) { tapHaptic(); setSelectedDay(selectedDay === d ? null : d); }

  // Bills due in next 7 days — quiet warning chip.
  var soonBills = bills.filter(function(b) {
    return !b.paidThisCycle && b.daysUntilDue != null && b.daysUntilDue >= 0 && b.daysUntilDue <= 7;
  });

  return h("div", null,
    h(Hero, { view: v, sid: sid }),
    h(FirstTimeCard, null),
    h(TodayStrip, { view: v, txs: txs, today: today, nameMap: nameMap }),
    h(Heatmap, {
      heatmap: heatmap, dailyPaceCents: v.dailyPaceCents, sym: sym,
      txs: txs, nameMap: nameMap,
      selectedDay: selectedDay, onSelectDay: handleSelectDay,
    }),
    selectedDay
      ? h(DayDetailCard, { date: selectedDay, txs: txs, sym: sym, nameMap: nameMap, today: today })
      : null,
    // Inline peek at upcoming bills — only when something's coming up
    // soon. Full bill management lives in the Bills tab.
    soonBills.length > 0 ? h("div", { style: { padding: "16px 16px 0" } },
      h(DueBanner, { envelopes: soonBills, sym: sym })
    ) : null,
    h("div", {
      style: { textAlign: "center", padding: "28px 16px 32px", color: C.muted, fontSize: 11 },
    }, t("miniapp.footer"))
  );
}

// ── PULSE SCREEN ──
// "Where is my money going?" — aggregated answers, no typing.
// Top categories (6 buckets), top vendors, week-over-week deltas.
// Time-scope toggle at the top: Week / Month / Cycle.
function PulseScreen(props) {
  var v = props.view, txs = props.txs || [], today = props.today;
  var sym = props.sym;

  // Scope toggle — defaults to "month" (most useful at a glance).
  var scopeState = useState("month");
  var scope = scopeState[0], setScope = scopeState[1];

  function dateMinusN(d, n) {
    var dt = new Date(d + "T00:00:00Z");
    dt.setUTCDate(dt.getUTCDate() - n);
    return dt.toISOString().slice(0, 10);
  }

  function scopeStart() {
    if (scope === "week") return dateMinusN(today, 6);
    if (scope === "month") return today.slice(0, 7) + "-01";
    // cycle: from earliest cycle event ≈ payday backwards. For simplicity
    // use 30 days back (typical cycle).
    return dateMinusN(today, 30);
  }
  var since = scopeStart();
  var label = scope === "week" ? "This week" : scope === "month" ? "This month" : "This cycle";

  // Filter txs to scope window. Only count discretionary `spend` and
  // refunds (which subtract). Bill payments are obligation money,
  // already reserved — excluded from spending aggregation here.
  var spendTxs = txs.filter(function(tx) {
    if (tx.kind !== "spend" && tx.kind !== "refund") return false;
    return tx.date >= since;
  });

  // ── Totals ──
  var totalCents = spendTxs.reduce(function(a, tx) {
    if (tx.kind === "spend") return a + Math.abs(tx.amountCents);
    if (tx.kind === "refund") return a - Math.abs(tx.amountCents);
    return a;
  }, 0);
  var count = spendTxs.filter(function(tx) { return tx.kind === "spend"; }).length;

  // ── Buckets ──
  // Aggregate by category using the new 6-bucket vocab. Map legacy
  // categories on the fly so historical data joins the new buckets.
  var legacyMap = {
    coffee: "food", groceries: "food", restaurant: "food",
    delivery: "food", alcohol: "food",
    subscription: "subscriptions", streaming: "subscriptions",
    clothing: "personal", health: "personal", entertainment: "personal",
    travel: "personal",
  };
  var byBucket = { food: 0, transport: 0, home: 0, subscriptions: 0, personal: 0, other: 0 };
  spendTxs.forEach(function(tx) {
    if (tx.kind !== "spend") return;
    var c = (tx.category || "other").toLowerCase();
    c = legacyMap[c] || c;
    if (!(c in byBucket)) c = "other";
    byBucket[c] += Math.abs(tx.amountCents);
  });
  var bucketRows = Object.keys(byBucket)
    .map(function(name) { return { name: name, cents: byBucket[name] }; })
    .filter(function(r) { return r.cents > 0; })
    .sort(function(a, b) { return b.cents - a.cents; });

  // ── Top vendors ──
  var byVendor = {};
  spendTxs.forEach(function(tx) {
    if (tx.kind !== "spend" || !tx.vendor) return;
    if (!byVendor[tx.vendor]) byVendor[tx.vendor] = { name: tx.vendor, cents: 0, count: 0 };
    byVendor[tx.vendor].cents += Math.abs(tx.amountCents);
    byVendor[tx.vendor].count++;
  });
  var topVendors = Object.values(byVendor)
    .sort(function(a, b) { return b.cents - a.cents; })
    .slice(0, 6);

  // Header style helper
  function header(text) {
    return h("div", { style: { fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 10 } }, text);
  }

  var maxBucket = bucketRows.length ? bucketRows[0].cents : 1;
  var maxVendor = topVendors.length ? topVendors[0].cents : 1;

  return h("div", { style: { paddingTop: 22 } },
    // Title + scope toggle
    h("div", { style: { padding: "0 16px 16px" } },
      h("div", { style: { fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 12 } }, "Pulse"),
      h("div", { style: { display: "flex", gap: 6, marginBottom: 16 } },
        ["week", "month", "cycle"].map(function(s) {
          var on = s === scope;
          return h("div", {
            key: s, onClick: function() { tapHaptic(); setScope(s); },
            style: {
              flex: 1, textAlign: "center",
              padding: "8px 0", borderRadius: 8, fontSize: 12,
              background: on ? C.text : C.card, color: on ? "#0F0F0F" : C.sub,
              border: "1px solid " + (on ? C.text : C.border),
              fontWeight: on ? 600 : 500, cursor: "pointer",
              textTransform: "capitalize",
              transition: "background 180ms ease, color 180ms ease",
            },
          }, s);
        })
      ),
      // Summary line
      h("div", { style: { fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 } }, label),
      h("div", { style: { fontFamily: "'Lora',serif", fontSize: 36, marginTop: 6, color: C.text } }, fmtMoney(totalCents, sym)),
      h("div", { style: { fontSize: 12, color: C.muted, marginTop: 4 } },
        count + " spend" + (count === 1 ? "" : "s")
      )
    ),
    // ── Buckets ──
    h("div", { style: { padding: "8px 16px 16px" } },
      header("Buckets"),
      bucketRows.length === 0
        ? h("div", { style: { fontSize: 12, color: C.muted, padding: "8px 0" } }, "No spending yet in this window.")
        : bucketRows.map(function(r) {
            var pct = totalCents > 0 ? Math.round((r.cents / totalCents) * 100) : 0;
            var barW = Math.max(2, Math.round((r.cents / maxBucket) * 100));
            return h("div", {
              key: r.name,
              style: { padding: "10px 0", borderTop: "1px solid " + C.border },
            },
              h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
                h("div", { style: { fontSize: 13, color: C.text, textTransform: "capitalize" } }, r.name),
                h("div", { style: { fontFamily: "'Lora',serif", fontSize: 14, color: C.text } },
                  fmtMoney(r.cents, sym),
                  h("span", { style: { fontSize: 10, color: C.muted, marginLeft: 6 } }, "(" + pct + "%)")
                )
              ),
              h("div", { style: { height: 4, background: C.border, borderRadius: 2, marginTop: 6, overflow: "hidden" } },
                h("div", {
                  style: {
                    height: "100%", width: barW + "%", background: C.text,
                    transition: "width 600ms cubic-bezier(0.34, 1.56, 0.64, 1)",
                  },
                })
              )
            );
          })
    ),
    // ── Top vendors ──
    topVendors.length > 0 ? h("div", { style: { padding: "16px 16px" } },
      header("Top vendors"),
      topVendors.map(function(v) {
        var barW = Math.max(2, Math.round((v.cents / maxVendor) * 100));
        return h("div", {
          key: v.name,
          style: { padding: "10px 0", borderTop: "1px solid " + C.border },
        },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
            h("div", null,
              h("div", { style: { fontSize: 13, color: C.text } }, v.name),
              h("div", { style: { fontSize: 10, color: C.muted, marginTop: 2 } }, v.count + " visit" + (v.count === 1 ? "" : "s"))
            ),
            h("div", { style: { fontFamily: "'Lora',serif", fontSize: 14, color: C.text } }, fmtMoney(v.cents, sym))
          ),
          h("div", { style: { height: 4, background: C.border, borderRadius: 2, marginTop: 6, overflow: "hidden" } },
            h("div", {
              style: {
                height: "100%", width: barW + "%", background: C.text,
                transition: "width 600ms cubic-bezier(0.34, 1.56, 0.64, 1)",
              },
            })
          )
        );
      })
    ) : null,
    // Hint — bottom of Pulse, gently surfaces chat Q&A as a complement.
    h("div", {
      style: {
        margin: "20px 16px 28px", padding: "14px",
        background: C.card, border: "1px dashed " + C.border, borderRadius: 12,
        fontSize: 12, color: C.muted, textAlign: "center", lineHeight: 1.5,
      },
    }, "Ask me anything in chat — \"how much on coffee last month?\" or \"my top spot?\"")
  );
}

// ── BILLS SCREEN ──
// AAA lifecycle layout: three sections matching the three mental
// phases of every commitment (unpaid one-time, recurring, paid).
// Each bill card has a Mark Paid action so the lifecycle is tappable.
//   1. UNPAID THIS CYCLE — one-time set-asides not yet paid. Most
//      action-needed. Sorted by due-date ascending (most urgent first).
//   2. RECURRING — monthly/weekly/biweekly bills. Each can be marked
//      paid for the current cycle (engine auto-advances dueDate).
//   3. PAID THIS CYCLE — done. Collapsed-style, no action button.
// ── BILLS HERO ─────────────────────────────────────────────
// AAA visual anchor at the top of the Bills tab — matches the Today
// tab's hero weight (big serif + label + sub-line). Shows the
// bills-level summary so the user has a single number to glance at:
// "how much is locked up this cycle?"
//
// Layout:
//   $187                       ← BIG (sum of unpaid this cycle = obligated)
//   reserved this cycle        ← small label
//   $340 paid · $130 next cycle    ← sub-line (conditional bits)
//
// When everything's clear (no bills active): hidden — empty state
// component handles the "no bills" case.
function BillsHero(props) {
  var v = props.view;
  var sym = props.sym || "$";
  var bills = props.bills || [];

  // Aggregate from the envelope list (already enriched server-side).
  var unpaidThisCycle = 0;
  var paidThisCycle = 0;
  var nextCycle = 0;
  for (var i = 0; i < bills.length; i++) {
    var b = bills[i];
    if (b.paidThisCycle) {
      paidThisCycle += b.amountCents || 0;
    } else if (b.cycleStatus === "next") {
      nextCycle += b.amountCents || 0;
    } else {
      unpaidThisCycle += b.amountCents || 0;
    }
  }
  // If nothing exists, return null (empty state renders elsewhere).
  if (unpaidThisCycle === 0 && paidThisCycle === 0 && nextCycle === 0) return null;

  var bigAmount = fmtMoney(unpaidThisCycle, sym);
  // Sub-line: paid + next-cycle pieces, joined by " · ". Skip pieces
  // that are zero so the line doesn't say "$0 paid · $0 next cycle".
  var subPieces = [];
  if (paidThisCycle > 0) subPieces.push(fmtMoney(paidThisCycle, sym) + " paid");
  if (nextCycle > 0) subPieces.push(fmtMoney(nextCycle, sym) + " next cycle");
  var subLine = subPieces.length > 0 ? subPieces.join(" · ") : "";

  // Label adapts to state. If unpaidThisCycle is 0 but paid > 0,
  // headline is "$0" + "all clear this cycle" — celebratory.
  var label;
  if (unpaidThisCycle === 0 && paidThisCycle > 0) {
    label = "all clear this cycle";
  } else {
    label = "reserved this cycle";
  }

  return h("div", { style: { padding: "32px 20px 18px", textAlign: "center" } },
    h("div", {
      style: {
        fontFamily: "'Lora',serif", fontSize: 60, fontWeight: 500,
        color: C.text, lineHeight: 1.0, letterSpacing: "-0.02em",
      },
    }, bigAmount),
    h("div", { style: { fontSize: 13, color: C.sub, marginTop: 10, letterSpacing: "0.02em" } }, label),
    subLine
      ? h("div", { style: { fontSize: 12, color: C.muted, marginTop: 6 } }, subLine)
      : null
  );
}

function BillsScreen(props) {
  var v = props.view, bills = props.bills || [], budgets = props.budgets || [], goals = props.goals || [];
  var sym = props.sym, sid = props.sid;

  // Four buckets — savings goals get their own section.
  // The kind:"savings" flag on a bill means user is reserving for THEMSELVES
  // (trip, emergency fund) vs an obligation to someone else (rent).
  var recurringKinds = { monthly: 1, weekly: 1, biweekly: 1 };
  var isSavings = function(b) { return b && b.kind === "savings"; };
  var savings = bills.filter(isSavings);
  var unpaidOnce = bills.filter(function(b) {
    return !isSavings(b) && !b.paidThisCycle && (!b.recurrence || b.recurrence === "once");
  });
  var recurring = bills.filter(function(b) {
    return !isSavings(b) && recurringKinds[b.recurrence];
  });
  var paidOnce = bills.filter(function(b) {
    return !isSavings(b) && b.paidThisCycle && (!b.recurrence || b.recurrence === "once");
  });
  // Expected incomes — exposed by the view (state.expectedIncomes)
  var expectedIncomes = (v && Array.isArray(v.expectedIncomes)) ? v.expectedIncomes.slice() : [];
  expectedIncomes.sort(function(a, b) {
    return String(a.expectedDate).localeCompare(String(b.expectedDate));
  });

  // Sort within buckets
  unpaidOnce.sort(function(a, b) { return String(a.dueDate).localeCompare(String(b.dueDate)); });
  recurring.sort(function(a, b) {
    return (a.paidThisCycle ? 1 : 0) - (b.paidThisCycle ? 1 : 0)
      || String(a.dueDate).localeCompare(String(b.dueDate));
  });
  paidOnce.sort(function(a, b) { return String(b.dueDate).localeCompare(String(a.dueDate)); });
  savings.sort(function(a, b) {
    return (a.paidThisCycle ? 1 : 0) - (b.paidThisCycle ? 1 : 0)
      || String(a.dueDate).localeCompare(String(b.dueDate));
  });

  return h("div", null,
    // BILLS HERO — matches Today tab visual weight at the top.
    h(BillsHero, { view: v, bills: bills, sym: sym }),
    bills.length === 0 ? h("div", { style: { padding: "24px 16px", textAlign: "center", color: C.muted, fontSize: 13 } },
      "No bills set up. Tell the bot in chat: \"Rent 1400 on the 1st\" — or tap S below to add one."
    ) : null,
    // Coming-up strip (next bills due within 7d) + Due banner (today/overdue)
    bills.length > 0 ? h(AnticipationStrip, { envelopes: bills, sym: sym }) : null,
    bills.length > 0 ? h(DueBanner, { envelopes: bills, sym: sym }) : null,
    // SECTION 1: Unpaid one-time
    unpaidOnce.length > 0 ? h("div", null,
      h(SectionHeader, {
        icon: "⏳",
        title: "Unpaid this cycle",
        count: unpaidOnce.length,
        subtitle: (function() {
          var total = unpaidOnce.reduce(function(acc, b) { return acc + (b.amountCents || 0); }, 0);
          return total > 0 ? "Reserved: " + (sym + (total / 100).toFixed(0)) : null;
        })(),
      }),
      h("div", { style: { padding: "0 16px" } },
        unpaidOnce.map(function(e) {
          return h(BillCard, { key: e.key, env: e, sym: sym, sid: sid, onPaid: props.onViewUpdate });
        }))
    ) : null,
    // SECTION 2: Recurring
    recurring.length > 0 ? h("div", null,
      h(SectionHeader, {
        icon: "🔁",
        title: "Recurring",
        count: recurring.length,
        subtitle: (function() {
          var unpaid = recurring.filter(function(b) { return !b.paidThisCycle; });
          return unpaid.length > 0
            ? unpaid.length + " unpaid this cycle"
            : "All paid this cycle ✓";
        })(),
      }),
      h("div", { style: { padding: "0 16px" } },
        recurring.map(function(e) {
          return h(BillCard, { key: e.key, env: e, sym: sym, sid: sid, onPaid: props.onViewUpdate });
        }))
    ) : null,
    // SECTION: Saving for (self-reservations, kind:"savings")
    savings.length > 0 ? h("div", null,
      h(SectionHeader, {
        icon: "🎯",
        title: "Saving for",
        count: savings.length,
        subtitle: (function() {
          var total = savings.reduce(function(acc, b) {
            return acc + (b.paidThisCycle ? 0 : (b.amountCents || 0));
          }, 0);
          return total > 0 ? "Set aside: " + sym + (total / 100).toFixed(0) : null;
        })(),
      }),
      h("div", { style: { padding: "0 16px" } },
        savings.map(function(e) {
          return h(BillCard, { key: e.key, env: e, sym: sym, sid: sid, onPaid: props.onViewUpdate });
        }))
    ) : null,
    // SECTION: Expected income (scheduled future inflow)
    expectedIncomes.length > 0 ? h("div", null,
      h(SectionHeader, {
        icon: "💰",
        title: "Expected income",
        count: expectedIncomes.length,
        subtitle: (function() {
          var total = expectedIncomes.reduce(function(acc, ei) { return acc + (ei.amountCents || 0); }, 0);
          return total > 0 ? "Coming: " + sym + (total / 100).toFixed(0) : null;
        })(),
      }),
      h("div", { style: { padding: "0 16px" } },
        expectedIncomes.map(function(ei) {
          // Inline card — simpler than BillCard, no mark-paid (those are
          // handled when the income actually lands via chat "got paid X").
          var daysLabel = ei.daysUntilExpected != null
            ? (ei.daysUntilExpected === 0 ? "today"
               : ei.daysUntilExpected === 1 ? "tomorrow"
               : ei.daysUntilExpected < 0 ? "overdue " + Math.abs(ei.daysUntilExpected) + "d"
               : "in " + ei.daysUntilExpected + "d")
            : "";
          return h("div", {
            key: ei.id,
            style: {
              background: C.card, border: "1px solid " + C.border, borderRadius: 12,
              padding: "12px 14px", marginBottom: 8,
              display: "flex", justifyContent: "space-between", alignItems: "center",
            },
          },
            h("div", null,
              h("div", { style: { fontSize: 14, fontWeight: 500 } }, ei.name),
              h("div", { style: { fontSize: 11, color: C.muted, marginTop: 3 } },
                daysLabel + (ei.recurrence && ei.recurrence !== "once" ? " · " + ei.recurrence : ""))
            ),
            h("div", { style: { fontFamily: "'Lora',serif", fontSize: 16, color: C.green } },
              "+" + ei.amountFormatted)
          );
        }))
    ) : null,
    // SECTION 3: Paid (one-time only — recurring "paid" just sits in section 2 with a checkmark)
    paidOnce.length > 0 ? h("div", null,
      h(SectionHeader, {
        icon: "✓",
        title: "Paid this cycle",
        count: paidOnce.length,
      }),
      h("div", { style: { padding: "0 16px", opacity: 0.65 } },
        paidOnce.map(function(e) {
          return h(BillCard, { key: e.key, env: e, sym: sym, sid: sid, onPaid: props.onViewUpdate });
        }))
    ) : null,
    budgets.length > 0 ? h("div", null,
      h(SectionHeader, { icon: "📊", title: t("miniapp.budgets.label"), count: budgets.length }),
      h("div", { style: { padding: "0 16px" } },
        budgets.map(function(e) { return h(BudgetCard, { key: e.key, env: e, sym: sym }); }))
    ) : null,
    goals.length > 0 ? h("div", null,
      h(SectionHeader, { icon: "🎯", title: t("miniapp.goals.label"), count: goals.length }),
      h("div", { style: { padding: "0 16px" } },
        goals.map(function(e) { return h(GoalCard, { key: e.key, env: e, sym: sym }); }))
    ) : null,
    h("div", { style: { paddingBottom: 32 } })
  );
}

// ── TAB BAR ──
// Bottom-pinned, 3 tabs. Premium feel: subtle backdrop blur, gentle
// spring on tab change. Tabs are large tap targets, thumb-reachable.
function TabBar(props) {
  var active = props.active, onChange = props.onChange;
  var tabs = [
    { id: "today", label: "Today", icon: "●" },
    { id: "pulse", label: "Pulse", icon: "◐" },
    { id: "bills", label: "Bills", icon: "◇" },
  ];
  return h("div", {
    style: {
      position: "fixed", bottom: 0, left: 0, right: 0,
      background: "rgba(15,15,15,0.92)",
      backdropFilter: "blur(12px)",
      WebkitBackdropFilter: "blur(12px)",
      borderTop: "1px solid " + C.border,
      display: "flex", justifyContent: "space-around",
      padding: "8px 0 16px",
      zIndex: 50,
    },
  },
    tabs.map(function(tab) {
      var on = tab.id === active;
      return h("div", {
        key: tab.id,
        onClick: function() { if (!on) { tapHaptic(); onChange(tab.id); } },
        style: {
          flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
          padding: "6px 0", cursor: "pointer",
          color: on ? C.text : C.muted,
          transition: "color 180ms ease",
        },
      },
        h("div", {
          style: {
            fontSize: 16, marginBottom: 4,
            transform: on ? "scale(1.1)" : "scale(1)",
            transition: "transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1)",
          },
        }, tab.icon),
        h("div", { style: { fontSize: 10, letterSpacing: "0.06em", fontWeight: on ? 600 : 500 } }, tab.label)
      );
    })
  );
}

// ── APP ──────────────────────────────────────────────────────
function App() {
  var dataState = useState(null);
  var data = dataState[0], setData = dataState[1];
  var loadingState = useState(true);
  var loading = loadingState[0], setLoading = loadingState[1];
  var errorState = useState(false);
  var error = errorState[0], setError = errorState[1];
  var lastErrState = useState("");
  var lastErr = lastErrState[0], setLastErr = lastErrState[1];

  var sid = useRef(null);

  var loadView = useCallback(function() {
    if (!sid.current) return;
    setError(false);
    fetch(API_BASE + "/api/v4/view/" + sid.current, { headers: authHeaders() })
      .then(function(r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function(d) {
        var v = d.view || { setup: false };
        // Load matching locale before showing the dashboard for the first
        // time. On subsequent refreshes the locale is already cached.
        //
        // CRITICAL: loadLocale is async (fetches a JSON file). Previously
        // we kicked it off and returned synchronously, then the terminal
        // .then() set loading=false BEFORE setData fired — opening a
        // 50-200ms gap where (loading=false, data=null) caused the
        // NotSetUpState screen to flash. Fix: wrap loadLocale in a
        // Promise so the chain WAITS for setData before the terminal
        // .then() runs.
        var lang = (v && v.language) || "en";
        return new Promise(function(resolve) {
          loadLocale(lang, function() {
            setData({
              view: v,
              txs: d.recentTransactions || [],
              heatmap: d.heatmap || [],
            });
            setError(false);
            resolve();
          });
        });
      })
      .catch(function(e) {
        setLastErr(e.message);
        setError(true);
      })
      .then(function() { setLoading(false); });
  }, []);

  useEffect(function() {
    var attempts = 0;
    function tryStart() {
      var tid = window.TELEGRAM_USER_ID;
      var hasInit = !!window.TG_INIT_DATA;
      if ((!tid || tid === "dev") && typeof window.refreshTgIdentity === "function") {
        var snap = window.refreshTgIdentity();
        tid = snap.id || tid;
        hasInit = !!snap.initData;
      }
      if (tid && tid !== "dev") {
        sid.current = "tg_" + tid;
        loadView();
        return;
      }
      attempts++;
      if (attempts < 6) { setTimeout(tryStart, 250); return; }
      setLastErr("No Telegram identity available.");
      setLoading(false); setError(true);
    }
    tryStart();
  }, []);

  // Refresh on visibility change (when user comes back to app after chatting).
  useEffect(function() {
    function onVis() { if (!document.hidden && sid.current) loadView(); }
    document.addEventListener("visibilitychange", onVis);
    return function() { document.removeEventListener("visibilitychange", onVis); };
  }, [loadView]);

  // Render branches, ordered most-specific to most-general.
  //
  // The "no data yet" check is independent of the `loading` flag —
  // even if loading flipped to false for any reason (race, async ordering,
  // future code path), as long as data hasn't arrived we treat it as
  // still loading. This is the AAA defensive layer that closes the
  // "NotSetUpState flashes before Dashboard" bug at the render level,
  // independent of the loadView ordering fix above. Belt + suspenders.
  var content;
  if (!data && !error) content = h(Skeleton, null);
  else if (!data && error) content = h(ErrorState, { onRetry: loadView, errMsg: lastErr });
  else if (!data.view || !data.view.setup) content = h(NotSetUpState, null);
  else content = h(Dashboard, {
    view: data.view, txs: data.txs, heatmap: data.heatmap, sid: sid.current,
    // After a successful Mark-Paid action, swap in the fresh view immediately
    // and re-fetch in the background to pick up new transaction list / heatmap.
    onViewUpdate: function(newView) {
      setData({ view: newView, txs: data.txs, heatmap: data.heatmap });
      loadView();
    },
  });

  // FAB visible only when fully set up + dashboard rendered.
  var showFab = data && data.view && data.view.setup;

  // Input modal state — opened by FAB sub-button tap. Holds the chosen
  // input mode (text/voice/photo) and the modal contents drive what's
  // rendered. Text input is fully in-app: types → POST /api/v5/parse
  // → confirm card → POST /api/v5/apply. Voice/photo fall back to
  // the chat (deferred for v1 standalone-prep).
  var inputModeState = useState(null);
  var inputMode = inputModeState[0], setInputMode = inputModeState[1];
  // Pre-filled text — when an action chip is tapped on Today, the
  // modal opens with a starter phrase already typed in (e.g. "spent ").
  // Discoverability without tutorial: chips tell users what's possible.
  var prefillState = useState("");
  var prefill = prefillState[0], setPrefill = prefillState[1];
  // Help overlay state — opened by the ? button top-right.
  var helpOpenState = useState(false);
  var helpOpen = helpOpenState[0], setHelpOpen = helpOpenState[1];

  function openInputWith(text) {
    setPrefill(text || "");
    setInputMode("text");
  }
  function onFabOpen() { openInputWith(""); }

  return h("div", {
    style: {
      display: "flex", flexDirection: "column", minHeight: "100vh",
      background: C.bg, color: C.text, fontFamily: "'Inter',sans-serif", fontSize: 14,
    },
  },
    content,
    // Top-right ? button — opens the help overlay. Only shows once
    // user is set up (no point on the not-set-up screen).
    (data && data.view && data.view.setup) ? h("div", {
      onClick: function() { tapHaptic && tapHaptic(); setHelpOpen(true); },
      style: {
        position: "fixed",
        top: 14, right: 14,
        width: 30, height: 30, borderRadius: "50%",
        background: "rgba(31,31,31,0.85)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        color: C.sub, fontSize: 14, fontWeight: 600,
        display: "flex", alignItems: "center", justifyContent: "center",
        cursor: "pointer", userSelect: "none",
        zIndex: 60,
        border: "1px solid " + C.border,
      },
    }, "?") : null,
    helpOpen ? h(HelpModal, { onClose: function() { setHelpOpen(false); } }) : null,
    showFab ? h(InputFAB, { onOpen: onFabOpen }) : null,
    inputMode === "text" ? h(InputModal, {
      sid: sid.current,
      initialText: prefill,
      onClose: function() { setInputMode(null); setPrefill(""); },
      onApplied: function() { setInputMode(null); setPrefill(""); loadView(); },
    }) : null
  );
}

// ── HELP MODAL ─────────────────────────────────────────────
// In-app help. Same content as the Telegram /help command but rendered
// visually — bigger type, sectioned, icons, scrollable.
//
// Structure (mirrors /help):
//   1. The idea — one paragraph, brand-voiced
//   2. What you can tell me — 5 capability blocks with examples
//   3. What the numbers mean — 4-line glossary
//
// Opens from the ? button top-right. Esc or backdrop tap closes.
function HelpModal(props) {
  useEffect(function() {
    function onKey(e) { if (e.key === "Escape") props.onClose(); }
    document.addEventListener("keydown", onKey);
    return function() { document.removeEventListener("keydown", onKey); };
  }, []);

  function Section(opts) {
    return h("div", { style: { marginBottom: 22 } },
      h("div", {
        style: {
          fontSize: 11, color: C.sub,
          textTransform: "uppercase", letterSpacing: "0.08em",
          fontWeight: 600, marginBottom: 10,
        },
      }, opts.title),
      opts.children
    );
  }
  function Block(opts) {
    return h("div", { style: { marginBottom: 14 } },
      h("div", {
        style: {
          fontSize: 14, fontWeight: 500, color: C.text,
          marginBottom: 6,
          display: "flex", alignItems: "center", gap: 8,
        },
      },
        h("span", { style: { fontSize: 16 } }, opts.icon),
        h("span", null, opts.label)
      ),
      h("div", { style: { fontSize: 12, color: C.muted, lineHeight: 1.6, paddingLeft: 24 } },
        opts.examples.map(function(ex, i) {
          return h("div", { key: i, style: { fontStyle: "italic" } }, "· \"" + ex + "\"");
        })
      )
    );
  }
  function GlossaryRow(opts) {
    return h("div", {
      style: {
        display: "flex", gap: 10,
        padding: "8px 0",
        borderBottom: "1px solid " + C.border,
        fontSize: 12,
      },
    },
      h("div", { style: { color: C.text, fontWeight: 500, minWidth: 110 } }, opts.term),
      h("div", { style: { color: C.muted, lineHeight: 1.5, flex: 1 } }, opts.def)
    );
  }

  return h("div", {
    onClick: function(e) { if (e.target === e.currentTarget) props.onClose(); },
    style: {
      position: "fixed", inset: 0,
      background: "rgba(0,0,0,0.72)",
      zIndex: 1100,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
      animation: "fadeIn 200ms ease",
    },
  },
    h("div", {
      onClick: function(e) { e.stopPropagation(); },
      style: {
        background: "#1a1a1a",
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
        width: "100%", maxWidth: 520,
        maxHeight: "85vh",
        padding: "22px 22px 32px",
        overflowY: "auto",
        boxShadow: "0 -12px 50px rgba(0,0,0,0.6)",
        animation: "modalIn 320ms cubic-bezier(0.34, 1.56, 0.64, 1)",
      },
    },
      // Drag handle
      h("div", {
        style: { width: 38, height: 4, background: "rgba(255,255,255,0.18)", borderRadius: 2, margin: "0 auto 22px" },
      }),
      // The idea (lead)
      h("div", { style: { marginBottom: 24 } },
        h("div", {
          style: {
            fontFamily: "'Lora',serif", fontSize: 28, fontWeight: 500,
            color: C.text, letterSpacing: "-0.01em", marginBottom: 12,
          },
        }, "Spendkitty"),
        h("div", { style: { fontSize: 13, color: C.sub, lineHeight: 1.6 } },
          "I do one thing: every day I tell you ",
          h("strong", { style: { color: C.text } }, "one number — what you can spend today"),
          ". Bills are reserved. Days to payday are counted. ",
          h("span", { style: { color: C.muted } }, "No budgets, no categories, no homework.")
        )
      ),
      // Capabilities
      Section({ title: "What you can tell me", children: h("div", null,
        Block({ icon: "💸", label: "Log a spend", examples: [
          "5 on coffee",
          "$50 dinner at Lighthouse",
          "yesterday I forgot to log $80 groceries",
        ] }),
        Block({ icon: "💰", label: "Income — landed or coming", examples: [
          "got paid",
          "got 3000 paycheck",
          "expecting 4000 from Acme on friday",
        ] }),
        Block({ icon: "🧾", label: "Bills", examples: [
          "rent 1400 due the 1st",
          "phone 80 monthly",
          "move rent to the 15th",
          "paid the rent",
        ] }),
        Block({ icon: "🎯", label: "Save for something", examples: [
          "save 200 for friend's trip by friday",
          "set aside 100/month for emergency fund",
        ] }),
        Block({ icon: "❓", label: "Ask \"can I?\"", examples: [
          "can I afford 200?",
          "if I spend 60 on dinner?",
        ] }),
      ) }),
      // Number glossary
      Section({ title: "What the numbers mean", children: h("div", null,
        GlossaryRow({ term: "To spend today", def: "What's left RIGHT NOW. Drops as you spend." }),
        GlossaryRow({ term: "Daily pace", def: "Your steady allowance per day." }),
        GlossaryRow({ term: "Available", def: "Balance minus reservations for bills." }),
        GlossaryRow({ term: "In account", def: "What's literally in your bank." }),
      ) }),
      // Footer line
      h("div", {
        style: {
          marginTop: 8, padding: "16px 0 0",
          borderTop: "1px solid " + C.border,
          fontSize: 11, color: C.muted,
          fontStyle: "italic", textAlign: "center",
        },
      }, "\"The math is done. You just spend.\""),
      // Close button
      h("button", {
        onClick: props.onClose,
        style: {
          marginTop: 22, width: "100%", padding: "13px",
          background: C.text, border: "none", borderRadius: 10,
          color: "#0F0F0F", fontSize: 13, fontWeight: 600,
          fontFamily: "'Inter',sans-serif", cursor: "pointer",
        },
      }, "Got it")
    )
  );
}

// ── INPUT FAB ──────────────────────────────────────────────
// Premium floating action button — the daily-habit input primitive.
//
// DESIGN PRINCIPLES
//   - SpendYes "S" mark in Lora serif (brand-tied, not generic +)
//   - Free positioning (drag anywhere, drop where released)
//   - Soft green-tinted shadow (alive feel, brand palette)
//   - Press-compress on tap (tactile feedback)
//   - Spring physics on expand (Cheng-Lou-era springy bounce)
//   - Sub-buttons emerge with staggered fab-in animation
//
// Position persists across sessions via localStorage. Drops where
// released (no edge snap — user feels in control). Clamped to viewport
// so it can't disappear off-screen.
//
// Tap-vs-drag: detected via threshold (6px movement = drag, else tap).
// Tap opens InputModal (which sends text directly to bot, no chat
// hop needed). Drag repositions.
// ── INPUT FAB ──────────────────────────────────────────────
// Single-action FAB. Tap → opens the universal input modal.
// No sub-buttons (voice/photo/text are inline icons INSIDE the
// modal). One entry point, one path. Polish = fewer affordances.
//
// Position: fixed bottom-right above the tab bar. No drag, no
// repositioning — every screen has the same hit zone. Predictable
// is calmer than configurable.
function InputFAB(props) {
  var onOpen = props.onOpen || function() {};
  var pressedState = useState(false);
  var pressed = pressedState[0], setPressed = pressedState[1];

  var fabSize = 60;
  var fabBg = "linear-gradient(145deg, #FAF7F2 0%, #EFEAE2 100%)";
  var fabShadow = "0 8px 22px rgba(79,184,136,0.22), 0 3px 10px rgba(0,0,0,0.4)";
  var fabTransform = pressed ? "scale(0.94)" : "scale(1)";

  function handleTap() {
    setPressed(true);
    tapHaptic && tapHaptic();
    setTimeout(function() { setPressed(false); onOpen(); }, 90);
  }

  return h("div", {
    onMouseDown: function() { setPressed(true); },
    onMouseUp: function() { setPressed(false); },
    onMouseLeave: function() { setPressed(false); },
    onClick: handleTap,
    onTouchStart: function() { setPressed(true); },
    onTouchEnd: function(e) { setPressed(false); e.preventDefault(); handleTap(); },
    style: {
      position: "fixed",
      right: 16, bottom: 94,
      width: fabSize, height: fabSize, borderRadius: "50%",
      background: fabBg,
      color: "#0F0F0F",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 30, fontFamily: "'Lora',serif", fontWeight: 500,
      cursor: "pointer",
      zIndex: 1000,
      boxShadow: fabShadow,
      userSelect: "none", touchAction: "manipulation",
      transition: "transform 140ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 220ms ease",
      transform: fabTransform,
      letterSpacing: "-0.02em",
    },
  }, "S");
}

// ── INPUT MODAL ──────────────────────────────────────────────
// Premium in-app text input. User types naturally ("$30 coffee at
// Lighthouse"), modal POSTs to /api/v5/parse, server runs the same
// pipeline as Telegram (AI parse + currency conversion + validation),
// returns a proposal. Modal renders a confirm card in the SAME app —
// user taps Yes → POST /api/v5/apply → state updates → modal closes.
//
// This is the standalone-app primitive: no chat hop, full input cycle
// inside the Mini App. Voice/photo are deferred (Web Speech API +
// multipart upload — separate ship).
function InputModal(props) {
  var sid = props.sid;
  // Seed initial text from prop (when opened via an action chip).
  // Falsy → empty; the placeholder rotation handles discoverability
  // when the input is empty.
  var inputState = useState(props.initialText || "");
  var input = inputState[0], setInput = inputState[1];
  var loadingState = useState(false);
  var loading = loadingState[0], setLoading = loadingState[1];
  var resultState = useState(null);
  var result = resultState[0], setResult = resultState[1];
  var errorState = useState("");
  var error = errorState[0], setError = errorState[1];
  var applyingState = useState(false);
  var applying = applyingState[0], setApplying = applyingState[1];
  // Photo capture state — file input ref + reading flag for the spinner.
  var fileInputRef = useRef(null);
  var readingPhotoState = useState(false);
  var readingPhoto = readingPhotoState[0], setReadingPhoto = readingPhotoState[1];
  // Voice recognition state — Web Speech API where available.
  var listeningState = useState(false);
  var listening = listeningState[0], setListening = listeningState[1];
  var recognitionRef = useRef(null);
  // Feature-detect Web Speech API. If unavailable, hide the mic icon.
  var SR = (typeof window !== "undefined") &&
           (window.SpeechRecognition || window.webkitSpeechRecognition);
  var voiceSupported = !!SR;

  // ── ROTATING PLACEHOLDER ─────────────────────────────────────
  // When the input is empty, the placeholder cycles through example
  // phrasings every 3.2 seconds. Users learn the bot's vocabulary by
  // osmosis — no help screen needed. The examples cover all 6 major
  // intents (spend, income, bill, set-aside, payment, afford check).
  var placeholders = [
    "spent 5 on coffee",
    "rent 1400 due the 1st",
    "i need 200 for friend's trip by friday",
    "paid the rent",
    "got paid 3000",
    "can i afford 200?",
  ];
  var phIndexState = useState(0);
  var phIndex = phIndexState[0], setPhIndex = phIndexState[1];
  useEffect(function() {
    if (input || result) return; // freeze rotation when user is typing or confirming
    var id = setInterval(function() {
      setPhIndex(function(i) { return (i + 1) % placeholders.length; });
    }, 3200);
    return function() { clearInterval(id); };
  }, [input, result]);
  var placeholder = "e.g. \"" + placeholders[phIndex] + "\"";

  // ESC closes when not actively applying.
  useEffect(function() {
    function onKey(e) { if (e.key === "Escape" && !applying) props.onClose(); }
    document.addEventListener("keydown", onKey);
    return function() { document.removeEventListener("keydown", onKey); };
  }, [applying]);

  function submit() {
    var text = input.trim();
    if (!text || loading) return;
    setLoading(true); setError(""); setResult(null);
    fetch(API_BASE + "/api/v5/parse/" + sid, {
      method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify({ text: text }),
    })
      .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, body: d }; }); })
      .then(function(res) {
        if (!res.ok) { setError(res.body && res.body.error || "Something went wrong."); return; }
        setResult(res.body);
      })
      .catch(function(e) { setError(e.message); })
      .then(function() { setLoading(false); });
  }

  // ── PHOTO RECEIPT ─────────────────────────────────────────
  // Pick or snap a receipt photo. Reads as base64 dataUrl, POSTs to
  // /api/v5/parse-photo. Server vision-parses → returns the same
  // result shape as text /parse, so the confirm card flow is shared.
  function onPickPhoto(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) { setError("Pick an image."); return; }
    if (file.size > 8 * 1024 * 1024) { setError("Photo too large (8MB max)."); return; }
    setReadingPhoto(true); setError(""); setResult(null);
    var reader = new FileReader();
    reader.onload = function() {
      var dataUrl = reader.result;
      fetch(API_BASE + "/api/v5/parse-photo/" + sid, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
        body: JSON.stringify({ dataUrl: dataUrl }),
      })
        .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, body: d }; }); })
        .then(function(res) {
          if (!res.ok) { setError((res.body && res.body.error) || "Couldn't read the photo."); return; }
          setResult(res.body);
        })
        .catch(function(e2) { setError(e2.message); })
        .then(function() {
          setReadingPhoto(false);
          // Clear the file input so picking the same file twice still triggers onChange.
          if (fileInputRef.current) fileInputRef.current.value = "";
        });
    };
    reader.onerror = function() { setError("Couldn't read the file."); setReadingPhoto(false); };
    reader.readAsDataURL(file);
  }

  // ── VOICE ─────────────────────────────────────────────────
  // Web Speech API (when supported). Tap mic → start recognition →
  // transcribed text fills the textarea. Tap again to stop. On
  // unsupported devices the mic icon is hidden (voiceSupported=false).
  function toggleVoice() {
    if (!SR) return;
    if (listening) {
      try { recognitionRef.current && recognitionRef.current.stop(); } catch {}
      setListening(false);
      return;
    }
    var rec;
    try { rec = new SR(); } catch (e) { setError("Voice not supported on this device."); return; }
    rec.lang = (_activeLang === "ru" ? "ru-RU" : "en-US");
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    var finalText = "";
    rec.onresult = function(ev) {
      var interim = "";
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var transcript = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += transcript;
        else interim += transcript;
      }
      setInput((finalText + interim).trim());
    };
    rec.onerror = function() { setListening(false); };
    rec.onend = function() { setListening(false); };
    recognitionRef.current = rec;
    try { rec.start(); setListening(true); }
    catch (e) { setError("Couldn't start voice — try again."); }
  }
  // Cleanup recognition on unmount
  useEffect(function() {
    return function() {
      try { recognitionRef.current && recognitionRef.current.stop(); } catch {}
    };
  }, []);

  function applyIntent() {
    if (!result || !result.intent || applying) return;
    setApplying(true); setError("");
    fetch(API_BASE + "/api/v5/apply/" + sid, {
      method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify({ intent: result.intent, intents: result.intents }),
    })
      .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, body: d }; }); })
      .then(function(res) {
        if (!res.ok || !(res.body && res.body.ok)) {
          setError((res.body && res.body.error) || "Couldn't apply.");
          setApplying(false);
          return;
        }
        tapHaptic && tapHaptic();
        props.onApplied();
      })
      .catch(function(e) { setError(e.message); setApplying(false); });
  }

  // Render branches: input (initial) → loading → result (confirm) → error
  var body;
  if (result && (result.intent || (result.intents && result.intents.length))) {
    // Confirm card — show the parsed intent(s) before applying
    var intents = result.intents || [result.intent];
    body = h("div", null,
      h("div", { style: { fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 12 } }, "Ready to log"),
      h("div", { style: { display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 } },
        intents.map(function(it, i) {
          var p = (it && it.params) || {};
          var desc = "";
          if (it.kind === "record_spend") {
            desc = "Spend ";
            if (p.originalCurrency && p.originalAmount) {
              desc += p.originalAmount + " " + p.originalCurrency;
            } else if (typeof p.amountCents === "number") {
              desc += "$" + (p.amountCents / 100).toFixed(2);
            }
            if (p.vendor) desc += " · " + p.vendor;
            if (p.note && p.note !== p.vendor) desc += " — " + p.note;
            if (p.category) desc += " #" + p.category;
          } else if (it.kind === "record_income") {
            desc = "Income ";
            if (typeof p.amountCents === "number") desc += "$" + (p.amountCents / 100).toFixed(2);
            if (p.note) desc += " · " + p.note;
          } else if (it.kind === "add_bill") {
            desc = "Add bill " + (p.name || "") + " · $" + ((p.amountCents || 0) / 100).toFixed(2);
          } else {
            desc = it.kind;
          }
          return h("div", {
            key: i,
            style: { padding: "12px 14px", background: C.card, border: "1px solid " + C.border, borderRadius: 10, fontSize: 13, color: C.text },
          }, desc);
        })
      ),
      result.message
        ? h("div", { style: { fontSize: 11, color: C.muted, marginBottom: 16, lineHeight: 1.5 } }, result.message)
        : null,
      h("div", { style: { display: "flex", gap: 10 } },
        h("button", {
          onClick: function() { setResult(null); setInput(""); },
          disabled: applying,
          style: {
            flex: 1, padding: "12px", background: "transparent", border: "1px solid " + C.border,
            borderRadius: 10, color: C.sub, fontSize: 13, fontFamily: "'Inter',sans-serif",
            cursor: "pointer", opacity: applying ? 0.5 : 1,
          },
        }, "Cancel"),
        h("button", {
          onClick: applyIntent,
          disabled: applying,
          style: {
            flex: 2, padding: "12px", background: C.text, border: "none",
            borderRadius: 10, color: "#0F0F0F", fontSize: 13, fontWeight: 600,
            fontFamily: "'Inter',sans-serif",
            cursor: applying ? "default" : "pointer",
            opacity: applying ? 0.6 : 1,
            transition: "opacity 180ms ease",
          },
        }, applying ? "Logging…" : "Yes, log it")
      )
    );
  } else if (result && result.kind === "talk") {
    // Bot replied conversationally (e.g., couldn't parse, asked a question)
    body = h("div", null,
      h("div", { style: { fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 12 } }, "Bot says"),
      h("div", { style: { fontSize: 14, color: C.text, marginBottom: 18, lineHeight: 1.5 } }, result.message || "Hmm, didn't catch that."),
      h("button", {
        onClick: function() { setResult(null); setInput(""); },
        style: {
          width: "100%", padding: "12px", background: C.text, border: "none",
          borderRadius: 10, color: "#0F0F0F", fontSize: 13, fontWeight: 600, cursor: "pointer",
        },
      }, "Try again")
    );
  } else {
    // Icon button helper — uniform style, tap haptic, opacity-on-disabled.
    function iconBtn(opts) {
      var disabled = !!opts.disabled;
      return h("button", {
        type: "button",
        onClick: opts.onClick,
        disabled: disabled,
        "aria-label": opts.label,
        title: opts.label,
        style: {
          width: 40, height: 40,
          background: opts.active ? C.greenSoft : C.card,
          border: "1px solid " + (opts.active ? C.green : C.border),
          color: opts.active ? C.green : C.text,
          borderRadius: 10,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 17,
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.4 : 1,
          fontFamily: "'Inter',sans-serif",
          transition: "background 160ms ease, border-color 160ms ease, opacity 160ms ease",
          padding: 0,
          userSelect: "none",
        },
      }, opts.icon);
    }

    // Starter chips — five common intents, tap to pre-fill the textarea.
    // Discoverability without overload: chips live INSIDE the modal
    // (not on the Today tab where they'd duplicate the S button) and
    // disappear once the user starts typing (so they don't fight the
    // input). One row, horizontally scrollable on narrow phones.
    function starterChip(label, prefill) {
      return h("button", {
        type: "button",
        onClick: function() {
          setInput(prefill);
          // Focus the textarea after the chip tap so the user can
          // immediately keep typing (cursor at end).
          setTimeout(function() {
            var ta = document.querySelector("textarea[autofocus]") || document.querySelector("textarea");
            if (ta) { ta.focus(); ta.setSelectionRange(prefill.length, prefill.length); }
          }, 30);
        },
        style: {
          padding: "6px 12px",
          background: "transparent",
          border: "1px solid " + C.border,
          borderRadius: 999,
          color: C.text,
          fontSize: 12,
          fontFamily: "'Inter',sans-serif",
          cursor: "pointer",
          whiteSpace: "nowrap",
          userSelect: "none",
        },
      }, label);
    }
    var chipsRow = !input ? h("div", {
      style: {
        display: "flex", gap: 6, marginBottom: 14,
        overflowX: "auto", paddingBottom: 4,
        WebkitOverflowScrolling: "touch",
      },
    },
      starterChip("Spend", "spent "),
      starterChip("Save for", "save "),
      starterChip("Income", "got paid "),
      starterChip("Bill", "rent "),
      starterChip("Afford?", "can i afford ")
    ) : null;

    body = h("div", null,
      h("div", { style: { fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 12 } }, "Log a spend"),
      chipsRow,
      h("textarea", {
        value: input,
        autoFocus: true,
        onChange: function(e) { setInput(e.target.value); },
        onKeyDown: function(e) {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
        },
        placeholder: placeholder,
        rows: 3,
        style: {
          width: "100%", boxSizing: "border-box",
          background: C.card, border: "1px solid " + C.border, borderRadius: 10,
          color: C.text, padding: "12px 14px",
          fontSize: 14, fontFamily: "'Inter',sans-serif", lineHeight: 1.5,
          outline: "none", resize: "none",
          marginBottom: 12,
        },
      }),
      // Action row: 📷 + 🎤 on left, Send on right. iMessage compose pattern.
      h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 } },
        // Hidden file input — triggered by the camera button. `capture`
        // hints mobile to default to the back camera for receipts.
        h("input", {
          ref: fileInputRef,
          type: "file",
          accept: "image/*",
          capture: "environment",
          onChange: onPickPhoto,
          style: { display: "none" },
        }),
        iconBtn({
          icon: readingPhoto ? "…" : "📷",
          label: "Receipt photo",
          disabled: readingPhoto || loading,
          onClick: function() {
            if (fileInputRef.current) fileInputRef.current.click();
          },
        }),
        voiceSupported ? iconBtn({
          icon: listening ? "■" : "🎤",
          label: listening ? "Stop voice" : "Voice",
          disabled: loading || readingPhoto,
          active: listening,
          onClick: toggleVoice,
        }) : null,
        h("div", { style: { flex: 1 } }), // spacer
        h("button", {
          onClick: submit,
          disabled: !input.trim() || loading || readingPhoto,
          style: {
            padding: "10px 18px", background: C.text, border: "none",
            borderRadius: 10, color: "#0F0F0F", fontSize: 13, fontWeight: 600,
            fontFamily: "'Inter',sans-serif",
            cursor: (!input.trim() || loading || readingPhoto) ? "default" : "pointer",
            opacity: (!input.trim() || loading || readingPhoto) ? 0.45 : 1,
            transition: "opacity 180ms ease",
          },
        }, loading ? "Thinking…" : readingPhoto ? "Reading…" : "Send")
      ),
      h("div", { style: { fontSize: 10, color: C.muted, marginTop: 10, letterSpacing: "0.02em" } },
        listening
          ? "Listening… tap ■ to stop"
          : readingPhoto
            ? "Reading your receipt…"
            : "Type, tap 📷 for a receipt" + (voiceSupported ? ", or 🎤 to dictate" : "") + ". ⌘+Enter to send."
      )
    );
  }

  return h("div", {
    onClick: function(e) { if (e.target === e.currentTarget && !applying) props.onClose(); },
    style: {
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)",
      zIndex: 1100,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
      animation: "fadeIn 200ms ease",
    },
  },
    h("div", {
      onClick: function(e) { e.stopPropagation(); },
      style: {
        background: "#1a1a1a",
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
        width: "100%", maxWidth: 520,
        padding: "22px 22px 32px",
        boxShadow: "0 -12px 50px rgba(0,0,0,0.6)",
        animation: "modalIn 320ms cubic-bezier(0.34, 1.56, 0.64, 1)",
      },
    },
      // Drag handle (visual)
      h("div", {
        style: { width: 38, height: 4, background: "rgba(255,255,255,0.18)", borderRadius: 2, margin: "0 auto 18px" },
      }),
      error
        ? h("div", { style: { padding: "10px 12px", marginBottom: 12, background: "rgba(228,86,86,0.12)", border: "1px solid rgba(228,86,86,0.3)", borderRadius: 8, fontSize: 12, color: C.red } }, error)
        : null,
      body
    )
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App, null));
