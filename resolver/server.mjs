import http from "node:http";
import { execFile } from "node:child_process";

const PORT = Number(process.env.PORT || 8080);
const TOKEN = (process.env.RESOLVER_TOKEN || "").trim();
const UA =
  process.env.RESOLVER_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const HOST_RE =
  /(^|\.)(dood\.(to|so|ws|la|yt|re|pm|li|watch|work|stream|ink|cx)|doods\.pro|d000d\.com|ds2play\.com|doodstream\.com|playmogo\.com)$/i;
const PATH_RE = /^\/(d|e)\/([A-Za-z0-9]+)/;
const PASS_RE = /pass_md5\/[^"'\s<>]+/;
const IFRAME_RE = /<iframe[^>]+src=["']([^"']+)["']/i;
const OG_TITLE_RE =
  /<meta[^>]+(?:name|property)=["']og:title["'][^>]+content=["']([^"']*)["']/i;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

function trim(value) {
  return String(value == null ? "" : value).replace(/^\s+|\s+$/g, "");
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanTitle(raw) {
  return trim(decodeEntities(raw)).replace(/\s*-\s*DoodStream\s*$/i, "");
}

function extractTitle(html) {
  const match = html.match(OG_TITLE_RE) || html.match(TITLE_RE);
  return match ? cleanTitle(match[1]) : "";
}

function extractEmbedUrl(html, baseUrl, fileId) {
  const match = html.match(IFRAME_RE);
  if (match) {
    let src = match[1];
    if (src.indexOf("//") === 0) src = "https:" + src;
    try {
      return new URL(src, baseUrl).toString();
    } catch {
      // fall through
    }
  }
  return new URL("/e/" + fileId, baseUrl).toString();
}

function curl(url) {
  return new Promise((resolve, reject) => {
    const args = [
      "-sS",
      "-L",
      "--max-time",
      "40",
      "--max-filesize",
      String(MAX_PAGE_BYTES),
      "-A",
      UA,
      "-w",
      "\n__META__%{http_code} %{url_effective}",
      url,
    ];
    execFile(
      "curl",
      args,
      { encoding: "utf8", timeout: 50000, maxBuffer: MAX_PAGE_BYTES + 65536 },
      (err, stdout) => {
        if (err && !stdout) {
          reject(new Error("curl 失败: " + err.message));
          return;
        }
        const idx = stdout.lastIndexOf("__META__");
        if (idx < 0) {
          reject(new Error("curl 返回内容异常"));
          return;
        }
        const body = stdout.slice(0, idx).replace(/\n$/, "");
        const meta = stdout.slice(idx + "__META__".length).trim().split(" ");
        const status = Number(meta[0]) || 0;
        const effectiveUrl = meta.slice(1).join(" ") || url;
        if (status >= 400) {
          reject(new Error(`请求失败 (HTTP ${status}): ${url}`));
          return;
        }
        resolve({ body, url: effectiveUrl });
      }
    );
  });
}

function randomAlphaNum(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

async function resolveDirect(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http/https 链接");
  }
  if (!HOST_RE.test(parsed.hostname)) {
    throw new Error("不支持的域名: " + parsed.hostname);
  }
  const pathMatch = parsed.pathname.match(PATH_RE);
  if (!pathMatch) {
    throw new Error("链接格式不支持，需要 /d/<文件ID> 或 /e/<文件ID>");
  }

  const kind = pathMatch[1];
  const fileId = pathMatch[2];
  let title = "";
  let embedUrl;

  if (kind === "e") {
    embedUrl = rawUrl;
  } else {
    const page = await curl(rawUrl);
    title = extractTitle(page.body);
    embedUrl = extractEmbedUrl(page.body, page.url, fileId);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await curl(embedUrl);
    if (page.body.indexOf("Just a moment") >= 0) {
      throw new Error("播放页被 Cloudflare 人机验证拦截");
    }
    const match = page.body.match(PASS_RE);
    if (!match) {
      throw new Error("播放页中未找到 pass_md5，文件可能已被删除或站点结构已变更");
    }
    const passPath = match[0].replace(/&amp;/g, "&").replace(/^\/+/, "");
    const token = passPath.substring(passPath.lastIndexOf("/") + 1);
    const pass = await curl(new URL("/" + passPath, page.url).toString());
    const base = trim(pass.body);
    if (base === "RELOAD") continue;
    if (!/^https?:\/\//i.test(base)) {
      throw new Error("pass_md5 返回异常: " + base.substring(0, 120));
    }
    return {
      name: title || extractTitle(page.body) || fileId,
      url: base + randomAlphaNum(10) + "?token=" + token + "&expiry=" + Date.now(),
      referer: page.url,
    };
  }
  throw new Error("播放页要求刷新 (RELOAD)，请重试");
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
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
      if (size > 64 * 1024) {
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

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const remote = req.socket.remoteAddress;
  console.log(new Date().toISOString(), req.method, req.url, "from", remote);
  try {
    const requestUrl = new URL(req.url, "http://localhost");
    if (requestUrl.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (requestUrl.pathname !== "/resolve") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      res.end();
      return;
    }
    if (TOKEN && req.headers["x-auth-token"] !== TOKEN) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    let target = "";
    if (req.method === "GET") {
      target = requestUrl.searchParams.get("url") || "";
    } else if (req.method === "POST") {
      const raw = await readBody(req);
      target = (JSON.parse(raw || "{}").url || "").trim();
    } else {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (!target) {
      sendJson(res, 400, { error: "missing url" });
      return;
    }

    const data = await resolveDirect(target);
    console.log("resolved", target, "->", data.url.slice(0, 60) + "...", Date.now() - startedAt + "ms");
    sendJson(res, 200, data);
  } catch (err) {
    console.log("resolve failed:", err.message || String(err), Date.now() - startedAt + "ms");
    sendJson(res, 502, { error: err.message || String(err) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("dood resolver listening on :" + PORT);
});
