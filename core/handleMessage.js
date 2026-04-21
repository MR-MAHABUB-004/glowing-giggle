"use strict";

/**
 * core/handleMessage.js
 * The main dispatcher for incoming Telegram messages.
 *
 * Flow (mirrors GoatBot):
 *  1. Record session
 *  2. Check blacklist
 *  3. Build event + message API objects
 *  4. Check whitelist mode
 *  5. Dispatch to matching command (by prefix+name or no-prefix match)
 *  6. Run all onChat handlers
 *  7. Run all onEvent handlers (events triggered on every message)
 */

const path = require("path");
const log  = require("../logger/log.js");
const {
  getPrefix,
  getUserRole,
  buildMessageAPI,
  buildEventObject,
  makeLangGetter,
  escapeRegex,
} = require("./utils.js");
const { threadsData, usersData, globalData } = require("./database.js");
const config = require("../config.json");

// ── COOLDOWN STORE ────────────────────────────────────────────────────────────
const cooldowns = new Map();

function checkCooldown(userId, cmdName, seconds) {
  const key  = `${userId}:${cmdName}`;
  const last = cooldowns.get(key) || 0;
  const now  = Date.now();
  const diff = now - last;
  if (diff < seconds * 1000) {
    return Math.ceil((seconds * 1000 - diff) / 1000);
  }
  cooldowns.set(key, now);
  return 0;
}

// ── PENDING REPLY MAP ─────────────────────────────────────────────────────────
// Maps "chatId:userId" → { commandName, data, ... }
const pendingReplies = new Map();

function setPendingReply(chatId, userId, cmdName, extra = {}) {
  pendingReplies.set(`${chatId}:${userId}`, { commandName: cmdName, ...extra });
}

function getPendingReply(chatId, userId) {
  return pendingReplies.get(`${chatId}:${userId}`) || null;
}

function clearPendingReply(chatId, userId) {
  pendingReplies.delete(`${chatId}:${userId}`);
}

// ── SAFE EXECUTOR ─────────────────────────────────────────────────────────────
async function safeRun(label, fn) {
  try {
    await fn();
  } catch (err) {
    log.error(label, err.message || String(err));
  }
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
async function handleMessage(bot, msg) {
  if (!msg || !msg.from) return;

  const chatId   = String(msg.chat.id);
  const userId   = String(msg.from.id);
  const text     = msg.text || msg.caption || "";

  // ── 1. Record thread + user in DB ─────────────────────────────────────────
  threadsData.getOrCreate(chatId, {
    title:     msg.chat.title || msg.chat.first_name || "",
    type:      msg.chat.type,
    username:  msg.chat.username || null,
  });

  usersData.getOrCreate(userId, {
    name:      `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim(),
    username:  msg.from.username || null,
  });

  // ── 2. Blacklist check ────────────────────────────────────────────────────
  const blacklistUsers = config.blackList?.users?.map(String) || [];
  const blacklistChats = config.blackList?.chats?.map(String) || [];
  if (blacklistUsers.includes(userId) || blacklistChats.includes(chatId)) return;

  // ── 3. Whitelist mode ─────────────────────────────────────────────────────
  if (config.whiteListMode?.enabled) {
    const allowed = config.whiteListMode.allowedChatIds?.map(String) || [];
    if (!allowed.includes(chatId) && !config.adminBot.map(String).includes(userId)) return;
  }

  // ── 4. Build GoatBot-style objects ────────────────────────────────────────
  const event   = buildEventObject(msg);
  const message = buildMessageAPI(bot, msg);
  const role    = await getUserRole(bot, msg);
  const prefix  = getPrefix(chatId);

  // Shared context injected into every command/event handler
  const ctx = {
    api:          bot,
    event,
    message,
    role,
    threadsData,
    usersData,
    globalData,
    prefix,
    // Helper used by commands: setPendingReply / getPendingReply
    setPendingReply: (cmdName, extra) => setPendingReply(chatId, userId, cmdName, extra),
    clearPendingReply: () => clearPendingReply(chatId, userId),
  };

  // ── 5. Check onReply (pending reply waiting for user input) ───────────────
  if (msg.reply_to_message) {
    const pending = getPendingReply(chatId, userId);
    if (pending) {
      const { commands } = global.GoatBot;
      const cmd = commands.get(pending.commandName);
      if (cmd && typeof cmd.onReply === "function") {
        await safeRun(`onReply:${pending.commandName}`, async () => {
          const getLang = makeLangGetter(cmd.langs || {}, config.language);
          await cmd.onReply({
            ...ctx,
            getLang,
            args:       text.trim().split(/\s+/).slice(1),
            pendingData: pending,
          });
        });
        clearPendingReply(chatId, userId);
        return; // consumed by onReply
      }
    }
  }

  // ── 6. Command dispatch ───────────────────────────────────────────────────
  const { commands, aliases } = global.GoatBot;
  let matched = false;

  for (const [name, cmd] of commands) {
    const cfg         = cmd.config;
    const usePrefix   = cfg.usePrefix !== false; // default true
    const cmdNames    = [cfg.name, ...(cfg.aliases || [])].map(n => n.toLowerCase());
    const escapedCmds = cmdNames.map(escapeRegex).join("|");

    const pattern = usePrefix
      ? new RegExp(`^${escapeRegex(prefix)}\\s*(${escapedCmds})(?:\\s|$)`, "i")
      : new RegExp(`^(${escapedCmds})(?:\\s|$)`, "i");

    if (!pattern.test(text)) continue;

    matched = true;

    // Role check
    if (role < (cfg.role || 0)) {
      await message.reply("⛔ You don't have permission to use this command.");
      break;
    }

    // Cooldown check
    const cdSeconds = cfg.countDown ?? config.cooldownDefault ?? 3;
    const remaining = checkCooldown(userId, name, cdSeconds);
    if (remaining > 0) {
      await message.reply(`⏳ Please wait *${remaining}s* before using this command again.`);
      break;
    }

    // Parse args
    const args = text
      .replace(pattern, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    const getLang = makeLangGetter(cmd.langs || {}, config.language);

    log.cmd(name, `${msg.chat.type} | user:${userId} | chat:${chatId}`);

    await safeRun(`cmd:${name}`, async () => {
      await cmd.onStart?.({
        ...ctx,
        args,
        getLang,
      });
    });

    break;
  }

  // ── 7. onChat handlers (run on every message, even without commands) ───────
  const { onChat } = global.GoatBot;
  for (const { name, fn } of onChat) {
    const cmd     = commands.get(name);
    const getLang = makeLangGetter(cmd?.langs || {}, config.language);
    await safeRun(`onChat:${name}`, () => fn({ ...ctx, getLang }));
  }

  // ── 8. Event handlers (eventType: "message") ──────────────────────────────
  const { eventCommands } = global.GoatBot;
  for (const [evName, ev] of eventCommands) {
    const evType = ev.config?.eventType || "message";
    if (evType !== "message" && evType !== "*") continue;

    const getLang = makeLangGetter(ev.langs || {}, config.language);
    await safeRun(`event:${evName}`, () =>
      ev.onStart?.({ ...ctx, getLang })
    );
  }
}

// ── CALLBACK QUERY HANDLER ────────────────────────────────────────────────────
async function handleCallbackQuery(bot, query) {
  const { data, message, from } = query;
  const chatId  = String(message.chat.id);
  const userId  = String(from.id);
  const role    = await getUserRole(bot, { from, chat: message.chat });

  const event   = buildEventObject(message);
  event.callbackData = data;
  const msgAPI  = buildMessageAPI(bot, message);

  const ctx = {
    api: bot,
    event,
    message: msgAPI,
    role,
    threadsData,
    usersData,
    globalData,
    query,
  };

  // Let event handlers with eventType: "callback_query" handle it
  const { eventCommands, commands } = global.GoatBot;

  for (const [evName, ev] of eventCommands) {
    if (ev.config?.eventType !== "callback_query") continue;
    const getLang = makeLangGetter(ev.langs || {}, config.language);
    await safeRun(`callback_event:${evName}`, () =>
      ev.onStart?.({ ...ctx, getLang, callbackData: data })
    );
  }

  // Also check if any command has an onCallbackQuery handler
  for (const [name, cmd] of commands) {
    if (typeof cmd.onCallbackQuery === "function") {
      await safeRun(`callback_cmd:${name}`, () =>
        cmd.onCallbackQuery?.({ ...ctx, callbackData: data })
      );
    }
  }

  bot.answerCallbackQuery(query.id).catch(() => {});
}

// ── JOIN/LEAVE EVENT DISPATCHER ───────────────────────────────────────────────
async function handleJoin(bot, msg) {
  const { eventCommands } = global.GoatBot;
  const event   = buildEventObject(msg);
  event.newMembers = msg.new_chat_members;
  const message = buildMessageAPI(bot, msg);

  for (const [evName, ev] of eventCommands) {
    if (!["join", "*"].includes(ev.config?.eventType)) continue;
    const getLang = makeLangGetter(ev.langs || {}, config.language);
    await safeRun(`join_event:${evName}`, () =>
      ev.onStart?.({ api: bot, event, message, threadsData, usersData, globalData, getLang })
    );
  }
}

async function handleLeave(bot, msg) {
  const { eventCommands } = global.GoatBot;
  const event    = buildEventObject(msg);
  event.leftMember = msg.left_chat_member;
  const message  = buildMessageAPI(bot, msg);

  for (const [evName, ev] of eventCommands) {
    if (!["leave", "*"].includes(ev.config?.eventType)) continue;
    const getLang = makeLangGetter(ev.langs || {}, config.language);
    await safeRun(`leave_event:${evName}`, () =>
      ev.onStart?.({ api: bot, event, message, threadsData, usersData, globalData, getLang })
    );
  }
}

module.exports = {
  handleMessage,
  handleCallbackQuery,
  handleJoin,
  handleLeave,
  setPendingReply,
  getPendingReply,
  clearPendingReply,
};
