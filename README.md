# 🎵 My Cloud Music — Personal Streaming & Downloader PWA

[![Backend](https://img.shields.io/badge/Backend-Node.js%20%7C%20Fastify-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](#)
[![Database](https://img.shields.io/badge/Database-SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](#)
[![Frontend](https://img.shields.io/badge/Frontend-Vanilla%20JS%20%7C%20PWA-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](#)
[![Tunnel](https://img.shields.io/badge/Network-Cloudflare%20Tunnel-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](#)
[![Docker](https://img.shields.io/badge/Deploy-Docker%20Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white)](#)

> **My Cloud Music** là hệ thống máy chủ phát nhạc, truyện và sách nói cá nhân, kết hợp với giao diện Web App (PWA) hiện đại. Hệ thống cho phép bạn đồng bộ nhạc từ Google Drive, tải nhạc trực tiếp từ YouTube, và đặc biệt là khả năng nghe nhạc/quản lý bộ nhớ Offline hoàn hảo trên các thiết bị di động. 
> *Dự án được tối ưu hóa đặc biệt cho sở thích nghe sách/truyện của tác giả (tự động lưu tiến độ, cắt intro/outro, chỉnh tốc độ phát...).* 😁

---

> 💡 **Tip cho Coder:** Hãy copy-paste toàn bộ nội dung tài liệu này cho một AI (ChatGPT/Gemini/Claude...) để nó có ngữ cảnh và giúp bạn gỡ lỗi, deploy dự án hoặc phát triển tính năng mới nhanh chóng hơn!

---

## ✨ 1. Giới thiệu & Các tính năng cốt lõi

Dự án này là giải pháp thay thế hoàn hảo cho các nền tảng streaming trả phí, giúp bạn sở hữu trọn vẹn thư viện âm nhạc và sách nói của riêng mình với trải nghiệm mượt mà không thua kém các ứng dụng Native (app gốc).

**🚀 Ưu điểm vượt trội**

* **Chuẩn PWA (Progressive Web App):** Chỉ cần mở bằng trình duyệt một lần là chạy, không cần cài đặt lằng nhằng. Bạn có thể sử dụng trên ô tô, TV, điện thoại, máy tính... & mọi dữ liệu tiến độ luôn được đồng bộ.
* **Hỗ trợ nghe Sách nói / Truyện chuyên sâu:**
  * Thay đổi tốc độ phát (nhanh/chậm) linh hoạt theo nhu cầu.
  * Tính năng **Skip Mode**: Tự động bỏ qua đoạn đầu (Intro - nhạc hiệu) và đoạn cuối (Outro - quảng cáo/lời chào) theo số giây tùy chỉnh cho từng tập truyện.
  * Tự động lưu và khôi phục tiến độ phát (vị trí giây chính xác) của bài hát/truyện nghe từ phiên trước/thiết bị khác.
* **Nghe nhạc Offline thông minh:** Quản lý kho nhạc Offline cục bộ trên trình duyệt (sử dụng IndexedDB). Hỗ trợ tải hàng loạt thư mục với giao diện Progress Bar trực quan và API Wake Lock chống tắt màn hình khi đang tải nền trên điện thoại.
* **Tích hợp Google Drive API:** Stream trực tiếp các file `.mp3`, `.flac` từ Google Drive cá nhân, tiết kiệm tối đa dung lượng ổ cứng cho máy chủ.
* **Tải nhạc từ YouTube nhanh chóng:** Tích hợp `yt-dlp` ở Backend, cho phép phân tích và tải trực tiếp Video/Playlist từ YouTube về thẳng thư mục Google Drive của bạn chỉ với một vài cú click.
* **Bảo mật & Linh hoạt:** Truy cập từ xa an toàn qua Cloudflare Tunnel tích hợp sẵn, không cần NAT Port hay mở cổng Router. Mọi truy cập trên thiết bị lạ được bảo vệ bằng mã PIN an toàn.

**👥 Đối tượng sử dụng**

* Những người đã hoặc muốn có 1 kho nhạc, sách/truyện khổng lồ trên Google Drive và đưọc quản lý bởi một ứng dụng chuyên nghiệp.
* Những ai muốn tự host dịch vụ nghe nhạc cá nhân riêng tư, không quảng cáo, nghe offline mọi lúc mọi nơi.
* **Yêu cầu phần cứng cực thấp:** Chỉ cần một tài khoản Google Drive dung lượng thoải mái (>100 GB) và một VPS cấu hình thấp (~1 Core / 1 GB RAM / 20GB Storage - cấu hình mặc định của **AWS Free Tier** hoặc Oracle Cloud Free là đủ xài thoải mái).

---

## 🛠️ 2. Môi trường chuẩn bị

Nhờ việc đóng gói toàn bộ hệ thống bằng Docker, môi trường máy chủ (VPS, Raspberry Pi, hoặc PC) của bạn **không cần cài đặt Node.js, Python, FFmpeg hay yt-dlp**. Tất cả đã được cấu hình tự động bên trong Container.

Bạn chỉ cần chuẩn bị duy nhất:
1. **Docker & Docker Compose** đã được cài đặt sẵn trên máy chủ.
2. **Google API Credentials:** File `credentials.json` cấp quyền Google Drive API (Xem hướng dẫn tạo chi tiết ngay trong file `credentials.json.example`).
3. **Cookie YouTube (`cookies.txt`):** Để bypass captcha hoặc tải các video giới hạn độ tuổi trên YouTube (Xem hướng dẫn lấy trong `cookies.txt.example`).
4. **Cloudflare Tunnel Token:** Token để kết nối mạng bảo mật của Cloudflare đưa ứng dụng ra Internet thông qua tên miền riêng.

---

## 🚀 3. Hướng dẫn triển khai (Deploy)

Thực hiện tuần tự theo các bước dưới đây để chạy hệ thống:

**Bước 3.1: Tải mã nguồn về máy chủ**
Mở Terminal của VPS và chạy lệnh:
```bash
git clone https://github.com/cronpostps/my-cloud-music.git
cd my-cloud-music
```

**Bước 3.2: Thiết lập các file cấu hình**
Hệ thống cần 3 file cấu hình chính để vận hành. Hãy tạo bản sao từ các file `.example` và điền thông tin của bạn:

1. **File Biến môi trường (`.env`):**
   ```bash
   cp .env.example .env
   ```
   Mở file `.env` và thiết lập các thông số:
   * `PORT`: Cổng chạy ứng dụng (Mặc định `3000`).
   * `DRIVE_FOLDER_ID`: ID thư mục gốc trên Google Drive để quét nhạc.
   * `DRIVE_DOWNLOAD_FOLDER_ID`: ID thư mục trên Drive dùng để lưu nhạc khi tải từ YouTube về.
   * `TUNNEL_TOKEN`: Token Cloudflare Tunnel của bạn để public app ra ngoài.
   * `APP_PIN`: Mã PIN 6 số dùng để đăng nhập mở khóa giao diện nghe nhạc.
   * `CACHE_LIMIT_GB`: Giới hạn dung lượng cache tối đa trên ổ cứng VPS (Mặc định `15` GB). Hệ thống sẽ tự động dọn dẹp khi vượt ngưỡng, giúp VPS không bao giờ bị đầy ổ cứng.

2. **File xác thực Google Drive (`credentials.json`):**
   Lấy file JSON xác thực từ Google Cloud Console (theo các bước chi tiết trong `credentials.json.example`) rồi đặt vào thư mục gốc dự án với tên `credentials.json`.

3. **File Cookie YouTube (`cookies.txt`):**
   ```bash
   cp cookies.txt.example cookies.txt
   ```
   Dán nội dung cookie tài khoản YouTube của bạn vào file này để hỗ trợ `yt-dlp` tải danh sách mượt mà, tránh bị chặn.

**Bước 3.3: Khởi chạy hệ thống bằng Docker**
Chạy lệnh duy nhất sau để tự động build môi trường và chạy nền ứng dụng:
```bash
docker compose up --build -d
```
Docker sẽ tự động kích hoạt 2 dịch vụ song song: Máy chủ ứng dụng (`music-player`) và Cổng kết nối bảo mật (`music-tunnel`).

---

## 🔑 4. Thiết lập và sử dụng lần đầu

1. Truy cập vào ứng dụng thông qua tên miền riêng bạn đã trỏ qua Cloudflare Tunnel (VD: `https://music.domain-cua-ban.com`).
2. **Nhập mã PIN** 6 số bảo mật mà bạn đã thiết lập trong file `.env`.
3. Tại giao diện chính, bấm vào biểu tượng **Đồng bộ 🔄** ở thanh tiêu đề trên cùng để hệ thống quét thư mục Google Drive ngầm và nạp danh sách bài hát/truyện vào cơ sở dữ liệu SQLite cục bộ.
4. Trên trình duyệt điện thoại (Safari trên iOS hoặc Chrome trên Android), hãy chọn chức năng **Thêm vào màn hình chính (Add to Home Screen)** để cài đặt PWA độc lập, giúp giao diện hiển thị full màn hình và kích hoạt các tính năng chạy Offline hoàn hảo.

---

## ☎️ 5. Liên hệ với tác giả

**Nguyễn Ngọc Anh**

➤ **Telegram:** [t.me/anhnn83](https://t.me/anhnn83)

✉ **Email:** [anhnn@dgd.vn](mailto:anhnn@dgd.vn)

## License
Dự án này được cấp phép theo các điều khoản của [GNU General Public License v3.0](LICENSE). Tất cả các tệp mã nguồn trong kho lưu trữ này đều thuộc phạm vi áp dụng của giấy phép này trừ khi có tuyên bố khác.

Mã nguồn gốc © [My Cloud Music by anhnn](https://github.com/cronpostps/my-cloud-music)