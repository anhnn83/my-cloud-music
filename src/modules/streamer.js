// src/modules/streamer.js - Version 5.3

const fs = require('fs');
const path = require('path');
const drive = require('./drive');
const { db } = require('./db');

const CACHE_DIR = path.join(__dirname, '../../cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

// Chuẩn bị lệnh xóa
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
                // Nếu lỗi cache nặng, có thể file gốc cũng hỏng, nhưng tạm thời chỉ xóa cache
                throw new Error('CORRUPT_FILE_ON_DRIVE');
            }
            try { fs.unlinkSync(filePath); } catch(e){}
            return getSongStream(songId, retryCount + 1); 
        }
        return { type: 'file', filename: filename };
    }

    // CASE 2: STREAM TỪ DRIVE
    else {
        try {
            const meta = await drive.files.get({ fileId: songId, fields: 'size, trashed', supportsAllDrives: true });
            if (meta.data.trashed) { deleteSong.run(songId); throw new Error('FILE_DELETED_ON_DRIVE'); }
            
            const fileSize = meta.data.size ? parseInt(meta.data.size) : null;
            downloadInBackground(songId, fileSize);

            // [VÁ LỖI] Chuyển tiếp tọa độ Tua (Range) cho Google Drive
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
                    'Content-Range': res.headers['content-range'], // Chuyển tiếp cự ly
                    'Accept-Ranges': 'bytes'
                },
                status: res.status // Sẽ trả về 206 Partial Content để điện thoại hiểu là đang Tua
            };

        } catch (error) {
            console.error(`❌ Stream Error ${songId}:`, error.message);
            
            // [LOGIC 2] Nếu lỗi 404 (Không tìm thấy trên Drive) -> Xóa khỏi DB ngay
            if (error.code === 404 || (error.response && error.response.status === 404)) {
                console.log(`🗑️ File ${songId} không còn trên Drive (404) -> Xóa khỏi DB.`);
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

async function downloadInBackground(songId, expectedSize) {
    // ... (Giữ nguyên logic download cũ)
    const filePath = path.join(CACHE_DIR, `${songId}.mp3`);
    const tempPath = path.join(CACHE_DIR, `${songId}.temp`);
    if (fs.existsSync(tempPath) || fs.existsSync(filePath)) return;

    try {
        const dest = fs.createWriteStream(tempPath);
        const res = await drive.files.get(
            { fileId: songId, alt: 'media', supportsAllDrives: true }, 
            { responseType: 'stream', headers: { 'Accept-Encoding': 'identity' } }
        );
        res.data.pipe(dest);
        dest.on('finish', () => {
            try {
                const stat = fs.statSync(tempPath);
                if (expectedSize && stat.size < expectedSize * 0.9) fs.unlinkSync(tempPath);
                else fs.renameSync(tempPath, filePath);
            } catch(e) {}
        });
        dest.on('error', () => { if(fs.existsSync(tempPath)) fs.unlinkSync(tempPath); });
    } catch (err) {}
}

module.exports = { getSongStream, preloadSong };