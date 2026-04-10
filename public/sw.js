const CACHE = 'wildlife-v2';
const STATIC = [
  '/',
  '/style.css',
  '/app.js',
  '/wildlife.png',
];

// 安裝：快取靜態資源
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

// 啟動：清除舊快取
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 攔截請求：API 走網路優先，靜態資源快取優先
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API 和認證路由永遠走網路
  if (url.pathname.startsWith('/api') ||
      url.pathname.startsWith('/auth') ||
      url.pathname.startsWith('/admin') ||
      url.pathname.startsWith('/uploads')) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
