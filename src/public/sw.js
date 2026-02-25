// src/public/sw.js
const CACHE_NAME = 'music-app-shell-v2'; // Tăng lên v2 để ép trình duyệt xóa bản lỗi cũ
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/index.js',
  '/downloader.js',
  '/offline-db.js', 
  '/favicon.ico',
  '/icon.png',
  '/manifest.json' // [MỚI] Bổ sung manifest để PWA chạy mượt offline
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
  // KHÔNG cache các API động và luồng stream nhạc
  if (event.request.url.includes('/api/') || event.request.url.includes('/stream/')) {
    return; 
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // Ngầm gọi server tải bản cập nhật mới (nếu có mạng)
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        // Cập nhật lại file mới vào cache để dùng cho lần mở app sau
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, networkResponse.clone());
          });
        }
        return networkResponse;
      }).catch(() => {
        // Bỏ qua lỗi ngầm nếu đang offline
        console.log('[SW] Đang chạy chế độ Offline hoàn toàn cho', event.request.url);
      });

      // Trả về file từ Cache ngay lập tức để app khởi động nhanh.
      // Nếu Cache chưa có (lần đầu), mới đợi fetchPromise từ mạng.
      return cachedResponse || fetchPromise;
    })
  );
});