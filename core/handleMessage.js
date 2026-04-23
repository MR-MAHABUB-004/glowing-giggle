"use strict";

/**
 * core/handleMessage.js
 * Main message dispatcher — GoatBot V2 style for Telegram.
 *
 * Ported features from GoatBot's handlerListenMessage.js:
 *   ✅ onAnyEvent      — fires on every single event
 *   ✅ onFirstChat     — fires only the first time a user messages the bot
 *   ✅ onChat          — fires on every message (passive handlers)
 *   ✅ onStart         — fires when a command is matched
 *   ✅ onReply         — fires on next user message after setPendingReply()
 *   ✅ onEvent         — fires on join/leave events
 *   ✅ onReaction      — fires when a message is liked/reacted
 *   ✅ approval system — thread must be approved before bot responds
 *   ✅ antiInbox       — ignore private (DM) messages if enabled
 *   ✅ reactBy         — admin can kick/delete via reaction
 *   ✅ onCallbackQuery — inline button handler
 */

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

// ── COOLDOWN ──────────────────────────────────────────────────────────────────
const cooldowns = new Map();
function checkCooldown(userId, cmdName, seconds) {
  const key  = `${userId}:${cmdName}`;
  const last = cooldowns.get(key) || 0;
  const now  = Date.now();
  if (now - last < seconds * 1000)
    return Math.ceil((seconds * 1000 - (now - last)) / 1000);
  cooldowns.set(key, now);
  return 0;
}

// ── PENDING REPLY ─────────────────────────────────────────────────────────────
// Fires on user's NEXT message — no Telegram quote/reply needed (GoatBot style)
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

// ── FIRST CHAT TRACKER (in-memory, resets on restart) ─────────────────────────
const firstChatSeen = new Set(); // "chatId:userId"

// ── SAFE EXECUTOR ─────────────────────────────────────────────────────────────
async function safeRun(label, fn) {
  try { await fn(); }
  catch (err) { log.error(label, err.message || String(err)); }
}

// ── APPROVAL SYSTEM ───────────────────────────────────────────────────────────
// config.approval = true → bot only responds in approved chats
// Approved list stored in globalData under key "approved"
async function isApproved(chatId) {
  if (!config.approval) return true;
  try {
    const rec      = await globalData.get("approved") || {};
    const approved = Array.isArray(rec.approved) ? rec.approved : [];
    return approved.includes(String(chatId));
  } catch { return false; }
}

// ── SHARED CONTEXT BUILDER ────────────────────────────────────────────────────
function buildCtx(bot, msg, event, message, role, prefix) {
  const chatId = String(msg.chat?.id || event.threadID);
  const userId = String(msg.from?.id  || event.senderID);
  return {
    api:   bot,
    event,
    message,
    role,
    threadsData,
    usersData,
    globalData,
    prefix,
    setPendingReply:   (cmdName, extra) => setPendingReply(chatId, userId, cmdName, extra),
    clearPendingReply: ()               => clearPendingReply(chatId, userId),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────────────────────
async function handleMessage(bot, msg) {
  if (!msg || !msg.from) return;

  const chatId = String(msg.chat.id);
  const userId = String(msg.from.id);
  const text   = msg.text || msg.caption || "";

  // ── antiInbox — ignore private DMs if enabled ─────────────────────────────
  if (config.antiInbox && msg.chat.type === "private") return;

  // ── Record session ────────────────────────────────────────────────────────
  const existingUser = await usersData.getOrCreate(userId, {
    name:     `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim(),
    username: msg.from.username || null,
  });
  await usersData.update(userId, { messageCount: (existingUser.messageCount || 0) + 1 });

  await threadsData.getOrCreate(chatId, {
    title:    msg.chat.title || msg.chat.first_name || "",
    type:     msg.chat.type,
    username: msg.chat.username || null,
  });

  // ── Blacklist ─────────────────────────────────────────────────────────────
  const blUsers = config.blackList?.users?.map(String) || [];
  const blChats = config.blackList?.chats?.map(String) || [];
  if (blUsers.includes(userId) || blChats.includes(chatId)) return;

  // ── Whitelist mode ────────────────────────────────────────────────────────
  if (config.whiteListMode?.enabled) {
    const allowed = config.whiteListMode.allowedChatIds?.map(String) || [];
    if (!allowed.includes(chatId) && !config.adminBot.map(String).includes(userId)) return;
  }

  // ── Approval system ───────────────────────────────────────────────────────
  if (!(await isApproved(chatId))) return;

  // ── Build context objects ─────────────────────────────────────────────────
  const event   = buildEventObject(msg);
  const message = buildMessageAPI(bot, msg);
  const role    = await getUserRole(bot, msg);
  const prefix  = getPrefix(chatId);
  const ctx     = buildCtx(bot, msg, event, message, role, prefix);

  const { commands, onChat, eventCommands } = global.GoatBot;

  // ── onAnyEvent — fires on EVERY message ───────────────────────────────────
  for (const [evName, ev] of eventCommands) {
    if (ev.config?.eventType !== "anyEvent") continue;
    const getLang = makeLangGetter(ev.langs || {}, config.language);
    await safeRun(`anyEvent:${evName}`, () => ev.onStart?.({ ...ctx, getLang }));
  }

  // ── onFirstChat — fires only the FIRST time this user messages ────────────
  const firstKey = `${chatId}:${userId}`;
  if (!firstChatSeen.has(firstKey)) {
    firstChatSeen.add(firstKey);
    for (const [evName, ev] of eventCommands) {
      if (ev.config?.eventType !== "firstChat") continue;
      const getLang = makeLangGetter(ev.langs || {}, config.language);
      await safeRun(`firstChat:${evName}`, () => ev.onStart?.({ ...ctx, getLang }));
    }
    // Also call onFirstChat hook in commands that define it
    for (const [, cmd] of commands) {
      if (typeof cmd.onFirstChat === "function") {
        const getLang = makeLangGetter(cmd.langs || {}, config.language);
        await safeRun(`firstChat:cmd`, () => cmd.onFirstChat?.({ ...ctx, getLang }));
      }
    }
  }

  // ── onReply — user's next message after setPendingReply() ─────────────────
  const pending = getPendingReply(chatId, userId);
  if (pending) {
    const cmd = commands.get(pending.commandName);
    if (cmd && typeof cmd.onReply === "function") {
      // If user typed a new command, cancel pending and fall through
      const isNewCmd = [...commands.values()].some(c => {
        const names   = [c.config.name, ...(c.config.aliases || [])].map(n => n.toLowerCase());
        const escaped = names.map(escapeRegex).join("|");
        const pat     = c.config.usePrefix !== false
          ? new RegExp(`^${escapeRegex(prefix)}\\s*(${escaped})(?:\\s|$)`, "i")
          : new RegExp(`^(${escaped})(?:\\s|$)`, "i");
        return pat.test(text);
      });

      if (!isNewCmd) {
        await safeRun(`onReply:${pending.commandName}`, async () => {
          const getLang = makeLangGetter(cmd.langs || {}, config.language);
          await cmd.onReply({
            ...ctx, getLang,
            args:        text.trim().split(/\s+/).filter(Boolean),
            pendingData: pending,
          });
        });
        // Only clear if command didn't re-register a new pending
        if (getPendingReply(chatId, userId) === pending)
          clearPendingReply(chatId, userId);
        return;
      }
      clearPendingReply(chatId, userId);
    }
  }

  // ── Command dispatch (onStart) ────────────────────────────────────────────
  for (const [name, cmd] of commands) {
    const cfg       = cmd.config;
    const usePrefix = cfg.usePrefix !== false;
    const names     = [cfg.name, ...(cfg.aliases || [])].map(n => n.toLowerCase());
    const escaped   = names.map(escapeRegex).join("|");
    const pattern   = usePrefix
      ? new RegExp(`^${escapeRegex(prefix)}\\s*(${escaped})(?:\\s|$)`, "i")
      : new RegExp(`^(${escaped})(?:\\s|$)`, "i");

    if (!pattern.test(text)) continue;

    // Per-thread checks
    const threadCfg    = await threadsData.get(chatId);
    const disabledCmds = threadCfg?.disabledCmds || [];
    if (disabledCmds.includes(name)) break;
    if (threadCfg?.adminOnly && role < 1) break;

    // Role
    if (role < (cfg.role || 0)) {
      await message.reply("⛔ You don't have permission to use this command.");
      break;
    }

    // Cooldown
    const cdSec     = cfg.countDown ?? config.cooldownDefault ?? 3;
    const remaining = checkCooldown(userId, name, cdSec);
    if (remaining > 0) {
      await message.reply(`⏳ Please wait *${remaining}s* before using \`${prefix}${name}\` again.`);
      break;
    }

    const args    = text.replace(pattern, "").trim().split(/\s+/).filter(Boolean);
    const getLang = makeLangGetter(cmd.langs || {}, config.language);
    log.cmd(name, `${msg.chat.type} | user:${userId} | chat:${chatId}`);
    await safeRun(`cmd:${name}`, () => cmd.onStart?.({ ...ctx, args, getLang }));
    break;
  }

  // ── onChat handlers ───────────────────────────────────────────────────────
  for (const { name, fn } of onChat) {
    const cmd     = commands.get(name);
    const getLang = makeLangGetter(cmd?.langs || {}, config.language);
    await safeRun(`onChat:${name}`, () => fn({ ...ctx, getLang }));
  }

  // ── eventCommands: "message" and "*" ─────────────────────────────────────
  for (const [evName, ev] of eventCommands) {
    const evType = ev.config?.eventType || "message";
    if (evType !== "message" && evType !== "*") continue;
    const getLang = makeLangGetter(ev.langs || {}, config.language);
    await safeRun(`event:${evName}`, () => ev.onStart?.({ ...ctx, getLang }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REACTION HANDLER
// GoatBot reactBy: admin reacts with emoji → bot kicks user or deletes message
// ─────────────────────────────────────────────────────────────────────────────
async function handleReaction(bot, reaction) {
  // Telegram sends message_reaction updates (Bot API 7.0+)
  // reaction.user, reaction.chat, reaction.message_id, reaction.new_reaction[]
  const chatId    = String(reaction.chat?.id || "");
  const reactUser = String(reaction.user?.id || "");
  const msgId     = reaction.message_id;

  // Only bot admins can trigger reactBy actions
  if (!config.adminBot?.map(String).includes(reactUser)) return;

  const reactBy    = config.reactBy || {};
  const delEmojis  = reactBy.delete || [];
  const kickEmojis = reactBy.kick   || [];

  const emojis = (reaction.new_reaction || []).map(r => r.emoji || r.custom_emoji_id || "");

  const { commands, eventCommands } = global.GoatBot;

  // Build minimal ctx for onReaction handlers
  const miniCtx = {
    api:        bot,
    chatId,
    reactUser,
    msgId,
    emojis,
    threadsData,
    usersData,
    globalData,
  };

  // Fire onReaction hooks in commands
  for (const [, cmd] of commands) {
    if (typeof cmd.onReaction === "function") {
      await safeRun("onReaction:cmd", () => cmd.onReaction?.({ ...miniCtx }));
    }
  }

  // Fire onReaction event handlers
  for (const [evName, ev] of eventCommands) {
    if (ev.config?.eventType !== "reaction") continue;
    const getLang = makeLangGetter(ev.langs || {}, config.language);
    await safeRun(`onReaction:${evName}`, () => ev.onStart?.({ ...miniCtx, getLang }));
  }

  // ── reactBy: delete ───────────────────────────────────────────────────────
  // Admin reacts with a "delete" emoji → bot deletes that message
  if (emojis.some(e => delEmojis.includes(e))) {
    try { await bot.deleteMessage(chatId, msgId); } catch {}
  }

  // ── reactBy: kick ─────────────────────────────────────────────────────────
  // Admin reacts with a "kick" emoji → bot kicks the message sender
  if (emojis.some(e => kickEmojis.includes(e))) {
    try {
      // Get the message to find sender
      // We can't fetch message by ID on Telegram easily,
      // so we store it via the message_reaction update's actor
      // The "user" field here is WHO reacted (admin), not the message author.
      // To kick we need the original sender — store via onChat if needed.
      // For now: kick the user who is being reacted to (if stored in cache)
      const targetKey = `reactTarget:${chatId}:${msgId}`;
      const targetId  = global._reactTargets?.get(targetKey);
      if (targetId) {
        await bot.banChatMember(chatId, targetId);
        await bot.unbanChatMember(chatId, targetId, { only_if_banned: true });
      }
    } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CALLBACK QUERY HANDLER
// ─────────────────────────────────────────────────────────────────────────────
async function handleCallbackQuery(bot, query) {
  const { data, message, from } = query;
  const chatId = String(message.chat.id);
  const userId = String(from.id);
  const role   = await getUserRole(bot, { from, chat: message.chat });

  const event  = buildEventObject(message);
  event.callbackData = data;
  const msgAPI = buildMessageAPI(bot, message);

  const ctx = {
    api: bot, event, message: msgAPI, role,
    threadsData, usersData, globalData, query,
    setPendingReply:   (cmdName, extra) => setPendingReply(chatId, userId, cmdName, extra),
    clearPendingReply: ()               => clearPendingReply(chatId, userId),
  };

  const { eventCommands, commands } = global.GoatBot;

  for (const [, ev] of eventCommands) {
    if (ev.config?.eventType !== "callback_query") continue;
    const getLang = makeLangGetter(ev.langs || {}, config.language);
    await safeRun("cbq_event", () => ev.onStart?.({ ...ctx, getLang, callbackData: data }));
  }

  for (const [, cmd] of commands) {
    if (typeof cmd.onCallbackQuery !== "function") continue;
    await safeRun("cbq_cmd", () => cmd.onCallbackQuery?.({ ...ctx, callbackData: data }));
  }

  bot.answerCallbackQuery(query.id).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// JOIN / LEAVE / onEvent
// ─────────────────────────────────────────────────────────────────────────────
async function handleJoin(bot, msg) {
  const { eventCommands } = global.GoatBot;
  const event   = buildEventObject(msg);
  event.newMembers = msg.new_chat_members;
  const message = buildMessageAPI(bot, msg);
  const chatId  = String(msg.chat.id);

  const ctx = {
    api: bot, event, message,
    threadsData, usersData, globalData,
    setPendingReply:   () => {},
    clearPendingReply: () => {},
  };

  for (const [, ev] of eventCommands) {
    if (!["join", "event", "*"].includes(ev.config?.eventType)) continue;
    const getLang = makeLangGetter(ev.langs || {}, config.language);
    await safeRun("join", () => ev.onStart?.({ ...ctx, getLang }));
  }

  // onEvent in commands
  for (const [, cmd] of global.GoatBot.commands) {
    if (typeof cmd.onEvent === "function") {
      const getLang = makeLangGetter(cmd.langs || {}, config.language);
      await safeRun("onEvent:join", () => cmd.onEvent?.({ ...ctx, getLang }));
    }
  }
}

async function handleLeave(bot, msg) {
  const { eventCommands } = global.GoatBot;
  const event   = buildEventObject(msg);
  event.leftMember = msg.left_chat_member;
  const message = buildMessageAPI(bot, msg);

  const ctx = {
    api: bot, event, message,
    threadsData, usersData, globalData,
    setPendingReply:   () => {},
    clearPendingReply: () => {},
  };

  for (const [, ev] of eventCommands) {
    if (!["leave", "event", "*"].includes(ev.config?.eventType)) continue;
    const getLang = makeLangGetter(ev.langs || {}, config.language);
    await safeRun("leave", () => ev.onStart?.({ ...ctx, getLang }));
  }

  for (const [, cmd] of global.GoatBot.commands) {
    if (typeof cmd.onEvent === "function") {
      const getLang = makeLangGetter(cmd.langs || {}, config.language);
      await safeRun("onEvent:leave", () => cmd.onEvent?.({ ...ctx, getLang }));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  handleMessage,
  handleCallbackQuery,
  handleJoin,
  handleLeave,
  handleReaction,
  setPendingReply,
  getPendingReply,
  clearPendingReply,
};
