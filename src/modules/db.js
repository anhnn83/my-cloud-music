// src/modules/db.js - Version 2.1 (PlaybackRate)

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Đảm bảo thư mục data tồn tại
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'music.db'); 
const db = new Database(dbPath);

// --- 1. TẠO CÁC BẢNG CƠ BẢN (NẾU CHƯA CÓ) ---

// Bảng bài hát
db.exec(`
  CREATE TABLE IF NOT EXISTS songs (
    id TEXT PRIMARY KEY,
    name TEXT,
    size INTEGER,
    drive_link TEXT, 
    folder_path TEXT,
    duration INTEGER,
    is_favorite INTEGER DEFAULT 0
  )
`);

// Bảng lịch sử nghe
db.exec(`
  CREATE TABLE IF NOT EXISTS playback_history (
    song_id TEXT PRIMARY KEY,
    current_time INTEGER,
    context_path TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Bảng cài đặt người dùng
db.exec(`
  CREATE TABLE IF NOT EXISTS user_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    play_from_start INTEGER DEFAULT 0,
    skip_mode INTEGER DEFAULT 0,
    skip_start INTEGER DEFAULT 5,
    skip_end INTEGER DEFAULT 10
  )
`);

// Tạo dữ liệu cài đặt mặc định nếu chưa có
db.exec(`INSERT OR IGNORE INTO user_settings (id) VALUES (1)`);


// --- 2. HÀM MIGRATION AN TOÀN (TỰ ĐỘNG SỬA LỖI THIẾU CỘT) ---

function addColumnIfNotExists(tableName, columnName, columnDef) {
    try {
        // Lấy danh sách cột hiện tại của bảng
        const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
        const exists = columns.some(c => c.name === columnName);
        
        if (!exists) {
            console.log(`⚡ Đang thêm cột '${columnName}' vào bảng '${tableName}'...`);
            db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
            console.log(`✅ Đã thêm cột '${columnName}' thành công.`);
            
            // LOGIC RIÊNG: Nếu là cột created_at, cập nhật luôn dữ liệu cho các bài cũ
            if (columnName === 'created_at') {
                console.log(`⏳ Đang cập nhật thời gian cho các bài hát cũ...`);
                db.exec("UPDATE songs SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL");
            }
        }
    } catch (error) {
        console.error(`❌ Lỗi Migration (${columnName}):`, error.message);
    }
}

// --- 3. THỰC HIỆN CẬP NHẬT DB ---

// Thêm cột Shuffle/Repeat cho User Settings
addColumnIfNotExists('user_settings', 'shuffle_mode', 'INTEGER DEFAULT 0');
addColumnIfNotExists('user_settings', 'repeat_mode', 'INTEGER DEFAULT 0');

// Thêm cột Điểm Nhiệt (Trending Score) cho bài hát
addColumnIfNotExists('songs', 'trending_score', 'REAL DEFAULT 0');

// [QUAN TRỌNG] Thêm cột Thời gian tạo (Created At) để sửa lỗi của bạn
addColumnIfNotExists('songs', 'created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');

// Chạy thêm một lần nữa lệnh update để đảm bảo 100% bài cũ không bị NULL
try {
    db.exec("UPDATE songs SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL");
} catch(e) {}

// [MỚI] Thêm cột Tốc độ phát (Playback Rate) - Mặc định là 1.0 (100%)
addColumnIfNotExists('user_settings', 'playback_rate', 'REAL DEFAULT 1.0');

console.log('✅ Database đã sẵn sàng (SQLite): music.db');

module.exports = { db };