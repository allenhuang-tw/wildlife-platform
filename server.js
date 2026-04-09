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
  res.json({ user: user || null });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {});
  res.clearCookie(COOKIE_NAME);
  res.json({ success: true });
});

// ── 通報 API ──────────────────────────────────────────────
app.get('/api/reports', async (req, res) => {
  const { species } = req.query;
  let query = supabase.from('reports').select('*')
    .eq('review_status', 'approved')          // 只顯示已核准
    .order('created_at', { ascending: false });
  if (species) query = query.ilike('species', `%${species}%`);
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
  const { error } = await supabase.from('reports')
    .update({ review_status, reject_reason: reason || null })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
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

// ── 啟動 ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🦌 野生動物通報平台已啟動 → http://localhost:${PORT}\n`);
});
