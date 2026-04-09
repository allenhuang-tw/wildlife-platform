/* ════════════════════════════════════════
   野生動物通報平台 — 管理後台 JS
   ════════════════════════════════════════ */

const STATUS_LABELS = { alive:'存活', injured:'受傷', dead:'死亡', unknown:'不確定' };
const SPECIES_EMOJI = {
  '台灣黑熊':'🐻','石虎':'🐆','台灣獼猴':'🐒','山羌':'🦌','水鹿':'🦌',
  '梅花鹿':'🦌','台灣野豬':'🐗','白鼻心':'🦡','鼬獾':'🦡','飛鼠':'🦇',
  '赤腹松鼠':'🐿️','台灣藍鵲':'🦚','領角鴞':'🦉','鳳頭蒼鷹':'🦅',
  '台灣黑鳶':'🦅','雨傘節':'🐍','龜殼花':'🐍','眼鏡蛇':'🐍','蛇':'🐍',
};
function getEmoji(s) {
  for (const [k, v] of Object.entries(SPECIES_EMOJI)) if (s.includes(k)) return v;
  return '🦎';
}
function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function safeImgs(raw) {
  if (!raw) return [];
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return []; } }
  return raw;
}

let currentTab = 'pending';
let pendingRejectId = null;
let allCounts = { pending: 0, approved: 0, rejected: 0 };

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const res  = await fetch('/admin/api/me');
  const data = await res.json();

  if (!data.user) {
    showNoAccess('請先登入', '請使用管理員 LINE 帳號登入');
    return;
  }
  if (!data.isAdmin) {
    showNoAccess('權限不足', '您的帳號沒有管理員權限');
    document.querySelector('.line-btn-admin').style.display = 'none';
    return;
  }

  // 顯示管理員資訊
  document.getElementById('admin-avatar').src  = data.user.avatar || '';
  document.getElementById('admin-name').textContent = data.user.name;
  document.getElementById('admin-user').classList.remove('hidden');
  document.getElementById('admin-main').classList.remove('hidden');

  bindEvents();
  await loadAll();
}

function showNoAccess(title, msg) {
  document.getElementById('no-access-title').textContent = title;
  document.getElementById('no-access-msg').textContent   = msg;
  document.getElementById('no-access').classList.remove('hidden');
}

function bindEvents() {
  // Tabs
  document.querySelectorAll('.admin-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      renderReports();
    });
  });

  // Logout
  document.getElementById('admin-logout').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    location.href = '/';
  });

  // Reject modal
  document.getElementById('reject-cancel').addEventListener('click', () => {
    document.getElementById('reject-modal').classList.add('hidden');
    pendingRejectId = null;
  });
  document.getElementById('reject-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('reject-modal')) {
      document.getElementById('reject-modal').classList.add('hidden');
      pendingRejectId = null;
    }
  });
  document.getElementById('reject-confirm').addEventListener('click', async () => {
    if (!pendingRejectId) return;
    const reason = document.getElementById('reject-reason').value.trim();
    await doReview(pendingRejectId, 'reject', reason);
    document.getElementById('reject-modal').classList.add('hidden');
    document.getElementById('reject-reason').value = '';
    pendingRejectId = null;
  });
}

let cachedReports = [];

async function loadAll() {
  const res = await fetch('/admin/api/reports');
  cachedReports = await res.json();

  // 計算各分類數量
  allCounts = { pending: 0, approved: 0, rejected: 0 };
  cachedReports.forEach(r => { if (allCounts[r.review_status] !== undefined) allCounts[r.review_status]++; });

  document.getElementById('count-pending').textContent  = allCounts.pending;
  document.getElementById('count-approved').textContent = allCounts.approved;
  document.getElementById('count-rejected').textContent = allCounts.rejected;

  renderReports();
}

function renderReports() {
  const list    = document.getElementById('report-list');
  const reports = cachedReports.filter(r => r.review_status === currentTab);

  if (!reports.length) {
    list.innerHTML = `<div class="empty">目前沒有${currentTab === 'pending' ? '待審核' : currentTab === 'approved' ? '已核准' : '已拒絕'}的通報</div>`;
    return;
  }

  list.innerHTML = reports.map(r => {
    const imgs   = safeImgs(r.image_paths);
    const photos = imgs.length
      ? imgs.slice(0, 4).map(u => `<img src="${u}" alt="" onclick="window.open('${u}')">`).join('')
      : `<div class="no-photo">📷</div>`;

    const actions = currentTab === 'pending'
      ? `<button class="btn-approve" onclick="approve(${r.id})">✅ 核准</button>
         <button class="btn-reject"  onclick="openReject(${r.id})">❌ 拒絕</button>`
      : currentTab === 'approved'
      ? `<button class="btn-reject btn-undo" onclick="openReject(${r.id})">↩ 撤回</button>`
      : `<button class="btn-approve" onclick="approve(${r.id})">↩ 重新核准</button>`;

    const rejectReason = r.reject_reason
      ? `<div class="card-reject-reason">拒絕原因：${r.reject_reason}</div>` : '';

    return `
      <div class="report-card" id="card-${r.id}">
        <div class="card-photos">${photos}</div>
        <div class="card-info">
          <div class="card-species">${getEmoji(r.species)} ${r.species}</div>
          <div class="card-meta">
            <span class="card-badge ${r.status}">${STATUS_LABELS[r.status] || r.status}</span>
            <span>數量：${r.quantity} 隻</span>
            <span>📍 ${r.address || `${Number(r.lat).toFixed(4)}, ${Number(r.lng).toFixed(4)}`}</span>
          </div>
          ${r.description ? `<div class="card-desc">${r.description}</div>` : ''}
          ${rejectReason}
          <div class="card-reporter">
            ${r.user_name ? `👤 ${r.user_name}` : '匿名'}・${formatDate(r.created_at)}
          </div>
        </div>
        <div class="card-actions">${actions}</div>
      </div>
    `;
  }).join('');
}

async function approve(id) {
  await doReview(id, 'approve');
}

function openReject(id) {
  pendingRejectId = id;
  document.getElementById('reject-reason').value = '';
  document.getElementById('reject-modal').classList.remove('hidden');
  document.getElementById('reject-reason').focus();
}

async function doReview(id, action, reason = '') {
  const btn = document.querySelector(`#card-${id} .btn-${action === 'approve' ? 'approve' : 'reject'}`);
  if (btn) { btn.textContent = '處理中…'; btn.disabled = true; }

  const res  = await fetch(`/admin/api/reports/${id}/review`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, reason }),
  });
  const data = await res.json();

  if (!res.ok) {
    showToast(data.error || '操作失敗', 'error');
    if (btn) { btn.textContent = action === 'approve' ? '✅ 核准' : '❌ 拒絕'; btn.disabled = false; }
    return;
  }

  showToast(action === 'approve' ? '✅ 已核准' : '❌ 已拒絕', action === 'approve' ? 'success' : '');
  await loadAll();
}

let toastTimer;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `admin-toast${type ? ' ' + type : ''}`;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}
