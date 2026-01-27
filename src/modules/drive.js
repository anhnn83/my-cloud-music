// src/modules/drive.js

const { google } = require('googleapis');
const path = require('path');

// Đường dẫn đến file credentials (service account)
const KEY_FILE_PATH = path.join(__dirname, '../../credentials.json');

// Cấu hình quyền truy cập
// QUAN TRỌNG: Phải dùng quyền 'https://www.googleapis.com/auth/drive'
// để có thể ĐỌC, GHI, XÓA file (thay vì chỉ .readonly như cũ)
const SCOPES = ['https://www.googleapis.com/auth/drive'];

const auth = new google.auth.GoogleAuth({
  keyFile: KEY_FILE_PATH,
  scopes: SCOPES,
});

const drive = google.drive({ version: 'v3', auth });

module.exports = drive;