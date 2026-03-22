// 用途：在 Jellyfin 的 JavaScript Injector 插件中使用的 JS 注入脚本，用于在视频详情页的信息栏中，异步探测并显示“弹幕”可用徽章。
(function () {
    'use strict';

    /**
     * 弹幕徽章功能固定语义说明 (SPA 环境核心设计原则)：
     * 1. DOM 状态防撕裂 (Anti-Tearing)：由于 SPA 路由切换时 DOM 极易瞬间被复用或替换，
     *    在异步请求 (Promise) resolve 后，必须再次对当前目标容器的 ID 进行合法性回查，确认匹配后再挂载徽章。
     * 2. 高频突变防抖 (Debounce)：在 MutationObserver 监听全局 body 变动时，必须加入 setTimeout 缓冲，
     *    将一瞬间密集的 DOM 变化合并为单次处理，严防全局 DOM 查询造成的 CPU 峰值与页面卡顿。
     * 3. 缓存淘汰机制 (Cache Eviction)：使用 Map 缓存视频 ID 与探测结果时，必须限制最大容量上限（如 100），
     *    定期触发清理逻辑，防止客户端（如电视、大屏）长时间不刷新页面导致内存泄漏。
     * 4. 异常容错与防死锁：仅对明确的 HTTP 404 (确无弹幕) 或成功响应进行永久缓存。
     *    若遇断网或 500 等异常失败，需及时将该记录从缓存剔除，确保网络恢复后允许重试，防止"缓存死锁"。
     * 5. 徽章职责边界：Badge 仅负责提示服务端是否已刮削到本地弹幕（即 Jellyfin 本地插件目录下是否存在对应弹幕文件），
     *    它不探测、不涉及任何在线弹幕 API 的查询结果。
     *    因此 Badge 的显示状态与主弹幕脚本（inject-danmu.js）的在线查询功能完全解耦：
     *    - Badge 显示"有弹幕"，不代表主脚本能查到弹幕（可能在线 API 配置错误或网络不通）。
     *    - Badge 显示"无弹幕"，也不代表主脚本无法从在线 API 获取到弹幕（用户可能只配了在线源）。
     *    Badge 的唯一数据来源是 /api/danmu/{itemId}，即本地插件接口。
     */

    // 缓存探测结果（存入 Promise，防止在网络请求期间同一 ID 被并发多次请求）
    const danmakuCache = new Map();

    // 防止长期运行 SPA 导致内存泄漏，定期清理缓存 (限制最大容量为 100)
    function evictCacheIfNeeded() {
        if (danmakuCache.size > 100) {
            const keys = Array.from(danmakuCache.keys());
            for (let i = 0; i < 50; i++) danmakuCache.delete(keys[i]);
        }
    }

    // 核心：极速探测弹幕文件是否存在
    function checkDanmakuExists(itemId) {
        if (danmakuCache.has(itemId)) return danmakuCache.get(itemId);
        evictCacheIfNeeded();

        const checkPromise = (async () => {
            try {
                const headers = {};
                const token = window.ApiClient?.accessToken?.();
                if (token) headers['Authorization'] = `MediaBrowser Token="${token}"`;

                // 使用专用的弹幕链接查询接口，更加轻量，且不会产生 404 报错
                const response = await fetch(`/api/danmu/${itemId}`, { headers });
                
                if (!response.ok) {
                    // 若并非确实不存在(404)，而是服务器500等其他错误，移除缓存以允许未来重新发起探测
                    if (response.status !== 404) danmakuCache.delete(itemId);
                    return false;
                }

                const text = await response.text();
                if (!text) return false;

                try {
                    // 尝试作为 JSON 解析（如 { "url": "..." } 或 { "url": "" }）
                    const data = JSON.parse(text);
                    const danmuUrl = data.url || data.Url || data.URL; // 兼容不同后端的序列化大小写
                    return !!danmuUrl; // 如果存在 url 并且不为空字符串，则表示有弹幕
                } catch (e) {
                    // 如果返回的是普通字符串，只要长度大于 0 就认为有链接
                    return text.trim().length > 0;
                }
            } catch (e) {
                // 请求失败（断网或超时），移除缓存以便恢复后重试
                danmakuCache.delete(itemId);
                return false; // 请求失败或被 abort 均视为无处理
            }
        })();

        danmakuCache.set(itemId, checkPromise);
        return checkPromise;
    }

    // 动态提取最准确的 itemId (解决剧集页面 URL ID 与实际视频 ID 不一致的问题)
    function getAccurateItemId(container) {
        // 1. 优先从信息栏内部提取自带的 data-item-id（最准确，能绕过 Series ID 拿到 Episode ID）
        const innerNode = container.querySelector('[data-item-id]');
        if (innerNode) {
            const id = innerNode.getAttribute('data-item-id');
            if (id) return id;
        }

        // 2. 尝试从详情页全局的播放按钮提取
        const btnWithId = document.querySelector('button[data-action="resume"][data-id], button[data-action="play"][data-id], .btnPlay[data-id]');
        if (btnWithId) {
            const id = btnWithId.getAttribute('data-id');
            if (id) return id;
        }

        // 3. 最后回退到 URL 上的 ID
        const hash = window.location.hash;
        const matchQuery = hash.match(/[?&]id=([a-f0-9]{32})/i);
        return matchQuery ? matchQuery[1] : null;
    }

    // 确保容器中正确显示或移除徽章（解决 SPA 异步渲染刷掉 DOM 的问题）
    function ensureBadge(container, itemId, exists) {
        // 再次校验当前容器是否仍属于此视频
        if (getAccurateItemId(container) !== itemId) return;

        const existingBadge = container.querySelector('.danmu-badge-injected');

        if (exists) {
            // 如果已经有正确的徽章，无需重复挂载
            if (existingBadge && existingBadge.dataset.badgeId === itemId) return;

            // 移除可能因为切集遗留的旧徽章
            if (existingBadge) existingBadge.remove();

            const badge = document.createElement('div');
            badge.className = 'mediaInfoItem danmu-badge-injected';
            badge.dataset.badgeId = itemId;
            badge.style.display = 'flex';
            badge.style.verticalAlign = 'middle';
            badge.style.alignItems = 'center';
            badge.title = '此视频已刮削到弹幕';
            badge.innerHTML = `
                <span class="material-icons" style="font-size: 1.2em; margin-right: 4px;">textsms</span>
                <span>弹幕</span>
            `;
            container.appendChild(badge);
            console.log(`[Danmaku Badge Injector] ID: ${itemId} 存在弹幕，徽章已挂载到DOM！`);
        } else {
            // 如果没弹幕，但存在徽章，则清理
            if (existingBadge) existingBadge.remove();
        }
    }

    // 监听 DOM 树变化，寻找详情页的信息栏
    let observerTimer = null;
    const observer = new MutationObserver(() => {
        // 引入防抖 (Debounce)，防止页面频繁重绘(如时间走动、图片加载)导致的大量且冗余的全局 DOM 查询卡顿
        if (observerTimer) clearTimeout(observerTimer);
        observerTimer = setTimeout(() => {
            // 寻找所有的主信息栏，不再通过简单的 :not 过滤
            const infoContainers = document.querySelectorAll('.itemMiscInfo-primary');
            infoContainers.forEach(container => {
                const itemId = getAccurateItemId(container);
                if (!itemId) return;
    
                // 调用缓存的 Promise 并在其 resolve 后确保 DOM 状态正确
                // 语义1：异步 resolve 后必须二次回查目标容器 ID，防止 SPA 路由切换期间
                // container 被替换为另一个视频的信息栏，导致徽章错挂到当前视频上
                checkDanmakuExists(itemId).then(exists => {
                    if (getAccurateItemId(container) !== itemId) return;
                    ensureBadge(container, itemId, exists);
                });
            });
        }, 150); // 150ms 缓冲，合并短时间内密集的 DOM 变化
    });

    observer.observe(document.body, { childList: true, subtree: true });
    console.log('[Danmaku Badge Injector] 详情页弹幕检测脚本已启动');

})();