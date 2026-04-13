require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer  = require('multer');
const axios   = require('axios');
const path    = require('path');
const crypto  = require('crypto');
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Supabase ──────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Multer（記憶體模式，上傳到 Supabase Storage）──────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('只允許圖片'));
  }
});

// ── 中介層 ────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(process.env.SESSION_SECRET || 'dev-secret'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',   // 讓 LINE OAuth redirect 後 cookie 能帶回來
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// 從 session 或 signed cookie 取得使用者（防止 Render 多 instance session 遺失）
const COOKIE_NAME = 'ww_user';
const COOKIE_OPTS = {
  signed: true, httpOnly: true, sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  secure: process.env.NODE_ENV === 'production',
};

function getUser(req) {
  if (req.session.user) return req.session.user;
  const raw = req.signedCookies[COOKIE_NAME];
  if (raw) { try { return JSON.parse(raw); } catch {} }
  return null;
}

const requireAuth = (req, res, next) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: '請先登入' });
  req.session.user = user;   // 補回 session
  next();
};

// ── 管理員判斷 ────────────────────────────────────────────
function isAdmin(user) {
  if (!user) return false;
  const ids = (process.env.ADMIN_LINE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return ids.includes(user.lineId);
}
const requireAdmin = (req, res, next) => {
  const user = getUser(req);
  if (!user)        return res.status(401).json({ error: '請先登入' });
  if (!isAdmin(user)) return res.status(403).json({ error: '權限不足' });
  next();
};

// ── LINE OAuth ────────────────────────────────────────────
const LINE_CLIENT_ID     = process.env.LINE_CLIENT_ID;
const LINE_CLIENT_SECRET = process.env.LINE_CLIENT_SECRET;
const LINE_REDIRECT_URI  = process.env.LINE_REDIRECT_URI || `http://localhost:${PORT}/auth/line/callback`;

app.get('/auth/line', (req, res) => {
  if (!LINE_CLIENT_ID) {
    return res.send('<h2>請在環境變數設定 LINE_CLIENT_ID 與 LINE_CLIENT_SECRET</h2>');
  }
  const state = crypto.randomBytes(16).toString('hex');
  // 用簽名 cookie 取代 session，避免 server 重啟後 state 消失
  res.cookie('oauth_state', state, {
    httpOnly: true, sameSite: 'lax',
    maxAge: 5 * 60 * 1000, // 5 分鐘有效
    secure: process.env.NODE_ENV === 'production',
  });
  const url =
    `https://access.line.me/oauth2/v2.1/authorize?response_type=code` +
    `&client_id=${LINE_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(LINE_REDIRECT_URI)}` +
    `&state=${state}&scope=profile%20openid`;
  res.redirect(url);
});

app.get('/auth/line/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?error=${error}`);
  const savedState = req.cookies.oauth_state;
  res.clearCookie('oauth_state');
  if (!savedState || state !== savedState) return res.redirect('/?error=invalid_state');

  try {
    const tokenRes = await axios.post(
      'https://api.line.me/oauth2/v2.1/token',
      new URLSearchParams({
        grant_type: 'authorization_code', code,
        redirect_uri: LINE_REDIRECT_URI,
        client_id: LINE_CLIENT_ID,
        client_secret: LINE_CLIENT_SECRET,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token } = tokenRes.data;

    const profileRes = await axios.get('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const { userId, displayName, pictureUrl } = profileRes.data;

    // Upsert user
    const { data: user, error: upsertErr } = await supabase
      .from('users')
      .upsert({ line_id: userId, display_name: displayName, picture_url: pictureUrl || '' },
               { onConflict: 'line_id' })
      .select()
      .single();

    if (upsertErr) throw upsertErr;

    const userData = { id: user.id, name: displayName, avatar: pictureUrl || '', lineId: userId };
    req.session.user = userData;
    res.cookie(COOKIE_NAME, JSON.stringify(userData), COOKIE_OPTS);
    res.redirect('/');
  } catch (err) {
    console.error('LINE auth error:', err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/user', (req, res) => {
  const user = getUser(req);
  if (user) req.session.user = user;  // 補回 session
  res.json({ user: user || null, isAdmin: isAdmin(user) });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {});
  res.clearCookie(COOKIE_NAME);
  res.json({ success: true });
});

// ── 通報 API ──────────────────────────────────────────────
// 使用者查自己的通報（含審核狀態）
app.get('/api/my-reports', requireAuth, async (req, res) => {
  const user = getUser(req);
  const { data, error } = await supabase
    .from('reports').select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/reports', async (req, res) => {
  const { species, status, days } = req.query;
  let query = supabase.from('reports').select('*')
    .eq('review_status', 'approved')
    .order('created_at', { ascending: false });

  if (species) query = query.ilike('species', `%${species}%`);

  // 動物狀態篩選（逗號分隔，如 alive,injured）
  if (status) {
    const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
    if (statuses.length > 0 && statuses.length < 4) query = query.in('status', statuses);
  }

  // 時間範圍篩選
  if (days && !isNaN(parseInt(days))) {
    const since = new Date(Date.now() - parseInt(days) * 86400000).toISOString();
    query = query.gte('created_at', since);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── 後台頁面 ──────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── 後台 API ──────────────────────────────────────────────
app.get('/admin/api/reports', requireAdmin, async (req, res) => {
  const { tab } = req.query; // pending | approved | rejected
  let query = supabase.from('reports').select('*').order('created_at', { ascending: false });
  if (tab && tab !== 'all') query = query.eq('review_status', tab);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/admin/api/me', (req, res) => {
  const user = getUser(req);
  res.json({ user: user || null, isAdmin: isAdmin(user) });
});

app.put('/admin/api/reports/:id/review', requireAdmin, async (req, res) => {
  const { action, reason } = req.body;
  if (!['approve','reject'].includes(action)) return res.status(400).json({ error: '無效操作' });
  const review_status = action === 'approve' ? 'approved' : 'rejected';

  // 取得通報資訊（含圖片路徑與通報者 LINE ID）
  const { data: report } = await supabase
    .from('reports').select('*, users(line_id, display_name)')
    .eq('id', req.params.id).single();

  const updatePayload = { review_status, reject_reason: reason || null };

  // 拒絕時刪除 Storage 圖片並清空 image_paths
  if (action === 'reject') {
    const imgs = Array.isArray(report?.image_paths) ? report.image_paths : [];
    await deleteStorageImages(imgs);
    updatePayload.image_paths = [];
  }

  const { error } = await supabase.from('reports')
    .update(updatePayload)
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  // LINE 推播通知
  if (report?.user_id && process.env.LINE_MESSAGING_TOKEN) {
    const lineId = report.users?.line_id;
    if (lineId) sendLineNotify(lineId, report.species, action, reason).catch(console.error);
  }

  res.json({ success: true });
});

// 從 Supabase 公開 URL 萃取 bucket 內的相對路徑，並刪除檔案
async function deleteStorageImages(imagePaths) {
  if (!Array.isArray(imagePaths) || !imagePaths.length) return;
  const paths = imagePaths
    .map(url => {
      // URL 格式：.../storage/v1/object/public/wildlife-images/<path>
      const m = String(url).match(/\/wildlife-images\/(.+)$/);
      return m ? m[1] : null;
    })
    .filter(Boolean);
  if (!paths.length) return;
  const { error } = await supabase.storage.from('wildlife-images').remove(paths);
  if (error) console.error('Storage 圖片刪除失敗:', error.message);
}

async function sendLineNotify(lineId, species, action, reason) {
  const SITE = process.env.LINE_REDIRECT_URI?.replace('/auth/line/callback', '') || 'https://wildlife-platform.onrender.com';
  const approved = action === 'approve';
  const message = {
    type: 'flex',
    altText: approved
      ? `您的通報「${species}」已通過審核！`
      : `您的通報「${species}」未通過審核`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        backgroundColor: approved ? '#1b4332' : '#7f1d1d',
        paddingAll: '16px',
        contents: [{
          type: 'text',
          text: approved ? '✅ 通報已核准' : '❌ 通報未通過',
          color: '#ffffff', weight: 'bold', size: 'lg'
        }]
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px',
        contents: [
          { type: 'text', text: `物種：${species}`, size: 'md', weight: 'bold', color: '#111827' },
          { type: 'text', text: approved
              ? '您的通報已通過審核，現已顯示於地圖上，感謝您的貢獻！'
              : `很抱歉，您的通報未通過審核。${reason ? `\n原因：${reason}` : ''}`,
            wrap: true, size: 'sm', color: '#374151', margin: 'sm' }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px',
        contents: [{
          type: 'button', style: 'primary',
          color: '#2d6a4f',
          action: { type: 'uri', label: '前往地圖查看', uri: SITE }
        }]
      }
    }
  };

  await axios.post('https://api.line.me/v2/bot/message/push',
    { to: lineId, messages: [message] },
    { headers: {
        'Authorization': `Bearer ${process.env.LINE_MESSAGING_TOKEN}`,
        'Content-Type': 'application/json'
    }}
  );
}

// ── 批量審核 ──────────────────────────────────────────────
app.put('/admin/api/reports/bulk-review', requireAdmin, async (req, res) => {
  const { ids, action, reason } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '請選擇通報' });
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: '無效操作' });

  const review_status = action === 'approve' ? 'approved' : 'rejected';

  // 先取通報資訊（圖片路徑 + LINE ID）
  const { data: reports } = await supabase
    .from('reports').select('id, species, image_paths, users(line_id)')
    .in('id', ids);

  const updatePayload = { review_status, reject_reason: reason || null };

  // 拒絕時刪除所有 Storage 圖片並清空 image_paths
  if (action === 'reject' && reports) {
    const allImgs = reports.flatMap(r =>
      Array.isArray(r.image_paths) ? r.image_paths : []
    );
    await deleteStorageImages(allImgs);
    updatePayload.image_paths = [];
  }

  const { error } = await supabase.from('reports')
    .update(updatePayload)
    .in('id', ids);

  if (error) return res.status(500).json({ error: error.message });

  // 發送 LINE 通知（非同步，不阻塞回應）
  if (process.env.LINE_MESSAGING_TOKEN && reports) {
    Promise.allSettled(
      reports
        .filter(r => r.users?.line_id)
        .map(r => sendLineNotify(r.users.line_id, r.species, action, reason))
    ).catch(() => {});
  }

  res.json({ success: true, count: ids.length });
});

app.get('/api/reports/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('reports')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: '通報不存在' });
  res.json(data);
});

app.post('/api/reports', requireAuth, upload.array('images', 5), async (req, res) => {
  const { species, quantity, status, lat, lng, address, description } = req.body;
  if (!species || !lat || !lng) return res.status(400).json({ error: '物種名稱與地點為必填' });

  // 上傳圖片到 Supabase Storage
  const imagePaths = [];
  for (const file of (req.files || [])) {
    const ext  = path.extname(file.originalname).toLowerCase() || '.jpg';
    const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    const { error: upErr } = await supabase.storage
      .from('wildlife-images')
      .upload(name, file.buffer, { contentType: file.mimetype, upsert: false });
    if (!upErr) {
      const { data: { publicUrl } } = supabase.storage.from('wildlife-images').getPublicUrl(name);
      console.log('圖片上傳成功:', publicUrl);
      imagePaths.push(publicUrl);
    } else {
      console.error('圖片上傳失敗:', upErr.message, '| bucket: wildlife-images | 請確認 bucket 存在且設為 public');
    }
  }

  const { data, error } = await supabase.from('reports').insert({
    user_id:     req.session.user.id,
    user_name:   req.session.user.name,
    user_avatar: req.session.user.avatar,
    species:     species.trim(),
    quantity:    parseInt(quantity) || 1,
    status:      status || 'alive',
    lat:         parseFloat(lat),
    lng:         parseFloat(lng),
    address:     address || '',
    description: description || '',
    image_paths: imagePaths,
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, id: data.id });
});

app.put('/api/reports/:id', requireAuth, upload.array('images', 5), async (req, res) => {
  const currentUser = getUser(req);
  const { data: report, error: fetchErr } = await supabase
    .from('reports').select('user_id, image_paths').eq('id', req.params.id).single();
  if (fetchErr || !report) return res.status(404).json({ error: '通報不存在' });
  if (report.user_id !== currentUser.id) return res.status(403).json({ error: '無權限' });

  const { species, quantity, status, lat, lng, address, description, keep_images } = req.body;
  if (!species || !lat || !lng) return res.status(400).json({ error: '物種名稱與地點為必填' });

  // 保留使用者選擇保留的舊圖
  let keptImages = [];
  try { keptImages = JSON.parse(keep_images || '[]'); } catch {}

  // 上傳新圖片
  const newImagePaths = [];
  for (const file of (req.files || [])) {
    const ext  = path.extname(file.originalname).toLowerCase() || '.jpg';
    const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    const { error: upErr } = await supabase.storage
      .from('wildlife-images')
      .upload(name, file.buffer, { contentType: file.mimetype });
    if (!upErr) {
      const { data: { publicUrl } } = supabase.storage.from('wildlife-images').getPublicUrl(name);
      newImagePaths.push(publicUrl);
    } else {
      console.error('圖片上傳失敗:', upErr.message);
    }
  }

  const { data, error } = await supabase.from('reports').update({
    species:     species.trim(),
    quantity:    parseInt(quantity) || 1,
    status:      status || 'alive',
    lat:         parseFloat(lat),
    lng:         parseFloat(lng),
    address:     address || '',
    description: description || '',
    image_paths: [...keptImages, ...newImagePaths],
  }).eq('id', req.params.id).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, id: data.id });
});

app.delete('/api/reports/:id', requireAuth, async (req, res) => {
  const { data: report } = await supabase
    .from('reports').select('user_id').eq('id', req.params.id).single();
  if (!report) return res.status(404).json({ error: '通報不存在' });
  if (report.user_id !== req.session.user.id) return res.status(403).json({ error: '無權限' });
  await supabase.from('reports').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ── 留言 API ──────────────────────────────────────────────
app.get('/api/reports/:id/comments', async (req, res) => {
  const { data, error } = await supabase
    .from('comments').select('*')
    .eq('report_id', req.params.id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/reports/:id/comments', requireAuth, async (req, res) => {
  const user = getUser(req);
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: '留言不能為空' });
  if (content.length > 500) return res.status(400).json({ error: '留言最多 500 字' });

  const { data, error } = await supabase.from('comments').insert({
    report_id:   parseInt(req.params.id),
    user_id:     user.id,
    user_name:   user.name,
    user_avatar: user.avatar || '',
    content,
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/comments/:id', requireAuth, async (req, res) => {
  const user = getUser(req);
  const { data: c } = await supabase
    .from('comments').select('user_id').eq('id', req.params.id).single();
  if (!c) return res.status(404).json({ error: '留言不存在' });
  if (c.user_id !== user.id && !isAdmin(user))
    return res.status(403).json({ error: '無權限刪除' });
  await supabase.from('comments').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ── 健康檢查 ──────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const checks = {
    supabase_url:  !!process.env.SUPABASE_URL,
    supabase_key:  !!process.env.SUPABASE_SERVICE_KEY,
    line_id:       !!process.env.LINE_CLIENT_ID,
    line_secret:   !!process.env.LINE_CLIENT_SECRET,
    line_redirect: process.env.LINE_REDIRECT_URI || '(未設定)',
    db: false,
    db_error: null,
  };
  try {
    const { error } = await supabase.from('reports').select('id').limit(1);
    checks.db = !error;
    if (error) checks.db_error = error.message;
  } catch (e) {
    checks.db_error = e.message;
  }
  res.json(checks);
});

// ── 地址 Autocomplete 建議（Photon API）──────────────────────
app.get('/api/geocode/suggest', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  try {
    const r = await axios.get('https://photon.komoot.io/api/', {
      params: { q, limit: 6, lang: 'zh', bbox: '118,21,122.5,26.5' },
      timeout: 5000
    });
    const results = (r.data.features || []).map(f => {
      const p = f.properties;
      const parts = [p.name, p.street, p.city || p.county, p.state].filter(Boolean);
      return {
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0],
        name: p.name || parts[0] || '',
        sub: [p.city || p.county, p.state].filter(Boolean).join(' · '),
        display_name: parts.join('，')
      };
    });
    res.json(results);
  } catch {
    res.json([]);
  }
});

// ── 地址 Geocoding 代理（NLSC → Nominatim fallback）────────
app.get('/api/geocode', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'missing q' });

  // 1. 嘗試 NLSC（國土測繪中心）台灣地址定位服務
  try {
    const nlscRes = await axios.get(
      'https://geocoding.nlsc.gov.tw/nlsc/toLonLat.action',
      { params: { address: q, format: 'json' }, timeout: 6000 }
    );
    const d = nlscRes.data;
    if (d && d.error === '0' && d.longitude && d.latitude) {
      return res.json([{
        lat: parseFloat(d.latitude),
        lng: parseFloat(d.longitude),
        display_name: d.address || q,
        source: 'nlsc'
      }]);
    }
  } catch (_) { /* fallthrough */ }

  // 2. Fallback: Nominatim
  try {
    const nomRes = await axios.get(
      'https://nominatim.openstreetmap.org/search',
      {
        params: { q, format: 'json', limit: 5, countrycodes: 'tw', 'accept-language': 'zh-TW' },
        headers: { 'User-Agent': 'WildlifePlatform/1.0', 'Accept-Language': 'zh-TW' },
        timeout: 8000
      }
    );
    const results = (nomRes.data || []).map(d => ({
      lat: parseFloat(d.lat),
      lng: parseFloat(d.lon),
      display_name: d.display_name,
      source: 'nominatim'
    }));
    if (results.length) return res.json(results);
    return res.json([]);
  } catch (_) {
    return res.status(502).json({ error: 'geocode failed' });
  }
});

// ── 啟動 ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🦌 野生動物通報平台已啟動 → http://localhost:${PORT}\n`);
});
