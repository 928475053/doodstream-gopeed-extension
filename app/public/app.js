const state = {
  page: 1,
  pageSize: 24,
  q: "",
  tags: new Set(),
  stores: new Set(),
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
      ${data.failures ? `<span><b>${data.failures.toLocaleString()}</b> 条采集失败</span>` : ""}
    `;
    return data;
  } catch {
    $("#stats").textContent = "统计加载失败";
    return null;
  }
}

const facetData = { tag: [], store: [] };
let openFacetKind = null;
let filterTimer = null;

function selectedSet(kind) {
  return kind === "tag" ? state.tags : state.stores;
}

function facetLabel(kind) {
  return kind === "tag" ? "标签" : "Store";
}

function updateFacetButton(kind) {
  const selected = selectedSet(kind);
  const button = document.querySelector(`#${kind}-btn`);
  if (!button) return;
  button.textContent = selected.size
    ? `${facetLabel(kind)}：${selected.size} 项`
    : `${facetLabel(kind)}：全部`;
  button.classList.toggle("active", selected.size > 0);
}

function renderFacetOptions(kind) {
  const container = document.querySelector(`#${kind}-options`);
  if (!container) return;
  const search = document
    .querySelector(`#${kind}-search`)
    .value.trim()
    .toLowerCase();
  const selected = selectedSet(kind);
  const list = facetData[kind].filter(
    (entry) => !search || String(entry.name).toLowerCase().includes(search)
  );
  container.innerHTML = list.length
    ? list
        .map(
          (entry) => `
          <label class="facet-option">
            <input type="checkbox" value="${esc(entry.name)}" ${
              selected.has(entry.name) ? "checked" : ""
            } />
            <span class="facet-name" title="${esc(entry.name)}">${esc(entry.name)}</span>
            <span class="facet-count">${entry.count}</span>
          </label>`
        )
        .join("")
    : `<div class="facet-empty">没有匹配项</div>`;
  updateFacetButton(kind);
}

async function loadFacets() {
  try {
    const [tagData, storeData] = await Promise.all([
      api("/api/categories"),
      api("/api/stores"),
    ]);
    facetData.tag = tagData.categories || [];
    facetData.store = storeData.stores || [];
    for (const kind of ["tag", "store"]) {
      const names = new Set(facetData[kind].map((entry) => entry.name));
      for (const value of [...selectedSet(kind)]) {
        if (!names.has(value)) selectedSet(kind).delete(value);
      }
      renderFacetOptions(kind);
    }
  } catch {
    // ignore
  }
}

function positionFacetPanel(kind) {
  const button = document.querySelector(`#${kind}-btn`);
  const panel = document.querySelector(`#${kind}-panel`);
  if (!button || !panel) return;
  const rect = button.getBoundingClientRect();
  const margin = 12;
  const top = Math.max(margin, Math.round(rect.bottom + 6));
  panel.style.position = "fixed";
  panel.style.top = top + "px";
  panel.style.maxHeight =
    Math.max(220, window.innerHeight - top - margin) + "px";
  if (window.innerWidth <= 720) {
    panel.style.left = margin + "px";
    panel.style.right = margin + "px";
    panel.style.width = "auto";
  } else {
    const width = 360;
    const left = Math.min(
      Math.max(margin, rect.left),
      window.innerWidth - width - margin
    );
    panel.style.left = left + "px";
    panel.style.right = "auto";
    panel.style.width = width + "px";
  }
}

function closeFacets() {
  for (const kind of ["tag", "store"]) {
    const facet = document.querySelector(`#${kind}-facet`);
    const button = document.querySelector(`#${kind}-btn`);
    const panel = document.querySelector(`#${kind}-panel`);
    if (facet) facet.classList.remove("open");
    if (button) button.setAttribute("aria-expanded", "false");
    if (panel) panel.removeAttribute("style");
  }
  openFacetKind = null;
}

function openFacet(kind) {
  if (openFacetKind === kind) {
    closeFacets();
    return;
  }
  closeFacets();
  const facet = document.querySelector(`#${kind}-facet`);
  const button = document.querySelector(`#${kind}-btn`);
  if (!facet || !button) return;
  facet.classList.add("open");
  button.setAttribute("aria-expanded", "true");
  openFacetKind = kind;
  renderFacetOptions(kind);
  positionFacetPanel(kind);
}

function scheduleFilterReload() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    state.page = 1;
    load();
  }, 350);
}

for (const kind of ["tag", "store"]) {
  document.querySelector(`#${kind}-btn`).addEventListener("click", (event) => {
    event.stopPropagation();
    openFacet(kind);
  });
  document
    .querySelector(`#${kind}-options`)
    .addEventListener("change", (event) => {
      const checkbox = event.target.closest('input[type="checkbox"]');
      if (!checkbox) return;
      if (checkbox.checked) selectedSet(kind).add(checkbox.value);
      else selectedSet(kind).delete(checkbox.value);
      updateFacetButton(kind);
      scheduleFilterReload();
    });
  document
    .querySelector(`#${kind}-search`)
    .addEventListener("input", () => renderFacetOptions(kind));
  document
    .querySelector(`#${kind}-clear`)
    .addEventListener("click", () => {
      selectedSet(kind).clear();
      for (const checkbox of document.querySelectorAll(
        `#${kind}-options input[type="checkbox"]`
      )) {
        checkbox.checked = false;
      }
      updateFacetButton(kind);
      scheduleFilterReload();
    });
  document
    .querySelector(`#${kind}-done`)
    .addEventListener("click", () => closeFacets());
}

document.addEventListener("click", (event) => {
  if (!openFacetKind) return;
  if (event.target.closest(".facet")) return;
  closeFacets();
});

window.addEventListener("resize", () => {
  if (openFacetKind) closeFacets();
});

window.addEventListener("scroll", () => {
  if (openFacetKind) closeFacets();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && openFacetKind) closeFacets();
});

async function load() {
  grid.innerHTML = `<div class="empty">加载中…</div>`;
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
  });
  if (state.q) params.set("q", state.q);
  for (const tag of state.tags) params.append("tag", tag);
  for (const store of state.stores) params.append("store", store);

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
  await Promise.all([loadStats(), loadFacets()]);
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
    $("#set-concurrency").value = data.settings.fetchConcurrency || 4;
    $("#set-connections").value = data.settings.connections || 16;
  } catch (err) {
    toast(err.message, true);
  }
}

function renderPrefetch(status) {
  const bar = $("#prefetch-bar");
  const text = $("#prefetch-status");
  const retry = $("#prefetch-retry");
  const failed = Number(status && status.failed) || 0;
  if (retry) {
    retry.disabled = !status || status.running || failed === 0;
    retry.textContent = failed > 0 ? `重试失败 (${failed})` : "重试失败";
  }
  if (!status || (!status.running && !status.total)) {
    bar.style.width = "0%";
    text.textContent = failed ? `未开始 · 累计失败 ${failed}` : "未开始";
    return;
  }
  const rawPercent = status.total ? (status.done / status.total) * 100 : 0;
  const percent =
    status.done > 0 && rawPercent > 0 && rawPercent < 1
      ? 1
      : Math.min(100, Math.round(rawPercent));
  bar.style.width = percent + "%";
  const mode = status.mode === "retry" ? "重试" : "采集";
  const current = status.current
    ? ` · 当前 #${status.current.libId} ${status.current.title}`
    : "";
  const last = status.lastError
    ? ` · 最近失败 #${status.lastError.libId} ${String(status.lastError.error).slice(0, 80)}`
    : "";
  const progressLabel = status.mode === "missing" ? "总体 " : "";
  text.textContent = `${status.running ? mode + "中" : "已停止"} · ${progressLabel}${status.done}/${
    status.total
  }（本次失败 ${status.errors}，累计 ${failed}）${
    status.concurrency ? ` · 并发 ${status.concurrency}` : ""
  }${current}${last}`;
}

async function pollPrefetch() {
  try {
    const status = await api("/api/prefetch/status");
    renderPrefetch(status);
    if (status.running && dialog.open) {
      clearTimeout(prefetchTimer);
      prefetchTimer = setTimeout(pollPrefetch, 2000);
    } else if (!status.running) {
      loadStats();
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
    fetchConcurrency: Number($("#set-concurrency").value) || 4,
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

async function prefetchAction(path, options, zeroMsg, okMsg) {
  try {
    const status = await api(path, options);
    renderPrefetch(status);
    if (status.running) {
      clearTimeout(prefetchTimer);
      prefetchTimer = setTimeout(pollPrefetch, 1500);
    }
    if (status.mode === "missing" && status.total > 0 && status.done >= status.total) {
      toast("所有条目已采集");
    } else if (status.total === 0 && !status.running) {
      toast(zeroMsg || "没有需要处理的条目");
    } else {
      toast(okMsg || "任务已提交");
    }
    if (!status.running) loadStats();
  } catch (err) {
    toast(err.message, true);
  }
}

$("#prefetch-start").addEventListener("click", () =>
  prefetchAction(
    "/api/prefetch/start",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
    "没有需要采集的条目",
    "后台采集已启动"
  )
);

$("#prefetch-retry").addEventListener("click", () =>
  prefetchAction(
    "/api/prefetch/retry",
    { method: "POST" },
    "没有可重试的失败条目",
    "失败重试已启动"
  )
);

$("#prefetch-stop").addEventListener("click", () =>
  prefetchAction(
    "/api/prefetch/stop",
    { method: "POST" },
    "没有正在运行的任务",
    "正在停止…"
  )
);

$("#reload-index").addEventListener("click", async () => {
  const button = $("#reload-index");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "读取中…";
  try {
    const data = await api("/api/items/reload", { method: "POST" });
    $("#index-status").textContent = `上次重新读取：${data.items.toLocaleString()} 条（${data.withDood.toLocaleString()} 条可下载）`;
    toast(`索引已更新：${data.items.toLocaleString()} 条`);
    state.page = 1;
    await Promise.all([loadStats(), loadFacets()]);
    load();
  } catch (err) {
    toast(`重新读取 Excel 失败：${err.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

dialog.addEventListener("close", () => {
  clearTimeout(prefetchTimer);
  loadStats();
});

loadStats();
loadFacets();
load();
