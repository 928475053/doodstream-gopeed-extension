import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseExcel } from "./excel.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(APP_ROOT, "data");
export const ITEMS_FILE = path.join(DATA_DIR, "items.json");
export const META_FILE = path.join(DATA_DIR, "meta.json");
export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const VIDEO_EXT_RE = /\.(mp4|mkv|webm|avi|mov|m4v|flv|wmv|ts)$/i;
const INVALID_RE = /[\\/:*?"<>|\u0000-\u001f]/g;

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

export function loadMeta() {
  ensureDir();
  const meta = readJson(META_FILE, {});
  return meta && typeof meta === "object" ? meta : {};
}

export function saveMeta(meta) {
  ensureDir();
  const tmp = META_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(meta));
  fs.renameSync(tmp, META_FILE);
}

const DEFAULT_SETTINGS = {
  gopeedUrl: process.env.GOPEED_URL || "",
  apiToken: process.env.GOPEED_TOKEN || "",
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
