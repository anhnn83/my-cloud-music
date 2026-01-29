// src/modules/downloader-backend.js - Version FINAL

const path = require('path');
const fs = require('fs');
const yt = require('yt-dlp-exec');
const drive = require('./drive');
const { scanNewFile } = require('./scanner');

const DOWNLOAD_FOLDER_ID = process.env.DRIVE_DOWNLOAD_FOLDER_ID || process.env.DRIVE_FOLDER_ID;
// Ưu tiên biến môi trường, fallback về lệnh mặc định
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp'; 

const CONCURRENCY_LIMIT = 1; // Tải từng file để tránh treo VPS yếu
const DOWNLOAD_FRAGMENTS = 3; // Tăng tốc độ tải từng phần

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
            flatPlaylist: isPlaylistUrl, // Nếu là playlist, chỉ lấy list, không lấy chi tiết từng bài
            extractorArgs: 'youtube:player_client=web', // Giả lập Web Client
            jsRuntimes: 'node',
            impersonate: 'chrome-110', 
            noCheckCertificates: true,
            forceIpv4: true
        };

        const rawOutput = await yt(url, ytArgs, { ytDlpBinaryPath: YTDLP_PATH });

        const isPlaylist = rawOutput._type === 'playlist';
        const rawEntries = isPlaylist ? rawOutput.entries : [rawOutput];
        
        // Map lại tên field cho khớp với Frontend (Frontend dùng 'items', 'title'...)
        const items = rawEntries.map(entry => ({
            id: entry.id,
            title: entry.title,
            duration: entry.duration
        }));

        // Trích xuất Formats (Chỉ dành cho Video lẻ)
        let cleanFormats = [];
        if (!isPlaylist && rawOutput.formats) {
            cleanFormats = rawOutput.formats.filter(f => {
                // Lọc lấy các stream Video có hình ảnh (vcodec != none) và không phải storyboard
                return f.vcodec !== 'none' && 
                       !f.format_id.includes('sb') && 
                       f.ext !== 'mhtml' &&
                       f.protocol !== 'mhtml'; // Loại bỏ mhtml
            }).map(f => {
                return {
                    id: f.format_id, // Frontend dùng id này để gửi lại khi download
                    ext: f.ext,
                    resolution: f.resolution || `${f.width}x${f.height}`,
                    filesize: formatSize(f.filesize || f.filesize_approx),
                    note: f.format_note || '',
                    vcodec: f.vcodec
                };
            });
            // Sắp xếp file nặng nhất (chất lượng cao nhất) lên đầu
            cleanFormats.sort((a, b) => {
                const sizeA = parseFloat(a.filesize) || 0;
                const sizeB = parseFloat(b.filesize) || 0;
                return sizeB - sizeA;
            });
        }

        return {
            title: rawOutput.title || 'Không có tiêu đề', 
            count: items.length,
            thumbnail: rawOutput.thumbnail || (rawOutput.thumbnails ? rawOutput.thumbnails[0]?.url : null),
            uploader: rawOutput.uploader || 'Unknown', 
            type: isPlaylist ? 'Playlist' : 'Video Lẻ', 
            url, 
            items: items, // Frontend dùng field này
            formats: cleanFormats // Frontend dùng field này
        };
    } catch (err) { 
        console.error(err);
        throw new Error('Không thể lấy thông tin. Link sai hoặc bị chặn.'); 
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
            extractorArgs: 'youtube:player_client=web', 
            jsRuntimes: 'node',
            impersonate: 'chrome-110', 
            noCheckCertificates: true, forceIpv4: true,
            concurrentFragments: DOWNLOAD_FRAGMENTS, retries: 10
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

async function processDownload(url, indices = [], formatId = null) {
    if (state.isProcessing) return; 
    state.isProcessing = true; state.shouldStop = false; state.logs = []; 
    addLog(`🚀 Bắt đầu...`);

    try {
        // Dọn dẹp thư mục temp trước khi tải
        if (fs.existsSync(TEMP_DIR)) {
            const oldFiles = fs.readdirSync(TEMP_DIR);
            for (const file of oldFiles) {
                if (file.match(/\.(mp3|webm|m4a|mp4|mkv|part)$/)) {
                    try { fs.unlinkSync(path.join(TEMP_DIR, file)); } catch(e){}
                }
            }
        }

        const info = await getPreviewInfo(url);
        let items = info.items || [];

        // --- LỌC BÀI HÁT (INDICES) ---
        // Frontend gửi Indices bắt đầu từ 1 (User view: 1, 2, 3...)
        // Array của chúng ta bắt đầu từ 0
        if (Array.isArray(indices) && indices.length > 0) {
            items = items.filter((_, idx) => {
                // Ví dụ: User chọn bài số 1 -> indices có chứa số 1 -> ta lấy items[0]
                // index thực của array là idx. User index là idx + 1.
                // Kiểm tra xem (idx + 1) có nằm trong danh sách indices user gửi không
                return indices.includes(idx + 1);
            });
            addLog(`🎯 Đã lọc: Tải ${items.length} bài theo yêu cầu.`);
        }

        // Nếu playlist rỗng (do lọc sai hoặc playlist trống)
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