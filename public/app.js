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

// ── 全域狀態 ────────────────────────────────────────────
let mainMap, miniMapMap, addrMap, gpsMap;
let markersLayer;
let allReports = [];
let currentUser = null;
let selectedLat = null, selectedLng = null;
let selectedAddress = '';
let selectedStatus = 'alive';
let photoFiles = [];
let activeTab = 'map';
let miniMapMarker = null;
let addrMapMarker = null;
let gpsMapMarker  = null;
let miniMapReady = false;
let editingReportId = null;   // null = 新增模式, 數字 = 編輯模式
let keepImages = [];          // 編輯時要保留的舊圖 URL

// ── 啟動 ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initMainMap();
  bindEvents();       // 先綁事件，確保按鈕一定有反應
  checkUrlError();
  await checkAuth();
  await loadReports().catch(err => {
    console.error('載入通報失敗:', err);
    showToast('資料載入失敗，請重新整理', 'error');
  });
});

// ── 認證 ─────────────────────────────────────────────────
async function checkAuth() {
  const res = await fetch('/auth/user');
  const data = await res.json();
  currentUser = data.user;
  renderAuthUI();
}

function renderAuthUI() {
  const loginBtn = document.getElementById('line-login-btn');
  const userInfo = document.getElementById('user-info');
  if (currentUser) {
    loginBtn.classList.add('hidden');
    userInfo.classList.remove('hidden');
    document.getElementById('user-avatar').src = currentUser.avatar || '';
    document.getElementById('user-name').textContent = currentUser.name;
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
  const url = filterSpecies ? `/api/reports?species=${encodeURIComponent(filterSpecies)}` : '/api/reports';
  const res = await fetch(url);
  allReports = await res.json();
  renderMarkers(allReports);
  document.getElementById('total-reports').textContent = allReports.length;
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
      <div class="popup-species">${getEmoji(r.species)} ${r.species}</div>
      <div class="popup-meta">
        數量：${r.quantity} 隻 ・
        <span style="color:${color};font-weight:600">${statusLabel}</span>
      </div>
      ${r.address ? `<div class="popup-meta">📍 ${r.address}</div>` : ''}
      <div class="popup-meta">${formatDate(r.created_at)}</div>
    </div>
    <button class="popup-open" id="popup-open-${r.id}">查看詳情 →</button>
  `;
}

// ── 事件綁定 ──────────────────────────────────────────────
function bindEvents() {
  // Header auth
  document.getElementById('line-login-btn').addEventListener('click', () => window.location.href = '/auth/line');
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    currentUser = null;
    renderAuthUI();
    showToast('已登出');
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

  // Location tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Address search
  document.getElementById('addr-search-btn').addEventListener('click', geocodeAddress);
  document.getElementById('addr-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') geocodeAddress();
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
  document.getElementById('close-detail-modal').addEventListener('click', () => {
    document.getElementById('detail-modal').classList.add('hidden');
  });
  document.getElementById('detail-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('detail-modal'))
      document.getElementById('detail-modal').classList.add('hidden');
  });

  // Login prompt
  document.getElementById('login-prompt-btn').addEventListener('click', () => window.location.href = '/auth/line');
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
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(miniMapMap);
      miniMapMap.on('click', onMiniMapClick);
      miniMapReady = true;
    } else {
      miniMapMap.invalidateSize();
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
    if (!miniMapReady) {
      miniMapMap = L.map('mini-map').setView([selectedLat || 23.69, selectedLng || 120.96], 13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(miniMapMap);
      miniMapMap.on('click', onMiniMapClick);
      miniMapReady = true;
    } else {
      miniMapMap.invalidateSize();
      if (selectedLat) miniMapMap.setView([selectedLat, selectedLng], 13);
    }
    if (selectedLat) {
      if (miniMapMarker) miniMapMap.removeLayer(miniMapMarker);
      miniMapMarker = L.marker([selectedLat, selectedLng]).addTo(miniMapMap);
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
  addrMapMarker = null;
  gpsMapMarker  = null;

  document.getElementById('species-input').value = '';
  document.getElementById('qty-input').value = '1';
  document.getElementById('desc-input').value = '';
  document.getElementById('addr-input').value = '';
  document.getElementById('photo-preview').innerHTML = '';
  document.getElementById('upload-placeholder').style.display = '';

  document.querySelectorAll('.status-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.status-btn[data-status="alive"]').classList.add('active');

  document.getElementById('location-badge').classList.add('hidden');
  document.getElementById('addr-result-map').classList.add('hidden');
  document.getElementById('gps-result-map').classList.add('hidden');

  switchTab('map');
}

// ── 定位 Tab ──────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.getElementById('tab-map').classList.toggle('hidden', tab !== 'map');
  document.getElementById('tab-address').classList.toggle('hidden', tab !== 'address');
  document.getElementById('tab-gps').classList.toggle('hidden', tab !== 'gps');

  if (tab === 'map' && miniMapReady) miniMapMap.invalidateSize();
  if (tab === 'address' && addrMap)   addrMap.invalidateSize();
  if (tab === 'gps'     && gpsMap)    gpsMap.invalidateSize();
}

function onMiniMapClick(e) {
  const { lat, lng } = e.latlng;
  setLocationFromCoords(lat, lng, miniMapMap, (m) => { miniMapMarker = m; }, miniMapMarker);
}

function setLocationFromCoords(lat, lng, map, setMarker, oldMarker) {
  if (oldMarker) map.removeLayer(oldMarker);
  const marker = L.marker([lat, lng]).addTo(map);
  setMarker(marker);
  selectedLat = lat;
  selectedLng = lng;
  // 立即用座標當地址，避免送出時還殘留舊地址
  selectedAddress = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  showLocationBadge('📡 解析中…');

  reverseGeocode(lat, lng).then(addr => {
    if (addr) selectedAddress = addr;
    showLocationBadge(selectedAddress);
  });
}

// Address search
async function geocodeAddress() {
  const q = document.getElementById('addr-input').value.trim();
  if (!q) return;

  const btn = document.getElementById('addr-search-btn');
  btn.textContent = '搜尋中…'; btn.disabled = true;
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=tw&accept-language=zh-TW`,
      { headers: { 'Accept-Language': 'zh-TW' } }
    );
    const data = await res.json();
    if (!data.length) { showToast('找不到該地址', 'error'); return; }

    const { lat, lon, display_name } = data[0];
    selectedLat = parseFloat(lat);
    selectedLng = parseFloat(lon);
    selectedAddress = q;

    // Show result map
    const mapEl = document.getElementById('addr-result-map');
    mapEl.classList.remove('hidden');
    if (!addrMap) {
      addrMap = L.map('addr-result-map').setView([selectedLat, selectedLng], 15);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(addrMap);
    } else {
      addrMap.setView([selectedLat, selectedLng], 15);
      if (addrMapMarker) addrMap.removeLayer(addrMapMarker);
    }
    addrMapMarker = L.marker([selectedLat, selectedLng]).addTo(addrMap);
    addrMap.invalidateSize();
    showLocationBadge(q);
  } catch {
    showToast('搜尋失敗，請稍後再試', 'error');
  } finally {
    btn.textContent = '搜尋'; btn.disabled = false;
  }
}

// GPS
function getGPSLocation() {
  const btn = document.getElementById('gps-btn');
  if (!navigator.geolocation) { showToast('瀏覽器不支援定位', 'error'); return; }
  btn.textContent = '📡 定位中…'; btn.disabled = true;

  navigator.geolocation.getCurrentPosition(async pos => {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    selectedLat = lat; selectedLng = lng;

    const mapEl = document.getElementById('gps-result-map');
    mapEl.classList.remove('hidden');
    if (!gpsMap) {
      gpsMap = L.map('gps-result-map').setView([lat, lng], 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(gpsMap);
    } else {
      gpsMap.setView([lat, lng], 16);
      if (gpsMapMarker) gpsMap.removeLayer(gpsMapMarker);
    }
    gpsMapMarker = L.marker([lat, lng]).addTo(gpsMap);
    gpsMap.invalidateSize();

    const addr = await reverseGeocode(lat, lng);
    selectedAddress = addr;
    showLocationBadge(addr || `${lat.toFixed(5)}, ${lng.toFixed(5)}`);

    btn.textContent = '📡 取得目前位置'; btn.disabled = false;
  }, err => {
    showToast('無法取得位置：' + err.message, 'error');
    btn.textContent = '📡 取得目前位置'; btn.disabled = false;
  }, { enableHighAccuracy: true, timeout: 10000 });
}

function showLocationBadge(text) {
  const badge = document.getElementById('location-badge');
  document.getElementById('location-text').textContent = text;
  badge.classList.remove('hidden');
}

async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=zh-TW`
    );
    const data = await res.json();
    return data.display_name || '';
  } catch { return ''; }
}

// ── 照片 ──────────────────────────────────────────────────
function addPhotos(files) {
  const allowed = files.filter(f => f.type.startsWith('image/'));
  const remaining = 5 - photoFiles.length;
  const toAdd = allowed.slice(0, remaining);
  if (!toAdd.length) return;
  photoFiles.push(...toAdd);
  renderPhotoPreview();
}

function renderPhotoPreview() {
  const grid = document.getElementById('photo-preview');
  const placeholder = document.getElementById('upload-placeholder');
  grid.innerHTML = '';

  photoFiles.forEach((file, i) => {
    const url = URL.createObjectURL(file);
    const thumb = document.createElement('div');
    thumb.className = 'photo-thumb';
    thumb.innerHTML = `
      <img src="${url}" alt="" />
      <button class="photo-remove" data-index="${i}">✕</button>
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
    showToast(isEdit ? '✅ 通報已更新！' : '通報成功！感謝您的回報 🎉', 'success');
    closeReportModal();
    await loadReports();
    if (selectedLat && selectedLng) mainMap.flyTo([selectedLat, selectedLng], 14);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.textContent = isEdit ? '💾 儲存修改' : '📤 提交通報';
    btn.disabled = false;
  }
}

// ── 詳情 Modal ────────────────────────────────────────────
async function openDetailModal(id) {
  const res = await fetch(`/api/reports/${id}`);
  const r = await res.json();

  document.getElementById('detail-title').textContent = `${getEmoji(r.species)} ${r.species}`;

  const statusLabel = STATUS_LABELS[r.status] || r.status;
  const addr = r.address || `${Number(r.lat).toFixed(5)}, ${Number(r.lng).toFixed(5)}`;
  const reporter = r.user_name
    ? `<img src="${r.user_avatar || ''}" onerror="this.style.display='none'" /><span>由 ${r.user_name} 通報</span>`
    : '<span>由匿名用戶通報（範例資料）</span>';

  // image_paths 有時從 Supabase 回來是 string，需要解析
  let imagePaths = r.image_paths || [];
  if (typeof imagePaths === 'string') {
    try { imagePaths = JSON.parse(imagePaths); } catch { imagePaths = []; }
  }
  const imgs = imagePaths.length
    ? `<div class="detail-images">${imagePaths.map(p =>
        `<img src="${p}" alt="通報照片" loading="lazy" onclick="window.open('${p}')">`
      ).join('')}</div>`
    : '';

  document.getElementById('detail-body').innerHTML = `
    ${imgs}
    <div class="detail-meta">
      <div class="detail-row">
        <span class="detail-label">物種</span>
        <span class="detail-value">${r.species}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">數量</span>
        <span class="detail-value">${r.quantity} 隻</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">狀態</span>
        <span class="detail-value">
          <span class="status-badge ${r.status}">${statusLabel}</span>
        </span>
      </div>
      <div class="detail-row">
        <span class="detail-label">通報時間</span>
        <span class="detail-value" style="font-size:13px">${formatDate(r.created_at)}</span>
      </div>
    </div>
    <div class="detail-row" style="margin-bottom:12px">
      <span class="detail-label">地點</span>
      <span class="detail-value" style="font-size:13px;font-weight:500;margin-top:4px;display:block">📍 ${addr}</span>
    </div>
    ${r.description ? `<div class="detail-desc">${r.description}</div>` : ''}
    <div class="detail-reporter">${reporter} ・ ${formatDate(r.created_at)}</div>
  `;

  // 顯示編輯按鈕（本人才看得到）
  const footer  = document.getElementById('detail-footer');
  const editBtn = document.getElementById('edit-report-btn');
  if (currentUser && currentUser.id === r.user_id) {
    footer.style.display = '';
    editBtn.onclick = () => openEditModal(r);
    document.getElementById('delete-report-btn').onclick = () => deleteReport(r.id, r.species);
  } else {
    footer.style.display = 'none';
  }

  document.getElementById('detail-modal').classList.remove('hidden');
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
