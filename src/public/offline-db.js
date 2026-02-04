// src/public/offline-db.js

const DB_NAME = 'MyMusicDB';
const DB_VERSION = 1;
const STORE_SONGS = 'songs';   // Lưu file nhạc (Blob)
const STORE_META = 'metadata'; // Lưu danh sách bài hát (JSON) để hiển thị offline

const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
        const db = event.target.result;
        // Tạo bảng lưu nhạc (key là songId)
        if (!db.objectStoreNames.contains(STORE_SONGS)) {
            db.createObjectStore(STORE_SONGS);
        }
        // Tạo bảng lưu thông tin bài hát (key là 'all_songs')
        if (!db.objectStoreNames.contains(STORE_META)) {
            db.createObjectStore(STORE_META);
        }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
});

const OfflineDB = {
    // 1. Lưu file nhạc
    async saveSong(songId, blob) {
        const db = await dbPromise;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_SONGS, 'readwrite');
            tx.objectStore(STORE_SONGS).put(blob, songId);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    // 2. Lấy file nhạc để phát
    async getSong(songId) {
        const db = await dbPromise;
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_SONGS, 'readonly');
            const req = tx.objectStore(STORE_SONGS).get(songId);
            req.onsuccess = () => resolve(req.result); // Trả về Blob hoặc undefined
            req.onerror = () => resolve(null);
        });
    },

    // 3. Xóa file nhạc
    async deleteSong(songId) {
        const db = await dbPromise;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_SONGS, 'readwrite');
            tx.objectStore(STORE_SONGS).delete(songId);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    // 4. Kiểm tra bài hát đã tải chưa (trả về true/false)
    async isDownloaded(songId) {
        const item = await this.getSong(songId);
        return !!item;
    },

    // 5. Lưu danh sách bài hát (Metadata) để load khi offline
    async saveMetadata(songs) {
        const db = await dbPromise;
        const tx = db.transaction(STORE_META, 'readwrite');
        tx.objectStore(STORE_META).put(songs, 'all_songs');
    },

    // 6. Lấy danh sách bài hát khi offline
    async getMetadata() {
        const db = await dbPromise;
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_META, 'readonly');
            const req = tx.objectStore(STORE_META).get('all_songs');
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
    }
};