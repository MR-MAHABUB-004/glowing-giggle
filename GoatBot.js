"use strict";

/**
 * GoatBot.js  —  Main entry point
 *
 * Startup order:
 *  1. Validate config
 *  2. Initialise global.GoatBot (mirrors GoatBot V2 globals)
 *  3. Load commands + events
 *  4. Start Telegram bot (polling or webhook)
 *  5. Start Express dashboard
 */

process.on("uncaughtException",  err => log.error("PROCESS", err.message || err));
process.on("unhandledRejection", err => log.error("PROCESS", String(err)));

const fs      = require("fs");
const path    = require("path");
const express = require("express");
const figlet  = require("figlet");
const chalk   = require("chalk");
const TelegramBot = require("node-telegram-bot-api");

const log    = require("./logger/log.js");
const config = require("./config.json");

// ── GLOBAL GoatBot STATE ──────────────────────────────────────────────────────
global.GoatBot = {
  startTime:           Date.now(),
  commands:            new Map(),   // name → cmd module
  eventCommands:       new Map(),   // name → event module
  aliases:             new Map(),   // alias → name
  onChat:              [],          // [{ name, fn }]
  onReply:             new Map(),   // name → fn
  onReaction:          new Map(),   // name → fn
  config,
  bot:                 null,        // set below
};

// ── INJECT GLOBAL UTILS ───────────────────────────────────────────────────────
global.utils = require("./core/utils.js");

// ── VALIDATE CONFIG ───────────────────────────────────────────────────────────
if (!config.botToken || config.botToken === "YOUR_BOT_TOKEN_HERE") {
  console.error(chalk.red("❌  Please set your bot token in config.json"));
  process.exit(1);
}

// ── LOAD COMMANDS + EVENTS ────────────────────────────────────────────────────
const { loadCommands } = require("./core/loadCommands.js");
const { loadEvents }   = require("./core/loadEvents.js");
loadCommands();
loadEvents();

// ── START BOT ─────────────────────────────────────────────────────────────────
let bot;

if (config.useWebhook && config.webhookUrl) {
  log.info("BOT", "Starting in Webhook mode");
  bot = new TelegramBot(config.botToken);
  const cleanUrl = config.webhookUrl.replace(/\/+$/, "");
  bot.setWebHook(`${cleanUrl}/bot${config.botToken}`);
} else {
  log.info("BOT", "Starting in Polling mode");
  bot = new TelegramBot(config.botToken, { polling: true });
}

global.GoatBot.bot = bot;
global.bot         = bot;

// ── REGISTER HANDLERS ─────────────────────────────────────────────────────────
const {
  handleMessage,
  handleCallbackQuery,
  handleJoin,
  handleLeave,
} = require("./core/handleMessage.js");

bot.on("message",          msg   => handleMessage(bot, msg));
bot.on("new_chat_members", msg   => handleJoin(bot, msg));
bot.on("left_chat_member", msg   => handleLeave(bot, msg));
bot.on("callback_query",   query => handleCallbackQuery(bot, query));
bot.on("polling_error",    err   => log.error("POLLING", err.message));

// ── BROADCAST HELPER ──────────────────────────────────────────────────────────
const { threadsData } = require("./core/database.js");

global.broadcast = async function broadcast(text, opts = {}) {
  const all = Object.values(threadsData.getAll());
  let sent = 0, failed = 0;
  for (const chat of all) {
    try {
      await bot.sendMessage(chat.id, text, { parse_mode: "Markdown", ...opts });
      sent++;
      await new Promise(r => setTimeout(r, 50)); // rate limit buffer
    } catch {
      failed++;
    }
  }
  log.info("BROADCAST", `Done — sent:${sent} failed:${failed}`);
  return { sent, failed };
};

// ── EXPRESS DASHBOARD ─────────────────────────────────────────────────────────
const app  = express();
const port = process.env.PORT || config.port || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Webhook endpoint
if (config.useWebhook) {
  app.post(`/bot${config.botToken}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

// Live stats API
const os = require("os");
app.get("/api/stats", async (req, res) => {
  const uptimeSec = Math.floor((Date.now() - global.GoatBot.startTime) / 1000);
  const d = Math.floor(uptimeSec / 86400);
  const h = Math.floor((uptimeSec % 86400) / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;

  if (!global._botInfo) {
    try { global._botInfo = await bot.getMe(); } catch { global._botInfo = {}; }
  }

  const allChats  = Object.values(threadsData.getAll());
  const groups    = allChats.filter(c => c.type === "group" || c.type === "supergroup");
  const privates  = allChats.filter(c => c.type === "private");
  const totalMem  = os.totalmem();
  const usedMem   = totalMem - os.freemem();

  res.json({
    ok:      true,
    uptime:  `${d}d ${h}h ${m}m ${s}s`,
    bot:     { username: global._botInfo.username, id: global._botInfo.id },
    counts:  { total: allChats.length, groups: groups.length, users: privates.length },
    commands: global.GoatBot.commands.size,
    events:   global.GoatBot.eventCommands.size,
    memory:  { used: Math.round(usedMem / 1024 / 1024), total: Math.round(totalMem / 1024 / 1024) },
  });
});

app.get("/", (req, res) => {
  const htmlPath = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
  res.send(`<h2>${config.botName} is running ✅</h2>`);
});

app.listen(port, () => log.success("SERVER", `Dashboard running on port ${port}`));

// ── BANNER ────────────────────────────────────────────────────────────────────
figlet(config.botName, { font: "Slant" }, (err, data) => {
  if (!err) console.log(chalk.cyan.bold(data));
  log.success("BOOT", `${config.botName} started with ${global.GoatBot.commands.size} commands, ${global.GoatBot.eventCommands.size} events`);
});
