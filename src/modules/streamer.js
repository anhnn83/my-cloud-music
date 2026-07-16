// src/modules/streamer.js - Version 6.0 (PassThrough Stream)

const fs = require('fs');
const path = require('path');
const drive = require('./drive');
const { db } = require('./db');
const { PassThrough } = require('stream'); // Thêm dòng này

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

    // CASE 1: ĐÃ CÓ FILE CACHE HOÀN CHỈNH
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

    // CASE 2: CHƯA CACHE -> MỞ 1 LUỒNG, CHIA 2 NHÁNH (PASSTHROUGH)
    else {
        try {
            // Kiểm tra trạng thái file trên Drive
            const meta = await drive.files.get({ fileId: songId, fields: 'size, trashed', supportsAllDrives: true });
            if (meta.data.trashed) { deleteSong.run(songId); throw new Error('FILE_DELETED_ON_DRIVE'); }
            
            const fileSize = meta.data.size ? parseInt(meta.data.size) : null;
            
            // Lấy stream trực tiếp từ Google Drive
            const driveHeaders = { 'Accept-Encoding': 'identity' };
            if (rangeHeader) driveHeaders['Range'] = rangeHeader;

            const res = await drive.files.get(
                { fileId: songId, alt: 'media', supportsAllDrives: true },
                { responseType: 'stream', headers: driveHeaders }
            );

            // BỘ CHIA (PassThrough)
            const passThroughStream = new PassThrough();
            res.data.pipe(passThroughStream);

            // Nếu user không tua nhạc (tải từ đầu), ta mới cho phép ghi cache vào ổ cứng
            if (!rangeHeader) {
                const tempPath = path.join(CACHE_DIR, `${songId}.temp`);
                const writeStream = fs.createWriteStream(tempPath);
                
                // Nhánh 2: Ghi vào file temp
                passThroughStream.pipe(writeStream);

                // Khi tải xong, đổi tên thành file chính thức
                writeStream.on('finish', () => {
                    try {
                        const stat = fs.statSync(tempPath);
                        if (fileSize && stat.size < fileSize * 0.9) fs.unlinkSync(tempPath);
                        else fs.renameSync(tempPath, filePath);
                    } catch(e) {}
                });
                
                writeStream.on('error', () => {
                    if(fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                });
            }

            // Trả Nhánh 1 về cho App (để ném cho Frontend)
            return {
                type: 'stream',
                stream: passThroughStream,
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

// Giữ lại hành vi preload song khi nhấn nút "Tải về" (Không thay đổi)
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