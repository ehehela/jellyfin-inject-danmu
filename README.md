# Jellyfin Inject Danmu (Jellyfin 弹幕注入脚本)

这是一套用于 Jellyfin 的前端 JavaScript 注入脚本，旨在为 Jellyfin Web 客户端提供原生的、沉浸式的弹幕（Danmaku）播放体验。本脚本需要配合 Jellyfin 的 JavaScript Injector 插件使用。

![弹幕效果图](Screenshot%202026-03-22%20061942.png)

## 功能特性

本项目主要包含两个核心注入脚本：

### 1. 播放器弹幕增强 (`inject-danmu.js`)
在 Jellyfin 自带的 HTML5 播放器中无缝嵌入弹幕层。主要功能包括：支持本地与在线多源智能查询；提供自适应桌面端与移动端的原生级控制面板；支持弹幕样式、色彩特效、密度限制与屏蔽词等高自由度设置；支持在桌面端绘制进度条高能直方图；内置严格的状态锁机制，有效防止 SPA 路由切换引发的内存泄露和卡顿。

### 2. 详情页弹幕徽章 (`inject-danmu-badge.js`)
在进入视频播放前，提前告知用户当前视频的服务端是否已刮削到本地弹幕。主要功能包括：后台无感异步探测本地弹幕资源状态；在视频详情页信息栏动态挂载”弹幕”徽章；内置防抖与缓存淘汰机制，严防高频 DOM 重绘卡顿与内存泄露。

> **注意：**
> - `inject-danmu.js` 在 **JMP 桌面客户端**下会自动禁用（QtWebEngine 环境弹幕渲染存在已知兼容性问题，脚本加载时检测后直接退出）。JMP 用户仍可通过 Badge 获知本地弹幕刮削状态。
> - `inject-danmu-badge.js` 在 JMP 和网页端均可正常工作，两者职责互不重叠。
> - 本脚本经 **Jellyfin v10.11.6** 验证。

---

## 安装与使用

为了正常使用本脚本，您需要准备对应的环境并按步骤配置：

1. **安装基础注入插件**：确保 Jellyfin 已启用 [Jellyfin-JavaScript-Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector)（或其他支持注入自定义 JS 的方式）。
   > **安全提醒**：若脚本中包含 Token 等敏感信息，请在插件设置中勾选 **Requires Authentication**，防止未授权访问时敏感信息泄露。
2. **配置服务端弹幕支持**（按需）：
   - **本地弹幕**：服务端需安装 [jellyfin-plugin-danmu](https://github.com/cxfksword/jellyfin-plugin-danmu) 插件。
   - **在线匹配**：需自行部署 [danmu_api](https://github.com/huangxd-/danmu_api) 服务。
3. **注入脚本**：将本项目中的 `inject-danmu-badge.js` 和 `inject-danmu.js` 代码分别添加到注入列表中。
4. 刷新 Jellyfin Web 页面即可生效。

## 配置说明

您可以直接在 `inject-danmu.js` 文件的顶部按需修改以下常量来定制您的弹幕来源策略：

```javascript
// 在线弹幕匹配 API 的服务地址（需自行部署或填写可用的后端服务）
const ONLINE_DANMU_SERVICE_URL = 'https://yourapiurl.com/123456789';

// 查询顺序配置：支持 'local' (本地探测) 和 'online' (在线API匹配)
// 默认优先尝试本地，如果本地没有则尝试在线刮削：
const DANMAKU_QUERY_ORDER = ['local', 'online']; 

// 弹幕状态通知 (Toast) 的样式偏好
const TOAST_FONT_SIZE = '32px'; 
const TOAST_POSITION_VERTICAL = 'center'; 
```

## 免责声明

本脚本仅用于前端 UI 增强，所有在线刮削接口及数据来源需由用户自行配置并承担相关风险。