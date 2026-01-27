// src/modules/downloader.js - Version 7.0 (Safe Turbo Boost)

const path = require('path');
const fs = require('fs');
const yt = require('yt-dlp-exec');
const drive = require('./drive');
const { scanNewFile } = require('./scanner');

const DOWNLOAD_FOLDER_ID = process.env.DRIVE_DOWNLOAD_FOLDER_ID || process.env.DRIVE_FOLDER_ID;
const YTDLP_PATH = '/usr/local/bin/yt-dlp'; // Đảm bảo đường dẫn đúng
const TEMP_DIR = path.join(__dirname, '../../temp_downloads');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// CẤU HÌNH TĂNG TỐC AN TOÀN
const CONCURRENCY_LIMIT = 2; // Xử lý 2 bài cùng lúc (An toàn cho VPS)
const DOWNLOAD_FRAGMENTS = 4; // Mỗi bài chia 4 luồng tải (Giống IDM)

let state = {
    isProcessing: false, shouldStop: false, currentTask: null, progress: 0, total: 0, logs: [] 
};

function addLog(message) {
    const timestamp = new Date().toLocaleTimeString('vi-VN');
    const logLine = `[${timestamp}] ${message}`;
    console.log(logLine);
    state.logs.push(logLine);
    if (state.logs.length > 100) state.logs.shift();
}

function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().substring(0, 100);           
}

async function getExistingFiles(folderId) {
    try {
        let files = [];
        let pageToken = null;
        do {
            const res = await drive.files.list({
                q: `'${folderId}' in parents and trashed = false`,
                fields: 'nextPageToken, files(name)',
                pageSize: 1000, pageToken: pageToken,
                supportsAllDrives: true, includeItemsFromAllDrives: true
            });
            if (res.data.files) files = files.concat(res.data.files);
            pageToken = res.data.nextPageToken;
        } while (pageToken);
        return new Set(files.map(f => f.name.toLowerCase()));
    } catch (e) { return new Set(); }
}

async function getPreviewInfo(url) {
    addLog(`🔍 Đang phân tích: ${url}`);
    try {
        const rawOutput = await yt(url, {
            dumpSingleJson: true, flatPlaylist: true, noWarnings: true,
            extractorArgs: 'youtube:player_client=android', forceIpv4: true, noCheckCertificates: true
        }, { ytDlpBinaryPath: YTDLP_PATH });

        const isPlaylist = rawOutput._type === 'playlist';
        let rawEntries = isPlaylist ? rawOutput.entries : [rawOutput];
        const items = rawEntries.map(entry => ({
            id: entry.id, title: entry.title || 'Unknown Track', duration: entry.duration
        }));

        return {
            title: rawOutput.title || 'Không có tiêu đề', 
            count: items.length,
            thumbnail: rawOutput.thumbnail || (rawOutput.thumbnails ? rawOutput.thumbnails[0]?.url : null),
            uploader: rawOutput.uploader || 'Unknown', 
            type: isPlaylist ? 'playlist' : 'video', 
            url, items
        };
    } catch (err) { 
        console.error(err);
        throw new Error('Không thể lấy thông tin. YouTube có thể đang chặn IP.'); 
    }
}

async function uploadToDrive(filePath, fileName) {
    try {
        const fileMetadata = { name: fileName, parents: [DOWNLOAD_FOLDER_ID] };
        const media = { mimeType: 'audio/mpeg', body: fs.createReadStream(filePath) };
        const file = await drive.files.create({ resource: fileMetadata, media: media, fields: 'id', supportsAllDrives: true });
        return file.data.id;
    } catch (err) { throw err; }
}

function stopDownload() {
    if (state.isProcessing) { state.shouldStop = true; addLog(`🛑 Đang gửi lệnh dừng...`); }
}

// --- HÀM XỬ LÝ 1 BÀI HÁT (WORKER) ---
async function processSingleItem(item, index, existingFileNamesLower) {
    if (state.shouldStop) return;

    const videoUrl = `https://www.youtube.com/watch?v=${item.id}`;
    const videoTitle = item.title || item.id; 
    const safeBaseName = sanitizeFilename(videoTitle);
    const finalFileName = `${safeBaseName}.mp3`;
    
    // Check trùng (nhanh)
    if (existingFileNamesLower.has(finalFileName.toLowerCase())) {
        addLog(`⏩ [#${index + 1}] Đã có: "${finalFileName}". Bỏ qua.`);
        state.progress++;
        return;
    }

    addLog(`⬇️ [#${index + 1}] Đang tải: ${videoTitle}`);

    try {
        const outputTemplate = path.join(TEMP_DIR, `${safeBaseName}.%(ext)s`);
        
        // TẢI FILE TỪ YOUTUBE
        await yt(videoUrl, {
            extractAudio: true, audioFormat: 'mp3', audioQuality: 0,
            embedThumbnail: true, addMetadata: true, 
            output: outputTemplate, 
            noPlaylist: true, format: 'bestaudio/best',
            
            // --- [NEW] CẤU HÌNH TĂNG TỐC ---
            concurrentFragments: DOWNLOAD_FRAGMENTS, // Tải đa luồng nội bộ
            retries: 5,                              // Thử lại nhiều lần nếu rớt
            fragmentRetries: 5,                      // Thử lại từng mảnh nhỏ
            // -------------------------------

            extractorArgs: 'youtube:player_client=android', forceIpv4: true, noCheckCertificates: true
        }, { ytDlpBinaryPath: YTDLP_PATH });

        const files = fs.readdirSync(TEMP_DIR).filter(f => f.endsWith('.mp3') && f.includes(safeBaseName));
        
        if (files.length > 0) {
            let fileName = files[0]; 
            const filePath = path.join(TEMP_DIR, fileName);

            // Xử lý trùng tên khi file sinh ra thực tế
            if (existingFileNamesLower.has(fileName.toLowerCase())) {
                const randomSuffix = Math.floor(Math.random() * 10000);
                fileName = fileName.replace('.mp3', ` (${randomSuffix}).mp3`);
            }

            addLog(`☁️ [#${index + 1}] Upload Drive: ${fileName}`);
            const fileId = await uploadToDrive(filePath, fileName);
            
            existingFileNamesLower.add(fileName.toLowerCase());
            try { fs.unlinkSync(filePath); } catch(e){}
            
            addLog(`💾 [#${index + 1}] Xong! Cập nhật DB...`);
            await scanNewFile(fileId);
        } else {
             addLog(`⚠️ [#${index + 1}] Lỗi: Không thấy file MP3 đầu ra.`);
        }
    } catch (err) {
        const errMsg = err.stderr || err.message || 'Unknown';
        if (errMsg.includes('429')) addLog(`❌ [#${index + 1}] Lỗi 429 (Too Many Requests). YouTube đang chặn.`);
        else addLog(`❌ [#${index + 1}] Lỗi: ${errMsg.slice(0, 50)}...`);
    } finally {
        state.progress++;
    }
}

async function processDownload(url, indices = null) {
    if (state.isProcessing) return; 
    state.isProcessing = true; state.shouldStop = false; state.logs = []; 
    addLog(`🚀 KÍCH HOẠT CHẾ ĐỘ TĂNG TỐC (Luồng: ${CONCURRENCY_LIMIT})...`);

    try {
        // Dọn dẹp thư mục temp
        if (fs.existsSync(TEMP_DIR)) {
            const oldFiles = fs.readdirSync(TEMP_DIR);
            for (const file of oldFiles) if (file.endsWith('.mp3')) fs.unlinkSync(path.join(TEMP_DIR, file));
        }

        const info = await getPreviewInfo(url);
        let items = info.items || [];

        // Lọc theo indices
        if (indices) {
            addLog(`📝 Tải tùy chọn: ${indices}`);
            const selectedSet = new Set(indices.split(',').map(n => parseInt(n.trim())));
            items = items.filter((_, idx) => selectedSet.has(idx + 1));
        }

        state.total = items.length; state.progress = 0;
        addLog(`☁️ Đang đồng bộ danh sách file...`);
        const existingFileNamesLower = await getExistingFiles(DOWNLOAD_FOLDER_ID);
        addLog(`📋 Danh sách cần tải: ${state.total} bài.`);

        // --- [NEW] LOGIC XỬ LÝ SONG SONG (BATCH PROCESSING) ---
        for (let i = 0; i < items.length; i += CONCURRENCY_LIMIT) {
            if (state.shouldStop) { addLog(`🛑 ĐÃ DỪNG.`); break; }

            // Lấy ra một nhóm (ví dụ 2 bài)
            const batch = items.slice(i, i + CONCURRENCY_LIMIT);
            state.currentTask = `Đang xử lý nhóm bài ${i + 1} - ${i + batch.length}`;
            
            // Chạy song song nhóm này và đợi tất cả xong mới qua nhóm tiếp theo
            // (Cách này an toàn hơn Promise.all toàn bộ danh sách)
            await Promise.all(batch.map((item, batchIndex) => {
                return processSingleItem(item, i + batchIndex, existingFileNamesLower);
            }));
        }

        if (!state.shouldStop) addLog(`🎉 HOÀN TẤT TOÀN BỘ!`);

    } catch (error) {
        addLog(`🔥 Lỗi nghiêm trọng: ${error.message}`);
    } finally {
        state.isProcessing = false; state.shouldStop = false; state.currentTask = null;
    }
}

function getStatus() { return state; }

module.exports = { processDownload, getPreviewInfo, getStatus, stopDownload };