# Dood Library（资料库 Web 应用）

从 Excel 表格生成资源索引，按 spankinglibrary.com 的 ID 抓取截图、价格、分类和 Store，并把 DoodStream 链接解析成直链发送给 Gopeed。下载时使用站点标题作为文件名，按 **Store** 自动建立子文件夹，**Categories 作为标签**展示和筛选。

## 功能

- 读取 `all-videos-and-links.xlsx`，只导入 **ACTIVE** 且带 DoodStream URL 的记录，生成 `/data/items.json`
- 按 ID 抓取 `https://www.spankinglibrary.com/clipdetails.php?id=<ID>`：
  - 截图（og:image + 多张预览图）
  - 价格、Store、分类标签、分辨率、时长、简介
- 卡片式浏览：搜索、标签筛选、分页
- 元数据懒加载 + SQLite 持久化；支持后台批量采集与失败重试
- 图片落盘：元数据采集或首次查看时把主缩略图下载到 `/data/images/<ID>.jpg`，页面通过 `/api/image/<ID>` 读取本地文件；下载失败时回退到 CDN 地址
- 一键发送到 Gopeed：
  - 文件名：站点标题 + `.mp4`
  - 目录：`<下载根目录>/<Store>`，例如 `/app/Downloads/NORTHERN SPANKING FILMS`
  - 自动携带 CDN 需要的 `Referer` / `User-Agent`
- 设置页可测试 Gopeed 连接、调整抓取间隔和下载连接数

## 目录

```
app/
  server.mjs            HTTP 服务 + API + 静态页面
  lib/
    excel.mjs           xlsx 解析（unzip + XML）
    library.mjs         spankinglibrary 详情抓取
    resolve.mjs         DoodStream → 直链
    gopeed.mjs          Gopeed API 客户端
    store.mjs           索引/缓存/设置持久化
  public/               前端页面
  data/                 运行时数据（items/settings、library.db、images 图片缓存，已 gitignore）
  Dockerfile
  docker-compose.yml
```

## 部署（预构建镜像）

GitHub Actions 会构建并推送多架构镜像（linux/amd64 + linux/arm64）：

```
ghcr.io/928475053/dood-library:latest
```

```bash
docker run -d --name dood-library \
  -p 18082:8080 \
  -v /path/to/all-videos-and-links.xlsx:/data/library.xlsx:ro \
  -v /path/to/dood-data:/data \
  --add-host=host.docker.internal:host-gateway \
  --restart unless-stopped \
  ghcr.io/928475053/dood-library:latest
```

启动后打开页面，在「设置」里填写 Gopeed API 地址（应用不内置地址）。

GHCR 包已验证可匿名拉取；如果遇到 401，执行 `docker login ghcr.io`，或到 [包设置](https://github.com/users/928475053/packages/container/dood-library/settings) 把可见性改为 Public。

## 部署（Docker Compose）

1. 把 `all-videos-and-links.xlsx` 放到 `app/` 目录（或修改 compose 里的挂载路径）。
2. 启动：

```bash
cd app
docker compose up -d
```

3. 打开 `http://<NAS-IP>:18082/`，在「设置」里填写 Gopeed API 地址（应用不预置地址）。

compose 直接使用预构建镜像 `ghcr.io/928475053/dood-library:latest`，不需要本地构建；如需本地构建，注释掉 `image:` 并取消 `build: .` 的注释。

### 不构建镜像的部署方式

在 UGOS/群晖 Docker 中新建容器：

- 镜像：`node:22-alpine`
- 端口：`18082` → `8080`
- 重启策略：always
- 命令：

```sh
sh -c "apk add --no-cache curl unzip >/dev/null && curl -fsSL https://github.com/928475053/doodstream-gopeed-extension/archive/refs/heads/main.tar.gz | tar -xz -C /opt && exec node /opt/doodstream-gopeed-extension-main/app/server.mjs"
```

- 挂载：
  - `all-videos-and-links.xlsx` → `/data/library.xlsx`（只读）
  - `data` 目录 → `/data`（用于缓存）
- 环境变量：
  - `EXCEL_PATH=/data/library.xlsx`
  - `DATA_DIR=/data`
  - `DOWNLOAD_ROOT=/app/Downloads`
- 若使用 `host.docker.internal`，需要给容器加 host 映射：`host.docker.internal:host-gateway`（compose 已配置）。

## 配置 Gopeed API 地址

应用**不内置**任何 Gopeed 地址或 Token，首次部署后完全由用户在页面「设置」里填写；连接测试和任务创建都由后端发出（不是浏览器直连）。

**不要填 UGREEN 的 `ugdocker.link` 地址**：那个入口需要网页登录，服务端请求会被重定向到登录页。

应用和 Gopeed 都在 NAS 上时，用 NAS 本机/容器网络访问：

- `http://host.docker.internal:<Gopeed宿主机端口>`（compose 已加 host 映射）
  - 在 UGOS Docker 的 Gopeed 容器里查看端口映射，例如 `9999/tcp -> 0.0.0.0:9999`，则填 `http://host.docker.internal:9999`
- 或 `http://<NAS局域网IP>:<Gopeed宿主机端口>`
- 若两个容器在同一个自定义 Docker 网络，可用 `http://<Gopeed容器名>:<容器内端口>`

部署后在页面「设置」里点 **测试 Gopeed**，返回版本号即成功。

## 使用

- 搜索框按标题或 ID 搜索，例如 `9272`。
- 卡片进入可视区域后才请求站点元数据，避免一次打 4 万次请求；结果写入 SQLite（`/data/library.db`）。
- 点 **下载到 Gopeed**：服务端会解析 Dood 链接，再调用 Gopeed 创建任务。
  - 文件名：`Late For Assembly - Full MP4.mp4`
  - 目录：`/app/Downloads/NORTHERN SPANKING FILMS`
  - 路径是 **Gopeed 容器内路径**，不是宿主机路径。
- 标签筛选只统计已采集的条目；未采集的条目在滚动时自动补全。

## 后台采集

设置页的「开始采集」会从第一条未采集的记录开始，按设置的间隔逐条抓取；「刷新全部」会重新抓取所有记录。

- 默认间隔 `1200ms`，44,779 条约需 15 小时；站点 `robots.txt` 建议 `Crawl-delay: 30`，请按需调大。
- 采集进度保存在内存中，刷新页面不影响；重启应用后从缺失元数据继续。
- 失败条目会写入 SQLite 的 `failures` 表；设置页显示「重试失败 (N)」，只重试失败条目，失败记录重启后仍保留。
- 卡片懒加载失败也可以点击卡片上的失败提示单独重试。

## 元数据存储（SQLite）

44,779 条元数据不再使用单个 `meta.json` 全量重写，改为 Node 内置 SQLite（`node:sqlite`），保存于 `/data/library.db`：

- `meta`：每条元数据按 ID 增量 upsert
- `meta_tags`：标签索引，用于筛选和统计
- `failures`：采集失败记录，供「重试失败」使用

首次启动会把旧的 `data/meta.json` 导入数据库并重命名为 `meta.json.migrated`。Node 22 会在启动日志里打印 SQLite 实验特性警告，不影响使用。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口 |
| `DATA_DIR` | `app/data` | 索引、元数据、设置的持久化目录 |
| `EXCEL_PATH` | 空 | `all-videos-and-links.xlsx` 路径；首次启动生成 `items.json` |
| `DOWNLOAD_ROOT` | `/app/Downloads` | Gopeed 容器内下载根目录 |
| `FETCH_INTERVAL_MS` | `1200` | 元数据抓取间隔 |
| `CONNECTIONS` | `16` | Gopeed 下载连接数 |

## API

- `GET /api/items?q=&category=&doodOnly=&page=&pageSize=`
- `GET /api/meta/:id`（`?refresh=1` 强制刷新）
- `GET /api/image/:id`（本地图片缓存，未命中时下载并落盘）
- `POST /api/download/:id`
- `GET/POST /api/settings`
- `POST /api/settings/test`
- `POST /api/prefetch/start|stop|retry`、`GET /api/prefetch/status`
- `GET /api/categories`（返回已采集的标签及数量）、`GET /api/stats`、`GET /api/health`

Gopeed 地址和 Token 只保存在 `/data/settings.json`，由页面填写，不通过环境变量内置。

## 注意

- 应用没有登录鉴权，只应部署在局域网内，不要直接暴露到公网。
- Excel、`data/` 和抓取到的元数据包含成人内容与你的资源链接，均未提交到仓库，请自行保管。
- `data/images/` 只保存每条的**主缩略图**（约 20–30KB），44,779 条约占用 1–1.5GB；多张预览图仍保留远程 URL，未落盘。
- 下载能力仅用于整理你有权访问的内容。
- 站点页面结构变化、条目被删除或 Cloudflare 拦截时，单条抓取会失败并显示“信息获取失败”；可稍后重试或调大抓取间隔。
