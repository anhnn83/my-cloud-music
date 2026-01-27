// src/public/downloader.js - Version 3.6 (UI Fixed)

const input = document.getElementById('dlLink');
const preview = document.getElementById('dlPreview');
// [MỚI] Lấy thêm khung điều khiển
const controls = document.getElementById('dlControls');

const btnCheck = document.getElementById('btnCheck');
const btnDownload = document.getElementById('btnDownload');
const btnStop = document.getElementById('btnStop');

const statusMsg = document.getElementById('dlStatus');
const consoleBox = document.getElementById('consoleBox');
const logContent = document.getElementById('logContent');

let validUrl = '';
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
    
    // Ẩn Preview khi F5 vì dữ liệu title/img đã mất, nhìn sẽ bị lỗi
    preview.style.display = 'none'; 
    
    // Hiện khung nút bấm
    controls.style.display = 'flex';
    
    btnDownload.style.display = 'none';
    btnStop.style.display = 'block';
    btnStop.innerText = '🛑 DỪNG';
    btnStop.disabled = false;

    const guideText = document.querySelector('.dl-container p');
    if(guideText) guideText.style.display = 'none';

    consoleBox.style.display = 'block';
    statusMsg.innerText = '🔄 Đang chạy tiến trình...';
    statusMsg.style.color = '#f1c40f';
}

async function requestStop() {
    if(!confirm('Bạn chắc chắn muốn dừng? Bài đang tải dở sẽ được hoàn thành nốt.')) return;
    btnStop.disabled = true;
    btnStop.innerText = '⏳ Đang dừng...';
    try { await fetch('/api/download/stop', { method: 'POST' }); } catch (e) { console.error(e); }
}

function resetUI() {
    input.style.display = 'block';
    input.value = '';
    btnCheck.style.display = 'block';
    btnCheck.disabled = false;
    btnCheck.innerText = '🔎 Kiểm Tra Thông Tin';
    
    const guideText = document.querySelector('.dl-container p');
    if(guideText) guideText.style.display = 'block';

    preview.style.display = 'none';
    controls.style.display = 'none'; // Ẩn nút
    
    validUrl = '';
    if(pollInterval) clearInterval(pollInterval);
}

// --- LOGIC ---

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
            // Fill data
            document.getElementById('dlTitle').innerText = data.data.title;
            document.getElementById('dlUploader').innerText = data.data.uploader;
            document.getElementById('dlType').innerText = data.data.type;
            document.getElementById('dlCount').innerText = data.data.count;
            const img = document.getElementById('dlImg');
            if(data.data.thumbnail) { img.src = data.data.thumbnail; img.style.display='block'; }
            
            // UI Switch
            input.style.display = 'none';
            btnCheck.style.display = 'none';
            
            preview.style.display = 'flex';   // Hiện thông tin
            controls.style.display = 'flex';  // Hiện nút bấm
            
            // Reset nút về trạng thái Bắt đầu
            btnDownload.style.display = 'block';
            btnStop.style.display = 'none';
            
            validUrl = data.data.url;
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

async function startDownload() {
    if (!validUrl) return;

    // Chuyển nút sang trạng thái Stop
    btnDownload.style.display = 'none';
    btnStop.style.display = 'block';

    // Ẩn khung thông tin để tập trung vào Console
    preview.style.display = 'none';
    
    // Hiện Console
    consoleBox.style.display = 'block';
    
    const guideText = document.querySelector('.dl-container p');
    if(guideText) guideText.style.display = 'none';

    try {
        const res = await fetch('/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: validUrl })
        });

        const data = await res.json();

        if (res.ok) {
            startPolling();
        } else {
            logContent.innerHTML += `<div class="log-line" style="color:red">${data.error}</div>`;
            if (data.error.includes('đang bận')) {
                setTimeout(() => {
                    restoreProcessingUI();
                    startPolling();
                }, 2000);
            } else {
                setTimeout(resetUI, 3000);
            }
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
            
            // 1. Vẽ Logs
            if (state.logs && state.logs.length > 0) {
                logContent.innerHTML = state.logs.map(l => {
                    let color = '#0f0'; 
                    if (l.includes('❌') || l.includes('🔥') || l.includes('🛑')) color = '#e74c3c'; 
                    if (l.includes('⬇️')) color = '#3498db'; 
                    if (l.includes('☁️')) color = '#f1c40f'; 
                    if (l.includes('✅')) color = '#2ecc71';
                    if (l.includes('⚠️')) color = '#e67e22'; // Màu cam cho cảnh báo
                    return `<div class="log-line" style="color:${color}">${l}</div>`;
                }).join('');
                consoleBox.scrollTop = consoleBox.scrollHeight;
            }

            // 2. [LOGIC MỚI] Kiểm tra trạng thái
            // Nếu Backend báo đã ngừng xử lý (isProcessing = false) -> KẾT THÚC NGAY
            if (!state.isProcessing) {
                clearInterval(pollInterval);
                
                const lastLog = state.logs.length > 0 ? state.logs[state.logs.length - 1] : '';

                // Phân loại thông báo dựa trên log cuối
                if (lastLog.includes('HOÀN TẤT')) {
                    statusMsg.innerText = '✅ Quy trình hoàn tất!';
                    statusMsg.style.color = '#1db954';
                } else if (lastLog.includes('DỪNG') || lastLog.includes('hủy')) {
                    // Bắt thêm từ khóa 'hủy' để khớp với log backend
                    statusMsg.innerText = '🛑 Đã dừng quy trình.';
                    statusMsg.style.color = '#e74c3c';
                } else {
                    statusMsg.innerText = '⚠️ Quy trình kết thúc (Có lỗi hoặc đã dừng).';
                    statusMsg.style.color = '#f1c40f';
                }
                
                // [QUAN TRỌNG] Reset lại nút bấm
                btnStop.style.display = 'none';
                btnDownload.style.display = 'block'; // Hiện lại nút Bắt đầu
                btnDownload.innerText = '⬇️ BẮT ĐẦU TIẾN TRÌNH';
                btnDownload.disabled = false;
                
                // Hiện nút tải bài khác
                setTimeout(() => {
                    const existingBtn = document.getElementById('btnReset');
                    if (!existingBtn) {
                        const btnReset = document.createElement('button');
                        btnReset.id = 'btnReset';
                        btnReset.className = 'btn-full';
                        btnReset.innerText = '🔎 Tải bài khác';
                        btnReset.style.backgroundColor = '#333';
                        btnReset.onclick = () => {
                            btnReset.remove();
                            resetUI();
                            statusMsg.innerText = '';
                        };
                        consoleBox.after(btnReset);
                    }
                }, 1000);
            }
        } catch (e) { console.error(e); }
    }, 1000); 
}