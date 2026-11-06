import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parseExcel } from "./excel.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(APP_ROOT, "data");
export const ITEMS_FILE = path.join(DATA_DIR, "items.json");
export const META_FILE = path.join(DATA_DIR, "meta.json");
export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
export const DB_FILE = path.join(DATA_DIR, "library.db");

const VIDEO_EXT_RE = /\.(mp4|mkv|webm|avi|mov|m4v|flv|wmv|ts)$/i;
const INVALID_RE = /[\\/:*?"<>|\u0000-\u001f]/g;

let db = null;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function initMetaStore() {
  ensureDir();
  if (db) return db;
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta (
      lib_id INTEGER PRIMARY KEY,
      data TEXT NOT NULL,
      image_file TEXT,
      image_mime TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta_tags (
      lib_id INTEGER NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (lib_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_meta_tags_tag ON meta_tags(tag);
    CREATE TABLE IF NOT EXISTS failures (
      lib_id INTEGER PRIMARY KEY,
      error TEXT NOT NULL,
      at INTEGER NOT NULL
    );
  `);
  migrateMetaJson();
  return db;
}

function migrateMetaJson() {
  const count = db.prepare("SELECT COUNT(*) AS c FROM meta").get().c;
  if (count > 0) return;
  if (!fs.existsSync(META_FILE)) return;
  const data = readJson(META_FILE, {});
  const entries = Object.entries(data || {});
  if (entries.length === 0) return;

  const insert = db.prepare(
    "INSERT OR REPLACE INTO meta (lib_id, data, image_file, image_mime, updated_at) VALUES (?, ?, ?, ?, ?)"
  );
  const insertTag = db.prepare(
    "INSERT OR IGNORE INTO meta_tags (lib_id, tag) VALUES (?, ?)"
  );
  db.exec("BEGIN");
  try {
    for (const [key, value] of entries) {
      const id = Number(key);
      if (!Number.isFinite(id) || !value) continue;
      insert.run(
        id,
        JSON.stringify(value),
        value.imageFile || null,
        value.imageMime || null,
        value.fetchedAt || Date.now()
      );
      for (const category of value.categories || []) {
        if (category && category.name) insertTag.run(id, category.name);
      }
    }
    db.exec("COMMIT");
    fs.renameSync(META_FILE, META_FILE + ".migrated");
    console.log(`[dood] migrated ${entries.length} metadata rows to SQLite`);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getMeta(libId) {
  const row = db
    .prepare("SELECT data FROM meta WHERE lib_id = ?")
    .get(Number(libId));
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

export function setMeta(libId, value) {
  const id = Number(libId);
  const now = Date.now();
  const tags = new Set(
    (value.categories || []).map((category) => category && category.name).filter(Boolean)
  );
  const insert = db.prepare(
    "INSERT INTO meta (lib_id, data, image_file, image_mime, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(lib_id) DO UPDATE SET data=excluded.data, image_file=excluded.image_file, image_mime=excluded.image_mime, updated_at=excluded.updated_at"
  );
  const deleteTags = db.prepare("DELETE FROM meta_tags WHERE lib_id = ?");
  const insertTag = db.prepare(
    "INSERT OR IGNORE INTO meta_tags (lib_id, tag) VALUES (?, ?)"
  );
  const deleteFailure = db.prepare("DELETE FROM failures WHERE lib_id = ?");

  db.exec("BEGIN");
  try {
    insert.run(
      id,
      JSON.stringify(value),
      value.imageFile || null,
      value.imageMime || null,
      now
    );
    deleteTags.run(id);
    for (const tag of tags) insertTag.run(id, tag);
    deleteFailure.run(id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function setMetaImage(libId, fileName, mime) {
  const value = getMeta(libId);
  if (!value) return false;
  value.imageFile = fileName;
  value.imageMime = mime;
  value.imageLocal = "/api/image/" + libId;
  setMeta(libId, value);
  return true;
}

export function clearMetaImage(libId) {
  const value = getMeta(libId);
  if (!value) return;
  delete value.imageFile;
  delete value.imageMime;
  delete value.imageLocal;
  setMeta(libId, value);
}

export function metaCount() {
  return db.prepare("SELECT COUNT(*) AS c FROM meta").get().c;
}

export function metaIds() {
  return db.prepare("SELECT lib_id FROM meta").all().map((row) => row.lib_id);
}

export function tagCounts() {
  return db
    .prepare(
      "SELECT tag AS name, COUNT(*) AS count FROM meta_tags GROUP BY tag ORDER BY count DESC, name ASC"
    )
    .all();
}

export function idsByTag(tag) {
  return db
    .prepare("SELECT lib_id FROM meta_tags WHERE tag = ?")
    .all(String(tag))
    .map((row) => row.lib_id);
}

export function imageRows() {
  return db
    .prepare("SELECT lib_id, image_file FROM meta WHERE image_file IS NOT NULL")
    .all();
}

export function missingImageRows() {
  return db
    .prepare("SELECT lib_id, data FROM meta WHERE image_file IS NULL")
    .all();
}

export function addFailure(libId, error) {
  db.prepare(
    "INSERT INTO failures (lib_id, error, at) VALUES (?, ?, ?) " +
      "ON CONFLICT(lib_id) DO UPDATE SET error=excluded.error, at=excluded.at"
  ).run(Number(libId), String(error || "").slice(0, 500), Date.now());
}

export function removeFailure(libId) {
  db.prepare("DELETE FROM failures WHERE lib_id = ?").run(Number(libId));
}

export function failureCount() {
  return db.prepare("SELECT COUNT(*) AS c FROM failures").get().c;
}

export function failureIds() {
  return db
    .prepare("SELECT lib_id FROM failures ORDER BY at ASC")
    .all()
    .map((row) => row.lib_id);
}

export function lastFailure() {
  const row = db
    .prepare("SELECT lib_id, error, at FROM failures ORDER BY at DESC LIMIT 1")
    .get();
  return row || null;
}

export function loadItems() {
  ensureDir();
  if (fs.existsSync(ITEMS_FILE)) {
    const items = readJson(ITEMS_FILE, null);
    if (Array.isArray(items)) return items;
  }
  const excelPath = String(process.env.EXCEL_PATH || "").trim();
  if (!excelPath) {
    return [];
  }
  const items = parseExcel(excelPath);
  const tmp = ITEMS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(items));
  fs.renameSync(tmp, ITEMS_FILE);
  return items;
}

const DEFAULT_SETTINGS = {
  gopeedUrl: "",
  apiToken: "",
  downloadRoot: process.env.DOWNLOAD_ROOT || "/app/Downloads",
  fetchIntervalMs: Number(process.env.FETCH_INTERVAL_MS || 1200),
  connections: Number(process.env.CONNECTIONS || 16),
};

export function loadSettings() {
  ensureDir();
  const saved = readJson(SETTINGS_FILE, {});
  const merged = Object.assign({}, DEFAULT_SETTINGS, saved || {});
  merged.fetchIntervalMs = Math.max(
    200,
    Math.min(30000, Number(merged.fetchIntervalMs) || 1200)
  );
  merged.connections = Math.max(1, Math.min(32, Number(merged.connections) || 16));
  return merged;
}

export function saveSettings(input) {
  const current = loadSettings();
  const next = Object.assign({}, current);
  for (const key of [
    "gopeedUrl",
    "apiToken",
    "downloadRoot",
    "fetchIntervalMs",
    "connections",
  ]) {
    if (input[key] !== undefined) next[key] = input[key];
  }
  next.fetchIntervalMs = Math.max(
    200,
    Math.min(30000, Number(next.fetchIntervalMs) || current.fetchIntervalMs)
  );
  next.connections = Math.max(1, Math.min(32, Number(next.connections) || 16));
  const tmp = SETTINGS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
  return next;
}

export function sanitizeSegment(value, fallback = "Uncategorized") {
  let name = String(value || "")
    .replace(/[\\/]+/g, "-")
    .replace(/[:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^[. \-]+|[. \-]+$/g, "")
    .trim();
  if (!name) name = fallback;
  if (name.length > 80) name = name.slice(0, 80).trim();
  return name;
}

export function buildFileName(title) {
  let name = String(title || "")
    .replace(INVALID_RE, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .trim();
  if (!name) name = "video";
  if (!VIDEO_EXT_RE.test(name)) name += ".mp4";
  if (name.length > 150) {
    const ext = (name.match(/\.[A-Za-z0-9]{1,5}$/) || [""])[0];
    name = name.slice(0, 150 - ext.length) + ext;
  }
  return name;
}

export function folderFor(meta) {
  if (meta && meta.store) {
    return meta.store;
  }
  return "Uncategorized";
}

export function joinDownloadPath(root, category) {
  const base = String(root || "/app/Downloads").replace(/\\/g, "/").replace(/\/+$/, "");
  return `${base}/${sanitizeSegment(category)}`;
}
