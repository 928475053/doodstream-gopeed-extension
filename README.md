# DoodStream Downloader for Gopeed

一个 [Gopeed](https://gopeed.com) 扩展：把 DoodStream 风格的 `/d/<文件ID>`、`/e/<文件ID>` 页面解析成可直接下载的视频直链。

## 支持的链接

```
https://dood.to/d/g68gu8474zzs
https://dood.to/e/g68gu8474zzs
```

以及 `dood.so`、`dood.ws`、`dood.la`、`dood.yt`、`dood.re`、`dood.pm`、`dood.li`、`dood.watch`、`dood.work`、`dood.stream`、`doods.pro`、`d000d.com`、`ds2play.com`、`doodstream.com`、`playmogo.com` 等镜像域名。

## 安装

在 Gopeed 的「扩展」页面点击安装，输入：

```
github.com/928475053/doodstream-gopeed-extension
```

安装后把 DoodStream 页面链接直接粘贴到 Gopeed 新建任务即可。

## 工作原理

1. 请求 `/d/<id>` 页面，定位其中的 `/e/<id>` 播放器 iframe；
2. 在播放页中提取 `pass_md5/<...>/<token>`，请求它得到 CDN 前缀；
3. 按播放器逻辑拼接 `前缀 + 10位随机字符 + ?token=<token>&expiry=<当前毫秒时间戳>`，得到签名直链；
4. 直链请求自动携带 `Referer` 和浏览器 `User-Agent`。

站点开启了 Cloudflare 防护，会按 TLS 指纹拦截 Go/Node 的 HTTP 客户端。因此扩展按以下顺序尝试：

1. **解析服务**（如果配置了地址）：把播放页地址交给自建的 `resolver`，由它用 curl 完成解析；
2. **普通 HTTP**：直接请求播放页；
3. **WebView**：Gopeed 桌面版可用时，用真实浏览器内核打开播放页。

## Docker / NAS 部署

Docker 版 Gopeed 没有 WebView，且 Go 的 HTTP 客户端会被 Cloudflare 拦截，因此解析服务必须跑在 NAS 侧（扩展本身跑在 Gopeed 里，但解析页面由该服务完成）。

### 方式一：无需镜像仓库（推荐）

在 UGOS / 群晖等 Docker 界面新建容器：

- 镜像：`node:22-alpine`
- 端口：`18080` → `8080`
- 重启策略：`always`
- 命令（覆盖 CMD）：

```sh
sh -c "apk add --no-cache curl >/dev/null && curl -fsSL https://raw.githubusercontent.com/928475053/doodstream-gopeed-extension/main/resolver/server.mjs -o /app.js && exec node /app.js"
```

或用 compose：

```yaml
services:
  dood-resolver:
    image: node:22-alpine
    container_name: dood-resolver
    restart: unless-stopped
    command:
      - sh
      - -c
      - |
        apk add --no-cache curl >/dev/null
        curl -fsSL https://raw.githubusercontent.com/928475053/doodstream-gopeed-extension/main/resolver/server.mjs -o /app.js
        exec node /app.js
    ports:
      - "18080:8080"
    environment:
      RESOLVER_TOKEN: ""
```

### 方式二：预构建镜像

GitHub Actions 会构建 `ghcr.io/928475053/doodstream-resolver:latest`。GHCR 包默认是私有的，需要先在 [包设置](https://github.com/users/928475053/packages/container/doodstream-resolver/settings) 中把可见性改为 Public，或在 NAS 上执行 `docker login ghcr.io` 后再拉取。

### 配置扩展

Gopeed → 扩展 → DoodStream Downloader 齿轮图标：

- **解析服务地址**：`http://<NAS局域网IP>:18080/resolve`；若解析容器与 Gopeed 在同一自定义 Docker 网络，可用 `http://dood-resolver:8080/resolve`
- **解析服务 Token**：与容器环境变量 `RESOLVER_TOKEN` 一致（可选）

排查时看容器日志：`docker logs dood-resolver`。解析服务只接受 DoodStream 域名的 `/d/`、`/e/` 链接，建议设置 `RESOLVER_TOKEN` 且仅在内网使用；它只转发页面地址，不接触下载内容。

## 平台限制

- 配置了解析服务时，Docker/NAS 也能正常解析下载。
- 未配置解析服务时：桌面版走 WebView 兜底；无 WebView 且被 Cloudflare 拦截时会报错提示。
- 人机验证需要交互时，WebView 可能无法自动通过。

## 设置

- **User-Agent**：请求播放页使用的 UA，默认内置 Chrome UA。
- **解析服务地址**：可选，自建 resolver 的 `/resolve` 地址。
- **解析服务 Token**：可选，与服务端 `RESOLVER_TOKEN` 一致。

## 本地测试

```bash
# 普通 HTTP 路径
node test/local-test.mjs https://dood.to/d/g68gu8474zzs

# 模拟 HTTP 被 Cloudflare 拦截，验证 WebView 兜底
node test/local-test.mjs https://dood.to/d/g68gu8474zzs --webview
```

测试脚本会用真实网络解析链接，并对结果发起 `Range` 请求，确认返回 `206 Partial Content` 与 `video/*`。

## 注意事项

签名直链带有效期，扩展会在每次新建任务时重新生成，请勿缓存或公开分享直链。请仅下载你有权访问的内容。

## License

MIT
