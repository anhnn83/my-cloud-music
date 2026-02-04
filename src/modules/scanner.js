// src/modules/scanner.js - Version 10.3 (Force Update Support)
const drive = require('./drive');
const { db } = require('./db');
const path = require('path');

// --- QUẢN LÝ TRẠNG THÁI SCAN ---
let scanState = {
    isScanning: false,
    logs: [] 
};

// 1. Cache bộ nhớ: Chứa ID và Duration của các bài hát ĐÃ CÓ trong DB
let dbCache = new Map(); 

// 2. Tập hợp chứa tất cả ID tìm thấy thực tế trên Drive
let foundFileIds = new Set(); 

function addScanLog(message) {
    console.log(message);
    const time = new Date().toLocaleTimeString('vi-VN');
    scanState.logs.push(`[${time}] ${message}`);
    if (scanState.logs.length > 5000) scanState.logs.shift();
}

function getScanStatus() { return scanState; }

// Cache thư viện music-metadata
let mmLibrary;
async function getMusicMetadata() {
    if (!mmLibrary) mmLibrary = await import('music-metadata');
    return mmLibrary;
}

// --- HÀM 1: CHUẨN BỊ CACHE TỪ DB ---
function loadDbToCache() {
    try {
        const rows = db.prepare('SELECT id, duration FROM songs').all();
        dbCache.clear();
        rows.forEach(row => {
            dbCache.set(row.id, row.duration);
        });
        addScanLog(`⚡ Đã tải cache: ${rows.length} bài hát hiện có.`);
    } catch (e) {
        console.error("Lỗi load cache:", e);
    }
}

// --- HÀM 2: LIST FILES TỪ DRIVE ---
async function listFiles(folderId) {
    try {
        const res = await drive.files.list({
            q: `'${folderId}' in parents and (mimeType = 'audio/mpeg' or mimeType = 'application/vnd.google-apps.folder') and trashed = false`,
            fields: 'files(id, name, mimeType, size, webContentLink, videoMediaMetadata)',
            pageSize: 1000,
            supportsAllDrives: true, 
            includeItemsFromAllDrives: true 
        });
        return res.data.files;
    } catch (err) {
        addScanLog(`❌ Lỗi quét folder ${folderId}: ${err.message}`);
        return [];
    }
}

// --- HÀM 3: ĐỌC DURATION (NẶNG) ---
async function fetchDurationFromStream(fileId, fileSize, fileName) {
    try {
        const mm = await getMusicMetadata();
        const res = await drive.files.get(
            { fileId: fileId, alt: 'media', supportsAllDrives: true },
            { responseType: 'stream' }
        );

        const metadata = await mm.parseStream(res.data, { mimeType: 'audio/mpeg', size: parseInt(fileSize) }, {
            duration: true, skipCovers: true, skipPostHeaders: true 
        });
        
        res.data.destroy(); 
        if (metadata?.format?.duration) return Math.floor(metadata.format.duration);
    } catch (e) {}
    return 0;
}

// --- HÀM 4: XỬ LÝ 1 FILE (CORE LOGIC) ---
// [CẬP NHẬT] Thêm tham số forceUpdate = false
async function processSingleFile(file, folderPath, forceUpdate = false) {
    foundFileIds.add(file.id); 

    const cachedDuration = dbCache.get(file.id);
    
    // [QUAN TRỌNG] Logic bỏ qua xử lý nặng:
    // Chỉ bỏ qua khi: KHÔNG phải force update VÀ đã có duration trong Cache
    if (!forceUpdate && cachedDuration && cachedDuration > 0) {
        // Light Update: Chỉ cập nhật tên, link, folder, size (đề phòng đổi tên/di chuyển)
        const stmt = db.prepare(`
            UPDATE songs SET name = ?, drive_link = ?, folder_path = ?, size = ? WHERE id = ?
        `);
        stmt.run(file.name, file.webContentLink, folderPath, file.size, file.id);
        return 0; 
    }

    // --- NẾU XUỐNG ĐÂY: LÀ FILE MỚI HOẶC ĐANG FORCE UPDATE ---
    
    let duration = 0;
    
    // 1. Ưu tiên lấy từ Google Metadata (Nhanh)
    if (file.videoMediaMetadata && file.videoMediaMetadata.durationMillis) {
        duration = Math.floor(parseInt(file.videoMediaMetadata.durationMillis) / 1000);
    }

    // 2. Nếu Google chưa index hoặc forceUpdate mà duration = 0 -> Tải stream về soi lại
    if (duration === 0) {
        // addScanLog(`🔍 Phân tích sâu: ${file.name}`);
        duration = await fetchDurationFromStream(file.id, file.size, file.name);
    }

    // 3. Ghi vào DB (Upsert - Chèn hoặc Cập nhật)
    // [FIX SQL] Đảm bảo cập nhật toàn bộ thông tin khi Conflict (trùng ID)
    const stmt = db.prepare(`
        INSERT INTO songs (id, name, size, drive_link, folder_path, duration)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            duration = excluded.duration,      -- Cập nhật thời lượng mới
            size = excluded.size,              -- Cập nhật dung lượng mới
            drive_link = excluded.drive_link,  -- Cập nhật link mới
            folder_path = excluded.folder_path,
            name = excluded.name
    `);
    
    const info = stmt.run(file.id, file.name, file.size, file.webContentLink, folderPath, duration);
    
    // Cập nhật lại cache RAM để đồng bộ
    if (duration > 0) {
        dbCache.set(file.id, duration);
        if (forceUpdate) console.log(`✨ Đã làm mới metadata: ${file.name} (${duration}s)`);
    }

    return info.changes > 0 ? 1 : 0;
}

// Hàm dọn dẹp file rác
function cleanupDeletedFiles() {
    addScanLog(`🧹 Đang dọn dẹp file đã xóa trên Drive...`);
    let deletedCount = 0;
    const deleteStmt = db.prepare('DELETE FROM songs WHERE id = ?');

    for (const [id, _] of dbCache) {
        if (!foundFileIds.has(id)) {
            deleteStmt.run(id);
            deletedCount++;
        }
    }

    if (deletedCount > 0) addScanLog(`🗑️ Đã xóa ${deletedCount} bài hát rác.`);
    else addScanLog(`✅ Database sạch sẽ.`);
    return deletedCount;
}

// --- HÀM 5: QUÉT ĐỆ QUY CHÍNH ---
async function scanFolderRecursive(folderId, parentPath = '') {
    if (folderId === process.env.DRIVE_FOLDER_ID && !parentPath) {
        scanState.isScanning = true;
        scanState.logs = [];
        foundFileIds.clear(); 
        addScanLog(`🚀 BẮT ĐẦU QUÉT (INCREMENTAL)...`);
        loadDbToCache();
    }

    let count = 0;
    const files = await listFiles(folderId);
    
    let currentFolderName = '';
    if (!parentPath) {
        try {
            const res = await drive.files.get({ fileId: folderId, fields: 'name', supportsAllDrives: true });
            currentFolderName = res.data.name;
        } catch(e) {}
    }

    const subFolders = files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    const songFiles = files.filter(f => f.mimeType !== 'application/vnd.google-apps.folder');

    for (const folder of subFolders) {
        const subPath = parentPath ? path.join(parentPath, folder.name) : folder.name;
        count += await scanFolderRecursive(folder.id, subPath);
    }

    const folderPath = parentPath || currentFolderName || 'Root';
    const BATCH_SIZE = 10; 

    if (songFiles.length > 0) {
        for (let i = 0; i < songFiles.length; i += BATCH_SIZE) {
            const batch = songFiles.slice(i, i + BATCH_SIZE);
            // Gọi processSingleFile mặc định (forceUpdate = false)
            const results = await Promise.all(batch.map(file => processSingleFile(file, folderPath, false)));
            count += results.reduce((a, b) => a + b, 0);
        }
    }

    if (folderId === process.env.DRIVE_FOLDER_ID && !parentPath) {
        const deleted = cleanupDeletedFiles();
        scanState.isScanning = false;
        dbCache.clear(); 
        addScanLog(`🎉 HOÀN TẤT! Cập nhật: ${count}. Xóa: ${deleted}.`);
    }

    return count;
}

// --- HÀM 6: QUÉT NHANH 1 FILE (Hỗ trợ Force Update) ---
// [CẬP NHẬT] Thêm tham số forceUpdate = false
async function scanNewFile(fileId, forceUpdate = false) {
    try {
        const res = await drive.files.get({
            fileId: fileId,
            fields: 'id, name, mimeType, size, webContentLink, videoMediaMetadata, parents',
            supportsAllDrives: true
        });
        const file = res.data;

        let folderName = 'Downloads'; 
        if (file.parents && file.parents.length > 0) {
            try {
                const parentRes = await drive.files.get({
                    fileId: file.parents[0],
                    fields: 'name',
                    supportsAllDrives: true
                });
                folderName = parentRes.data.name.trim();
            } catch(e) {}
        }

        // Truyền forceUpdate xuống processSingleFile
        await processSingleFile(file, folderName, forceUpdate);
        
        return true;
    } catch (e) {
        console.error(`❌ Lỗi scanNewFile ${fileId}:`, e.message);
        return false;
    }
}

module.exports = { scanFolderRecursive, getScanStatus, scanNewFile };

loadDbToCache();