/* ═══════════════════════════════════════════════════════
   野生動物通報平台 — 前端邏輯
   ═══════════════════════════════════════════════════════ */

// ── 物種 Emoji 對照 ─────────────────────────────────────
const SPECIES_EMOJI = {
  '台灣黑熊':'🐻','黑熊':'🐻',
  '石虎':'🐆',
  '台灣獼猴':'🐒','獼猴':'🐒',
  '山羌':'🦌','水鹿':'🦌','梅花鹿':'🦌',
  '台灣野豬':'🐗','野豬':'🐗',
  '白鼻心':'🦡','鼬獾':'🦡',
  '飛鼠':'🦇','蝙蝠':'🦇',
  '赤腹松鼠':'🐿️','松鼠':'🐿️',
  '台灣藍鵲':'🦚','藍鵲':'🦚',
  '領角鴞':'🦉','貓頭鷹':'🦉',
  '鳳頭蒼鷹':'🦅','老鷹':'🦅','台灣黑鳶':'🦅',
  '雨傘節':'🐍','龜殼花':'🐍','眼鏡蛇':'🐍','百步蛇':'🐍','蛇':'🐍',
  '台灣草蜥':'🦎','蜥蜴':'🦎',
  '草龜':'🐢','斑龜':'🐢','龜':'🐢',
  '緬甸蟒':'🐍','蟒':'🐍',
};
function getEmoji(species) {
  for (const [k, v] of Object.entries(SPECIES_EMOJI)) {
    if (species.includes(k)) return v;
  }
  return '🦎';
}

const STATUS_LABELS = { alive:'存活', injured:'受傷', dead:'死亡', unknown:'不確定' };
const STATUS_COLORS = { alive:'#22c55e', injured:'#f97316', dead:'#ef4444', unknown:'#94a3b8' };

// 台灣生物多樣性網絡 (TBN) 物種搜尋連結
function speciesWikiUrl(species) {
  return `https://www.tbn.org.tw/search?q=${encodeURIComponent(species)}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// ── PWA Service Worker 註冊 ─────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ── PWA 安裝 Banner ─────────────────────────────────────
let deferredInstallPrompt = null;

// Android / Chrome：攔截安裝事件
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  // 若使用者之前沒有關掉過，5 秒後顯示
  if (!localStorage.getItem('pwa-banner-dismissed')) {
    setTimeout(showInstallBanner, 5000);
  }
});

// iOS Safari 偵測（不支援 beforeinstallprompt）
function isIosSafari() {
  const ua = navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) && /safari/i.test(ua) && !/crios|fxios|opios/i.test(ua);
}

function isStandalone() {
  return window.navigator.standalone === true ||
         window.matchMedia('(display-mode: standalone)').matches;
}

function showInstallBanner() {
  const banner = document.getElementById('install-banner');
  if (!banner || isStandalone()) return;
  banner.classList.remove('hidden');
}

function showIosBanner() {
  const banner = document.getElementById('install-banner');
  if (!banner) return;
  banner.classList.add('ios-hint');
  banner.classList.remove('hidden');
  document.getElementById('install-banner-sub').textContent = '請依下列步驟加入主畫面';
  // 插入步驟說明
  if (!document.getElementById('ios-steps')) {
    const steps = document.createElement('div');
    steps.id = 'ios-steps';
    steps.className = 'ios-steps';
    steps.innerHTML = '1. 點選底部 <strong>分享</strong> 按鈕 ⎋<br>2. 選擇「<strong>加入主畫面</strong>」<br>3. 點「<strong>新增</strong>」即完成';
    banner.appendChild(steps);
  }
}

// 安裝按鈕點擊（Android）
document.addEventListener('DOMContentLoaded', () => {
  const installBtn   = document.getElementById('install-banner-btn');
  const installClose = document.getElementById('install-banner-close');
  const banner       = document.getElementById('install-banner');

  installBtn && installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    banner.classList.add('hidden');
    if (outcome === 'accepted') localStorage.setItem('pwa-banner-dismissed', '1');
  });

  installClose && installClose.addEventListener('click', () => {
    banner.classList.add('hidden');
    localStorage.setItem('pwa-banner-dismissed', '1');
  });

  // iOS：若是 iOS Safari 且未安裝，3 秒後顯示說明 banner
  if (isIosSafari() && !isStandalone() && !localStorage.getItem('pwa-banner-dismissed')) {
    setTimeout(showIosBanner, 3000);
  }
});

// ── 全域狀態 ────────────────────────────────────────────
let mainMap, miniMapMap;
let markersLayer;
let allReports = [];
let currentUser = null;
let selectedLat = null, selectedLng = null;
let selectedAddress = '';
let selectedStatus = 'alive';
let photoFiles = [];
let miniMapMarker = null;
let miniMapReady = false;
let editingReportId = null;
let keepImages = [];
// 篩選狀態
let filterStatus = ['alive','injured','dead','unknown'];
let filterDays   = '';

// ── 啟動 ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initMainMap();
  bindEvents();
  checkUrlError();
  await checkAuth();
  await loadReports().catch(err => {
    console.error('載入通報失敗:', err);
    showToast('資料載入失敗，請重新整理', 'error');
  });
  await checkUrlParams();
});

// 處理分享連結 (?report=ID)
async function checkUrlParams() {
  const params   = new URLSearchParams(location.search);
  const reportId = parseInt(params.get('report'));
  if (!reportId) return;

  // 試著飛到通報位置
  const found = allReports.find(r => r.id === reportId);
  if (found) mainMap.flyTo([found.lat, found.lng], 15);

  await openDetailModal(reportId).catch(() => {
    showToast('找不到此通報', 'error');
    history.replaceState({}, '', '/');
  });
}

// ── 認證 ─────────────────────────────────────────────────
async function checkAuth() {
  const res = await fetch('/auth/user');
  const data = await res.json();
  currentUser = data.user;
  renderAuthUI(data.isAdmin);
}

function renderAuthUI(isAdmin = false) {
  const loginBtn = document.getElementById('line-login-btn');
  const userInfo = document.getElementById('user-info');
  if (currentUser) {
    loginBtn.classList.add('hidden');
    userInfo.classList.remove('hidden');
    document.getElementById('user-avatar').src = currentUser.avatar || '';
    document.getElementById('user-name').textContent = currentUser.name;
    const adminBtn = document.getElementById('admin-btn');
    if (adminBtn) adminBtn.classList.toggle('hidden', !isAdmin);
  } else {
    loginBtn.classList.remove('hidden');
    userInfo.classList.add('hidden');
  }
}

// ── 主地圖 ────────────────────────────────────────────────
function initMainMap() {
  mainMap = L.map('map', { zoomControl: true }).setView([23.6978, 120.9605], 8);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org">OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(mainMap);
  markersLayer = L.layerGroup().addTo(mainMap);
}

// ── 讀取通報 ──────────────────────────────────────────────
async function loadReports(filterSpecies = '') {
  const params = new URLSearchParams();
  if (filterSpecies)                          params.set('species', filterSpecies);
  if (filterStatus.length < 4)               params.set('status', filterStatus.join(','));
  if (filterDays)                             params.set('days', filterDays);
  const res = await fetch('/api/reports?' + params.toString());
  allReports = await res.json();
  renderMarkers(allReports);
  document.getElementById('total-reports').textContent = allReports.length;
  updateFilterCount();
}

function updateFilterCount() {
  const count = (filterStatus.length < 4 ? 1 : 0) + (filterDays ? 1 : 0);
  const badge = document.getElementById('filter-count');
  const btn   = document.getElementById('filter-btn');
  badge.textContent = count;
  badge.classList.toggle('hidden', count === 0);
  btn.classList.toggle('active', count > 0);
}

function renderMarkers(reports) {
  markersLayer.clearLayers();
  reports.forEach(r => {
    const icon = createMarkerIcon(r.status, r.species);
    const marker = L.marker([r.lat, r.lng], { icon }).addTo(markersLayer);
    marker.bindPopup(makePopupHtml(r), { maxWidth: 240 });
    marker.on('popupopen', () => {
      document.getElementById(`popup-open-${r.id}`)
        ?.addEventListener('click', () => openDetailModal(r.id));
    });
  });
}

function createMarkerIcon(status, species) {
  const color = STATUS_COLORS[status] || STATUS_COLORS.unknown;
  const emoji = getEmoji(species);
  return L.divIcon({
    html: `<div class="marker-icon" style="
      width:40px;height:40px;
      background:${color};
    ">${emoji}</div>`,
    className: '',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    popupAnchor: [0, -22]
  });
}

function makePopupHtml(r) {
  const statusLabel = STATUS_LABELS[r.status] || r.status;
  const color = STATUS_COLORS[r.status] || STATUS_COLORS.unknown;
  return `
    <div class="popup-inner">
      <div class="popup-species">
        ${getEmoji(r.species)} ${escapeHtml(r.species)}
        <a href="${speciesWikiUrl(r.species)}" target="_blank" rel="noopener noreferrer"
           class="popup-wiki-link" title="查詢物種百科">📖</a>
      </div>
      <div class="popup-meta">
        數量：${r.quantity} 隻 ・
        <span style="color:${color};font-weight:600">${statusLabel}</span>
      </div>
      ${r.address ? `<div class="popup-meta">📍 ${escapeHtml(r.address)}</div>` : ''}
      <div class="popup-meta">${formatDate(r.created_at)}</div>
    </div>
    <button class="popup-open" id="popup-open-${r.id}">查看詳情 →</button>
  `;
}

// ── 事件綁定 ──────────────────────────────────────────────
function bindEvents() {
  // Header auth
  document.getElementById('line-login-btn').addEventListener('click', lineLogin);
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    currentUser = null;
    renderAuthUI();
    showToast('已登出');
  });

  // ── 進階篩選 ──
  const filterBtn   = document.getElementById('filter-btn');
  const filterPanel = document.getElementById('filter-panel');

  filterBtn.addEventListener('click', () => {
    filterPanel.classList.toggle('hidden');
  });

  // checkbox 樣式同步
  document.querySelectorAll('.fcheck').forEach(label => {
    const cb = label.querySelector('input');
    label.classList.toggle('checked', cb.checked);
    cb.addEventListener('change', () => label.classList.toggle('checked', cb.checked));
  });

  // 時間範圍按鈕
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.day-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // 套用篩選
  document.getElementById('filter-apply').addEventListener('click', () => {
    filterStatus = Array.from(document.querySelectorAll('.fcheck input:checked')).map(cb => cb.value);
    if (!filterStatus.length) filterStatus = ['alive','injured','dead','unknown'];
    filterDays = document.querySelector('.day-btn.active')?.dataset.days || '';
    filterPanel.classList.add('hidden');
    loadReports(document.getElementById('filter-input').value.trim());
  });

  // 重設篩選
  document.getElementById('filter-reset').addEventListener('click', () => {
    filterStatus = ['alive','injured','dead','unknown'];
    filterDays   = '';
    document.querySelectorAll('.fcheck input').forEach(cb => { cb.checked = true; cb.closest('.fcheck').classList.add('checked'); });
    document.querySelectorAll('.day-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.day-btn[data-days=""]').classList.add('active');
    updateFilterCount();
    filterPanel.classList.add('hidden');
    loadReports(document.getElementById('filter-input').value.trim());
  });

  // 我的通報
  document.getElementById('my-reports-btn').addEventListener('click', openMyReports);
  document.getElementById('close-my-reports').addEventListener('click', () => {
    document.getElementById('my-reports-modal').classList.add('hidden');
  });
  document.getElementById('my-reports-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('my-reports-modal'))
      document.getElementById('my-reports-modal').classList.add('hidden');
  });

  // Filter
  const filterInput = document.getElementById('filter-input');
  const filterClear = document.getElementById('filter-clear');
  let filterTimer;
  filterInput.addEventListener('input', () => {
    clearTimeout(filterTimer);
    const val = filterInput.value.trim();
    filterClear.classList.toggle('hidden', !val);
    filterTimer = setTimeout(() => loadReports(val), 400);
  });
  filterClear.addEventListener('click', () => {
    filterInput.value = '';
    filterClear.classList.add('hidden');
    loadReports();
  });

  // FAB
  document.getElementById('report-fab').addEventListener('click', () => {
    if (!currentUser) { showLoginPrompt(); return; }
    openReportModal();
  });

  // Report modal close
  document.getElementById('close-report-modal').addEventListener('click', closeReportModal);
  document.getElementById('report-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('report-modal')) closeReportModal();
  });

  // Address search
  document.getElementById('addr-search-btn').addEventListener('click', geocodeAddress);
  // Autocomplete
  let suggestTimer = null;
  document.getElementById('addr-input').addEventListener('input', () => {
    clearTimeout(suggestTimer);
    const q = document.getElementById('addr-input').value.trim();
    if (q.length < 2) { hideSuggestions(); return; }
    suggestTimer = setTimeout(() => fetchSuggestions(q), 300);
  });
  document.getElementById('addr-input').addEventListener('keydown', e => {
    if (e.key === 'Escape') { hideSuggestions(); return; }
    if (e.key === 'Enter') { hideSuggestions(); geocodeAddress(); }
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.addr-input-wrap')) hideSuggestions();
  });

  // GPS
  document.getElementById('gps-btn').addEventListener('click', getGPSLocation);

  // Status buttons
  document.querySelectorAll('.status-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.status-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedStatus = btn.dataset.status;
    });
  });

  // Photo upload
  const uploadArea = document.getElementById('upload-area');
  const photoInput = document.getElementById('photo-input');

  uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
  uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');
    addPhotos(Array.from(e.dataTransfer.files));
  });
  photoInput.addEventListener('change', () => {
    addPhotos(Array.from(photoInput.files));
    photoInput.value = '';
  });

  // Submit
  document.getElementById('submit-btn').addEventListener('click', submitReport);

  // Detail modal close
  document.getElementById('close-detail-modal').addEventListener('click', closeDetailModal);
  // 點遮罩關閉
  document.getElementById('detail-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('detail-modal')) closeDetailModal();
  });
  document.getElementById('detail-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('detail-modal'))
      document.getElementById('detail-modal').classList.add('hidden');
  });

  // Success modal
  document.getElementById('close-success-modal').addEventListener('click', closeSuccessModal);
  document.getElementById('success-close-btn').addEventListener('click', closeSuccessModal);
  document.getElementById('success-view-my-btn').addEventListener('click', () => {
    closeSuccessModal();
    openMyReports();
  });

  // Login prompt
  document.getElementById('login-prompt-btn').addEventListener('click', lineLogin);
  document.getElementById('login-prompt-cancel').addEventListener('click', () => {
    document.getElementById('login-prompt').classList.add('hidden');
  });
  document.getElementById('login-prompt').addEventListener('click', e => {
    if (e.target === document.getElementById('login-prompt'))
      document.getElementById('login-prompt').classList.add('hidden');
  });
}

// ── 通報 Modal ────────────────────────────────────────────
function openReportModal() {
  resetReportForm();
  document.querySelector('#report-modal .modal-header h2').textContent = '新增野生動物通報';
  document.getElementById('submit-btn').textContent = '📤 提交通報';
  document.getElementById('report-modal').classList.remove('hidden');

  // Init mini-map after modal is visible
  setTimeout(() => {
    if (!miniMapReady) {
      miniMapMap = L.map('mini-map').setView([23.6978, 120.9605], 8);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
      }).addTo(miniMapMap);
      miniMapMap.on('click', onMiniMapClick);
      miniMapReady = true;
    } else {
      miniMapMap.invalidateSize();
      miniMapMap.setView([23.6978, 120.9605], 8);
    }
  }, 100);
}

function closeReportModal() {
  document.getElementById('report-modal').classList.add('hidden');
  editingReportId = null;
  keepImages = [];
}

function openEditModal(report) {
  resetReportForm();
  editingReportId = report.id;

  // 預填欄位
  document.getElementById('species-input').value = report.species || '';
  document.getElementById('qty-input').value      = report.quantity || 1;
  document.getElementById('desc-input').value     = report.description || '';

  // 狀態按鈕
  document.querySelectorAll('.status-btn').forEach(b => b.classList.remove('active'));
  const statusBtn = document.querySelector(`.status-btn[data-status="${report.status}"]`);
  if (statusBtn) statusBtn.classList.add('active');
  selectedStatus = report.status || 'alive';

  // 座標與地址
  selectedLat     = report.lat;
  selectedLng     = report.lng;
  selectedAddress = report.address || '';

  // 舊照片 — 存入 keepImages，顯示為縮圖
  let imgs = report.image_paths || [];
  if (typeof imgs === 'string') { try { imgs = JSON.parse(imgs); } catch { imgs = []; } }
  keepImages = [...imgs];
  renderExistingPhotos();

  // 標題與按鈕
  document.querySelector('#report-modal .modal-header h2').textContent = '編輯通報';
  document.getElementById('submit-btn').textContent = '💾 儲存修改';

  // 顯示目前地點
  if (selectedLat) showLocationBadge(selectedAddress || `${selectedLat.toFixed(5)}, ${selectedLng.toFixed(5)}`);

  document.getElementById('detail-modal').classList.add('hidden');
  document.getElementById('report-modal').classList.remove('hidden');

  setTimeout(() => {
    const initLat = selectedLat || 23.6978;
    const initLng = selectedLng || 120.9605;
    const initZoom = selectedLat ? 15 : 8;
    if (!miniMapReady) {
      miniMapMap = L.map('mini-map').setView([initLat, initLng], initZoom);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
      }).addTo(miniMapMap);
      miniMapMap.on('click', onMiniMapClick);
      miniMapReady = true;
    } else {
      miniMapMap.invalidateSize();
      miniMapMap.setView([initLat, initLng], initZoom);
    }
    if (selectedLat) {
      const savedAddr = selectedAddress; // preserve address from report
      placeMapMarker(selectedLat, selectedLng);
      selectedAddress = savedAddr;       // restore after placeMapMarker overwrites it
      if (savedAddr) showLocationBadge(savedAddr);
    }
  }, 100);
}

function renderExistingPhotos() {
  const grid        = document.getElementById('photo-preview');
  const placeholder = document.getElementById('upload-placeholder');
  grid.innerHTML    = '';

  keepImages.forEach((url, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'photo-thumb';
    thumb.innerHTML = `
      <img src="${url}" alt="" />
      <button class="photo-remove" data-keep-index="${i}">✕</button>
    `;
    thumb.querySelector('.photo-remove').addEventListener('click', e => {
      e.stopPropagation();
      keepImages.splice(parseInt(e.target.dataset.keepIndex), 1);
      renderExistingPhotos();
    });
    grid.appendChild(thumb);
  });

  placeholder.style.display = (keepImages.length + photoFiles.length) ? 'none' : '';
}

function resetReportForm() {
  selectedLat = null;
  selectedLng = null;
  selectedAddress = '';
  selectedStatus = 'alive';
  photoFiles = [];
  keepImages = [];
  editingReportId = null;
  miniMapMarker = null;

  document.getElementById('species-input').value = '';
  document.getElementById('qty-input').value = '1';
  document.getElementById('desc-input').value = '';
  document.getElementById('addr-input').value = '';
  document.getElementById('photo-preview').innerHTML = '';
  document.getElementById('upload-placeholder').style.display = '';

  document.querySelectorAll('.status-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.status-btn[data-status="alive"]').classList.add('active');

  document.getElementById('location-badge').classList.add('hidden');
}

// ── 統一定位地圖 ───────────────────────────────────────────
function onMiniMapClick(e) {
  const { lat, lng } = e.latlng;
  placeMapMarker(lat, lng);
}

function placeMapMarker(lat, lng) {
  if (miniMapMarker) miniMapMap.removeLayer(miniMapMarker);
  miniMapMarker = L.marker([lat, lng], { draggable: true }).addTo(miniMapMap);
  miniMapMarker.on('dragend', e => {
    const pos = e.target.getLatLng();
    selectedLat = pos.lat;
    selectedLng = pos.lng;
    selectedAddress = `${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`;
    showLocationBadge('📡 解析中…');
    reverseGeocode(pos.lat, pos.lng).then(addr => {
      if (addr) selectedAddress = addr;
      showLocationBadge(selectedAddress);
    });
  });

  selectedLat = lat;
  selectedLng = lng;
  selectedAddress = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  showLocationBadge('📡 解析中…');

  reverseGeocode(lat, lng).then(addr => {
    if (addr) selectedAddress = addr;
    showLocationBadge(selectedAddress);
  });
}

// ── Autocomplete 下拉 ─────────────────────────────────────
async function fetchSuggestions(q) {
  try {
    const res = await fetch(`/api/geocode/suggest?q=${encodeURIComponent(q)}`);
    if (res.status === 429) { hideSuggestions(); return; }
    const data = await res.json();
    showSuggestions(data);
  } catch { hideSuggestions(); }
}

function positionSuggestions() {
  const input = document.getElementById('addr-input');
  const box   = document.getElementById('addr-suggestions');
  const rect  = input.getBoundingClientRect();
  box.style.top   = (rect.bottom + 4) + 'px';
  box.style.left  = rect.left + 'px';
  box.style.width = rect.width + 'px';
}

function showSuggestions(items) {
  const box = document.getElementById('addr-suggestions');
  if (!items.length) { hideSuggestions(); return; }
  box.innerHTML = items.map(item => `
    <div class="suggestion-item"
         data-lat="${item.lat}" data-lng="${item.lng}"
         data-display="${encodeURIComponent(item.display_name)}"
         data-name="${encodeURIComponent(item.name)}">
      <span class="suggestion-name">${item.name || item.display_name}</span>
      ${item.sub ? `<span class="suggestion-sub">${item.sub}</span>` : ''}
    </div>
  `).join('');
  positionSuggestions();
  box.classList.remove('hidden');

  box.querySelectorAll('.suggestion-item').forEach(el => {
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      const name    = decodeURIComponent(el.dataset.name);
      const display = decodeURIComponent(el.dataset.display);
      const lat     = el.dataset.lat !== 'null' ? parseFloat(el.dataset.lat) : null;
      const lng     = el.dataset.lng !== 'null' ? parseFloat(el.dataset.lng) : null;
      document.getElementById('addr-input').value = name;
      hideSuggestions();
      if (lat && lng) {
        // 已有座標（非 Google Places 路徑）
        if (!miniMapReady) return;
        miniMapMap.flyTo([lat, lng], 17, { animate: true, duration: 0.8 });
        placeMapMarker(lat, lng);
        selectedAddress = display;
        showLocationBadge(display);
      } else {
        // Google Places 路徑：用 display_name 再 geocode 取座標
        geocodeByAddress(display);
      }
    });
  });
}

function hideSuggestions() {
  document.getElementById('addr-suggestions').classList.add('hidden');
}

// 用地址字串取得座標並定位（供 autocomplete 選取後呼叫）
async function geocodeByAddress(address) {
  if (!miniMapReady) return;
  showLocationBadge('📡 解析中…');
  try {
    const res  = await fetch(`/api/geocode?q=${encodeURIComponent(address)}`);
    const data = await res.json();
    if (!data.length) { showToast('無法解析位置', 'error'); return; }
    const { lat, lng, display_name } = data[0];
    miniMapMap.flyTo([lat, lng], 17, { animate: true, duration: 0.8 });
    placeMapMarker(lat, lng);
    selectedAddress = display_name || address;
    showLocationBadge(selectedAddress);
  } catch {
    showToast('位置解析失敗', 'error');
  }
}

// Address search — pans the shared miniMapMap (via server proxy: Google → NLSC fallback)
async function geocodeAddress() {
  const q = document.getElementById('addr-input').value.trim();
  if (!q) return;
  if (!miniMapReady) { showToast('地圖載入中，請稍候再試', 'error'); return; }

  const btn = document.getElementById('addr-search-btn');
  btn.textContent = '搜尋中…'; btn.disabled = true;
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!data.length) { showToast('找不到該地址，請嘗試更詳細的地址', 'error'); return; }

    const { lat, lng, display_name } = data[0];

    miniMapMap.flyTo([lat, lng], 17, { animate: true, duration: 0.8 });
    placeMapMarker(lat, lng);
    selectedAddress = display_name || q;
    showLocationBadge(display_name || q);
  } catch {
    showToast('搜尋失敗，請稍後再試', 'error');
  } finally {
    btn.textContent = '搜尋'; btn.disabled = false;
  }
}

// GPS — pans the shared miniMapMap
function getGPSLocation() {
  const btn = document.getElementById('gps-btn');
  if (!navigator.geolocation) { showToast('瀏覽器不支援定位', 'error'); return; }
  if (!miniMapReady) { showToast('地圖載入中，請稍候再試', 'error'); return; }
  btn.textContent = '⏳'; btn.disabled = true;

  navigator.geolocation.getCurrentPosition(async pos => {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;

    miniMapMap.flyTo([lat, lng], 17, { animate: true, duration: 0.8 });
    placeMapMarker(lat, lng);

    btn.textContent = '📡'; btn.disabled = false;
  }, err => {
    showToast('無法取得位置：' + err.message, 'error');
    btn.textContent = '📡'; btn.disabled = false;
  }, { enableHighAccuracy: true, timeout: 10000 });
}

function showLocationBadge(text) {
  const badge = document.getElementById('location-badge');
  document.getElementById('location-text').textContent = text;
  badge.classList.remove('hidden');
}

async function reverseGeocode(lat, lng) {
  try {
    const res  = await fetch(`/api/reverse-geocode?lat=${lat}&lng=${lng}`);
    const data = await res.json();
    return data.address || '';
  } catch { return ''; }
}

// ── 照片 ──────────────────────────────────────────────────

// Canvas 壓縮：最長邊 ≤ 1920px，JPEG 品質 0.82
// 小於 300 KB 的直接略過；不支援的格式（如舊版 HEIC）傳原檔
function compressImage(file) {
  const MAX_PX   = 1920;
  const QUALITY  = 0.82;
  const MIN_SIZE = 300 * 1024; // 300 KB 以下不壓縮

  if (file.size < MIN_SIZE) return Promise.resolve(file);

  return new Promise(resolve => {
    const img = new Image();
    const blobUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(blobUrl);
      let { naturalWidth: w, naturalHeight: h } = img;

      // 縮小尺寸
      if (w > MAX_PX || h > MAX_PX) {
        if (w >= h) { h = Math.round(h * MAX_PX / w); w = MAX_PX; }
        else        { w = Math.round(w * MAX_PX / h); h = MAX_PX; }
      }

      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);

      const outName = file.name.replace(/\.[^.]+$/, '.jpg');
      canvas.toBlob(
        blob => resolve(blob ? new File([blob], outName, { type: 'image/jpeg' }) : file),
        'image/jpeg', QUALITY
      );
    };

    img.onerror = () => { URL.revokeObjectURL(blobUrl); resolve(file); };
    img.src = blobUrl;
  });
}

function fmtSize(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const PLACEHOLDER_HTML = `
  <span class="upload-icon">📸</span>
  <p>點擊或拖曳照片至此</p>
  <small>JPG・PNG・HEIC・最大 15MB／張</small>`;

async function addPhotos(files) {
  const allowed   = files.filter(f => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  const remaining = 5 - photoFiles.length - keepImages.length;
  const toAdd     = allowed.slice(0, remaining);
  if (!toAdd.length) return;

  const placeholder = document.getElementById('upload-placeholder');
  placeholder.style.display = ''; // 壓縮期間保持可見

  const compressed = [];
  for (let i = 0; i < toAdd.length; i++) {
    placeholder.innerHTML = `
      <span class="upload-icon">⏳</span>
      <p>壓縮中… ${i + 1}／${toAdd.length}</p>
      <small>${toAdd[i].name}</small>`;
    compressed.push(await compressImage(toAdd[i]));
  }

  placeholder.innerHTML = PLACEHOLDER_HTML;
  photoFiles.push(...compressed);
  renderPhotoPreview();
}

function renderPhotoPreview() {
  const grid = document.getElementById('photo-preview');
  const placeholder = document.getElementById('upload-placeholder');
  grid.innerHTML = '';

  photoFiles.forEach((file, i) => {
    const url  = URL.createObjectURL(file);
    const size = fmtSize(file.size);
    const thumb = document.createElement('div');
    thumb.className = 'photo-thumb';
    thumb.innerHTML = `
      <img src="${url}" alt="" />
      <button class="photo-remove" data-index="${i}">✕</button>
      <span class="photo-size">${size}</span>
    `;
    thumb.querySelector('.photo-remove').addEventListener('click', e => {
      e.stopPropagation();
      photoFiles.splice(parseInt(e.target.dataset.index), 1);
      renderPhotoPreview();
    });
    grid.appendChild(thumb);
  });

  placeholder.style.display = (photoFiles.length + keepImages.length) ? 'none' : '';
}

// ── 提交 ──────────────────────────────────────────────────
async function submitReport() {
  if (!currentUser) { showLoginPrompt(); return; }

  const species = document.getElementById('species-input').value.trim();
  const qty     = document.getElementById('qty-input').value;
  const desc    = document.getElementById('desc-input').value.trim();

  if (!species) { showToast('請填寫物種名稱', 'error'); return; }
  if (selectedLat === null || selectedLng === null) {
    showToast('請選擇通報地點', 'error'); return;
  }

  const btn = document.getElementById('submit-btn');
  btn.textContent = '上傳中…'; btn.disabled = true;

  const fd = new FormData();
  fd.append('species', species);
  fd.append('quantity', qty);
  fd.append('status', selectedStatus);
  fd.append('lat', selectedLat);
  fd.append('lng', selectedLng);
  fd.append('address', selectedAddress);
  fd.append('description', desc);
  photoFiles.forEach(f => fd.append('images', f));
  if (editingReportId) fd.append('keep_images', JSON.stringify(keepImages));

  const isEdit  = !!editingReportId;
  const url     = isEdit ? `/api/reports/${editingReportId}` : '/api/reports';
  const method  = isEdit ? 'PUT' : 'POST';

  try {
    const res  = await fetch(url, { method, body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || (isEdit ? '更新失敗' : '提交失敗'));
    closeReportModal();
    await loadReports();
    if (selectedLat && selectedLng) mainMap.flyTo([selectedLat, selectedLng], 14);
    openSuccessModal(species, isEdit);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.textContent = isEdit ? '💾 儲存修改' : '📤 提交通報';
    btn.disabled = false;
  }
}

function openSuccessModal(species, isEdit) {
  document.getElementById('success-title').textContent = isEdit ? '通報已更新！' : '通報已送出！';
  document.getElementById('success-species').textContent = `${getEmoji(species)} ${species}`;
  document.getElementById('success-modal').classList.remove('hidden');
}

function closeSuccessModal() {
  document.getElementById('success-modal').classList.add('hidden');
}

// ── LINE 登入（含冷啟動喚醒）────────────────────────────────
async function lineLogin() {
  const btn = document.getElementById('line-login-btn');
  const promptBtn = document.getElementById('login-prompt-btn');
  const origText = btn ? btn.innerHTML : '';

  function setLoading(loading) {
    if (btn) {
      btn.disabled = loading;
      btn.innerHTML = loading ? '<span>連線中…</span>' : origText;
    }
    if (promptBtn) promptBtn.disabled = loading;
  }

  try {
    setLoading(true);
    // 先確認伺服器已醒來（最多等 20 秒）
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch('/auth/user', { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok && res.status === 503) {
      // 再等一秒後直接跳，讓 LINE 那邊也給時間
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch {
    // 超時或失敗 — 還是嘗試跳轉，讓伺服器繼續醒
  } finally {
    setLoading(false);
  }
  window.location.href = '/auth/line';
}

// ── 詳情 Modal ────────────────────────────────────────────
async function openDetailModal(id) {
  // 同時取通報 + 留言
  const [repRes, comRes] = await Promise.all([
    fetch(`/api/reports/${id}`),
    fetch(`/api/reports/${id}/comments`),
  ]);
  const r = await repRes.json();
  const comments = comRes.ok ? await comRes.json() : [];

  document.getElementById('detail-title').textContent = `${getEmoji(r.species)} ${r.species}`;

  const statusLabel = STATUS_LABELS[r.status] || r.status;
  const addr = r.address || `${Number(r.lat).toFixed(5)}, ${Number(r.lng).toFixed(5)}`;
  const reporter = r.user_name
    ? `<img src="${r.user_avatar || ''}" onerror="this.style.display='none'" /><span>由 ${r.user_name} 通報</span>`
    : '<span>由匿名用戶通報（範例資料）</span>';

  let imagePaths = r.image_paths || [];
  if (typeof imagePaths === 'string') {
    try { imagePaths = JSON.parse(imagePaths); } catch { imagePaths = []; }
  }
  const imgs = imagePaths.length
    ? `<div class="detail-images">${imagePaths.map(p =>
        `<img src="${p}" alt="通報照片" loading="lazy" onclick="window.open('${p}')">`
      ).join('')}</div>`
    : '';

  // 留言輸入區
  const commentForm = currentUser
    ? `<div class="comment-form">
        <img src="${escapeHtml(currentUser.avatar || '')}" class="comment-avatar" onerror="this.style.display='none'" />
        <div class="comment-form-inner">
          <textarea id="comment-input" placeholder="補充觀察、行為或更多資訊…" rows="2" maxlength="500"></textarea>
          <div class="comment-form-footer">
            <span class="comment-char-hint" id="comment-char">0 / 500</span>
            <button class="btn-primary comment-submit-btn" id="comment-submit-btn">送出留言</button>
          </div>
        </div>
       </div>`
    : `<div class="comment-login-hint">
        <button class="line-btn" style="font-size:13px;padding:8px 14px" onclick="lineLogin()">🔐 登入後留言</button>
       </div>`;

  document.getElementById('detail-body').innerHTML = `
    ${imgs}
    <div class="detail-meta">
      <div class="detail-row">
        <span class="detail-label">物種</span>
        <span class="detail-value">
          ${escapeHtml(r.species)}
          <a href="${speciesWikiUrl(r.species)}" target="_blank" rel="noopener noreferrer"
             class="wiki-link" title="查詢台灣生物多樣性資料庫">📖</a>
        </span>
      </div>
      <div class="detail-row">
        <span class="detail-label">數量</span>
        <span class="detail-value">${r.quantity} 隻</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">狀態</span>
        <span class="detail-value"><span class="status-badge ${r.status}">${statusLabel}</span></span>
      </div>
      <div class="detail-row">
        <span class="detail-label">通報時間</span>
        <span class="detail-value" style="font-size:13px">${formatDate(r.created_at)}</span>
      </div>
    </div>
    <div class="detail-row" style="margin-bottom:12px">
      <span class="detail-label">地點</span>
      <span class="detail-value" style="font-size:13px;font-weight:500;margin-top:4px;display:block">📍 ${escapeHtml(addr)}</span>
    </div>
    ${r.description ? `<div class="detail-desc">${escapeHtml(r.description)}</div>` : ''}
    <div class="detail-reporter">${reporter} ・ ${formatDate(r.created_at)}</div>

    <!-- 留言區 -->
    <div class="comment-section">
      <div class="comment-section-header">
        <span>💬 留言討論</span>
        <span class="comment-total" id="comment-total">${comments.length} 則</span>
      </div>
      <div class="comment-list" id="comment-list">
        ${comments.length
          ? comments.map(c => buildCommentItem(c)).join('')
          : '<div class="comment-empty">還沒有留言，成為第一個！</div>'}
      </div>
      ${commentForm}
    </div>
  `;

  // 綁定留言互動
  bindCommentForm(id);

  // Footer 永遠顯示（含分享按鈕）
  const ownerActions = document.getElementById('detail-owner-actions');
  const editBtn      = document.getElementById('edit-report-btn');
  if (currentUser && currentUser.id === r.user_id) {
    ownerActions.classList.remove('hidden');
    editBtn.onclick = () => openEditModal(r);
    const delBtn = document.getElementById('delete-report-btn');
    delBtn.textContent = '🗑️ 刪除';
    delBtn.disabled = false;
    delBtn.onclick = () => deleteReport(r.id, r.species);
  } else {
    ownerActions.classList.add('hidden');
  }

  // 分享按鈕（傳整筆通報資料以組完整描述）
  document.getElementById('share-report-btn').onclick = () => shareReport(r);

  // 更新網址列，方便書籤 / 直接分享
  history.pushState({ reportId: id }, '', `/?report=${id}`);

  document.getElementById('detail-modal').classList.remove('hidden');
}

// ── 分享通報 ──────────────────────────────────────────────
function shareReport(r) {
  const url         = `${location.origin}/?report=${r.id}`;
  const emoji       = getEmoji(r.species);
  const statusLabel = STATUS_LABELS[r.status] || r.status;
  const addr        = r.address || `${Number(r.lat).toFixed(4)}, ${Number(r.lng).toFixed(4)}`;

  // 組分享文字
  const lines = [`${emoji} ${r.species}　狀態：${statusLabel}`];
  if (r.quantity > 1) lines.push(`數量：${r.quantity} 隻`);
  lines.push(`📍 ${addr}`);
  if (r.description) {
    const desc = r.description.length > 100
      ? r.description.slice(0, 100) + '…'
      : r.description;
    lines.push(`📝 ${desc}`);
  }
  lines.push('');
  lines.push('🌿 台灣野生動物通報平台');

  const shareText = lines.join('\n');
  const title     = `${emoji} ${r.species} — 野生動物通報`;

  if (navigator.share) {
    // 手機原生分享：文字 + 連結分開，讓 LINE 等 App 各自處理
    navigator.share({ title, text: shareText, url }).catch(() => {});
  } else {
    // 桌機：文字與連結一起複製到剪貼簿
    const full = `${shareText}\n${url}`;
    navigator.clipboard.writeText(full)
      .then(() => showToast('🔗 分享內容已複製！', 'success'))
      .catch(() => { prompt('複製此分享內容：', full); });
  }
}

function closeDetailModal() {
  document.getElementById('detail-modal').classList.add('hidden');
  // 恢復乾淨網址
  if (location.search.includes('report=')) history.pushState({}, '', '/');
}

// ── 留言功能 ──────────────────────────────────────────────
function buildCommentItem(c) {
  const isOwn = currentUser && currentUser.id === c.user_id;
  const delBtn = isOwn
    ? `<button class="comment-del-btn" data-id="${c.id}" title="刪除留言">✕</button>` : '';
  return `
    <div class="comment-item" id="comment-item-${c.id}">
      <img src="${escapeHtml(c.user_avatar || '')}" class="comment-avatar"
           onerror="this.style.display='none'" />
      <div class="comment-bubble">
        <div class="comment-meta">
          <strong class="comment-name">${escapeHtml(c.user_name)}</strong>
          <span class="comment-time">${formatDate(c.created_at)}</span>
          ${delBtn}
        </div>
        <div class="comment-content">${escapeHtml(c.content)}</div>
      </div>
    </div>`;
}

function bindCommentForm(reportId) {
  const input     = document.getElementById('comment-input');
  const submitBtn = document.getElementById('comment-submit-btn');
  const charHint  = document.getElementById('comment-char');
  const list      = document.getElementById('comment-list');

  if (input && charHint) {
    input.addEventListener('input', () => {
      charHint.textContent = `${input.value.length} / 500`;
    });
    // Ctrl/Cmd+Enter 快速送出
    input.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submitComment(reportId);
    });
  }
  if (submitBtn) submitBtn.addEventListener('click', () => submitComment(reportId));

  // 刪除留言（事件委派）
  if (list) {
    list.addEventListener('click', e => {
      const btn = e.target.closest('.comment-del-btn');
      if (btn) deleteComment(parseInt(btn.dataset.id), reportId);
    });
  }
}

async function submitComment(reportId) {
  const input     = document.getElementById('comment-input');
  const submitBtn = document.getElementById('comment-submit-btn');
  const content   = input?.value.trim();
  if (!content) return;

  submitBtn.textContent = '送出中…'; submitBtn.disabled = true;
  try {
    const res  = await fetch(`/api/reports/${reportId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '送出失敗');

    const list  = document.getElementById('comment-list');
    const empty = list?.querySelector('.comment-empty');
    if (empty) empty.remove();
    list?.insertAdjacentHTML('beforeend', buildCommentItem(data));
    list?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    updateCommentCount(1);
    input.value = '';
    const charHint = document.getElementById('comment-char');
    if (charHint) charHint.textContent = '0 / 500';
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    submitBtn.textContent = '送出留言'; submitBtn.disabled = false;
  }
}

async function deleteComment(commentId, reportId) {
  if (!confirm('確定刪除這則留言？')) return;
  const res = await fetch(`/api/comments/${commentId}`, { method: 'DELETE' });
  if (!res.ok) { const d = await res.json(); showToast(d.error || '刪除失敗', 'error'); return; }
  document.getElementById(`comment-item-${commentId}`)?.remove();
  updateCommentCount(-1);
  // 若列表空了補提示
  const list = document.getElementById('comment-list');
  if (list && !list.children.length) {
    list.innerHTML = '<div class="comment-empty">還沒有留言，成為第一個！</div>';
  }
}

function updateCommentCount(delta) {
  const el = document.getElementById('comment-total');
  if (!el) return;
  const n = Math.max(0, (parseInt(el.textContent) || 0) + delta);
  el.textContent = `${n} 則`;
}

// ── 我的通報 ──────────────────────────────────────────────
const REVIEW_LABELS = { pending:'待審核', approved:'已核准', rejected:'已拒絕' };

async function openMyReports() {
  document.getElementById('my-reports-modal').classList.remove('hidden');
  document.getElementById('my-reports-body').innerHTML = '<div class="loading-text">載入中…</div>';

  const res     = await fetch('/api/my-reports');
  const reports = await res.json();

  if (!reports.length) {
    document.getElementById('my-reports-body').innerHTML = '<div class="empty-text">尚未有任何通報紀錄</div>';
    return;
  }

  document.getElementById('my-reports-body').innerHTML = reports.map(r => {
    let imgs = r.image_paths || [];
    if (typeof imgs === 'string') { try { imgs = JSON.parse(imgs); } catch { imgs = []; } }

    const thumb = imgs.length
      ? `<div class="my-report-thumb"><img src="${imgs[0]}" alt="" /></div>`
      : `<div class="my-report-thumb">${getEmoji(r.species)}</div>`;

    const status   = r.review_status || 'pending';
    const addr     = r.address || `${Number(r.lat).toFixed(4)}, ${Number(r.lng).toFixed(4)}`;
    const rejected = status === 'rejected' && r.reject_reason
      ? `<div class="my-report-reject">拒絕原因：${r.reject_reason}</div>` : '';

    return `
      <div class="my-report-item" onclick="flyToReport(${r.lat}, ${r.lng}, ${r.id})">
        ${thumb}
        <div class="my-report-info">
          <div class="my-report-species">${getEmoji(r.species)} ${r.species} ×${r.quantity}</div>
          <div class="my-report-meta">📍 ${addr}　${formatDate(r.created_at)}</div>
          ${rejected}
        </div>
        <span class="review-badge ${status}">${REVIEW_LABELS[status] || status}</span>
      </div>
    `;
  }).join('');
}

function flyToReport(lat, lng, id) {
  document.getElementById('my-reports-modal').classList.add('hidden');
  mainMap.flyTo([lat, lng], 15);
  // 若是已核准，開啟 popup
  setTimeout(() => openDetailModal(id), 800);
}

// ── 刪除通報 ──────────────────────────────────────────────
async function deleteReport(id, species) {
  if (!confirm(`確定要刪除「${species}」這筆通報嗎？\n此動作無法復原。`)) return;

  const btn = document.getElementById('delete-report-btn');
  btn.textContent = '刪除中…'; btn.disabled = true;

  try {
    const res  = await fetch(`/api/reports/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '刪除失敗');
    document.getElementById('detail-modal').classList.add('hidden');
    showToast('通報已刪除', 'success');
    await loadReports();
  } catch (err) {
    showToast(err.message, 'error');
    btn.textContent = '🗑️ 刪除'; btn.disabled = false;
  }
}

// ── Login prompt ──────────────────────────────────────────
function showLoginPrompt() {
  document.getElementById('login-prompt').classList.remove('hidden');
}

// ── Utilities ─────────────────────────────────────────────
function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

let toastTimer;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast${type ? ' ' + type : ''}`;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

function checkUrlError() {
  const params = new URLSearchParams(location.search);
  const err = params.get('error');
  if (err) {
    const msgs = {
      auth_failed: 'LINE 登入失敗，請再試一次',
      invalid_state: '安全驗證失敗，請重試',
    };
    showToast(msgs[err] || `登入錯誤：${err}`, 'error');
    history.replaceState({}, '', '/');
  }
}
