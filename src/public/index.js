// src/public/index.js - Version 2.8
console.log("--- src/public/index.js - Version 2.7 ---");

let scanInterval = null;
let allSongs = [], currentPlaylist = [], currentIndex = -1;
let isPlaying = false, isShuffle = false, loopMode = 0;
const audio = document.getElementById('audio');
const seekBar = document.getElementById('seekBar');

// Biến cho tính năng Preload (Tải trước)
let pendingNextIndex = -1;
let isPreloaded = false;

// --- 1. KHỞI TẠO ---
async function init() {
    try {
        const res = await fetch('/api/songs');
        const data = await res.json();
        allSongs = data.data; 
        document.getElementById('count').innerText = data.total;

        // Tạo danh sách thư mục
        const folders = [...new Set(allSongs.map(s => (s.folder_path || 'Root').trim()))];
        const select = document.getElementById('folderFilter');
        while (select.options.length > 2) select.remove(2);
        folders.sort().forEach(f => {
            const opt = document.createElement('option');
            opt.value = f; 
            opt.innerText = f.replace('/', '📁 '); 
            select.appendChild(opt);
        });

        currentPlaylist = [...allSongs];
        renderPlaylist();
        checkLastSession();
    } catch (e) { console.error(e); }
}

// [MỚI] Hàm hiển thị trạng thái
// timeout: thời gian tự tắt (mili giây). Nếu = 0 thì hiện mãi.
let statusTimeout;
function showStatus(text, timeout = 3000) {
    const el = document.getElementById('statusBar');
    if (!el) return;
    
    el.innerText = text;
    el.classList.add('show');

    // Reset timer cũ nếu có
    if (statusTimeout) clearTimeout(statusTimeout);

    if (timeout > 0) {
        statusTimeout = setTimeout(() => {
            el.classList.remove('show');
        }, timeout);
    }
}

async function checkLastSession() {
    try {
        const res = await fetch('/api/last-session');
        const lastSession = await res.json();
        if (lastSession) {
            const song = allSongs.find(s => s.id === lastSession.song_id);
            if (song) {
                // 1. Khôi phục Folder Context
                const folderSelect = document.getElementById('folderFilter');
                if (lastSession.context_path) {
                    folderSelect.value = lastSession.context_path;
                    
                    // Nếu folder cũ không còn tồn tại trong list option -> về mặc định 'all'
                    if (folderSelect.selectedIndex === -1) {
                        folderSelect.value = 'all';
                    }
                }

                // 2. Kích hoạt lọc lại playlist theo folder vừa set
                // (Để currentPlaylist khớp với ngữ cảnh cũ)
                filterPlaylist(); 

                // 3. Khôi phục bài hát
                song.current_time = lastSession.current_time;
                updatePlayerUI(song);
                
                // Tìm lại index trong playlist MỚI (đã lọc)
                const idx = currentPlaylist.findIndex(s => s.id === song.id);
                if (idx !== -1) currentIndex = idx;
                
                // Load bài (không autoplay)
                loadSong(song, false);
            }
        }
    } catch (e) { console.error(e); }
}

// Scan logs
async function updateLibrary() {
    const btn = document.getElementById('btnScan');
    const icon = document.getElementById('scanIcon');
    
    if(!confirm('Bạn có muốn quét lại toàn bộ thư viện nhạc trên Drive?')) return;

    // 1. Hiệu ứng giao diện
    btn.disabled = true;           // Disable nút bấm
    icon.classList.add('spinning'); // Thêm class xoay
    showStatus("🔄 Đang kết nối máy chủ...", 0); // Hiện status mãi mãi

    try {
        // 2. Gọi lệnh quét
        await fetch('/api/scan');
        showStatus("📡 Đang quét dữ liệu từ Google Drive...", 0);

        // 3. Polling (Chỉ kiểm tra xong hay chưa, không cần lấy log)
        if (scanInterval) clearInterval(scanInterval);
        
        scanInterval = setInterval(async () => {
            try {
                const res = await fetch('/api/scan/status');
                const data = await res.json();

                // Nếu backend báo đã xong (isScanning = false)
                if (!data.isScanning) {
                    clearInterval(scanInterval);
                    
                    // Tắt hiệu ứng xoay ngay lập tức
                    btn.disabled = false;
                    icon.classList.remove('spinning');
                    
                    // Báo hoàn tất
                    showStatus("✅ Hoàn tất! Đang tải lại danh sách...", 0);
                    
                    // Đợi 2 giây cho người dùng đọc rồi mới reload
                    setTimeout(() => {
                        location.reload();
                    }, 2000);
                } else {
                    // Vẫn đang quét -> Update text cho đỡ chán
                    // (Lấy dòng log cuối cùng từ backend hiển thị lên status bar cho chuyên nghiệp)
                    if (data.logs && data.logs.length > 0) {
                        const lastLog = data.logs[data.logs.length - 1];
                        // Cắt bỏ timestamp [12:00:00] cho ngắn gọn
                        const shortMsg = lastLog.replace(/^\[.*?\]\s*/, ''); 
                        showStatus("Scan: " + shortMsg, 0);
                    }
                }
            } catch (e) { console.error(e); }
        }, 2000); // 2 giây hỏi 1 lần cho nhẹ server

    } catch (err) {
        alert('Lỗi: ' + err.message);
        btn.disabled = false;
        icon.classList.remove('spinning');
        showStatus("❌ Lỗi kết nối!", 5000);
    }
}

// --- 2. LOGIC TÍNH TOÁN BÀI TIẾP THEO (PRELOAD) ---
function prepareNextSong() {
    if (!currentPlaylist.length) {
        pendingNextIndex = -1;
        return;
    }

    if (isShuffle) {
        // Random nhưng tránh trùng bài hiện tại (nếu list > 1)
        let n;
        do { 
            n = Math.floor(Math.random() * currentPlaylist.length); 
        } while (n === currentIndex && currentPlaylist.length > 1);
        pendingNextIndex = n;
    } else {
        // Tuần tự
        let n = currentIndex + 1;
        if (n >= currentPlaylist.length) n = 0;
        pendingNextIndex = n;
    }
}

// --- 3. CORE: LOAD & PLAY SONG ---
function loadSong(song, autoPlay = true) {
    updatePlayerUI(song);
    updateMediaSession(song);
    // Reset trạng thái preload cho bài mới
    isPreloaded = false;
    prepareNextSong();

    // A. Reset Audio Element
    audio.pause();
    audio.onloadedmetadata = null;
    audio.onerror = null;

    // B. Sự kiện Metadata
    audio.onloadedmetadata = () => {
        const cbStart = document.getElementById('cbPlayFromStart').checked;
        const cbSkip = document.getElementById('cbSkipMode').checked;
        const skipStartVal = parseInt(document.getElementById('inpSkipStart').value) || 0;

        let startTime = 0;

        // 1. Nếu KHÔNG check "Phát từ đầu" -> Thì mới lấy lịch sử từ DB
        if (!cbStart && song.current_time && song.current_time > 5 && song.current_time < song.duration - 5) {
            startTime = song.current_time;
        }

        // 2. Nếu check "Bỏ qua..." -> Đảm bảo bắt đầu tối thiểu từ giây thứ X
        if (cbSkip) {
            if (startTime < skipStartVal) {
                startTime = skipStartVal;
            }
        }

        // Gán thời gian bắt đầu
        audio.currentTime = startTime;
        
        if(autoPlay) {
            var playPromise = audio.play();
            if (playPromise !== undefined) {
                playPromise
                    .then(() => updatePlayBtn(true))
                    .catch(e => {
                        console.warn("Autoplay blocked:", e);
                        updatePlayBtn(false);
                    });
            }
        }
    };

    // C. Xử lý lỗi
    audio.onerror = (e) => {
        console.error("Lỗi phát bài hát:", song.name, audio.error);
        updatePlayBtn(false);
    };

    // D. Gán nguồn (Thêm timestamp để tránh cache trình duyệt)
    audio.src = `/stream/${song.id}?t=${Date.now()}`;
    
    // E. Bắt buộc nạp lại
    audio.load();
}

// --- 4. SỰ KIỆN AUDIO ---
audio.ontimeupdate = () => {
    // Nếu chưa có duration (NaN hoặc 0) thì không làm gì để tránh lỗi
    if (!audio.duration || isNaN(audio.duration)) return;

    // --- [LOGIC MỚI] BỎ QUA ĐOẠN CUỐI ---
    // Kiểm tra xem user có bật chế độ Skip không
    const cbSkip = document.getElementById('cbSkipMode');
    // Cần kiểm tra phần tử tồn tại và đang checked, đồng thời nhạc phải đang chạy
    if (cbSkip && cbSkip.checked && isPlaying) {
        const inpSkipEnd = document.getElementById('inpSkipEnd');
        const skipEndVal = inpSkipEnd ? (parseInt(inpSkipEnd.value) || 0) : 0;
        
        // Nếu thời gian hiện tại >= (Tổng thời gian - Giây bỏ qua) -> Next bài
        if (skipEndVal > 0 && audio.currentTime >= (audio.duration - skipEndVal)) {
            console.log(`⏩ Auto Skip Outro (${skipEndVal}s cuối)`);
            playNext(true); // True để tự động play bài sau
            return; // Dừng xử lý tiếp để tránh cập nhật UI thừa
        }
    }
    // -------------------------------------

    // 1. Cập nhật giao diện Web
    document.getElementById('currTime').innerText = formatTime(audio.currentTime);
    seekBar.value = audio.currentTime;

    // 2. [FIX IOS] Cập nhật tiến độ cho màn hình khóa (BẮT BUỘC CHO IOS)
    if ('mediaSession' in navigator) {
        try {
            navigator.mediaSession.setPositionState({
                duration: audio.duration,
                playbackRate: audio.playbackRate,
                position: audio.currentTime
            });
        } catch (e) {
            // Bỏ qua lỗi nếu số liệu chưa chuẩn xác
        }
    }
    
    // 3. Logic Preload (Giữ nguyên)
    if (!isPreloaded && pendingNextIndex !== -1 && (audio.currentTime / audio.duration > 0.9)) {
        isPreloaded = true;
        const nextSong = currentPlaylist[pendingNextIndex];
        console.log("⚡ Preloading:", nextSong.name);
        showStatus(`🔜 Sắp phát: ${nextSong.name}`, 10000);
        fetch(`/api/preload/${nextSong.id}`).catch(()=>{});
    }

    // 4. Logic lưu tiến độ (Giữ nguyên)
    if (Math.floor(audio.currentTime) % 5 === 0 && isPlaying && currentIndex !== -1) {
        const song = currentPlaylist[currentIndex];
        const currentFolder = document.getElementById('folderFilter').value;
        fetch('/api/progress', { 
            method: 'POST', 
            headers: {'Content-Type':'application/json'}, 
            body: JSON.stringify({
                songId: song.id, 
                currentTime: audio.currentTime,
                folder: currentFolder
            }) 
        }).catch(()=>{}); 
    }
};

// Khi hết bài -> Chuyển bài
audio.onended = () => { 
    if (loopMode === 2) { 
        audio.currentTime = 0; 
        audio.play().catch(()=>{}); 
    } else { 
        playNext(false); 
    } 
};

// --- 5. UI UPDATE FUNCTIONS ---
function updatePlayerUI(song) {
    // 1. [MỚI] Xử lý tên bài hát: Xóa đuôi file (.mp3, .flac...)
    const cleanName = song.name.replace(/\.(mp3|flac|wav|m4a|aac|ogg)$/i, '');

    // 2. [MỚI] Tạo cấu trúc chạy chữ liên tục
    // Mẹo: Tạo 4 bản sao của tên bài hát để đảm bảo độ dài luôn phủ kín thanh player
    // Thêm icon nhạc 🎵 vào đầu mỗi đoạn
    const loopContent = `<span>🎵🎵 ${cleanName} &nbsp;&nbsp;&nbsp;&nbsp;</span>`;
    document.getElementById('songTitle').innerHTML = `
        <div class="marquee-wrapper">
            ${loopContent.repeat(4)}
        </div>
    `;

    // Các phần giữ nguyên như cũ
    document.getElementById('totalTime').innerText = formatTime(song.duration);
    seekBar.max = song.duration;
    updatePlayerHeart(song.is_favorite);
    
    document.querySelectorAll('.song-item').forEach(el => el.classList.remove('active'));
    const el = document.getElementById(`song-${song.id}`);
    if(el) { 
        el.classList.add('active'); 
        el.scrollIntoView({ behavior: 'smooth', block: 'center' }); 
    }
}

function updatePlayBtn(p) { 
    const b = document.getElementById('btnPlay'); 
    b.innerText = p ? '⏸️' : '▶️'; 
    if(p) b.classList.add('active'); else b.classList.remove('active'); 
    isPlaying = p; 
}

function formatTime(s) { 
    if(!s || isNaN(s)) return '0:00'; 
    const m=Math.floor(s/60), sc=Math.floor(s%60); 
    return `${m}:${sc<10?'0'+sc:sc}`; 
}

// --- 6. CONTROLS & LOGIC ---
function togglePlay() { 
    if (currentIndex === -1 && currentPlaylist.length > 0) { playIndex(0); return; }
    if (audio.paused) { 
        audio.play().then(() => updatePlayBtn(true)).catch(e => { console.warn(e); updatePlayBtn(false); });
    } else { 
        audio.pause(); updatePlayBtn(false); 
    } 
}

function playIndex(i) { 
    if (i < 0 || i >= currentPlaylist.length) return; 
    currentIndex = i; 
    loadSong(currentPlaylist[currentIndex]); 
}

function playNext(u = false) {
    if (!currentPlaylist.length) return;
    
    let nextIndex;
    // Ưu tiên dùng bài đã tính toán trước (Preload)
    if (pendingNextIndex !== -1) {
        nextIndex = pendingNextIndex;
    } else {
        // Fallback
        if (isShuffle) nextIndex = Math.floor(Math.random() * currentPlaylist.length);
        else {
            nextIndex = currentIndex + 1;
            if (nextIndex >= currentPlaylist.length) nextIndex = 0;
        }
    }

    if (!isShuffle && !u && loopMode === 0 && currentIndex === currentPlaylist.length - 1) {
        return; 
    }
    playIndex(nextIndex);
}

function playPrev() { 
    if (audio.currentTime > 3) { audio.currentTime = 0; return; } 
    let n = currentIndex - 1; 
    if (n < 0) n = currentPlaylist.length - 1; 
    playIndex(n); 
}

function toggleShuffle() { 
    isShuffle = !isShuffle; 
    const b = document.getElementById('btnShuffle'); 
    if (isShuffle) b.classList.add('active'); else b.classList.remove('active'); 
    prepareNextSong(); // Tính lại bài tiếp theo khi đổi chế độ
}

function toggleLoop() { 
    loopMode++; if (loopMode > 2) loopMode = 0; 
    const b = document.getElementById('btnLoop'); 
    if (loopMode === 0) { b.classList.remove('active'); b.innerHTML = '🔁'; } 
    else if (loopMode === 1) { b.classList.add('active'); b.innerHTML = '🔁'; } 
    else { b.classList.add('active'); b.innerHTML = '🔂'; } 
}

function seekAudio() { 
    audio.currentTime = seekBar.value; 
    document.getElementById('currTime').innerText = formatTime(audio.currentTime); 
}

// --- 7. FAVORITE & SEARCH ---
function toggleFavorite(event, songId) {
    event.stopPropagation();
    const song = allSongs.find(s => s.id === songId);
    if (!song) return;
    fetch('/api/favorite/toggle', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ songId }) })
        .then(r => r.json()).then(d => {
            song.is_favorite = d.is_favorite;
            if (document.getElementById('folderFilter').value === 'favorites' && !song.is_favorite) {
                currentPlaylist = currentPlaylist.filter(s => s.id !== songId);
            }
            renderPlaylist();
            if (currentIndex !== -1 && currentPlaylist[currentIndex].id === songId) updatePlayerHeart(song.is_favorite);
        });
}

function toggleFavoriteCurrent() {
    if (currentIndex !== -1) toggleFavorite({ stopPropagation: () => {} }, currentPlaylist[currentIndex].id);
}

function updatePlayerHeart(isFav) {
    const btn = document.getElementById('playerHeart');
    btn.innerText = isFav ? '❤️' : '🤍';
    if(isFav) btn.classList.add('liked'); else btn.classList.remove('liked');
}

function toggleSearch() {
    const s = document.getElementById('folderFilter');
    const i = document.getElementById('searchInput');
    const btn = document.getElementById('btnSearchToggle');

    // Kiểm tra trạng thái hiện tại (Đang hiện ô input hay không?)
    const isSearching = i.style.display === 'block';

    if (isSearching) {
        // --- ĐANG MỞ -> BẤM ĐỂ ĐÓNG ---
        i.value = '';             // 1. Xóa chữ trong ô tìm kiếm
        i.style.display = 'none'; // 2. Ẩn ô tìm kiếm
        s.style.display = 'block';// 3. Hiện lại Dropdown
        btn.innerText = '🔎';     // 4. Đổi icon về kính lúp
        
        // 5. Khôi phục danh sách bài hát theo folder hiện tại
        filterPlaylist(); 
    } else {
        // --- ĐANG ĐÓNG -> BẤM ĐỂ MỞ ---
        s.style.display = 'none'; // 1. Ẩn Dropdown
        i.style.display = 'block';// 2. Hiện ô tìm kiếm
        i.focus();                // 3. Focus để gõ luôn
        btn.innerText = '❌';     // 4. Đổi icon thành dấu X (Đóng)
    }
}

// Hàm chuẩn hóa chuỗi (Bỏ dấu, bỏ ký tự lạ, về chữ thường)
function cleanString(str) {
    if (!str) return '';
    return str.toString()
        // 1. Chuẩn hóa Unicode (tách riêng ký tự và dấu)
        .normalize('NFD')
        // 2. Xóa các dấu thanh (dấu sắc, huyền, hỏi...)
        .replace(/[\u0300-\u036f]/g, '')
        // 3. Chuyển đ -> d (vì quy tắc trên không xử lý chữ đ)
        .replace(/đ/g, 'd').replace(/Đ/g, 'd')
        // 4. Chuyển về chữ thường
        .toLowerCase()
        // 5. Thay thế TẤT CẢ ký tự đặc biệt (không phải chữ và số) bằng khoảng trắng
        // Ví dụ: "em_đen" -> "em đen"
        .replace(/[^a-z0-9]/g, ' ')
        // 6. Gom gọn nhiều khoảng trắng liên tiếp thành 1 (để tránh lỗi khi user gõ thừa dấu cách)
        .replace(/\s+/g, ' ')
        .trim();
}

function searchSongs() {
    const rawInput = document.getElementById('searchInput').value;
    
    // Làm sạch từ khóa tìm kiếm (VD: "Em Đen" -> "em den")
    const q = cleanString(rawInput);

    // Nếu ô tìm kiếm rỗng -> Trả lại danh sách gốc theo bộ lọc folder
    if (!q) { 
        filterPlaylist(); 
        return; 
    }

    // Lọc danh sách
    currentPlaylist = allSongs.filter(s => {
        // Làm sạch tên bài hát gốc (VD: "Em_Đen_Remix!!!" -> "em den remix")
        const songNameClean = cleanString(s.name);
        
        // Kiểm tra xem tên bài hát (đã làm sạch) có chứa từ khóa (đã làm sạch) không
        return songNameClean.includes(q);
    });

    renderPlaylist();
}

function filterPlaylist() {
    const rawF = document.getElementById('folderFilter').value;
    const f = rawF ? rawF.trim() : 'all';

    document.getElementById('searchInput').value = '';

    if (f === 'all') {
        currentPlaylist = [...allSongs];
    } else if (f === 'favorites') {
        currentPlaylist = allSongs.filter(s => s.is_favorite === 1);
    } else {
        // [SỬA LỖI] So sánh mềm dẻo hơn (chính xác từng ký tự sau khi trim)
        currentPlaylist = allSongs.filter(s => {
            const songFolder = (s.folder_path || '').trim();
            return songFolder === f;
        });
    }
    
    if(isShuffle) toggleShuffle(); 
    else {
        renderPlaylist();
        prepareNextSong();
    }
}

function renderPlaylist() {
    const list = document.getElementById('playlist'); list.innerHTML = '';
    currentPlaylist.slice(0, 100).forEach((song, index) => {
        const div = document.createElement('div'); div.className = 'song-item'; div.id = `song-${song.id}`;
        div.innerHTML = `<div class="song-info"><span class="song-title">${song.name}</span><div class="song-meta"><span class="tag">${song.folder_path.replace('/', '')}</span><span>⏱ ${formatTime(song.duration)}</span></div></div><button class="btn-heart ${song.is_favorite?'liked':''}" onclick="toggleFavorite(event, '${song.id}')">${song.is_favorite?'❤️':'🤍'}</button>`;
        div.onclick = () => { if(isShuffle) toggleShuffle(); playIndex(index); };
        list.appendChild(div);
    });
}

// [MỚI] Hàm chuyển đổi giữa Playlist và Downloader
function toggleDownloaderView() {
    const playlistView = document.getElementById('playlist');
    const downloaderView = document.getElementById('downloaderView');
    const btn = document.getElementById('btnDownloadView');

    // Kiểm tra xem Downloader đang hiện hay ẩn
    const isShowing = downloaderView.style.display === 'block';

    if (isShowing) {
        // ĐANG HIỆN -> ẨN ĐI (Về Playlist)
        downloaderView.style.display = 'none';
        playlistView.style.display = 'block';
        btn.innerHTML = '⬇️'; // Icon tải
        btn.classList.remove('active');
        
        // Tải lại playlist để cập nhật nếu vừa có nhạc mới
        // init(); (Tùy chọn: nếu muốn auto refresh)
    } else {
        // ĐANG ẨN -> HIỆN LÊN (Vào Downloader)
        downloaderView.style.display = 'block';
        playlistView.style.display = 'none';
        btn.innerHTML = '❌'; // Icon đóng
        btn.classList.add('active'); // Style active (màu bạc)
        
        // Focus vào ô nhập link
        setTimeout(() => document.getElementById('dlLink').focus(), 100);
    }
}

// --- SỬA LẠI ĐOẠN XỬ LÝ LỖI AUDIO (ĐỒNG BỘ TÊN BIẾN) ---
audio.addEventListener('error', (e) => {
    // Chỉ xử lý khi có lỗi thực sự và danh sách nhạc còn
    if (audio.error && (audio.error.code === 4 || audio.error.code === 3)) {
        console.warn("⚠️ Bài hát không tồn tại (404). Đang xóa và chuyển bài...");
        
        // 1. Thông báo cho người dùng biết (Dùng hàm showStatus có sẵn trong index.js)
        if (typeof showStatus === 'function') {
            showStatus("⚠️ Bài hát bị lỗi/xóa trên Drive. Đang bỏ qua...", 3000);
        }

        // 2. Xử lý Logic Playlist
        if (currentPlaylist.length > 0 && currentIndex > -1) {
            // Xóa bài hát bị lỗi khỏi mảng playlist hiện tại
            currentPlaylist.splice(currentIndex, 1);
            
            // Cập nhật lại giao diện danh sách (để mất dòng bài hát lỗi đi)
            renderPlaylist();

            // 3. Logic chọn bài tiếp theo
            // Sau khi xóa, các bài phía sau sẽ dồn lên.
            // Ví dụ: Đang nghe bài [5], xóa bài [5], thì bài [6] cũ sẽ trở thành bài [5] mới.
            // -> Nên ta vẫn giữ nguyên currentIndex để phát bài tiếp theo.
            
            if (currentPlaylist.length > 0) {
                // Nếu vừa xóa bài cuối cùng, quay về bài đầu tiên
                if (currentIndex >= currentPlaylist.length) {
                    currentIndex = 0;
                }
                
                // Gọi hàm playIndex (Hàm chuẩn trong index.js của bạn)
                playIndex(currentIndex);
            } else {
                console.log("Playlist đã hết.");
                showStatus("Playlist đã hết.", 3000);
            }
        } else {
            // Trường hợp lỗi lạ hoặc playlist rỗng
            playNext();
        }
    }
});

// --- [MỚI] TÍCH HỢP MEDIA SESSION API (CHO MÀN HÌNH KHÓA MOBILE) ---
function updateMediaSession(song) {
    if ('mediaSession' in navigator) {
        // 1. Cập nhật Metadata
        // Lưu ý: iOS rất thích ảnh vuông (sizes: '512x512')
        navigator.mediaSession.metadata = new MediaMetadata({
            title: song.name,
            artist: "My Cloud Music",
            album: song.folder_path || "Unknown Album",
            artwork: [
                { src: 'https://cdn-icons-png.flaticon.com/512/461/461238.png', sizes: '96x96', type: 'image/png' },
                { src: 'https://cdn-icons-png.flaticon.com/512/461/461238.png', sizes: '128x128', type: 'image/png' },
                { src: 'https://cdn-icons-png.flaticon.com/512/461/461238.png', sizes: '192x192', type: 'image/png' },
                { src: 'https://cdn-icons-png.flaticon.com/512/461/461238.png', sizes: '512x512', type: 'image/png' },
            ]
        });

        // 2. Định nghĩa các hành động (Actions)
        // iOS yêu cầu phải khai báo cả 'seekbackward' và 'seekforward' để thanh thời gian hoạt động trơn tru
        const actionHandlers = [
            ['play',          () => { audio.play().catch(()=>{}); updatePlayBtn(true); }],
            ['pause',         () => { audio.pause(); updatePlayBtn(false); }],
            ['previoustrack', () => playPrev()],
            ['nexttrack',     () => playNext(true)],
            ['seekbackward',  (details) => { audio.currentTime = Math.max(audio.currentTime - (details.seekOffset || 10), 0); }],
            ['seekforward',   (details) => { audio.currentTime = Math.min(audio.currentTime + (details.seekOffset || 10), audio.duration); }],
            ['seekto',        (details) => { 
                if (details.fastSeek && 'fastSeek' in audio) audio.fastSeek(details.seekTime);
                else audio.currentTime = details.seekTime; 
            }],
        ];

        for (const [action, handler] of actionHandlers) {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
            } catch (error) {
                // Một số trình duyệt cũ không hỗ trợ action seekto, bỏ qua lỗi
            }
        }
    }
}

// --- [MỚI] QUẢN LÝ SETTING PLAYBACK ---
// 1. Hàm xử lý logic loại trừ (Mới thêm)
function toggleSettingMode(mode) {
    const cbStart = document.getElementById('cbPlayFromStart');
    const cbSkip = document.getElementById('cbSkipMode');

    // Logic: Nếu tôi vừa được BẬT -> Hãy TẮT cái kia ngay lập tức
    if (mode === 'start' && cbStart.checked) {
        cbSkip.checked = false;
    }

    if (mode === 'skip' && cbSkip.checked) {
        cbStart.checked = false;
    }
    
    // Lưu lại
    savePlaybackSettings();
}

// 2. Hàm lưu (Giữ nguyên hoặc cập nhật lại cho chắc)
function savePlaybackSettings() {
    const settings = {
        playFromStart: document.getElementById('cbPlayFromStart').checked,
        skipMode: document.getElementById('cbSkipMode').checked,
        skipStart: document.getElementById('inpSkipStart').value,
        skipEnd: document.getElementById('inpSkipEnd').value
    };
    
    // Gọi API lưu (Không cần await vì chạy ngầm cũng được)
    fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
    }).catch(console.error);
}

// 3. Hàm load (Đã cập nhật bộ lọc thông minh)
async function loadPlaybackSettings() {
    try {
        const res = await fetch('/api/settings');
        const settings = await res.json();
        
        if (settings) {
            const cbStart = document.getElementById('cbPlayFromStart');
            const cbSkip = document.getElementById('cbSkipMode');
            
            // Database trả về 1/0, cần chuyển thành boolean
            cbStart.checked = settings.play_from_start === 1;
            cbSkip.checked = settings.skip_mode === 1;
            
            document.getElementById('inpSkipStart').value = settings.skip_start;
            document.getElementById('inpSkipEnd').value = settings.skip_end;

            // Kiểm tra xung đột logic (như cũ)
            if (cbStart.checked && cbSkip.checked) {
                cbStart.checked = false;
                savePlaybackSettings();
            }
        }
    } catch (e) { console.error("Không thể tải cài đặt:", e); }
}

// Gọi hàm này ngay khi khởi tạo
loadPlaybackSettings();

// --- RUN ---
// init();
document.addEventListener('keydown', e => {
    // 1. Kiểm tra xem người dùng có đang gõ chữ không
    const activeTag = document.activeElement.tagName.toUpperCase();
    const isInput = activeTag === 'INPUT' || activeTag === 'TEXTAREA';

    // Nếu đang gõ trong ô tìm kiếm/input -> Bỏ qua, không làm gì cả (để gõ dấu cách)
    if (isInput) return;

    // 2. Nếu không gõ chữ mà nhấn Space -> Toggle Play/Pause
    if (e.code === 'Space') {
        e.preventDefault(); // Ngăn trình duyệt cuộn trang xuống
        togglePlay();
    }
});