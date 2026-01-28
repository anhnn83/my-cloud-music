// src/modules/downloader.js - Version 10.1

const path = require('path');
const fs = require('fs');
const yt = require('yt-dlp-exec');
const drive = require('./drive');
const { scanNewFile } = require('./scanner');

const DOWNLOAD_FOLDER_ID = process.env.DRIVE_DOWNLOAD_FOLDER_ID || process.env.DRIVE_FOLDER_ID;
const YTDLP_PATH = '/usr/local/bin/yt-dlp'; 
const TEMP_DIR = path.join(__dirname, '../../temp_downloads');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const CONCURRENCY_LIMIT = 2; 
const DOWNLOAD_FRAGMENTS = 4;

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

// --- 1. HÀM LẤY THÔNG TIN (DÙNG WEB CLIENT MẶC ĐỊNH) ---
async function getPreviewInfo(url) {
    addLog(`🔍 Đang phân tích: ${url}`);
    try {
        // [QUAN TRỌNG] Xóa bỏ hoàn toàn 'extractorArgs'
        // Để yt-dlp tự giả lập trình duyệt Web -> An toàn nhất cho IP VPS
        const rawOutput = await yt(url, {
            dumpSingleJson: true, flatPlaylist: true, noWarnings: true,
            forceIpv4: true, noCheckCertificates: true
        }, { ytDlpBinaryPath: YTDLP_PATH });

        const isPlaylist = rawOutput._type === 'playlist';
        
        let formats = [];
        if (!isPlaylist && rawOutput.formats) {
            formats = rawOutput.formats.map(f => {
                let typeNote = '';
                if (f.vcodec !== 'none' && f.acodec !== 'none') typeNote = '[Video+Audio]';
                else if (f.vcodec !== 'none') typeNote = '[Video Only 🔇]';
                else if (f.acodec !== 'none') typeNote = '[Audio Only 🎵]';

                return {
                    id: f.format_id,
                    ext: f.ext,
                    resolution: (f.resolution || (f.height ? f.height + 'p' : 'Audio Only')),
                    note: `${typeNote} ${f.format_note || ''} ${f.fps ? f.fps + 'fps' : ''}`.trim(),
                    filesize: f.filesize ? (f.filesize / 1024 / 1024).toFixed(1) + ' MB' : (f.filesize_approx ? '~' + (f.filesize_approx / 1024 / 1024).toFixed(1) + ' MB' : 'N/A'),
                    vcodec: f.vcodec,
                    acodec: f.acodec,
                    height: f.height || 0
                };
            }).filter(f => f.ext !== 'mhtml' && f.ext !== 'html'); 
            
            formats.sort((a, b) => b.height - a.height);
        }

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
            url, items, formats: formats 
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

// --- 2. HÀM TẢI (QUAY VỀ WEB CLIENT CHO CẢ 2) ---
async function processSingleItem(item, index, existingFileNamesLower, formatId = null) {
    if (state.shouldStop) return;

    const videoUrl = `https://www.youtube.com/watch?v=${item.id}`;
    const videoTitle = item.title || item.id; 
    const safeBaseName = sanitizeFilename(videoTitle);
    
    addLog(`⬇️ [#${index + 1}] Đang tải: ${videoTitle} ${formatId ? `(Format: ${formatId})` : '(Audio MP3)'}`);

    try {
        const ytOptions = {
            embedThumbnail: true, addMetadata: true, 
            output: path.join(TEMP_DIR, `${safeBaseName}.%(ext)s`),
            noPlaylist: true, 
            concurrentFragments: DOWNLOAD_FRAGMENTS,
            retries: 5, fragmentRetries: 5,
            forceIpv4: true, noCheckCertificates: true
            // [QUAN TRỌNG] Đã xóa toàn bộ extractorArgs
        };

        if (formatId) {
            ytOptions.format = formatId;
        } else {
            // Tải Audio mặc định
            ytOptions.extractAudio = true;
            ytOptions.audioFormat = 'mp3';
            ytOptions.audioQuality = 0;
            ytOptions.format = 'bestaudio/best';
        }

        await yt(videoUrl, ytOptions, { ytDlpBinaryPath: YTDLP_PATH });

        const files = fs.readdirSync(TEMP_DIR).filter(f => f.includes(safeBaseName));
        
        if (files.length > 0) {
            let fileName = files[0]; 
            const filePath = path.join(TEMP_DIR, fileName);

            if (existingFileNamesLower.has(fileName.toLowerCase())) {
                const randomSuffix = Math.floor(Math.random() * 10000);
                const ext = path.extname(fileName);
                const nameNoExt = path.basename(fileName, ext);
                const newName = `${nameNoExt} (${randomSuffix})${ext}`;
                const newPath = path.join(TEMP_DIR, newName);
                fs.renameSync(filePath, newPath);
                fileName = newName;
            }

            addLog(`☁️ [#${index + 1}] Upload Drive: ${fileName}`);
            const fileId = await uploadToDrive(filePath, fileName);
            
            existingFileNamesLower.add(fileName.toLowerCase());
            try { fs.unlinkSync(filePath); } catch(e){}
            
            addLog(`💾 [#${index + 1}] Xong! Cập nhật DB...`);
            await scanNewFile(fileId);
        } else {
             addLog(`⚠️ [#${index + 1}] Lỗi: Không thấy file đầu ra.`);
        }
    } catch (err) {
        const errMsg = err.stderr || err.message || 'Unknown';
        addLog(`❌ [#${index + 1}] Lỗi: ${errMsg.slice(0, 50)}...`);
    } finally {
        state.progress++;
    }
}

async function processDownload(url, indices = null, formatId = null) {
    if (state.isProcessing) return; 
    state.isProcessing = true; state.shouldStop = false; state.logs = []; 
    addLog(`🚀 BẮT ĐẦU TIẾN TRÌNH...`);

    try {
        if (fs.existsSync(TEMP_DIR)) {
            const oldFiles = fs.readdirSync(TEMP_DIR);
            for (const file of oldFiles) fs.unlinkSync(path.join(TEMP_DIR, file));
        }

        const info = await getPreviewInfo(url);
        let items = info.items || [];

        if (indices) {
            addLog(`📝 Tải tùy chọn: ${indices}`);
            const selectedSet = new Set(indices.split(',').map(n => parseInt(n.trim())));
            items = items.filter((_, idx) => selectedSet.has(idx + 1));
        }

        state.total = items.length; state.progress = 0;
        const existingFileNamesLower = await getExistingFiles(DOWNLOAD_FOLDER_ID);
        addLog(`📋 Danh sách cần tải: ${state.total} file.`);

        for (let i = 0; i < items.length; i += CONCURRENCY_LIMIT) {
            if (state.shouldStop) { addLog(`🛑 ĐÃ DỪNG.`); break; }
            const batch = items.slice(i, i + CONCURRENCY_LIMIT);
            state.currentTask = `Đang xử lý ${i + 1} - ${i + batch.length}`;
            
            await Promise.all(batch.map((item, batchIndex) => {
                return processSingleItem(item, i + batchIndex, existingFileNamesLower, formatId);
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