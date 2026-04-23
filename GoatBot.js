"use strict";

/**
 * GoatBot.js — Main entry point
 */

process.on("uncaughtException",  err => log.error("PROCESS", err.message || err));
process.on("unhandledRejection", err => log.error("PROCESS", String(err)));

const fs      = require("fs");
const path    = require("path");
const os      = require("os");
const express = require("express");
const figlet  = require("figlet");
const chalk   = require("chalk");
const TelegramBot = require("node-telegram-bot-api");

const log    = require("./logger/log.js");
const config = require("./config.json");

// ── GLOBAL GoatBot STATE (mirrors GoatBot V2) ─────────────────────────────────
global.GoatBot = {
  startTime:     Date.now(),
  commands:      new Map(),
  eventCommands: new Map(),
  aliases:       new Map(),
  onChat:        [],
  onReply:       new Map(),
  onReaction:    new Map(),
  config,
  bot:           null,
};

global.utils = require("./core/utils.js");

// ── VALIDATE CONFIG ───────────────────────────────────────────────────────────
if (!config.botToken || config.botToken === "YOUR_BOT_TOKEN_HERE") {
  console.error(chalk.red("\n❌  Set your bot token in config.json\n"));
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
  log.info("BOT", "Webhook mode");
  bot = new TelegramBot(config.botToken);
  bot.setWebHook(`${config.webhookUrl.replace(/\/+$/, "")}/bot${config.botToken}`);
} else {
  log.info("BOT", "Polling mode");
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
bot.on("polling_error",    err   => log.error("POLLING", err.code || err.message));

// ── BROADCAST HELPER ──────────────────────────────────────────────────────────
const { threadsData } = require("./core/database.js");

global.broadcast = async function(text, opts = {}) {
  const all = Object.values(await threadsData.getAll());
  let sent = 0, failed = 0;
  for (const chat of all) {
    try {
      await bot.sendMessage(chat.id, text, { parse_mode: "Markdown", ...opts });
      sent++;
      await new Promise(r => setTimeout(r, 50));
    } catch { failed++; }
  }
  log.info("BROADCAST", `sent:${sent} failed:${failed}`);
  return { sent, failed };
};

// ── EXPRESS DASHBOARD ─────────────────────────────────────────────────────────
const app  = express();
const port = process.env.PORT || config.port || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

if (config.useWebhook) {
  app.post(`/bot${config.botToken}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

app.get("/api/stats", async (req, res) => {
  const uptimeSec = Math.floor((Date.now() - global.GoatBot.startTime) / 1000);
  const d = Math.floor(uptimeSec / 86400);
  const h = Math.floor((uptimeSec % 86400) / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;

  if (!global._botInfo) {
    try { global._botInfo = await bot.getMe(); } catch { global._botInfo = {}; }
  }

  const allChats = Object.values(await threadsData.getAll());
  const groups   = allChats.filter(c => c.type === "group" || c.type === "supergroup");
  const privates = allChats.filter(c => c.type === "private");
  const totalMem = os.totalmem();
  const usedMem  = totalMem - os.freemem();

  res.json({
    ok:       true,
    uptime:   `${d}d ${h}h ${m}m ${s}s`,
    bot:      { username: global._botInfo.username, id: global._botInfo.id, name: global._botInfo.first_name },
    counts:   { total: allChats.length, groups: groups.length, users: privates.length },
    commands: global.GoatBot.commands.size,
    events:   global.GoatBot.eventCommands.size,
    memory:   { used: Math.round(usedMem / 1024 / 1024), total: Math.round(totalMem / 1024 / 1024), pct: Math.round((usedMem / totalMem) * 100) },
  });
});

app.get("/", (req, res) => {
  const htmlPath = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
  res.send(`<h2>✅ ${config.botName} is running</h2><p>Commands: ${global.GoatBot.commands.size}</p>`);
});

// Health check endpoint (used by keep-alive ping)
app.get("/ping", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.listen(port, () => {
  log.success("SERVER", `Dashboard on port ${port}`);

  // ── Keep-alive for Render free tier ────────────────────────────────────────
  const { keepAlive } = require("./bot/keepAlive.js");
  const pingUrl = config.webhookUrl || `http://localhost:${port}/ping`;
  keepAlive(pingUrl);
});

// ── BANNER ────────────────────────────────────────────────────────────────────
figlet(config.botName || "GoatBot", { font: "Slant" }, (err, data) => {
  if (!err) console.log(chalk.cyan.bold(data));
  log.success("BOOT", `${config.botName} — ${global.GoatBot.commands.size} commands | ${global.GoatBot.eventCommands.size} events`);
});
