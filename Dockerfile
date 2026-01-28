# Dockerfile - Final Fix (Alpine + Which + PyCryptodomex)
FROM node:20-alpine

WORKDIR /app

# 1. Cài đặt các gói hệ thống CỐT LÕI
# - python3, py3-pip: Môi trường chạy yt-dlp
# - ffmpeg: Xử lý video/audio
# - which: [QUAN TRỌNG NHẤT] Giúp yt-dlp tìm thấy đường dẫn Node.js (Fix lỗi Runtime)
# - build-base, python3-dev: Để cài thư viện giải mã
RUN apk add --no-cache python3 py3-pip ffmpeg which build-base python3-dev

# 2. Tạo liên kết (Symlink) - Chỉ đường rõ ràng
# yt-dlp thường tìm node ở /usr/bin/node
RUN ln -s /usr/local/bin/node /usr/bin/node || true
# Tạo liên kết python -> python3 (fix lỗi npm install)
RUN ln -sf /usr/bin/python3 /usr/bin/python

# 3. Cài đặt yt-dlp và thư viện giải mã Native
# pycryptodomex: Giải mã chữ ký YouTube bằng C++ (Không cần JS, cực nhanh)
RUN pip install --no-cache-dir yt-dlp pycryptodomex mutagen --break-system-packages

# 4. Dọn dẹp bộ biên dịch (để image nhẹ lại)
RUN apk del build-base python3-dev

# 5. Setup thư mục
RUN mkdir -p /app/temp_downloads && chmod 777 /app/temp_downloads

# 6. Cài đặt App
COPY package*.json ./
RUN npm install --production

# 7. Copy code
COPY . .

# Mở port
EXPOSE 3000

# Chạy ứng dụng
CMD ["node", "src/app.js"]