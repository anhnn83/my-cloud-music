// src/modules/db.js

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Đảm bảo thư mục data tồn tại
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// [SỬA LẠI TÊN FILE CHO ĐÚNG VỚI CỦA BẠN]
const dbPath = path.join(dataDir, 'music.db'); 
const db = new Database(dbPath);

// --- TẠO BẢNG DỮ LIỆU ---

// 1. Bảng bài hát (Songs) - Có thêm cột drive_link
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

// 2. Bảng lịch sử nghe
db.exec(`
  CREATE TABLE IF NOT EXISTS playback_history (
    song_id TEXT PRIMARY KEY,
    current_time INTEGER,
    context_path TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// [MỚI] Bảng cài đặt người dùng (User Settings)
db.exec(`
  CREATE TABLE IF NOT EXISTS user_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1), -- Chỉ cho phép 1 dòng duy nhất
    play_from_start INTEGER DEFAULT 0,
    skip_mode INTEGER DEFAULT 0,
    skip_start INTEGER DEFAULT 5,
    skip_end INTEGER DEFAULT 10
  )
`);

// Tạo sẵn dữ liệu mặc định nếu chưa có
db.exec(`INSERT OR IGNORE INTO user_settings (id) VALUES (1)`);

console.log('✅ Database đã sẵn sàng (SQLite): music.db');

module.exports = { db };