// src/public/downloader.js - Version 4.0 (Partial Download Support)

const input = document.getElementById('dlLink');
const preview = document.getElementById('dlPreview');
const controls = document.getElementById('dlControls');
const videoListBox = document.getElementById('videoListBox');

const btnCheck = document.getElementById('btnCheck');
const btnDownloadAll = document.getElementById('btnDownloadAll');
const btnSelectMode = document.getElementById('btnSelectMode');
const btnDownloadSelected = document.getElementById('btnDownloadSelected');
const btnStop = document.getElementById('btnStop');

const statusMsg = document.getElementById('dlStatus');
const consoleBox = document.getElementById('consoleBox');
const logContent = document.getElementById('logContent');

let validUrl = '';
let currentPlaylistItems = []; // Lưu danh sách bài hát trả về từ API
let pollInterval = null;

input.addEventListener("keypress", (e) => { if (e.key === "Enter") checkLink(); });

// --- INIT ---
(async function init() {
    try {
        const res = await fetch('/api/download/status');
        const state = await res.json();
        if (state.isProcessing) {
            restoreProcessingUI();
            startPolling();
        }
    } catch (e) { console.error("Lỗi init:", e); }
})();

function restoreProcessingUI() {
    input.style.display = 'none';
    btnCheck.style.display = 'none';
    preview.style.display = 'none';
    videoListBox.style.display = 'none';
    
    controls.style.display = 'flex';
    btnDownloadAll.style.display = 'none';
    btnSelectMode.style.display = 'none';
    btnDownloadSelected.style.display = 'none';
    
    btnStop.style.display = 'block';
    btnStop.innerText = '🛑 DỪNG';
    btnStop.disabled = false;

    consoleBox.style.display = 'block';
    statusMsg.innerText = '🔄 Đang chạy tiến trình...';
    statusMsg.style.color = '#f1c40f';
}

async function requestStop() {
    if(!confirm('Bạn chắc chắn muốn dừng?')) return;
    btnStop.disabled = true;
    btnStop.innerText = '⏳ Đang dừng...';
    try { await fetch('/api/download/stop', { method: 'POST' }); } catch (e) {}
}

function resetUI() {
    input.style.display = 'block';
    input.value = '';
    btnCheck.style.display = 'block';
    btnCheck.disabled = false;
    btnCheck.innerText = '🔎 Kiểm Tra Thông Tin';
    
    preview.style.display = 'none';
    videoListBox.style.display = 'none';
    videoListBox.innerHTML = ''; // Xóa danh sách cũ
    controls.style.display = 'none';
    
    validUrl = '';
    currentPlaylistItems = [];
    if(pollInterval) clearInterval(pollInterval);
}

// --- LOGIC MỚI: XỬ LÝ CHECKBOX ---
function toggleSelectionMode() {
    // Ẩn nút "Tải Toàn Bộ" và nút "Tải Tùy Chọn"
    btnDownloadAll.style.display = 'none';
    btnSelectMode.style.display = 'none';
    
    // Hiện nút "Tải các bài đã chọn"
    btnDownloadSelected.style.display = 'block';
    
    // Render danh sách checkbox
    renderVideoList();
    videoListBox.style.display = 'block';
}

function renderVideoList() {
    videoListBox.innerHTML = '';
    if (!currentPlaylistItems || currentPlaylistItems.length === 0) {
        videoListBox.innerHTML = '<div style="padding:15px; text-align:center; color:#777;">Không tìm thấy danh sách bài hát chi tiết.</div>';
        return;
    }

    currentPlaylistItems.forEach((item, index) => {
        // item có dạng: { title: "Tên bài", id: "VIDEO_ID", ... }
        // Index trong yt-dlp bắt đầu từ 1
        const realIndex = index + 1;
        
        const div = document.createElement('div');
        div.className = 'video-item';
        div.innerHTML = `
            <input type="checkbox" id="chk-${realIndex}" value="${realIndex}">
            <label for="chk-${realIndex}"><b>#${realIndex}</b>. ${item.title || 'Unknown Track'}</label>
        `;
        videoListBox.appendChild(div);
    });
}

// --- LOGIC CHÍNH ---

async function checkLink() {
    const url = input.value.trim();
    if (!url) return;

    btnCheck.disabled = true;
    btnCheck.innerText = '⏳ Đang phân tích...';
    statusMsg.innerText = '';
    consoleBox.style.display = 'none';

    try {
        const res = await fetch('/api/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();

        if (res.ok) {
            // Fill Info
            const info = data.data;
            document.getElementById('dlTitle').innerText = info.title;
            document.getElementById('dlUploader').innerText = info.uploader;
            document.getElementById('dlType').innerText = info.type;
            document.getElementById('dlCount').innerText = info.count;
            const img = document.getElementById('dlImg');
            if(info.thumbnail) { img.src = info.thumbnail; img.style.display='block'; }
            
            // Lưu lại danh sách bài hát (Nếu backend trả về)
            currentPlaylistItems = info.items || [];
            validUrl = info.url;

            // UI Switch
            input.style.display = 'none';
            btnCheck.style.display = 'none';
            preview.style.display = 'flex';
            controls.style.display = 'flex';
            
            // Reset buttons
            btnStop.style.display = 'none';
            btnDownloadSelected.style.display = 'none';
            videoListBox.style.display = 'none';

            // [LOGIC QUYẾT ĐỊNH HIỂN THỊ NÚT]
            if (info.type === 'playlist' && info.count > 2) {
                // Nếu là playlist > 2 bài -> Hiện cả 2 nút
                btnDownloadAll.style.display = 'block';
                btnDownloadAll.innerText = '⬇️ TẢI TOÀN BỘ (' + info.count + ')';
                
                btnSelectMode.style.display = 'block'; // Hiện nút Tải tùy chọn
            } else {
                // Nếu là video lẻ hoặc playlist ít bài -> Chỉ hiện nút Tải (như cũ)
                btnDownloadAll.style.display = 'block';
                btnDownloadAll.innerText = '⬇️ BẮT ĐẦU TIẾN TRÌNH';
                btnSelectMode.style.display = 'none';
            }

            statusMsg.innerText = '';
        } else {
            throw new Error(data.error);
        }
    } catch (e) {
        statusMsg.innerText = '❌ ' + e.message;
        statusMsg.style.color = '#e74c3c';
        btnCheck.disabled = false;
        btnCheck.innerText = '🔎 Kiểm Tra Lại';
        input.style.display = 'block';
    }
}

async function startDownload(mode) {
    if (!validUrl) return;
    
    let payload = { url: validUrl };

    // XỬ LÝ CHẾ ĐỘ TÙY CHỌN
    if (mode === 'selected') {
        const checkboxes = document.querySelectorAll('.video-item input[type="checkbox"]:checked');
        if (checkboxes.length === 0) {
            alert("Vui lòng chọn ít nhất 1 bài hát!");
            return;
        }
        
        // Tạo chuỗi indices (Ví dụ: "1,3,5,10")
        const indices = Array.from(checkboxes).map(cb => cb.value).join(',');
        payload.indices = indices; // Gửi kèm danh sách index lên server
        
        videoListBox.style.display = 'none'; // Ẩn list đi cho gọn
    }

    // UI Updates
    controls.style.display = 'flex'; // Đảm bảo hiện khung
    btnDownloadAll.style.display = 'none';
    btnSelectMode.style.display = 'none';
    btnDownloadSelected.style.display = 'none';
    
    btnStop.style.display = 'block';
    preview.style.display = 'none';
    consoleBox.style.display = 'block';

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
            logContent.innerHTML += `<div class="log-line" style="color:red">${data.error}</div>`;
            setTimeout(resetUI, 3000);
        }
    } catch (e) {
        statusMsg.innerText = '❌ Lỗi kết nối';
        setTimeout(resetUI, 3000);
    }
}

function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
        try {
            const res = await fetch('/api/download/status');
            const state = await res.json();
            
            if (state.logs && state.logs.length > 0) {
                logContent.innerHTML = state.logs.map(l => {
                    let color = '#0f0'; 
                    if (l.includes('❌') || l.includes('🔥') || l.includes('🛑')) color = '#e74c3c'; 
                    if (l.includes('⬇️')) color = '#3498db'; 
                    if (l.includes('☁️')) color = '#f1c40f'; 
                    if (l.includes('✅')) color = '#2ecc71';
                    return `<div class="log-line" style="color:${color}">${l}</div>`;
                }).join('');
                consoleBox.scrollTop = consoleBox.scrollHeight;
            }

            if (!state.isProcessing) {
                clearInterval(pollInterval);
                statusMsg.innerText = '✅ Quy trình hoàn tất/đã dừng!';
                statusMsg.style.color = '#1db954';
                
                btnStop.style.display = 'none';
                
                // Hiện nút tải bài khác
                if(!document.getElementById('btnReset')) {
                    const btnReset = document.createElement('button');
                    btnReset.id = 'btnReset';
                    btnReset.className = 'btn-full';
                    btnReset.innerText = '🔎 Tải tiếp bài khác';
                    btnReset.style.backgroundColor = '#333';
                    btnReset.onclick = () => { btnReset.remove(); resetUI(); statusMsg.innerText = ''; };
                    consoleBox.after(btnReset);
                }
            }
        } catch (e) { console.error(e); }
    }, 1000); 
}