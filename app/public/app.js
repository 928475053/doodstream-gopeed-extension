const state = {
  page: 1,
  pageSize: 24,
  q: "",
  status: "",
  doodOnly: true,
  category: "",
  total: 0,
  pages: 1,
};

const metaCache = new Map();
const metaQueue = [];
const queued = new Set();
let activeMeta = 0;
const MAX_META_CONCURRENCY = 2;
let observer = null;
let prefetchTimer = null;
let toastTimer = null;

const $ = (selector) => document.querySelector(selector);
const grid = $("#grid");

function esc(value) {
  return String(value == null ? "" : value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]
  );
}

async function api(path, options) {
  const res = await fetch(path, options);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(data.error || data.msg || `HTTP ${res.status}`);
  return data;
}

function toast(message, isError) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", !!isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 5000);
}

function formatPrice(meta) {
  if (!meta || !meta.price) return "";
  const value = String(meta.price);
  return meta.currency === "USD" || !meta.currency
    ? `$${value}`
    : `${value} ${meta.currency}`;
}

function siteUrl(item, meta) {
  if (meta && meta.url) return meta.url;
  if (item.libId) {
    return `https://www.spankinglibrary.com/clipdetails.php?id=${item.libId}`;
  }
  return item.dood || "#";
}

function renderCard(item, meta) {
  const title = (meta && meta.title) || item.title || item.name;
  const price = formatPrice(meta);
  const image = meta && meta.image ? meta.image : "";
  const categories = (meta && meta.categories) || [];
  const chips = categories
    .slice(0, 3)
    .map((category) => `<span class="chip">${esc(category.name)}</span>`)
    .join("");
  const more =
    categories.length > 3
      ? `<span class="chip more">+${categories.length - 3}</span>`
      : "";
  const store = (meta && meta.store) || "";
  const stateText = meta
    ? [meta.resolution, meta.length].filter(Boolean).join(" · ") || "已采集"
    : "正在获取截图 / 价格 / 分类…";

  return `
    <article class="card" data-lib="${esc(item.libId || "")}" data-key="${esc(item.key)}">
      <a class="thumb" href="${esc(siteUrl(item, meta))}" target="_blank" rel="noreferrer">
        ${
          image
            ? `<img src="${esc(image)}" alt="${esc(title)}" loading="lazy" referrerpolicy="no-referrer" />`
            : `<div class="skeleton"></div>`
        }
        <span class="badge-id">#${esc(item.libId || "—")}</span>
        ${price ? `<span class="price">${esc(price)}</span>` : ""}
      </a>
      <div class="card-body">
        <h3 class="card-title" title="${esc(title)}">${esc(title)}</h3>
        <div class="meta-line">${store ? esc(store) : "&nbsp;"}</div>
        <div class="chips">${chips}${more}</div>
        <div class="meta-state${meta ? "" : ""}" data-state>${esc(stateText)}</div>
        <div class="actions">
          <button class="download" data-lib="${esc(item.libId || "")}" ${
            item.dood ? "" : "disabled"
          }>下载到 Gopeed</button>
          <a class="link" href="${esc(item.dood || "#")}" target="_blank" rel="noreferrer">Dood</a>
        </div>
      </div>
    </article>
  `;
}

function ensureObserver() {
  if (observer) return observer;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const card = entry.target;
        observer.unobserve(card);
        const libId = Number(card.dataset.lib);
        if (libId) queueMeta(libId);
      }
    },
    { rootMargin: "320px 0px" }
  );
  return observer;
}

function queueMeta(libId) {
  if (!libId || metaCache.has(libId) || queued.has(libId)) return;
  queued.add(libId);
  metaQueue.push(libId);
  pumpMeta();
}

async function pumpMeta() {
  if (activeMeta >= MAX_META_CONCURRENCY) return;
  const libId = metaQueue.shift();
  if (!libId) return;
  activeMeta++;
  try {
    const data = await api(`/api/meta/${libId}`);
    metaCache.set(libId, data.meta);
    const card = grid.querySelector(`.card[data-lib="${libId}"]`);
    if (card) {
      const item = JSON.parse(card.dataset.item || "null");
      if (item) card.outerHTML = renderCard(item, data.meta);
    }
  } catch (err) {
    queued.delete(libId);
    const card = grid.querySelector(`.card[data-lib="${libId}"] .meta-state`);
    if (card) {
      card.classList.add("error");
      card.textContent = "信息获取失败，点击重试";
      card.dataset.retry = String(libId);
    }
  } finally {
    activeMeta--;
    pumpMeta();
  }
}

function bindItems(items) {
  // Store the item payload on each card so a meta refresh can re-render it.
  for (const item of items) {
    const card = grid.querySelector(`.card[data-key="${CSS.escape(item.key)}"]`);
    if (card) {
      card.dataset.item = JSON.stringify(item);
    }
  }
}

async function loadStats() {
  try {
    const data = await api("/api/stats");
    $("#stats").innerHTML = `
      <span><b>${data.withDood.toLocaleString()}</b> 条可下载记录</span>
      <span><b>${data.metaCached.toLocaleString()}</b> 条已采集</span>
    `;
    return data;
  } catch {
    $("#stats").textContent = "统计加载失败";
    return null;
  }
}

async function loadCategories() {
  try {
    const data = await api("/api/categories");
    const select = $("#category");
    const current = select.value;
    select.innerHTML =
      `<option value="">全部标签（已采集）</option>` +
      data.categories
        .map(
          (category) =>
            `<option value="${esc(category.name)}">${esc(category.name)} (${category.count})</option>`
        )
        .join("");
    select.value = current;
  } catch {
    // ignore
  }
}

async function load() {
  grid.innerHTML = `<div class="empty">加载中…</div>`;
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
    doodOnly: state.doodOnly ? "1" : "0",
  });
  if (state.q) params.set("q", state.q);
  if (state.status) params.set("status", state.status);
  if (state.category) params.set("category", state.category);

  try {
    const data = await api("/api/items?" + params.toString());
    state.total = data.total;
    state.pages = data.pages;
    if (state.page > data.pages) {
      state.page = data.pages;
      return load();
    }
    if (data.items.length === 0) {
      grid.innerHTML = `<div class="empty">没有匹配的条目。请检查 Excel 是否已挂载，或调整筛选条件。</div>`;
    } else {
      grid.innerHTML = data.items
        .map((item) => renderCard(item, item.meta))
        .join("");
      bindItems(data.items);
      const io = ensureObserver();
      for (const item of data.items) {
        if (!item.meta && item.libId) {
          const card = grid.querySelector(
            `.card[data-key="${CSS.escape(item.key)}"]`
          );
          if (card) io.observe(card);
        }
      }
    }
    $("#page-info").textContent = `第 ${state.page} / ${data.pages} 页 · 共 ${data.total.toLocaleString()} 条`;
    $("#prev").disabled = state.page <= 1;
    $("#next").disabled = state.page >= data.pages;
  } catch (err) {
    grid.innerHTML = `<div class="empty">加载失败：${esc(err.message)}</div>`;
  }
}

async function download(button) {
  const libId = Number(button.dataset.lib);
  if (!libId) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "发送中…";
  try {
    const data = await api(`/api/download/${libId}`, { method: "POST" });
    toast(
      `已发送到 Gopeed\n${data.name}\n目录：${data.path}` +
        (data.warning ? `\n${data.warning}` : ""),
      false
    );
  } catch (err) {
    toast(`下载发送失败：${err.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

grid.addEventListener("click", (event) => {
  const button = event.target.closest(".download");
  if (button) {
    download(button);
    return;
  }
  const retry = event.target.closest(".meta-state.error");
  if (retry && retry.dataset.retry) {
    const libId = Number(retry.dataset.retry);
    delete retry.dataset.retry;
    retry.classList.remove("error");
    retry.textContent = "正在获取截图 / 价格 / 分类…";
    queued.delete(libId);
    queueMeta(libId);
  }
});

let searchTimer = null;
$("#search").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = event.target.value.trim();
    state.page = 1;
    load();
  }, 350);
});

$("#status").addEventListener("change", (event) => {
  state.status = event.target.value;
  state.page = 1;
  load();
});

$("#dood-only").addEventListener("change", (event) => {
  state.doodOnly = event.target.checked;
  state.page = 1;
  load();
});

$("#category").addEventListener("change", (event) => {
  state.category = event.target.value;
  state.page = 1;
  load();
});

$("#page-size").addEventListener("change", (event) => {
  state.pageSize = Number(event.target.value) || 24;
  state.page = 1;
  load();
});

$("#prev").addEventListener("click", () => {
  if (state.page > 1) {
    state.page--;
    load();
  }
});

$("#next").addEventListener("click", () => {
  if (state.page < state.pages) {
    state.page++;
    load();
  }
});

$("#refresh").addEventListener("click", async () => {
  await Promise.all([loadStats(), loadCategories()]);
  load();
});

const dialog = $("#settings-dialog");

async function fillSettings() {
  try {
    const data = await api("/api/settings");
    $("#set-gopeed").value = data.settings.gopeedUrl || "";
    $("#set-token").value = data.settings.apiToken || "";
    $("#set-root").value = data.settings.downloadRoot || "/app/Downloads";
    $("#set-interval").value = data.settings.fetchIntervalMs || 1200;
    $("#set-connections").value = data.settings.connections || 16;
  } catch (err) {
    toast(err.message, true);
  }
}

function renderPrefetch(status) {
  const bar = $("#prefetch-bar");
  const text = $("#prefetch-status");
  if (!status || (!status.running && !status.total)) {
    bar.style.width = "0%";
    text.textContent = "未开始";
    return;
  }
  const percent = status.total
    ? Math.min(100, Math.round((status.done / status.total) * 100))
    : 0;
  bar.style.width = percent + "%";
  const current = status.current
    ? `当前 #${status.current.libId} ${status.current.title}`
    : "";
  text.textContent = `${status.running ? "采集中" : "已停止"} · ${status.done}/${
    status.total
  }（失败 ${status.errors}）${current ? " · " + current : ""}`;
}

async function pollPrefetch() {
  try {
    const status = await api("/api/prefetch/status");
    renderPrefetch(status);
    if (status.running && dialog.open) {
      clearTimeout(prefetchTimer);
      prefetchTimer = setTimeout(pollPrefetch, 2000);
    }
  } catch {
    // ignore
  }
}

$("#open-settings").addEventListener("click", async () => {
  await fillSettings();
  pollPrefetch();
  dialog.showModal();
});

$("#save-settings").addEventListener("click", async () => {
  const payload = {
    gopeedUrl: $("#set-gopeed").value.trim(),
    apiToken: $("#set-token").value,
    downloadRoot: $("#set-root").value.trim() || "/app/Downloads",
    fetchIntervalMs: Number($("#set-interval").value) || 1200,
    connections: Number($("#set-connections").value) || 16,
  };
  try {
    await api("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast("设置已保存");
  } catch (err) {
    toast(err.message, true);
  }
});

$("#test-gopeed").addEventListener("click", async () => {
  const button = $("#test-gopeed");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "测试中…";
  try {
    const data = await api("/api/settings/test", { method: "POST" });
    toast(`Gopeed 连接成功（${data.info.version || "unknown"}）`);
  } catch (err) {
    toast(`Gopeed 连接失败：${err.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

async function prefetchAction(path, options) {
  try {
    const status = await api(path, options);
    renderPrefetch(status);
    if (status.running) {
      clearTimeout(prefetchTimer);
      prefetchTimer = setTimeout(pollPrefetch, 1500);
    }
    toast(status.running ? "后台采集已启动" : "后台采集已停止");
  } catch (err) {
    toast(err.message, true);
  }
}

$("#prefetch-start").addEventListener("click", () =>
  prefetchAction("/api/prefetch/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
);

$("#prefetch-start-refresh").addEventListener("click", () =>
  prefetchAction("/api/prefetch/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh: true }),
  })
);

$("#prefetch-stop").addEventListener("click", () =>
  prefetchAction("/api/prefetch/stop", { method: "POST" })
);

dialog.addEventListener("close", () => {
  clearTimeout(prefetchTimer);
});

loadStats();
loadCategories();
load();
