import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFileName,
  folderFor,
  joinDownloadPath,
  loadItems,
  loadMeta,
  loadSettings,
  saveMeta,
  saveSettings,
} from "./lib/store.mjs";
import { fetchClip } from "./lib/library.mjs";
import { createTask, getInfo } from "./lib/gopeed.mjs";
import { resolveDirect } from "./lib/resolve.mjs";
import { BROWSER_UA } from "./lib/http.mjs";
import {
  IMAGE_DIR,
  cacheImage,
  imageFileFor,
  imageMime,
  initImageCache,
} from "./lib/images.mjs";

const PORT = Number(process.env.PORT || 8080);
const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_ROOT, "public");
const PAGE_SIZE_MAX = 100;

const items = loadItems();
const itemByLibId = new Map();
for (const item of items) {
  if (item.libId && !itemByLibId.has(item.libId)) {
    itemByLibId.set(item.libId, item);
  }
}
const meta = loadMeta();
let settings = loadSettings();
try {
  if (initImageCache(meta)) {
    saveMeta(meta);
  }
} catch (err) {
  console.error("[dood] init image cache failed:", err.message);
}

console.log(
  `[dood] loaded ${items.length} items, ${Object.keys(meta).length} cached metadata`
);

let metaSaveTimer = null;
function scheduleMetaSave() {
  if (metaSaveTimer) return;
  metaSaveTimer = setTimeout(() => {
    metaSaveTimer = null;
    try {
      saveMeta(meta);
    } catch (err) {
      console.error("[dood] save metadata failed:", err.message);
    }
  }, 1500);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const metaQueue = [];
const metaInflight = new Map();
let pumping = false;
let lastFetchAt = 0;

function metaFor(libId) {
  return meta[String(libId)] || null;
}

function enqueueMeta(libId, force = false) {
  const key = String(libId);
  if (!force && meta[key]) return Promise.resolve(meta[key]);
  if (metaInflight.has(key)) return metaInflight.get(key);

  const promise = new Promise((resolve, reject) => {
    metaQueue.push({ id: Number(libId), key, resolve, reject });
    pumpMetaQueue();
  });
  metaInflight.set(key, promise);
  promise
    .catch(() => {})
    .finally(() => metaInflight.delete(key));
  return promise;
}

async function pumpMetaQueue() {
  if (pumping) return;
  pumping = true;
  try {
    while (metaQueue.length > 0) {
      const job = metaQueue.shift();
      const interval = Number(settings.fetchIntervalMs) || 1200;
      const wait = Math.max(0, interval - (Date.now() - lastFetchAt));
      if (wait > 0) await sleep(wait);
      lastFetchAt = Date.now();
      try {
        const data = await fetchClip(job.id);
        if (!data) throw new Error("spankinglibrary 中未找到该条目");
        if (data.image) {
          try {
            const cachedImage = await cacheImage(job.id, data.image);
            data.imageFile = cachedImage.file;
            data.imageMime = cachedImage.mime;
            data.imageLocal = "/api/image/" + job.id;
          } catch (imageErr) {
            console.error(
              `[dood] image cache failed #${job.id}:`,
              imageErr.message
            );
          }
        }
        meta[job.key] = data;
        scheduleMetaSave();
        job.resolve(data);
      } catch (err) {
        job.reject(err);
      }
    }
  } finally {
    pumping = false;
  }
}

const prefetch = {
  running: false,
  stopRequested: false,
  total: 0,
  done: 0,
  errors: 0,
  current: null,
  startedAt: null,
};

function prefetchStatus() {
  return {
    running: prefetch.running,
    total: prefetch.total,
    done: prefetch.done,
    errors: prefetch.errors,
    current: prefetch.current,
    startedAt: prefetch.startedAt,
  };
}

async function startPrefetch(refresh) {
  if (prefetch.running) return prefetchStatus();
  const targets = items.filter(
    (item) =>
      item.libId &&
      item.dood &&
      (refresh || !meta[String(item.libId)])
  );
  prefetch.running = true;
  prefetch.stopRequested = false;
  prefetch.total = targets.length;
  prefetch.done = 0;
  prefetch.errors = 0;
  prefetch.startedAt = Date.now();

  (async () => {
    for (const item of targets) {
      if (prefetch.stopRequested) break;
      prefetch.current = { libId: item.libId, title: item.title };
      try {
        await enqueueMeta(item.libId);
        prefetch.done++;
      } catch {
        prefetch.errors++;
      }
    }
    prefetch.running = false;
    prefetch.current = null;
    prefetch.stopRequested = false;
  })();

  return prefetchStatus();
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function itemView(item) {
  const m = item.libId ? metaFor(item.libId) : null;
  return {
    key: item.key,
    libId: item.libId,
    name: item.name,
    title: item.title,
    status: item.status,
    dood: item.dood,
    meta: m
      ? {
          title: m.title,
          image: m.image ? "/api/image/" + item.libId : "",
          images: m.images,
          price: m.price,
          currency: m.currency,
          store: m.store,
          categories: m.categories,
          resolution: m.resolution,
          length: m.length,
          description: m.description,
          url: m.url,
        }
      : null,
  };
}

function filterItems(searchParams) {
  const q = String(searchParams.get("q") || "").trim().toLowerCase();
  const status = String(searchParams.get("status") || "").trim();
  const category = String(searchParams.get("category") || "").trim();
  const doodOnly = searchParams.get("doodOnly") !== "0";

  let result = items;
  if (doodOnly) result = result.filter((item) => item.dood);
  if (status) result = result.filter((item) => item.status === status);
  if (q) {
    result = result.filter(
      (item) =>
        String(item.libId || "").includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.title.toLowerCase().includes(q)
    );
  }
  if (category) {
    result = result.filter((item) => {
      const m = item.libId ? metaFor(item.libId) : null;
      return !!(
        m &&
        Array.isArray(m.categories) &&
        m.categories.some((entry) => entry.name === category)
      );
    });
  }
  return result;
}

function categoryList() {
  const counts = new Map();
  for (const value of Object.values(meta)) {
    if (!value || !Array.isArray(value.categories)) continue;
    for (const category of value.categories) {
      if (!category || !category.name) continue;
      counts.set(category.name, (counts.get(category.name) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-Api-Token",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end();
    return;
  }

  if (pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/stats") {
    sendJson(res, 200, {
      items: items.length,
      withDood: items.filter((item) => item.dood).length,
      metaCached: Object.keys(meta).length,
      prefetch: prefetchStatus(),
      settings: {
        gopeedUrl: settings.gopeedUrl,
        downloadRoot: settings.downloadRoot,
        fetchIntervalMs: settings.fetchIntervalMs,
      },
    });
    return;
  }

  if (pathname === "/api/categories") {
    sendJson(res, 200, { categories: categoryList() });
    return;
  }

  if (pathname === "/api/items") {
    const filtered = filterItems(url.searchParams);
    const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
    const pageSize = Math.max(
      1,
      Math.min(
        PAGE_SIZE_MAX,
        Number(url.searchParams.get("pageSize") || 24) || 24
      )
    );
    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const start = (page - 1) * pageSize;
    sendJson(res, 200, {
      total,
      page,
      pageSize,
      pages,
      items: filtered.slice(start, start + pageSize).map(itemView),
    });
    return;
  }

  const metaMatch = pathname.match(/^\/api\/meta\/(\d+)$/);
  if (metaMatch) {
    const libId = Number(metaMatch[1]);
    const item = itemByLibId.get(libId);
    if (!item) {
      sendJson(res, 404, { error: "条目不存在" });
      return;
    }
    const force = url.searchParams.get("refresh") === "1";
    try {
      const data = await enqueueMeta(libId, force);
      const view =
        data && data.image
          ? Object.assign({}, data, { image: "/api/image/" + libId })
          : data;
      sendJson(res, 200, { meta: view });
    } catch (err) {
      sendJson(res, 502, { error: err.message || String(err) });
    }
    return;
  }

  const imageMatch = pathname.match(/^\/api\/image\/(\d+)$/);
  if (imageMatch) {
    const libId = Number(imageMatch[1]);
    const metaData = metaFor(libId);
    if (!metaData) {
      sendJson(res, 404, { error: "条目元数据不存在" });
      return;
    }
    let file = imageFileFor(libId);
    if (!file) {
      if (!metaData.image) {
        sendJson(res, 404, { error: "该条目没有图片" });
        return;
      }
      try {
        const cachedImage = await cacheImage(libId, metaData.image);
        metaData.imageFile = cachedImage.file;
        metaData.imageMime = cachedImage.mime;
        metaData.imageLocal = "/api/image/" + libId;
        scheduleMetaSave();
        file = cachedImage.file;
      } catch (err) {
        let allowed = false;
        try {
          allowed = /(^|\.)spankinglibrary\.com$/i.test(
            new URL(metaData.image).hostname
          );
        } catch {}
        if (allowed) {
          res.writeHead(302, {
            Location: metaData.image,
            "Cache-Control": "no-store",
          });
          res.end();
        } else {
          sendJson(res, 502, { error: "图片缓存失败: " + err.message });
        }
        return;
      }
    }
    const fullPath = path.join(IMAGE_DIR, file);
    try {
      const stat = fs.statSync(fullPath);
      res.writeHead(200, {
        "Content-Type": imageMime(file),
        "Content-Length": stat.size,
        "Cache-Control": "public, max-age=604800",
        "Access-Control-Allow-Origin": "*",
      });
      fs.createReadStream(fullPath).pipe(res);
    } catch (err) {
      sendJson(res, 500, { error: "读取图片失败" });
    }
    return;
  }

  const downloadMatch = pathname.match(/^\/api\/download\/(\d+)$/);
  if (downloadMatch && req.method === "POST") {
    const libId = Number(downloadMatch[1]);
    const item = itemByLibId.get(libId);
    if (!item) {
      sendJson(res, 404, { error: "条目不存在" });
      return;
    }
    if (!item.dood) {
      sendJson(res, 400, { error: "该条目没有 DoodStream 链接" });
      return;
    }
    try {
      let metaData = metaFor(libId);
      let metaWarning = "";
      if (!metaData) {
        try {
          metaData = await enqueueMeta(libId);
        } catch (err) {
          metaWarning = "元数据获取失败，使用 Excel 标题: " + err.message;
        }
      }
      const resolved = await resolveDirect(item.dood);
      const title =
        (metaData && metaData.title) || item.title || item.name || String(libId);
      const fileName = buildFileName(title);
      const folder = folderFor(metaData);
      const downloadPath = joinDownloadPath(settings.downloadRoot, folder);
      const taskId = await createTask(settings, {
        url: resolved.url,
        header: {
          Referer: resolved.referer,
          "User-Agent": BROWSER_UA,
        },
        name: fileName,
        path: downloadPath,
      });
      sendJson(res, 200, {
        ok: true,
        taskId,
        name: fileName,
        path: downloadPath,
        folder,
        warning: metaWarning,
      });
    } catch (err) {
      sendJson(res, 502, { error: err.message || String(err) });
    }
    return;
  }

  if (pathname === "/api/settings" && req.method === "GET") {
    sendJson(res, 200, { settings });
    return;
  }

  if (pathname === "/api/settings" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const input = JSON.parse(raw || "{}");
      settings = saveSettings(input);
      sendJson(res, 200, { settings });
    } catch (err) {
      sendJson(res, 400, { error: err.message || String(err) });
    }
    return;
  }

  if (pathname === "/api/settings/test" && req.method === "POST") {
    try {
      const info = await getInfo(settings);
      sendJson(res, 200, { ok: true, info });
    } catch (err) {
      sendJson(res, 502, { error: err.message || String(err) });
    }
    return;
  }

  if (pathname === "/api/prefetch/status") {
    sendJson(res, 200, prefetchStatus());
    return;
  }

  if (pathname === "/api/prefetch/start" && req.method === "POST") {
    const body = await readBody(req).catch(() => "{}");
    const input = body ? JSON.parse(body || "{}") : {};
    sendJson(res, 200, await startPrefetch(!!input.refresh));
    return;
  }

  if (pathname === "/api/prefetch/stop" && req.method === "POST") {
    prefetch.stopRequested = true;
    sendJson(res, 200, prefetchStatus());
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function serveStatic(res, pathname) {
  let relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

async function backfillImages() {
  let count = 0;
  for (const [key, value] of Object.entries(meta)) {
    if (!value || !value.image || value.imageFile) continue;
    try {
      const cachedImage = await cacheImage(key, value.image);
      value.imageFile = cachedImage.file;
      value.imageMime = cachedImage.mime;
      value.imageLocal = "/api/image/" + key;
      count++;
      if (count % 20 === 0) scheduleMetaSave();
    } catch {
      // keep the remote URL as fallback
    }
  }
  if (count > 0) {
    scheduleMetaSave();
    console.log(`[dood] cached ${count} images`);
  }
}

setTimeout(backfillImages, 1500);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(res, url.pathname);
  } catch (err) {
    console.error("[dood] request failed:", err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: err.message || String(err) });
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[dood] listening on http://0.0.0.0:${PORT}`);
});
