const Database = require('better-sqlite3');
const path = require('path');

// Đường dẫn DB (trong Docker nó thường nằm ở /app/data hoặc ../data tùy cấu trúc)
// Ta dùng đường dẫn tương đối để tìm
const dbPath = path.join(__dirname, '../data/music.db'); 
console.log("📂 Đang tìm Database tại:", dbPath);

const db = new Database(dbPath);

try {
    console.log("⚡ Đang thêm cột created_at...");
    db.exec("ALTER TABLE songs ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP");
    console.log("✅ Thành công: Đã thêm cột created_at.");
} catch (e) {
    if (e.message.includes('duplicate column')) {
        console.log("⚠️ Cột này đã tồn tại rồi.");
    } else {
        console.error("❌ Lỗi:", e.message);
    }
}

try {
    console.log("⏳ Đang cập nhật ngày giờ cho bài hát cũ...");
    db.exec("UPDATE songs SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL");
    console.log("✅ Thành công: Dữ liệu đã chuẩn.");
} catch (e) {
    console.error("❌ Lỗi update:", e.message);
}