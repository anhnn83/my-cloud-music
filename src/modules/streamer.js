// src/modules/streamer.js - Final Stable Version

const fs = require('fs');
const path = require('path');
const drive = require('./drive');
const { db } = require('./db');

const CACHE_DIR = path.join(__dirname, '../../cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

const deleteSong = db.prepare('DELETE FROM songs WHERE id = ?');

function isValidMp3Header(filePath) {
    try {
        const buffer = Buffer.alloc(4);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buffer, 0, 4, 0);
        fs.closeSync(fd);
        if (buffer.toString('utf8', 0, 3) === 'ID3') return true;
        if (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) return true;
        return false;
    } catch (e) { return false; }
}

// ---------------------------------------------------------
// [MỚI] Ổ KHÓA TIẾN TRÌNH: Tránh tải trùng lặp khi trình duyệt spam Request
const activeDownloads = new Map();

async function downloadInBackground(songId, expectedSize) {
    const filePath = path.join(CACHE_DIR, `${songId}.mp3`);
    const tempPath = path.join(CACHE_DIR, `${songId}.temp`);

    // Nếu file đã cache xong, hoặc đang trong quá trình tải ngầm -> Không làm gì cả
    if (fs.existsSync(filePath) || activeDownloads.has(songId)) return;

    // Đánh dấu là đang tải
    activeDownloads.set(songId, true);

    try {
        const dest = fs.createWriteStream(tempPath);
        const res = await drive.files.get(
            { fileId: songId, alt: 'media', supportsAllDrives: true }, 
            { responseType: 'stream', headers: { 'Accept-Encoding': 'identity' } }
        );
        
        res.data.pipe(dest);

        dest.on('finish', () => {
            activeDownloads.delete(songId); // Mở khóa
            try {
                const stat = fs.statSync(tempPath);
                if (expectedSize && stat.size < expectedSize * 0.9) {
                    fs.unlinkSync(tempPath);
                } else {
                    fs.renameSync(tempPath, filePath);
                    console.log(`✅ [Cache] Tải ngầm thành công: ${songId}.mp3`);
                }
            } catch(e) {}
        });

        dest.on('error', () => {
            activeDownloads.delete(songId);
            if(fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        });

        res.data.on('error', () => {
            dest.end();
            activeDownloads.delete(songId);
            if(fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        });

    } catch (err) {
        activeDownloads.delete(songId);
    }
}
// ---------------------------------------------------------

async function getSongStream(songId, rangeHeader = null, retryCount = 0) {
    const filename = `${songId}.mp3`;
    const filePath = path.join(CACHE_DIR, filename);

    // CASE 1: ĐÃ CÓ FILE CACHE
    if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.size < 10240 || !isValidMp3Header(filePath)) {
            console.log(`🗑️ File lỗi cache: ${songId}. Retry: ${retryCount}`);
            if (retryCount >= 1) {
                try { fs.unlinkSync(filePath); } catch(e){}
                throw new Error('CORRUPT_FILE_ON_DRIVE');
            }
            try { fs.unlinkSync(filePath); } catch(e){}
            return getSongStream(songId, rangeHeader, retryCount + 1); 
        }
        return { type: 'file', filename: filename };
    }

    // CASE 2: CHƯA CACHE -> STREAM TRỰC TIẾP & TẢI NGẦM ĐỘC LẬP
    else {
        try {
            const meta = await drive.files.get({ fileId: songId, fields: 'size, trashed', supportsAllDrives: true });
            if (meta.data.trashed) { deleteSong.run(songId); throw new Error('FILE_DELETED_ON_DRIVE'); }
            
            const fileSize = meta.data.size ? parseInt(meta.data.size) : null;
            
            // Kích hoạt tiến trình tải ngầm (sẽ không bị gọi đúp nhờ activeDownloads)
            downloadInBackground(songId, fileSize);

            // Stream riêng biệt trả thẳng về cho trình duyệt
            const driveHeaders = { 'Accept-Encoding': 'identity' };
            if (rangeHeader) {
                driveHeaders['Range'] = rangeHeader;
            }

            const res = await drive.files.get(
                { fileId: songId, alt: 'media', supportsAllDrives: true },
                { responseType: 'stream', headers: driveHeaders }
            );

            return {
                type: 'stream',
                stream: res.data,
                headers: {
                    'Content-Type': 'audio/mpeg',
                    'Content-Length': res.headers['content-length'] || fileSize,
                    'Content-Range': res.headers['content-range'],
                    'Accept-Ranges': 'bytes'
                },
                status: res.status
            };

        } catch (error) {
            console.error(`❌ Stream Error ${songId}:`, error.message);
            if (error.code === 404 || (error.response && error.response.status === 404)) {
                deleteSong.run(songId); 
                throw new Error('FILE_DELETED_ON_DRIVE');
            }
            throw error;
        }
    }
}

async function preloadSong(songId) {
    const filePath = path.join(CACHE_DIR, `${songId}.mp3`);
    if (fs.existsSync(filePath)) return; 
    try {
        const meta = await drive.files.get({ fileId: songId, fields: 'size, trashed', supportsAllDrives: true });
        if (meta.data.trashed) return;
        downloadInBackground(songId, meta.data.size);
    } catch (e) {}
}

module.exports = { getSongStream, preloadSong };