// src/modules/downloader.js - Version 5.1 (Force Filename from Title)

const path = require('path');
const fs = require('fs');
const yt = require('yt-dlp-exec');
const drive = require('./drive');
const { scanNewFile } = require('./scanner');

const DOWNLOAD_FOLDER_ID = process.env.DRIVE_DOWNLOAD_FOLDER_ID || process.env.DRIVE_FOLDER_ID;
const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const TEMP_DIR = path.join(__dirname, '../../temp_downloads');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

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

// [MỚI] Hàm làm sạch tên file thủ công (Thay thế cho %(title).100s của yt-dlp)
function sanitizeFilename(name) {
    return name
        .replace(/[<>:"/\\|?*]/g, '') // Loại bỏ ký tự cấm của Windows/Linux
        .replace(/\s+/g, ' ')         // Xóa khoảng trắng thừa
        .trim()
        .substring(0, 100);           // Cắt ngắn 100 ký tự
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
        const entries = isPlaylist ? rawOutput.entries : [rawOutput];
        return {
            title: rawOutput.title || 'Không có tiêu đề', count: entries.length,
            thumbnail: rawOutput.thumbnail || (rawOutput.thumbnails ? rawOutput.thumbnails[0]?.url : null),
            uploader: rawOutput.uploader || 'Unknown', type: isPlaylist ? 'Playlist' : 'Video Lẻ', url, entries 
        };
    } catch (err) { throw new Error('Không thể lấy thông tin. Kiểm tra lại Link.'); }
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

async function processDownload(url) {
    if (state.isProcessing) return; 
    state.isProcessing = true; state.shouldStop = false; state.logs = []; 
    addLog(`🚀 Bắt đầu quy trình xử lý...`);

    try {
        if (fs.existsSync(TEMP_DIR)) {
            const oldFiles = fs.readdirSync(TEMP_DIR);
            for (const file of oldFiles) if (file.endsWith('.mp3')) fs.unlinkSync(path.join(TEMP_DIR, file));
        }

        const info = await getPreviewInfo(url);
        const items = info.entries || [];
        state.total = items.length; state.progress = 0;

        addLog(`☁️ Đang đồng bộ danh sách file...`);
        const existingFileNamesLower = await getExistingFiles(DOWNLOAD_FOLDER_ID);
        addLog(`📋 Danh sách: ${state.total} bài.`);

        for (let i = 0; i < items.length; i++) {
            if (state.shouldStop) { addLog(`🛑 ĐÃ DỪNG THEO YÊU CẦU NGƯỜI DÙNG.`); break; }

            const item = items[i];
            const videoUrl = item.url || `https://www.youtube.com/watch?v=${item.id}`;
            // Tiêu đề gốc lấy từ bước Preview (Chính xác 100%)
            const videoTitle = item.title || item.id; 
            
            state.currentTask = `[${i + 1}/${state.total}] ${videoTitle}`;

            // --- 1. CHUẨN BỊ TÊN FILE (Force Name) ---
            // Thay vì để yt-dlp tự sinh, ta tự tạo tên file chuẩn ngay tại đây
            const safeBaseName = sanitizeFilename(videoTitle);
            const finalFileName = `${safeBaseName}.mp3`;
            const finalFileNameLower = finalFileName.toLowerCase();

            // --- 2. SMART CHECK (Dựa trên tên file ta vừa tự tạo) ---
            if (existingFileNamesLower.has(finalFileNameLower)) {
                addLog(`⏩ Đã tồn tại: "${finalFileName}". Bỏ qua.`);
                state.progress = i + 1;
                continue;
            }

            addLog(`⬇️ Đang tải: ${videoTitle}`);

            try {
                // [QUAN TRỌNG] Ép yt-dlp dùng tên file do ta chỉ định
                // Ta truyền safeBaseName vào, yt-dlp chỉ việc thêm đuôi file tạm (.webm/.m4a)
                // Sau đó nó sẽ convert sang .mp3 đúng như tên ta muốn
                const outputTemplate = path.join(TEMP_DIR, `${safeBaseName}.%(ext)s`);
                
                await yt(videoUrl, {
                    extractAudio: true, audioFormat: 'mp3', audioQuality: 0,
                    embedThumbnail: true, addMetadata: true, 
                    output: outputTemplate, // <--- Dùng template cứng
                    noPlaylist: true, format: 'bestaudio/best', 
                    extractorArgs: 'youtube:player_client=android', forceIpv4: true, noCheckCertificates: true
                }, { ytDlpBinaryPath: YTDLP_PATH });

                const files = fs.readdirSync(TEMP_DIR).filter(f => f.endsWith('.mp3'));
                if (files.length > 0) {
                    let fileName = files[0]; // Lúc này tên file chắc chắn là safeBaseName.mp3
                    const filePath = path.join(TEMP_DIR, fileName);

                    // Safety Check (Check trùng lần cuối)
                    if (existingFileNamesLower.has(fileName.toLowerCase())) {
                        const randomSuffix = Math.floor(Math.random() * 10000);
                        const nameWithoutExt = fileName.replace('.mp3', '');
                        const newFileName = `${nameWithoutExt} (${randomSuffix}).mp3`;
                        addLog(`⚠️ Trùng tên (Safety). Đổi thành: "${newFileName}"`);
                        fileName = newFileName; 
                    }

                    addLog(`☁️ Đang upload: ${fileName}`);
                    const fileId = await uploadToDrive(filePath, fileName);
                    
                    existingFileNamesLower.add(fileName.toLowerCase());
                    fs.unlinkSync(filePath);
                    
                    addLog(`💾 Cập nhật Database...`);
                    await scanNewFile(fileId);
                    addLog(`✅ Xong.`);
                } else {
                     addLog(`⚠️ Lỗi: Không sinh ra file MP3.`);
                }
            } catch (err) {
                const errMsg = err.stderr || err.message || 'Unknown Error';
                if (errMsg.includes('403')) addLog(`❌ Lỗi 403. Thử lại...`);
                else addLog(`❌ Lỗi: ${errMsg.slice(0, 100)}...`);
            }
            state.progress = i + 1;
        }

        if (!state.shouldStop) addLog(`🎉 HOÀN TẤT TOÀN BỘ QUY TRÌNH!`);

    } catch (error) {
        addLog(`🔥 Lỗi nghiêm trọng: ${error.message}`);
    } finally {
        state.isProcessing = false; state.shouldStop = false; state.currentTask = null;
    }
}

function getStatus() { return state; }

module.exports = { processDownload, getPreviewInfo, getStatus, stopDownload };