// scr/modules/cacheCleaner.js - Version 1.0

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '../../cache');

// CẤU HÌNH GIỚI HẠN
const MAX_CACHE_SIZE_GB = 10; // Giới hạn 5GB (Bạn có thể tăng lên tùy ổ cứng VPS)
const MAX_BYTES = MAX_CACHE_SIZE_GB * 1024 * 1024 * 1024;

/**
 * Hàm lấy tổng dung lượng thư mục và danh sách file
 */
function getCacheStats() {
    let totalSize = 0;
    const files = [];

    if (!fs.existsSync(CACHE_DIR)) return { totalSize, files };

    const filenames = fs.readdirSync(CACHE_DIR);

    filenames.forEach(name => {
        const filePath = path.join(CACHE_DIR, name);
        try {
            const stats = fs.statSync(filePath);
            if (stats.isFile()) {
                totalSize += stats.size;
                files.push({
                    path: filePath,
                    size: stats.size,
                    time: stats.atimeMs || stats.mtimeMs // Ưu tiên lấy thời gian truy cập cuối
                });
            }
        } catch (e) {}
    });

    return { totalSize, files };
}

/**
 * Hàm chính: Dọn dẹp cache
 */
function cleanCache() {
    console.log('🧹 Đang kiểm tra dung lượng Cache...');
    
    const { totalSize, files } = getCacheStats();
    const currentGB = (totalSize / (1024 * 1024 * 1024)).toFixed(2);

    console.log(`📊 Dung lượng hiện tại: ${currentGB} GB / ${MAX_CACHE_SIZE_GB} GB`);

    if (totalSize <= MAX_BYTES) {
        console.log('✅ Dung lượng ổn định. Không cần dọn dẹp.');
        return;
    }

    // Nếu vượt quá giới hạn -> Sắp xếp file theo thời gian (Cũ nhất lên đầu)
    // LRU (Least Recently Used) Strategy
    files.sort((a, b) => a.time - b.time);

    let freedSpace = 0;
    let deletedCount = 0;
    
    // Mục tiêu: Xóa bớt để dung lượng về mức an toàn (ví dụ 80% của Max)
    const TARGET_SIZE = MAX_BYTES * 0.8;
    let currentSize = totalSize;

    for (const file of files) {
        if (currentSize <= TARGET_SIZE) break;

        try {
            fs.unlinkSync(file.path);
            freedSpace += file.size;
            currentSize -= file.size;
            deletedCount++;
        } catch (e) {
            console.error(`Lỗi xóa file ${file.path}:`, e.message);
        }
    }

    const freedMB = (freedSpace / (1024 * 1024)).toFixed(2);
    console.log(`♻️ Đã dọn dẹp xong! Xóa ${deletedCount} file cũ, giải phóng ${freedMB} MB.`);
}

module.exports = { cleanCache };