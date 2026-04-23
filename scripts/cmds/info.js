"use strict";

const os = require("os");

module.exports = {
  config: {
    name:      "i",
    aliases:   ["uptime", "p", "s"],
    version:   "1.0",
    author:    "System",
    usePrefix: true,
    role:      0,
    category:  "info",
    countDown: 5,
    description: { en: "Show bot status, uptime and system info" },
    guide:       { en: "{pn}" },
  },

  langs: {
    en: {
      title: "🤖 *Bot Status*",
    },
  },

  onStart: async function ({ message, getLang }) {
    const { config, commands, eventCommands, startTime, bot } = global.GoatBot;

    if (!global._botInfo) {
      try { global._botInfo = await bot.getMe(); } catch { global._botInfo = {}; }
    }

    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const d  = Math.floor(uptimeSec / 86400);
    const h  = Math.floor((uptimeSec % 86400) / 3600);
    const m  = Math.floor((uptimeSec % 3600) / 60);
    const s  = uptimeSec % 60;

    const totalMem = os.totalmem();
    const usedMem  = totalMem - os.freemem();
    const memPct   = Math.round((usedMem / totalMem) * 100);

    const ping = Date.now();

    return message.reply(
      `${getLang("title")}\n\n` +
      `🏷 *Name:* ${config.botName}\n` +
      `👤 *Username:* @${global._botInfo.username || "unknown"}\n` +
      `⏱ *Uptime:* ${d}d ${h}h ${m}m ${s}s\n` +
      `📦 *Commands:* ${commands.size}\n` +
      `⚡ *Events:* ${eventCommands.size}\n` +
      `💾 *Memory:* ${Math.round(usedMem / 1024 / 1024)}MB / ${Math.round(totalMem / 1024 / 1024)}MB (${memPct}%)\n` +
      `🖥 *Platform:* ${os.platform()} ${os.arch()}\n` +
      `🟢 *Status:* Online`
    );
  },
};
