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
function Hero(props) {
  var v = props.view;
  var col = colorForState(v.state);

  var pill = h("div", {
    style: {
      display: "inline-flex", alignItems: "center", gap: 6,
      background: softColorForState(v.state),
      color: col, fontSize: 12, fontWeight: 600,
      padding: "5px 12px", borderRadius: 999,
      letterSpacing: "0.02em", marginBottom: 16,
    },
  },
    h("span", { style: { width: 6, height: 6, borderRadius: "50%", background: col } }),
    v.state === "over" ? t("status.over") : v.state === "tight" ? t("status.tight") : t("status.calm")
  );

  var heroNumber, heroLabel, subContext;
  if (v.state === "over") {
    heroNumber = v.deficitFormatted;
    heroLabel = t("miniapp.hero.overForPeriod");
    subContext = t("miniapp.hero.afterPayday", { days: v.daysToPayday, pace: v.dailyPaceFormatted });
  } else {
    heroNumber = v.todayRemainingFormatted;
    heroLabel = t("miniapp.hero.freeToday");
    subContext = t("miniapp.hero.beforePayday", { pace: v.dailyPaceFormatted, days: v.daysToPayday });
  }

  return h("div", { style: { padding: "32px 20px 22px", textAlign: "center" } },
    pill,
    h("div", {
      style: {
        fontFamily: "'Lora',serif", fontSize: 60, fontWeight: 500,
        color: col, lineHeight: 1.0, letterSpacing: "-0.02em",
        transition: "color 0.4s ease",
      },
    }, heroNumber),
    h("div", { style: { fontSize: 13, color: C.sub, marginTop: 10, letterSpacing: "0.02em" } }, heroLabel),
    h("div", { style: { fontSize: 12, color: C.muted, marginTop: 6 } }, subContext)
  );
}

// ── HEATMAP CALENDAR ─────────────────────────────────────────
// 30 days as colored squares. Color from spend vs that day's safe
// pace. Tap a square → expand inline showing that day's transactions.
function Heatmap(props) {
  var heatmap = props.heatmap || [];
  var dailyPace = props.dailyPaceCents || 0;
  var sym = props.sym || "$";
  var txs = props.txs || [];
  var nameMap = props.nameMap || {};
  var openState = useState(null);
  var open = openState[0], setOpen = openState[1];

  // Subtle haptic feedback on Telegram clients that support it.
  function tapHaptic() {
    try {
      var hf = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.HapticFeedback;
      if (hf && hf.impactOccurred) hf.impactOccurred("light");
    } catch (e) { /* ignore */ }
  }

  // Color thresholds: 0 spend = dim grey, <50% pace = green,
  // 50-100% pace = green-medium, 100-150% = amber, >150% = red
  function colorForDay(spent) {
    if (spent === 0) return { bg: C.cardHi, fg: C.muted };
    if (dailyPace <= 0) return { bg: C.cardHi, fg: C.muted };
    var ratio = spent / dailyPace;
    if (ratio <= 0.5) return { bg: "rgba(79,184,136,0.55)", fg: "#0F0F0F" };
    if (ratio <= 1.0) return { bg: "rgba(79,184,136,0.85)", fg: "#0F0F0F" };
    if (ratio <= 1.5) return { bg: "rgba(240,160,80,0.85)", fg: "#0F0F0F" };
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
        var col = colorForDay(d.spentCents);
        var isOpen = open === d.date;
        return h("div", {
          key: d.date,
          onClick: function() { tapHaptic(); setOpen(isOpen ? null : d.date); },
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
    ),
    open ? DayDetail({ date: open, txs: txs, sym: sym, nameMap: nameMap, today: heatmap[heatmap.length - 1] && heatmap[heatmap.length - 1].date }) : null
  );
}

function DayDetail(props) {
  var dayTxs = (props.txs || []).filter(function(tx) { return tx.date === props.date; });
  var total = dayTxs.reduce(function(a, tx) {
    if (tx.kind === "spend" || tx.kind === "bill_payment") return a + tx.amountCents;
    if (tx.kind === "refund") return a - Math.abs(tx.amountCents);
    return a;
  }, 0);
  var dateLabel = props.today ? relativeDay(props.date, props.today) : props.date;
  var isEmpty = dayTxs.length === 0;
  return h("div", {
    style: { marginTop: 10, padding: "12px 14px", background: C.card, borderRadius: 10, border: "1px solid " + C.border },
  },
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
      h("div", { style: { fontSize: 12, fontWeight: 600 } }, dateLabel),
      // Hide "$0.00 spent" when the day genuinely has nothing — it pretends
      // there was activity when there wasn't. Just show the friendly empty
      // state below.
      isEmpty
        ? null
        : h("div", { style: { fontSize: 11, color: C.sub } }, t("miniapp.heatmap.spent", { amount: fmtMoney(total, props.sym) }))
    ),
    isEmpty
      ? h("div", { style: { fontSize: 11, color: C.muted, padding: "6px 0", fontStyle: "italic" } }, t("miniapp.heatmap.empty"))
      : dayTxs.map(function(tx) {
          var lbl = txLabel(tx, props.nameMap);
          return h("div", {
            key: tx.id,
            style: { display: "flex", justifyContent: "space-between", padding: "7px 0", fontSize: 12, borderTop: "1px solid " + C.border, alignItems: "center" },
          },
            h("div", { style: { flex: 1, overflow: "hidden", marginRight: 8 } },
              h("div", { style: { color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, lbl.primary),
              lbl.secondary ? h("div", { style: { color: C.muted, fontSize: 10, marginTop: 1 } }, lbl.secondary) : null
            ),
            h("div", { style: { color: tx.kind === "refund" ? C.green : C.text, fontFamily: "'Lora',serif" } },
              (tx.kind === "refund" ? "+" : "") + fmtMoney(Math.abs(tx.amountCents), props.sym)
            )
          );
        })
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
            h("div", { style: { fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, lbl.primary),
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
      // Big amount headline
      h("div", { style: { textAlign: "center", marginBottom: foreignLine ? 4 : 18 } },
        h("div", { style: { fontFamily: "'Lora',serif", fontSize: 34, color: tx.kind === "refund" || tx.kind === "income" ? C.green : C.text, fontWeight: 400 } }, bigAmount),
        foreignLine ? h("div", { style: { fontFamily: "'Lora',serif", fontSize: 14, color: C.muted, marginTop: 4 } }, foreignLine + " · " + tx.originalCurrency) : null
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
  return h("div", {
    style: { display: "flex", alignItems: "center", padding: "20px 16px 8px", gap: 8 },
  },
    h("div", { style: { fontSize: 16 } }, props.icon),
    h("div", { style: { fontSize: 12, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 } }, props.title),
    props.count != null ? h("div", { style: { fontSize: 12, color: C.muted } }, "· " + props.count) : null
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

  function tapHaptic() {
    try {
      var hf = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.HapticFeedback;
      if (hf && hf.impactOccurred) hf.impactOccurred("light");
    } catch (_) {}
  }

  function markPaid() {
    if (!sid || busy) return;
    setBusy(true); setErr(null);
    fetch(API_BASE + "/api/v4/action/" + sid, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ intent: { kind: "pay_bill", params: { name: e.name } } }),
    })
      .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, body: d }; }); })
      .then(function(res) {
        if (res.ok && res.body && res.body.ok) {
          tapHaptic();
          setShowConfirm(false);
          if (onPaid) onPaid(res.body.view);
        } else {
          setErr((res.body && (res.body.error || res.body.reason)) || t("miniapp.bills.couldntPay"));
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
        h("div", { style: { fontSize: 11, color: col, marginTop: 3 } },
          label,
          e.recurrence && e.recurrence !== "once" ? h("span", { style: { color: C.muted } }, " · " + e.recurrence) : null
        )
      ),
      h("div", { style: { fontFamily: "'Lora',serif", fontSize: 16 } }, e.amountFormatted)
    ),
    // Action area — Mark Paid two-tap confirm, only for active bills with future-or-today dates.
    e.daysUntilDue != null && e.daysUntilDue <= 30 && sid ? h("div", { style: { marginTop: 10, paddingTop: 10, borderTop: "1px solid " + C.border } },
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
                          h("div", { style: { color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, lbl.primary),
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
    h("style", null, "@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } } @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } } @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }"),
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

  // dueNow appears as part of bills card sort (most urgent first), not a separate section.
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

  return h("div", null,
    h(Hero, { view: v, sid: props.sid }),
    h(FirstTimeCard, null),
    h(Heatmap, { heatmap: heatmap, dailyPaceCents: v.dailyPaceCents, sym: sym, txs: txs, nameMap: nameMap }),
    h(AnticipationStrip, { envelopes: bills, sym: sym }),
    h(TodayStrip, { view: v, txs: txs, today: today, nameMap: nameMap }),
    bills.length > 0 ? h("div", null,
      h(DueBanner, { envelopes: bills, sym: sym }),
      h(SectionHeader, { icon: "📌", title: t("miniapp.bills.label"), count: bills.length }),
      h("div", { style: { padding: "0 16px" } },
        bills.map(function(e) { return h(BillCard, { key: e.key, env: e, sym: sym, sid: props.sid, onPaid: props.onViewUpdate }); }))
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
    h(History, { txs: txs, sym: sym, today: today, dateMinusN: dateMinusN, nameMap: nameMap }),
    h("div", {
      style: { textAlign: "center", padding: "28px 16px 32px", color: C.muted, fontSize: 11 },
    }, t("miniapp.footer"))
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
        var lang = (v && v.language) || "en";
        loadLocale(lang, function() {
          setData({
            view: v,
            txs: d.recentTransactions || [],
            heatmap: d.heatmap || [],
          });
          setError(false);
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

  var content;
  if (loading && !data) content = h(Skeleton, null);
  else if (error && !data) content = h(ErrorState, { onRetry: loadView, errMsg: lastErr });
  else if (!data || !data.view || !data.view.setup) content = h(NotSetUpState, null);
  else content = h(Dashboard, {
    view: data.view, txs: data.txs, heatmap: data.heatmap, sid: sid.current,
    // After a successful Mark-Paid action, swap in the fresh view immediately
    // and re-fetch in the background to pick up new transaction list / heatmap.
    onViewUpdate: function(newView) {
      setData({ view: newView, txs: data.txs, heatmap: data.heatmap });
      loadView();
    },
  });

  return h("div", {
    style: {
      display: "flex", flexDirection: "column", minHeight: "100vh",
      background: C.bg, color: C.text, fontFamily: "'Inter',sans-serif", fontSize: 14,
    },
  }, content);
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App, null));
