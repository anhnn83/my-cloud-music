// src/public/sw.js
const CACHE_NAME = 'music-app-shell-v3'; // Tăng lên v3 để reset lại bộ đệm
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/index.js',
  '/downloader.js',
  '/offline-db.js', 
  '/favicon.ico',
  '/icon.png',
  '/manifest.json'
];

// 1. Install: Cache toàn bộ file giao diện
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching App Shell v3');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// 2. Activate: Xóa cache cũ
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(keyList.map((key) => {
        if (key !== CACHE_NAME) {
            console.log('[SW] Đang xóa cache cũ:', key);
            return caches.delete(key);
        }
      }));
    })
  );
  self.clients.claim();
});

// 3. Fetch: Áp dụng Stale-While-Revalidate
self.addEventListener('fetch', (event) => {
  // [VÁ LỖI 1] BỎ QUA NGAY LẬP TỨC các request từ Chrome Extension (chỉ lấy http/https)
  if (!event.request.url.startsWith('http')) {
    return;
  }

  // Bỏ qua các API động và luồng stream nhạc
  if (event.request.url.includes('/api/') || event.request.url.includes('/stream/')) {
    return; 
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        // Chỉ lưu Cache nếu fetch thành công VÀ là file của chính trang web (type === 'basic')
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch((err) => {
        // [VÁ LỖI 2] Nuốt trôi lỗi khi rớt mạng hoặc bị Adblock chặn Cloudflare
        console.log('[SW] Yêu cầu bị chặn hoặc Offline:', event.request.url);
        
        // Nếu file này không có sẵn trong Cache, trả về Response.error() ảo thay vì throw gây đỏ console
        if (!cachedResponse) {
            return Response.error(); 
        }
      });

      return cachedResponse || fetchPromise;
    })
  );
});