// src/public/sw.js
const CACHE_NAME = 'music-app-shell-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/index.js',
  '/downloader.js',
  '/offline-db.js', // File mới sẽ tạo ở bước 2
  '/favicon.ico',
  '/icon.png' // Icon
];

// 1. Install: Cache toàn bộ file giao diện
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching App Shell');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// 2. Activate: Xóa cache cũ nếu update version mới
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(keyList.map((key) => {
        if (key !== CACHE_NAME) return caches.delete(key);
      }));
    })
  );
  self.clients.claim();
});

// 3. Fetch: Chặn request mạng
self.addEventListener('fetch', (event) => {
  // KHÔNG cache các API động và luồng stream nhạc ở đây
  // Việc lưu nhạc sẽ do IndexedDB lo
  if (event.request.url.includes('/api/') || event.request.url.includes('/stream/')) {
    return; // Để mặc định (Network only)
  }

  // Với các file tĩnh (HTML, CSS...), ưu tiên lấy từ Cache
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});