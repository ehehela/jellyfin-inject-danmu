// 用途：在 Jellyfin 的 JavaScript Injector 插件中使用的 JS 注入脚本，用于在 HTML5 播放器中请求、解析并渲染弹幕，同时提供自定义的弹幕设置控制面板。
(function () {
    'use strict';

    /**
     * 弹幕功能固定语义说明：
     * 1. UI 按需渲染：只有当获取到有效的弹幕数据时，才会在播放器上渲染弹幕相关的控制按钮，否则不显示。
     * 2. 来源状态通知：成功获取到弹幕时，会在页面底部弹出短时间的通知提示，如"获取到在线弹幕"或"获取到本地弹幕"。
     * 3. 查询顺序可控：脚本顶部提供 DANMAKU_QUERY_ORDER 配置项，允许用户自由组合或精简弹幕接口的查询顺序。
     * 4. 在线服务校验：如果用户未配置有效的在线服务地址（如非合法的 HTTP/HTTPS URL），则自动跳过在线查询路线。
     * 5. 异步状态安全：每个播放生命周期拥有独立 generation 与 AbortController；切集或离页立即取消请求、观察器和 UI，
     *    每次异步返回都会确认仍属于同一视频，避免 SPA 中旧请求覆盖新页面。
     * 6. 环境主动检测：脚本加载时立即检测 QtWebEngine 环境，检测到后直接退出，不启动 MutationObserver，不进行任何 DOM 监听，确保对非兼容环境零侵入。
     * 7. UI 与引擎分离：只有弹幕数据和真实 video 都就绪后才创建引擎与控制按钮；无弹幕或加载失败不保留 UI。
     * 8. 视频生命周期锁定：通过 currentItemIdCache 缓存当前视频 ID，在 DOM 变化时通过对比 ID 判断是否真的是视频切换，而非同一视频内的正常 DOM 波动。
     * 9. 异步安全退出：取消是正常控制流，不触发重试；未拿到 ItemId 时仅在同一 video 上限速重试，
     *    避免把 Sessions API 变成高频轮询。
     * 10. 直方图仅限桌面端：直方图（弹幕密度可视化）仅在桌面端渲染和提供调节选项。
     *    移动端不显示直方图，画布不创建，设置面板中也不提供"直方图高度"调节项。
     *    判断依据：window.innerWidth <= 768 或 userAgent 匹配 Mobi|Android|iPhone|iPad。
     * 11. 时间偏移每视频独立：时间偏移（timeOffset）用于将弹幕时间线相对视频水平平移，以对齐弹幕与视频内容。
     *    该值为会话级状态，切换视频或刷新页面后自动重置为 0，不跨视频保留。
     *    效果同时体现在弹幕直方图上（直方图随时间偏移左右平移）。
     */

    // 配置项
    // 固定依赖版本，避免 unpkg 的 latest 标签在无感情况下改变播放器行为。
    const DANMAKU_LIB_URL = 'https://unpkg.com/danmaku@2.0.10/dist/danmaku.min.js';
    // 填写完整的在线 API 基址（可包含部署路径前缀），例如：
    // https://danmu.example.com/your-api-prefix
    // 留空时会安全跳过在线查询。
    const ONLINE_DANMU_SERVICE_URL = '';
    // 查询顺序配置：支持 'local' (本地插件) 和 'online' (在线API)。
    // 例如优先本地再在线: ['local', 'online']; 仅在线: ['online']
    const DANMAKU_QUERY_ORDER = ['local', 'online'];
    // 直方图功能开关（设为 false 可临时禁用，排查问题时使用）
    const ENABLE_HISTOGRAM = true;

    // 检测是否为 QtWebEngine 环境（JMP 桌面客户端）
    // danmaku.js 在 QtWebEngine 中 RTL 弹幕轨道计算严重异常（canvas 引擎和 DOM 引擎均失效），
    // JMP 端弹幕无法正常工作。检测到 JMP 时脚本在加载阶段直接退出，不进行任何监听和初始化。
    function isQtWebEngine() {
        const ua = navigator.userAgent || '';
        // QtWebEngine 特征：UA 中包含 Qt 相关信息，或平台为 Linux 且存在 jellyfin-desktop 相关标识
        return !!(window.QtWebEngine || window.qt ||
            ua.includes('QtWebEngine') ||
            ua.includes('JellyfinDesktop') ||
            (ua.includes('Linux') && ua.includes('Qt')) ||
            // JMP 特有的 navigator.platform 值
            (navigator.platform && navigator.platform.includes('Jellyfin'))
        );
    }

    // 弹幕来源通知提示配置
    const TOAST_FONT_SIZE = '32px'; // 提示字体大小 (默认: 32px)
    const TOAST_POSITION_VERTICAL = 'center'; // 垂直位置: 'center' (竖直居中) 或 'top' (顶部)
    let danmakuInstance = null;
    let danmakuLibraryPromise = null;
    let playbackGeneration = 0;
    let activePlayback = null;
    let currentItemIdCache = null;
    let isDanmakuVisible = true;
    let originalCommentsCache = []; // 原始弹幕数据缓存，用于修改设置时重新生成

    // 直方图功能相关的状态变量
    let cachedVideoDuration = 0;

    // 默认配置项与本地存储初始化
    const DEFAULT_SETTINGS = {
        opacity: 1,
        fontSize: 24,
        fontFamily: 'sans-serif',
        area: 100,
        speed: 144,
        baseColor: 'original',
        style: 'default',
        blocklist: '',
        density: 100,
        histogramHeight: 24,
        timeOffset: 0
    };
    let currentSettings = { ...DEFAULT_SETTINGS };
    let timeOffset = 0; // 弹幕时间偏移量（秒），负数=提前，正数=延后

    function clampNumber(value, fallback, min, max) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
    }

    function normalizeSettings(saved) {
        const input = saved && typeof saved === 'object' ? saved : {};
        return {
            ...DEFAULT_SETTINGS,
            opacity: clampNumber(input.opacity, DEFAULT_SETTINGS.opacity, 0.1, 1),
            fontSize: clampNumber(input.fontSize, DEFAULT_SETTINGS.fontSize, 12, 48),
            fontFamily: typeof input.fontFamily === 'string' ? input.fontFamily : DEFAULT_SETTINGS.fontFamily,
            area: clampNumber(input.area, DEFAULT_SETTINGS.area, 25, 100),
            speed: clampNumber(input.speed, DEFAULT_SETTINGS.speed, 1, 500),
            baseColor: typeof input.baseColor === 'string' ? input.baseColor : DEFAULT_SETTINGS.baseColor,
            style: typeof input.style === 'string' ? input.style : DEFAULT_SETTINGS.style,
            blocklist: typeof input.blocklist === 'string' ? input.blocklist : '',
            density: clampNumber(input.density, DEFAULT_SETTINGS.density, 0, 100),
            histogramHeight: clampNumber(input.histogramHeight, DEFAULT_SETTINGS.histogramHeight, 0, 48),
            timeOffset: 0
        };
    }

    function loadSettings() {
        try {
            const saved = localStorage.getItem('jellyfin_danmaku_settings');
            if (saved) currentSettings = normalizeSettings(JSON.parse(saved));
            // timeOffset 不从 localStorage 恢复，每个视频默认从 0 开始
            timeOffset = 0;
        } catch (e) {
            currentSettings = { ...DEFAULT_SETTINGS };
            timeOffset = 0;
        }
    }

    function saveSettings() {
        try {
            currentSettings.timeOffset = timeOffset;
            localStorage.setItem('jellyfin_danmaku_settings', JSON.stringify(currentSettings));
        } catch (e) {
            console.warn('[Danmaku Injector] 保存弹幕设置失败：', e);
        }
    }

    // 初始化时加载配置
    loadSettings();

    // 注入全局的弹幕样式及控制面板样式
    (function injectGlobalStyles() {
        if (document.getElementById('danmaku-custom-styles')) return;
        const style = document.createElement('style');
        style.id = 'danmaku-custom-styles';
        style.textContent = `
            #custom-danmaku-container {
                font-size: 24px;
                opacity: 1;
            }
            /* 字体描边防重叠 */
            #custom-danmaku-container > div > div {
                font-size: inherit !important;
                text-shadow: 1px 1px 2px #000, -1px -1px 2px #000, 1px -1px 2px #000, -1px 1px 2px #000 !important;
                font-weight: bold;
            }
            
            /* 赛博朋克风格 (青色主调 + 洋红阴影) */
            #custom-danmaku-container[data-color-style="cyberpunk"] > div > div {
                color: #0ff !important;
                text-shadow: 2px 2px 0px #f0f, -1px -1px 1px #000, 1px -1px 1px #000 !important;
            }
            /* 黑客帝国风格 (荧光绿发光) */
            #custom-danmaku-container[data-color-style="matrix"] > div > div {
                color: #0f0 !important;
                text-shadow: 0px 0px 8px #0f0, 1px 1px 2px #000 !important;
                font-family: "Courier New", Courier, monospace !important;
            }
            /* 幻彩渐变风格 (利用色相旋转动画实现彩虹效果) */
            @keyframes dm-rainbow-anim {
                0% { filter: hue-rotate(0deg); }
                100% { filter: hue-rotate(360deg); }
            }
            #custom-danmaku-container[data-color-style="rainbow"] > div > div {
                color: #ff2a2a !important;
                animation: dm-rainbow-anim 3s linear infinite !important;
            }

            /* 移动端特制面板 (避开所有原生 class，纯自定义，模仿现代 Bottom Sheet) */
            .dm-mobile-panel {
                position: fixed !important;
                bottom: 0 !important;
                left: 0 !important;
                right: 0 !important;
                background: var(--theme-background-color, rgba(20,20,20,0.95)) !important;
                color: var(--theme-text-color-primary, #fff) !important;
                z-index: 99999 !important;
                display: none;
                flex-direction: column;
                border-radius: 16px 16px 0 0 !important;
                box-shadow: 0 -4px 24px rgba(0,0,0,0.6) !important;
                padding: 16px !important;
                padding-bottom: calc(16px + env(safe-area-inset-bottom, 0)) !important;
                animation: dm-slide-up 0.25s cubic-bezier(0.2, 0.8, 0.2, 1) both !important;
            }
            @keyframes dm-slide-up {
                0% { transform: translateY(100%); }
                100% { transform: translateY(0); }
            }

            /* 通用独立滚动区与列表项 (双端共用，彻底剥离原生的 .listItem 和 .scrollY 干扰) */
            .dm-scroll-container {
                flex: 1;
                overflow-y: auto;
                -webkit-overflow-scrolling: touch;
                touch-action: pan-y !important;
                overscroll-behavior-y: contain;
                max-height: 60vh;
                padding: 8px 0;
            }
            .dm-setting-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 0;
                color: inherit;
            }
            .dm-mobile-panel .dm-setting-row {
                padding: 14px 0;
                border-bottom: 1px solid var(--line-background, rgba(255,255,255,0.05));
            }
            .dm-mobile-panel .dm-setting-row:last-child {
                border-bottom: none;
            }
            #danmaku-settings-panel select,
            #danmaku-settings-panel textarea {
                background: var(--theme-background-color, rgba(0, 0, 0, 0.4));
                color: inherit;
                border: 1px solid var(--line-background, rgba(255, 255, 255, 0.2));
                border-radius: 4px;
                padding: 4px 8px;
                font-family: inherit;
                outline: none;
            }
            #danmaku-settings-panel textarea::-webkit-scrollbar { width: 6px; }
            #danmaku-settings-panel textarea::-webkit-scrollbar-thumb { background: var(--theme-primary-color, #888); border-radius: 3px; }
            .dm-setting-btn {
                font-size: 12px;
                cursor: pointer;
                background: var(--theme-primary-color, #555);
                color: #fff;
                padding: 2px 6px;
                border-radius: 4px;
                border: none;
                transition: filter 0.2s;
            }
            .dm-setting-btn:hover { filter: brightness(1.2); }
        `;
        document.head.appendChild(style);
    })();

    // 随机生成亮色
    function getRandomBrightColor() {
        const letters = '89ABCDEF'; // 限制在较高数值保证色彩明亮不刺眼
        let color = '#';
        for (let i = 0; i < 6; i++) color += letters[Math.floor(Math.random() * 8)];
        return color;
    }

    // 将当前设置（颜色/屏蔽词）应用到原始弹幕数据上
    function applySettingsToComments() {
        const blocks = String(currentSettings.blocklist || '').split('\n').map(s => s.trim()).filter(s => s);

        let filtered = originalCommentsCache;
        // 1. 过滤屏蔽词
        if (blocks.length > 0) {
            filtered = filtered.filter(c => !blocks.some(b => c.text.includes(b)));
        }

        // 2. 过滤弹幕密度
        const density = parseInt(currentSettings.density || 100, 10);
        if (density < 100) {
            filtered = filtered.filter(c => {
                // 利用弹幕的时间与长度计算固定的伪随机值(0-99)，保证每次重载UI时筛选出的弹幕是固定的，防止闪烁
                const hash = (Math.round(c.time * 10) + (c.text ? c.text.length : 0)) % 100;
                return hash < density;
            });
        }

        // 3. 映射颜色 & 应用时间偏移
        const offset = timeOffset; // 负数=提前，正数=延后
        return filtered.map(c => {
            let outColor = c.originalColor;
            if (currentSettings.baseColor === 'random') {
                outColor = getRandomBrightColor();
            } else if (currentSettings.baseColor !== 'original') {
                const colorMap = {
                    white: '#ffffff', red: '#ff2a2a', yellow: '#ffff00',
                    green: '#00ff00', cyan: '#00ffff', blue: '#4444ff', magenta: '#ff00ff'
                };
                outColor = colorMap[currentSettings.baseColor] || c.originalColor;
            }
            // 修复：Danmaku.js 引擎必须通过 style 属性包裹对象才能生效颜色
            // 应用时间偏移：弹幕显示时间 = 原始时间 + offset
            return { ...c, time: c.time + offset, style: { ...c.style, color: outColor } };
        });
    }

    // 当配置变更时，实时重刷弹幕数据
    function reloadDanmakuData() {
        if (!activePlayback || !originalCommentsCache.length) return;
        const newComments = applySettingsToComments();
        recreateDanmakuEngine(newComments);
    }

    // 1. 动态加载弹幕库
    function loadDanmakuLibrary() {
        if (window.Danmaku) return Promise.resolve(window.Danmaku);
        if (danmakuLibraryPromise) return danmakuLibraryPromise;

        danmakuLibraryPromise = new Promise((resolve, reject) => {
            const scriptId = 'jellyfin-danmaku-library';
            const existingScript = document.getElementById(scriptId);
            const script = existingScript || document.createElement('script');
            const timeoutId = setTimeout(() => finish(new Error('加载 Danmaku 渲染库超时')), 10000);
            let settled = false;

            function finish(error) {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                script.onload = null;
                script.onerror = null;
                if (error) {
                    if (!existingScript) script.remove();
                    danmakuLibraryPromise = null;
                    reject(error);
                } else {
                    resolve(window.Danmaku);
                }
            }

            script.onload = () => window.Danmaku
                ? finish()
                : finish(new Error('Danmaku 渲染库加载完成但未暴露 window.Danmaku'));
            script.onerror = () => finish(new Error('Danmaku 渲染库加载失败'));

            if (!existingScript) {
                script.id = scriptId;
                script.src = DANMAKU_LIB_URL;
                script.async = true;
                document.head.appendChild(script);
            }
        });
        return danmakuLibraryPromise;
    }

    // 2. 获取当前视频的 itemId（Jellyfin 10.11 专用）
    //    Jellyfin 10.11 的视频 src 格式为：http://host/Videos/{itemId}/stream.mp4
    //    优先从 video.src 同步提取；已缓存时需验证是否与当前视频匹配，避免切集后返回旧缓存
    function getCurrentItemId(videoElement) {
        // 从 video.src 中提取 itemId（/Videos/{itemId}/stream.mp4）
        let extractedId = null;
        if (videoElement) {
            const src = videoElement.src || videoElement.currentSrc || '';
            const match = src.match(/\/Videos\/([a-f0-9]{32})/i);
            if (match) {
                extractedId = match[1];
            }
        }

        // 已缓存过 itemId：只有当缓存值与当前视频提取的 ID 一致时才使用缓存
        // 修复 Bug：切集后（如 intro skipper 自动跳到下一集）视频 src 已变，
        // 但 currentItemIdCache 尚未被 cleanup 清除，此时必须以新提取的 ID 为准
        if (currentItemIdCache && extractedId && currentItemIdCache === extractedId) {
            return currentItemIdCache;
        }

        // 仅在 ID 真正变化（获取到有效新 ID）时记录日志，避免播放期间的频繁日志刷屏
        if (extractedId) {
            console.log(`[Danmaku Injector] [getCurrentItemId] 从 video.src 提取: ${extractedId}`);
        }

        return extractedId;
    }

    function showDanmakuSourceToast(text) {
        if (!text) return;
        removeDanmakuSourceToast();
        const toast = document.createElement('div');
        toast.id = 'danmaku-source-toast';
        toast.innerText = text;
        Object.assign(toast.style, {
            position: 'fixed',
            top: TOAST_POSITION_VERTICAL === 'center' ? '50%' : '40px',
            left: '50%',
            transform: TOAST_POSITION_VERTICAL === 'center' ? 'translate(-50%, -50%)' : 'translateX(-50%)',
            zIndex: '999999',
            background: 'rgba(0, 0, 0, 0.8)',
            color: '#fff',
            padding: '10px 20px',
            borderRadius: '999px',
            fontSize: TOAST_FONT_SIZE,
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            pointerEvents: 'none',
            opacity: '0',
            transition: 'opacity 0.3s ease',
            maxWidth: '90%',
            textAlign: 'center',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
        });

        document.body.appendChild(toast);

        setTimeout(() => {
            if (toast.isConnected) toast.style.opacity = '1';
        }, 50);

        toast._hideTimer = setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 250);
        }, 5000);
    }

    function removeDanmakuSourceToast() {
        const oldToast = document.getElementById('danmaku-source-toast');
        if (oldToast) {
            clearTimeout(oldToast._hideTimer);
            oldToast.remove();
        }
    }

    function createAbortError() {
        return typeof DOMException === 'function'
            ? new DOMException('操作已取消', 'AbortError')
            : Object.assign(new Error('操作已取消'), { name: 'AbortError' });
    }

    function throwIfAborted(signal) {
        if (signal && signal.aborted) throw createAbortError();
    }

    function isAbortError(error) {
        return error && error.name === 'AbortError';
    }

    // ApiClient.serverAddress() 会携带 Jellyfin 的 Base URL；只有它不可用时才回退到当前 Origin。
    function getJellyfinApiUrl(path) {
        const serverAddress = window.ApiClient?.serverAddress?.();
        const webPath = window.location.pathname.match(/^(.*)\/web(?:\/|$)/i);
        const base = typeof serverAddress === 'string' && serverAddress
            ? `${serverAddress.replace(/\/+$/, '')}/`
            : new URL(webPath ? `${webPath[1]}/` : '/', window.location.origin).toString();
        return new URL(String(path).replace(/^\/+/, ''), base).toString();
    }

    // 在线服务必须是 HTTPS，且可以带 Cloudflare Worker 的路径前缀。
    function getOnlineApiUrl(path) {
        const base = new URL(ONLINE_DANMU_SERVICE_URL);
        if (base.protocol !== 'https:') throw new Error('在线弹幕 API 必须使用 HTTPS URL');
        base.pathname = `${base.pathname.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
        return base.toString();
    }

    function hasOnlineApiConfiguration() {
        if (!ONLINE_DANMU_SERVICE_URL.trim()) return false;
        try {
            getOnlineApiUrl('api/v2/match');
            return true;
        } catch (_) {
            return false;
        }
    }

    function waitWithSignal(delay, signal) {
        return new Promise((resolve, reject) => {
            throwIfAborted(signal);
            const timer = setTimeout(done, delay);
            function done() {
                if (signal) signal.removeEventListener('abort', onAbort);
                resolve();
            }
            function onAbort() {
                clearTimeout(timer);
                reject(createAbortError());
            }
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    // 调用方的 signal 与超时 signal 同时生效，便于切集/离页时立刻终止网络请求。
    async function fetchWithTimeout(resource, options = {}) {
        const { timeout = 8000, signal: callerSignal, ...fetchOptions } = options;
        throwIfAborted(callerSignal);
        const controller = new AbortController();
        let timedOut = false;
        const onCallerAbort = () => controller.abort();
        const timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeout);
        if (callerSignal) callerSignal.addEventListener('abort', onCallerAbort, { once: true });
        try {
            return await fetch(resource, { ...fetchOptions, signal: controller.signal });
        } catch (error) {
            if (timedOut && isAbortError(error)) error.danmakuTimeout = true;
            throw error;
        } finally {
            clearTimeout(timeoutId);
            if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
        }
    }

    // 最多三次请求：只重试超时、网络 TypeError 与明确的瞬时 HTTP 状态。
    async function fetchWithRetry(resource, options = {}) {
        const {
            retries = 2,
            retryDelay = 800,
            timeout = 8000,
            signal,
            retryableStatusCodes = [429, 502, 503, 504],
            ...fetchOptions
        } = options;
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt++) {
            throwIfAborted(signal);
            try {
                const response = await fetchWithTimeout(resource, { ...fetchOptions, timeout, signal });
                if (response.ok || !retryableStatusCodes.includes(response.status) || attempt === retries) return response;
                lastError = new Error(`HTTP ${response.status}`);
            } catch (error) {
                if (isAbortError(error) && !error.danmakuTimeout) throw error;
                if (!(isAbortError(error) || error instanceof TypeError) || attempt === retries) throw error;
                lastError = error;
            }
            const delay = retryDelay * Math.pow(2, attempt) + Math.random() * 250;
            console.log(`[Danmaku Injector] 请求失败，${delay.toFixed(0)}ms 后重试 (${attempt + 1}/${retries})`);
            await waitWithSignal(delay, signal);
        }
        throw lastError || new Error('请求失败');
    }

    function waitForApiClient(signal) {
        return new Promise((resolve, reject) => {
            let retryCount = 0;
            let timer = null;
            const maxRetries = 30;
            const finish = (value, error) => {
                if (timer) clearTimeout(timer);
                if (signal) signal.removeEventListener('abort', onAbort);
                error ? reject(error) : resolve(value);
            };
            const onAbort = () => finish(null, createAbortError());
            const check = () => {
                if (signal && signal.aborted) return onAbort();
                const token = window.ApiClient?.accessToken?.();
                if (token) return finish(token);
                if (++retryCount >= maxRetries) {
                    console.warn('[Danmaku Injector] 等待 ApiClient 超时，继续以无 token 方式尝试。');
                    return finish(null);
                }
                timer = setTimeout(check, 500);
            };
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            check();
        });
    }

    // 3. 调度获取弹幕数据
    async function fetchDanmakuData(itemId, signal) {
        try {
            const token = await waitForApiClient(signal);
            throwIfAborted(signal);
            const headers = token ? { Authorization: `MediaBrowser Token="${token}"` } : {};
            for (const source of DANMAKU_QUERY_ORDER) {
                throwIfAborted(signal);
                if (source === 'local') {
                    const comments = await fetchDanmakuFromLocalApi(itemId, headers, signal);
                    if (comments.length) {
                        throwIfAborted(signal);
                        showDanmakuSourceToast('获取到本地弹幕');
                        return comments;
                    }
                } else if (source === 'online') {
                    if (!hasOnlineApiConfiguration()) {
                        console.log('[Danmaku Injector] 在线弹幕 API 未配置或不是 HTTPS，跳过在线查询。');
                        continue;
                    }
                    const online = await fetchDanmakuFromOnlineApi(itemId, headers, signal);
                    const comments = Array.isArray(online) ? online : online.comments;
                    if (Array.isArray(comments) && comments.length) {
                        throwIfAborted(signal);
                        showDanmakuSourceToast(online.displayText ? `获取到在线弹幕 - ${online.displayText}` : '获取到在线弹幕');
                        return comments;
                    }
                }
            }
            console.log(`[Danmaku Injector] ID: ${itemId} 所有配置源均未查到弹幕。`);
            return [];
        } catch (error) {
            if (isAbortError(error)) throw error;
            console.error('[Danmaku Injector] 获取弹幕失败:', error);
            return [];
        }
    }

    // /api/danmu/{id} 只用于存在性探测，返回的 url 可为内网绝对 HTTP 地址。
    // 播放必须请求 Jellyfin 当前 Origin/Base URL 下的 raw，避免公网 HTTPS 页面混合内容和 Token 外泄。
    async function fetchDanmakuFromLocalApi(itemId, headers, signal) {
        const rawUrl = getJellyfinApiUrl(`api/danmu/${encodeURIComponent(itemId)}/raw`);
        try {
            const response = await fetchWithTimeout(rawUrl, { headers, timeout: 8000, signal, cache: 'no-store' });
            if (!response.ok) return [];
            const xmlString = await response.text();
            throwIfAborted(signal);
            return xmlString ? parseDanmakuData(xmlString) : [];
        } catch (error) {
            if (isAbortError(error)) throw error;
            console.warn('[Danmaku Injector] 本地 /raw 弹幕获取失败:', error);
            return [];
        }
    }

    async function fetchAndParseDanmakuFromUrl(url, { retry = false, signal } = {}) {
        try {
            const response = await (retry
                ? fetchWithRetry(url, { timeout: 10000, retries: 2, signal })
                : fetchWithTimeout(url, { timeout: 10000, signal }));
            if (!response.ok) {
                if (response.status === 404) return [];
                throw new Error(`弹幕文件获取失败 (HTTP ${response.status})`);
            }
            const xmlString = await response.text();
            throwIfAborted(signal);
            return xmlString ? parseDanmakuData(xmlString) : [];
        } catch (error) {
            if (isAbortError(error)) throw error;
            console.warn('[Danmaku Injector] 获取在线弹幕 XML 失败:', error);
            return [];
        }
    }

    async function fetchItemDetails(itemId, headers, signal) {
        try {
            await waitForApiClient(signal);
            const userId = window.ApiClient?.getCurrentUserId?.();
            if (!userId) return null;
            const url = getJellyfinApiUrl(`Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}`);
            const response = await fetchWithTimeout(url, { headers, timeout: 5000, signal });
            if (!response.ok) return null;
            const item = await response.json();
            throwIfAborted(signal);
            return item;
        } catch (error) {
            if (isAbortError(error)) throw error;
            console.warn('[Danmaku Injector] 获取视频元数据失败:', error);
            return null;
        }
    }

    // URL/blob 无法提取 ItemId 时，使用当前用户和设备的 Sessions 记录兜底。
    async function fetchCurrentPlayingItemId(signal) {
        try {
            await waitForApiClient(signal);
            const client = window.ApiClient;
            const token = client?.accessToken?.();
            const userId = client?.getCurrentUserId?.();
            const deviceId = client?.deviceId?.();
            if (!token || !userId || !deviceId) return null;
            const response = await fetchWithTimeout(getJellyfinApiUrl('Sessions'), {
                headers: { Authorization: `MediaBrowser Token="${token}"` }, timeout: 5000, signal
            });
            if (!response.ok) return null;
            const sessions = await response.json();
            throwIfAborted(signal);
            const session = Array.isArray(sessions) && sessions.find(s =>
                s.NowPlayingItem?.Id && s.UserId === userId && s.DeviceId === deviceId
            );
            return session?.NowPlayingItem?.Id || null;
        } catch (error) {
            if (isAbortError(error)) throw error;
            console.warn('[Danmaku Injector] fetchCurrentPlayingItemId 失败：', error);
            return null;
        }
    }

    async function fetchDanmakuFromOnlineApi(itemId, headers, signal) {
        try {
            const itemInfo = await fetchItemDetails(itemId, headers, signal);
            if (!itemInfo) return [];
            let queryFileName = '';
            let displayText = '';
            if (itemInfo.Type === 'Episode') {
                const seriesName = itemInfo.SeriesName || '';
                const season = String(itemInfo.ParentIndexNumber ?? 1).padStart(2, '0');
                const episode = String(itemInfo.IndexNumber ?? 1).padStart(2, '0');
                queryFileName = seriesName ? `${seriesName}.S${season}E${episode}` : '';
                displayText = `${seriesName} S${season}E${episode}`.trim();
            } else {
                queryFileName = itemInfo.Name || '';
                if (itemInfo.ProductionYear) queryFileName += `.${itemInfo.ProductionYear}`;
                displayText = `${itemInfo.Name || ''}${itemInfo.ProductionYear ? ` (${itemInfo.ProductionYear})` : ''}`.trim();
            }
            if (!queryFileName) return [];

            const matchResponse = await fetchWithRetry(getOnlineApiUrl('api/v2/match'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileName: queryFileName }), timeout: 8000, retries: 2, signal
            });
            if (!matchResponse.ok) return [];
            const matchData = await matchResponse.json();
            throwIfAborted(signal);
            if (matchData?.success !== true || matchData?.isMatched !== true || !Array.isArray(matchData.matches)) return [];
            const episodeId = matchData.matches[0]?.episodeId;
            if (episodeId === undefined || episodeId === null || episodeId === '') return [];
            const commentUrl = getOnlineApiUrl(`api/v2/comment/${encodeURIComponent(String(episodeId))}`);
            const url = new URL(commentUrl);
            url.searchParams.set('format', 'xml');
            url.searchParams.set('duration', 'true');
            const comments = await fetchAndParseDanmakuFromUrl(url.toString(), { retry: true, signal });
            return { comments, displayText };
        } catch (error) {
            if (isAbortError(error)) throw error;
            console.warn(`[Danmaku Injector] 在线匹配 API 请求失败 (itemId=${itemId})：`, error);
            return [];
        }
    }

    // 2. 之前的 TODO: 现由 parseDanmakuData 处理response，继续往下

    // 解析获取到的 Bilibili 标准 XML 弹幕数据
    function parseDanmakuData(xmlString) {
        const comments = [];
        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlString, "text/xml");
            if (xmlDoc.getElementsByTagName('parsererror').length) throw new Error('XML 格式无效');
            const dTags = xmlDoc.getElementsByTagName('d');

            for (let i = 0; i < dTags.length; i++) {
                const text = (dTags[i].textContent || '').trim();
                const p = dTags[i].getAttribute('p');
                if (!p || !text) continue;
                const attrs = p.split(',');
                const time = Number.parseFloat(attrs[0]);
                const type = Number.parseInt(attrs[1], 10);
                if (!Number.isFinite(time) || time < 0 || !Number.isFinite(type) || type === 7 || type === 8) continue;

                // Bilibili 颜色是 24 bit 十进制；越界值钳制，避免生成非法 CSS 色值。
                const colorDec = clampNumber(Number.parseInt(attrs[3], 10), 16777215, 0, 0xffffff);
                const color = `#${Math.round(colorDec).toString(16).padStart(6, '0')}`;
                let mode = 'rtl';
                if (type === 4) mode = 'bottom';
                else if (type === 5) mode = 'top';
                else if (type === 6) mode = 'ltr';
                comments.push({ text, time, mode, originalColor: color, style: { color } });
            }
            console.log(`[Danmaku Injector] 成功解析了 ${comments.length} 条弹幕`);
        } catch (e) {
            console.error('[Danmaku Injector] 解析弹幕 XML 失败:', e);
        }
        return comments;
    }

    function destroyDanmakuInstance() {
        if (danmakuInstance) {
            try {
                danmakuInstance.destroy();
            } catch (error) {
                console.warn('[Danmaku Injector] 销毁 Danmaku 引擎失败：', error);
            }
            danmakuInstance = null;
        }
    }

    function isPlaybackCurrent(playback) {
        return !!playback && activePlayback === playback &&
            playback.generation === playbackGeneration &&
            !playback.controller.signal.aborted &&
            document.body.contains(playback.video);
    }

    function removeHistogram() {
        const canvas = document.getElementById('danmaku-histogram-canvas');
        if (!canvas) return;
        if (canvas._ro) canvas._ro.disconnect();
        if (canvas._resizeHandler) window.removeEventListener('resize', canvas._resizeHandler);
        canvas.remove();
    }

    function syncDanmakuGeometry(playback) {
        if (!isPlaybackCurrent(playback) || !playback.container) return;
        const rect = playback.video.getBoundingClientRect();
        const container = playback.container;
        if (rect.width <= 0 || rect.height <= 0) {
            container.style.display = 'none';
            playback.hiddenByGeometry = true;
            if (danmakuInstance) danmakuInstance.hide();
            return;
        }
        const height = rect.height * (clampNumber(currentSettings.area, 100, 25, 100) / 100);
        Object.assign(container.style, {
            display: 'block', position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
            width: `${rect.width}px`, height: `${height}px`
        });
        if (playback.hiddenByGeometry) {
            playback.hiddenByGeometry = false;
            if (danmakuInstance && isDanmakuVisible) danmakuInstance.show();
        }
        if (danmakuInstance) danmakuInstance.resize();
    }

    function updateVideoDuration(playback) {
        if (!isPlaybackCurrent(playback)) return;
        const duration = playback.video.duration;
        if (Number.isFinite(duration) && duration > 0) {
            cachedVideoDuration = duration;
            injectDanmakuUI();
        }
    }

    function bindPlaybackEvents(playback) {
        const updateGeometry = () => syncDanmakuGeometry(playback);
        const updateDuration = () => updateVideoDuration(playback);
        playback.video.addEventListener('loadedmetadata', updateDuration);
        playback.video.addEventListener('durationchange', updateDuration);
        window.addEventListener('resize', updateGeometry, { passive: true });
        document.addEventListener('fullscreenchange', updateGeometry);
        playback.cleanupEvents = () => {
            playback.video.removeEventListener('loadedmetadata', updateDuration);
            playback.video.removeEventListener('durationchange', updateDuration);
            window.removeEventListener('resize', updateGeometry);
            document.removeEventListener('fullscreenchange', updateGeometry);
        };
        if (window.ResizeObserver) {
            playback.resizeObserver = new ResizeObserver(updateGeometry);
            playback.resizeObserver.observe(playback.video);
        }
        updateGeometry();
        updateDuration();
    }

    // 切集、离开播放页或失败时统一调用；初始化中的请求也会被 AbortController 立即取消。
    function cleanupDanmaku({ resetVideoState = true } = {}) {
        playbackGeneration++;
        const playback = activePlayback;
        activePlayback = null;
        if (playback) {
            playback.controller.abort();
            if (playback.retryTimer) clearTimeout(playback.retryTimer);
            if (playback.resizeObserver) playback.resizeObserver.disconnect();
            if (playback.cleanupEvents) playback.cleanupEvents();
        }
        destroyDanmakuInstance();
        const container = document.getElementById('custom-danmaku-container');
        if (container) {
            container.remove();
        }
        currentItemIdCache = null;
        originalCommentsCache = [];
        cachedVideoDuration = 0;
        if (resetVideoState) timeOffset = 0;
        removeHistogram();
        removeDanmakuUI();
        removeDanmakuSourceToast();
    }

    function createDanmakuEngine(comments) {
        const playback = activePlayback;
        if (!isPlaybackCurrent(playback) || !playback.container || !comments.length || !window.Danmaku) return false;
        destroyDanmakuInstance();
        danmakuInstance = new window.Danmaku({
            container: playback.container,
            media: playback.video,
            comments: comments.slice().sort((a, b) => a.time - b.time),
            engine: 'dom'
        });
        danmakuInstance.speed = Number(currentSettings.speed);
        if (!isDanmakuVisible) danmakuInstance.hide();
        syncDanmakuGeometry(playback);
        applyVisualSettings();
        return true;
    }

    // danmaku@2 不支持安全地替换私有 comments；设置变化时重建，保留媒体、时间和显示开关。
    function recreateDanmakuEngine(comments) {
        const playback = activePlayback;
        if (!isPlaybackCurrent(playback)) return;
        if (!comments.length) {
            // 屏蔽词/密度过滤后没有可显示评论时，保留设置 UI 以便用户恢复筛选，
            // 但销毁旧引擎，避免旧评论继续显示。
            destroyDanmakuInstance();
            return;
        }
        const currentTime = playback.video.currentTime;
        if (createDanmakuEngine(comments) && Number.isFinite(currentTime)) {
            // 新实例读取同一 video 的 currentTime，不修改播放器进度。
            syncDanmakuGeometry(playback);
            injectDanmakuUI();
        }
    }

    // 创建或移除控制面板及按钮
    function removeDanmakuUI() {
        const wrapper = document.getElementById('danmaku-ui-wrapper');
        const toggle = document.getElementById('danmaku-toggle-btn');
        const settings = document.getElementById('danmaku-settings-btn');
        const panel = document.getElementById('danmaku-settings-panel');
        const backdrop = document.getElementById('danmaku-settings-backdrop');
        if (wrapper) wrapper.remove();
        if (toggle) toggle.remove();
        if (settings) settings.remove();
        if (panel) panel.remove();
        if (backdrop) backdrop.remove();
    }

    function createSettingsPanel() {
        if (document.getElementById('danmaku-settings-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'danmaku-settings-panel';

        // 检测是否为移动设备 (宽度 <= 768px 或是触控设备标识)
        const isMobile = window.innerWidth <= 768 || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

        if (!isMobile) {
            // 桌面端：融入原生组件体系 (Pattern 3)，彻底剥离强写死的固定位置
            panel.className = 'focuscontainer dialog actionsheet-not-fullscreen actionSheet';
            panel.style.cssText = 'position: fixed; margin: 0px; width: 360px; max-width: 90vw; z-index: 99999; display: none; box-sizing: border-box;';
        } else {
            // 移动端：完全使用特制 class 避开 Jellyfin JS 劫持
            panel.className = 'dm-mobile-panel';
        }

        // 利用 Web Component 的 is 属性和原生 class，让桌面端表单组件彻底原生化
        const selectClass = isMobile ? '' : 'emby-select-withcolor emby-select';
        const inputClass  = isMobile ? '' : 'emby-input';
        const btnClass    = isMobile ? 'dm-setting-btn' : 'raised emby-button';
        const isSelect    = isMobile ? '' : 'is="emby-select"';
        const isInput     = isMobile ? '' : 'is="emby-input"';
        const isBtn       = isMobile ? '' : 'is="emby-button"';

        const innerHTML = `
            <div class="${isMobile ? '' : 'actionSheetContent'}" style="${isMobile ? 'display:flex; flex-direction:column; height:100%;' : 'box-sizing: border-box;'}">
                <div style="display:flex; justify-content:space-between; align-items:center; padding: ${isMobile ? '0 4px 16px 4px' : '0 16px 16px 16px'}; box-sizing: border-box;">
                    <h3 style="margin: 0; font-size: 1.4em; font-weight: normal;">弹幕设置</h3>
                    <button id="danmaku-settings-reset" class="${btnClass}" ${isBtn} style="${isMobile ? '' : 'margin:0; padding: 0.4em 1em;'}">重置</button>
                </div>
                <div class="${isMobile ? 'dm-scroll-container' : 'actionSheetScroller scrollY'}" style="${isMobile ? '' : 'max-height: 55vh; overflow-y: auto; padding: 0 16px 16px 16px; box-sizing: border-box;'}">
                    <div class="dm-setting-row">
                        <div style="font-size:14px; ${isMobile?'font-weight:500;':''}">透明度</div>
                        <input type="range" id="dm-opacity" min="0.1" max="1" step="0.1" value="1" style="width:140px; margin:0;">
                    </div>
                    <div class="dm-setting-row">
                        <div style="font-size:14px; ${isMobile?'font-weight:500;':''}">字体大小</div>
                        <input type="range" id="dm-fontsize" min="12" max="48" step="2" value="24" style="width:140px; margin:0;">
                    </div>
                    <div class="dm-setting-row">
                        <div style="font-size:14px; ${isMobile?'font-weight:500;':''}">字体样式</div>
                        <select id="dm-fontfamily" style="width:140px; margin:0;" class="${selectClass}" ${isSelect}>
                            <option value="sans-serif">默认 (无衬线)</option>
                            <option value="'Microsoft YaHei', sans-serif">微软雅黑</option>
                            <option value="KaiTi, serif">楷体</option>
                            <option value="SimSun, serif">宋体</option>
                        </select>
                    </div>
                    <div class="dm-setting-row">
                        <div style="font-size:14px; ${isMobile?'font-weight:500;':''}">显示区域</div>
                        <select id="dm-area" style="width:140px; margin:0;" class="${selectClass}" ${isSelect}>
                            <option value="100">全部 (100%)</option>
                            <option value="75">偏上 (75%)</option>
                            <option value="50">半屏 (50%)</option>
                            <option value="25">顶部 (25%)</option>
                        </select>
                    </div>
                    ${!isMobile ? `
                    <div class="dm-setting-row">
                        <div style="font-size:14px; ${isMobile?'font-weight:500;':''}">直方图高度</div>
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="range" id="dm-histogram-height" min="0" max="48" step="2" value="24" style="width:100px; margin:0;">
                            <span id="dm-histogram-height-label" style="font-size:12px; min-width:28px; text-align:right;">24px</span>
                        </div>
                    </div>` : ''}
                    <div class="dm-setting-row">
                        <div style="font-size:14px; ${isMobile?'font-weight:500;':''}">弹幕密度</div>
                        <select id="dm-density" style="width:140px; margin:0;" class="${selectClass}" ${isSelect}>
                            <option value="100">全部 (100%)</option>
                            <option value="75">较多 (75%)</option>
                            <option value="50">半数 (50%)</option>
                            <option value="25">较少 (25%)</option>
                            <option value="10">极少 (10%)</option>
                        </select>
                    </div>
                    <div class="dm-setting-row">
                        <div style="font-size:14px; ${isMobile?'font-weight:500;':''}">主色调</div>
                        <select id="dm-base-color" style="width:140px; margin:0;" class="${selectClass}" ${isSelect}>
                            <option value="original">原色 (默认)</option>
                            <option value="random">随机颜色</option>
                            <option value="white">纯白</option>
                            <option value="red">红色</option>
                            <option value="yellow">黄色</option>
                            <option value="green">绿色</option>
                            <option value="cyan">青色</option>
                        </select>
                    </div>
                    <div class="dm-setting-row">
                        <div style="font-size:14px; ${isMobile?'font-weight:500;':''}">色彩特效</div>
                        <select id="dm-color-style" style="width:140px; margin:0;" class="${selectClass}" ${isSelect}>
                            <option value="default">原色 (默认)</option>
                            <option value="cyberpunk">赛博朋克 (霓虹)</option>
                            <option value="rainbow">幻彩渐变 (彩虹)</option>
                            <option value="matrix">黑客帝国 (荧光绿)</option>
                        </select>
                    </div>
                    <div class="dm-setting-row">
                        <div style="font-size:14px; ${isMobile?'font-weight:500;':''}">弹幕速度</div>
                        <select id="dm-speed" style="width:140px; margin:0;" class="${selectClass}" ${isSelect}>
                            <option value="80">较慢</option>
                            <option value="144" selected>正常</option>
                            <option value="200">较快</option>
                            <option value="250">极快</option>
                        </select>
                    </div>
                    <div class="dm-setting-row">
                        <div style="font-size:14px; ${isMobile?'font-weight:500;':''}">时间偏移</div>
                        <div style="display:flex; align-items:center; gap:6px;">
                            <button id="dm-timeoffset-dec" class="${btnClass}" ${isBtn} style="padding: 0.3em 0.6em; min-width:28px;">−</button>
                            <input type="text" id="dm-timeoffset" class="${inputClass}" ${isInput} style="width:60px; text-align:center; margin:0; padding: 4px 2px;" value="+0">
                            <span style="font-size:12px; color: var(--theme-secondary-text-color, #aaa);">秒</span>
                            <button id="dm-timeoffset-inc" class="${btnClass}" ${isBtn} style="padding: 0.3em 0.6em; min-width:28px;">+</button>
                        </div>
                    </div>
                    <div class="dm-setting-row" style="flex-direction:column; align-items:flex-start; gap:8px; border-bottom:none;">
                        <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
                            <div style="font-size:14px; ${isMobile?'font-weight:500;':''}">屏蔽关键词 (每行一个)</div>
                            <span id="dm-blocklist-clear" class="${btnClass}" ${isBtn} style="padding: 0.3em 0.8em; font-size:12px; cursor:pointer;">清空</span>
                        </div>
                        <textarea id="dm-blocklist" rows="3" style="width:100%; resize:vertical; box-sizing:border-box; margin:0;" class="${inputClass}" ${isInput}></textarea>
                    </div>
                </div>
            </div>
        `;

        // 引入原生播放器常用的“物理遮罩层”理念，继承原生点击背景关闭菜单的逻辑
        // [修复] 必须先于 Panel 插入 DOM，确保遮罩层永远压在面板底部
        if (!document.getElementById('danmaku-settings-backdrop')) {
            const backdrop = document.createElement('div');
            backdrop.id = 'danmaku-settings-backdrop';
            // [修复] 彻底剥离原生 class，防止 Jellyfin 全局 CSS (如最高级的 z-index) 导致遮罩反盖在面板上方
            backdrop.style.position = 'fixed';
            backdrop.style.top = '0';
            backdrop.style.left = '0';
            backdrop.style.width = '100%';
            backdrop.style.height = '100%';
            backdrop.style.zIndex = '99998'; // 处于面板(99999)之下，播放器画面之上
            backdrop.style.background = 'rgba(0,0,0,0.4)'; // 手动补充原本 class 带有的半透明暗化遮罩
            backdrop.style.display = 'none';
            document.body.appendChild(backdrop);

            backdrop.onclick = () => {
                // 点击遮罩层时，仅隐藏面板与遮罩，事件会被物理阻挡，不会触及视频
                const btn = document.getElementById('danmaku-settings-btn');
                if (btn) btn.click();
            };
        }

        // 避免重复包裹 actionSheetContent 导致 padding 嵌套溢出
        panel.innerHTML = innerHTML;
        document.body.appendChild(panel);

        // 全面拦截面板内的所有交互事件，形成“事件黑洞”，防止泄漏到播放器底层被误认为单击（导致暂停）或滑动
        const stopProp = (e) => e.stopPropagation();
        ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'click', 'wheel'].forEach(evt => {
            panel.addEventListener(evt, stopProp);
        });

        // 更新面板UI匹配当前状态
        function updateUIValues() {
            document.getElementById('dm-opacity').value = currentSettings.opacity;
            document.getElementById('dm-fontsize').value = currentSettings.fontSize;
            document.getElementById('dm-fontfamily').value = currentSettings.fontFamily;
            document.getElementById('dm-area').value = currentSettings.area;
            document.getElementById('dm-density').value = currentSettings.density !== undefined ? currentSettings.density : 100;
            document.getElementById('dm-speed').value = currentSettings.speed;
            document.getElementById('dm-base-color').value = currentSettings.baseColor;
            document.getElementById('dm-color-style').value = currentSettings.style;
            document.getElementById('dm-blocklist').value = currentSettings.blocklist;
            document.getElementById('dm-timeoffset').value = timeOffset >= 0 ? '+' + timeOffset : timeOffset;
            if (!isMobile) {
                document.getElementById('dm-histogram-height').value = currentSettings.histogramHeight;
                document.getElementById('dm-histogram-height-label').textContent =
                    currentSettings.histogramHeight === 0 ? '关闭' : currentSettings.histogramHeight + 'px';
            }
        }
        updateUIValues();

        // 一键重置
        document.getElementById('danmaku-settings-reset').onclick = () => {
            currentSettings = { ...DEFAULT_SETTINGS };
            timeOffset = DEFAULT_SETTINGS.timeOffset || 0;
            saveSettings();
            updateUIValues();
            applyVisualSettings();
            reloadDanmakuData();
            // 重绘直方图
            const canvas = document.getElementById('danmaku-histogram-canvas');
            if (canvas && cachedVideoDuration > 0) {
                drawHistogramCanvas(canvas, cachedVideoDuration);
            }
        };

        // 绑定用户输入事件
        document.getElementById('dm-opacity').oninput = (e) => {
            currentSettings.opacity = e.target.value; saveSettings(); applyVisualSettings();
        };
        document.getElementById('dm-fontsize').oninput = (e) => {
            currentSettings.fontSize = e.target.value; saveSettings(); applyVisualSettings();
        };
        document.getElementById('dm-fontfamily').onchange = (e) => {
            currentSettings.fontFamily = e.target.value; saveSettings(); applyVisualSettings();
        };
        document.getElementById('dm-area').onchange = (e) => {
            currentSettings.area = e.target.value; saveSettings(); applyVisualSettings();
        };
        if (!isMobile) {
            document.getElementById('dm-histogram-height').oninput = (e) => {
                const h = parseInt(e.target.value, 10);
                currentSettings.histogramHeight = h;
                saveSettings();
                document.getElementById('dm-histogram-height-label').textContent = h === 0 ? '关闭' : h + 'px';
                // 即时更新直方图：0=隐藏，>0=显示并刷新位置
                const canvas = document.getElementById('danmaku-histogram-canvas');
                if (!canvas) return;
                if (h === 0) {
                    canvas.style.display = 'none';
                } else {
                    // 确保 canvas 显示出来
                    canvas.style.display = 'block';
                    canvas.style.height = h + 'px';
                    const sliderContainer = document.querySelector('.sliderContainer.mdl-slider-container');
                    if (sliderContainer) {
                        const rect = sliderContainer.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            canvas.style.left = rect.left + 'px';
                            canvas.style.width = rect.width + 'px';
                            canvas.style.top = (rect.top - h) + 'px';
                        }
                    }
                    // 重新绘制以适应新高度
                    if (cachedVideoDuration > 0) {
                        drawHistogramCanvas(canvas, cachedVideoDuration);
                    }
                }
            };
        }
        document.getElementById('dm-density').onchange = (e) => {
            currentSettings.density = parseInt(e.target.value);
            saveSettings();
            reloadDanmakuData(); // 更改密度需要重新计算并投递弹幕数据
        };
        document.getElementById('dm-speed').onchange = (e) => {
            currentSettings.speed = parseInt(e.target.value); saveSettings(); applyVisualSettings();
        };

        // 时间偏移控制
        const timeOffsetInput = document.getElementById('dm-timeoffset');
        const updateTimeOffset = (newOffset) => {
            timeOffset = newOffset;
            timeOffsetInput.value = timeOffset >= 0 ? '+' + timeOffset : timeOffset;
            saveSettings();
            reloadDanmakuData();
            // 即时重绘直方图
            const canvas = document.getElementById('danmaku-histogram-canvas');
            if (canvas && cachedVideoDuration > 0) {
                drawHistogramCanvas(canvas, cachedVideoDuration);
            }
        };
        document.getElementById('dm-timeoffset-dec').onclick = () => {
            updateTimeOffset(parseFloat((timeOffset - 0.5).toFixed(1)));
        };
        document.getElementById('dm-timeoffset-inc').onclick = () => {
            updateTimeOffset(parseFloat((timeOffset + 0.5).toFixed(1)));
        };
        timeOffsetInput.onchange = () => {
            const val = parseFloat(timeOffsetInput.value);
            if (!isNaN(val)) {
                updateTimeOffset(parseFloat(val.toFixed(1)));
            } else {
                timeOffsetInput.value = timeOffset >= 0 ? '+' + timeOffset : timeOffset;
            }
        };
        // 阻止数字键等按键冒泡到视频播放器，确保输入框能正常接收
        timeOffsetInput.onkeydown = (e) => {
            // 数字键、负号、正号、句点、退格、删除、左右方向键、小数点
            if ((e.key >= '0' && e.key <= '9') || e.key === '-' || e.key === '+' || e.key === '.' ||
                e.key === 'Backspace' || e.key === 'Delete' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.stopPropagation();
            }
        };
        document.getElementById('dm-base-color').onchange = (e) => {
            currentSettings.baseColor = e.target.value;
            saveSettings();
            reloadDanmakuData(); // 颜色变更需要重算
        };
        document.getElementById('dm-color-style').onchange = (e) => {
            currentSettings.style = e.target.value;
            saveSettings();
            applyVisualSettings();
        };

        // 屏蔽词变更
        let blocklistTimer = null;
        document.getElementById('dm-blocklist').oninput = (e) => {
            currentSettings.blocklist = e.target.value;
            saveSettings();
            // 防抖动重算
            clearTimeout(blocklistTimer);
            blocklistTimer = setTimeout(reloadDanmakuData, 600);
        };
        document.getElementById('dm-blocklist-clear').onclick = () => {
            document.getElementById('dm-blocklist').value = '';
            currentSettings.blocklist = '';
            saveSettings();
            reloadDanmakuData();
        };
    }

    // 应用直接视觉更改（无需重载数据的项）
    // [重要] 已移到外层作用域，使其在 createSettingsPanel() 外部也可访问
    function applyVisualSettings() {
        const container = document.getElementById('custom-danmaku-container');
        const engine = danmakuInstance ? danmakuInstance.engine : null;

        if (container) {
            container.style.opacity = currentSettings.opacity;
            container.style.fontSize = currentSettings.fontSize + 'px';
            container.style.fontFamily = currentSettings.fontFamily;
            container.setAttribute('data-color-style', currentSettings.style);
        }
        if (danmakuInstance) {
            danmakuInstance.speed = parseInt(currentSettings.speed);
            // [重要] canvas 引擎不读取 DOM 样式，必须直接设置到 danmaku 实例
            if (engine === 'canvas') {
                danmakuInstance.fontSize = parseInt(currentSettings.fontSize);
                danmakuInstance.fontFamily = currentSettings.fontFamily;
                danmakuInstance.opacity = parseFloat(currentSettings.opacity);
            }
            danmakuInstance.resize();
        }
        if (activePlayback) syncDanmakuGeometry(activePlayback);
    }

    function createDanmakuButtons(btnClasses = '', isAttr = '', iconTag = 'i', iconClass = 'material-icons') {
        const toggleBtn = document.createElement('button');
        if (isAttr) toggleBtn.setAttribute('is', isAttr);
        toggleBtn.id = 'danmaku-toggle-btn';
        toggleBtn.className = btnClasses;
        toggleBtn.title = '弹幕开关';
        toggleBtn.setAttribute('aria-label', '弹幕开关');
        toggleBtn.style.display = 'block'; // 借鉴 jellysleep: 强制声明盒模型，解决 JMP(Qt) 渲染器丢失动态组件 display 属性导致按钮 0x0 隐形的 Bug
        toggleBtn.innerHTML = `<${iconTag} class="${iconClass}" style="color:${isDanmakuVisible ? 'inherit' : '#888'}; transition: color 0.2s;" aria-hidden="true">${isDanmakuVisible ? 'subtitles' : 'subtitles_off'}</${iconTag}>`;
        toggleBtn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (!danmakuInstance) return;
            isDanmakuVisible = !isDanmakuVisible;
            isDanmakuVisible ? danmakuInstance.show() : danmakuInstance.hide();
            const iconEl = toggleBtn.querySelector(iconTag);
            if (iconEl) {
                iconEl.style.color = isDanmakuVisible ? 'inherit' : '#888';
                iconEl.textContent = isDanmakuVisible ? 'subtitles' : 'subtitles_off';
            }
        };

        const settingsBtn = document.createElement('button');
        if (isAttr) settingsBtn.setAttribute('is', isAttr);
        settingsBtn.id = 'danmaku-settings-btn';
        settingsBtn.className = btnClasses;
        settingsBtn.title = '弹幕设置';
        settingsBtn.setAttribute('aria-label', '弹幕设置');
        settingsBtn.style.display = 'block'; // 借鉴 jellysleep: 确保按钮强行占据渲染空间
        settingsBtn.innerHTML = `<${iconTag} class="${iconClass}" aria-hidden="true">line_style</${iconTag}>`;
        settingsBtn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            const p = document.getElementById('danmaku-settings-panel');
            const bg = document.getElementById('danmaku-settings-backdrop');
            const isMobile = p && p.classList.contains('dm-mobile-panel');

            if (p) {
                if (p.style.display === 'none' || p.style.display === '') {
                    // 桌面端使用 block (匹配原生 actionSheet)，移动端维持 flex
                    p.style.display = isMobile ? 'flex' : 'block';
                    if (!isMobile) {
                        p.classList.add('opened');
                        p.style.animation = '140ms ease-out 0s 1 normal both running scaleup';
                        
                        // 借鉴 Jellysleep 高级设计 3：动态根据调出按钮的位置计算呈现位置，完美伪装成原生 OSD 弹窗
                        const btnRect = settingsBtn.getBoundingClientRect();
                        const panelHeight = p.offsetHeight || 420;
                        const panelWidth = p.offsetWidth || 340;
                        
                        let topPos = btnRect.top - panelHeight - 15;
                        if (topPos < 10) topPos = 10; // 防溢出顶部屏幕
                        let leftPos = btnRect.left - panelWidth + btnRect.width;
                        if (leftPos < 10) leftPos = 10; // 防溢出左侧屏幕
                        
                        p.style.left = leftPos + 'px';
                        p.style.top = topPos + 'px';
                    }
                    if (bg) {
                        bg.style.display = 'block';
                        if (!isMobile) bg.classList.add('dialogBackdropOpened');
                    }
                } else {
                    p.style.display = 'none';
                    if (!isMobile) {
                        p.classList.remove('opened');
                        p.style.animation = '';
                    }
                    if (bg) {
                        bg.style.display = 'none';
                        if (!isMobile) bg.classList.remove('dialogBackdropOpened');
                    }
                }
            }
        };

        return { toggleBtn, settingsBtn };
    }

    function drawHistogramCanvas(canvas, duration) {
        if (!originalCommentsCache || originalCommentsCache.length === 0) return;

        // 动态读取当前 Jellyfin 进度条”已播放”部分的准确主题颜色
        const progressFill = document.querySelector('.mdl-slider-background-lower');
        const themeColor = progressFill ? window.getComputedStyle(progressFill).backgroundColor : '#00a4dc';

        // 将视频切分为 100 个时间桶
        const bucketsCount = 100;
        const buckets = new Array(bucketsCount).fill(0);
        let maxDensity = 0;

        // 应用时间偏移计算桶分布
        originalCommentsCache.forEach(c => {
            const shiftedTime = c.time + timeOffset;
            // 弹幕时间偏移后可能出现负数或超出视频时长，只统计在 [0, duration] 范围内的
            if (shiftedTime < 0 || shiftedTime > duration) return;
            const bucketIndex = Math.floor((shiftedTime / duration) * bucketsCount);
            if (bucketIndex >= 0 && bucketIndex < bucketsCount) {
                buckets[bucketIndex]++;
                if (buckets[bucketIndex] > maxDensity) {
                    maxDensity = buckets[bucketIndex];
                }
            }
        });

        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();

        // 防止在元素隐藏 (display:none) 宽度为 0 时进行无用绘制
        if (rect.width === 0 || rect.height === 0) return;

        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);

        ctx.clearRect(0, 0, rect.width, rect.height);
        ctx.fillStyle = themeColor;

        const barWidth = rect.width / bucketsCount;
        const gap = barWidth > 4 ? 2 : 1; // 柱间隙自适应

        ctx.shadowColor = themeColor;
        ctx.shadowBlur = 4; // 添加微微的泛光，匹配进度条质感

        if (maxDensity === 0) return; // 拦截无有效分发弹幕时的异常，防止出现被 0 除的情况

        for (let i = 0; i < bucketsCount; i++) {
            const density = buckets[i];
            if (density === 0) continue;

            // 使用平方根算法平滑过高的波峰，防止个别高潮导致其他柱子过矮
            const normalizedDensity = Math.sqrt(density) / Math.sqrt(maxDensity);
            const barHeight = normalizedDensity * (rect.height * 0.85); // 最大高度 85%，顶部留白

            const x = i * barWidth;
            const y = rect.height - barHeight;

            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(x + gap / 2, y, barWidth - gap, barHeight, [2, 2, 0, 0]); // 顶部带圆角
            } else {
                ctx.fillRect(x + gap / 2, y, barWidth - gap, barHeight); // 降级兼容
            }
            ctx.fill();
        }
        ctx.shadowBlur = 0; // 重置阴影避免溢出
    }

    function renderHistogram(sliderContainer, duration) {
        let canvas = document.getElementById('danmaku-histogram-canvas');
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.id = 'danmaku-histogram-canvas';

            // 【核心重构：零侵入设计】不再干预 sliderContainer 的内部子节点。
            // 挂载到 body，利用 fixed 绝对定位实现视觉悬浮，彻底根除破坏 React 虚拟 DOM 导致的 JMP 客户端卡死。
            Object.assign(canvas.style, {
                position: 'fixed',
                pointerEvents: 'none',
                opacity: '0.6',
                zIndex: '9999' // 确保在原生 OSD 控件层之上
            });

            document.body.appendChild(canvas);

            // 动态同步坐标，幽灵贴靠在进度条上方
            const syncPosition = () => {
                if (!document.body.contains(sliderContainer)) return;
                const rect = sliderContainer.getBoundingClientRect();
                // 如果进度条处于隐藏状态，或直方图高度为0（关闭），直方图同步消失
                if (rect.width === 0 || rect.height === 0 || window.getComputedStyle(sliderContainer).display === 'none') {
                    canvas.style.display = 'none';
                    return;
                }
                const h = currentSettings.histogramHeight;
                if (h === 0) {
                    canvas.style.display = 'none';
                    return;
                }
                canvas.style.display = 'block';
                canvas.style.left = rect.left + 'px';
                canvas.style.width = rect.width + 'px';
                canvas.style.top = (rect.top - h) + 'px'; // 精准置于进度条顶部上方 h px 处
                canvas.style.height = h + 'px';
            };

            // 监听容器大小改变 (解决 OSD UI 面板隐藏显示、窗口缩放导致分辨率变糊的情况)
            if (window.ResizeObserver) {
                const ro = new ResizeObserver(() => {
                    syncPosition();
                    const rect = canvas.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        if (currentSettings.histogramHeight > 0) {
                            drawHistogramCanvas(canvas, duration);
                        }
                    }
                });
                ro.observe(sliderContainer);
                canvas._ro = ro; // 挂载到DOM元素以便销毁时释放
                syncPosition();
                if (currentSettings.histogramHeight > 0) drawHistogramCanvas(canvas, duration);
            } else {
                const resizeHandler = () => {
                    if (document.getElementById('danmaku-histogram-canvas')) {
                        syncPosition();
                        if (currentSettings.histogramHeight > 0) {
                            drawHistogramCanvas(canvas, duration);
                        }
                    }
                };
                window.addEventListener('resize', resizeHandler, { passive: true });
                canvas._resizeHandler = resizeHandler; // 挂载引用供清理时解绑

                syncPosition();
                if (currentSettings.histogramHeight > 0) {
                    drawHistogramCanvas(canvas, duration);
                }
            }
        }
    }

    function injectDanmakuUI() {
        // 严格遵守固定语义 1 (UI 按需渲染)：如果当前没有成功挂载引擎或没有弹幕数据，绝对不渲染任何控制面板与按钮
        if (!danmakuInstance || originalCommentsCache.length === 0) return;

        // 检测是否为移动设备
        const isMobile = window.innerWidth <= 768 || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

        // ====== 直方图注入逻辑 (仅限桌面端，且已开启) ======
        if (!isMobile && originalCommentsCache.length > 0 && ENABLE_HISTOGRAM) {
            const sliderContainer = document.querySelector('.sliderContainer.mdl-slider-container');
            const existingCanvas = document.getElementById('danmaku-histogram-canvas');
            if (sliderContainer) {
                // 若已成功获取时长，且 Canvas 尚未创建，则渲染
                if (cachedVideoDuration > 0) {
                    if (!existingCanvas) {
                        renderHistogram(sliderContainer, cachedVideoDuration);
                    } else {
                        // Canvas 已存在但可能处于隐藏状态（sliderContainer 之前不可见时被 syncPosition 隐藏）
                        // 需要主动触发一次 syncPosition 使其重新显示
                        const rect = sliderContainer.getBoundingClientRect();
                        const h = currentSettings.histogramHeight;
                        if (rect.width > 0 && rect.height > 0 && window.getComputedStyle(sliderContainer).display !== 'none' && h > 0) {
                            existingCanvas.style.display = 'block';
                            existingCanvas.style.left = rect.left + 'px';
                            existingCanvas.style.width = rect.width + 'px';
                            existingCanvas.style.top = (rect.top - h) + 'px';
                            existingCanvas.style.height = h + 'px';
                            drawHistogramCanvas(existingCanvas, cachedVideoDuration);
                        } else if (h === 0) {
                            existingCanvas.style.display = 'none';
                        }
                    }
                }
            }
        }

        // 移动端/安卓客户端修复：客户端通常会通过原生代码接管全屏，并用 CSS 永久隐藏网页端的全屏按钮（display: none）。
        // 如果弹幕按钮挂载到这个被永久隐藏的全屏按钮旁，就会导致短暂出现悬浮窗后，被立即移动到不可见的 OSD 容器中而彻底消失。
        // 对策：采用优先级降级查找锚点，优先寻找最稳定的“设置(齿轮)”按钮，其次“字幕”按钮，最后才是“全屏”按钮。
        const anchorQueries = [
            'button.btnVideoOsdSettings, button[data-action="osdsettings" i], button[title*="设置" i], button[title*="Settings" i]',
            'button.btnSubtitles, button[data-action="subtitles" i], button[title*="字幕" i]',
            'button.btnFullscreen, button[data-action="fullscreen" i], button[title*="全屏" i], button[title*="Full screen" i], button[title*="Fullscreen" i]',
            'button.btnAudio, button[title*="音频" i], button[title*="Audio" i]', // 音频轨按钮
            '.videoOsdBottom button[is="paper-icon-button-light"]' // 最通用的回退：兼容并截获控制栏上如 sleep timer 等其他插件的有效图标按钮
        ];

        let targetBtn = null;
        let fallbackTargetBtn = null;

        // 提取 Jellysleep 插件使用的目标容器，作为强制挂载的最强备选点
        const controlsContainer = document.querySelector('.videoOsdBottom .buttons.focuscontainer-x') || document.querySelector('.osdControls .buttons');

        for (const query of anchorQueries) {
            // 修复严重Bug：过滤掉我们自己注入的弹幕按钮。
            // 因为弹幕设置按钮的 title 是"弹幕设置"，会导致被当作原生设置按钮捕获。
            // 这会让程序误判挂载目标，从而触发销毁和重建，形成每秒出现又消失的无限闪烁死循环。
            const btns = Array.from(document.querySelectorAll(query)).filter(b => b.id !== 'danmaku-toggle-btn' && b.id !== 'danmaku-settings-btn');
            const visibleBtn = btns.find(b => b.offsetWidth > 0 || b.offsetHeight > 0);
            if (visibleBtn) {
                targetBtn = visibleBtn;
                break; // 找到真实可见的按钮，立即锁定
            }
            if (!fallbackTargetBtn && btns.length > 0) {
                fallbackTargetBtn = btns[0]; // 记录优先级最高的备用按钮（防 OSD 整体由于 display:none 隐藏时的判断失效）
            }
        }

        targetBtn = targetBtn || fallbackTargetBtn;

        const oldToggle = document.getElementById('danmaku-toggle-btn');
        const oldSettings = document.getElementById('danmaku-settings-btn');
        const oldWrapper = document.getElementById('danmaku-ui-wrapper'); // 兼容旧版以及兜底 Wrapper 清理

        if (!targetBtn) {
            // 采纳 Jellysleep 插件的注入策略：当特定锚点按钮隐藏时，直接找到底层控制栏容器强行推入
            if (controlsContainer) {
                if (oldToggle && oldToggle.parentNode === controlsContainer) return;
                
                if (oldToggle) oldToggle.remove();
                if (oldSettings) oldSettings.remove();
                if (oldWrapper) oldWrapper.remove();

                // 使用与 Jellysleep 相同的类名与组件属性，深度伪装成原生按钮，防止被 OSD 布局引擎踢出
                const { toggleBtn, settingsBtn } = createDanmakuButtons('autoSize paper-icon-button-light', 'paper-icon-button-light', 'span', 'xlargePaperIconButton material-icons');
                
                // 像 Jellysleep 一样，尝试插在 userRating 之前，或者直接追加到末尾
                const userRatingBtn = controlsContainer.querySelector('.btnUserRating');
                if (userRatingBtn) {
                    controlsContainer.insertBefore(settingsBtn, userRatingBtn);
                    controlsContainer.insertBefore(toggleBtn, userRatingBtn);
                } else {
                    controlsContainer.appendChild(settingsBtn);
                    controlsContainer.appendChild(toggleBtn);
                }
                createSettingsPanel();
                return;
            }

            // 当找不到目标按钮时，使用固定悬浮栏方式回退，避免按钮整套消失
            if (oldWrapper && oldWrapper.dataset.fallback === 'true') return;
            if (oldWrapper) oldWrapper.remove();
            if (oldToggle) oldToggle.remove();
            if (oldSettings) oldSettings.remove();

            const fallbackWrapper = document.createElement('div');
            fallbackWrapper.id = 'danmaku-ui-wrapper';
            fallbackWrapper.dataset.fallback = 'true';
            Object.assign(fallbackWrapper.style, {
                position: 'fixed',
                bottom: '80px',
                right: '20px',
                zIndex: '100000',
                display: 'flex',
                gap: '6px',
                pointerEvents: 'auto'
            });

            document.body.appendChild(fallbackWrapper);
            const { toggleBtn, settingsBtn } = createDanmakuButtons();
            fallbackWrapper.appendChild(settingsBtn);
            fallbackWrapper.appendChild(toggleBtn);
            // [关键修复] Fallback 路径同样需要调用 createSettingsPanel（它内部有防重保护）
            createSettingsPanel();
            return;
        }

        // 直接校验按钮在 DOM 里的顺序与位置：settingsBtn -> toggleBtn -> targetBtn
        if (oldToggle && oldToggle.nextElementSibling === targetBtn && oldSettings && oldSettings.nextElementSibling === oldToggle) {
            return; // 状态健康且位置完全正确，直接退出
        }

        // 弃用 display: contents 的 Wrapper 包裹器，彻底解决桌面端 Web 引擎渲染子元素凭空消失的 Bug
        if (oldToggle) oldToggle.remove();
        if (oldSettings) oldSettings.remove();
        if (oldWrapper) oldWrapper.remove();

        const buttonContainer = targetBtn.parentNode;

        // 获取目标按钮上的所有样式类，移除专属全屏类名，防止附加特定的 CSS 逻辑
        const btnClasses = targetBtn.className.replace(/\b(btnFullscreen|btnVideoOsdSettings|btnSubtitles|btnAudio)\b/ig, '').trim();
        const isAttr = targetBtn.getAttribute('is'); // 兼容 Web Component

        // 动态寻找内部的图标元素 (span 或 i)，兼容不同主题和版本的标签类型
        const targetIcon = targetBtn.querySelector('i, span.material-icons');
        const iconTag = targetIcon ? targetIcon.tagName.toLowerCase() : 'i';
        let iconClass = targetIcon ? targetIcon.className : 'material-icons';
        iconClass = iconClass.replace(/\b(fullscreen|settings|subtitles|audiotrack)\b/ig, '').trim(); // 防止复制了其它特定功能的 icon class

        const { toggleBtn, settingsBtn } = createDanmakuButtons(btnClasses, isAttr, iconTag, iconClass);

        // 采用倒序插入，确保 UI 上排布为：弹幕设置、弹幕开关、原生的锚点按钮
        buttonContainer.insertBefore(settingsBtn, targetBtn);
        buttonContainer.insertBefore(toggleBtn, targetBtn);

        createSettingsPanel();
    }

    // 4. 初始化和挂载弹幕：每次真实视频生命周期都有独立 generation 与 AbortController。
    async function initDanmaku(videoElement) {
        if (!videoElement || activePlayback) return;
        const playback = {
            generation: ++playbackGeneration,
            controller: new AbortController(),
            video: videoElement,
            itemId: null,
            container: null,
            completed: false,
            resizeObserver: null,
            cleanupEvents: null,
            retryTimer: null
        };
        activePlayback = playback;
        const signal = playback.controller.signal;

        try {
            let itemId = getCurrentItemId(videoElement);
            if (!itemId) {
                itemId = await fetchCurrentPlayingItemId(signal);
                if (!isPlaybackCurrent(playback)) return;
                if (itemId) console.log(`[Danmaku Injector] Sessions API 获取到 ItemId: ${itemId}`);
            }
            if (!itemId) {
                console.warn('[Danmaku Injector] 尚未获取 ItemId，2 秒后在同一视频上重试。');
                playback.retryTimer = setTimeout(() => {
                    if (isPlaybackCurrent(playback)) {
                        cleanupDanmaku();
                        initDanmaku(videoElement);
                    }
                }, 2000);
                return;
            }

            playback.itemId = itemId;
            currentItemIdCache = itemId;
            console.log(`[Danmaku Injector] 初始化弹幕 (itemId=${itemId})`);
            const comments = await fetchDanmakuData(itemId, signal);
            if (!isPlaybackCurrent(playback) || playback.itemId !== itemId) return;
            if (!comments.length) {
                playback.completed = true;
                console.log('[Danmaku Injector] 未获取到弹幕，本视频不挂载引擎和 UI。');
                return;
            }

            // 没有弹幕时不触碰 CDN；到这里确认有数据后才加载渲染库。
            await loadDanmakuLibrary();
            if (!isPlaybackCurrent(playback) || playback.itemId !== itemId) return;

            const container = document.createElement('div');
            container.id = 'custom-danmaku-container';
            Object.assign(container.style, {
                position: 'fixed', pointerEvents: 'none', zIndex: '999',
                opacity: String(currentSettings.opacity), fontSize: `${currentSettings.fontSize}px`,
                fontFamily: currentSettings.fontFamily
            });
            container.setAttribute('data-color-style', currentSettings.style);
            document.body.appendChild(container);
            playback.container = container;
            originalCommentsCache = comments;
            bindPlaybackEvents(playback);
            if (!isPlaybackCurrent(playback)) return;
            if (!createDanmakuEngine(applySettingsToComments())) throw new Error('Danmaku 引擎创建失败');
            playback.completed = true;
            injectDanmakuUI();
        } catch (error) {
            if (isAbortError(error)) return;
            console.error('[Danmaku Injector] 弹幕初始化出错:', error);
            if (isPlaybackCurrent(playback)) {
                destroyDanmakuInstance();
                if (playback.container) playback.container.remove();
                playback.container = null;
                if (playback.resizeObserver) playback.resizeObserver.disconnect();
                playback.resizeObserver = null;
                if (playback.cleanupEvents) playback.cleanupEvents();
                playback.cleanupEvents = null;
                originalCommentsCache = [];
                removeHistogram();
                removeDanmakuUI();
                removeDanmakuSourceToast();
                playback.completed = true;
            }
        }
    }

    // 5. 监听 DOM 变化，寻找 <video> 元素
    // [重要] JMP 环境检测前置：脚本加载时直接退出，不启动 Observer
    if (isQtWebEngine()) {
        console.log('[Danmaku Injector] JMP/QtWebEngine 环境检测成功，脚本静默退出，不进行任何监听和初始化');
        return;
    }

    // 防抖扫描播放状态；不会向 Jellyfin 的虚拟 DOM 写入任何节点。
    let observerDebounceTimer = null;
    const OBSERVER_DEBOUNCE_MS = 200;
    function scanPlaybackState() {
        const videoElement = document.querySelector('video:not([data-injected-video="1"])');
        const isVideoPage = window.location.hash.includes('/video') || window.location.hash.includes('videoosd') || window.location.href.includes('/play') || document.querySelector('.videoOsdPage') !== null;
        if (!isVideoPage || !videoElement) {
            if (activePlayback) cleanupDanmaku();
            return;
        }
        if (activePlayback) {
            const observedItemId = getCurrentItemId(videoElement);
            const changedVideo = activePlayback.video !== videoElement;
            const changedItem = observedItemId && activePlayback.itemId && observedItemId !== activePlayback.itemId;
            if (changedVideo || changedItem) {
                cleanupDanmaku();
                initDanmaku(videoElement);
            } else if (danmakuInstance) {
                syncDanmakuGeometry(activePlayback);
                injectDanmakuUI();
            }
            return;
        }
        initDanmaku(videoElement);
    }

    const observer = new MutationObserver(() => {
        if (observerDebounceTimer !== null) return;
        observerDebounceTimer = setTimeout(() => {
            observerDebounceTimer = null;
            scanPlaybackState();
        }, OBSERVER_DEBOUNCE_MS);
    });

    // 启动观察器，增加 attributes: true 以便监听 src 属性的后期赋值
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    scanPlaybackState();
    console.log('[Danmaku Injector] 脚本已加载，正在监听播放器状态...');

})();
