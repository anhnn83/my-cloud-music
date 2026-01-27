# Giữ nguyên Node 20 Alpine như cũ
FROM node:20-alpine

# Thiết lập thư mục làm việc
WORKDIR /app

# --- PHẦN CẬP NHẬT: CÀI ĐẶT DEPENDENCIES ---
# 1. Cài đặt các công cụ build cho better-sqlite3 (python3, make, g++)
# 2. Cài đặt FFmpeg và Wget cho tính năng tải nhạc
RUN apk add --no-cache python3 make g++ ffmpeg wget

# 3. Tải và cài đặt yt-dlp binary thủ công từ GitHub
# Đặt nó vào /usr/local/bin để có thể gọi từ bất cứ đâu
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# 4. Tạo thư mục tạm để chứa file đang tải
# Cấp quyền ghi để tránh lỗi permission
RUN mkdir -p /app/temp_downloads && chmod 777 /app/temp_downloads
# -------------------------------------------

# Copy package.json trước để tận dụng Docker cache
COPY package*.json ./

# Cài đặt packages (bao gồm yt-dlp-exec mới thêm)
RUN npm install --production

# Copy toàn bộ source code vào
COPY . .

# Mở port
EXPOSE 3000

# Chạy ứng dụng
CMD ["node", "src/app.js"]