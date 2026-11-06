import { curlText, BROWSER_UA } from "./http.mjs";

const PATH_RE = /^\/(d|e)\/([A-Za-z0-9]+)/;
const PASS_RE = /pass_md5\/[^"'\s<>]+/;
const IFRAME_RE = /<iframe[^>]+src=["']([^"']+)["']/i;
const OG_TITLE_RE =
  /<meta[^>]+(?:name|property)=["']og:title["'][^>]+content=["']([^"']*)["']/i;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractTitle(html) {
  const match = html.match(OG_TITLE_RE) || html.match(TITLE_RE);
  if (!match) return "";
  return decodeEntities(match[1])
    .replace(/\s*-\s*DoodStream\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
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

function randomAlphaNum(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

export async function resolveDirect(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http/https 链接");
  }
  const pathMatch = parsed.pathname.match(PATH_RE);
  if (!pathMatch) {
    throw new Error("链接格式不支持，需要 /d/<文件ID> 或 /e/<文件ID>");
  }
  const kind = pathMatch[1];
  const fileId = pathMatch[2];
  const headers = {
    "User-Agent": BROWSER_UA,
    Referer: parsed.origin + "/",
  };

  let title = "";
  let embedUrl;
  if (kind === "e") {
    embedUrl = rawUrl;
  } else {
    const page = await curlText(rawUrl, { headers, timeoutMs: 45000 });
    if (page.status >= 400) {
      throw new Error(`播放页请求失败 (HTTP ${page.status})`);
    }
    title = extractTitle(page.body);
    embedUrl = extractEmbedUrl(page.body, page.url, fileId);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await curlText(embedUrl, { headers, timeoutMs: 45000 });
    if (page.status >= 400) {
      throw new Error(`播放页请求失败 (HTTP ${page.status})`);
    }
    if (page.body.indexOf("Just a moment") >= 0) {
      throw new Error("播放页被 Cloudflare 人机验证拦截");
    }
    const match = page.body.match(PASS_RE);
    if (!match) {
      throw new Error("播放页中未找到 pass_md5，文件可能已被删除或站点结构已变更");
    }
    const passPath = match[0].replace(/&amp;/g, "&").replace(/^\/+/, "");
    const token = passPath.substring(passPath.lastIndexOf("/") + 1);
    const passUrl = new URL("/" + passPath, page.url).toString();
    const pass = await curlText(passUrl, {
      headers: Object.assign({}, headers, { Referer: page.url }),
      timeoutMs: 45000,
    });
    const base = pass.body.trim();
    if (base === "RELOAD") continue;
    if (!/^https?:\/\//i.test(base)) {
      throw new Error("pass_md5 返回异常: " + base.substring(0, 120));
    }
    return {
      url: base + randomAlphaNum(10) + "?token=" + token + "&expiry=" + Date.now(),
      referer: page.url,
      name: title || extractTitle(page.body) || fileId,
    };
  }
  throw new Error("播放页要求刷新 (RELOAD)，请重试");
}
