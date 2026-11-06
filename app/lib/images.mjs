import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { DATA_DIR, clearMetaImage, imageRows } from "./store.mjs";
import { BROWSER_UA } from "./http.mjs";

export const IMAGE_DIR = path.join(DATA_DIR, "images");
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const EXT_MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const cached = new Map();
const inFlight = new Map();

export function initImageCache() {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  for (const row of imageRows()) {
    const key = String(row.lib_id);
    const file = row.image_file;
    if (file && fs.existsSync(path.join(IMAGE_DIR, file))) {
      cached.set(key, file);
    } else {
      clearMetaImage(row.lib_id);
    }
  }
}

export function imageMime(fileName) {
  return EXT_MIME[path.extname(fileName).toLowerCase()] || "application/octet-stream";
}

export function imageFileFor(libId) {
  const key = String(libId);
  const file = cached.get(key);
  if (!file) return null;
  if (!fs.existsSync(path.join(IMAGE_DIR, file))) {
    cached.delete(key);
    return null;
  }
  return file;
}

function downloadImage(libId, remoteUrl) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(remoteUrl);
    } catch {
      reject(new Error("无效的图片地址"));
      return;
    }
    if (!/(^|\.)spankinglibrary\.com$/i.test(parsed.hostname)) {
      reject(new Error("图片域名不在允许列表: " + parsed.hostname));
      return;
    }

    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    const tmp = path.join(
      IMAGE_DIR,
      `.tmp-${libId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    const args = [
      "-sS",
      "-L",
      "--max-time",
      "40",
      "--max-filesize",
      String(MAX_IMAGE_BYTES),
      "-A",
      BROWSER_UA,
      "-o",
      tmp,
      "-w",
      "%{http_code} %{content_type} %{size_download}",
      remoteUrl,
    ];

    execFile("curl", args, { encoding: "utf8", timeout: 45000 }, (err, stdout) => {
      const cleanup = () => {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {}
      };
      if (err && !stdout) {
        cleanup();
        reject(new Error("图片下载失败: " + err.message));
        return;
      }
      const parts = String(stdout || "").trim().split(" ");
      const status = Number(parts[0]) || 0;
      const contentType = (parts[1] || "").split(";")[0].toLowerCase();
      const size = Number(parts[2]) || 0;
      if (status !== 200 || !contentType.startsWith("image/") || size <= 0) {
        cleanup();
        reject(new Error(`图片下载失败 (HTTP ${status}, ${contentType || "unknown"})`));
        return;
      }
      let ext = MIME_EXT[contentType] || path.extname(parsed.pathname).slice(1);
      ext = String(ext || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!ext) ext = "jpg";
      const fileName = `${libId}.${ext}`;
      const finalPath = path.join(IMAGE_DIR, fileName);
      try {
        fs.rmSync(finalPath, { force: true });
        fs.renameSync(tmp, finalPath);
      } catch (renameErr) {
        cleanup();
        reject(new Error("图片写入失败: " + renameErr.message));
        return;
      }
      resolve({ file: fileName, mime: imageMime(fileName) });
    });
  });
}

export function cacheImage(libId, remoteUrl) {
  const key = String(libId);
  const existing = imageFileFor(key);
  if (existing) {
    return Promise.resolve({ file: existing, mime: imageMime(existing) });
  }
  if (inFlight.has(key)) return inFlight.get(key);
  if (!remoteUrl) {
    return Promise.reject(new Error("没有图片地址"));
  }
  const promise = downloadImage(key, remoteUrl)
    .then((result) => {
      cached.set(key, result.file);
      return result;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
