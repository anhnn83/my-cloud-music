# Dockerfile - Final Stable (Debian Slim)
FROM node:20-slim

WORKDIR /app

# 1. Cài đặt Python, FFmpeg và gói 'which'
# - build-essential, libffi-dev: Để cài curl-cffi
# - which: Để yt-dlp tìm thấy lệnh 'node'
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    build-essential \
    libffi-dev \
    which \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 2. Tạo Symlink (Chỉ đường dẫn)
RUN ln -s /usr/bin/python3 /usr/bin/python && \
    ln -s /usr/local/bin/node /usr/bin/node && \
    ln -s /usr/local/bin/node /usr/bin/nodejs

# 3. Cài đặt yt-dlp + curl-cffi
# - curl-cffi: Hỗ trợ tính năng impersonate
# - yt-dlp[default]: Cài đầy đủ modules
RUN pip3 install --no-cache-dir "yt-dlp[default,curl-cffi]" pycryptodomex mutagen brotli certifi --break-system-packages

# 4. Setup App
RUN mkdir -p /app/temp_downloads && chmod 777 /app/temp_downloads
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 3000
CMD ["node", "src/app.js"]