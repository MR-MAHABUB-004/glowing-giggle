"use strict";
const axios = require("axios");
const fs    = require("fs");
const path  = require("path");
const yts   = require("yt-search");

if (!global.ytCache) global.ytCache = new Map();

async function processVideo(youtubeUrl) {
  const res = await axios.post(
    "https://app.ytdown.to/proxy.php",
    new URLSearchParams({ url: youtubeUrl }),
    {
      headers: {
        "authority":        "app.ytdown.to",
        "accept":           "*/*",
        "content-type":     "application/x-www-form-urlencoded; charset=UTF-8",
        "origin":           "https://app.ytdown.to",
        "referer":          "https://app.ytdown.to/en24/",
        "user-agent":       "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
        "x-requested-with": "XMLHttpRequest"
      },
      timeout: 30000
    }
  );
  return res.data.api;
}

async function pollUntilReady(mediaUrl, maxWait = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const res  = await axios.get(mediaUrl, { timeout: 15000 });
    const data = res.data;
    if (data.status === "completed" && data.fileUrl && data.fileUrl !== "Waiting...")
      return data;
    if (data.status === "error" || data.status === "failed")
      throw new Error(`Processing failed: ${data.status}`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error("Timeout — processing too slow.");
}

// ── Helper: send message as Promise ─────────────────────────────────
function sendMsg(api, body, threadID, attachment = null) {
  return new Promise((resolve, reject) => {
    const payload = { body };
    if (attachment) payload.attachment = attachment;
    api.sendMessage(payload, threadID, (err, info) => {
      if (err) return reject(err);
      resolve(info);
    });
  });
}

module.exports = {
  config: {
    name:        "video",
    aliases:     ["yt", "ytdl"],
    version:     "3.1.0",
    author:      "MR᭄﹅ MAHABUB﹅ メꪜ",
    role:        0,
    usePrefix:   true,
    countDown:   10,
    description: "YouTube থেকে ভিডিও/অডিও ডাউনলোড",
    category:    "Media",
    guide:       { en: "{pn}video <name or YouTube URL>" }
  },

  // ────────────────────────────────────────────────────────────────────
  // onStart — user runs the command
  // ────────────────────────────────────────────────────────────────────
  onStart: async function ({ api, event, args, message }) {
    const threadID = event.threadID;
    const input    = args.join(" ").trim();

    if (!input) {
      return message.reply(
        "📌 ব্যবহার:\n.video Tum Hi Ho\n.video https://youtu.be/..."
      );
    }

    const waitInfo = await sendMsg(api, "🔍 খোঁজা হচ্ছে...", threadID).catch(() => null);

    try {
      const isUrl = /youtu(be\.com|\.be)/i.test(input);

      if (isUrl) {
        let videoTitle = input;
        let duration   = "?";
        try {
          const videoIdMatch = input.match(/(?:v=|youtu\.be\/)([^&?/]+)/);
          if (videoIdMatch) {
            const info = await yts({ videoId: videoIdMatch[1] });
            videoTitle = info?.title || input;
            duration   = info?.duration?.timestamp || "?";
          }
        } catch (_) {}

        if (waitInfo) await api.unsendMessage(waitInfo.messageID).catch(() => {});
        return this.processAndShow(api, event, message, input, videoTitle, duration);

      } else {
        const r       = await yts(input);
        const results = (r.videos || []).slice(0, 5);

        if (!results.length) throw new Error("কোনো ভিডিও পাওয়া যায়নি।");

        if (waitInfo) await api.unsendMessage(waitInfo.messageID).catch(() => {});

        // Only one result — go straight to processing
        if (results.length === 1) {
          return this.processAndShow(
            api, event, message,
            results[0].url,
            results[0].title,
            results[0].duration?.timestamp || "?"
          );
        }

        // Multiple results — show numbered list and wait for reply
        let body = `🔍 "${input}" — Results:\n${"━".repeat(20)}\n`;
        results.forEach((v, i) => {
          body += `${i + 1}. ${v.title}\n   ⏱ ${v.duration?.timestamp || "?"} | 👁 ${v.views?.toLocaleString() || "?"}\n\n`;
        });
        body += `${"━".repeat(20)}\n`;
        body += `▶️ ডাউনলোড করতে নম্বর reply করুন (1–${results.length})`;

        const listInfo = await sendMsg(api, body, threadID);

        // Store results against this message for onReply
        global.ytCache.set(`ytsearch_${threadID}_${listInfo.messageID}`, {
          type:    "search",
          results,
          author:  event.senderID
        });

        // Register reply handler
        global.GoatBot.onReply.set(listInfo.messageID, {
          commandName: this.config.name,
          messageID:   listInfo.messageID,
          type:        "search",
          threadID,
          author:      event.senderID
        });
      }

    } catch (err) {
      if (waitInfo) await api.unsendMessage(waitInfo.messageID).catch(() => {});
      message.reply(`❌ ${err.message}`);
    }
  },

  // ────────────────────────────────────────────────────────────────────
  // onReply — handles both search selection and quality/format selection
  // ────────────────────────────────────────────────────────────────────
  onReply: async function ({ api, event, message, Reply }) {
    const threadID = event.threadID;
    const text     = (event.body || "").trim();

    if (!/^\d+$/.test(text)) {
      return message.reply("❌ শুধু নম্বর লিখুন।");
    }

    const num = parseInt(text);

    // ── Stage 1: User picked a search result ──
    if (Reply.type === "search") {
      const cached = global.ytCache.get(`ytsearch_${threadID}_${Reply.messageID}`);
      if (!cached) return message.reply("❌ Session শেষ। আবার .video চালান।");

      const video = cached.results[num - 1];
      if (!video) return message.reply(`❌ ${num} নম্বর ভিডিও নেই।`);

      // Clean up
      await api.unsendMessage(Reply.messageID).catch(() => {});
      global.ytCache.delete(`ytsearch_${threadID}_${Reply.messageID}`);
      global.GoatBot.onReply.delete(Reply.messageID);

      const waitInfo = await sendMsg(
        api,
        `⚙️ "${video.title}" process হচ্ছে...`,
        threadID
      ).catch(() => null);

      return this.processAndShow(
        api, event, message,
        video.url,
        video.title,
        video.duration?.timestamp || "?",
        waitInfo?.messageID || null
      );
    }

    // ── Stage 2: User picked a quality/format ──
    if (Reply.type === "quality") {
      const cached = global.ytCache.get(`ytquality_${threadID}_${Reply.messageID}`);
      if (!cached) return message.reply("❌ Session শেষ। আবার .video চালান।");

      const chosen = cached.items[num - 1];
      if (!chosen) return message.reply(`❌ ${num} নম্বর অপশন নেই।`);

      // Clean up
      await api.unsendMessage(Reply.messageID).catch(() => {});
      global.ytCache.delete(`ytquality_${threadID}_${Reply.messageID}`);
      global.GoatBot.onReply.delete(Reply.messageID);

      return this.downloadItem(api, threadID, message, chosen.item, cached.title, cached.duration);
    }
  },

  // ────────────────────────────────────────────────────────────────────
  // processAndShow — call API, show quality list
  // ────────────────────────────────────────────────────────────────────
  processAndShow: async function (api, event, message, youtubeUrl, videoTitle, duration, existingWaitMsgId = null) {
    const threadID = event.threadID;

    let waitInfo = null;
    if (existingWaitMsgId) {
      waitInfo = { messageID: existingWaitMsgId };
    } else {
      waitInfo = await sendMsg(
        api,
        `⚙️ "${videoTitle}"\nServer-এ process হচ্ছে...`,
        threadID
      ).catch(() => null);
    }

    try {
      const apiData = await processVideo(youtubeUrl);
      if (!apiData || apiData.status !== "ok")
        throw new Error(apiData?.message || "API error");

      const title      = apiData.title || videoTitle;
      const thumbnail  = apiData.imagePreviewUrl || null;
      const items      = apiData.mediaItems || [];
      const videoItems = items.filter(i => i.type === "Video");
      const audioItems = items.filter(i => i.type === "Audio");

      if (!videoItems.length && !audioItems.length)
        throw new Error("কোনো media পাওয়া যায়নি।");

      if (waitInfo) await api.unsendMessage(waitInfo.messageID).catch(() => {});

      // Build numbered list
      const allItems = [];
      let body = `🎬 ${title}\n⏱ ${duration}\n${"━".repeat(20)}\n`;

      if (videoItems.length) {
        body += `📹 Video:\n`;
        videoItems.forEach(item => {
          allItems.push({ item, label: `🎬 ${item.mediaRes || item.mediaQuality || "?"} (${item.mediaFileSize || "?"})` });
          body += `  ${allItems.length}. ${item.mediaRes || item.mediaQuality || "?"} — ${item.mediaFileSize || "?"}\n`;
        });
      }

      if (audioItems.length) {
        body += `\n🎵 Audio:\n`;
        audioItems.forEach(item => {
          allItems.push({ item, label: `🎵 ${item.mediaExtension || "M4A"} ${item.mediaQuality || "?"} (${item.mediaFileSize || "?"})` });
          body += `  ${allItems.length}. ${item.mediaExtension || "M4A"} ${item.mediaQuality || "?"} — ${item.mediaFileSize || "?"}\n`;
        });
      }

      body += `${"━".repeat(20)}\n`;
      body += `⬇️ নম্বর reply করুন ডাউনলোড করতে (1–${allItems.length})`;

      // Try to send thumbnail + text, fall back to text only
      let qualityInfo;
      if (thumbnail) {
        try {
          const imgRes = await axios.get(thumbnail, {
            responseType: "stream", timeout: 15000,
            headers: { "User-Agent": "Mozilla/5.0" }
          });
          qualityInfo = await new Promise((resolve, reject) => {
            api.sendMessage(
              { body, attachment: imgRes.data },
              threadID,
              (err, info) => (err ? reject(err) : resolve(info))
            );
          });
        } catch (_) {
          qualityInfo = await sendMsg(api, body, threadID);
        }
      } else {
        qualityInfo = await sendMsg(api, body, threadID);
      }

      // Store items and register reply
      global.ytCache.set(`ytquality_${threadID}_${qualityInfo.messageID}`, {
        items: allItems,
        title,
        duration,
        author: event.senderID
      });

      global.GoatBot.onReply.set(qualityInfo.messageID, {
        commandName: this.config.name,
        messageID:   qualityInfo.messageID,
        type:        "quality",
        threadID,
        author:      event.senderID
      });

    } catch (err) {
      if (waitInfo) await api.unsendMessage(waitInfo.messageID).catch(() => {});
      message.reply(`❌ ${err.message}`);
    }
  },

  // ────────────────────────────────────────────────────────────────────
  // downloadItem — poll, download, send as FB attachment
  // ────────────────────────────────────────────────────────────────────
  downloadItem: async function (api, threadID, message, item, title, duration) {
    const { mediaUrl, mediaFileSize, mediaExtension, mediaQuality, mediaRes, type } = item;
    const ext  = (mediaExtension || "mp4").toLowerCase();
    const qual = mediaRes || mediaQuality || "";

    const waitInfo = await sendMsg(
      api,
      `⏳ "${title}"\n${type === "Audio" ? "🎵" : "🎬"} ${qual} — ${mediaFileSize}\n🔄 Processing...`,
      threadID
    ).catch(() => null);

    const tmpPath = path.join(__dirname, `ytdl_${Date.now()}.${ext}`);

    try {
      const result  = await pollUntilReady(mediaUrl);
      const sizeStr = result.fileSize || mediaFileSize || "?";

      // Size check — Facebook limit is ~25 MB
      let sizeMB = 0;
      const sizeMatch = sizeStr.match(/([\d.]+)\s*(MB|GB|KB)/i);
      if (sizeMatch) {
        sizeMB = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toUpperCase();
        if (unit === "GB") sizeMB *= 1024;
        if (unit === "KB") sizeMB /= 1024;
      }

      const caption = `${type === "Audio" ? "🎵" : "🎬"} ${title}\n📊 ${qual} — ${sizeStr}\n⏱ ${duration}`;

      if (sizeMB > 25) {
        if (waitInfo) await api.unsendMessage(waitInfo.messageID).catch(() => {});
        return message.reply(
          `${caption}\n\n⚠️ ফাইল ২৫ MB-এর বড় (Facebook Limit)।\n🌐 সরাসরি ডাউনলোড: ${result.fileUrl}`
        );
      }

      // Download to temp file
      const response = await axios({
        method:       "GET",
        url:          result.fileUrl,
        responseType: "stream",
        timeout:      180000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36",
          "Referer":    "https://app.ytdown.to/"
        }
      });

      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(tmpPath);
        response.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
        response.data.on("error", reject);
      });

      const stat = fs.statSync(tmpPath);
      if (stat.size < 1024) throw new Error("Empty file downloaded");

      if (waitInfo) await api.unsendMessage(waitInfo.messageID).catch(() => {});

      // Send as FB attachment
      await new Promise((resolve, reject) => {
        api.sendMessage(
          { body: caption, attachment: fs.createReadStream(tmpPath) },
          threadID,
          (err, info) => (err ? reject(err) : resolve(info))
        );
      });

    } catch (err) {
      if (waitInfo) await api.unsendMessage(waitInfo.messageID).catch(() => {});
      message.reply(`❌ ডাউনলোড ব্যর্থ: ${err.message}`);
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  }
};
