// src/app.js - Version 1.0

require('dotenv').config();
const fastify = require('fastify')({ logger: true });
fastify.register(require('@fastify/compress')); // Nén Gzip để tải JSON nhanh hơn
const path = require('path');
const fs = require('fs');

// --- IMPORT MODULES ---
const { db } = require('./modules/db');
const { scanFolderRecursive, getScanStatus, scanNewFile } = require('./modules/scanner');
const { getSongStream, preloadSong } = require('./modules/streamer');
const { cleanCache } = require('./modules/cacheCleaner');
const { processDownload, getPreviewInfo, getStatus, stopDownload } = require('./modules/downloader-backend');

// --- CẤU HÌNH ---
const PORT = process.env.PORT || 3000;
const CACHE_ROOT = path.join(__dirname, '../cache');
const APP_PIN = process.env.APP_PIN || '123456';

// 1. Đăng ký Plugin Cookie
fastify.register(require('@fastify/cookie'), {
    secret: process.env.COOKIE_SECRET || 'secret-key-must-be-at-least-32-chars-long', 
    parseOptions: {}     
});

// 2. Đăng ký Static (Public) - Cấu hình Header cho PWA
fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, 'public'),
    prefix: '/',
    setHeaders: (res, pathStr) => {
        if (pathStr.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
        if (pathStr.endsWith('manifest.json')) {
             res.setHeader('Content-Type', 'application/manifest+json');
        }
    }
});

// --- BẢO MẬT: RATE LIMIT & LOGIN ---
const failedAttempts = new Map();

function checkRateLimit(ip) {
    const record = failedAttempts.get(ip);
    if (!record) return { allowed: true };
    if (Date.now() < record.nextAllowed) {
        const waitSeconds = Math.ceil((record.nextAllowed - Date.now()) / 1000);
        return { allowed: false, wait: waitSeconds };
    }
    return { allowed: true };
}

function recordFailure(ip) {
    const record = failedAttempts.get(ip) || { count: 0, nextAllowed: 0 };
    record.count += 1;
    const delay = Math.min(Math.pow(2, record.count), 900) * 1000;
    record.nextAllowed = Date.now() + delay;
    failedAttempts.set(ip, record);
    return Math.ceil(delay / 1000);
}

function resetFailure(ip) {
    failedAttempts.delete(ip);
}

fastify.post('/api/login', async (request, reply) => {
    const ip = request.ip;
    const { pin } = request.body;

    const check = checkRateLimit(ip);
    if (!check.allowed) {
        return reply.code(429).send({ error: `Bạn nhập sai quá nhiều lần. Thử lại sau ${check.wait}s.` });
    }

    if (pin === APP_PIN) {
        resetFailure(ip);
        reply.setCookie('auth_token', 'true', {
            path: '/',
            httpOnly: true,
            signed: true,
            maxAge: 365 * 24 * 60 * 60
        });
        return { status: 'success' };
    } else {
        const waitTime = recordFailure(ip);
        const msg = waitTime > 2 ? `PIN sai! Chờ ${waitTime}s.` : 'Mã PIN không đúng.';
        return reply.code(401).send({ error: msg });
    }
});

fastify.get('/api/auth-status', async (request, reply) => {
    const cookie = request.cookies.auth_token;
    if (!cookie) return { authenticated: false };
    const unsigned = request.unsignCookie(cookie);
    return { authenticated: unsigned.valid && unsigned.value === 'true' };
});

// --- HOOK BẢO MẬT TOÀN CỤC ---
fastify.addHook('preHandler', async (request, reply) => {
    const urlpath = request.url.split('?')[0]; 

    let isAuthenticated = false;
    const cookie = request.cookies.auth_token;
    if (cookie) {
        const unsigned = request.unsignCookie(cookie);
        if (unsigned.valid && unsigned.value === 'true') {
            isAuthenticated = true;
        }
    }

    const publicWhitelist = [
        '/', '/index.html', '/index.js', '/style.css', 
        '/favicon.ico', '/icon.png', '/manifest.json', '/sw.js', 
        '/offline-db.js', '/downloader.js',
        '/api/login', '/api/auth-status'
    ];

    if (publicWhitelist.includes(urlpath)) return;

    if (!isAuthenticated) {
        if (urlpath === '/downloader.html') return reply.redirect('/');
        reply.code(401).send({ error: 'Unauthorized: Vui lòng nhập PIN.' });
        return reply; 
    }
});

// ============================================================
// CÁC TÍNH NĂNG CHÍNH
// ============================================================

// 1. Quét nhạc & Cài đặt
fastify.get('/api/scan', async (request, reply) => {
    scanFolderRecursive(process.env.DRIVE_FOLDER_ID).catch(console.error);
    return { status: 'started', message: 'Đã bắt đầu quét ngầm.' };
});

fastify.get('/api/scan/status', async (request, reply) => {
    return getScanStatus();
});

fastify.get('/api/settings', async (request, reply) => {
    const settings = db.prepare('SELECT * FROM user_settings WHERE id = 1').get();
    return settings;
});

fastify.post('/api/settings', async (request, reply) => {
    const { playFromStart, skipMode, skipStart, skipEnd, isShuffle, loopMode, playbackRate } = request.body;
    
    const stmt = db.prepare(`
        UPDATE user_settings 
        SET play_from_start = ?, skip_mode = ?, skip_start = ?, skip_end = ?,
            shuffle_mode = ?, repeat_mode = ?, playback_rate = ?
        WHERE id = 1
    `);
    
    stmt.run(
        playFromStart ? 1 : 0, 
        skipMode ? 1 : 0, 
        parseInt(skipStart) || 0, 
        parseInt(skipEnd) || 0,
        isShuffle ? 1 : 0,
        parseInt(loopMode) || 0,
        parseFloat(playbackRate) || 1.0
    );
    
    return { status: 'saved' };
});

// ============================================================
// DOWNLOADER (TẢI NHẠC/VIDEO)
// ============================================================

fastify.post('/api/preview', async (request, reply) => {
    const { url } = request.body;
    if (!url) return reply.code(400).send({ error: 'Thiếu URL' });

    try {
        const info = await getPreviewInfo(url);
        return { status: 'success', data: info };
    } catch (err) {
        return reply.code(400).send({ error: err.message });
    }
});

fastify.post('/api/download', async (request, reply) => {
    const { url, indices, formatId } = request.body;
    
    const currentStatus = getStatus();
    if (currentStatus.isProcessing) {
        return reply.code(409).send({ error: '⚠️ Hệ thống đang bận tải danh sách khác.' });
    }

    if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
        return reply.code(400).send({ error: 'Link không hợp lệ' });
    }

    processDownload(url, indices || null, formatId || null);
    return { status: 'started', message: 'Đã bắt đầu tiến trình.' };
});

fastify.post('/api/download/stop', async (request, reply) => {
    stopDownload();
    return { status: 'stopping', message: 'Đã gửi lệnh dừng.' };
});

fastify.get('/api/download/status', async (request, reply) => {
    return getStatus();
});

// ============================================================
// QUẢN LÝ BÀI HÁT & CACHE
// ============================================================

// Lấy toàn bộ bài hát (Sắp xếp tự nhiên)
fastify.get('/api/songs', async (request, reply) => {
    const stmt = db.prepare(`SELECT s.*, h.current_time FROM songs s LEFT JOIN playback_history h ON s.id = h.song_id`);
    let songs = stmt.all();

    // Natural Sort (Để "Bài 2" đứng trước "Bài 10")
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    songs.sort((a, b) => {
        const folderA = (a.folder_path || '').trim();
        const folderB = (b.folder_path || '').trim();
        const folderDiff = collator.compare(folderA, folderB);
        if (folderDiff !== 0) return folderDiff;
        return collator.compare(a.name, b.name);
    });

    // Check Cache O(1)
    let cachedSet = new Set();
    try {
        if (fs.existsSync(CACHE_ROOT)) {
            const files = await fs.promises.readdir(CACHE_ROOT);
            files.forEach(f => {
                if (f.endsWith('.mp3')) cachedSet.add(f.replace('.mp3', ''));
            });
        }
    } catch (e) {}

    songs.forEach(s => { s.is_cached = cachedSet.has(s.id); });

    return { total: songs.length, data: songs };
});

// Lấy danh sách ID đã cache (Dùng để update icon realtime)
fastify.get('/api/cache-list', async (request, reply) => {
    try {
        if (!fs.existsSync(CACHE_ROOT)) return [];
        const files = await fs.promises.readdir(CACHE_ROOT);
        return files.filter(f => f.endsWith('.mp3')).map(f => f.replace('.mp3', ''));
    } catch (e) { return []; }
});

// [API] Buộc làm mới Cache & Database (Khi file gốc thay đổi)
fastify.post('/api/cache/refresh', async (request, reply) => {
    const { songId } = request.body;
    if (!songId) return reply.code(400).send({ error: 'Thiếu Song ID' });

    const filePath = path.join(CACHE_ROOT, `${songId}.mp3`);

    try {
        // 1. Xóa file cache cũ
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch(e) {}
            console.log(`🗑️ [Force Refresh] Đã xóa cache file: ${songId}`);
        }

        // 2. Force Update Metadata từ Drive
        console.log(`🔄 Đang đồng bộ lại metadata: ${songId}...`);
        await scanNewFile(songId, true);

        // 3. Kích hoạt tải lại ngầm
        preloadSong(songId); 

        // 4. Trả về thông tin mới nhất để Frontend update UI
        const updatedSong = db.prepare('SELECT * FROM songs WHERE id = ?').get(songId);

        return { 
            status: 'success', 
            message: 'Đã cập nhật thành công.',
            data: updatedSong 
        };
    } catch (err) {
        console.error("Lỗi refresh cache:", err);
        return reply.code(500).send({ error: 'Lỗi hệ thống.' });
    }
});

// ============================================================
// STREAM & PLAYBACK
// ============================================================

fastify.get('/stream/:id', async (request, reply) => {
    try {
        const songId = request.params.id;
        const range = request.headers.range;
        const result = await getSongStream(songId, 0, range);

        if (result.type === 'file') {
            const filePath = path.join(CACHE_ROOT, result.filename);
            const stat = fs.statSync(filePath);
            const fileSize = stat.size;

            reply.header('Content-Type', 'audio/mpeg');
            reply.header('Accept-Ranges', 'bytes');

            if (range) {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunksize = (end - start) + 1;
                const file = fs.createReadStream(filePath, { start, end });
                reply.code(206).header('Content-Range', `bytes ${start}-${end}/${fileSize}`).header('Content-Length', chunksize);
                return reply.send(file);
            } else {
                reply.code(200).header('Content-Length', fileSize);
                return reply.send(fs.createReadStream(filePath));
            }
        } else {
            reply.code(result.status); 
            Object.keys(result.headers).forEach(key => reply.header(key, result.headers[key]));
            return reply.send(result.stream);
        }
    } catch (error) {
        if (error.message === 'FILE_DELETED_ON_DRIVE') return reply.code(404).send({ error: 'File deleted' });
        reply.code(500).send("Stream Error");
    }
});

fastify.get('/api/preload/:id', async (request, reply) => {
    preloadSong(request.params.id);
    return { status: 'preloading' };
});

fastify.post('/api/progress', async (request, reply) => {
    const { songId, currentTime, folder } = request.body;
    const stmt = db.prepare(`INSERT OR REPLACE INTO playback_history (song_id, current_time, context_path, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`);
    stmt.run(songId, currentTime, folder || 'all');
    return { status: 'saved' };
});

fastify.get('/api/last-session', async (request, reply) => {
    const stmt = db.prepare(`SELECT h.song_id, h.current_time, h.context_path, s.* FROM playback_history h JOIN songs s ON h.song_id = s.id ORDER BY h.updated_at DESC LIMIT 1`);
    return stmt.get() || null;
});

fastify.post('/api/favorite/toggle', async (request, reply) => {
    const { songId } = request.body;
    if (!songId) return { status: 'error', message: 'Missing songId' };
    try {
        const current = db.prepare('SELECT is_favorite FROM songs WHERE id = ?').get(songId);
        if (!current) return { status: 'error', message: 'Not found' };

        const newValue = current.is_favorite === 1 ? 0 : 1;
        db.prepare('UPDATE songs SET is_favorite = ? WHERE id = ?').run(newValue, songId);
        return { status: 'success', is_favorite: newValue };
    } catch (e) {
        return { status: 'error', message: 'DB Error' };
    }
});

// ============================================================
// HỆ THỐNG TRENDING & RECENT
// ============================================================

fastify.post('/api/trend/add', async (request, reply) => {
    const { songId } = request.body;
    if (!songId) return;
    const stmt = db.prepare('UPDATE songs SET trending_score = trending_score + 10 WHERE id = ?');
    stmt.run(songId);
    return { status: 'boosted' };
});

fastify.get('/api/songs/top100', async (request, reply) => {
    try {
        const stmt = db.prepare(`SELECT s.*, h.current_time FROM songs s LEFT JOIN playback_history h ON s.id = h.song_id`);
        const allSongs = stmt.all();

        const cacheDir = path.join(__dirname, '../cache');
        let cachedSet = new Set();
        try {
            const files = await fs.promises.readdir(cacheDir);
            files.forEach(f => { if (f.endsWith('.mp3')) cachedSet.add(f.replace('.mp3', '')); });
        } catch (e) {}

        const bucketTrending = [];
        const bucketCached = [];
        const bucketRandom = [];

        allSongs.forEach(song => {
            song.is_cached = cachedSet.has(song.id);
            if (song.trending_score > 0) bucketTrending.push(song);
            else if (song.is_cached) bucketCached.push(song);
            else bucketRandom.push(song);
        });

        bucketTrending.sort((a, b) => b.trending_score - a.trending_score);
        for (let i = bucketRandom.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [bucketRandom[i], bucketRandom[j]] = [bucketRandom[j], bucketRandom[i]];
        }

        const finalTop100 = [...bucketTrending, ...bucketCached, ...bucketRandom].slice(0, 100);
        return finalTop100;
    } catch (e) {
        console.error("Top 100 Error:", e);
        return [];
    }
});

// [MỚI] API lấy 100 bài hát mới tải gần nhất
fastify.get('/api/songs/recent', async (request, reply) => {
    try {
        const stmt = db.prepare(`
            SELECT s.*, h.current_time 
            FROM songs s 
            LEFT JOIN playback_history h ON s.id = h.song_id 
            ORDER BY s.created_at DESC 
            LIMIT 100
        `);
        const recentSongs = stmt.all();
        
        let cachedSet = new Set();
        try {
            if (fs.existsSync(CACHE_ROOT)) {
                const files = await fs.promises.readdir(CACHE_ROOT);
                files.forEach(f => { if (f.endsWith('.mp3')) cachedSet.add(f.replace('.mp3', '')); });
            }
        } catch (e) {}

        recentSongs.forEach(song => { song.is_cached = cachedSet.has(song.id); });
        return recentSongs;
    } catch (e) {
        console.error("Recent Songs Error:", e);
        return [];
    }
});

// Tác vụ nền: Dọn cache và Giảm điểm nhiệt
setInterval(cleanCache, 12 * 60 * 60 * 1000); // 12h
cleanCache();

setInterval(() => {
    // Mỗi 24h giảm 10% điểm nhiệt
    console.log('📉 [Trending] Decay started...');
    db.prepare("UPDATE songs SET trending_score = trending_score * 0.9 WHERE trending_score > 0.1").run();
}, 24 * 60 * 60 * 1000);

// Start Server
const start = async () => {
    try { 
        await fastify.listen({ port: PORT, host: '0.0.0.0' }); 
        console.log(`🚀 Server đang chạy tại: http://localhost:${PORT}`); 
    } catch (err) { 
        fastify.log.error(err); 
        process.exit(1); 
    }
};
start();