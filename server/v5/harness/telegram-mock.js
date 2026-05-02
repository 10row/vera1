"use strict";
// telegram-mock.js — a fake Telegram chat. Captures every reply, edit,
// inline-keyboard click, callback answer. Renders a transcript exactly
// the way it'd look on a phone: messages in bubbles, edits show as
// "(edited)", inline buttons render as [button] tap-targets.
//
// The harness uses this to drive bot.js's processText / processCommand /
// processCallbackData with a real ctx-like object.

let nextMsgId = 1;

// Create a mock chat for a single user. Returns:
//   { ctx, transcript, getMessages, lastInlineButtons, tap, snapshot }
function createMockChat(opts) {
  const userId = opts && opts.userId ? opts.userId : 100001;
  const language_code = (opts && opts.language_code) || "en";
  const chatId = userId; // private chat == user id

  // Transcript is an append-only ordered log of events: messages, edits,
  // taps. Each entry has { dir, ts, ... } where dir is "→" (user) or
  // "←" (bot) or "·" (system).
  const transcript = [];

  // Messages by message_id (so edits can mutate them).
  const messages = new Map();

  function record(entry) {
    transcript.push(Object.assign({ ts: Date.now() }, entry));
  }

  function newMessage(from, text, extra) {
    const id = nextMsgId++;
    const msg = {
      message_id: id,
      from,
      text,
      reply_markup: extra && extra.reply_markup,
      parse_mode: extra && extra.parse_mode,
      edited: false,
    };
    messages.set(id, msg);
    return msg;
  }

  // The user's outgoing message — we record it and return a ctx-like
  // object the bot can use as if Telegram had delivered it.
  function makeIncomingTextCtx(text) {
    const msg = newMessage("user", text);
    record({ dir: "→", kind: "text", text, message_id: msg.message_id });
    return Object.assign({}, baseCtxFields(), {
      message: { text, message_id: msg.message_id },
      // Used by bot.command handlers — grammy passes ctx.message.text.
      messageText: text,
    });
  }

  function makeIncomingCallbackCtx(button, originatingMessageId) {
    const data = button.callback_data;
    const orig = messages.get(originatingMessageId);
    record({ dir: "→", kind: "tap", text: button.text, callback_data: data, on_message_id: originatingMessageId });
    return Object.assign({}, baseCtxFields(), {
      callbackQuery: {
        data,
        id: "cb" + Math.random(),
        message: orig ? { message_id: orig.message_id } : null,
      },
      // Bots edit "the message that contained the inline keyboard" —
      // we wire editMessageText / editMessageReplyMarkup to that message.
      _originatingMessageId: originatingMessageId,
    });
  }

  function baseCtxFields() {
    return {
      from: {
        id: userId,
        is_bot: false,
        first_name: "Tester",
        language_code,
      },
      chat: { id: chatId, type: "private" },

      // ── outbound: bot calls these ──
      reply: async (text, options) => {
        const msg = newMessage("bot", text, options);
        record({
          dir: "←", kind: "reply", text, message_id: msg.message_id,
          parse_mode: options && options.parse_mode,
          inline_keyboard: extractInlineKeyboard(options),
        });
        return msg;
      },
      replyWithChatAction: async () => {},
      answerCallbackQuery: async () => {},

      // editMessageText / editMessageReplyMarkup target the originating
      // message of a callback query.
      editMessageText: async (text, options) => {
        const msgId = currentEditTarget();
        const msg = messages.get(msgId);
        if (!msg) {
          // No matching message — record but no mutation.
          record({ dir: "·", kind: "edit_orphan", text });
          return;
        }
        msg.text = text;
        msg.edited = true;
        msg.reply_markup = options && options.reply_markup ? options.reply_markup : msg.reply_markup;
        record({
          dir: "←", kind: "edit", text,
          message_id: msg.message_id,
          inline_keyboard: extractInlineKeyboard({ reply_markup: msg.reply_markup }),
        });
      },
      editMessageReplyMarkup: async (options) => {
        const msgId = currentEditTarget();
        const msg = messages.get(msgId);
        if (!msg) return;
        msg.reply_markup = options && options.reply_markup ? options.reply_markup : null;
        record({
          dir: "←", kind: "edit_buttons", message_id: msg.message_id,
          inline_keyboard: extractInlineKeyboard({ reply_markup: msg.reply_markup }),
        });
      },

      // file/voice helpers — not used in scripted text scenarios but
      // present so bot code doesn't crash if it pokes them.
      getFile: async () => ({ file_path: null }),
      api: {
        sendMessage: async () => {},
        editMessageText: async () => {},
        deleteMessage: async () => {},
        setMyCommands: async () => {},
        setChatMenuButton: async () => {},
        unpinAllChatMessages: async () => {},
        unpinChatMessage: async () => {},
      },
    };
  }

  // Simple convention: when a callback ctx is created we tag it with
  // _originatingMessageId. The most-recently-created callback ctx is the
  // one currently being processed by the bot — track that for edit calls.
  let _currentEditTarget = null;
  function currentEditTarget() { return _currentEditTarget; }
  function setCurrentEditTarget(id) { _currentEditTarget = id; }

  // ── Public API ──
  return {
    // Drive: simulate the user sending a text message. Returns a ctx
    // the test can pass into processText.
    sendText: () => {
      throw new Error("Use harness.sendText, not chat.sendText directly");
    },
    makeIncomingTextCtx,
    makeIncomingCallbackCtx,
    setCurrentEditTarget,
    transcript,
    messages,
    user: { id: userId, language_code },

    // For the simulator: list inline buttons currently visible on the
    // most recent bot message (so the user can tap one).
    lastInlineButtons() {
      // Walk transcript backwards for last "←" reply or edit with buttons.
      for (let i = transcript.length - 1; i >= 0; i--) {
        const e = transcript[i];
        if (e.dir === "←" && e.inline_keyboard && e.inline_keyboard.length) {
          return { messageId: e.message_id, buttons: flattenButtons(e.inline_keyboard) };
        }
        if (e.dir === "←" && e.kind === "edit_buttons") {
          // If buttons were cleared by an edit, no buttons available.
          if (!e.inline_keyboard || e.inline_keyboard.length === 0) return null;
        }
      }
      return null;
    },
  };
}

function extractInlineKeyboard(options) {
  if (!options || !options.reply_markup || !options.reply_markup.inline_keyboard) return null;
  return options.reply_markup.inline_keyboard;
}

function flattenButtons(rows) {
  const out = [];
  for (const row of rows) for (const b of row) out.push(b);
  return out;
}

// Render a transcript as chat-like ASCII. Useful for human inspection
// AND for feeding to the LLM judge.
function renderTranscript(chat, opts) {
  const useColor = opts && opts.color;
  const W = (opts && opts.width) || 60;
  const lines = [];
  for (const e of chat.transcript) {
    if (e.dir === "→" && e.kind === "text") {
      lines.push("");
      lines.push(pad(W, "                              [you] ◄ " + truncate(e.text, 200)));
    } else if (e.dir === "→" && e.kind === "tap") {
      lines.push(pad(W, "                              [you tapped: " + e.text + "]"));
    } else if (e.dir === "←" && (e.kind === "reply" || e.kind === "edit")) {
      const prefix = e.kind === "edit" ? "(edit) " : "";
      const bodyLines = String(e.text || "").split("\n");
      lines.push("");
      lines.push("[bot] ► " + prefix + bodyLines[0]);
      for (let i = 1; i < bodyLines.length; i++) lines.push("       " + bodyLines[i]);
      if (e.inline_keyboard && e.inline_keyboard.length) {
        const buttonsLine = e.inline_keyboard.map(row => row.map(b => "[" + b.text + "]").join(" ")).join(" ");
        lines.push("       " + buttonsLine);
      }
    } else if (e.dir === "←" && e.kind === "edit_buttons") {
      // Just buttons changed (e.g. cleared after undo); not super useful in transcript.
    } else if (e.dir === "·") {
      lines.push("· " + (e.kind || "") + " " + (e.text || ""));
    }
  }
  return lines.join("\n");
}

function pad(w, s) { return s; }
function truncate(s, n) { s = String(s || ""); return s.length <= n ? s : s.slice(0, n) + "…"; }

module.exports = { createMockChat, renderTranscript };
