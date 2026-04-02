// src/public/sw.js
const CACHE_NAME = 'music-app-shell-v2.1';
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
        // [VÁ LỖI 1] Phải CLONE dữ liệu ngay lập tức trước khi mở Cache (bất đồng bộ)
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone(); // <--- Clone ở đây
          
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch((err) => {
        // [VÁ LỖI 2] Bắt lỗi khi rớt mạng hoặc bị Adblock chặn (Cloudflare)
        console.log('[SW] Không thể fetch (Offline hoặc bị block):', event.request.url);
        
        // Nếu trong Cache KHÔNG CÓ file này, bắt buộc phải throw error để trình duyệt không bị lỗi "Failed to convert"
        if (!cachedResponse) {
            throw err; 
        }
      });

      // Trả về file từ Cache ngay lập tức để app khởi động nhanh.
      // Nếu Cache chưa có (lần đầu), mới đợi fetchPromise từ mạng.
      return cachedResponse || fetchPromise;
    })
  );
});