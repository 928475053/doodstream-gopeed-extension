import { curlText } from "./http.mjs";

const BASE = "https://www.spankinglibrary.com";
const IMG_RE = /https:\/\/img\.spankinglibrary\.com\/clipdata\/\d+\/[^"'\s<>]+/g;

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function stripTags(value) {
  return decodeEntities(String(value).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function metaContent(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const direct = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`,
    "i"
  );
  const reversed = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`,
    "i"
  );
  const match = html.match(direct) || html.match(reversed);
  return match ? decodeEntities(match[1]).trim() : "";
}

function parseJsonLd(html) {
  const blocks =
    html.match(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ) || [];
  let product = null;
  let video = null;
  for (const block of blocks) {
    const json = block
      .replace(/^<script[^>]*>/i, "")
      .replace(/<\/script>$/i, "");
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      continue;
    }
    const roots = Array.isArray(parsed) ? parsed : [parsed];
    for (const root of roots) {
      const nodes =
        root["@graph"] && Array.isArray(root["@graph"])
          ? root["@graph"]
          : [root];
      for (const node of nodes) {
        if (!node) continue;
        if (node["@type"] === "Product" && !product) product = node;
        if (node["@type"] === "VideoObject" && !video) video = node;
      }
    }
  }
  return product || video;
}

function extractCategories(html) {
  const index = html.lastIndexOf("Categories:");
  if (index < 0) return [];
  const limit = html.indexOf("Keywords:", index);
  const section = html.slice(
    index,
    limit > index ? limit : Math.min(html.length, index + 4000)
  );
  const categories = [];
  const seen = new Set();
  const re =
    /<a[^>]+href=["'][^"']*category\.php\?id=(\d+)[^"']*["'][^>]*(?:title=["']([^"']*)["'])?[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(section))) {
    const id = Number(match[1]);
    const name = stripTags(match[2] || match[3] || "");
    if (!name || seen.has(id)) continue;
    seen.add(id);
    categories.push({ id, name });
  }
  return categories;
}

function extractImages(html, clipId, ogImage) {
  const images = [];
  const seen = new Set();
  const add = (url) => {
    const clean = String(url || "").replace(/&amp;/g, "&").trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    images.push(clean);
  };
  add(ogImage);
  const matches = html.match(IMG_RE) || [];
  for (const url of matches) {
    if (url.indexOf("/" + clipId + "/") < 0) continue;
    add(url);
    if (images.length >= 12) break;
  }
  return images;
}

function priceFromBlock(html) {
  const match = html.match(
    /Price:\s*<\/span>\s*<span[^>]*>\s*\$?([0-9]+(?:\.[0-9]+)?)/i
  );
  return match ? match[1] : "";
}

function fieldFromBlock(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `${escaped}:\\s*</span>\\s*<span[^>]*>\\s*(?:<span[^>]*>)?\\s*([^<]+)`,
    "i"
  ).exec(html);
  return match ? stripTags(match[1]) : "";
}

export async function fetchClip(clipId, options = {}) {
  const id = Number(clipId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("无效的 spankinglibrary ID");
  }
  const url = `${BASE}/clipdetails.php?id=${id}`;
  const headers = {
    "Accept-Language": "en-US,en;q=0.9",
    Referer: BASE + "/",
  };

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await curlText(url, {
        timeoutMs: options.timeoutMs || 45000,
        headers,
      });
      if (res.status === 404) return null;
      if (res.status === 403 || res.body.indexOf("Just a moment") >= 0) {
        throw new Error("spankinglibrary 触发了 Cloudflare 验证");
      }
      if (res.status >= 400) {
        throw new Error(`spankinglibrary 返回 HTTP ${res.status}`);
      }
      const html = res.body;
      if (!html || html.indexOf("clipdetails.php?id=") < 0) {
        if (/Not Found|video you are looking for is not found/i.test(html)) {
          return null;
        }
        throw new Error("spankinglibrary 返回了异常页面");
      }
      return parseClipPage(html, id, url);
    } catch (err) {
      lastError = err;
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
    }
  }
  throw lastError || new Error("spankinglibrary 抓取失败");
}

function parseClipPage(html, id, url) {

  const jsonLd = parseJsonLd(html);
  const product =
    jsonLd && jsonLd.offers
      ? jsonLd
      : null;

  const title =
    metaContent(html, "og:title") ||
    (jsonLd && jsonLd.name) ||
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])
      .slice(1)
      .join("")
      .replace(/\s*-\s*SpankingLibrary\.com\s*$/i, "") ||
    "";

  const description =
    metaContent(html, "og:description") || (jsonLd && jsonLd.description) || "";

  const storeMatch = html.match(
    /Store:\s*<\/span>\s*<a[^>]*>([\s\S]*?)<\/a>/i
  );
  const store = storeMatch ? stripTags(storeMatch[1]) : "";
  const storeIdMatch = html.match(/store\.php\?id=(\d+)/i);
  const storeId = storeIdMatch ? Number(storeIdMatch[1]) : null;

  const categories = extractCategories(html);
  const image = metaContent(html, "og:image");
  const images = extractImages(html, id, image);
  const price =
    (product && product.offers && String(product.offers.price || "")) ||
    priceFromBlock(html);
  const currency =
    (product &&
      product.offers &&
      String(product.offers.priceCurrency || "USD")) ||
    "USD";

  return {
    id,
    title: stripTags(title),
    description: stripTags(description),
    image: images[0] || image,
    images,
    price,
    currency,
    store,
    storeId,
    categories,
    resolution: fieldFromBlock(html, "Resolution"),
    fileSize: fieldFromBlock(html, "File Size"),
    length: fieldFromBlock(html, "Movie Length"),
    url,
    fetchedAt: Date.now(),
  };
}
