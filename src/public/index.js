// src/public/index.js - Version 3.2 (PlaybackRate)
console.log("--- src/public/index.js - Version 3.2 ---");

let scanInterval = null;
let allSongs = [], currentPlaylist = [], currentIndex = -1;
let isPlaying = false, isShuffle = false, loopMode = 0;
const audio = document.getElementById('audio');
const seekBar = document.getElementById('seekBar');

// Biến cho tính năng Preload (Tải trước)
let pendingNextIndex = -1;
let isPreloaded = false;

// --- 1. KHỞI TẠO ---
// --- src/public/index.js ---
window.init = init;

// --- src/public/index.js ---

async function init(isSilent = false) {
    try {
        // 1. Lấy danh sách bài hát từ Server
        const res = await fetch('/api/songs');
        const data = await res.json();
        
        // Lưu vào biến toàn cục
        allSongs = data.data; 
        document.getElementById('count').innerText = data.total;

        // 2. Tạo Menu lọc (Dropdown)
        // Lưu lại giá trị filter hiện tại để không bị reset khi render lại option
        const currentFilterVal = document.getElementById('folderFilter').value;
        const folders = [...new Set(allSongs.map(s => (s.folder_path || 'Root').trim()))];
        
        const select = document.getElementById('folderFilter');
        select.innerHTML = ''; 

        // Tạo lại các Option (Giữ nguyên logic cũ của bạn)
        const optAll = document.createElement('option'); optAll.value = 'all'; optAll.innerText = '📁 Tất cả thư mục'; select.appendChild(optAll);
        const optFav = document.createElement('option'); optFav.value = 'favorites'; optFav.innerText = '❤️ Bài hát yêu thích'; select.appendChild(optFav);
        const optTop = document.createElement('option'); optTop.value = 'top100'; optTop.innerText = '🔥 Top 100 Thường nghe'; select.appendChild(optTop);
        const optRecent = document.createElement('option'); optRecent.value = 'recent'; optRecent.innerText = '🆕 Top 100 Mới tải'; select.appendChild(optRecent);
        
        folders.sort().forEach(f => {
            const opt = document.createElement('option');
            opt.value = f; opt.innerText = f.replace('/', '📁 '); select.appendChild(opt);
        });

        // Khôi phục lại lựa chọn cũ của người dùng
        if (currentFilterVal) select.value = currentFilterVal;

        // --- XỬ LÝ PHÂN TÁCH LOGIC ---

        if (!isSilent) {
            // === TRƯỜNG HỢP 1: LOAD LẦN ĐẦU (F5) ===
            currentPlaylist = [...allSongs];
            renderPlaylist(); 

            if (typeof loadPlaybackSettings === 'function') {
                await loadPlaybackSettings();
            }

            // CHỈ GỌI checkLastSession KHI LOAD LẦN ĐẦU
            await checkLastSession(); 
            
            // Kích hoạt đồng bộ cache (chỉ chạy 1 lần)
            if (typeof startCacheSync === 'function' && !window.hasStartedCacheSync) {
                 startCacheSync();
                 window.hasStartedCacheSync = true;
            }

        } else {
            // === TRƯỜNG HỢP 2: SILENT UPDATE (SAU KHI TẢI NHẠC) ===
            // Mục tiêu: Cập nhật list nhạc MÀ KHÔNG DỪNG NHẠC đang phát

            // 1. Lưu lại ID bài hát đang phát (nếu có)
            let playingSongId = null;
            if (currentIndex !== -1 && currentPlaylist[currentIndex]) {
                playingSongId = currentPlaylist[currentIndex].id;
            }

            // 2. Cập nhật currentPlaylist dựa theo bộ lọc hiện tại
            // (Gọi lại logic lọc thay vì gán cứng, để cover cả trường hợp đang ở trong Folder hoặc Favorites)
            await filterPlaylist(); 

            // 3. Tìm lại vị trí (Index) mới của bài hát đang phát
            // Vì khi thêm bài mới, số thứ tự (index) có thể bị lệch
            if (playingSongId) {
                const newIndex = currentPlaylist.findIndex(s => s.id === playingSongId);
                if (newIndex !== -1) {
                    currentIndex = newIndex;
                    
                    // Highlight lại bài hát đang phát trên giao diện mới
                    // (Đợi render xong 1 chút rồi mới add class)
                    setTimeout(() => {
                        const el = document.getElementById(`song-${playingSongId}`);
                        if(el) el.classList.add('active');
                    }, 100);
                }
            }

            showStatus("✅ Đã cập nhật thư viện nhạc mới!", 3000);
        }
        
    } catch (e) { 
        console.error("Lỗi khởi tạo:", e);
        if (typeof showStatus === 'function') {
            showStatus("❌ Lỗi tải dữ liệu. Vui lòng F5!", 5000);
        }
    }
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
    // [MỚI] Áp dụng lại tốc độ phát cho bài mới
    audio.playbackRate = currentSpeed;
    
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
    // --- [MỚI] CẬP NHẬT THANH TIẾN TRÌNH TRONG DANH SÁCH (REALTIME) ---
    if (currentIndex !== -1 && currentPlaylist[currentIndex]) {
        const songId = currentPlaylist[currentIndex].id;
        const songItem = document.getElementById(`song-${songId}`);
        
        if (songItem) {
            const percent = (audio.currentTime / audio.duration) * 100;
            const bar = songItem.querySelector('.mini-progress-fill');
            if (bar) {
                bar.style.width = `${percent}%`;
            }
        }
    }

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
    // [MỚI] Gửi tín hiệu cộng điểm (+10 Hot Score)
    // Chỉ cộng khi nghe trọn vẹn (không phải tua đến cuối rồi next)
    // Logic đơn giản: cứ onended tự nhiên là cộng.
    if (currentIndex !== -1 && currentPlaylist[currentIndex]) {
        fetch('/api/trend/add', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ songId: currentPlaylist[currentIndex].id })
        }).catch(()=>{}); // Fire and forget (không cần chờ kết quả)
    }

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
    if (!s || isNaN(s)) return '0:00';
    
    // 1. Tính toán Giờ, Phút, Giây
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sc = Math.floor(s % 60);
    
    // 2. Tạo chuỗi format (thêm số 0 vào trước nếu < 10)
    const mStr = m < 10 ? '0' + m : m;
    const scStr = sc < 10 ? '0' + sc : sc;
    
    // 3. Logic hiển thị
    // Nếu có giờ (> 0) -> Trả về H:MM:SS (Ví dụ: 1:05:20)
    if (h > 0) {
        return `${h}:${mStr}:${scStr}`;
    }
    
    // Nếu bài ngắn (< 1 giờ) -> Vẫn giữ M:SS cho gọn (Ví dụ: 5:30)
    return `${m}:${scStr}`;
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
    prepareNextSong(); 
    
    savePlaybackSettings(); // [MỚI] Lưu ngay khi bấm
}

function toggleLoop() { 
    loopMode++; if (loopMode > 2) loopMode = 0; 
    const b = document.getElementById('btnLoop'); 
    
    // Reset class trước
    b.classList.remove('active');
    
    if (loopMode === 0) { 
        b.innerHTML = '🔁'; 
    } else if (loopMode === 1) { 
        b.classList.add('active'); 
        b.innerHTML = '🔁'; 
    } else { 
        b.classList.add('active'); 
        b.innerHTML = '🔂'; 
    }
    
    savePlaybackSettings(); // [MỚI] Lưu ngay khi bấm
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

async function filterPlaylist() { // [Lưu ý] Thêm async vì ta sẽ gọi API
    const rawF = document.getElementById('folderFilter').value;
    const f = rawF ? rawF.trim() : 'all';

    document.getElementById('searchInput').value = '';

    if (f === 'all') {
        currentPlaylist = [...allSongs];
        finishFilter();
    } else if (f === 'favorites') {
        currentPlaylist = allSongs.filter(s => s.is_favorite === 1);
        finishFilter();
    } else if (f === 'top100') {
        // [MỚI] Xử lý Top 100 -> Gọi API lấy dữ liệu mới nhất từ Server
        try {
            const res = await fetch('/api/songs/top100');
            const topSongs = await res.json();
            currentPlaylist = topSongs;
            finishFilter();
        } catch (e) {
            console.error(e);
            currentPlaylist = []; // Lỗi thì rỗng
            finishFilter();
        }
    } else if (f === 'recent') {
        try {
            const res = await fetch('/api/songs/recent');
            const recentSongs = await res.json();
            currentPlaylist = recentSongs;
            finishFilter();
        } catch (e) {
            console.error(e);
            currentPlaylist = [];
            finishFilter();
        }
    } else {
        // Lọc theo folder
        currentPlaylist = allSongs.filter(s => {
            const songFolder = (s.folder_path || '').trim();
            return songFolder === f;
        });
        finishFilter();
    }
}

// Hàm phụ trợ để tái sử dụng code render (đỡ lặp lại)
function finishFilter() {
    if(isShuffle) toggleShuffle(); 
    else {
        renderPlaylist();
        prepareNextSong();
    }
}

// [CẬP NHẬT] Hàm render danh sách bài hát mới
function renderPlaylist() {
    const list = document.getElementById('playlist'); 
    list.innerHTML = '';
    
    currentPlaylist.forEach((song, index) => {
        const div = document.createElement('div'); 
        div.className = 'song-item'; 
        div.id = `song-${song.id}`;

        // 1. Xử lý tên: Bỏ đuôi mở rộng (.mp3, .flac...)
        const cleanName = song.name.replace(/\.(mp3|flac|wav|m4a|aac|ogg)$/i, '');
        
        // 2. Xử lý tên thư mục: Bỏ dấu gạch chéo
        const cleanFolder = (song.folder_path || 'Root').replace('/', '');

        // 3. Tính phần trăm tiến trình (Dựa trên lịch sử nghe)
        // Lưu ý: song.current_time lấy từ DB, song.duration lấy từ metadata
        let progressPercent = 0;
        if (song.current_time && song.duration > 0) {
            progressPercent = (song.current_time / song.duration) * 100;
            // Giới hạn max 100%
            if (progressPercent > 100) progressPercent = 100;
        }

        // 4. Xác định icon Cache (Tạm thời logic frontend)
        // Vì Frontend không check được file hệ thống, ta tạm dùng logic:
        // Nếu đã từng nghe (có duration & progress) -> Khả năng cao là đã cache hoặc load nhanh
        // *Lưu ý: Để chính xác 100% cần Backend trả về field is_cached (xem Bước 3 bên dưới)*
        const isCached = (song.is_cached === true); // Cần backend hỗ trợ, nếu không mặc định ẩn hoặc hiện 🚫
        const cacheIcon = isCached ? '💾' : '🚫'; 

        div.innerHTML = `
            <div class="song-info">
                <div class="song-title-row">
                    <span class="folder-badge">[${cleanFolder}]</span>
                    ${cleanName}
                </div>
                
                <div class="song-meta-row">
                    <span class="meta-icon" title="${isCached ? 'Đã lưu cache' : 'Chưa cache'}">${cacheIcon}</span>
                    <span>${formatTime(song.duration)}</span>
                    
                    <div class="mini-progress-track">
                        <div class="mini-progress-fill" style="width: ${progressPercent}%"></div>
                    </div>
                </div>
            </div>
            
            <button class="btn-heart ${song.is_favorite?'liked':''}" onclick="toggleFavorite(event, '${song.id}')">
                ${song.is_favorite?'❤️':'🤍'}
            </button>
        `;

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
        init(); // (Tùy chọn: nếu muốn auto refresh)
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
        skipEnd: document.getElementById('inpSkipEnd').value,
        isShuffle: isShuffle, 
        loopMode: loopMode,
        playbackRate: currentSpeed
    };
    
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
            // 1. Load setting skip/intro cũ
            const cbStart = document.getElementById('cbPlayFromStart');
            const cbSkip = document.getElementById('cbSkipMode');
            
            cbStart.checked = settings.play_from_start === 1;
            cbSkip.checked = settings.skip_mode === 1;
            document.getElementById('inpSkipStart').value = settings.skip_start;
            document.getElementById('inpSkipEnd').value = settings.skip_end;

            // 2. [MỚI] Load setting Shuffle
            isShuffle = (settings.shuffle_mode === 1);
            const btnShuf = document.getElementById('btnShuffle');
            if (isShuffle) btnShuf.classList.add('active'); 
            else btnShuf.classList.remove('active');

            // 3. [MỚI] Load setting Loop
            loopMode = settings.repeat_mode || 0;
            const btnLoop = document.getElementById('btnLoop');
            btnLoop.classList.remove('active');
            
            if (loopMode === 1) {
                btnLoop.classList.add('active');
                btnLoop.innerHTML = '🔁';
            } else if (loopMode === 2) {
                btnLoop.classList.add('active');
                btnLoop.innerHTML = '🔂';
            } else {
                btnLoop.innerHTML = '🔁';
            }

            // Xử lý xung đột logic (nếu có)
            if (cbStart.checked && cbSkip.checked) {
                cbStart.checked = false;
                savePlaybackSettings();
            }
            // [MỚI] Load Speed
            currentSpeed = settings.playback_rate || 1.00;
            applySpeedUI(); // Áp dụng ngay
        }
    } catch (e) { console.error("Không thể tải cài đặt:", e); }
}

// --- [MỚI] ĐỒNG BỘ TRẠNG THÁI CACHE (REALTIME) ---
function startCacheSync() {
    // Cứ 10 giây kiểm tra 1 lần
    setInterval(async () => {
        try {
            // Gọi API siêu nhẹ để lấy danh sách ID đã cache
            const res = await fetch('/api/cache-list');
            const cachedIds = await res.json();
            const cachedSet = new Set(cachedIds); // Chuyển sang Set để tra cứu cho nhanh

            // Duyệt qua các bài hát đang hiển thị trên màn hình
            const uiItems = document.querySelectorAll('.song-item');
            
            uiItems.forEach(item => {
                // Lấy ID bài hát từ id của thẻ div (song-xxxxx)
                const songId = item.id.replace('song-', '');
                
                // Tìm icon cache trong thẻ này
                const iconEl = item.querySelector('.meta-icon');
                
                if (iconEl) {
                    if (cachedSet.has(songId)) {
                        // Nếu đã cache -> Đổi thành đĩa mềm 💾
                        if (iconEl.innerText !== '💾') {
                            iconEl.innerText = '💾';
                            iconEl.title = 'Đã lưu cache';
                        }
                    } else {
                        // Nếu chưa cache -> Đổi thành cấm 🚫
                        if (iconEl.innerText !== '🚫') {
                            iconEl.innerText = '🚫';
                            iconEl.title = 'Chưa cache';
                        }
                    }
                }
            });
        } catch (e) {
            // Lỗi thì bỏ qua, đợi lần sau sync tiếp
        }
    }, 10000); // 10000ms = 10 giây
}

// --- [MỚI] LOGIC TỐC ĐỘ PHÁT (- 1.00 +) ---
let currentSpeed = 1.00;

function changeSpeed(delta) {
    // Cộng trừ và làm tròn số thập phân (tránh lỗi 1.0099999)
    currentSpeed = parseFloat((currentSpeed + delta).toFixed(2));
    
    // Giới hạn tốc độ (ví dụ: từ 0.25x đến 4.00x)
    if (currentSpeed < 0.25) currentSpeed = 0.25;
    if (currentSpeed > 4.00) currentSpeed = 4.00;
    
    applySpeedUI();
    savePlaybackSettings(); // Lưu ngay
}

function resetSpeed() {
    currentSpeed = 1.00;
    applySpeedUI();
    savePlaybackSettings();
}

function applySpeedUI() {
    // 1. Cập nhật text hiển thị
    const display = document.getElementById('speedDisplay');
    if (display) {
        // Luôn hiển thị 2 số thập phân (1.00, 1.05)
        display.innerText = currentSpeed.toFixed(2);
        
        // --- LOGIC MÀU SẮC MỚI ---
        if (currentSpeed < 1.0) {
            // Tốc độ chậm (< 1) -> Màu Đỏ cam (#ff4d4d)
            display.style.color = '#ff4d4d'; 
        } else if (currentSpeed > 1.0) {
            // Tốc độ nhanh (> 1) -> Màu Xanh lá (#1db954)
            display.style.color = '#1db954'; 
        } else {
            // Tốc độ chuẩn (1.0) -> Màu mặc định (trắng/xám)
            display.style.color = 'inherit'; 
        }
    }

    // 2. Áp dụng vào thẻ Audio
    const audio = document.getElementById('audio');
    if (audio) {
        audio.playbackRate = currentSpeed;
    }
}

// --- [MỚI] TÍNH NĂNG TUA NHANH/LÙI (SEEK) ---
function seekRelative(seconds) {
    const audio = document.getElementById('audio');
    
    // Chỉ thực hiện khi audio đã tải metadata (có duration)
    if (audio && audio.duration) {
        let newTime = audio.currentTime + seconds;
        
        // Giới hạn không cho tua quá độ dài bài hát hoặc nhỏ hơn 0
        if (newTime < 0) newTime = 0;
        if (newTime > audio.duration) newTime = audio.duration;
        
        audio.currentTime = newTime;
        
        // Cập nhật ngay giao diện thanh trượt để người dùng thấy phản hồi tức thì
        const seekBar = document.getElementById('seekBar');
        const currTimeLabel = document.getElementById('currTime');
        
        if (seekBar) seekBar.value = newTime;
        if (currTimeLabel) currTimeLabel.innerText = formatTime(newTime);
    }
}

// --- RUN ---
// init();
// loadPlaybackSettings();
// startCacheSync();

document.addEventListener('keydown', e => {
    // 1. Kiểm tra xem người dùng có đang gõ chữ không
    const activeTag = document.activeElement.tagName.toUpperCase();
    const isInput = activeTag === 'INPUT' || activeTag === 'TEXTAREA';

    // Nếu đang gõ trong ô tìm kiếm/input -> Bỏ qua, không làm gì cả (để gõ dấu cách)
    if (isInput) return;

    // 2. Nếu không gõ chữ mà nhấn Space -> Toggle Play/Pause
    switch (e.code) {
        case 'Space':
            e.preventDefault(); // Ngăn cuộn trang
            togglePlay();
            break;
            
        case 'ArrowLeft': // [MỚI] Mũi tên trái -> Lùi 10s
            e.preventDefault();
            seekRelative(-10);
            break;
            
        case 'ArrowRight': // [MỚI] Mũi tên phải -> Tới 10s
            e.preventDefault();
            seekRelative(10);
            break;
            
        case 'ArrowUp': // [MỚI] Mũi tên lên -> Tăng volume (Tùy chọn)
            e.preventDefault();
            if(audio.volume < 1) audio.volume = Math.min(1, audio.volume + 0.1);
            break;

        case 'ArrowDown': // [MỚI] Mũi tên xuống -> Giảm volume (Tùy chọn)
            e.preventDefault();
            if(audio.volume > 0) audio.volume = Math.max(0, audio.volume - 0.1);
            break;
    }
});