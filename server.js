require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer  = require('multer');
const axios   = require('axios');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── 目錄 ──────────────────────────────────────────────────
// 雲端：設定 DATA_DIR 環境變數指向 Volume 掛載點（如 /data）
// 本地：預設使用專案根目錄
const DATA_DIR   = process.env.DATA_DIR || __dirname;
const uploadsDir = process.env.DATA_DIR
  ? path.join(DATA_DIR, 'uploads')
  : path.join(__dirname, 'public', 'uploads');
const dataFile   = path.join(DATA_DIR, 'data.json');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// 雲端 Volume 上傳時，提供靜態服務
if (process.env.DATA_DIR) {
  app.use('/uploads', express.static(uploadsDir));
}

// ── JSON 資料庫 ───────────────────────────────────────────
function readDB() {
  if (!fs.existsSync(dataFile)) {
    const init = { users: [], reports: [], nextUserId: 1, nextReportId: 1 };
    fs.writeFileSync(dataFile, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
}
function writeDB(data) {
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
}

// 插入範例資料（僅首次）
(function seedIfEmpty() {
  const db = readDB();
  if (db.reports.length > 0) return;

  const samples = [
    { species:'台灣黑熊', quantity:1, status:'alive',   lat:23.80, lng:121.02, address:'花蓮縣秀林鄉', description:'在山路上目擊黑熊橫越馬路，狀況良好' },
    { species:'石虎',     quantity:2, status:'alive',   lat:24.12, lng:120.62, address:'苗栗縣三義鄉', description:'夜間車燈照到兩隻石虎，疑似母子' },
    { species:'台灣獼猴', quantity:15,status:'alive',   lat:22.63, lng:120.51, address:'高雄市壽山',   description:'壽山獼猴群，共約 15 隻' },
    { species:'山羌',     quantity:1, status:'injured', lat:23.52, lng:120.80, address:'嘉義縣阿里山鄉', description:'發現受傷山羌，已通知救傷單位' },
    { species:'台灣藍鵲', quantity:3, status:'alive',   lat:25.17, lng:121.55, address:'台北市陽明山', description:'陽明山發現台灣藍鵲家族，共三隻' },
    { species:'領角鴞',   quantity:1, status:'alive',   lat:24.78, lng:121.01, address:'桃園市復興區', description:'夜間聽到鳴叫後循聲發現' },
    { species:'水鹿',     quantity:4, status:'alive',   lat:23.47, lng:121.22, address:'花蓮縣玉里鎮', description:'傍晚在農地旁發現水鹿群' },
    { species:'白鼻心',   quantity:1, status:'dead',    lat:24.51, lng:120.82, address:'新竹縣尖石鄉', description:'路邊發現疑似路殺個體' },
    { species:'台灣野豬', quantity:3, status:'alive',   lat:23.18, lng:120.42, address:'台南市楠西區', description:'農地附近發現野豬破壞農作' },
    { species:'赤腹松鼠', quantity:6, status:'alive',   lat:25.08, lng:121.23, address:'新北市三峽區', description:'郊山步道旁活動頻繁' },
  ];

  const now = new Date().toISOString();
  samples.forEach(s => {
    db.reports.push({ id: db.nextReportId++, user_id: null, user_name: null, user_avatar: null,
      image_paths: [], created_at: now, ...s });
  });
  writeDB(db);
  console.log('✅ 已插入 10 筆範例資料');
})();

// ── Multer ────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('只允許圖片'));
  }
});

// ── 中介層 ────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

const requireAuth = (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: '請先登入' });
  next();
};

// ── LINE OAuth ────────────────────────────────────────────
const LINE_CLIENT_ID     = process.env.LINE_CLIENT_ID;
const LINE_CLIENT_SECRET = process.env.LINE_CLIENT_SECRET;
const LINE_REDIRECT_URI  = process.env.LINE_REDIRECT_URI || `http://localhost:${PORT}/auth/line/callback`;

app.get('/auth/line', (req, res) => {
  if (!LINE_CLIENT_ID) {
    return res.send('<h2>請在 .env 設定 LINE_CLIENT_ID 與 LINE_CLIENT_SECRET</h2><a href="/">返回</a>');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const url = `https://access.line.me/oauth2/v2.1/authorize?response_type=code` +
    `&client_id=${LINE_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(LINE_REDIRECT_URI)}` +
    `&state=${state}&scope=profile%20openid`;
  res.redirect(url);
});

app.get('/auth/line/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error)             return res.redirect(`/?error=${error}`);
  if (state !== req.session.oauthState) return res.redirect('/?error=invalid_state');

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

    const db = readDB();
    let user = db.users.find(u => u.line_id === userId);
    if (user) {
      user.display_name = displayName;
      user.picture_url  = pictureUrl || '';
    } else {
      user = { id: db.nextUserId++, line_id: userId, display_name: displayName,
               picture_url: pictureUrl || '', created_at: new Date().toISOString() };
      db.users.push(user);
    }
    writeDB(db);

    req.session.user = { id: user.id, name: displayName, avatar: pictureUrl || '', lineId: userId };
    res.redirect('/');
  } catch (err) {
    console.error('LINE auth error:', err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/user', (req, res) => res.json({ user: req.session.user || null }));

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ── 通報 API ──────────────────────────────────────────────
app.get('/api/reports', (req, res) => {
  const { species } = req.query;
  let { reports } = readDB();
  if (species) reports = reports.filter(r => r.species.includes(species));
  res.json([...reports].reverse());
});

app.get('/api/reports/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const report = readDB().reports.find(r => r.id === id);
  if (!report) return res.status(404).json({ error: '通報不存在' });
  res.json(report);
});

app.post('/api/reports', requireAuth, upload.array('images', 5), (req, res) => {
  const { species, quantity, status, lat, lng, address, description } = req.body;
  if (!species || !lat || !lng) return res.status(400).json({ error: '物種名稱與地點為必填' });

  const db = readDB();
  const imagePaths = (req.files || []).map(f => `/uploads/${f.filename}`);
  const report = {
    id:          db.nextReportId++,
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
    created_at:  new Date().toISOString(),
  };
  db.reports.push(report);
  writeDB(db);
  res.json({ success: true, id: report.id });
});

app.delete('/api/reports/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDB();
  const idx = db.reports.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: '通報不存在' });
  if (db.reports[idx].user_id !== req.session.user.id) return res.status(403).json({ error: '無權限' });
  db.reports.splice(idx, 1);
  writeDB(db);
  res.json({ success: true });
});

// ── 啟動 ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🦌 野生動物通報平台已啟動`);
  console.log(`   → http://localhost:${PORT}\n`);
  if (!LINE_CLIENT_ID) {
    console.log('⚠️  尚未設定 LINE_CLIENT_ID，LINE 登入功能無法使用');
  }
});
