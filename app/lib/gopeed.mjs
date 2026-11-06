import { curlJson } from "./http.mjs";

function normalizeBase(settings) {
  let base = String(settings.gopeedUrl || "").trim();
  if (!base) {
    throw new Error("未配置 Gopeed API 地址（在设置里填写，如 http://127.0.0.1:9999）");
  }
  if (!/^https?:\/\//i.test(base)) {
    base = "http://" + base;
  }
  base = base.replace(/\/+$/, "");
  if (!/\/api\/v1$/i.test(base)) {
    base += "/api/v1";
  }
  return base;
}

function headers(settings) {
  const result = { "Content-Type": "application/json" };
  const token = String(settings.apiToken || "").trim();
  if (token) {
    result["X-Api-Token"] = token;
  }
  return result;
}

export async function createTask(settings, file) {
  const payload = {
    req: {
      url: file.url,
      extra: {
        method: "",
        header: file.header || {},
        body: "",
      },
    },
    opts: {
      name: file.name,
      path: file.path,
      extra: {
        connections: Number(settings.connections) || 16,
      },
    },
  };

  const { data } = await curlJson(normalizeBase(settings) + "/tasks", {
    method: "POST",
    headers: headers(settings),
    body: JSON.stringify(payload),
    timeoutMs: 30000,
  });

  if (!data || data.code !== 0) {
    throw new Error((data && (data.msg || data.error)) || "Gopeed 创建任务失败");
  }
  const value = data.data;
  if (value && typeof value === "object") {
    return String(value.id || value.taskId || "");
  }
  return String(value || "");
}

export async function getInfo(settings) {
  const { data } = await curlJson(normalizeBase(settings) + "/info", {
    headers: headers(settings),
    timeoutMs: 15000,
  });
  if (!data || data.code !== 0) {
    throw new Error((data && (data.msg || data.error)) || "Gopeed 连接失败");
  }
  return data.data;
}
