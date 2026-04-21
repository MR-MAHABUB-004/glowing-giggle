"use strict";

/**
 * database/index.js
 * GoatBot-style JSON database for Telegram.
 * Manages: threads, users, global, dashboard data.
 *
 * Each model follows the GoatBot API:
 *   .get(id)            → returns data object
 *   .set(id, key, val)  → sets a key on a record
 *   .create(id, extra)  → create a new record
 *   .delete(id)         → remove a record
 *   .getAll()           → returns all records
 */

const fs   = require("fs");
const path = require("path");
const log  = require("../logger/log.js");

const DB_DIR = path.join(__dirname, "../database");

function ensureDir() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
}

function loadFile(filename, defaultData = {}) {
  ensureDir();
  const fp = path.join(DB_DIR, filename);
  try {
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, JSON.stringify(defaultData, null, 2));
      return defaultData;
    }
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch (e) {
    log.error("DB", `loadFile(${filename}): ${e.message}`);
    return defaultData;
  }
}

function saveFile(filename, data) {
  ensureDir();
  const fp = path.join(DB_DIR, filename);
  try {
    fs.writeFileSync(fp, JSON.stringify(data, null, 2));
  } catch (e) {
    log.error("DB", `saveFile(${filename}): ${e.message}`);
  }
}

// ─── GENERIC MODEL ────────────────────────────────────────────────────────────
function createModel(filename, defaultRecord = {}) {
  return {
    _file: filename,

    getAll() {
      return loadFile(filename, {});
    },

    get(id) {
      const db = loadFile(filename, {});
      return db[String(id)] || null;
    },

    getOrCreate(id, defaults = {}) {
      const db = loadFile(filename, {});
      const key = String(id);
      if (!db[key]) {
        db[key] = { ...defaultRecord, ...defaults, id: key, createdAt: Date.now() };
        saveFile(filename, db);
      }
      return db[key];
    },

    create(id, extra = {}) {
      const db  = loadFile(filename, {});
      const key = String(id);
      db[key]   = { ...defaultRecord, ...extra, id: key, createdAt: Date.now() };
      saveFile(filename, db);
      return db[key];
    },

    set(id, key, value) {
      const db  = loadFile(filename, {});
      const k   = String(id);
      if (!db[k]) db[k] = { ...defaultRecord, id: k, createdAt: Date.now() };
      db[k][key] = value;
      db[k].updatedAt = Date.now();
      saveFile(filename, db);
      return db[k];
    },

    update(id, updates = {}) {
      const db  = loadFile(filename, {});
      const k   = String(id);
      if (!db[k]) db[k] = { ...defaultRecord, id: k, createdAt: Date.now() };
      Object.assign(db[k], updates, { updatedAt: Date.now() });
      saveFile(filename, db);
      return db[k];
    },

    delete(id) {
      const db  = loadFile(filename, {});
      const key = String(id);
      delete db[key];
      saveFile(filename, db);
    },

    has(id) {
      const db = loadFile(filename, {});
      return Boolean(db[String(id)]);
    },

    count() {
      return Object.keys(loadFile(filename, {})).length;
    },
  };
}

// ─── THREAD MODEL (per-chat settings) ────────────────────────────────────────
const threadDefaultRecord = {
  prefix:        null,   // per-thread prefix override
  language:      "en",
  adminOnly:     false,
  welcomeMsg:    null,
  leaveMsg:      null,
  autoReact:     false,
  blackList:     [],
  data:          {},     // freeform storage for commands
};

// ─── USER MODEL ───────────────────────────────────────────────────────────────
const userDefaultRecord = {
  exp:       0,
  money:     0,
  name:      "",
  data:      {},
};

// ─── GLOBAL DATA (shared key-value for commands) ──────────────────────────────
const globalDefaultRecord = {
  value: null,
  data:  {},
};

const threadsData   = createModel("threads.json",   threadDefaultRecord);
const usersData     = createModel("users.json",     userDefaultRecord);
const globalData    = createModel("global.json",    globalDefaultRecord);
const dashboardData = createModel("dashboard.json", {});

module.exports = { threadsData, usersData, globalData, dashboardData };
