// src/public/downloader.js - Version 5.0

console.log("--- src/public/downloader.js - Version 5.0 ---");

// --- 1. KHAI BÁO BIẾN & DOM ---
const input = document.getElementById('dlLink');
const preview = document.getElementById('dlPreview');
const controls = document.getElementById('dlControls');
const videoListBox = document.getElementById('videoListBox');

// Các nút bấm
const btnCheck = document.getElementById('btnCheck');
const btnDownloadAll = document.getElementById('btnDownloadAll');
const btnSelectMode = document.getElementById('btnSelectMode');
const btnDownloadSelected = document.getElementById('btnDownloadSelected');
const btnStop = document.getElementById('btnStop');

// Status & Logs
const statusMsg = document.getElementById('dlStatus');
const consoleBox = document.getElementById('consoleBox');
const logContent = document.getElementById('logContent');

// Biến dữ liệu
let validUrl = '';
let currentPlaylistItems = []; 
let currentFormats = []; // [MỚI] Lưu danh sách formats cho video lẻ
let pollInterval = null;

// Listener
if (input) input.addEventListener("keypress", (e) => { if (e.key === "Enter") checkLink(); });

// --- 2. HÀM INIT & UI HELPERS ---

(async function init() {
    try {
        const res = await fetch('/api/download/status');
        const state = await res.json();
        if (state.isProcessing) {
            restoreProcessingUI();
            startPolling();
        }
    } catch (e) { console.error("Lỗi init downloader:", e); }
})();

// Hàm an toàn để ẩn/hiện element (tránh lỗi null)
function setDisplay(el, displayVal) {
    if (el) el.style.display = displayVal;
}

function restoreProcessingUI() {
    setDisplay(input, 'none');
    setDisplay(btnCheck, 'none');
    setDisplay(preview, 'none');
    setDisplay(videoListBox, 'none');
    
    setDisplay(controls, 'flex');
    setDisplay(btnDownloadAll, 'none');
    setDisplay(btnSelectMode, 'none');
    setDisplay(btnDownloadSelected, 'none');
    
    if (btnStop) {
        btnStop.style.display = 'block';
        btnStop.innerText = '🛑 DỪNG';
        btnStop.disabled = false;
    }

    setDisplay(consoleBox, 'block');
    if (statusMsg) {
        statusMsg.innerText = '🔄 Đang chạy tiến trình...';
        statusMsg.style.color = '#f1c40f';
    }
}

async function requestStop() {
    if(!confirm('Bạn chắc chắn muốn dừng?')) return;
    if (btnStop) {
        btnStop.disabled = true;
        btnStop.innerText = '⏳ Đang dừng...';
    }
    try { await fetch('/api/download/stop', { method: 'POST' }); } catch (e) {}
}

function resetUI() {
    setDisplay(input, 'block');
    if (input) input.value = '';
    
    setDisplay(btnCheck, 'block');
    if (btnCheck) {
        btnCheck.disabled = false;
        btnCheck.innerText = '🔎 Kiểm Tra Thông Tin';
    }
    
    setDisplay(preview, 'none');
    setDisplay(videoListBox, 'none');
    if (videoListBox) videoListBox.innerHTML = ''; 
    setDisplay(controls, 'none');
    
    validUrl = '';
    currentPlaylistItems = [];
    currentFormats = [];
    if(pollInterval) clearInterval(pollInterval);
}

// --- 3. LOGIC XỬ LÝ FORMAT (VIDEO LẺ) ---

// [MỚI] Hàm chỉ cho phép chọn 1 checkbox (Radio behavior)
window.onlyOne = function(checkbox) {
    const checkboxes = document.getElementsByName('format-chk');
    checkboxes.forEach((item) => {
        if (item !== checkbox) item.checked = false;
    });
}

function toggleFormatMode() {
    // Ẩn các nút chính
    setDisplay(btnDownloadAll, 'none');
    setDisplay(btnSelectMode, 'none');
    
    // Hiện nút tải selected
    setDisplay(btnDownloadSelected, 'block');
    if(btnDownloadSelected) btnDownloadSelected.innerText = '⬇️ TẢI LUỒNG ĐÃ CHỌN';

    renderFormatList();
    setDisplay(videoListBox, 'block');
}

function renderFormatList() {
    if (!videoListBox) return;
    videoListBox.innerHTML = '';
    
    if (!currentFormats || currentFormats.length === 0) {
        videoListBox.innerHTML = '<div style="padding:15px; text-align:center; color:#777;">Không tìm thấy luồng tải đặc biệt (Chỉ có mặc định).</div>';
        return;
    }

    // Header hướng dẫn
    const header = document.createElement('div');
    header.style.padding = '10px';
    header.style.color = '#aaa';
    header.style.fontSize = '0.9rem';
    header.style.borderBottom = '1px solid #444';
    header.style.marginBottom = '5px';
    header.innerText = '⚠️ Lưu ý: Video chất lượng cao (1080p+) thường không kèm tiếng. Hãy chọn kỹ.';
    videoListBox.appendChild(header);

    currentFormats.forEach((fmt) => {
        const div = document.createElement('div');
        div.className = 'video-item';
        // Hiển thị: 1080p (mp4) - 50MB [Note]
        const labelText = `<b>${fmt.resolution}</b> (${fmt.ext}) - ${fmt.filesize} <span style="color:#888; font-size:0.85em">[${fmt.note}]</span>`;
        
        div.innerHTML = `
            <input type="checkbox" name="format-chk" id="fmt-${fmt.id}" value="${fmt.id}" onclick="onlyOne(this)">
            <label for="fmt-${fmt.id}">${labelText}</label>
        `;
        videoListBox.appendChild(div);
    });
}

// --- 4. LOGIC XỬ LÝ PLAYLIST (NHIỀU BÀI) ---

function toggleSelectionMode() {
    setDisplay(btnDownloadAll, 'none');
    setDisplay(btnSelectMode, 'none');
    
    setDisplay(btnDownloadSelected, 'block');
    if(btnDownloadSelected) btnDownloadSelected.innerText = '⬇️ TẢI CÁC BÀI ĐÃ CHỌN';
    
    renderVideoList();
    setDisplay(videoListBox, 'block');
}

function renderVideoList() {
    if (!videoListBox) return;
    videoListBox.innerHTML = '';
    
    if (!currentPlaylistItems || currentPlaylistItems.length === 0) {
        videoListBox.innerHTML = '<div style="padding:15px; text-align:center; color:#777;">Không tìm thấy danh sách bài hát.</div>';
        return;
    }

    currentPlaylistItems.forEach((item, index) => {
        const realIndex = index + 1;
        const div = document.createElement('div');
        div.className = 'video-item';
        div.innerHTML = `
            <input type="checkbox" class="playlist-chk" id="chk-${realIndex}" value="${realIndex}">
            <label for="chk-${realIndex}"><b>#${realIndex}</b>. ${item.title || 'Unknown Track'}</label>
        `;
        videoListBox.appendChild(div);
    });
}

// --- 5. LOGIC CHÍNH: KIỂM TRA LINK & BẮT ĐẦU TẢI ---

async function checkLink() {
    const url = input ? input.value.trim() : '';
    if (!url) return;

    if (btnCheck) {
        btnCheck.disabled = true;
        btnCheck.innerText = '⏳ Đang phân tích...';
    }
    if (statusMsg) statusMsg.innerText = '';
    setDisplay(consoleBox, 'none');

    // Reset dữ liệu cũ
    currentPlaylistItems = [];
    currentFormats = [];

    try {
        const res = await fetch('/api/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();

        if (res.ok) {
            const info = data.data;
            // Fill thông tin
            if (document.getElementById('dlTitle')) document.getElementById('dlTitle').innerText = info.title;
            if (document.getElementById('dlUploader')) document.getElementById('dlUploader').innerText = info.uploader;
            if (document.getElementById('dlType')) document.getElementById('dlType').innerText = info.type;
            if (document.getElementById('dlCount')) document.getElementById('dlCount').innerText = info.count;
            
            const img = document.getElementById('dlImg');
            if(img && info.thumbnail) { img.src = info.thumbnail; img.style.display='block'; }
            
            // Lưu dữ liệu trả về
            currentPlaylistItems = info.entries || [];
            currentFormats = info.formats || [];
            validUrl = info.url;

            // Chuyển giao diện
            setDisplay(input, 'none');
            setDisplay(btnCheck, 'none');
            setDisplay(preview, 'flex');
            setDisplay(controls, 'flex');
            setDisplay(btnStop, 'none');
            setDisplay(btnDownloadSelected, 'none');
            setDisplay(videoListBox, 'none');

            // --- PHÂN LOẠI UI: PLAYLIST vs SINGLE VIDEO ---
            if ((info.type === 'Playlist' || info.type === 'playlist') && info.count > 1) {
                // >> GIAO DIỆN PLAYLIST
                setDisplay(btnDownloadAll, 'block');
                if (btnDownloadAll) btnDownloadAll.innerText = '⬇️ TẢI TOÀN BỘ (' + info.count + ')';
                
                setDisplay(btnSelectMode, 'block'); 
                if (btnSelectMode) {
                    btnSelectMode.innerText = '📝 TẢI TÙY CHỌN';
                    btnSelectMode.onclick = toggleSelectionMode; // Gán hàm xử lý Playlist
                }
            } else {
                // >> GIAO DIỆN VIDEO ĐƠN LẺ
                setDisplay(btnDownloadAll, 'block');
                // 1. Sửa tên nút Bắt đầu
                if (btnDownloadAll) btnDownloadAll.innerText = '⬇️ TẢI NHẠC TỪ VIDEO (MP3)';
                
                // 2. Hiện nút Chọn luồng
                setDisplay(btnSelectMode, 'block');
                if (btnSelectMode) {
                    btnSelectMode.innerText = '⚙️ CHỌN LUỒNG TẢI';
                    btnSelectMode.onclick = toggleFormatMode; // Gán hàm xử lý Format
                }
            }

            if (statusMsg) statusMsg.innerText = '';
        } else {
            throw new Error(data.error);
        }
    } catch (e) {
        if (statusMsg) {
            statusMsg.innerText = '❌ ' + e.message;
            statusMsg.style.color = '#e74c3c';
        }
        if (btnCheck) {
            btnCheck.disabled = false;
            btnCheck.innerText = '🔎 Kiểm Tra Lại';
        }
        setDisplay(input, 'block');
    }
}

async function startDownload(mode) {
    if (!validUrl) return;
    
    let payload = { url: validUrl };

    if (mode === 'selected') {
        // Kiểm tra xem đang ở chế độ chọn Format hay chọn Playlist Item
        const isFormatMode = document.querySelector('input[name="format-chk"]');

        if (isFormatMode) {
            // --- LOGIC TẢI FORMAT (VIDEO LẺ) ---
            const checkbox = document.querySelector('input[name="format-chk"]:checked');
            if (!checkbox) {
                alert("Vui lòng chọn 1 luồng để tải!");
                return;
            }
            payload.formatId = checkbox.value; // Gửi formatId
        } else {
            // --- LOGIC TẢI PLAYLIST ITEM ---
            const checkboxes = document.querySelectorAll('.playlist-chk:checked');
            if (checkboxes.length === 0) {
                alert("Vui lòng chọn ít nhất 1 bài hát!");
                return;
            }
            const indices = Array.from(checkboxes).map(cb => cb.value).join(',');
            payload.indices = indices;
        }
        
        setDisplay(videoListBox, 'none');
    }

    // UI Updates
    setDisplay(controls, 'flex');
    setDisplay(btnDownloadAll, 'none');
    setDisplay(btnSelectMode, 'none');
    setDisplay(btnDownloadSelected, 'none');
    
    setDisplay(btnStop, 'block');
    setDisplay(preview, 'none');
    setDisplay(consoleBox, 'block');

    try {
        const res = await fetch('/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (res.ok) {
            startPolling();
        } else {
            if (logContent) logContent.innerHTML += `<div class="log-line" style="color:red">${data.error}</div>`;
            setTimeout(resetUI, 3000);
        }
    } catch (e) {
        if (statusMsg) statusMsg.innerText = '❌ Lỗi kết nối';
        setTimeout(resetUI, 3000);
    }
}

function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
        try {
            const res = await fetch('/api/download/status');
            const state = await res.json();
            
            if (state.logs && state.logs.length > 0 && logContent) {
                logContent.innerHTML = state.logs.map(l => {
                    let color = '#0f0'; 
                    if (l.includes('❌') || l.includes('🔥') || l.includes('🛑')) color = '#e74c3c'; 
                    if (l.includes('⬇️')) color = '#3498db'; 
                    if (l.includes('☁️')) color = '#f1c40f'; 
                    if (l.includes('✅')) color = '#2ecc71';
                    return `<div class="log-line" style="color:${color}">${l}</div>`;
                }).join('');
                if (consoleBox) consoleBox.scrollTop = consoleBox.scrollHeight;
            }

            if (!state.isProcessing) {
                clearInterval(pollInterval);
                if (statusMsg) {
                    statusMsg.innerText = '✅ Quy trình hoàn tất/đã dừng!';
                    statusMsg.style.color = '#1db954';
                }
                
                setDisplay(btnStop, 'none');

                if (typeof window.init === 'function' && typeof window.updateLibrary !== 'undefined') {
                    console.log("🔄 Auto-refreshing library...");
                    window.init(); 
                }
                
                if(!document.getElementById('btnReset')) {
                    const btnReset = document.createElement('button');
                    btnReset.id = 'btnReset';
                    btnReset.className = 'btn-full';
                    btnReset.innerText = '🔎 Tải tiếp bài khác';
                    btnReset.style.backgroundColor = '#333';
                    btnReset.onclick = () => { btnReset.remove(); resetUI(); if(statusMsg) statusMsg.innerText = ''; };
                    if (consoleBox) consoleBox.after(btnReset);
                }
            }
        } catch (e) { console.error(e); }
    }, 1000); 
}