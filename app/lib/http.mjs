import { execFile } from "node:child_process";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * curl-backed HTTP helper. Node/Go TLS stacks are challenged by Cloudflare on
 * several of these hosts, while curl is accepted, so every outbound request in
 * the app goes through curl.
 */
export function curlText(url, options = {}) {
  const {
    headers = {},
    method = "GET",
    body = null,
    maxBytes = 8 * 1024 * 1024,
    timeoutMs = 60000,
  } = options;

  return new Promise((resolve, reject) => {
    const args = [
      "-sS",
      "-L",
      "--compressed",
      "--max-time",
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      "--max-filesize",
      String(maxBytes),
      "-A",
      BROWSER_UA,
      "-w",
      "\n__META__%{http_code} %{url_effective}",
    ];
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null || value === "") continue;
      args.push("-H", `${key}: ${value}`);
    }
    if (method !== "GET") args.push("-X", method);
    if (body !== null) args.push("--data-binary", body);
    args.push(url);

    execFile(
      "curl",
      args,
      { encoding: "utf8", timeout: timeoutMs + 5000, maxBuffer: maxBytes + 65536 },
      (err, stdout) => {
        if (err && !stdout) {
          reject(new Error("curl 请求失败: " + err.message));
          return;
        }
        const output = String(stdout || "");
        const marker = output.lastIndexOf("__META__");
        if (marker < 0) {
          reject(new Error("curl 返回内容异常"));
          return;
        }
        const content = output.slice(0, marker).replace(/\n$/, "");
        const meta = output
          .slice(marker + "__META__".length)
          .trim()
          .split(" ");
        const status = Number(meta[0]) || 0;
        const effectiveUrl = meta.slice(1).join(" ") || url;
        resolve({ status, url: effectiveUrl, body: content });
      }
    );
  });
}

export async function curlJson(url, options = {}) {
  const res = await curlText(url, options);
  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error(`返回非 JSON (HTTP ${res.status})`);
  }
  if (res.status >= 400) {
    throw new Error(
      (data && (data.error || data.msg)) || `请求失败 (HTTP ${res.status})`
    );
  }
  return { status: res.status, data };
}
