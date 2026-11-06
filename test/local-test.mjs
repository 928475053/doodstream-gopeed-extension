import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "index.js");
const target = process.argv[2] || "https://dood.to/d/g68gu8474zzs";
const useWebview = process.argv.includes("--webview");
const useResolver = process.argv.includes("--resolver");

// Node's own TLS stack is Cloudflare-challenged here, so route every request
// through curl to exercise the extension's HTTP logic for real.
function curlRaw(url, headers = {}, extraArgs = [], requestBody = null) {
  const tmp = join(here, ".body.tmp");
  const tmpHeaders = join(here, ".headers.tmp");
  const args = ["-sS", "-L", "--max-time", "60", "-o", tmp, "-D", tmpHeaders];
  let hasUA = false;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "user-agent") hasUA = true;
    args.push("-H", `${k}: ${v}`);
  }
  if (!hasUA) {
    args.push(
      "-A",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
  }
  if (requestBody != null) args.push("--data-binary", requestBody);
  args.push("-w", "%{http_code} %{url_effective}", ...extraArgs, url);
  let out;
  try {
    out = execFileSync("curl", args, { encoding: "utf8" });
  } catch (err) {
    out = String(err.stdout || "0 " + url);
  }
  const [statusStr, effective] = out.trim().split(" ");
  let body = "";
  let responseHeaders = "";
  try {
    body = readFileSync(tmp, "utf8");
  } catch {}
  try {
    responseHeaders = readFileSync(tmpHeaders, "utf8");
  } catch {}
  for (const f of [tmp, tmpHeaders]) {
    try {
      unlinkSync(f);
    } catch {}
  }
  const status = Number(statusStr) || 0;
  return { status, url: effective || url, body, headers: responseHeaders };
}

function pageLike(url) {
  return /\/[de]\/[A-Za-z0-9]+\/?(?:\?.*)?$/.test(url);
}

async function curlFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input.url;
  const absolute = url.startsWith("http")
    ? url
    : (globalThis.location ? globalThis.location.origin : "") + url;
  const headers = init.headers || {};
  if ((useWebview || useResolver) && pageLike(absolute)) {
    return {
      ok: false,
      status: 403,
      url: absolute,
      text: async () => "<title>Just a moment...</title>",
    };
  }
  const res = curlRaw(
    absolute,
    headers,
    [],
    init.body != null ? String(init.body) : null
  );
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    url: res.url,
    text: async () => res.body,
  };
}

globalThis.fetch = curlFetch;

let handler = null;
const runtime = {};
if (useWebview) {
  runtime.webview = {
    isAvailable: () => true,
    open: async () => {
      let pageHtml = "";
      let pageUrl = "";
      return {
        goto: async (url) => {
          const res = curlRaw(url, {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            Referer: "https://dood.to/",
          });
          if (res.status >= 400) {
            throw new Error("goto failed: HTTP " + res.status);
          }
          pageHtml = res.body;
          pageUrl = res.url;
          globalThis.location = {
            href: pageUrl,
            origin: new URL(pageUrl).origin,
          };
          globalThis.document = {
            documentElement: { innerHTML: pageHtml },
            title: (pageHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "",
            querySelector: () => null,
          };
        },
        waitForFunction: async (fn) => fn(),
        execute: async (fn) => fn(),
        close: async () => {},
      };
    },
  };
}

globalThis.gopeed = {
  settings: useResolver
    ? {
        resolverUrl: process.env.RESOLVER_URL || "http://127.0.0.1:18080/resolve",
        resolverToken: process.env.RESOLVER_TOKEN || "",
      }
    : {},
  info: { name: "doodstream" },
  logger: console,
  runtime,
  events: {
    onResolve(fn) {
      handler = fn;
    },
  },
};

new Function(readFileSync(entry, "utf8"))();

if (!handler) {
  throw new Error("extension did not register onResolve");
}

const ctx = { req: { url: target, labels: {} }, res: null };
const started = Date.now();
await handler(ctx);
console.log(
  "mode:",
  useWebview ? "webview-fallback" : useResolver ? "resolver" : "http",
  "| resolved in",
  Date.now() - started,
  "ms"
);
console.log(JSON.stringify(ctx.res, null, 2));

const file = ctx.res.files[0];
const check = curlRaw(
  file.req.url,
  Object.assign({}, file.req.extra.headers, { Range: "bytes=0-1023" })
);
console.log("download check:", check.status, "final:", check.url);
const type = (check.headers.match(/content-type:\s*([^\r\n]+)/i) || [])[1] || "";
const range = (check.headers.match(/content-range:\s*([^\r\n]+)/i) || [])[1] || "";
console.log("content-type:", type, "| content-range:", range);

if (check.status !== 206) {
  process.exitCode = 1;
}
