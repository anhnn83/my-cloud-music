// src/modules/cacheCleaner.js - Version 2.0 (Async & Non-blocking)

const fs = require('fs').promises; // Dùng thư viện Promise để không chặn luồng
const path = require('path');

const CACHE_DIR = path.join(__dirname, '../../cache');

// Lấy cấu hình từ biến môi trường (Mặc định 10GB nếu không set)
// Bạn nên thêm dòng CACHE_LIMIT_GB=15 vào file .env
const MAX_CACHE_SIZE_GB = parseInt(process.env.CACHE_LIMIT_GB) || 10;
const MAX_BYTES = MAX_CACHE_SIZE_GB * 1024 * 1024 * 1024;

/**
 * Hàm lấy thống kê cache (Bất đồng bộ)
 */
async function getCacheStats() {
    let totalSize = 0;
    const files = [];

    try {
        // Kiểm tra thư mục có tồn tại không
        await fs.access(CACHE_DIR);
        
        const filenames = await fs.readdir(CACHE_DIR);

        // Dùng Promise.all để đọc thông tin file song song (Nhanh hơn)
        await Promise.all(filenames.map(async (name) => {
            const filePath = path.join(CACHE_DIR, name);
            try {
                const stats = await fs.stat(filePath);
                if (stats.isFile()) {
                    totalSize += stats.size;
                    files.push({
                        path: filePath,
                        size: stats.size,
                        time: stats.atimeMs || stats.mtimeMs // Ưu tiên thời gian truy cập
                    });
                }
            } catch (e) {
                // Bỏ qua lỗi nếu file bị xóa trong lúc đang đọc
            }
        }));

    } catch (e) {
        // Nếu thư mục chưa tồn tại thì thôi
        return { totalSize: 0, files: [] };
    }

    return { totalSize, files };
}

/**
 * Hàm chính: Dọn dẹp cache
 */
async function cleanCache() {
    // console.log('🧹 [Cache] Đang kiểm tra dung lượng...');
    
    try {
        const { totalSize, files } = await getCacheStats();
        const currentGB = (totalSize / (1024 * 1024 * 1024)).toFixed(2);

        if (totalSize <= MAX_BYTES) {
            // Chỉ log nếu gần đầy để đỡ spam console
            if (totalSize > MAX_BYTES * 0.8) {
                console.log(`📊 Cache ổn định: ${currentGB} / ${MAX_CACHE_SIZE_GB} GB`);
            }
            return;
        }

        console.log(`⚠️ Cache đầy (${currentGB} GB). Bắt đầu dọn dẹp...`);

        // Sắp xếp: Cũ nhất lên đầu
        files.sort((a, b) => a.time - b.time);

        let freedSpace = 0;
        let deletedCount = 0;
        
        // Mục tiêu: Xóa về mức 80%
        const TARGET_SIZE = MAX_BYTES * 0.8;
        let currentSize = totalSize;

        for (const file of files) {
            if (currentSize <= TARGET_SIZE) break;

            try {
                await fs.unlink(file.path); // Xóa file bất đồng bộ
                freedSpace += file.size;
                currentSize -= file.size;
                deletedCount++;
            } catch (e) {
                console.error(`Lỗi xóa ${path.basename(file.path)}:`, e.message);
            }
        }

        const freedMB = (freedSpace / (1024 * 1024)).toFixed(2);
        console.log(`♻️ Đã giải phóng: ${freedMB} MB. Xóa ${deletedCount} file cũ.`);

    } catch (err) {
        console.error('❌ Lỗi quy trình dọn cache:', err);
    }
}

module.exports = { cleanCache };