// 用途：在 Jellyfin 视频详情页的信息栏中异步显示本地弹幕可用徽章。
(function () {
    'use strict';

    // 只缓存确定的结果：有弹幕 5 分钟，无弹幕（包括 404）1 分钟。
    // 网络、超时和 5xx 不缓存，网络恢复后可以重新探测。
    const POSITIVE_TTL = 5 * 60 * 1000;
    const NEGATIVE_TTL = 60 * 1000;
    const CACHE_LIMIT = 100;
    const danmakuCache = new Map();
    const inFlight = new Map();

    function getJellyfinApiUrl(path) {
        const serverAddress = window.ApiClient?.serverAddress?.();
        const webPath = window.location.pathname.match(/^(.*)\/web(?:\/|$)/i);
        const base = typeof serverAddress === 'string' && serverAddress
            ? `${serverAddress.replace(/\/+$/, '')}/`
            : new URL(webPath ? `${webPath[1]}/` : '/', window.location.origin).toString();
        return new URL(String(path).replace(/^\/+/, ''), base).toString();
    }

    function evictCacheIfNeeded() {
        const now = Date.now();
        for (const [itemId, entry] of danmakuCache) {
            if (entry.expiresAt <= now) danmakuCache.delete(itemId);
        }
        while (danmakuCache.size > CACHE_LIMIT) {
            danmakuCache.delete(danmakuCache.keys().next().value);
        }
    }

    async function fetchWithTimeout(url, options, timeout = 5000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            return await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
        } finally {
            clearTimeout(timer);
        }
    }

    function isHttpUrl(value) {
        if (typeof value !== 'string' || !value.trim()) return false;
        try {
            const url = new URL(value.trim());
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch (_) {
            return false;
        }
    }

    // 仅将明确存在的链接认定为“有弹幕”：兼容 {url}、纯 URL、null 和空对象。
    function responseContainsDanmakuUrl(text) {
        const value = String(text || '').trim();
        if (!value) return false;
        try {
            const parsed = JSON.parse(value);
            if (typeof parsed === 'string') return isHttpUrl(parsed);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
            return isHttpUrl(parsed.url) || isHttpUrl(parsed.Url) || isHttpUrl(parsed.URL);
        } catch (_) {
            return isHttpUrl(value);
        }
    }

    function cacheResult(itemId, exists) {
        danmakuCache.set(itemId, {
            exists,
            expiresAt: Date.now() + (exists ? POSITIVE_TTL : NEGATIVE_TTL)
        });
        evictCacheIfNeeded();
        return exists;
    }

    function checkDanmakuExists(itemId) {
        const cached = danmakuCache.get(itemId);
        if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.exists);
        if (cached) danmakuCache.delete(itemId);
        if (inFlight.has(itemId)) return inFlight.get(itemId);

        const request = (async () => {
            try {
                const token = window.ApiClient?.accessToken?.();
                const headers = token ? { Authorization: `MediaBrowser Token="${token}"` } : {};
                const url = getJellyfinApiUrl(`api/danmu/${encodeURIComponent(itemId)}`);
                const response = await fetchWithTimeout(url, { headers });
                if (response.status === 404) return cacheResult(itemId, false);
                if (!response.ok) return false;
                return cacheResult(itemId, responseContainsDanmakuUrl(await response.text()));
            } catch (error) {
                console.warn('[Danmaku Badge Injector] 本地弹幕探测失败，结果不缓存：', error);
                return false;
            } finally {
                inFlight.delete(itemId);
            }
        })();
        inFlight.set(itemId, request);
        return request;
    }

    // 动态提取准确的 Episode/Movie ItemId。
    function getAccurateItemId(container) {
        const innerNode = container.querySelector('[data-item-id]');
        const innerId = innerNode?.getAttribute('data-item-id');
        if (innerId) return innerId;
        const button = document.querySelector('button[data-action="resume"][data-id], button[data-action="play"][data-id], .btnPlay[data-id]');
        const buttonId = button?.getAttribute('data-id');
        if (buttonId) return buttonId;
        const match = window.location.hash.match(/[?&]id=([a-f0-9]{32})/i);
        return match ? match[1] : null;
    }

    function ensureBadge(container, itemId, exists) {
        if (!container.isConnected || getAccurateItemId(container) !== itemId) return;
        const existingBadge = container.querySelector('.danmu-badge-injected');
        if (!exists) {
            if (existingBadge) existingBadge.remove();
            return;
        }
        if (existingBadge?.dataset.badgeId === itemId) return;
        if (existingBadge) existingBadge.remove();
        const badge = document.createElement('div');
        badge.className = 'mediaInfoItem danmu-badge-injected';
        badge.dataset.badgeId = itemId;
        badge.style.cssText = 'display:flex;vertical-align:middle;align-items:center;';
        badge.title = '此视频已刮削到本地弹幕';
        badge.innerHTML = '<span class="material-icons" style="font-size:1.2em;margin-right:4px;">textsms</span><span>弹幕</span>';
        container.appendChild(badge);
    }

    function scanBadges() {
        evictCacheIfNeeded();
        document.querySelectorAll('.itemMiscInfo-primary').forEach(container => {
            const itemId = getAccurateItemId(container);
            if (!itemId) return;
            checkDanmakuExists(itemId).then(exists => ensureBadge(container, itemId, exists));
        });
    }

    let observerTimer = null;
    const observer = new MutationObserver(() => {
        clearTimeout(observerTimer);
        observerTimer = setTimeout(scanBadges, 150);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scanBadges();
    console.log('[Danmaku Badge Injector] 详情页本地弹幕检测脚本已启动');
})();
