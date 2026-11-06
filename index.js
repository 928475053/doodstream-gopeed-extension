const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const VIDEO_EXT_RE = /\.(mp4|mkv|webm|avi|mov|m4v|flv|wmv|ts|m3u8)$/i;
const PATH_RE = /^\/(d|e)\/([A-Za-z0-9]+)/;
const PASS_RE = /pass_md5\/[^"'\s<>]+/;
const IFRAME_RE = /<iframe[^>]+src=["']([^"']+)["']/i;
const OG_TITLE_RE = /<meta[^>]+(?:name|property)=["']og:title["'][^>]+content=["']([^"']*)["']/i;
const OG_TITLE_REV_RE = /<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']og:title["']/i;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

function trim(value) {
  return String(value == null ? "" : value).replace(/^\s+|\s+$/g, "");
}

function settingsValue(ctx, name) {
  const settings = (gopeed && gopeed.settings) || (ctx && ctx.settings) || {};
  return trim(settings[name]);
}

function userAgent(ctx) {
  return settingsValue(ctx, "ua") || DEFAULT_UA;
}

function randomAlphaNum(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
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

function safeFileName(raw, fallbackId) {
  let name = cleanTitle(raw).replace(/\s+/g, " ");
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  name = name.replace(/^[. ]+|[. ]+$/g, "");
  if (!name) {
    name = fallbackId;
  }
  if (!VIDEO_EXT_RE.test(name)) {
    name += ".mp4";
  }
  if (name.length > 150) {
    const extMatch = name.match(/\.[A-Za-z0-9]{1,5}$/);
    const ext = extMatch ? extMatch[0] : "";
    name = name.slice(0, 150 - ext.length) + ext;
  }
  return name;
}

function extractTitle(html) {
  const match =
    html.match(OG_TITLE_RE) || html.match(OG_TITLE_REV_RE) || html.match(TITLE_RE);
  return match ? cleanTitle(match[1]) : "";
}

function extractEmbedUrl(html, baseUrl, fileId) {
  const match = html.match(IFRAME_RE);
  if (match) {
    let src = match[1];
    if (src.indexOf("//") === 0) {
      src = "https:" + src;
    }
    try {
      return new URL(src, baseUrl).toString();
    } catch (err) {
      // fall through to the conventional embed path
    }
  }
  return new URL("/e/" + fileId, baseUrl).toString();
}

async function requestText(url, headers) {
  const resp = await fetch(url, {
    method: "GET",
    headers: headers,
    redirect: "follow",
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error("请求失败 (HTTP " + resp.status + "): " + url);
  }
  return { text: text, url: resp.url || url };
}

// DoodStream player flow: embed page -> /pass_md5/<...>/<token> -> base URL,
// then base + 10 random chars + ?token=<token>&expiry=<now> is the signed CDN link.
function buildDirectUrl(base, token) {
  return base + randomAlphaNum(10) + "?token=" + token + "&expiry=" + Date.now();
}

async function resolveViaHttp(embedUrl, headers) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await requestText(embedUrl, headers);
    if (page.text.indexOf("Just a moment") >= 0) {
      throw new Error("播放页被 Cloudflare 人机验证拦截");
    }
    const match = page.text.match(PASS_RE);
    if (!match) {
      throw new Error("播放页中未找到 pass_md5，文件可能已被删除或站点结构已变更");
    }
    const passPath = match[0].replace(/&amp;/g, "&").replace(/^\/+/, "");
    const token = passPath.substring(passPath.lastIndexOf("/") + 1);
    const passUrl = new URL("/" + passPath, page.url).toString();

    const pass = await requestText(
      passUrl,
      Object.assign({}, headers, { Referer: page.url })
    );
    const base = trim(pass.text);
    if (base === "RELOAD") {
      continue;
    }
    if (!/^https?:\/\//i.test(base)) {
      throw new Error("pass_md5 返回了异常内容: " + base.substring(0, 120));
    }
    return {
      url: buildDirectUrl(base, token),
      referer: page.url,
      title: extractTitle(page.text),
    };
  }
  throw new Error("播放页要求刷新后重试 (RELOAD)");
}

async function resolveViaResolver(ctx, embedUrl) {
  const endpoint = settingsValue(ctx, "resolverUrl");
  if (!endpoint) {
    return null;
  }
  const headers = { "Content-Type": "application/json" };
  const token = settingsValue(ctx, "resolverToken");
  if (token) {
    headers["X-Auth-Token"] = token;
  }
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: headers,
    body: JSON.stringify({ url: embedUrl }),
  });
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error("解析服务返回非 JSON (HTTP " + resp.status + ")");
  }
  if (!resp.ok || data.error) {
    throw new Error(data.error || "解析服务请求失败 (HTTP " + resp.status + ")");
  }
  if (!data.url) {
    throw new Error("解析服务未返回直链");
  }
  return {
    url: String(data.url),
    referer: String(data.referer || embedUrl),
    title: cleanTitle(data.name || data.title || ""),
  };
}

function webviewAvailable() {
  const runtime = gopeed && gopeed.runtime;
  const webview = runtime && runtime.webview;
  try {
    return !!(webview && webview.isAvailable && webview.isAvailable());
  } catch (err) {
    return false;
  }
}

// Browser fallback: Cloudflare fingerprints the Go/Node TLS stack, so when the
// plain HTTP path is challenged we resolve inside a real WebView instead.
async function resolveViaWebview(embedUrl) {
  if (!webviewAvailable()) {
    return null;
  }
  const page = await gopeed.runtime.webview.open({
    headless: true,
    title: "DoodStream Resolver",
    width: 1280,
    height: 800,
  });
  try {
    await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeoutMs: 60000 });

    const ready = await page.waitForFunction(
      function () {
        var html = document.documentElement ? document.documentElement.innerHTML : "";
        return html.indexOf("pass_md5/") >= 0;
      },
      { timeoutMs: 60000 }
    );
    if (!ready) {
      throw new Error("WebView 等待播放页超时，可能未通过 Cloudflare 人机验证");
    }

    const data = await page.execute(async function () {
      var html = document.documentElement.innerHTML;
      var match = html.match(/pass_md5\/[^"'\s<>]+/);
      if (!match) {
        return { error: "pass_md5 not found in page" };
      }
      var passPath = match[0].replace(/&amp;/g, "&").replace(/^\/+/, "");
      var token = passPath.substring(passPath.lastIndexOf("/") + 1);
      var resp = await fetch("/" + passPath, {
        headers: { Referer: location.href },
      });
      var base = (await resp.text()).replace(/^\s+|\s+$/g, "");
      if (!/^https?:\/\//i.test(base) || base === "RELOAD") {
        return { error: "unexpected pass_md5 response: " + base.substring(0, 100) };
      }
      var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      var rand = "";
      for (var i = 0; i < 10; i++) {
        rand += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
      }
      var video = document.querySelector("video");
      var src = video && (video.currentSrc || video.src);
      var meta = document.querySelector(
        'meta[name="og:title"], meta[property="og:title"]'
      );
      return {
        url:
          src && /^https?:/i.test(src)
            ? src
            : base + rand + "?token=" + token + "&expiry=" + Date.now(),
        referer: location.href,
        title: (meta && meta.content) || document.title || "",
      };
    });

    if (!data) {
      throw new Error("WebView 未返回解析结果");
    }
    if (data.error) {
      throw new Error("WebView 解析失败: " + data.error);
    }
    return {
      url: String(data.url),
      referer: String(data.referer),
      title: cleanTitle(data.title),
    };
  } finally {
    await page.close();
  }
}

gopeed.events.onResolve(async function (ctx) {
  const input = ctx.req.url;
  const parsed = new URL(input);
  const pathMatch = parsed.pathname.match(PATH_RE);
  if (!pathMatch) {
    throw new Error("链接格式不支持，请使用 https://<域名>/d/<文件ID> 或 /e/<文件ID>。");
  }

  const kind = pathMatch[1];
  const fileId = pathMatch[2];
  const ua = userAgent(ctx);
  const headers = {
    "User-Agent": ua,
    Referer: parsed.origin + "/",
  };

  let title = "";
  let embedUrl;
  if (kind === "e") {
    embedUrl = input;
  } else {
    try {
      const page = await requestText(input, headers);
      title = extractTitle(page.text);
      embedUrl = extractEmbedUrl(page.text, page.url, fileId);
    } catch (err) {
      embedUrl = new URL("/e/" + fileId, input).toString();
    }
  }

  let resolved = null;
  const errors = [];

  if (settingsValue(ctx, "resolverUrl")) {
    try {
      resolved = await resolveViaResolver(ctx, embedUrl);
    } catch (err) {
      errors.push("解析服务: " + err.message);
    }
  }

  if (!resolved) {
    try {
      resolved = await resolveViaHttp(embedUrl, headers);
    } catch (err) {
      errors.push("直连: " + err.message);
    }
  }

  if (!resolved) {
    try {
      resolved = await resolveViaWebview(embedUrl);
      if (!resolved) {
        errors.push("WebView: 当前平台不可用");
      }
    } catch (err) {
      errors.push("WebView: " + err.message);
    }
  }

  if (!resolved) {
    throw new Error(
      "解析失败。" +
        errors.join("；") +
        "。Docker/NAS 等无 WebView 的环境请在扩展设置中填写【解析服务地址】。"
    );
  }

  if (!title) {
    title = resolved.title;
  }
  const fileName = safeFileName(title, fileId);

  ctx.res = {
    name: fileName,
    files: [
      {
        name: fileName,
        req: {
          url: resolved.url,
          extra: {
            headers: {
              "User-Agent": ua,
              Referer: resolved.referer,
            },
          },
        },
      },
    ],
  };
});
