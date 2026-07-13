// src/modules/downloader-backend.js - Version 11.5

const path = require('path');
const fs = require('fs');
const yt = require('yt-dlp-exec');
const drive = require('./drive');
const { scanNewFile } = require('./scanner');

const DOWNLOAD_FOLDER_ID = process.env.DRIVE_DOWNLOAD_FOLDER_ID || process.env.DRIVE_FOLDER_ID;
// Ưu tiên biến môi trường, fallback về lệnh mặc định
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp'; 

const CONCURRENCY_LIMIT = 2; // Tải từng file để tránh treo VPS yếu
const DOWNLOAD_FRAGMENTS = 4; // Tăng tốc độ tải từng phần

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
    if (state.logs.length > 200) state.logs.shift();
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

function formatSize(bytes) {
    if (!bytes) return 'N/A';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) * 1 + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i];
}

// ==========================================
// 1. LẤY THÔNG TIN (PREVIEW)
// ==========================================
async function getPreviewInfo(url) {
    addLog(`🔍 Đang phân tích: ${url}`);
    try {
        const isPlaylistUrl = url.includes('list=');
        
        const ytArgs = {
            dumpSingleJson: true,
            noWarnings: true,
            // yesPlaylist: isPlaylistUrl,
            flatPlaylist: true,
            extractorArgs: 'youtube:player_client=android.web',
            jsRuntimes: 'node',
            impersonate: 'chrome-110', 
            noCheckCertificates: true,
            forceIpv4: true,
            // username: 'oauth2',
            // password: ''
            // cookies: '/app/cookies.txt'
        };

        const rawOutput = await yt(url, ytArgs, { ytDlpBinaryPath: YTDLP_PATH });

        // [FIXED] Logic nhận diện Playlist mạnh mẽ hơn
        const hasEntries = Array.isArray(rawOutput.entries) && rawOutput.entries.length > 0;
        const isPlaylist = rawOutput._type === 'playlist' || hasEntries;
        
        const entries = isPlaylist ? rawOutput.entries : [rawOutput];
        
        let cleanFormats = [];
        // Chỉ lấy formats nếu đây KHÔNG phải là playlist (vì playlist không trả về formats chi tiết cho từng bài ở bước này)
        if (!isPlaylist && rawOutput.formats) {
            cleanFormats = rawOutput.formats.filter(f => {
                if (f.format_id.includes('sb')) return false;
                if (f.ext === 'mhtml' || f.protocol === 'mhtml') return false;
                return f.vcodec !== 'none';
            }).map(f => {
                return {
                    format_id: f.format_id,
                    ext: f.ext,
                    resolution: f.resolution || `${f.width}x${f.height}`,
                    filesize: formatSize(f.filesize || f.filesize_approx),
                    note: f.format_note || '',
                    vcodec: f.vcodec
                };
            });
            cleanFormats.sort((a, b) => (parseFloat(b.filesize) || 0) - (parseFloat(a.filesize) || 0));
        }

        return {
            title: rawOutput.title || 'Không có tiêu đề', 
            count: entries.length,
            thumbnail: rawOutput.thumbnail || (rawOutput.thumbnails ? rawOutput.thumbnails[0]?.url : null),
            uploader: rawOutput.uploader || 'Unknown', 
            // Trả về type chính xác để Frontend hiển thị đúng nút
            type: isPlaylist ? 'Playlist' : 'Video Lẻ', 
            url, 
            entries, 
            formats: cleanFormats 
        };
    } catch (err) { 
        console.error(err);
        throw new Error('Lỗi lấy thông tin. YouTube chặn hoặc Link sai.'); 
    }
}

async function uploadToDrive(filePath, fileName) {
    try {
        const fileMetadata = { name: fileName, parents: [DOWNLOAD_FOLDER_ID] };
        
        // Tự động nhận diện MimeType
        const ext = path.extname(fileName).toLowerCase();
        let mimeType = 'audio/mpeg'; 
        if (ext === '.mp4') mimeType = 'video/mp4';
        else if (ext === '.webm') mimeType = 'video/webm';
        else if (ext === '.mkv') mimeType = 'video/x-matroska';
        
        const media = { mimeType: mimeType, body: fs.createReadStream(filePath) };

        const file = await drive.files.create({ 
            resource: fileMetadata, media: media, fields: 'id', supportsAllDrives: true 
        });
        return file.data.id;
    } catch (err) { throw err; }
}

function stopDownload() {
    if (state.isProcessing) { state.shouldStop = true; addLog(`🛑 Đang gửi lệnh dừng...`); }
}

// ==========================================
// 2. XỬ LÝ TẢI (CORE LOGIC)
// ==========================================
async function processSingleItem(item, index, existingFileNamesLower, formatId = null) {
    if (state.shouldStop) return;

    const videoTitle = item.title || item.id; 
    const safeBaseName = sanitizeFilename(videoTitle);
    
    // -- LOGIC CHECK TRÙNG --
    // Chỉ check kỹ khi tải nhạc (MP3). Nếu tải Video, cho phép tải lại (hoặc check lỏng lẻo)
    if (!formatId) {
        const expectedFile = `${safeBaseName}.mp3`.toLowerCase();
        if (existingFileNamesLower.has(expectedFile)) {
            addLog(`⏩ [#${index + 1}] Đã có: "${safeBaseName}.mp3". Bỏ qua.`);
            return;
        }
    }

    addLog(`⬇️ [#${index + 1}] Đang tải: ${videoTitle}`);

    try {
        let outputTemplate = path.join(TEMP_DIR, `${safeBaseName}.%(ext)s`);
        
        const ytOptions = {
            embedThumbnail: true, addMetadata: true, 
            output: outputTemplate,
            noPlaylist: true,
            // extractorArgs: 'youtube:player_client=android', 
            jsRuntimes: 'node',
            impersonate: 'chrome-110', 
            noCheckCertificates: true,
            forceIpv4: true,
            concurrentFragments: DOWNLOAD_FRAGMENTS,
            retries: 10,
            sleepRequests: 3,     // Nghỉ 3 giây giữa các request
            minSleepInterval: 5,  // Nghỉ tối thiểu 5 giây trước khi tải video tiếp theo
            maxSleepInterval: 15, // Nghỉ tối đa 15 giây (random khoảng 5-15s để giống người thật)
            // username: 'oauth2',
            // password: ''
            cookies: '/app/cookies.txt'
        };

        if (formatId) {
            // [MODE VIDEO] 
            // formatId là mã video (ví dụ 137 cho 1080p). 
            // Cộng thêm "+bestaudio/best" để yt-dlp tự động tải audio và merge vào.
            ytOptions.format = `${formatId}+bestaudio/best`; 
            ytOptions.embedThumbnail = false; // Video không cần embed thumbnail vào file
        } else {
            // [MODE MUSIC - DEFAULT]
            // Tải audio tốt nhất và convert sang mp3
            ytOptions.format = 'bestaudio/best';
            ytOptions.extractAudio = true;
            ytOptions.audioFormat = 'mp3';
            ytOptions.audioQuality = 0;
        }

        await yt(`https://www.youtube.com/watch?v=${item.id}`, ytOptions, { ytDlpBinaryPath: YTDLP_PATH });

        // Tìm file kết quả (Vì extension có thể là mp3, mp4, webm, mkv...)
        const files = fs.readdirSync(TEMP_DIR).filter(f => f.includes(safeBaseName) && !f.endsWith('.part'));
        
        if (files.length > 0) {
            let fileName = files[0];
            const filePath = path.join(TEMP_DIR, fileName);

            // Xử lý trùng tên khi Upload
            if (existingFileNamesLower.has(fileName.toLowerCase())) {
                const randomSuffix = Math.floor(Math.random() * 10000);
                const ext = path.extname(fileName);
                const nameNoExt = path.basename(fileName, ext);
                const newFileName = `${nameNoExt} (${randomSuffix})${ext}`;
                fs.renameSync(filePath, path.join(TEMP_DIR, newFileName));
                fileName = newFileName;
            }

            addLog(`☁️ [#${index + 1}] Uploading: ${fileName}`);
            const fileId = await uploadToDrive(path.join(TEMP_DIR, fileName), fileName);
            
            existingFileNamesLower.add(fileName.toLowerCase());
            try { fs.unlinkSync(path.join(TEMP_DIR, fileName)); } catch(e){}
            
            addLog(`✅ [#${index + 1}] Hoàn tất.`);
            await scanNewFile(fileId); // Scan vào DB ngay
        } else {
             addLog(`⚠️ [#${index + 1}] Lỗi: Không tìm thấy file đầu ra.`);
        }
    } catch (err) {
        const errMsg = err.stderr || err.message || 'Unknown Error';
        if (errMsg.includes('Sign in')) addLog(`❌ [#${index + 1}] Lỗi: YouTube chặn (Sign in required).`);
        else if (errMsg.includes('403')) addLog(`❌ [#${index + 1}] Lỗi 403 Forbidden.`);
        else addLog(`❌ [#${index + 1}] Lỗi: ${errMsg.slice(0, 100)}...`);
    }
}

async function processDownload(url, rawIndices = null, formatId = null) {
    if (state.isProcessing) return; 
    state.isProcessing = true; state.shouldStop = false; state.logs = []; 
    
    // --- 1. XỬ LÝ BIẾN INDICES (Chuỗi -> Mảng) ---
    let indices = [];
    if (Array.isArray(rawIndices)) {
        indices = rawIndices;
    } else if (typeof rawIndices === 'string' && rawIndices.trim().length > 0) {
        // Tách chuỗi "1,2,3" thành mảng số [1, 2, 3]
        indices = rawIndices.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
    }
    // ---------------------------------------------

    // Log kiểm tra để bạn yên tâm
    if (formatId) addLog(`🚀 Bắt đầu tải VIDEO (Format ID: ${formatId})...`);
    else if (indices.length > 0) addLog(`🚀 Bắt đầu tải ${indices.length} bài hát đã chọn (MP3)...`);
    else addLog(`🚀 Bắt đầu tải TOÀN BỘ danh sách (MP3)...`);

    try {
        // Dọn dẹp thư mục temp
        if (fs.existsSync(TEMP_DIR)) {
            const oldFiles = fs.readdirSync(TEMP_DIR);
            for (const file of oldFiles) {
                if (file.match(/\.(mp3|webm|m4a|mp4|mkv|part)$/)) {
                    try { fs.unlinkSync(path.join(TEMP_DIR, file)); } catch(e){}
                }
            }
        }

        const info = await getPreviewInfo(url);
        let items = info.entries || [];

        // --- 2. LỌC BÀI HÁT ---
        if (indices.length > 0) {
            items = items.filter((_, idx) => {
                // Frontend gửi index bắt đầu từ 1 (1, 2, 3...), mảng bắt đầu từ 0
                return indices.includes(idx + 1);
            });
            addLog(`🎯 Đã lọc: Chỉ tải ${items.length} bài theo yêu cầu.`);
        }

        if (items.length === 0) {
            addLog(`⚠️ Không có bài nào để tải.`);
            return;
        }

        state.total = items.length; state.progress = 0;
        addLog(`☁️ Đang đồng bộ danh sách file từ Drive...`);
        const existingFileNamesLower = await getExistingFiles(DOWNLOAD_FOLDER_ID);
        
        for (let i = 0; i < items.length; i += CONCURRENCY_LIMIT) {
            if (state.shouldStop) { addLog(`🛑 ĐÃ DỪNG.`); break; }
            const batch = items.slice(i, i + CONCURRENCY_LIMIT);
            state.currentTask = `Đang xử lý nhóm: ${i + 1}`;
            
            await Promise.all(batch.map((item, batchIndex) => {
                const globalIndex = i + batchIndex;
                return processSingleItem(item, globalIndex, existingFileNamesLower, formatId);
            }));
            state.progress = Math.min(i + CONCURRENCY_LIMIT, state.total);
        }

        if (!state.shouldStop) addLog(`🎉 TIẾN TRÌNH HOÀN TẤT!`);

    } catch (error) {
        addLog(`🔥 Lỗi hệ thống: ${error.message}`);
    } finally {
        state.isProcessing = false; state.shouldStop = false; state.currentTask = null;
    }
}

function getStatus() { return state; }

module.exports = { processDownload, getPreviewInfo, getStatus, stopDownload };