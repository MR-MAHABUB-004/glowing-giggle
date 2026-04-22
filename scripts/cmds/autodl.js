"use strict";

const fs    = require("fs");
const path  = require("path");
const axios = require("axios");

const TMP_DIR = path.join(__dirname, "../tmp");

module.exports = {
  config: {
    name:      "auto",
    aliases:   ["dl", "download"],
    version:   "5.4",
    author:    "MR᭄﹅ MAHABUB﹅ メꪜ",
    usePrefix: false,   // fires on any message containing a link — no prefix needed
    role:      0,
    category:  "media",
    countDown: 5,
    description: { en: "Auto video downloader — just send a link" },
    guide:       { en: "Just send any video link (TikTok, YouTube, Facebook, Instagram...)" },
  },

  langs: {
    en: {
      downloaded: "✅ 𝗗𝗼𝘄𝗻𝗹𝗼𝗮𝗱𝗲𝗱!\n\n📌 Platform: %1\n🎬 Title: %2",
      noLink:     "📥 Send the link to download the video 🎥",
      noVideo:    "❌ No downloadable video found for that link.",
    },
  },

  // /auto  →  tell user to send a link
  onStart: async function ({ message, getLang }) {
    return message.reply(getLang("noLink"));
  },

  // Fires on EVERY message — checks for a URL and downloads if found
  onChat: async function ({ api, event, message, getLang }) {
    const text = event.body?.trim();
    if (!text) return;

    const match = text.match(/(https?:\/\/[^\s]+)/);
    if (!match) return;

    const videoLink = match[0];

    // Only act on known video platforms to avoid triggering on random links
    const VIDEO_HOSTS = [
      "tiktok.com", "vm.tiktok.com",
      "youtube.com", "youtu.be",
      "facebook.com", "fb.watch",
      "instagram.com",
      "twitter.com", "x.com",
      "reddit.com",
    ];
    const isVideoLink = VIDEO_HOSTS.some(h => videoLink.includes(h));
    if (!isVideoLink) return;

    const apiBaseURL = "https://mahabub-apis.fun";  // ← comma instead of semicolon
    if (!apiBaseURL) return; // api base not configured — skip silently

    // Show downloading indicator
    await message.action("upload_video");

    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    // Fetch download info with retry
    async function fetchInfo(url, retries = 3) {
      for (let i = 1; i <= retries; i++) {
        try {
          const res = await axios.get(
            `${apiBaseURL}/mahabub/dl?url=${encodeURIComponent(url)}`,
            { timeout: 15000 }
          );
          return res.data;
        } catch (err) {
          if (i === retries) throw err;
          await wait(2000);
        }
      }
    }

    // Download file to tmp with retry
    async function downloadFile(downloadURL, filePath, retries = 3) {
      for (let i = 1; i <= retries; i++) {
        try {
          const res = await axios.get(downloadURL, {
            responseType: "stream",
            timeout: 60000,
            headers: { "User-Agent": "Mozilla/5.0" },
          });
          await new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(filePath);
            res.data.pipe(writer);
            writer.on("finish", resolve);
            writer.on("error", reject);
          });
          return;
        } catch (err) {
          if (i === retries) throw err;
          await wait(2000);
        }
      }
    }

    // Ensure tmp dir exists
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

    const filePath = path.join(TMP_DIR, `video_${Date.now()}.mp4`);

    try {
      const data = await fetchInfo(videoLink);
      const { platform, title, hd, sd } = data;
      const downloadURL = hd || sd;

      if (!downloadURL) {
        return message.reply(getLang("noVideo"));
      }

      await downloadFile(downloadURL, filePath);

      // Send video — Telegram accepts a ReadStream for sendVideo
      await message.sendVideo(
        fs.createReadStream(filePath),
        getLang("downloaded")
          .replace("%1", platform || "Unknown")
          .replace("%2", title    || "No Title")
      );

    } catch {
      // Silent fail — same behaviour as original
    } finally {
      // Always clean up the temp file
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    }
  },
};
