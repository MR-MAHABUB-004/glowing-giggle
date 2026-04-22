"use strict";

module.exports = {
  config: {
    name:      "adminonly",
    aliases:   ["adminmode", "lockdown"],
    version:   "1.0",
    author:    "System",
    usePrefix: true,
    role:      1,
    category:  "admin",
    countDown: 5,
    description: { en: "Restrict all bot commands to group admins only" },
    guide:       { en: "{pn} on — lock commands to admins\n{pn} off — allow everyone" },
  },

  langs: {
    en: {
      notGroup: "❌ Only usable in groups.",
      on:       "🔒 Admin-only mode *enabled*. Only admins can use commands.",
      off:      "🔓 Admin-only mode *disabled*. Everyone can use commands.",
      status:   "ℹ️ Admin-only mode is currently *%1*.",
      usage:    "Usage: `/adminonly on` or `/adminonly off`",
    },
  },

  onStart: async function ({ event, message, args, getLang, threadsData }) {
    if (!event.isGroup) return message.reply(getLang("notGroup"));

    const chatId = event.threadID;
    const action = args[0]?.toLowerCase();

    if (!action) {
      const thread = threadsData.getOrCreate(chatId);
      const state  = thread.adminOnly ? "enabled" : "disabled";
      return message.reply(getLang("status").replace("%1", state));
    }

    if (action === "on") {
      threadsData.set(chatId, "adminOnly", true);
      return message.reply(getLang("on"));
    }

    if (action === "off") {
      threadsData.set(chatId, "adminOnly", false);
      return message.reply(getLang("off"));
    }

    return message.reply(getLang("usage"));
  },
};
