// src/public/index.js - Version 4.1 (Offline Mode PWA + PlaybackRate)
console.log("--- src/public/index.js - Version 4.0 (Offline) ---");

let scanInterval = null;
let allSongs = [], currentPlaylist = [], currentIndex = -1;
let isPlaying = false, isShuffle = false, loopMode = 0;
const audio = document.getElementById('audio');
const seekBar = document.getElementById('seekBar');

// Biến cho tính năng Preload (Tải trước)
let pendingNextIndex = -1;
let isPreloaded = false;

// --- 1. KHỞI TẠO ---
window.init = init;

async function init(isSilent = false) {
    try {
        let data;
        let isOfflineMode = false;

        // [OFFLINE UPDATE] 1. Cố gắng lấy dữ liệu Online
        try {
            const res = await fetch('/api/songs');
            if (!res.ok) throw new Error("Offline"); // Force lỗi nếu server không trả về 200
            data = await res.json();
            
            // Nếu có mạng: Lưu danh sách bài hát vào DB để dùng khi mất mạng sau này
            if (typeof OfflineDB !== 'undefined') {
                await OfflineDB.saveMetadata(data.data);
            }
        } catch (err) {
            // [OFFLINE UPDATE] 2. Nếu lỗi mạng -> Lấy dữ liệu Offline từ DB
            console.warn("Mất kết nối! Đang tải chế độ Offline...");
            if (typeof OfflineDB !== 'undefined') {
                const offlineSongs = await OfflineDB.getMetadata();
                if (offlineSongs.length > 0) {
                    data = { total: offlineSongs.length, data: offlineSongs };
                    showStatus("⚠️ Đang chạy chế độ Offline", 5000);
                    isOfflineMode = true;
                } else {
                    throw new Error("Không có dữ liệu Offline. Vui lòng kết nối mạng lần đầu.");
                }
            } else {
                throw err;
            }
        }
        
        // Lưu vào biến toàn cục
        allSongs = data.data; 
        document.getElementById('count').innerText = data.total;

        // 2. Tạo Menu lọc (Dropdown)
        const currentFilterVal = document.getElementById('folderFilter').value;
        // Gom nhóm folder
        const folders = [...new Set(allSongs.map(s => (s.folder_path || 'Root').trim()))];
        
        const select = document.getElementById('folderFilter');
        select.innerHTML = ''; 

        const optAll = document.createElement('option'); optAll.value = 'all'; optAll.innerText = '📁 Tất cả thư mục'; select.appendChild(optAll);
        const optFav = document.createElement('option'); optFav.value = 'favorites'; optFav.innerText = '❤️ Bài hát yêu thích'; select.appendChild(optFav);
        const optTop = document.createElement('option'); optTop.value = 'top100'; optTop.innerText = '🔥 Top 100 Thường nghe'; select.appendChild(optTop);
        const optRecent = document.createElement('option'); optRecent.value = 'recent'; optRecent.innerText = '🆕 Top 100 Mới tải'; select.appendChild(optRecent);
        
        // [OFFLINE UPDATE] Thêm bộ lọc bài đã tải
        const optOffline = document.createElement('option'); optOffline.value = 'offline_only'; optOffline.innerText = '⬇️ Nhạc đã tải'; select.appendChild(optOffline);

        folders.sort().forEach(f => {
            const opt = document.createElement('option');
            opt.value = f; opt.innerText = f.replace('/', '📁 '); select.appendChild(opt);
        });

        // Khôi phục lại lựa chọn cũ
        if (currentFilterVal) select.value = currentFilterVal;

        if (!isSilent) {
            // === LOAD LẦN ĐẦU ===
            currentPlaylist = [...allSongs];
            
            // Nếu đang offline thì tự động lọc ra các bài đã tải để user dễ dùng
            if (isOfflineMode) {
                select.value = 'offline_only';
                await filterPlaylist(); // Sẽ gọi renderPlaylist bên trong
            } else {
                renderPlaylist(); 
            }

            if (typeof loadPlaybackSettings === 'function') {
                await loadPlaybackSettings();
            }

            await checkLastSession(); 
            
            if (typeof startCacheSync === 'function' && !window.hasStartedCacheSync) {
                 startCacheSync();
                 window.hasStartedCacheSync = true;
            }

        } else {
            // === SILENT UPDATE ===
            let playingSongId = null;
            if (currentIndex !== -1 && currentPlaylist[currentIndex]) {
                playingSongId = currentPlaylist[currentIndex].id;
            }

            await filterPlaylist(); 

            if (playingSongId) {
                const newIndex = currentPlaylist.findIndex(s => s.id === playingSongId);
                if (newIndex !== -1) {
                    currentIndex = newIndex;
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
let statusTimeout;
function showStatus(text, timeout = 3000) {
    const el = document.getElementById('statusBar');
    if (!el) return;
    
    el.innerText = text;
    el.classList.add('show');

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
        if (!res.ok) return; // Nếu offline api fail thì bỏ qua
        const lastSession = await res.json();
        if (lastSession) {
            const song = allSongs.find(s => s.id === lastSession.song_id);
            if (song) {
                const folderSelect = document.getElementById('folderFilter');
                if (lastSession.context_path) {
                    folderSelect.value = lastSession.context_path;
                    if (folderSelect.selectedIndex === -1) folderSelect.value = 'all';
                }
                filterPlaylist(); 
                song.current_time = lastSession.current_time;
                updatePlayerUI(song);
                const idx = currentPlaylist.findIndex(s => s.id === song.id);
                if (idx !== -1) currentIndex = idx;
                loadSong(song, false);
            }
        }
    } catch (e) { console.error(e); }
}

async function updateLibrary() {
    const btn = document.getElementById('btnScan');
    const icon = document.getElementById('scanIcon');
    
    if(!confirm('Bạn có muốn quét lại toàn bộ thư viện nhạc trên Drive?')) return;

    btn.disabled = true;           
    icon.classList.add('spinning'); 
    showStatus("🔄 Đang kết nối máy chủ...", 0); 

    try {
        await fetch('/api/scan');
        showStatus("📡 Đang quét dữ liệu từ Google Drive...", 0);

        if (scanInterval) clearInterval(scanInterval);
        
        scanInterval = setInterval(async () => {
            try {
                const res = await fetch('/api/scan/status');
                const data = await res.json();

                if (!data.isScanning) {
                    clearInterval(scanInterval);
                    btn.disabled = false;
                    icon.classList.remove('spinning');
                    showStatus("✅ Hoàn tất! Đang tải lại danh sách...", 0);
                    setTimeout(() => location.reload(), 2000);
                } else {
                    if (data.logs && data.logs.length > 0) {
                        const lastLog = data.logs[data.logs.length - 1];
                        const shortMsg = lastLog.replace(/^\[.*?\]\s*/, ''); 
                        showStatus("Scan: " + shortMsg, 0);
                    }
                }
            } catch (e) { console.error(e); }
        }, 2000); 

    } catch (err) {
        alert('Lỗi: ' + err.message);
        btn.disabled = false;
        icon.classList.remove('spinning');
        showStatus("❌ Lỗi kết nối!", 5000);
    }
}

function prepareNextSong() {
    if (!currentPlaylist.length) {
        pendingNextIndex = -1;
        return;
    }
    if (isShuffle) {
        let n;
        do { 
            n = Math.floor(Math.random() * currentPlaylist.length); 
        } while (n === currentIndex && currentPlaylist.length > 1);
        pendingNextIndex = n;
    } else {
        let n = currentIndex + 1;
        if (n >= currentPlaylist.length) n = 0;
        pendingNextIndex = n;
    }
}

// --- 3. CORE: LOAD & PLAY SONG (OFFLINE UPGRADE) ---
// async function loadSong(song, autoPlay = true) {
//     updatePlayerUI(song);
//     updateMediaSession(song);
//     isPreloaded = false;
//     prepareNextSong();

//     audio.pause();
//     audio.onloadedmetadata = null;
//     audio.onerror = null;

//     // [OFFLINE UPDATE] Kiểm tra xem bài hát có trong IndexedDB không
//     let isPlayingOffline = false;
//     if (typeof OfflineDB !== 'undefined') {
//         const offlineBlob = await OfflineDB.getSong(song.id);
//         if (offlineBlob) {
//             console.log("📂 Playing from Offline DB:", song.name);
//             const url = URL.createObjectURL(offlineBlob);
//             audio.src = url;
//             isPlayingOffline = true;
//         }
//     }

//     // Nếu không có offline, stream từ server như bình thường
//     if (!isPlayingOffline) {
//         console.log("☁️ Playing from Server:", song.name);
//         audio.src = `/stream/${song.id}?t=${Date.now()}`;
//     }

//     // Áp dụng lại tốc độ phát
//     audio.playbackRate = currentSpeed;

//     audio.onloadedmetadata = () => {
//         const cbStart = document.getElementById('cbPlayFromStart').checked;
//         const cbSkip = document.getElementById('cbSkipMode').checked;
//         const skipStartVal = parseInt(document.getElementById('inpSkipStart').value) || 0;

//         let startTime = 0;
//         if (!cbStart && song.current_time && song.current_time > 5 && song.current_time < song.duration - 5) {
//             startTime = song.current_time;
//         }

//         if (cbSkip) {
//             if (startTime < skipStartVal) startTime = skipStartVal;
//         }

//         audio.currentTime = startTime;
        
//         if(autoPlay) {
//             var playPromise = audio.play();
//             if (playPromise !== undefined) {
//                 playPromise
//                     .then(() => updatePlayBtn(true))
//                     .catch(e => {
//                         console.warn("Autoplay blocked:", e);
//                         updatePlayBtn(false);
//                     });
//             }
//         }
//     };

//     audio.onerror = (e) => {
//         console.error("Lỗi phát bài hát:", song.name, audio.error);
//         updatePlayBtn(false);
//     };
    
//     audio.load();
// }

// src/public/index.js

async function loadSong(song, autoPlay = true) {
    updatePlayerUI(song);
    updateMediaSession(song);
    isPreloaded = false;
    prepareNextSong();

    // Reset các event cũ để tránh lặp
    // Lưu ý: Không gọi audio.pause() ở đây để tránh đứt luồng âm thanh
    
    // [OFFLINE UPDATE] Kiểm tra xem bài hát có trong IndexedDB không
    let isPlayingOffline = false;
    if (typeof OfflineDB !== 'undefined') {
        const offlineBlob = await OfflineDB.getSong(song.id);
        if (offlineBlob) {
            console.log("📂 Playing from Offline DB:", song.name);
            const url = URL.createObjectURL(offlineBlob);
            audio.src = url;
            isPlayingOffline = true;
        }
    }

    // Nếu không có offline, stream từ server
    if (!isPlayingOffline) {
        console.log("☁️ Playing from Server:", song.name);
        audio.src = `/stream/${song.id}?t=${Date.now()}`;
    }

    // [FIX iOS PWA] Sử dụng 'canplay' thay vì 'loadedmetadata'
    // 'canplay' đảm bảo iOS đã buffer đủ dữ liệu để chạy, tránh bị kill process
    const playHandler = () => {
        // Gỡ bỏ listener ngay lập tức
        audio.removeEventListener('canplay', playHandler);

        // Áp dụng tốc độ phát
        audio.playbackRate = currentSpeed;

        // Xử lý logic Skip / Resume
        const cbStart = document.getElementById('cbPlayFromStart').checked;
        const cbSkip = document.getElementById('cbSkipMode').checked;
        const skipStartVal = parseInt(document.getElementById('inpSkipStart').value) || 0;

        let startTime = 0;
        if (!cbStart && song.current_time && song.current_time > 5 && song.current_time < song.duration - 5) {
            startTime = song.current_time;
        }
        if (cbSkip && startTime < skipStartVal) startTime = skipStartVal;

        // Gán thời gian bắt đầu
        if(isFinite(startTime)) audio.currentTime = startTime;
        
        if(autoPlay) {
            const playPromise = audio.play();
            if (playPromise !== undefined) {
                playPromise
                    .then(() => {
                        updatePlayBtn(true);
                        updateMediaSession(song);
                    })
                    .catch(e => {
                        console.warn("Autoplay blocked/Interrupted on iOS:", e);
                        updatePlayBtn(false);
                        
                        // [FIX iOS] Thử kích hoạt lại lần nữa sau 500ms nếu bị chặn (Hy vọng mong manh ở background)
                        setTimeout(() => {
                            if(audio.paused) audio.play().catch(()=>{});
                        }, 500);
                    });
            }
        }
    };

    // Sử dụng 'canplay' an toàn hơn cho iOS
    audio.addEventListener('canplay', playHandler);
    
    // [FIX iOS] Bắt buộc gọi load() khi đổi src bằng Javascript
    audio.load(); 
}

// --- 4. SỰ KIỆN AUDIO ---
audio.ontimeupdate = () => {
    if (!audio.duration || isNaN(audio.duration)) return;

    const cbSkip = document.getElementById('cbSkipMode');
    if (cbSkip && cbSkip.checked && isPlaying) {
        const inpSkipEnd = document.getElementById('inpSkipEnd');
        const skipEndVal = inpSkipEnd ? (parseInt(inpSkipEnd.value) || 0) : 0;
        
        if (skipEndVal > 0 && audio.currentTime >= (audio.duration - skipEndVal)) {
            console.log(`⏩ Auto Skip Outro (${skipEndVal}s cuối)`);
            playNext(true); 
            return; 
        }
    }

    document.getElementById('currTime').innerText = formatTime(audio.currentTime);
    seekBar.value = audio.currentTime;
    
    if (currentIndex !== -1 && currentPlaylist[currentIndex]) {
        const songId = currentPlaylist[currentIndex].id;
        const songItem = document.getElementById(`song-${songId}`);
        if (songItem) {
            const percent = (audio.currentTime / audio.duration) * 100;
            const bar = songItem.querySelector('.mini-progress-fill');
            if (bar) bar.style.width = `${percent}%`;
        }
    }

    if ('mediaSession' in navigator) {
        try {
            navigator.mediaSession.setPositionState({
                duration: audio.duration,
                playbackRate: audio.playbackRate,
                position: audio.currentTime
            });
        } catch (e) {}
    }
    
    if (!isPreloaded && pendingNextIndex !== -1 && (audio.currentTime / audio.duration > 0.9)) {
        isPreloaded = true;
        const nextSong = currentPlaylist[pendingNextIndex];
        // Chỉ preload nếu online (chưa hỗ trợ preload blob offline phức tạp)
        if (!audio.src.startsWith('blob:')) {
             console.log("⚡ Preloading:", nextSong.name);
             fetch(`/api/preload/${nextSong.id}`).catch(()=>{});
        }
    }

    if (Math.floor(audio.currentTime) % 5 === 0 && isPlaying && currentIndex !== -1) {
        // Chỉ lưu progress nếu đang online (API call sẽ fail nếu offline, catch bỏ qua)
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

audio.onended = () => { 
    if (currentIndex !== -1 && currentPlaylist[currentIndex]) {
        fetch('/api/trend/add', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ songId: currentPlaylist[currentIndex].id })
        }).catch(()=>{}); 
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
    const cleanName = song.name.replace(/\.(mp3|flac|wav|m4a|aac|ogg)$/i, '');
    const loopContent = `<span>🎵🎵 ${cleanName} &nbsp;&nbsp;&nbsp;&nbsp;</span>`;
    document.getElementById('songTitle').innerHTML = `
        <div class="marquee-wrapper">
            ${loopContent.repeat(4)}
        </div>
    `;

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
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sc = Math.floor(s % 60);
    const mStr = m < 10 ? '0' + m : m;
    const scStr = sc < 10 ? '0' + sc : sc;
    if (h > 0) return `${h}:${mStr}:${scStr}`;
    return `${m}:${scStr}`;
}

// --- 6. CONTROLS ---
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
    if (pendingNextIndex !== -1) {
        nextIndex = pendingNextIndex;
    } else {
        if (isShuffle) nextIndex = Math.floor(Math.random() * currentPlaylist.length);
        else {
            nextIndex = currentIndex + 1;
            if (nextIndex >= currentPlaylist.length) nextIndex = 0;
        }
    }
    if (!isShuffle && !u && loopMode === 0 && currentIndex === currentPlaylist.length - 1) return; 
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
    savePlaybackSettings(); 
}

function toggleLoop() { 
    loopMode++; if (loopMode > 2) loopMode = 0; 
    const b = document.getElementById('btnLoop'); 
    b.classList.remove('active');
    if (loopMode === 0) b.innerHTML = '🔁'; 
    else if (loopMode === 1) { b.classList.add('active'); b.innerHTML = '🔁'; } 
    else { b.classList.add('active'); b.innerHTML = '🔂'; }
    savePlaybackSettings(); 
}

function seekAudio() { 
    audio.currentTime = seekBar.value; 
    document.getElementById('currTime').innerText = formatTime(audio.currentTime); 
}

// --- 7. FAVORITE & DOWNLOAD & SEARCH ---

// [OFFLINE UPDATE] Hàm xử lý Download
async function toggleDownload(event, songId) {
    event.stopPropagation(); // Không trigger play
    const btn = document.getElementById(`btn-dl-${songId}`);
    
    if (typeof OfflineDB === 'undefined') {
        alert("Trình duyệt không hỗ trợ lưu Offline!");
        return;
    }

    const isDownloaded = await OfflineDB.isDownloaded(songId);

    if (isDownloaded) {
        // --- XÓA ---
        if (!confirm('Xóa bài hát này khỏi bộ nhớ máy?')) return;
        await OfflineDB.deleteSong(songId);
        btn.innerText = '⬇️'; // Đổi lại icon tải
        btn.classList.remove('downloaded');
        btn.title = 'Tải Offline';
        showStatus("🗑️ Đã xóa bản Offline", 2000);
        
        // Nếu đang ở bộ lọc "offline_only", xóa xong thì refresh list
        if(document.getElementById('folderFilter').value === 'offline_only') {
            filterPlaylist();
        }
    } else {
        // --- TẢI ---
        try {
            btn.innerText = '⏳'; // Icon chờ
            btn.disabled = true;
            
            // Gọi API Stream để lấy Blob
            const res = await fetch(`/stream/${songId}`);
            if (!res.ok) throw new Error("Lỗi tải file");
            const blob = await res.blob();
            
            // Lưu vào IndexedDB
            await OfflineDB.saveSong(songId, blob);
            
            btn.innerText = '✅';
            btn.classList.add('downloaded');
            btn.disabled = false;
            btn.title = 'Đã tải (Nhấn để xóa)';
            showStatus("💾 Đã tải xong! Có thể nghe Offline.", 2000);
        } catch (e) {
            console.error(e);
            btn.innerText = '⚠️';
            btn.disabled = false;
            if (e.name === 'QuotaExceededError') {
                alert("Bộ nhớ trình duyệt đã đầy! Hãy xóa bớt nhạc.");
            } else {
                showStatus("❌ Lỗi tải xuống", 3000);
                btn.innerText = '⬇️';
            }
        }
    }
}

function toggleFavorite(event, songId) {
    event.stopPropagation();
    let song = currentPlaylist.find(s => s.id === songId);
    if (!song) song = allSongs.find(s => s.id === songId);
    if (!song) return;
    
    fetch('/api/favorite/toggle', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ songId }) })
        .then(r => r.json()).then(d => {
            if(d.status === 'error') { alert(d.message); return; }
            song.is_favorite = d.is_favorite;
            const globalSong = allSongs.find(s => s.id === songId);
            if (globalSong) globalSong.is_favorite = d.is_favorite;

            if (document.getElementById('folderFilter').value === 'favorites' && !song.is_favorite) {
                currentPlaylist = currentPlaylist.filter(s => s.id !== songId);
            }
            renderPlaylist();
            if (currentIndex !== -1 && currentPlaylist[currentIndex].id === songId) updatePlayerHeart(song.is_favorite);
        })
        .catch(err => console.error("Lỗi toggle favorite:", err));
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
    const isSearching = i.style.display === 'block';

    if (isSearching) {
        i.value = '';             
        i.style.display = 'none'; 
        s.style.display = 'block';
        btn.innerText = '🔎';     
        filterPlaylist(); 
    } else {
        s.style.display = 'none'; 
        i.style.display = 'block';
        i.focus();                
        btn.innerText = '❌';     
    }
}

function cleanString(str) {
    if (!str) return '';
    return str.toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function searchSongs() {
    const rawInput = document.getElementById('searchInput').value;
    const q = cleanString(rawInput);
    if (!q) { filterPlaylist(); return; }

    currentPlaylist = allSongs.filter(s => {
        const songNameClean = cleanString(s.name);
        return songNameClean.includes(q);
    });

    renderPlaylist();
}

async function filterPlaylist() { 
    const rawF = document.getElementById('folderFilter').value;
    const f = rawF ? rawF.trim() : 'all';

    document.getElementById('searchInput').value = '';

    try {
        if (f === 'all') {
            currentPlaylist = [...allSongs];
        } else if (f === 'favorites') {
            currentPlaylist = allSongs.filter(s => s.is_favorite === 1);
        } else if (f === 'top100') {
            const res = await fetch('/api/songs/top100');
            currentPlaylist = await res.json();
        } else if (f === 'recent') {
            const res = await fetch('/api/songs/recent');
            currentPlaylist = await res.json();
        } else if (f === 'offline_only') {
            // [OFFLINE UPDATE] Lọc bài đã tải
            if (typeof OfflineDB !== 'undefined') {
                const offlineList = [];
                // Check async từng bài hơi chậm, nhưng an toàn
                // Cách tối ưu: lấy tất cả key trong DB so sánh
                // Ở đây dùng cách lặp qua allSongs và check (hiệu năng ổn với < 1000 bài)
                for (const song of allSongs) {
                    if (await OfflineDB.isDownloaded(song.id)) {
                        offlineList.push(song);
                    }
                }
                currentPlaylist = offlineList;
            } else {
                currentPlaylist = [];
            }
        } else {
            currentPlaylist = allSongs.filter(s => (s.folder_path || '').trim() === f);
        }
    } catch (e) {
        console.error("Filter Error:", e);
        // Nếu lỗi mạng khi lọc (Top 100/Recent) -> Fallback về rỗng
        currentPlaylist = [];
    }
    
    finishFilter();
}

function finishFilter() {
    if(isShuffle) toggleShuffle(); 
    else {
        renderPlaylist();
        prepareNextSong();
    }
}

function renderPlaylist() {
    const list = document.getElementById('playlist'); 
    list.innerHTML = '';
    
    currentPlaylist.forEach((song, index) => {
        const div = document.createElement('div'); 
        div.className = 'song-item'; 
        div.id = `song-${song.id}`;

        const cleanName = song.name.replace(/\.(mp3|flac|wav|m4a|aac|ogg)$/i, '');
        const cleanFolder = (song.folder_path || 'Root').replace(/\//g, ' › ');

        let progressPercent = 0;
        if (song.current_time && song.duration > 0) {
            progressPercent = (song.current_time / song.duration) * 100;
            if (progressPercent > 100) progressPercent = 100;
        }

        const isCached = (song.is_cached === true);
        const cacheIcon = isCached ? '💾' : '🚫'; 

        // [OFFLINE UPDATE] Thêm nút tải xuống
        const downloadBtnHtml = `
            <button id="btn-dl-${song.id}" class="btn-icon-only btn-dl" 
                onclick="toggleDownload(event, '${song.id}')" title="Tải Offline">
                ⬇️
            </button>
        `;

        div.innerHTML = `
            <div class="song-info">
                <div class="song-title-row">
                    <span class="folder-badge">[${cleanFolder}]</span>
                    ${cleanName}
                </div>
                
                <div class="song-meta-row">
                    <span class="meta-icon" 
                        title="${isCached ? 'Click để tải lại Cache từ Drive' : 'Chưa Cache'}" 
                        style="${isCached ? 'cursor: pointer;' : ''}"
                        onclick="${isCached ? `refreshServerCache(event, '${song.id}')` : ''}">
                        ${cacheIcon}
                    </span>
                    <span>${formatTime(song.duration)}</span>
                    <div class="mini-progress-track">
                        <div class="mini-progress-fill" style="width: ${progressPercent}%"></div>
                    </div>
                </div>
            </div>
            
            <div class="action-group" style="display:flex; align-items:center; gap:8px;">
                ${downloadBtnHtml}
                <button class="btn-heart ${song.is_favorite?'liked':''}" onclick="toggleFavorite(event, '${song.id}')">
                    ${song.is_favorite?'❤️':'🤍'}
                </button>
            </div>
        `;

        div.onclick = () => { if(isShuffle) toggleShuffle(); playIndex(index); };
        
        list.appendChild(div);

        // [OFFLINE UPDATE] Check bất đồng bộ icon đã tải
        if (typeof OfflineDB !== 'undefined') {
            OfflineDB.isDownloaded(song.id).then(isDL => {
                const btn = document.getElementById(`btn-dl-${song.id}`);
                if (btn && isDL) {
                    btn.innerText = '✅';
                    btn.classList.add('downloaded');
                    btn.title = 'Đã tải (Nhấn để xóa)';
                }
            });
        }
    });
}

function toggleDownloaderView() {
    const playlistView = document.getElementById('playlist');
    const downloaderView = document.getElementById('downloaderView');
    const btn = document.getElementById('btnDownloadView');

    const isShowing = downloaderView.style.display === 'block';

    if (isShowing) {
        downloaderView.style.display = 'none';
        playlistView.style.display = 'block';
        btn.innerHTML = '⬇️'; 
        btn.classList.remove('active');
        init(); 
    } else {
        downloaderView.style.display = 'block';
        playlistView.style.display = 'none';
        btn.innerHTML = '❌'; 
        btn.classList.add('active'); 
        setTimeout(() => document.getElementById('dlLink').focus(), 100);
    }
}

audio.addEventListener('error', (e) => {
    if (audio.error && (audio.error.code === 4 || audio.error.code === 3)) {
        console.warn("⚠️ Bài hát lỗi (404/Decode).");
        if (typeof showStatus === 'function') {
            showStatus("⚠️ Lỗi bài hát. Đang bỏ qua...", 3000);
        }

        if (currentPlaylist.length > 0 && currentIndex > -1) {
            currentPlaylist.splice(currentIndex, 1);
            renderPlaylist();
            if (currentPlaylist.length > 0) {
                if (currentIndex >= currentPlaylist.length) currentIndex = 0;
                playIndex(currentIndex);
            }
        } else {
            playNext();
        }
    }
});

function updateMediaSession(song) {
    if ('mediaSession' in navigator) {
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
            try { navigator.mediaSession.setActionHandler(action, handler); } catch (error) {}
        }
    }
}

function toggleSettingMode(mode) {
    const cbStart = document.getElementById('cbPlayFromStart');
    const cbSkip = document.getElementById('cbSkipMode');
    if (mode === 'start' && cbStart.checked) cbSkip.checked = false;
    if (mode === 'skip' && cbSkip.checked) cbStart.checked = false;
    savePlaybackSettings();
}

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

async function loadPlaybackSettings() {
    try {
        const res = await fetch('/api/settings');
        if (!res.ok) return; // Silent fail if offline
        const settings = await res.json();
        
        if (settings) {
            const cbStart = document.getElementById('cbPlayFromStart');
            const cbSkip = document.getElementById('cbSkipMode');
            
            cbStart.checked = settings.play_from_start === 1;
            cbSkip.checked = settings.skip_mode === 1;
            document.getElementById('inpSkipStart').value = settings.skip_start;
            document.getElementById('inpSkipEnd').value = settings.skip_end;

            isShuffle = (settings.shuffle_mode === 1);
            const btnShuf = document.getElementById('btnShuffle');
            if (isShuffle) btnShuf.classList.add('active'); 
            else btnShuf.classList.remove('active');

            loopMode = settings.repeat_mode || 0;
            const btnLoop = document.getElementById('btnLoop');
            btnLoop.classList.remove('active');
            if (loopMode === 1) { btnLoop.classList.add('active'); btnLoop.innerHTML = '🔁'; } 
            else if (loopMode === 2) { btnLoop.classList.add('active'); btnLoop.innerHTML = '🔂'; } 
            else { btnLoop.innerHTML = '🔁'; }

            if (cbStart.checked && cbSkip.checked) {
                cbStart.checked = false;
                savePlaybackSettings();
            }
            currentSpeed = settings.playback_rate || 1.00;
            applySpeedUI(); 
        }
    } catch (e) { console.error("Không thể tải cài đặt:", e); }
}

function startCacheSync() {
    setInterval(async () => {
        try {
            const res = await fetch('/api/cache-list');
            const cachedIds = await res.json();
            const cachedSet = new Set(cachedIds); 

            const uiItems = document.querySelectorAll('.song-item');
            uiItems.forEach(item => {
                const songId = item.id.replace('song-', '');
                const iconEl = item.querySelector('.meta-icon');
                if (iconEl) {
                    if (cachedSet.has(songId)) {
                        if (iconEl.innerText !== '💾') {
                            iconEl.innerText = '💾';
                            iconEl.title = 'Đã lưu cache';
                        }
                    } else {
                        if (iconEl.innerText !== '🚫') {
                            iconEl.innerText = '🚫';
                            iconEl.title = 'Chưa cache';
                        }
                    }
                }
            });
        } catch (e) {}
    }, 10000); 
}

// --- LOGIC TỐC ĐỘ PHÁT ---
let currentSpeed = 1.00;

function changeSpeed(delta) {
    currentSpeed = parseFloat((currentSpeed + delta).toFixed(2));
    if (currentSpeed < 0.25) currentSpeed = 0.25;
    if (currentSpeed > 4.00) currentSpeed = 4.00;
    applySpeedUI();
    savePlaybackSettings(); 
}

function resetSpeed() {
    currentSpeed = 1.00;
    applySpeedUI();
    savePlaybackSettings();
}

function applySpeedUI() {
    const display = document.getElementById('speedDisplay');
    if (display) {
        display.innerText = currentSpeed.toFixed(2);
        if (currentSpeed < 1.0) display.style.color = '#ff4d4d'; 
        else if (currentSpeed > 1.0) display.style.color = '#1db954'; 
        else display.style.color = 'inherit'; 
    }
    const audio = document.getElementById('audio');
    if (audio) audio.playbackRate = currentSpeed;
}

function seekRelative(seconds) {
    const audio = document.getElementById('audio');
    if (audio && audio.duration) {
        let newTime = audio.currentTime + seconds;
        if (newTime < 0) newTime = 0;
        if (newTime > audio.duration) newTime = audio.duration;
        audio.currentTime = newTime;
        const seekBar = document.getElementById('seekBar');
        const currTimeLabel = document.getElementById('currTime');
        if (seekBar) seekBar.value = newTime;
        if (currTimeLabel) currTimeLabel.innerText = formatTime(newTime);
    }
}

// [CẬP NHẬT] Hàm xử lý khi bấm vào icon Cache (💾) - Có cập nhật UI
async function refreshServerCache(event, songId) {
    event.stopPropagation(); 
    
    if (!confirm('Bạn có chắc muốn xóa bản cache cũ và tải lại dữ liệu mới từ Drive?')) return;

    const iconSpan = event.target;
    const originalText = iconSpan.innerText;
    
    iconSpan.innerText = '⏳';
    iconSpan.style.cursor = 'wait';

    try {
        const res = await fetch('/api/cache/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ songId })
        });
        
        const response = await res.json();

        if (res.ok && response.data) {
            const newSongData = response.data;
            showStatus(`✅ Đã cập nhật: ${formatTime(newSongData.duration)}`, 3000);

            // --- 1. CẬP NHẬT DỮ LIỆU TRONG RAM ---
            // Cập nhật trong danh sách tổng
            const globalIndex = allSongs.findIndex(s => s.id === songId);
            if (globalIndex !== -1) {
                // Giữ lại các thuộc tính local (như is_favorite) nếu API không trả về
                allSongs[globalIndex] = { ...allSongs[globalIndex], ...newSongData };
                // Reset trạng thái cache để icon chuyển về chưa cache (đang tải lại)
                allSongs[globalIndex].is_cached = false; 
            }

            // Cập nhật trong playlist hiện tại
            const playlistIndex = currentPlaylist.findIndex(s => s.id === songId);
            if (playlistIndex !== -1) {
                currentPlaylist[playlistIndex] = { ...currentPlaylist[playlistIndex], ...newSongData };
                currentPlaylist[playlistIndex].is_cached = false;
            }

            // --- 2. CẬP NHẬT GIAO DIỆN NGAY LẬP TỨC ---
            const songItem = document.getElementById(`song-${songId}`);
            if (songItem) {
                // Cập nhật thời lượng text
                const timeSpan = songItem.querySelector('.song-meta-row span:nth-child(2)');
                if (timeSpan) timeSpan.innerText = formatTime(newSongData.duration);
                
                // Cập nhật icon về trạng thái chờ tải
                iconSpan.innerText = '🚫';
                iconSpan.title = 'Server đang tải lại file mới...';
            }

            // --- 3. NẾU ĐANG PHÁT BÀI NÀY -> CẬP NHẬT PLAYER ---
            if (currentIndex !== -1 && currentPlaylist[currentIndex].id === songId) {
                const totalTimeEl = document.getElementById('totalTime');
                const seekBar = document.getElementById('seekBar');
                if (totalTimeEl) totalTimeEl.innerText = formatTime(newSongData.duration);
                if (seekBar) seekBar.max = newSongData.duration;
            }

        } else {
            throw new Error(response.error || 'Lỗi không xác định');
        }
    } catch (e) {
        console.error(e);
        showStatus("❌ Lỗi: " + e.message, 3000);
        iconSpan.innerText = originalText; 
    } finally {
        iconSpan.style.cursor = 'pointer';
    }
}

document.addEventListener('keydown', e => {
    const activeTag = document.activeElement.tagName.toUpperCase();
    const isInput = activeTag === 'INPUT' || activeTag === 'TEXTAREA';
    if (isInput) return;

    switch (e.code) {
        case 'Space': e.preventDefault(); togglePlay(); break;
        case 'ArrowLeft': e.preventDefault(); seekRelative(-10); break;
        case 'ArrowRight': e.preventDefault(); seekRelative(10); break;
        case 'ArrowUp': e.preventDefault(); if(audio.volume < 1) audio.volume = Math.min(1, audio.volume + 0.1); break;
        case 'ArrowDown': e.preventDefault(); if(audio.volume > 0) audio.volume = Math.max(0, audio.volume - 0.1); break;
    }
});