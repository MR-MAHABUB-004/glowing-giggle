"use strict";
const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

if (!global.videoCache) global.videoCache = new Map();

const LONG_VIDEO_MINUTES = 10;

function parseDurationToMinutes(d) {
  if (!d) return 0;
  const p = d.split(":").map(Number);
  if (p.length === 3) return p[0] * 60 + p[1] + p[2] / 60;
  if (p.length === 2) return p[0] + p[1] / 60;
  return 0;
}

async function fetchWithRetry(url, params, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, {
        params,
        timeout: 30000,
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
      });
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

// ── Helper: send message and return messageID as a Promise ──────────
function sendMsg(api, body, threadID, extra = {}) {
  return new Promise((resolve, reject) => {
    api.sendMessage({ body, ...extra }, threadID, (err, info) => {
      if (err) return reject(err);
      resolve(info);
    });
  });
}

module.exports = {
  config: {
    name:        "xnx",
    aliases:     ["xnxx"],
    version:     "13.0.0",
    author:      "MR᭄﹅ MAHABUB﹅ メꪜ",
    role:        0,           // 0 = everyone, 1 = admin, 2 = owner
    usePrefix:   true,
    countDown:   5,           // seconds cooldown
    description: "Search videos with thumbnails, reply with number to download",
    category:    "Media",
    guide:       { en: "{pn} xnx <query> — then reply with a number to download" }
  },

  // ────────────────────────────────────────────────────────────────────────────
  // onStart — triggered when user runs the command
  // ────────────────────────────────────────────────────────────────────────────
  onStart: async function ({ api, event, args, message }) {
    const threadID = event.threadID;
    const query    = args.join(" ").trim();

    if (!query) {
      return message.reply(
        "📌 ব্যবহার:\n.xnx <নাম> — সার্চ করুন\nলিস্ট আসলে নম্বর reply করুন ডাউনলোড করতে"
      );
    }

    return this.handleSearch(api, event, message, query, 1);
  },

  // ────────────────────────────────────────────────────────────────────────────
  // onReply — triggered when user replies to the bot's list message
  // ────────────────────────────────────────────────────────────────────────────
  onReply: async function ({ api, event, message, Reply }) {
    const threadID = event.threadID;
    const text     = (event.body || "").trim();
    const { query, page } = Reply; // data stored when we registered the reply

    // ── Navigation ──
    if (text.toLowerCase() === "next" || text === ">") {
      await this.deleteSessionMessages(api, threadID);
      return this.handleSearch(api, event, message, query, page + 1);
    }
    if ((text.toLowerCase() === "prev" || text === "<") && page > 1) {
      await this.deleteSessionMessages(api, threadID);
      return this.handleSearch(api, event, message, query, page - 1);
    }

    // ── Numbered selection ──
    if (!/^\d+$/.test(text)) {
      return message.reply("❌ শুধু নম্বর লিখুন (যেমন: 1, 2, 3...)");
    }

    const num     = parseInt(text);
    const vidData = global.videoCache.get(`v_${threadID}_${num}`);
    if (!vidData) {
      return message.reply(`❌ ${num} নম্বর ভিডিও ক্যাশে নেই বা সেশন শেষ।`);
    }

    await this.deleteSessionMessages(api, threadID);
    return this.downloadAndSend(api, threadID, message, vidData);
  },

  // ────────────────────────────────────────────────────────────────────────────
  // deleteSessionMessages — unsend all tracked messages for this thread
  // ────────────────────────────────────────────────────────────────────────────
  deleteSessionMessages: async function (api, threadID) {
    const ids = global.videoCache.get(`msgs_${threadID}`) || [];
    for (const msgId of ids) {
      await api.unsendMessage(msgId).catch(() => {});
    }
    global.videoCache.delete(`msgs_${threadID}`);
    global.videoCache.delete(`ses_${threadID}`);
  },

  saveMsgId: function (threadID, msgId) {
    const key = `msgs_${threadID}`;
    const ids = global.videoCache.get(key) || [];
    ids.push(msgId);
    global.videoCache.set(key, ids);
  },

  // ────────────────────────────────────────────────────────────────────────────
  // handleSearch — fetch results, send thumbnails + numbered list
  // ────────────────────────────────────────────────────────────────────────────
  handleSearch: async function (api, event, message, query, page) {
    const threadID = event.threadID;

    // Loading indicator
    const loadInfo = await sendMsg(
      api,
      `🔍 "${query}" — Page ${page} লোড হচ্ছে...`,
      threadID
    ).catch(() => null);

    try {
      const res  = await fetchWithRetry(
        "https://page-browser.vercel.app/api/q",
        { q: query, page }
      );
      const data = res.data;

      if (loadInfo) await api.unsendMessage(loadInfo.messageID).catch(() => {});

      if (!data || !data.status || !Array.isArray(data.videos) || data.videos.length === 0) {
        return message.reply(`❌ Page ${page} — কোনো ভিডিও পাওয়া যায়নি।`);
      }

      const videos  = data.videos.slice(0, 10);
      const hasNext = !!data.next;
      const hasPrev = page > 1;

      // ── সেশন সেভ ──
      global.videoCache.set(`ses_${threadID}`, { query, page });

      // ── ভিডিও ক্যাশ ──
      videos.forEach((vid, i) => {
        const num     = i + 1;
        const minutes = parseDurationToMinutes(vid.duration);
        global.videoCache.set(`v_${threadID}_${num}`, {
          title:     vid.title     || `Video ${num}`,
          video_url: vid.video_url || null,
          referer:   vid.link      || "https://www.desitales2.com/",
          duration:  vid.duration  || "?",
          views:     vid.views     || "?",
          rating:    vid.rating    || "?",
          thumbnail: vid.thumbnail || null,
          isLong:    minutes >= LONG_VIDEO_MINUTES
        });
      });

      // ── থামনেইল পাঠানো (আলাদা আলাদা attachment) ──
      for (let i = 0; i < videos.length; i++) {
        const vid = videos[i];
        if (!vid.thumbnail) continue;
        const num     = i + 1;
        const minutes = parseDurationToMinutes(vid.duration);
        const icon    = minutes >= LONG_VIDEO_MINUTES ? "🌐" : "📥";

        try {
          // Stream the thumbnail so we don't hit FB's URL restrictions
          const imgRes = await axios.get(vid.thumbnail, {
            responseType: "stream",
            timeout:      15000,
            headers:      { "User-Agent": "Mozilla/5.0" }
          });

          const sentThumb = await new Promise((resolve, reject) => {
            api.sendMessage(
              {
                body:       `${num}. ${icon} ${vid.title || "?"}\n⏱ ${vid.duration || "?"} | 👁 ${vid.views || "?"} | ⭐ ${vid.rating || "?"}`,
                attachment: imgRes.data
              },
              threadID,
              (err, info) => (err ? reject(err) : resolve(info))
            );
          });

          this.saveMsgId(threadID, sentThumb.messageID);
        } catch (_) {
          // Thumbnail failed — skip silently, list still shows below
        }
      }

      // ── নম্বর লিস্ট ──
      let listBody = `📋 "${query}" — Page ${page}\n${"━".repeat(20)}\n`;
      videos.forEach((vid, i) => {
        const num     = i + 1;
        const minutes = parseDurationToMinutes(vid.duration);
        const icon    = minutes >= LONG_VIDEO_MINUTES ? "🌐" : "📥";
        listBody += `${icon} ${num}. ${vid.title || `Video ${num}`}\n   ⏱ ${vid.duration || "?"} | 👁 ${vid.views || "?"}\n`;
      });

      listBody += `\n${"━".repeat(20)}\n`;
      listBody += `⬇️ ডাউনলোড করতে নম্বর reply করুন (1–${videos.length})`;
      if (hasPrev) listBody += `\n◀️ আগের পেজ: "prev" লিখুন`;
      if (hasNext) listBody += `\n▶️ পরের পেজ:  "next" লিখুন`;

      // Send the list and register onReply so replies come back here
      const listInfo = await new Promise((resolve, reject) => {
        api.sendMessage({ body: listBody }, threadID, (err, info) => {
          if (err) return reject(err);
          resolve(info);
        });
      });

      this.saveMsgId(threadID, listInfo.messageID);

      // ── Reply tracker ──
      // When someone replies to THIS message, GoatBot's main handler
      // will look up onReply by the replied-to messageID and call
      // this command's onReply with the stored data.
      global.GoatBot.onReply.set(listInfo.messageID, {
        commandName: this.config.name,
        messageID:   listInfo.messageID,
        author:      event.senderID,
        query,
        page
      });

    } catch (err) {
      if (loadInfo) await api.unsendMessage(loadInfo.messageID).catch(() => {});
      console.error("[XNX Error]", err.message);
      message.reply(`❌ Error: ${err.message}`);
    }
  },

  // ────────────────────────────────────────────────────────────────────────────
  // downloadAndSend — stream video file and send as FB attachment
  // ────────────────────────────────────────────────────────────────────────────
  downloadAndSend: async function (api, threadID, message, vidData) {
    const { title, video_url, referer, isLong, duration } = vidData;

    if (!video_url) {
      return message.reply("❌ ডাউনলোড লিঙ্ক পাওয়া যায়নি।");
    }

    // Long video — just send the link
    if (isLong) {
      return message.reply(
        `🎬 ${title}\n⏱ ${duration}\n⚠️ ফাইল অনেক বড়। নিচের লিঙ্ক থেকে দেখুন:\n${video_url}`
      );
    }

    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Referer":    referer,
      "Origin":     "https://www.desitales2.com",
      "Accept":     "video/*,*/*;q=0.9"
    };

    const waitInfo = await sendMsg(
      api,
      `⏳ "${title}"\nডাউনলোড হচ্ছে... অনুগ্রহ করে অপেক্ষা করুন।`,
      threadID
    ).catch(() => null);

    const tmpPath = path.join(__dirname, `xnx_${Date.now()}.mp4`);

    try {
      // ── Size check ──
      try {
        const head   = await axios.head(video_url, { headers, timeout: 10000 });
        const bytes  = parseInt(head.headers["content-length"] || "0");
        const sizeMB = bytes / (1024 * 1024);
        if (sizeMB > 25) {
          // Facebook limit is ~25 MB for video uploads via bot
          if (waitInfo) await api.unsendMessage(waitInfo.messageID).catch(() => {});
          return message.reply(
            `⚠️ ${sizeMB.toFixed(1)} MB — ফাইল Facebook সীমার (25 MB) বেশি।\n🌐 দেখুন: ${video_url}`
          );
        }
      } catch (_) {}

      // ── Download to temp file ──
      const response = await axios({
        method:       "GET",
        url:          video_url,
        responseType: "stream",
        headers,
        timeout:      180000,
        maxRedirects: 10
      });

      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);

      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(tmpPath);
        response.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
        response.data.on("error", reject);
      });

      const stat     = fs.statSync(tmpPath);
      const actualMB = stat.size / (1024 * 1024);

      if (stat.size < 1024) throw new Error("CDN blocked — empty response");

      if (actualMB > 25) {
        fs.unlinkSync(tmpPath);
        if (waitInfo) await api.unsendMessage(waitInfo.messageID).catch(() => {});
        return message.reply(
          `⚠️ ${actualMB.toFixed(1)} MB — ফাইল Facebook সীমার বেশি।\n🌐 দেখুন: ${video_url}`
        );
      }

      // ── Send video as attachment ──
      await new Promise((resolve, reject) => {
        api.sendMessage(
          {
            body:       `🎬 ${title}`,
            attachment: fs.createReadStream(tmpPath)
          },
          threadID,
          (err, info) => (err ? reject(err) : resolve(info))
        );
      });

      if (waitInfo) await api.unsendMessage(waitInfo.messageID).catch(() => {});

    } catch (err) {
      console.error("[XNX Download Error]", err.message);
      if (waitInfo) await api.unsendMessage(waitInfo.messageID).catch(() => {});
      message.reply(`❌ ডাউনলোড ব্যর্থ।\n🌐 দেখুন: ${video_url}`);
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  }
};
