// 用途：在 Jellyfin 的 JavaScript Injector 插件中使用的 JS 注入脚本，用于在 HTML5 播放器中请求、解析并渲染弹幕，同时提供自定义的弹幕设置控制面板。
(function () {
    'use strict';

    /**
     * 弹幕功能固定语义说明：
     * 1. UI 按需渲染：只有当获取到有效的弹幕数据时，才会在播放器上渲染弹幕相关的控制按钮，否则不显示。
     * 2. 来源状态通知：成功获取到弹幕时，会在页面底部弹出短时间的通知提示，如"获取到在线弹幕"或"获取到本地弹幕"。
     * 3. 查询顺序可控：脚本顶部提供 DANMAKU_QUERY_ORDER 配置项，允许用户自由组合或精简弹幕接口的查询顺序。
     * 4. 在线服务校验：如果用户未配置有效的在线服务地址（如非合法的 HTTP/HTTPS URL），则自动跳过在线查询路线。
     * 5. 异步状态安全锁：通过 isDanmakuInitializing 和 isDanmakuInitialized 两个状态锁，严格控制单页应用(SPA)中复杂的 DOM 变化。
     *    确保每个视频生命周期内只触发一次核心查询逻辑；即使获取弹幕或 ID 失败，也会安全地标记为已处理，彻底杜绝无限轮询黑洞。
     * 6. 环境主动检测：脚本加载时立即检测 QtWebEngine 环境，检测到后直接退出，不启动 MutationObserver，不进行任何 DOM 监听，确保对非兼容环境零侵入。
     * 7. UI 与引擎分离：控制按钮和设置面板的创建与弹幕引擎初始化完全解耦。
     *    即使弹幕引擎创建失败（如 JMP 环境），UI 相关状态仍需正确标记，防止 Observer 不断重复尝试初始化。
     * 8. 视频生命周期锁定：通过 currentItemIdCache 缓存当前视频 ID，在 DOM 变化时通过对比 ID 判断是否真的是视频切换，而非同一视频内的正常 DOM 波动。
     * 9. 异步安全退出：initDanmaku() 内部的任何提前 return，通常需同时设置 isDanmakuInitialized=true 和 isDanmakuInitializing=false。
     *    唯一例外：获取 ItemId 超时时仅解锁 isDanmakuInitializing=false，保留重试机会；真正的"已处理"状态由成功初始化或明确失败（无弹幕）时标记。
     *    确保状态锁在所有退出路径上都被正确解锁。
     */

    // 配置项
    const DANMAKU_LIB_URL = 'https://unpkg.com/danmaku/dist/danmaku.min.js';
    const ONLINE_DANMU_SERVICE_URL = 'HXXPS://yourapiurl.com/123456789';
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
    let isDanmakuInitialized = false;
    let isDanmakuInitializing = false;
    let currentItemIdCache = null;
    let isDanmakuVisible = true;
    let originalCommentsCache = []; // 原始弹幕数据缓存，用于修改设置时重新生成

    // 直方图功能相关的状态变量
    let cachedVideoDuration = 0;
    let durationPollAttempts = 0;
    const MAX_DURATION_POLLS = 30; // 最多尝试 30 次获取时长 (对应约 30 秒)

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
        histogramHeight: 24
    };
    let currentSettings = { ...DEFAULT_SETTINGS };

    function loadSettings() {
        try {
            const saved = localStorage.getItem('jellyfin_danmaku_settings');
            if (saved) currentSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
        } catch (e) { }
    }

    function saveSettings() {
        localStorage.setItem('jellyfin_danmaku_settings', JSON.stringify(currentSettings));
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
            #custom-danmaku-container > div {
                font-size: inherit !important;
                text-shadow: 1px 1px 2px #000, -1px -1px 2px #000, 1px -1px 2px #000, -1px 1px 2px #000 !important;
                font-weight: bold;
            }
            
            /* 赛博朋克风格 (青色主调 + 洋红阴影) */
            #custom-danmaku-container[data-color-style="cyberpunk"] > div {
                color: #0ff !important;
                text-shadow: 2px 2px 0px #f0f, -1px -1px 1px #000, 1px -1px 1px #000 !important;
            }
            /* 黑客帝国风格 (荧光绿发光) */
            #custom-danmaku-container[data-color-style="matrix"] > div {
                color: #0f0 !important;
                text-shadow: 0px 0px 8px #0f0, 1px 1px 2px #000 !important;
                font-family: "Courier New", Courier, monospace !important;
            }
            /* 幻彩渐变风格 (利用色相旋转动画实现彩虹效果) */
            @keyframes dm-rainbow-anim {
                0% { filter: hue-rotate(0deg); }
                100% { filter: hue-rotate(360deg); }
            }
            #custom-danmaku-container[data-color-style="rainbow"] > div {
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
        const blocks = currentSettings.blocklist.split('\n').map(s => s.trim()).filter(s => s);

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

        // 3. 映射颜色
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
            return { ...c, style: { ...c.style, color: outColor } };
        });
    }

    // 当配置变更时，实时重刷弹幕数据
    function reloadDanmakuData() {
        if (!danmakuInstance || !originalCommentsCache.length) return;
        const newComments = applySettingsToComments();
        // 必须按时间排序后喂给引擎
        danmakuInstance.comments = newComments.slice().sort((a, b) => a.time - b.time);
        danmakuInstance.clear(); // 清空当前屏幕，让新配置立刻生效
    }

    // 1. 动态加载弹幕库
    function loadDanmakuLibrary() {
        return new Promise((resolve, reject) => {
            if (window.Danmaku) return resolve(window.Danmaku);
            const script = document.createElement('script');
            script.src = DANMAKU_LIB_URL;
            script.onload = () => resolve(window.Danmaku);
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    // 2. 获取当前视频的 itemId（Jellyfin 10.11 专用）
    //    Jellyfin 10.11 的视频 src 格式为：http://host/Videos/{itemId}/stream.mp4
    //    优先从 video.src 同步提取；已缓存时直接返回缓存值（避免重复探测）
    function getCurrentItemId(videoElement) {
        // 已缓存过 itemId 且尚未切换视频，直接返回缓存值
        if (currentItemIdCache) {
            return currentItemIdCache;
        }

        // 从 video.src 中提取 itemId（/Videos/{itemId}/stream.mp4）
        if (videoElement) {
            const src = videoElement.src || videoElement.currentSrc || '';
            const match = src.match(/\/Videos\/([a-f0-9]{32})/i);
            if (match) {
                console.log(`[Danmaku Injector] [getCurrentItemId] 从 video.src 提取: ${match[1]}`);
                return match[1];
            }
        }

        return null;
    }

    function showDanmakuSourceToast(text) {
        if (!text) return;
        const oldToast = document.getElementById('danmaku-source-toast');
        if (oldToast) {
            oldToast.remove();
            clearTimeout(oldToast._hideTimer);
        }

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
            toast.style.opacity = '1';
        }, 50);

        toast._hideTimer = setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 250);
        }, 5000);
    }

    // 验证是否为合法的 HTTP/HTTPS URL
    function isValidHttpUrl(string) {
        try {
            const url = new URL(string);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch (_) {
            return false;
        }
    }

    // 封装带有超时的 fetch 请求，防止在线弹幕服务器卡死导致长时间等待
    async function fetchWithTimeout(resource, options = {}) {
        const { timeout = 8000 } = options; // 默认 8 秒超时
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(resource, { ...options, signal: controller.signal });
            clearTimeout(id);
            return response;
        } catch (error) {
            clearTimeout(id);
            throw error;
        }
    }

    // ==========================================
    // 借鉴 Jellysleep 高级设计 2：强等待 ApiClient 就绪
    // ==========================================
    function waitForApiClient() {
        return new Promise((resolve) => {
            let retryCount = 0;
            const maxRetries = 30; // 等待上限 15 秒
            const check = () => {
                if (window.ApiClient && window.ApiClient.accessToken && window.ApiClient.accessToken()) {
                    resolve(window.ApiClient.accessToken());
                    return;
                }
                if (++retryCount >= maxRetries) {
                    console.warn('[Danmaku Injector] ApiClient 强等待超时，尝试降级回退');
                    resolve(null);
                    return;
                }
                setTimeout(check, 500);
            };
            check();
        });
    }

    // 3. 调度获取弹幕数据
    async function fetchDanmakuData(itemId) {
        try {
            const headers = {};
            const token = await waitForApiClient();
            if (token) {
                headers['Authorization'] = `MediaBrowser Token="${token}"`;
            }

            for (const source of DANMAKU_QUERY_ORDER) {
                if (source === 'local') {
                    const localComments = await fetchDanmakuFromLocalApi(itemId, headers);
                    if (localComments && localComments.length > 0) {
                        showDanmakuSourceToast('获取到本地弹幕');
                        return localComments;
                    }
                } else if (source === 'online') {
                    if (!isValidHttpUrl(ONLINE_DANMU_SERVICE_URL)) {
                        console.log('[Danmaku Injector] 在线弹幕 API 地址无效或未配置，跳过在线查询。');
                        continue;
                    }
                    const onlineComments = await fetchDanmakuFromOnlineApi(itemId, headers);
                    const commentArray = onlineComments.comments || (Array.isArray(onlineComments) ? onlineComments : null);
                    if (commentArray && commentArray.length > 0) {
                        const displayText = onlineComments.displayText || null;
                        if (displayText) {
                            showDanmakuSourceToast(`获取到在线弹幕 - ${displayText}`);
                        } else {
                            showDanmakuSourceToast('获取到在线弹幕');
                        }
                        return commentArray;
                    }
                }
            }

            console.log(`[Danmaku Injector] ID: ${itemId} 所有配置源均未查到弹幕，结束。`);
            return [];
        } catch (error) {
            console.error('[Danmaku Injector] 获取弹幕失败:', error);
            return [];
        }
    }

    async function fetchDanmakuFromLocalApi(itemId, headers) {
        try {
            const response = await fetchWithTimeout(`/api/danmu/${itemId}`, { headers, timeout: 5000 });
            if (!response.ok) return [];
            const text = await response.text();
            if (!text) return [];

            // 兼容返回 JSON {"url": "..."} 格式
            const data = JSON.parse(text);
            const danmuUrl = data.url || data.Url || data.URL;
            if (danmuUrl) return await fetchAndParseDanmakuFromUrl(danmuUrl, headers);
        } catch (error) {
            // 如果解析失败或无弹幕静默忽略
            return [];
        }
    }

    async function fetchAndParseDanmakuFromUrl(url, headers) {
        try {
            const response = await fetchWithTimeout(url, { headers, timeout: 10000 });
            if (!response.ok) {
                if (response.status === 404) return [];
                throw new Error(`弹幕文件获取失败 (HTTP ${response.status})`);
            }
            const xmlString = await response.text();
            if (!xmlString) return [];
            return parseDanmakuData(xmlString);
        } catch (error) {
            if (error.name === 'AbortError') {
                console.warn('[Danmaku Injector] 获取弹幕文件超时:', url);
            } else {
                console.warn('[Danmaku Injector] 通过 URL 获取弹幕失败:', url, error);
            }
            return [];
        }
    }

    // 获取 Jellyfin 中的视频元数据（剧名、季号、集号等）
    async function fetchItemDetails(itemId, headers) {
        try {
            await waitForApiClient(); // 确保 window.ApiClient 及其底层方法已完全就绪
            const userId = window.ApiClient?.getCurrentUserId?.();
            if (!userId) {
                console.warn('[Danmaku Injector] 无法获取当前 userId');
                return null;
            }
            const response = await fetchWithTimeout(`/Users/${userId}/Items/${itemId}`, { headers, timeout: 5000 });
            if (!response.ok) return null;
            return await response.json();
        } catch (error) {
            console.error('[Danmaku Injector] 获取视频元数据失败', error);
            return null;
        }
    }

    // 通过 Jellyfin Sessions API 获取当前正在播放的媒体项 ID
    // 解决剧集等场景下 URL/hash/video src 均无法获取 ID 的问题
    // 严格过滤：只返回当前浏览器会话的播放项，避免多设备场景下误取其他设备的播放信息
    async function fetchCurrentPlayingItemId() {
        try {
            await waitForApiClient();
            const client = window.ApiClient;
            if (!client) return null;

            const serverUrl = client.serverAddress();
            const token = client.accessToken();
            const userId = client.getCurrentUserId();
            const deviceId = client.deviceId();
            if (!serverUrl || !token || !userId || !deviceId) return null;

            const response = await fetchWithTimeout(`${serverUrl}/Sessions`, {
                headers: {
                    'Authorization': `MediaBrowser Token="${token}"`,
                    'Content-Type': 'application/json'
                },
                timeout: 5000
            });
            if (!response.ok) return null;

            const sessions = await response.json();
            // 严格筛选：必须同时匹配当前用户 ID 和当前设备 ID，确保是本浏览器会话
            const playingSession = sessions.find(s =>
                s.NowPlayingItem &&
                s.NowPlayingItem.Id &&
                s.UserId === userId &&
                s.DeviceId === deviceId
            );
            if (playingSession && playingSession.NowPlayingItem.Id) {
                return playingSession.NowPlayingItem.Id;
            }
            return null;
        } catch (e) {
            console.warn('[Danmaku Injector] fetchCurrentPlayingItemId 失败：', e);
            return null;
        }
    }

    async function fetchDanmakuFromOnlineApi(itemId, headers) {
        try {
            // 第一步：获取 Jellyfin 中的视频元数据
            const itemInfo = await fetchItemDetails(itemId, headers);
            let queryFileName = '';
            let displayText = '';

            if (itemInfo) {
                if (itemInfo.Type === 'Episode') {
                    const seriesName = itemInfo.SeriesName || '';
                    const season = String(itemInfo.ParentIndexNumber || 1).padStart(2, '0');
                    const episode = String(itemInfo.IndexNumber || 1).padStart(2, '0');
                    queryFileName = `${seriesName}.S${season}E${episode}`;
                    displayText = `${seriesName} S${season}E${episode}`;
                    console.log(`[Danmaku Injector] 提取剧集元数据 -> 剧名: "${seriesName}", 季: ${season}, 集: ${episode}`);
                } else {
                    // 电影或其他类型，使用本地化名称(Name)而不是原名(OriginalTitle)，提高中文弹幕库的匹配率
                    queryFileName = itemInfo.Name || '';
                    if (itemInfo.ProductionYear) queryFileName += `.${itemInfo.ProductionYear}`;
                    displayText = itemInfo.Name || '';
                    if (itemInfo.ProductionYear) displayText += ` (${itemInfo.ProductionYear})`;
                    console.log(`[Danmaku Injector] 提取电影/其他元数据 -> 片名: "${itemInfo.Name}", 年份: ${itemInfo.ProductionYear || '无'}`);
                }
                console.log(`[Danmaku Injector] 最终拼接的查询参数 (fileName): "${queryFileName}"`);
            }

            // 第二步：使用 match 接口匹配 episodeId
            if (queryFileName) {
                console.log(`[Danmaku Injector] 正在使用关键字匹配弹幕: ${queryFileName}`);
                const matchUrl = `${ONLINE_DANMU_SERVICE_URL}/api/v2/match`;
                const matchResponse = await fetchWithTimeout(matchUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileName: queryFileName }),
                    timeout: 8000
                });

                if (matchResponse.ok) {
                    const matchData = await matchResponse.json();

                    // 提前判断：如果查询失败或未命中，则提前返回
                    if (!matchData.success || !matchData.isMatched) {
                        console.log(`[Danmaku Injector] 未能精准匹配到对应的弹幕资源 (success: ${matchData.success}, isMatched: ${matchData.isMatched})`);
                        return [];
                    }

                    if (matchData.matches && matchData.matches.length > 0) {
                        const episodeId = matchData.matches[0].episodeId;
                        console.log(`[Danmaku Injector] 匹配成功！获取到 episodeId: ${episodeId}`);

                        // 第三步：根据 episodeId 请求 XML 弹幕 (请求外部API无需携带Jellyfin headers)
                        const danmakuUrl = `${ONLINE_DANMU_SERVICE_URL}/api/v2/comment/${episodeId}?format=xml&duration=true`;
                        const comments = await fetchAndParseDanmakuFromUrl(danmakuUrl, {});
                        // 返回弹幕数据及用于显示的剧集/电影名称信息
                        return { comments, displayText };
                    } else {
                        console.log(`[Danmaku Injector] 返回状态为匹配成功，但未包含有效的剧集(matches)信息`);
                        return [];
                    }
                }
            }

            return [];
        } catch (error) {
            if (error.name === 'AbortError') {
                console.warn(`[Danmaku Injector] 在线匹配 API 请求超时 (itemId=${itemId})`);
            } else {
                console.warn(`[Danmaku Injector] 在线匹配 API 请求失败 (itemId=${itemId})：`, error);
            }
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
            const dTags = xmlDoc.getElementsByTagName('d');

            for (let i = 0; i < dTags.length; i++) {
                const text = dTags[i].textContent;
                const p = dTags[i].getAttribute('p');

                if (p && text) {
                    const attrs = p.split(',');
                    // Bilibili XML 标准 p 属性格式: "time,type,size,color,timestamp,pool,uid,rowid"
                    const time = parseFloat(attrs[0]);
                    const type = parseInt(attrs[1]);
                    const colorDec = parseInt(attrs[3], 10);
                    const validColorDec = isNaN(colorDec) ? 16777215 : colorDec; // 防止 NaN 导致颜色样式崩溃，回退到白色

                    const color = '#' + validColorDec.toString(16).padStart(6, '0');

                    let mode = 'rtl'; // 默认从右向左滚动 (通常 type 为 1, 2, 3)
                    if (type === 4) mode = 'bottom'; // 底部弹幕
                    else if (type === 5) mode = 'top'; // 顶部弹幕

                    // 保存原始颜色以便后续切换风格时恢复，注意放入 style 对象中 Danmaku.js 才会读取
                    comments.push({ text, time, mode, originalColor: color, style: { color } });
                }
            }
            console.log(`[Danmaku Injector] 成功解析了 ${comments.length} 条弹幕`);
        } catch (e) {
            console.error('[Danmaku Injector] 解析弹幕 XML 失败:', e);
        }
        return comments;
    }

    // 彻底清理并卸载弹幕
    function cleanupDanmaku() {
        console.log('[Danmaku Injector] 视频源改变或销毁，正在清理弹幕...');
        if (danmakuInstance) {
            if (danmakuInstance._proxy) {
                danmakuInstance._proxy.destroy();
            }
            danmakuInstance.destroy();
            danmakuInstance = null;
        }
        const container = document.getElementById('custom-danmaku-container');
        if (container) {
            if (container._ro) container._ro.disconnect();
            if (container._resizeHandler) window.removeEventListener('resize', container._resizeHandler);
            if (container.parentNode) {
                container.parentNode.removeChild(container);
            }
        }
        isDanmakuInitialized = false;
        currentItemIdCache = null;
        originalCommentsCache = [];

        // 清理直方图状态
        cachedVideoDuration = 0;
        durationPollAttempts = 0;
        const histogramCanvas = document.getElementById('danmaku-histogram-canvas');
        if (histogramCanvas) {
            if (histogramCanvas._ro) histogramCanvas._ro.disconnect();
            if (histogramCanvas._resizeHandler) window.removeEventListener('resize', histogramCanvas._resizeHandler); // 解绑回调防内存泄漏
            histogramCanvas.remove();
        }
        removeDanmakuUI();
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
                    <div class="dm-setting-row">
                        <div style="font-size:14px; ${isMobile?'font-weight:500;':''}">直方图高度</div>
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="range" id="dm-histogram-height" min="0" max="48" step="2" value="24" style="width:100px; margin:0;">
                            <span id="dm-histogram-height-label" style="font-size:12px; min-width:28px; text-align:right;">24px</span>
                        </div>
                    </div>
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
            document.getElementById('dm-histogram-height').value = currentSettings.histogramHeight;
            document.getElementById('dm-histogram-height-label').textContent =
                currentSettings.histogramHeight === 0 ? '关闭' : currentSettings.histogramHeight + 'px';
        }
        updateUIValues();

        // 一键重置
        document.getElementById('danmaku-settings-reset').onclick = () => {
            currentSettings = { ...DEFAULT_SETTINGS };
            saveSettings();
            updateUIValues();
            applyVisualSettings();
            reloadDanmakuData();
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
        document.getElementById('dm-density').onchange = (e) => {
            currentSettings.density = parseInt(e.target.value);
            saveSettings();
            reloadDanmakuData(); // 更改密度需要重新计算并投递弹幕数据
        };
        document.getElementById('dm-speed').onchange = (e) => {
            currentSettings.speed = parseInt(e.target.value); saveSettings(); applyVisualSettings();
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
            container.style.height = currentSettings.area + '%';
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

        // 动态读取当前 Jellyfin 进度条“已播放”部分的准确主题颜色
        const progressFill = document.querySelector('.mdl-slider-background-lower');
        const themeColor = progressFill ? window.getComputedStyle(progressFill).backgroundColor : '#00a4dc';

        // 将视频切分为 100 个时间桶
        const bucketsCount = 100;
        const buckets = new Array(bucketsCount).fill(0);
        let maxDensity = 0;

        originalCommentsCache.forEach(c => {
            const bucketIndex = Math.floor((c.time / duration) * bucketsCount);
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
                    const rect = canvas.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        syncPosition();
                        if (currentSettings.histogramHeight > 0) {
                            drawHistogramCanvas(canvas, duration);
                        }
                    }
                });
                ro.observe(sliderContainer);
                canvas._ro = ro; // 挂载到DOM元素以便销毁时释放
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
                // 尚未获取时长，尝试轮询查询
                else if (durationPollAttempts < MAX_DURATION_POLLS) {
                    // 优先使用引擎已经锁定的媒体元素，避免出现多播放器实例的页面误拿到不可见元素
                    const video = (danmakuInstance && danmakuInstance.media) ? danmakuInstance.media : document.querySelector('video:not([data-injected-video="1"])');
                    if (video && video.duration > 0 && !isNaN(video.duration)) {
                        cachedVideoDuration = video.duration;
                        console.log(`[Danmaku Injector] 获取到视频时长: ${cachedVideoDuration}s，准备绘制直方图 (共尝试: ${durationPollAttempts + 1} 次)`);
                        renderHistogram(sliderContainer, cachedVideoDuration);
                    } else {
                        durationPollAttempts++;
                        if (durationPollAttempts >= MAX_DURATION_POLLS) {
                            console.warn(`[Danmaku Injector] 获取视频时长超时(${MAX_DURATION_POLLS}次)，已达上限，放弃绘制直方图`);
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

    // 4. 初始化和挂载弹幕
    async function initDanmaku(initialVideoElement) {
        if (isDanmakuInitialized || isDanmakuInitializing) return;

        isDanmakuInitializing = true; // 加锁，防止异步期间被重复调用

        let videoElement = initialVideoElement;
        let itemId = null;

        // ---- 阶段一：同步从 video.src 提取（Jellyfin 10.11 直接 MP4 流，立即可用）----
        if (!videoElement) {
            videoElement = document.querySelector('video:not([data-injected-video="1"])');
        }
        itemId = getCurrentItemId(videoElement);

        // ---- 阶段二：Sessions API 兜底（最可靠，解决 blob URL 等同步方法失效的场景）----
        if (!itemId) {
            try {
                const sessionItemId = await fetchCurrentPlayingItemId();
                if (sessionItemId) {
                    console.log(`[Danmaku Injector] Sessions API 获取到 ItemId: ${sessionItemId}`);
                    itemId = sessionItemId;
                }
            } catch (e) {
                console.warn('[Danmaku Injector] Sessions API 获取失败：', e);
            }
        }

        // ---- 阶段三：仍未获取到 ID，放弃本次初始化 ----
        if (!itemId) {
            console.warn('[Danmaku Injector] 获取视频 ItemId 失败，放弃本次弹幕初始化。');
            // 不标记 isDanmakuInitialized=true，保留重试机会；Observer 在 DOM 变化时会再次触发
            isDanmakuInitializing = false;
            return;
        }

        currentItemIdCache = itemId; // 锁定当前视频特征，防止错误卸载
        console.log('[Danmaku Injector] 检测到视频播放，正在初始化弹幕...');

        // 准备弹幕容器
        const container = document.createElement('div');
        container.id = 'custom-danmaku-container';
        container.style.position = 'absolute';
        container.style.top = '0';
        container.style.left = '0';
        container.style.width = '100%';
        container.style.height = '100%';
        container.style.pointerEvents = 'none'; // 防止遮挡视频点击事件
        container.style.zIndex = '999'; // 确保在视频画面之上

        // 应用初始化视觉参数
        container.style.opacity = currentSettings.opacity;
        container.style.fontSize = currentSettings.fontSize + 'px';
        container.style.fontFamily = currentSettings.fontFamily;
        container.style.height = currentSettings.area + '%';
        container.setAttribute('data-color-style', currentSettings.style);

        // 为彻底避免与 React/Vue 虚拟 DOM 产生冲突导致页面卡死，
        // 放弃向播放器内部 (.videoOsdPage) 插入节点，一律采用固定定位挂载到 document.body
        container.style.position = 'fixed';
        document.body.appendChild(container);

        try {
            // 加载库并获取数据
            const Danmaku = await loadDanmakuLibrary();
            const comments = await fetchDanmakuData(itemId);

            // 如果在异步请求期间发生了切集，则直接退出不再渲染
            if (!document.body.contains(container)) return;

            // 只有当获取到有效弹幕时才渲染 UI 和初始化弹幕引擎
            if (!comments || comments.length === 0) {
                console.log('[Danmaku Injector] 未获取到弹幕，不挂载弹幕引擎和UI');
                container.remove();
                isDanmakuInitialized = true; // 修复：标记已完成查询（即已明确无弹幕），防止 Observer 陷入无限重试循环
                isDanmakuInitializing = false;
                return;
            }

            originalCommentsCache = comments;
            const processedComments = applySettingsToComments();

            // 初始化 Danmaku.js
            const engine = 'dom';
            console.log(`[Danmaku Injector] 渲染引擎: ${engine}`);
            danmakuInstance = new Danmaku({
                container: container,
                media: videoElement || undefined, // 兼容初始化时仍未拿到 mock video 的情况
                comments: processedComments.slice().sort((a, b) => a.time - b.time),
                engine: engine
            });

            // 如果初始化引擎时还没拿到视频元素（桌面端延迟挂载），启动安全补偿定时器
            if (!videoElement) {
                let bindAttempts = 0;
                const bindInterval = setInterval(() => {
                    const v = document.querySelector('video:not([data-injected-video="1"])');
                    if (v && danmakuInstance) {
                        danmakuInstance.media = v;
                        console.log('[Danmaku Injector] 成功将延迟加载的播放器实例绑定到弹幕引擎，弹幕将可正常同步进度');
                        clearInterval(bindInterval);
                    }
                    if (++bindAttempts > 60) clearInterval(bindInterval); // 30秒后放弃
                }, 500);
            }

            // 监听容器尺寸变化，解决移动端横竖屏切换导致弹幕显示区域变窄的Bug
            if (window.ResizeObserver) {
                const ro = new ResizeObserver(() => {
                    if (danmakuInstance) danmakuInstance.resize();
                });
                ro.observe(container);
                container._ro = ro;
            } else {
                container._resizeHandler = () => {
                    if (danmakuInstance) danmakuInstance.resize();
                };
                window.addEventListener('resize', container._resizeHandler, { passive: true });
            }

            danmakuInstance.speed = parseInt(currentSettings.speed);
            if (!isDanmakuVisible) danmakuInstance.hide();

            // [重要] canvas 引擎需要在初始化时同步所有视觉参数，不仅仅是 speed
            // applyVisualSettings() 会同时处理 DOM（container.style）和 canvas（danmakuInstance）两种模式
            applyVisualSettings();

            isDanmakuInitialized = true;
            // [关键修复] 主动触发 UI 注入，因为 Observer 可能此时不再有 DOM 变化可触发它
            // injectDanmakuUI() 内部有防重保护，可以安全多次调用
            injectDanmakuUI();
        } catch (error) {
            console.error('[Danmaku Injector] 弹幕初始化出错:', error);
            // 语义9：发生严重异常时标记为已完成查询，避免由于网络超时等原因导致疯狂重试
            isDanmakuInitialized = true;
            if (container && container.parentNode) container.remove();
        } finally {
            isDanmakuInitializing = false; // finally 统一解锁，语义5：所有退出路径均需解锁
        }
    }

    // 5. 监听 DOM 变化，寻找 <video> 元素
    // [重要] JMP 环境检测前置：脚本加载时直接退出，不启动 Observer
    if (isQtWebEngine()) {
        console.log('[Danmaku Injector] JMP/QtWebEngine 环境检测成功，脚本静默退出，不进行任何监听和初始化');
        return;
    }

    const observer = new MutationObserver(() => {
        // 排除 trailer 注入器可能生成的干扰视频标签
        const videoElement = document.querySelector('video:not([data-injected-video="1"])');
        const isVideoPage = window.location.hash.includes('/video') || window.location.hash.includes('videoosd') || window.location.href.includes('/play') || document.querySelector('.videoOsdPage') !== null;

        if (isDanmakuInitialized) {
            // 彻底对齐 jellysleep：通过路由状态判断是否退出，比强行检测 video 元素在跨端时更稳定
            if (!isVideoPage) {
                cleanupDanmaku();
            } else {
                const currentId = getCurrentItemId(videoElement);
                if (currentId && currentId !== currentItemIdCache) cleanupDanmaku();
                else {
                    // 借鉴 Jellysleep 方案：DOM 变动时立刻维护 UI，完美替代低效迟钝的 setInterval
                    // 由于 injectDanmakuUI 内部有完善的返回校验机制，不会造成重复挂载或性能问题
                    injectDanmakuUI();
                }
            }
        } else if (!isDanmakuInitializing) {
            // 彻底对齐 jellysleep 触发条件：不区分网页与客户端，也不再依赖脆弱的 video.src 时序。
            // 只要路由在播放页且原生控制栏已挂载，即代表前端组件已完全就绪，此时注入绝对安全！
            const controlsContainer = document.querySelector('.videoOsdBottom .buttons.focuscontainer-x') || document.querySelector('.osdControls .buttons');
            
            if (isVideoPage && controlsContainer) {
                initDanmaku(videoElement);
            }
        }
    });

    // 启动观察器，增加 attributes: true 以便监听 src 属性的后期赋值
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    console.log('[Danmaku Injector] 脚本已加载，正在监听播放器状态...');

})();
