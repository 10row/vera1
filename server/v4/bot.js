"use strict";
// v4/bot.js — Telegram bot using v4 safe core.
// Confirm-card flow: every DO intent is shown to the user first; nothing
// applies until they tap "Yes" (or it's an auto-tier small spend with Undo).

const { Bot } = require("grammy");
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");
const m = require("./model");
const { applyIntent } = require("./engine");
const { compute, heroLine: viewHeroLine } = require("./view");
const { processMessage } = require("./pipeline");
const tts = require("./tts");
const proactive = require("./proactive");
const db = require("./db");

// Trim BOT_TOKEN — Railway/.env paste often leaves a trailing newline which
// silently breaks initData HMAC validation while still working for API calls.
const BOT_TOKEN_RAW = process.env.BOT_TOKEN || "";
const BOT_TOKEN = BOT_TOKEN_RAW.trim();
if (BOT_TOKEN_RAW && BOT_TOKEN_RAW !== BOT_TOKEN) {
  console.warn("[v4] BOT_TOKEN had trailing whitespace — trimmed");
}
const bot = BOT_TOKEN ? new Bot(BOT_TOKEN) : null;
const openai = new OpenAI();

// In-memory pending intents store: { token → { userId, intent, expires } }.
// Confirm cards include a token in the callback_data; max ~30 min TTL.
const PENDING_TTL_MS = 30 * 60 * 1000;
const pending = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
}, 60_000);

function makeToken() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// Pending intents are now stored as an array so a batch card can apply
// multiple intents on a single Yes. Single-intent callers pass [intent].
// A pending entry can carry a queue. When the user taps Yes on a queued
// confirm, the bot applies the current intent then advances to the next
// item in the queue, presenting a fresh confirm card with "(idx+1) of N".
function setPending(intents, userId, opts) {
  const arr = Array.isArray(intents) ? intents : [intents];
  const token = makeToken();
  pending.set(token, {
    intents: arr,                            // the intents being confirmed by THIS card
    queueAfter: (opts && opts.queueAfter) || null,  // remaining intents to process
    queueTotal: (opts && opts.queueTotal) || arr.length,
    queueIndex: (opts && opts.queueIndex) || 1,
    originalMessage: (opts && opts.originalMessage) || null,
    userId,
    expires: Date.now() + PENDING_TTL_MS,
  });
  return token;
}

// Undo tokens — separate map. Tied to a specific event id so a stale undo
// (after other actions happened) can be detected and refused gracefully.
const UNDO_TTL_MS = 30 * 60 * 1000;
const undoTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of undoTokens) if (v.expires < now) undoTokens.delete(k);
}, 60_000);

function setUndoToken(eventId, userId) {
  const token = makeToken();
  undoTokens.set(token, { eventId, userId, expires: Date.now() + UNDO_TTL_MS });
  return token;
}

function takeUndoToken(token) {
  const e = undoTokens.get(token);
  if (!e) return null;
  undoTokens.delete(token);
  return e;
}

function undoButton(token) {
  return { reply_markup: { inline_keyboard: [[{ text: "↶ Undo", callback_data: "undo:" + token }]] } };
}

const PROMISE = "_I'll never log anything you don't tap. Anything I do is undoable._";

function takePending(token) {
  const entry = pending.get(token);
  if (!entry) return null;
  pending.delete(token);
  return entry;
}

// ── HELPERS ─────────────────────────────────────────────
function fmtIntent(intent, sym) {
  const p = intent.params || {};
  const M = c => m.toMoney(typeof c === "number" ? c : 0, sym || "$");
  switch (intent.kind) {
    case "setup_account":
      return "Set up account · balance " + M(p.balanceCents) +
        (p.payday ? ", payday " + p.payday : "") +
        (p.payFrequency ? ", " + p.payFrequency : "");
    case "adjust_balance":
      return "Update balance to " + M(p.newBalanceCents);
    case "add_envelope": {
      // Make kind UNMISTAKABLE so a misclassification is visible at a glance.
      const kindIcon = p.kind === "bill" ? "📌" : p.kind === "budget" ? "📊" : p.kind === "goal" ? "🎯" : "•";
      const kindLabel = p.kind === "bill" ? "Bill (recurring)"
        : p.kind === "budget" ? "Budget (ongoing spend allowance)"
        : p.kind === "goal" ? "Goal (saving toward target)"
        : "Envelope";
      const recurrence = p.recurrence && p.recurrence !== "once" ? " · " + p.recurrence : "";
      const due = p.dueDate ? " · due " + p.dueDate : "";
      return kindIcon + " *" + kindLabel + "*\n     " + p.name + " · " + M(p.amountCents) + recurrence + due;
    }
    case "update_envelope":
      return "Update " + (p.key || p.name);
    case "remove_envelope":
      return "Remove " + (p.key || p.name);
    case "record_spend":
      return "Spend " + M(p.amountCents) + (p.note ? " · " + p.note : "") +
        (p.envelopeKey ? " · " + p.envelopeKey : "");
    case "record_income":
      return "Income " + M(p.amountCents) + (p.note ? " · " + p.note : "");
    case "fund_envelope":
      return "Move " + M(p.amountCents) + " into " + (p.name || p.envelopeKey);
    case "pay_bill":
      return "Mark " + (p.name || p.envelopeKey) + " paid";
    case "skip_bill":
      return "Skip " + (p.name || p.envelopeKey) + " this cycle";
    case "edit_transaction":
      return "Edit transaction" + (p.newAmountCents !== undefined ? " → " + M(p.newAmountCents) : "");
    case "delete_transaction":
      return "Delete transaction";
    case "update_settings":
      return "Update settings";
    case "reset":
      return "Reset everything";
    default:
      return intent.kind;
  }
}

function heroLine(state) {
  const v = compute(state);
  if (!v.setup) return "";
  return viewHeroLine(v, m.today(state.timezone || "UTC"));
}

// Reply keyboard is dead weight: it eats screen space on every message,
// looks dated, and is redundant with the always-visible ≡ menu button.
// Modern Telegram money bots don't use them. We send remove_keyboard with
// every reply so existing users see their old keyboard disappear, and new
// users never see one. Inline keyboards are still used for confirm cards.
function mainKeyboard() {
  return { remove_keyboard: true };
}

// Greeting patterns: deterministic intercept for fresh users who say
// hi/hello/hey/etc. Bypasses the AI entirely so the response is reliable.
const GREETING_PATTERNS = /^\s*(hi+|hello+|hey+|yo+|sup|hola|namaste|howdy|hii+|heya|good\s*(morning|afternoon|evening|day|night)|what['s ]*up|h r u|hru)\s*[!.?]*\s*$/i;

function welcomeMessage() {
  return (
    "Hey 👋 I'm SpendYes — your money friend.\n\n" +
    PROMISE + "\n\n" +
    "What's the rough balance in your main account right now? Just say a number — like *$5,000* or *5k*."
  );
}

function confirmCard(token, opts) {
  const yesLabel = (opts && opts.yesLabel) || "Yes, do it";
  const noLabel = (opts && opts.noLabel) || "Cancel";
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: yesLabel, callback_data: "yes:" + token },
        { text: noLabel, callback_data: "no:" + token },
      ]],
    },
  };
}

// Send a text reply, and if the incoming was voice + user opted in,
// also send a voice synth. TTS failure is invisible (no error to user).
async function sayMaybeVoice(ctx, text, options, voiceMode) {
  const sent = await ctx.reply(text, options || {});
  if (voiceMode && text) {
    const audio = await tts.synthesize(text);
    if (audio) {
      try { await ctx.replyWithVoice(new (require("grammy").InputFile)(audio, "reply.opus")); }
      catch (e) { console.warn("[v4 voice send]", e.message); }
    }
  }
  return sent;
}

// ── PROCESS A USER TEXT MESSAGE ────────────────────────
async function processText(prisma, ctx, telegramId, text, opts) {
  const isVoice = !!(opts && opts.isVoice);
  const u = await db.resolveUser(prisma, "tg_" + telegramId);
  await ctx.replyWithChatAction("typing");

  await db.withUserLock(u.id, async () => {
    const state = await db.loadState(prisma, u.id);
    const history = await db.loadHistory(prisma, u.id);
    const voiceMode = isVoice && !!state.voiceReplies;

    const result = await processMessage(state, text, history);

    // Persist conversation history (talk and do both).
    await db.appendHistory(prisma, u.id, "user", text);
    if (result.message) await db.appendHistory(prisma, u.id, "assistant", result.message);

    if (result.kind === "talk") {
      await sayMaybeVoice(ctx, result.message || "…", {
        parse_mode: "Markdown",
        reply_markup: mainKeyboard(),
      }, voiceMode);
      return;
    }

    // DECISION SUPPORT: read-only simulate. Show projected hero + delta,
    // offer "Log it now" button that converts to a real record_spend confirm.
    if (result.kind === "decision") {
      const sym = state.currencySymbol || "$";
      const sim = result.simulate;
      const proj = sim.projected;
      const cur = sim.current;
      const M = c => m.toMoney(c, sym);
      const amt = result.intent.params.amountCents;

      let verdict;
      if (proj.state === "over") {
        verdict = "*Over.* That'd put you " + M(proj.deficitCents) + " over for the cycle.";
      } else if (proj.state === "tight") {
        verdict = "*Tight.* You'd drop to " + proj.dailyPaceFormatted + "/day for " + proj.daysToPayday + " days.";
      } else if (cur.state !== "green") {
        verdict = "*Green.* You'd jump from " + cur.dailyPaceFormatted + "/day up to " + proj.dailyPaceFormatted + "/day.";
      } else {
        verdict = "*Easy.* You'd still have " + proj.dailyPaceFormatted + "/day for " + proj.daysToPayday + " days.";
      }

      const lines = [];
      if (result.message) lines.push(result.message);
      lines.push("");
      lines.push(verdict);
      lines.push("_Spend: " + M(amt) + (result.intent.params.note ? " on " + result.intent.params.note : "") + "_");

      // Offer to log it now: token holds the equivalent record_spend intent.
      const recordIntent = {
        kind: "record_spend",
        params: {
          amountCents: amt,
          note: result.intent.params.note || "",
          envelopeKey: result.intent.params.envelopeKey || null,
        },
      };
      const token = setPending([recordIntent], u.id);
      await ctx.reply(lines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "Log it now", callback_data: "yes:" + token },
            { text: "Skip", callback_data: "no:" + token },
          ]],
        },
      });
      return;
    }

    // DO mode: bucket decisions by severity.
    // - auto    → apply immediately (we'll send one summary at the end)
    // - confirm → collect into a single batch confirm card
    // - reject  → send error inline (one combined message if multiple)
    let curState = state;
    const sym = (curState.currencySymbol) || "$";
    const autoApplied = [];
    const toConfirm = [];
    const rejections = [];

    for (const d of result.decisions) {
      if (!d.verdict.ok) {
        rejections.push(d.verdict.reason);
        continue;
      }
      if (d.verdict.severity === "auto") {
        try {
          const r = applyIntent(curState, d.intent);
          curState = r.state;
          autoApplied.push(d.intent);
        } catch (e) {
          rejections.push("Couldn't log: " + e.message);
        }
        continue;
      }
      toConfirm.push({ intent: d.intent, verdict: d.verdict });
    }

    if (autoApplied.length > 0) await db.saveState(prisma, u.id, curState);

    // Compose one outgoing message stack: rejections (if any), auto summary
    // (if any), single batch confirm card (if any).
    if (rejections.length > 0) {
      const text = (result.message ? result.message + "\n\n" : "")
        + rejections.map(r => "_" + r + "_").join("\n");
      await ctx.reply(text, { parse_mode: "Markdown", reply_markup: mainKeyboard() });
    }

    if (autoApplied.length > 0) {
      const lines = autoApplied.map(i => "✓ " + fmtIntent(i, sym));
      lines.push(heroLine(curState, sym));
      // Get the most recent event id for the Undo token.
      const lastEventId = curState.events && curState.events.length
        ? curState.events[curState.events.length - 1].id
        : null;
      const opts = { parse_mode: "Markdown", reply_markup: mainKeyboard() };
      if (lastEventId) {
        const undoTok = setUndoToken(lastEventId, u.id);
        opts.reply_markup = undoButton(undoTok).reply_markup;
      }
      await sayMaybeVoice(ctx, lines.join("\n"), opts, voiceMode);
    }

    if (toConfirm.length === 1) {
      const { intent, verdict } = toConfirm[0];
      // QUEUE-AWARE: if pipeline returned a queueAfter, attach it to the
      // pending token. The callback handler will advance through it on Yes.
      const queueAfter = result.queueAfter || null;
      const queueTotal = result.queueTotal || 1;
      const queueIndex = result.queueIndex || 1;

      const token = setPending([intent], u.id, { queueAfter, queueTotal, queueIndex });

      // Header shows "1 of N" when sequencing
      const stepLabel = queueTotal > 1 ? "*Step " + queueIndex + " of " + queueTotal + "*\n" : "";
      const intro = (result.message && rejections.length === 0 && autoApplied.length === 0)
        ? result.message + "\n\n" : "";

      const cardText = intro + stepLabel
        + fmtIntent(intent, sym)
        + (verdict.reason && verdict.reason !== "Set up your account?" ? "\n_" + verdict.reason + "_" : "");

      const yesLabel = queueTotal > 1 ? "Confirm · next" : "Yes, do it";
      const noLabel = queueTotal > 1 ? "Skip" : "Cancel";
      await ctx.reply(cardText, { parse_mode: "Markdown", ...confirmCard(token, { yesLabel, noLabel }) });
    } else if (toConfirm.length > 1) {
      const intents = toConfirm.map(c => c.intent);
      const token = setPending(intents, u.id);
      const lines = ["*I'd like to:*"];
      intents.forEach((i, idx) => lines.push((idx + 1) + ". " + fmtIntent(i, sym)));
      lines.push("");
      lines.push("_Confirm all?_");
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", ...confirmCard(token) });
    }

    if (rejections.length === 0 && autoApplied.length === 0 && toConfirm.length === 0 && result.message) {
      // Edge case: AI in "do" mode but everything got dropped — fall back to talk.
      await ctx.reply(result.message, { parse_mode: "Markdown", reply_markup: mainKeyboard() });
    }
  });
}

// ── HANDLERS ───────────────────────────────────────────
function attach(prisma) {
  if (!bot) return;

  bot.command("start", async (ctx) => {
    try {
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      const state = await db.loadState(prisma, u.id);
      if (!state.setup) {
        await ctx.reply(
          "Hey 👋 I'm SpendYes — your money friend.\n\n" +
          PROMISE + "\n\n" +
          "Tell me your starting balance, when you next get paid, and any bills or budgets you've got. " +
          "You can hold the mic and just talk.",
          { parse_mode: "Markdown", reply_markup: mainKeyboard() }
        );
      } else {
        const sym = state.currencySymbol || "$";
        await ctx.reply("Welcome back. " + heroLine(state, sym), {
          parse_mode: "Markdown",
          reply_markup: mainKeyboard(),
        });
      }
    } catch (e) {
      console.error("[v4 /start]", e);
      await ctx.reply("Something went wrong. Try again?").catch(() => {});
    }
  });

  bot.command("mute", async (ctx) => {
    try {
      const arg = (ctx.match || "").toString().trim().toLowerCase();
      const valid = ["bills", "pace", "milestones", "all"];
      if (!valid.includes(arg)) {
        await ctx.reply("Use `/mute bills`, `/mute pace`, `/mute milestones`, or `/mute all`.", { parse_mode: "Markdown" });
        return;
      }
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      await db.withUserLock(u.id, async () => {
        const state = await db.loadState(prisma, u.id);
        if (!state.mute) state.mute = {};
        if (arg === "all") {
          state.mute.bills = state.mute.pace = state.mute.milestones = true;
        } else {
          state.mute[arg] = true;
        }
        await db.saveState(prisma, u.id, state);
        await ctx.reply("✓ Muted " + arg + ". Use `/unmute " + arg + "` to turn back on.", { parse_mode: "Markdown" });
      });
    } catch (e) {
      console.error("[v4 /mute]", e);
      await ctx.reply("Couldn't update mute setting.").catch(() => {});
    }
  });

  bot.command("unmute", async (ctx) => {
    try {
      const arg = (ctx.match || "").toString().trim().toLowerCase();
      const valid = ["bills", "pace", "milestones", "all"];
      if (!valid.includes(arg)) {
        await ctx.reply("Use `/unmute bills`, `/unmute pace`, `/unmute milestones`, or `/unmute all`.", { parse_mode: "Markdown" });
        return;
      }
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      await db.withUserLock(u.id, async () => {
        const state = await db.loadState(prisma, u.id);
        if (!state.mute) state.mute = {};
        if (arg === "all") {
          state.mute.bills = state.mute.pace = state.mute.milestones = false;
        } else {
          state.mute[arg] = false;
        }
        await db.saveState(prisma, u.id, state);
        await ctx.reply("✓ Unmuted " + arg + ".");
      });
    } catch (e) {
      console.error("[v4 /unmute]", e);
      await ctx.reply("Couldn't update mute setting.").catch(() => {});
    }
  });

  bot.command("voice", async (ctx) => {
    try {
      const arg = (ctx.match || "").toString().trim().toLowerCase();
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      await db.withUserLock(u.id, async () => {
        const state = await db.loadState(prisma, u.id);
        if (arg === "on") {
          state.voiceReplies = true;
          await db.saveState(prisma, u.id, state);
          await ctx.reply("✓ Voice replies on. I'll speak when you speak.", { reply_markup: mainKeyboard() });
        } else if (arg === "off") {
          state.voiceReplies = false;
          await db.saveState(prisma, u.id, state);
          await ctx.reply("✓ Voice replies off.", { reply_markup: mainKeyboard() });
        } else {
          await ctx.reply("Voice replies are " + (state.voiceReplies ? "on" : "off") + ". Use `/voice on` or `/voice off`.", {
            parse_mode: "Markdown", reply_markup: mainKeyboard(),
          });
        }
      });
    } catch (e) {
      console.error("[v4 /voice]", e);
      await ctx.reply("Couldn't update voice setting.").catch(() => {});
    }
  });

  bot.command("today", async (ctx) => {
    try {
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      const state = await db.loadState(prisma, u.id);
      if (!state.setup) {
        await ctx.reply("Not set up yet — say hi and tell me your balance.", { reply_markup: mainKeyboard() });
        return;
      }
      // Just the hero. Nothing else. The daily ritual.
      await ctx.reply(heroLine(state), { parse_mode: "Markdown", reply_markup: mainKeyboard() });
    } catch (e) {
      console.error("[v4 /today]", e);
      await ctx.reply("Couldn't load that.").catch(() => {});
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "*SpendYes — what I do*\n\n" +
      PROMISE + "\n\n" +
      "Just talk to me about your money — text or voice. I'll show a confirm card before anything changes.\n\n" +
      "*Commands*\n" +
      "/start — say hi or set up\n" +
      "/today — just the hero number\n" +
      "/app — open your dashboard\n" +
      "/undo — roll back my last action\n" +
      "/voice on|off — talk back when you talk to me\n" +
      "/reset — wipe everything (asks first)",
      { parse_mode: "Markdown", reply_markup: mainKeyboard() }
    );
  });

  bot.command("undo", async (ctx) => {
    try {
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      await db.withUserLock(u.id, async () => {
        const state = await db.loadState(prisma, u.id);
        if (!state.setup || !Array.isArray(state.events) || state.events.length <= 1) {
          await ctx.reply("Nothing to undo yet.", { reply_markup: mainKeyboard() });
          return;
        }
        const last = state.events[state.events.length - 1];
        if (last && last.intent && last.intent.kind === "setup_account") {
          await ctx.reply("Can't undo setup — say /reset to wipe everything instead.", { reply_markup: mainKeyboard() });
          return;
        }
        try {
          const r = applyIntent(state, { kind: "undo_last", params: {} });
          await db.saveState(prisma, u.id, r.state);
          const sym = r.state.currencySymbol || "$";
          const undidIntent = r.event.undid && r.event.undid.intent;
          const desc = undidIntent ? fmtIntent(undidIntent, sym) : "last action";
          await ctx.reply("↶ Undone: " + desc + "\n" + heroLine(r.state, sym), {
            parse_mode: "Markdown",
            reply_markup: mainKeyboard(),
          });
        } catch (e) {
          await ctx.reply("Couldn't undo: " + e.message).catch(() => {});
        }
      });
    } catch (e) {
      console.error("[v4 /undo]", e);
      await ctx.reply("Something went wrong with undo.").catch(() => {});
    }
  });

  bot.command("app", async (ctx) => {
    const url = process.env.MINIAPP_URL;
    if (!url) return ctx.reply("Mini App is not configured.");
    await ctx.reply("Open your dashboard:", {
      reply_markup: {
        inline_keyboard: [[{ text: "📊 Open Dashboard", web_app: { url } }]],
      },
    });
  });

  bot.command("reset", async (ctx) => {
    const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
    const token = setPending([{ kind: "reset", params: {} }], u.id);
    await ctx.reply("This will erase everything. Confirm?", {
      ...confirmCard(token, { yesLabel: "Yes, wipe it" }),
    });
  });

  bot.hears(/^(How am I doing\?|how am i doing)/i, async (ctx) => {
    await processText(prisma, ctx, ctx.from.id, "How am I doing?");
  });

  bot.on("message:text", async (ctx) => {
    try {
      const text = ctx.message.text;
      if (!text || text.startsWith("/")) return; // commands handled above
      if (text.length > 2000) return ctx.reply("That message is too long — keep it under 2000 chars.");

      // Deterministic onboarding intercept: fresh users sending a greeting
      // get a hardcoded warm welcome that asks for balance. Reliable —
      // doesn't depend on the AI following a prompt rule.
      if (GREETING_PATTERNS.test(text)) {
        const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
        const state = await db.loadState(prisma, u.id);
        if (!state.setup) {
          await ctx.reply(welcomeMessage(), {
            parse_mode: "Markdown",
            reply_markup: mainKeyboard(),
          });
          return;
        }
      }

      await processText(prisma, ctx, ctx.from.id, text);
    } catch (e) {
      console.error("[v4 text]", e);
      await ctx.reply("Hmm, something went wrong. Try again?").catch(() => {});
    }
  });

  bot.on("message:voice", async (ctx) => {
    if (!process.env.OPENAI_API_KEY) return ctx.reply("Voice not enabled.");
    let statusMsg;
    try { statusMsg = await ctx.reply("🎙"); } catch {}
    const typing = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 4000);
    try {
      const file = await ctx.getFile();
      const url = "https://api.telegram.org/file/bot" + BOT_TOKEN + "/" + file.file_path;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(url, { signal: ctrl.signal });
      const buf = Buffer.from(await resp.arrayBuffer());
      clearTimeout(t);
      const audioFile = await toFile(buf, "voice.ogg", { type: "audio/ogg" });
      const tr = await openai.audio.transcriptions.create({ file: audioFile, model: "whisper-1" }, { timeout: 15000 });
      const text = (tr.text || "").slice(0, 2000);
      if (statusMsg) ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      if (!text) return ctx.reply("Couldn't catch that — try again?");
      await processText(prisma, ctx, ctx.from.id, text, { isVoice: true });
    } catch (e) {
      console.error("[v4 voice]", e);
      if (statusMsg) ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "Couldn't process voice — try again?").catch(() => {});
      else ctx.reply("Couldn't process voice — try again?").catch(() => {});
    } finally {
      clearInterval(typing);
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data || "";
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      // Undo button — independent flow from confirm tokens.
      if (data.startsWith("undo:")) {
        const token = data.slice(5);
        const entry = takeUndoToken(token);
        if (!entry) {
          await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
          await ctx.reply("That undo expired — say /undo to roll back the latest.", { reply_markup: mainKeyboard() }).catch(() => {});
          return;
        }
        const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
        if (entry.userId !== u.id) {
          await ctx.reply("That wasn't yours.").catch(() => {});
          return;
        }
        await db.withUserLock(u.id, async () => {
          const state = await db.loadState(prisma, u.id);
          const last = state.events && state.events.length ? state.events[state.events.length - 1] : null;
          if (!last || last.id !== entry.eventId) {
            await ctx.reply("Other things happened since — say /undo to roll back the latest.", { reply_markup: mainKeyboard() }).catch(() => {});
            return;
          }
          try {
            const r = applyIntent(state, { kind: "undo_last", params: {} });
            await db.saveState(prisma, u.id, r.state);
            const sym = r.state.currencySymbol || "$";
            const undidIntent = r.event.undid && r.event.undid.intent;
            const desc = undidIntent ? fmtIntent(undidIntent, sym) : "last action";
            // Strip the Undo button on the original message.
            await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
            await ctx.reply("↶ Undone: " + desc + "\n" + heroLine(r.state, sym), { parse_mode: "Markdown", reply_markup: mainKeyboard() }).catch(() => {});
          } catch (e) {
            await ctx.reply("Couldn't undo: " + e.message).catch(() => {});
          }
        });
        return;
      }

      if (!data.startsWith("yes:") && !data.startsWith("no:")) return;
      const isYes = data.startsWith("yes:");
      const token = data.slice(4);
      const entry = takePending(token);
      if (!entry) {
        await ctx.editMessageText("That request expired. Try again?").catch(() => {});
        return;
      }
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      if (entry.userId !== u.id) {
        await ctx.editMessageText("Hmm, that wasn't yours.").catch(() => {});
        return;
      }
      if (!isYes) {
        // Cancel: drops the rest of the queue too. User can re-describe.
        const wasInQueue = entry.queueAfter && entry.queueAfter.length > 0;
        await ctx.editMessageText(wasInQueue ? "Stopped — nothing else changed." : "Cancelled.").catch(() => {});
        return;
      }
      // Yes → apply each pending intent in order under one lock.
      // Then, if a queue exists, present the NEXT confirm card.
      await db.withUserLock(u.id, async () => {
        let state = await db.loadState(prisma, u.id);
        const applied = [];
        try {
          for (const intent of entry.intents) {
            const r = applyIntent(state, intent);
            state = r.state;
            applied.push(intent);
          }
          await db.saveState(prisma, u.id, state);
          const sym = state.currencySymbol || "$";
          const wasReset = applied.some(i => i && i.kind === "reset");

          if (wasReset) {
            // Special case: after a reset, don't show "✓ Done" then leave
            // the user staring at a void. Acknowledge the reset and
            // immediately kick off onboarding with the warm welcome.
            await ctx.editMessageText("✓ Wiped clean.", { parse_mode: "Markdown" }).catch(() => {});
            await ctx.reply(welcomeMessage(), {
              parse_mode: "Markdown",
              reply_markup: mainKeyboard(),
            });
            // Clear conversation history so AI doesn't carry over old turns.
            await db.appendHistory(prisma, u.id, "system", "[user reset — fresh start]").catch(() => {});
            return;
          }

          const lines = applied.map(i => "✓ " + fmtIntent(i, sym));

          // QUEUE ADVANCEMENT: if there are more intents queued, validate the
          // next one and present a fresh confirm card. Auto-applies are
          // applied silently and we keep walking; rejections are reported
          // and we keep walking; confirms become the new card.
          let nextQueue = (entry.queueAfter || []).slice();
          let nextIndex = (entry.queueIndex || 1) + 1;
          const total = entry.queueTotal || 1;
          let nextConfirmIntent = null;
          let nextConfirmVerdict = null;
          const queueRejections = [];

          while (nextQueue.length > 0) {
            const candidate = nextQueue.shift();
            const verdict = validateIntent(state, candidate, m.today(state.timezone || "UTC"));
            if (!verdict.ok) {
              queueRejections.push("Skipped: " + verdict.reason);
              nextIndex++;
              continue;
            }
            if (verdict.severity === "auto") {
              try {
                const r = applyIntent(state, candidate);
                state = r.state;
                applied.push(candidate);
                nextIndex++;
              } catch (e) {
                queueRejections.push("Couldn't apply: " + e.message);
                nextIndex++;
              }
              continue;
            }
            // confirm tier — pause and show this card
            nextConfirmIntent = candidate;
            nextConfirmVerdict = verdict;
            break;
          }

          // Persist any auto-applies that ran during queue walk
          if (applied.length > entry.intents.length) {
            await db.saveState(prisma, u.id, state);
          }

          // Edit the original card to a tight summary
          const summary = lines.concat(queueRejections.map(r => "_" + r + "_")).join("\n");
          await ctx.editMessageText(summary, { parse_mode: "Markdown" }).catch(() => {});

          if (nextConfirmIntent) {
            // Present the next queued confirm
            const newToken = setPending([nextConfirmIntent], u.id, {
              queueAfter: nextQueue,
              queueTotal: total,
              queueIndex: nextIndex,
            });
            const stepLabel = "*Step " + nextIndex + " of " + total + "*\n";
            const cardText = stepLabel + fmtIntent(nextConfirmIntent, sym) +
              (nextConfirmVerdict.reason && nextConfirmVerdict.reason !== "Set up your account?"
                ? "\n_" + nextConfirmVerdict.reason + "_" : "");
            const yesLabel = (nextIndex < total) ? "Confirm · next" : "Confirm";
            const noLabel = "Skip";
            await ctx.reply(cardText, { parse_mode: "Markdown", ...confirmCard(newToken, { yesLabel, noLabel }) });
            return;
          }

          // No more queued items — final summary message with hero line
          const lastEventId = state.events && state.events.length
            ? state.events[state.events.length - 1].id
            : null;
          const finalLines = [];
          if (total > 1) finalLines.push("*All set.*");
          finalLines.push(heroLine(state, sym));
          const finalOpts = { parse_mode: "Markdown" };
          if (lastEventId) {
            finalOpts.reply_markup = undoButton(setUndoToken(lastEventId, u.id)).reply_markup;
          }
          await ctx.reply(finalLines.join("\n"), finalOpts);
        } catch (e) {
          console.error("[v4 confirm apply]", e);
          await ctx.editMessageText("Couldn't apply that: " + e.message).catch(() => {});
        }
      });
    } catch (e) {
      console.error("[v4 callback]", e);
    }
  });
}

// ── PROACTIVE SCHEDULER ─────────────────────────────────
// Runs every hour. Fires only at 9 AM user-local. Hard rate-limit: 1
// proactive message per user per ~24 hours, even if multiple eligible.
const PROACTIVE_HOUR = 9;
const PROACTIVE_MIN_INTERVAL_MS = 23 * 60 * 60 * 1000;

async function runProactive(prisma) {
  if (!bot) return;
  let users;
  try {
    users = await prisma.user.findMany({
      where: { telegramId: { not: null } },
      select: { id: true, telegramId: true },
    });
  } catch (e) {
    console.error("[v4 proactive] user fetch failed:", e.message);
    return;
  }
  let sent = 0;
  for (const u of users) {
    if (!u.telegramId) continue;
    try {
      await db.withUserLock(u.id, async () => {
        const state = await db.loadState(prisma, u.id);
        if (!state.setup) return;
        const tz = state.timezone || "UTC";
        const hour = proactive.localHour(tz);
        if (hour !== PROACTIVE_HOUR) return;
        // Hard rate limit
        const lastAt = state.proactiveLastSentAt || 0;
        if (Date.now() - lastAt < PROACTIVE_MIN_INTERVAL_MS) return;
        const all = proactive.decideProactive(state, m.today(tz));
        const pick = proactive.pickMostImportant(all);
        if (!pick) return;
        try {
          await bot.api.sendMessage(u.telegramId, pick.text + "\n" + heroLine(state), {
            parse_mode: "Markdown",
            reply_markup: mainKeyboard(),
          });
          let next = proactive.markSent(state, [pick]);
          next.proactiveLastSentAt = Date.now();
          await db.saveState(prisma, u.id, next);
          sent++;
        } catch (e) {
          console.error("[v4 proactive send]", u.telegramId, e.message);
        }
      });
    } catch (e) {
      console.error("[v4 proactive user loop]", e.message);
    }
  }
  if (sent > 0) console.log("[v4 proactive] sent " + sent + " messages");
}

module.exports = { bot, attach, runProactive };
