/* =========================================================
   Service Worker · 考研西医综合 306
   缓存策略
     · App Shell          → 安装时预缓存 + 导航网络优先
     · data/*.json        → 网络优先，离线回退缓存（忽略 ?t= 时间戳）
     · CDN（jsDelivr…）   → 缓存优先（内容带版本号，可长期缓存）
     · 图片               → 缓存优先
     · GitHub / AI API    → 直通不缓存（含鉴权、实时性要求高）
   ========================================================= */
"use strict";

const SW_VERSION   = "1.0.2";
const CACHE_PREFIX = "kaoyan306";

const STATIC_CACHE = `${CACHE_PREFIX}-static-${SW_VERSION}`;
const DATA_CACHE   = `${CACHE_PREFIX}-data-${SW_VERSION}`;
const CDN_CACHE    = `${CACHE_PREFIX}-cdn-${SW_VERSION}`;
const IMAGE_CACHE  = `${CACHE_PREFIX}-image-${SW_VERSION}`;

const CURRENT_CACHES = [STATIC_CACHE, DATA_CACHE, CDN_CACHE, IMAGE_CACHE];

/* 安装时预缓存的应用外壳（相对 sw.js 所在目录） */
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon.svg",
  "./icons/icon-maskable.svg",
];

/* 直通不缓存的域名：API / 鉴权 / 实时性要求高 */
const PASSTHROUGH_HOSTS = new Set([
  "api.github.com",
  "uploads.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "generativelanguage.googleapis.com",
  "openrouter.ai",
  "open.bigmodel.cn",
  "api.groq.com",
  "api.siliconflow.cn",
  "api-inference.modelscope.cn",
  "api.deepseek.com",
  "api.moonshot.cn",
  "dashscope.aliyuncs.com",
  "api.openai.com",
  "opencode.ai"
]);

/* 可长缓存的静态 CDN */
const CDN_HOSTS = new Set([
  "cdn.jsdelivr.net",
  "fastly.jsdelivr.net",
  "gcore.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
]);

/* =========================================================
   install：预缓存 App Shell
   ========================================================= */
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await Promise.all(
      APP_SHELL.map(async (url) => {
        try {
          await cache.add(new Request(url, { cache: "reload" }));
        } catch (err) {
          // 单个资源缺失（例如还没放图标）不影响整体安装
          console.warn("[SW] 预缓存失败：", url, err && err.message);
        }
      })
    );
    // 立即接管，不等待旧页面关闭
    await self.skipWaiting();
  })());
});

/* =========================================================
   activate：清理旧版本缓存 + 启用导航预加载
   ========================================================= */
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(CACHE_PREFIX) && !CURRENT_CACHES.includes(k))
        .map((k) => caches.delete(k))
    );

    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (e) { /* 忽略 */ }
    }

    await self.clients.claim();
  })());
});

/* =========================================================
   fetch：路由分发
   ========================================================= */
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // 只处理 GET
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  const sameOrigin = url.origin === self.location.origin;

  // 1) 导航请求
  if (req.mode === "navigate") {
    event.respondWith(handleNavigate(req, event));
    return;
  }

  // 2) sw.js 自身不拦截（避免影响更新检查）
  if (sameOrigin && /\/sw\.js$/i.test(url.pathname)) return;

  // 3) 鉴权 / 实时 API 直通
  if (PASSTHROUGH_HOSTS.has(url.hostname)) return;

  // 4) 本地推理服务（Ollama / LM Studio）直通
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "0.0.0.0") return;

  // 5) 同源 data/*.json → 网络优先（离线回退缓存）
  if (sameOrigin && /\/data\/[^/]*\.json$/i.test(url.pathname)) {
    event.respondWith(dataNetworkFirst(req, url));
    return;
  }

  // 6) 已知 CDN → 缓存优先
  if (CDN_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }

  // 7) 图片 → 缓存优先
  if (req.destination === "image") {
    event.respondWith(cacheFirst(req, IMAGE_CACHE));
    return;
  }

  // 8) 其余同源静态资源 → 缓存优先 + 后台刷新
  if (sameOrigin) {
    event.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
    return;
  }

  // 9) 其他跨域请求直通
});

/* =========================================================
   策略实现
   ========================================================= */

/* 导航：网络优先，离线回退缓存的 index.html */
async function handleNavigate(request, event) {
  try {
    const preload = event.preloadResponse ? await event.preloadResponse : null;
    if (preload && preload.ok) {
      const copy = preload.clone();
      caches.open(STATIC_CACHE)
        .then((c) => c.put("./index.html", copy))
        .catch(() => {});
      return preload;
    }

    const resp = await fetch(request);
    if (resp && resp.ok) {
      const copy = resp.clone();
      caches.open(STATIC_CACHE)
        .then((c) => c.put("./index.html", copy))
        .catch(() => {});
    }
    return resp;
  } catch (err) {
    const cache = await caches.open(STATIC_CACHE);
    const hit = (await cache.match("./index.html")) || (await cache.match("./"));
    if (hit) return hit;
    return new Response("离线中，且没有可用的缓存页面。", {
      status: 503,
      statusText: "Offline",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

/* 数据文件：网络优先，忽略 ?t= 缓存参数 */
async function dataNetworkFirst(request, url) {
  const cache = await caches.open(DATA_CACHE);
  const key = url.origin + url.pathname;   // 去掉 ?t=timestamp

  try {
    const resp = await fetch(request);
    if (resp && resp.ok) {
      cache.put(key, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    return new Response(
      JSON.stringify({ __offline: true, error: "offline" }),
      {
        status: 503,
        statusText: "Offline",
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }
    );
  }
}

/* 缓存优先：命中即返回，否则请求并缓存 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;

  try {
    const resp = await fetch(request);
    if (resp && resp.ok) {
      cache.put(request, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (err) {
    const fallback = await cache.match(request, { ignoreSearch: true });
    if (fallback) return fallback;
    return new Response("", { status: 504, statusText: "Gateway Timeout" });
  }
}

/* 缓存优先 + 后台刷新（同源静态资源） */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);

  const networkPromise = fetch(request)
    .then((resp) => {
      if (resp && resp.ok) {
        cache.put(request, resp.clone()).catch(() => {});
      }
      return resp;
    })
    .catch(() => null);

  if (hit) return hit;

  const resp = await networkPromise;
  if (resp) return resp;

  return new Response("", { status: 504, statusText: "Gateway Timeout" });
}

/* =========================================================
   消息通道（可选：由页面主动控制）
   ========================================================= */
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (data.type === "CLEAR_CACHES") {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k))
      );
      const clients = await self.clients.matchAll();
      clients.forEach((c) => c.postMessage({ type: "CACHES_CLEARED" }));
    })());
  }
});
