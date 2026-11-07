import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  addFailure,
  buildFileName,
  failureCount,
  failureIds,
  folderFor,
  getMeta,
  idsByTag,
  initMetaStore,
  joinDownloadPath,
  lastFailure,
  loadItems,
  loadPrefetchState,
  loadSettings,
  metaCount,
  metaIds,
  missingImageRows,
  rebuildItemsFromExcel,
  removeFailure,
  savePrefetchState,
  saveSettings,
  setMeta,
  setMetaImage,
  tagCounts,
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

initMetaStore();
let items = loadItems();
const itemByLibId = new Map();

function rebuildItemIndex(list) {
  items = list;
  itemByLibId.clear();
  for (const item of items) {
    if (item.libId && !itemByLibId.has(item.libId)) {
      itemByLibId.set(item.libId, item);
    }
  }
}
rebuildItemIndex(items);

let settings = loadSettings();
initImageCache();

console.log(
  `[dood] loaded ${items.length} items, ${metaCount()} metadata, ${failureCount()} failures`
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const metaQueue = [];
const metaInflight = new Map();
const metaSlots = Array.from({ length: 10 }, () => ({
  busy: false,
  lastFetchAt: 0,
}));

function metaConcurrency() {
  return Math.max(1, Math.min(10, Number(settings.fetchConcurrency) || 4));
}

function metaFor(libId) {
  return getMeta(libId);
}

function enqueueMeta(libId, force = false) {
  const key = String(libId);
  if (!force) {
    const cached = getMeta(libId);
    if (cached) return Promise.resolve(cached);
  }
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

function pumpMetaQueue() {
  const limit = metaConcurrency();
  for (let i = 0; i < limit && metaQueue.length > 0; i++) {
    const slot = metaSlots[i];
    if (slot.busy) continue;
    const job = metaQueue.shift();
    slot.busy = true;
    runMetaJob(job, slot).finally(() => {
      slot.busy = false;
      pumpMetaQueue();
    });
  }
}

async function runMetaJob(job, slot) {
  const interval = Number(settings.fetchIntervalMs) || 1200;
  const wait = Math.max(0, interval - (Date.now() - slot.lastFetchAt));
  if (wait > 0) await sleep(wait);
  slot.lastFetchAt = Date.now();
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
        console.error(`[dood] image cache failed #${job.id}:`, imageErr.message);
      }
    }
    setMeta(job.id, data);
    job.resolve(data);
  } catch (err) {
    addFailure(job.id, err.message || String(err));
    job.reject(err);
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
  mode: "",
};

const savedPrefetch = loadPrefetchState();
if (savedPrefetch) {
  prefetch.mode = savedPrefetch.mode || "";
  prefetch.total = savedPrefetch.total || 0;
  prefetch.done = savedPrefetch.done || 0;
  prefetch.errors = savedPrefetch.errors || 0;
  prefetch.startedAt = savedPrefetch.started_at || null;
}

function prefetchStatus() {
  const last = lastFailure();
  return {
    running: prefetch.running,
    total: prefetch.total,
    done: prefetch.done,
    errors: prefetch.errors,
    failed: failureCount(),
    lastError: last ? { libId: last.lib_id, error: last.error } : null,
    current: prefetch.current,
    startedAt: prefetch.startedAt,
    mode: prefetch.mode,
    concurrency: metaConcurrency(),
  };
}

async function runPrefetch(targets, mode) {
  if (prefetch.running) return prefetchStatus();
  prefetch.running = true;
  prefetch.stopRequested = false;
  prefetch.total = targets.length;
  prefetch.done = 0;
  prefetch.errors = 0;
  prefetch.startedAt = Date.now();
  prefetch.mode = mode;
  savePrefetchState(prefetch);

  (async () => {
    const force = mode === "refresh";
    const workers = Math.max(
      1,
      Math.min(metaConcurrency(), targets.length || 1)
    );
    let index = 0;

    const work = async () => {
      while (!prefetch.stopRequested && index < targets.length) {
        const item = targets[index++];
        prefetch.current = { libId: item.libId, title: item.title };
        try {
          await enqueueMeta(item.libId, force);
          prefetch.done++;
        } catch {
          prefetch.errors++;
        }
        savePrefetchState(prefetch);
      }
    };

    await Promise.all(Array.from({ length: workers }, work));
    prefetch.running = false;
    prefetch.current = null;
    prefetch.stopRequested = false;
    savePrefetchState(prefetch);
  })();

  return prefetchStatus();
}

async function startPrefetch(options = {}) {
  if (prefetch.running) return prefetchStatus();
  if (options.retry) {
    const ids = new Set(failureIds());
    const targets = items.filter(
      (item) => item.libId && item.dood && ids.has(item.libId)
    );
    const matched = new Set(targets.map((item) => item.libId));
    for (const id of ids) {
      if (!matched.has(id)) removeFailure(id);
    }
    return runPrefetch(targets, "retry");
  }
  const existing = new Set(metaIds());
  const targets = items.filter(
    (item) =>
      item.libId &&
      item.dood &&
      (options.refresh || !existing.has(item.libId))
  );
  return runPrefetch(targets, options.refresh ? "refresh" : "missing");
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
  const m = item.libId ? getMeta(item.libId) : null;
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
  const category = String(searchParams.get("category") || "").trim();
  const doodOnly = searchParams.get("doodOnly") !== "0";

  let result = items;
  if (doodOnly) result = result.filter((item) => item.dood);
  if (q) {
    result = result.filter(
      (item) =>
        String(item.libId || "").includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.title.toLowerCase().includes(q)
    );
  }
  if (category) {
    const ids = new Set(idsByTag(category));
    result = result.filter((item) => ids.has(item.libId));
  }
  return result;
}

function categoryList() {
  return tagCounts().map((row) => ({ name: row.name, count: row.count }));
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
      metaCached: metaCount(),
      failures: failureCount(),
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

  if (pathname === "/api/items/reload" && req.method === "POST") {
    try {
      const list = rebuildItemsFromExcel();
      rebuildItemIndex(list);
      sendJson(res, 200, {
        ok: true,
        items: list.length,
        withDood: list.filter((item) => item.dood).length,
        meta: metaCount(),
      });
    } catch (err) {
      sendJson(res, 502, { error: err.message || String(err) });
    }
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
        setMetaImage(libId, cachedImage.file, cachedImage.mime);
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
    } catch {
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
    let input = {};
    try {
      input = JSON.parse(body || "{}");
    } catch {}
    sendJson(res, 200, await startPrefetch({ refresh: !!input.refresh }));
    return;
  }

  if (pathname === "/api/prefetch/retry" && req.method === "POST") {
    sendJson(res, 200, await startPrefetch({ retry: true }));
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
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
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
  for (const row of missingImageRows()) {
    let value;
    try {
      value = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (!value || !value.image) continue;
    try {
      const cachedImage = await cacheImage(row.lib_id, value.image);
      setMetaImage(row.lib_id, cachedImage.file, cachedImage.mime);
      count++;
    } catch {
      // keep the remote URL as fallback
    }
  }
  if (count > 0) {
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
