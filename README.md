# Jellyfin Inject Danmu

用于 Jellyfin Web 客户端的 JavaScript 注入弹幕脚本，包含播放器弹幕层和详情页本地弹幕徽章。需要 [Jellyfin JavaScript Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector) 或等效的前端注入方式。

本版本以 Jellyfin Server **10.11.11**、Danmu 插件 **2.7.4.0** 验证和设计。`jellysleep.js` 是无关的外部脚本，不属于本项目，也不需要注入。

## 脚本

- `inject-danmu.js`：在实际的 HTML5 `<video>` 区域上渲染本地或在线 XML 弹幕，提供开关、样式、密度、屏蔽词、时间偏移与桌面端直方图。
- `inject-danmu-badge.js`：在详情页显示“本地弹幕”徽章。它不查询在线服务，因此徽章状态不代表在线服务是否可匹配。

`inject-danmu.js` 会在 JMP/QtWebEngine 中自行退出；Badge 可独立使用。

## 安装

1. 安装并启用 JavaScript Injector。
   - **安全提醒**：若注入脚本会读取 Jellyfin 登录态或包含任何私有配置，请在 Injector 中启用 **Requires Authentication**，避免未登录访问者取得注入脚本。已登录用户仍可在浏览器中查看脚本内容，因此不要把密码、API Key、Worker Secret 或其他凭据写入 JavaScript。
2. 如需本地弹幕，安装 [jellyfin-plugin-danmu](https://github.com/cxfksword/jellyfin-plugin-danmu)。
3. 如需在线弹幕，部署与 [huangxd-/danmu_api](https://github.com/huangxd-/danmu_api) 兼容的 `danmu_api` 服务。
4. 分别注入 `inject-danmu-badge.js` 与 `inject-danmu.js`，刷新 Jellyfin 网页。

## 在线弹幕配置

编辑 `inject-danmu.js` 顶部的常量。默认留空，因此不会向任何外部服务发请求。

```js
// 必须是 HTTPS 的完整 API 基址；可以包含 Cloudflare Worker 的路径前缀。
const ONLINE_DANMU_SERVICE_URL = 'https://danmu.example.com/worker-prefix';

// 'local' 使用 Jellyfin Danmu 插件；'online' 使用 danmu_api。
const DANMAKU_QUERY_ORDER = ['local', 'online'];
```

脚本通过 `ApiClient.serverAddress()` 构造 Jellyfin API 地址，兼容未来启用 Base URL 的情况；不要在脚本中硬编码 LAN IP、端口或公网域名。

LAN HTTP 和经 Cloudflare 反代的公网 HTTPS 均无需在前端配置 Origin。在线服务必须由其 Cloudflare Worker/API 提供允许 Jellyfin 页面 Origin 的 CORS 响应；这项跨域策略不能由本脚本绕过。

`ONLINE_DANMU_SERVICE_URL` 的域名和路径前缀会随脚本下发给浏览器，因而**不是秘密**。公开端点本身通常不会泄露 Jellyfin Token：本脚本不会将 Jellyfin 认证头发送给在线服务；但端点可能遭受探测或滥用。请在 Worker 侧配置限流、日志脱敏和必要的访问控制，不要将路径随机串当作认证机制。

## 本地与在线请求行为

- 本地播放始终请求当前 Jellyfin Origin/Base URL 的 `api/danmu/{itemId}/raw` 并解析 XML。不会跟随 `api/danmu/{itemId}` 所给的绝对 `url`，因为它可能是内网 HTTP 地址；这样可避免公网 HTTPS 的混合内容和向外部地址发送 Jellyfin Token。
- Badge 只以 `api/danmu/{itemId}` 的链接是否明确存在作为本地弹幕提示，成功结果缓存 5 分钟、明确无弹幕缓存 1 分钟；网络失败不缓存。
- 在线流程是 `POST /api/v2/match` 后请求 `GET /api/v2/comment/{episodeId}?format=xml&duration=true`。在线请求不携带 Jellyfin 身份认证头。
- 渲染器固定使用 `danmaku@2.0.10`，仅在确认获取到弹幕后加载。

## 使用说明

弹幕层和直方图均固定挂在 `body`，通过实际 `<video>` 的位置和尺寸同步显示，不修改 Jellyfin 播放器的虚拟 DOM。切集、自动连播、离开播放页与视频元素替换会取消仍在进行的请求并清理 UI、观察器和渲染实例。

时间偏移按视频生命周期重置；直方图仅在桌面端显示。设置中需要重算评论的项目会重建 Danmaku 引擎，而不是修改其私有字段。

## 免责声明

本项目只提供前端显示逻辑。在线服务、数据来源、CORS 与 Cloudflare 配置由部署者负责。
