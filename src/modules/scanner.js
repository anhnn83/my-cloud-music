// src/modules/scanner.js - Version 10.2
const drive = require('./drive');
const { db } = require('./db');
const path = require('path');

// --- QUẢN LÝ TRẠNG THÁI SCAN ---
let scanState = {
    isScanning: false,
    logs: [] 
};

// 1. Cache bộ nhớ: Chứa ID và Duration của các bài hát ĐÃ CÓ trong DB
// Để tránh việc phải đọc lại file stream những bài đã xử lý ngon lành.
let dbCache = new Map(); 

// 2. Tập hợp chứa tất cả ID tìm thấy thực tế trên Drive (Để so sánh xóa file rác)
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

// --- HÀM 1: CHUẨN BỊ CACHE TỪ DB (BÍ QUYẾT TĂNG TỐC) ---
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

// --- HÀM 3: ĐỌC DURATION (NẶNG - CHỈ CHẠY KHI CẦN) ---
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

// --- HÀM 4: XỬ LÝ 1 FILE (THÔNG MINH HƠN) ---
async function processSingleFile(file, folderPath) {
    foundFileIds.add(file.id); // Đánh dấu là file này còn tồn tại trên Drive

    // KIỂM TRA CACHE: Nếu bài này đã có trong DB và duration > 0 -> BỎ QUA XỬ LÝ NẶNG
    const cachedDuration = dbCache.get(file.id);
    
    // Logic: Nếu đã có Duration trong DB (tức là > 0), ta coi như file đã ổn.
    // Trừ khi bạn muốn cập nhật lại duration thì mới force chạy lại.
    if (cachedDuration && cachedDuration > 0) {
        // CHỈ CẬP NHẬT ĐƯỜNG DẪN (Folder Path) phòng khi di chuyển file
        // Đây là thao tác rất nhẹ (Light Update)
        const stmt = db.prepare(`
            UPDATE songs SET 
                name = ?, 
                drive_link = ?, 
                folder_path = ?, 
                size = ? 
            WHERE id = ?
        `);
        stmt.run(file.name, file.webContentLink, folderPath, file.size, file.id);
        
        // Return 0 nghĩa là "không có gì mới quan trọng", nhưng vẫn tính là đã quét
        return 0; 
    }

    // --- NẾU ĐẾN ĐÂY NGHĨA LÀ FILE MỚI HOẶC FILE CŨ BỊ LỖI (0:00) ---
    // Ta mới bắt đầu tốn tài nguyên để tính toán
    
    let duration = 0;
    // 1. Thử lấy từ Google Metadata (Nhanh)
    if (file.videoMediaMetadata?.durationMillis) {
        duration = Math.floor(parseInt(file.videoMediaMetadata.durationMillis) / 1000);
    }

    // 2. Nếu Google không có -> Tải stream (Chậm)
    if (duration === 0) {
        // addScanLog(`🔍 Đang phân tích kỹ thuật số: ${file.name}`);
        duration = await fetchDurationFromStream(file.id, file.size, file.name);
    }

    // 3. Ghi vào DB (Upsert)
    const stmt = db.prepare(`
        INSERT INTO songs (id, name, size, drive_link, folder_path, duration)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE duration END,
            drive_link = excluded.drive_link,
            folder_path = excluded.folder_path
    `);
    
    const info = stmt.run(file.id, file.name, file.size, file.webContentLink, folderPath, duration);
    
    // Cập nhật lại cache luôn để dùng cho lần sau (nếu trong cùng 1 phiên quét có lặp lại logic nào đó)
    if (duration > 0) dbCache.set(file.id, duration);

    return info.changes > 0 ? 1 : 0;
}

// Hàm dọn dẹp file rác
function cleanupDeletedFiles() {
    addScanLog(`🧹 Đang dọn dẹp file đã xóa trên Drive...`);
    
    // Vì dbCache chứa toàn bộ ID trong DB lúc đầu, ta có thể dùng nó để đối chiếu nhanh
    let deletedCount = 0;
    const deleteStmt = db.prepare('DELETE FROM songs WHERE id = ?');

    // Duyệt qua tất cả ID có trong DB
    for (const [id, _] of dbCache) {
        // Nếu ID trong DB mà KHÔNG tìm thấy trên Drive đợt này -> Xóa
        if (!foundFileIds.has(id)) {
            deleteStmt.run(id);
            deletedCount++;
        }
    }

    if (deletedCount > 0) addScanLog(`🗑️ Đã xóa ${deletedCount} bài hát rác khỏi Database.`);
    else addScanLog(`✅ Database đồng bộ hoàn toàn.`);
    return deletedCount;
}

// --- HÀM 5: QUÉT ĐỆ QUY CHÍNH ---
async function scanFolderRecursive(folderId, parentPath = '') {
    // KHI BẮT ĐẦU (ROOT)
    if (folderId === process.env.DRIVE_FOLDER_ID && !parentPath) {
        scanState.isScanning = true;
        scanState.logs = [];
        foundFileIds.clear(); 
        
        addScanLog(`🚀 BẮT ĐẦU QUÉT THÔNG MINH (INCREMENTAL SCAN)...`);
        
        // [QUAN TRỌNG] Tải dữ liệu cũ lên RAM để đối chiếu
        loadDbToCache();
    }

    // addScanLog(`📂 Quét: ...${folderId.slice(-5)}`);
    
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

    // Đệ quy Folder con
    for (const folder of subFolders) {
        const subPath = parentPath ? path.join(parentPath, folder.name) : folder.name;
        count += await scanFolderRecursive(folder.id, subPath);
    }

    // Xử lý File nhạc
    const folderPath = parentPath || currentFolderName || 'Root';
    
    // Vì ta đã có cơ chế Cache Skip, ta có thể tăng Batch Size lên để quét nhanh hơn các file đã tồn tại
    const BATCH_SIZE = 10; 

    if (songFiles.length > 0) {
        for (let i = 0; i < songFiles.length; i += BATCH_SIZE) {
            const batch = songFiles.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(file => processSingleFile(file, folderPath)));
            
            // Tính tổng số bài có sự thay đổi thực sự (Mới thêm hoặc cập nhật duration)
            count += results.reduce((a, b) => a + b, 0);
            
            // Chỉ log nếu có thay đổi hoặc định kỳ
            if ((i + BATCH_SIZE) % 50 === 0) {
                // addScanLog(`   ...Đang kiểm tra ${Math.min(i + BATCH_SIZE, songFiles.length)}/${songFiles.length} bài tại ${folderPath}`);
            }
        }
    }

    // KHI KẾT THÚC (ROOT)
    if (folderId === process.env.DRIVE_FOLDER_ID && !parentPath) {
        const deleted = cleanupDeletedFiles();
        scanState.isScanning = false;
        
        // Giải phóng RAM
        dbCache.clear(); 
        
        addScanLog(`🎉 QUÉT XONG! Thêm mới/Sửa lỗi: ${count} bài. Xóa: ${deleted} bài.`);
    }

    return count;
}

// --- HÀM MỚI: QUÉT NHANH 1 FILE VỪA UPLOAD (Dùng cho Downloader) ---
async function scanNewFile(fileId) {
    try {
        // 1. Lấy metadata của file từ Drive (để biết size, link, duration...)
        const res = await drive.files.get({
            fileId: fileId,
            fields: 'id, name, mimeType, size, webContentLink, videoMediaMetadata, parents',
            supportsAllDrives: true
        });
        const file = res.data;

        // 2. Lấy tên thư mục cha (để lưu vào DB cột folder_path)
        let folderName = 'Downloads'; // Mặc định
        if (file.parents && file.parents.length > 0) {
            try {
                const parentRes = await drive.files.get({
                    fileId: file.parents[0],
                    fields: 'name',
                    supportsAllDrives: true
                });
                folderName = parentRes.data.name;
            } catch(e) {}
        }

        // 3. Gọi hàm xử lý cốt lõi (Tận dụng logic của Scanner v10)
        // Hàm này sẽ tự động tính duration, upsert vào DB và update Cache
        await processSingleFile(file, folderName);
        
        return true;
    } catch (e) {
        console.error(`❌ Lỗi scanNewFile ${fileId}:`, e.message);
        return false;
    }
}

module.exports = { scanFolderRecursive, getScanStatus, scanNewFile };

loadDbToCache();