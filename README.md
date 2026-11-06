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

站点开启了 Cloudflare 防护，会按 TLS 指纹拦截 Go/Node 的 HTTP 客户端。因此扩展先走普通 HTTP；一旦被拦截，会自动切换到 Gopeed 的 WebView（真实浏览器内核）完成同样的解析。

## 平台限制

- WebView 兜底需要 Gopeed 桌面版（Windows/macOS/Linux）或支持 `gopeed.runtime.webview` 的客户端。
- 在不支持 WebView 的环境（如 Docker/NAS 服务端）中，若站点启用了 Cloudflare 人机验证，解析会失败并给出提示。
- 人机验证需要交互时，WebView 可能无法自动通过。

## 设置

- **User-Agent**：请求播放页使用的 UA，默认内置 Chrome UA。

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
