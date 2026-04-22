"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const TMP_DIR = path.join(__dirname, "../tmp");

module.exports = {
  config: {
    name: "auto",
    aliases: ["dl", "download"],
    version: "5.5",
    author: "MR᭄﹅ MAHABUB﹅ メꪜ",
    usePrefix: false, 
    role: 0,
    category: "media",
    countDown: 5,
    description: { en: "Auto video downloader — triggers on any https link" },
    guide: { en: "Just send any link starting with https://" },
  },

  langs: {
    en: {
      downloaded: "✅ 𝗗𝗼𝘄𝗻𝗹𝗼𝗮𝗱𝗲𝗱!\n\n📌 Platform: %1\n🎬 Title: %2",
      noLink: "📥 Send a link starting with https:// to download 🎥",
      noVideo: "❌ No downloadable video found for that link.",
    },
  },

  onStart: async function ({ message, getLang }) {
    return message.reply(getLang("noLink"));
  },

  onChat: async function ({ api, event, message, getLang }) {
    const text = event.body?.trim();
    if (!text) return;

    // Matches any link starting with https://
    const match = text.match(/(https:\/\/[^\s]+)/);
    if (!match) return;

    const videoLink = match[0];
    const apiBaseURL = "https://mahabub-apis.fun";

    // Show 'uploading video' state in chat
    await message.action("upload_video");

    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    // Logic to fetch download details from API
    async function fetchInfo(url, retries = 2) {
      for (let i = 1; i <= retries; i++) {
        try {
          const res = await axios.get(
            `${apiBaseURL}/mahabub/dl?url=${encodeURIComponent(url)}`,
            { timeout: 15000 }
          );
          if (res.data && (res.data.hd || res.data.sd || res.data.url)) {
            return res.data;
          }
          throw new Error("No media found");
        } catch (err) {
          if (i === retries) throw err;
          await wait(1500);
        }
      }
    }

    // Logic to stream the file into local storage
    async function downloadFile(downloadURL, filePath) {
      const res = await axios.get(downloadURL, {
        responseType: "stream",
        timeout: 60000,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const writer = fs.createWriteStream(filePath);
      res.data.pipe(writer);
      return new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
    }

    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, `auto_${Date.now()}.mp4`);

    try {
      const data = await fetchInfo(videoLink);
      // Support various API response keys
      const downloadURL = data.hd || data.sd || data.url;

      if (!downloadURL) return;

      await downloadFile(downloadURL, filePath);

      await message.reply({
        body: getLang("downloaded")
          .replace("%1", data.platform || "Auto-Detector")
          .replace("%2", data.title || "No Title"),
        attachment: fs.createReadStream(filePath)
      });

    } catch (error) {
      console.error("Auto-DL Error:", error.message);
      // Fail silently to avoid spamming the chat on non-video links
    } finally {
      // Small delay before deletion to ensure the read stream is closed
      setTimeout(() => {
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) {
          console.error("Cleanup error:", e.message);
        }
      }, 10000);
    }
  },
};
