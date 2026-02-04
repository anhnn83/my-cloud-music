// src/app.js - Version 6.5

require('dotenv').config();
const fastify = require('fastify')({ logger: true });
fastify.register(require('@fastify/compress'));
const path = require('path');
const fs = require('fs');

// Import modules
const { db } = require('./modules/db');
const { scanFolderRecursive, getScanStatus, scanNewFile } = require('./modules/scanner');
const { getSongStream, preloadSong } = require('./modules/streamer');
const { cleanCache } = require('./modules/cacheCleaner');
const { processDownload, getPreviewInfo, getStatus, stopDownload } = require('./modules/downloader-backend');

const PORT = process.env.PORT || 3000;
const ROOT_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const CACHE_ROOT = path.join(__dirname, '../cache');
const APP_PIN = process.env.APP_PIN || '123456';

// 1. Đăng ký Plugin Cookie
fastify.register(require('@fastify/cookie'), {
    secret: process.env.COOKIE_SECRET || 'secret-key-must-be-at-least-32-chars-long', 
    parseOptions: {}     
});

// 2. Đăng ký Static (Public) - Có cấu hình Header cho SW
fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, 'public'),
    prefix: '/',
    setHeaders: (res, pathStr) => {
        // Nếu là file service worker -> Không cache
        if (pathStr.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
        // Nếu là file manifest -> Set đúng Content-Type
        if (pathStr.endsWith('manifest.json')) {
             res.setHeader('Content-Type', 'application/manifest+json');
        }
    }
});

// --- BẢO MẬT: BRUTE FORCE PROTECTION ---
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

// --- API LOGIN ---
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
            maxAge: 30 * 24 * 60 * 60 
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

// --- HOOK BẢO MẬT ---
// --- GLOBAL HOOK: BẢO VỆ TOÀN DIỆN ---
fastify.addHook('preHandler', async (request, reply) => {
    const urlpath = request.url.split('?')[0]; // Lấy đường dẫn không kèm query

    // 1. KIỂM TRA TRẠNG THÁI ĐĂNG NHẬP (COOKIE)
    let isAuthenticated = false;
    const cookie = request.cookies.auth_token;
    if (cookie) {
        const unsigned = request.unsignCookie(cookie);
        if (unsigned.valid && unsigned.value === 'true') {
            isAuthenticated = true;
        }
    }

    // 2. DANH SÁCH "VÙNG XANH" (Được phép truy cập khi chưa login)
    // Bao gồm trang chủ (để hiện login form), file style, và API login
    const publicWhitelist = [
        '/',                // Trang chủ
        '/index.html',      // File HTML chính
        '/index.js',        // Script chính (chứa logic login)
        '/style.css',       // Giao diện
        '/favicon.ico',     // Icon
        '/api/login',       // API gửi PIN
        '/api/auth-status'  // API check trạng thái
    ];

    // Nếu đường dẫn nằm trong Whitelist -> Cho qua luôn
    if (publicWhitelist.includes(urlpath)) {
        return;
    }

    // 3. CÁC VÙNG CẦN BẢO VỆ (VÙNG ĐỎ)
    // Nếu KHÔNG phải vùng xanh, và chưa đăng nhập -> Chặn
    if (!isAuthenticated) {
        // Trường hợp đặc biệt: Nếu người dùng cố vào downloader.html bằng link trực tiếp
        // -> Chuyển hướng (Redirect) về trang chủ để bắt nhập PIN
        if (path === '/downloader.html' || urlpath === '/downloader.js') {
            return reply.redirect('/');
        }

        // Với các API hoặc Stream -> Trả về lỗi 401
        reply.code(401).send({ error: 'Unauthorized: Vui lòng nhập PIN.' });
        return reply; // Dừng request
    }

    // Nếu đã đăng nhập -> Cho phép đi tiếp (vào Downloader, Stream, API...)
});

// --- CÁC API CHÍNH ---

// 1. Quét nhạc
fastify.get('/api/scan', async (request, reply) => {
    // Gọi hàm chạy ngầm, không await để trả về response ngay
    scanFolderRecursive(process.env.DRIVE_FOLDER_ID).catch(console.error);
    return { status: 'started', message: 'Đã bắt đầu quét. Hãy xem Console (F12) để theo dõi.' };
});

// [MỚI] API để Frontend lấy Logs Scan
fastify.get('/api/scan/status', async (request, reply) => {
    return getScanStatus();
});

// [MỚI] API Lấy cài đặt playback
fastify.get('/api/settings', async (request, reply) => {
    const settings = db.prepare('SELECT * FROM user_settings WHERE id = 1').get();
    return settings;
});

// [CẬP NHẬT] API Lưu cài đặt playback (Bao gồm cả Shuffle/Repeat)
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

// [MỚI] API Lấy thông tin trước khi tải (Preview)
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

// 2. [MỚI] API Tải nhạc từ YouTube
fastify.post('/api/download', async (request, reply) => {
    // Lấy thêm formatId
    const { url, indices, formatId } = request.body;
    
    const currentStatus = getStatus();
    if (currentStatus.isProcessing) {
        return reply.code(409).send({ error: '⚠️ Hệ thống đang bận tải một danh sách khác.' });
    }

    if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
        return reply.code(400).send({ error: 'Link không hợp lệ' });
    }

    // Truyền formatId vào hàm xử lý
    processDownload(url, indices || null, formatId || null);

    return { status: 'started', message: 'Đã bắt đầu tiến trình.' };
});

// [MỚI] API Dừng tải
fastify.post('/api/download/stop', async (request, reply) => {
    stopDownload();
    return { status: 'stopping', message: 'Đã gửi lệnh dừng.' };
});

// [MỚI] API Lấy trạng thái tiến độ (Frontend sẽ gọi mỗi 1s)
fastify.get('/api/download/status', async (request, reply) => {
    return getStatus();
});

//======================================================================
// 3. Lấy danh sách bài hát
// fastify.get('/api/songs', async (request, reply) => {
//     const stmt = db.prepare(`SELECT s.*, h.current_time FROM songs s LEFT JOIN playback_history h ON s.id = h.song_id ORDER BY s.folder_path, s.name`);
//     const songs = stmt.all();

//     // Lấy danh sách cache 1 lần duy nhất
//     let cachedSet = new Set();
//     try {
//         if (fs.existsSync(CACHE_ROOT)) {
//             const files = await fs.promises.readdir(CACHE_ROOT);
//             files.forEach(f => {
//                 if (f.endsWith('.mp3')) cachedSet.add(f.replace('.mp3', ''));
//             });
//         }
//     } catch (e) {}

//     // Map dữ liệu (tốc độ cực nhanh vì chỉ check Set trong RAM)
//     songs.forEach(s => {
//         s.is_cached = cachedSet.has(s.id);
//     });

//     return { total: songs.length, data: songs };
// });
//======================================================================

// 3. Lấy danh sách bài hát (Đã nâng cấp Natural Sort)
fastify.get('/api/songs', async (request, reply) => {
    // 1. Lấy dữ liệu thô (Bỏ ORDER BY trong SQL để JS xử lý)
    const stmt = db.prepare(`SELECT s.*, h.current_time FROM songs s LEFT JOIN playback_history h ON s.id = h.song_id`);
    let songs = stmt.all();

    // 2. Sắp xếp thông minh (Natural Sort: 1 -> 2 -> 10)
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    
    songs.sort((a, b) => {
        // Ưu tiên xếp theo Folder trước
        const folderA = (a.folder_path || '').trim();
        const folderB = (b.folder_path || '').trim();
        const folderDiff = collator.compare(folderA, folderB);
        
        if (folderDiff !== 0) return folderDiff;
        
        // Nếu cùng Folder thì xếp theo Tên bài hát
        return collator.compare(a.name, b.name);
    });

    // 3. Lấy danh sách cache 1 lần duy nhất (Giữ nguyên logic cũ của bạn)
    let cachedSet = new Set();
    try {
        if (fs.existsSync(CACHE_ROOT)) {
            const files = await fs.promises.readdir(CACHE_ROOT);
            files.forEach(f => {
                if (f.endsWith('.mp3')) cachedSet.add(f.replace('.mp3', ''));
            });
        }
    } catch (e) {}

    // Map dữ liệu
    songs.forEach(s => {
        s.is_cached = cachedSet.has(s.id);
    });

    return { total: songs.length, data: songs };
});


// [MỚI] API Lấy danh sách ID các file đã được cache
fastify.get('/api/cache-list', async (request, reply) => {
    try {
        if (!fs.existsSync(CACHE_ROOT)) return [];
        // Đọc thư mục cache
        const files = await fs.promises.readdir(CACHE_ROOT);
        // Chỉ lấy tên file (bỏ đuôi .mp3) -> chính là Song ID
        const cachedIds = files
            .filter(f => f.endsWith('.mp3'))
            .map(f => f.replace('.mp3', ''));
        return cachedIds;
    } catch (e) {
        return [];
    }
});

// [MỚI] API Buộc làm mới Cache (Xóa file cũ -> Tải lại từ Drive)
fastify.post('/api/cache/refresh', async (request, reply) => {
    const { songId } = request.body;
    if (!songId) return reply.code(400).send({ error: 'Thiếu Song ID' });

    const filePath = path.join(CACHE_ROOT, `${songId}.mp3`);

    try {
        // 1. Xóa file cache cũ trên ổ cứng (Bắt buộc)
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch(e) {}
            console.log(`🗑️ [Force Refresh] Đã xóa cache file: ${songId}`);
        }

        // 2. [QUAN TRỌNG] Cập nhật lại thông tin trong Database từ Drive
        // Gọi với tham số true để Force Update (bỏ qua cache DB cũ)
        console.log(`🔄 Đang đồng bộ lại metadata từ Drive cho bài hát: ${songId}...`);
        await scanNewFile(songId, true);

        // 3. Kích hoạt tải file mới về cache (Chạy ngầm)
        preloadSong(songId); 

        return { 
            status: 'success', 
            message: 'Đã xóa cache cũ, cập nhật DB và đang tải bản mới.' 
        };
    } catch (err) {
        console.error("Lỗi refresh cache:", err);
        return reply.code(500).send({ error: 'Lỗi hệ thống khi làm mới.' });
    }
});

// 4. Stream nhạc (Manual Stream)
fastify.get('/stream/:id', async (request, reply) => {
    try {
        const songId = request.params.id;
        const range = request.headers.range;
        const result = await getSongStream(songId);

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
            reply.header('Accept-Ranges', 'bytes');
            return reply.send(result.stream);
        }
    } catch (error) {
        if (error.message === 'FILE_DELETED_ON_DRIVE') return reply.code(404).send({ error: 'File deleted' });
        reply.code(500).send("Stream Error");
    }
});

// 5. Preload & Progress
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
        // Cách 1: Logic an toàn hơn (Tách 2 lệnh để tránh lỗi cú pháp SQL lạ)
        const current = db.prepare('SELECT is_favorite FROM songs WHERE id = ?').get(songId);
        
        if (!current) {
            return { status: 'error', message: 'Bài hát chưa có trong Database (Hãy Scan lại)' };
        }

        const newValue = current.is_favorite === 1 ? 0 : 1;
        db.prepare('UPDATE songs SET is_favorite = ? WHERE id = ?').run(newValue, songId);

        return { status: 'success', is_favorite: newValue };
    } catch (e) {
        console.error("Favorite Error:", e);
        return { status: 'error', message: 'DB Error' };
    }
});

setInterval(cleanCache, 12 * 60 * 60 * 1000);
cleanCache();

// --- [MỚI] HỆ THỐNG ĐIỂM NHIỆT (TRENDING SYSTEM) ---
// 1. API Cộng điểm (Gọi khi nghe hết bài)
fastify.post('/api/trend/add', async (request, reply) => {
    const { songId } = request.body;
    if (!songId) return;

    // Cộng 10 điểm cho bài hát
    const stmt = db.prepare('UPDATE songs SET trending_score = trending_score + 10 WHERE id = ?');
    stmt.run(songId);
    
    return { status: 'boosted' };
});

// 2. API Lấy Top 100 Trending
fastify.get('/api/songs/top100', async (request, reply) => {
    try {
        // 1. Lấy toàn bộ bài hát từ DB
        const stmt = db.prepare(`
            SELECT s.*, h.current_time 
            FROM songs s 
            LEFT JOIN playback_history h ON s.id = h.song_id 
        `);
        const allSongs = stmt.all();

        // 2. Lấy danh sách các file đang có trong Cache
        const cacheDir = path.join(__dirname, '../cache');
        let cachedSet = new Set();
        try {
            // Đọc thư mục cache 1 lần duy nhất (nhanh hơn check từng file)
            const files = await fs.promises.readdir(cacheDir);
            files.forEach(f => {
                if (f.endsWith('.mp3')) cachedSet.add(f.replace('.mp3', ''));
            });
        } catch (e) { console.error("Cache read error:", e); }

        // 3. Phân loại vào 3 giỏ ưu tiên
        const bucketTrending = [];
        const bucketCached = [];
        const bucketRandom = [];

        allSongs.forEach(song => {
            // Đánh dấu cache để Frontend hiển thị icon lun
            song.is_cached = cachedSet.has(song.id);

            if (song.trending_score > 0) {
                // Ưu tiên 1: Có điểm nhiệt
                bucketTrending.push(song);
            } else if (song.is_cached) {
                // Ưu tiên 2: Chưa có điểm nhưng đã Cache (để nghe offline)
                bucketCached.push(song);
            } else {
                // Ưu tiên 3: Còn lại
                bucketRandom.push(song);
            }
        });

        // 4. Sắp xếp nội bộ từng giỏ
        
        // Giỏ 1: Điểm cao xếp trước
        bucketTrending.sort((a, b) => b.trending_score - a.trending_score);
        
        // Giỏ 2: Không cần sort (hoặc sort theo tên nếu muốn)
        
        // Giỏ 3: Trộn ngẫu nhiên (Shuffle) để mỗi lần vào Top 100 thấy mới lạ
        for (let i = bucketRandom.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [bucketRandom[i], bucketRandom[j]] = [bucketRandom[j], bucketRandom[i]];
        }

        // 5. Gộp lại và cắt lấy 100 bài
        const finalTop100 = [...bucketTrending, ...bucketCached, ...bucketRandom].slice(0, 100);

        return finalTop100;
        
    } catch (e) {
        console.error("Top 100 Error:", e);
        return [];
    }
});

// [MỚI] API Lấy Top 100 Mới tải (Sắp xếp theo created_at giảm dần)
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
        
        // Vẫn check cache như logic cũ để hiển thị icon
        const cacheDir = path.join(__dirname, '../cache');
        let cachedSet = new Set();
        try {
            if (fs.existsSync(cacheDir)) {
                const files = await fs.promises.readdir(cacheDir);
                files.forEach(f => {
                    if (f.endsWith('.mp3')) cachedSet.add(f.replace('.mp3', ''));
                });
            }
        } catch (e) {}

        recentSongs.forEach(song => {
            song.is_cached = cachedSet.has(song.id);
        });

        return recentSongs;
    } catch (e) {
        console.error("Recent Songs Error:", e);
        return [];
    }
});

// 3. Cơ chế "Hạ nhiệt" (Decay) - Chạy mỗi 24 giờ
// Giảm 10% điểm của tất cả bài hát để các bài cũ từ từ rớt hạng
setInterval(() => {
    console.log('📉 [Trending] Đang hạ nhiệt điểm số bài hát (-10%)...');
    // Chỉ giảm những bài đang có điểm > 0.1 để tránh số quá nhỏ vô nghĩa
    db.prepare("UPDATE songs SET trending_score = trending_score * 0.9 WHERE trending_score > 0.1").run();
}, 24 * 60 * 60 * 1000); // 24 giờ

const start = async () => {
    try { await fastify.listen({ port: PORT, host: '0.0.0.0' }); console.log(`🚀 Server: http://localhost:${PORT}`); }
    catch (err) { fastify.log.error(err); process.exit(1); }
};
start();