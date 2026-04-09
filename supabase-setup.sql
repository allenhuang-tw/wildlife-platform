-- ══════════════════════════════════════════════
-- 野生動物通報平台 — Supabase 初始化 SQL
-- 在 Supabase Dashboard → SQL Editor 貼上執行
-- ══════════════════════════════════════════════

-- 使用者資料表
CREATE TABLE IF NOT EXISTS users (
  id           SERIAL PRIMARY KEY,
  line_id      TEXT UNIQUE NOT NULL,
  display_name TEXT,
  picture_url  TEXT DEFAULT '',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 通報資料表
CREATE TABLE IF NOT EXISTS reports (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id),
  user_name   TEXT,
  user_avatar TEXT DEFAULT '',
  species     TEXT NOT NULL,
  quantity    INTEGER DEFAULT 1,
  status      TEXT DEFAULT 'alive',
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  address     TEXT DEFAULT '',
  description TEXT DEFAULT '',
  image_paths JSONB DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 建立索引加速查詢
CREATE INDEX IF NOT EXISTS idx_reports_species    ON reports(species);
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_status     ON reports(status);

-- 範例資料（台灣野生動物觀察記錄）
INSERT INTO reports (user_name, species, quantity, status, lat, lng, address, description, image_paths) VALUES
  (NULL, '台灣黑熊', 1,  'alive',   23.80, 121.02, '花蓮縣秀林鄉',   '在山路上目擊黑熊橫越馬路，狀況良好',         '[]'),
  (NULL, '石虎',     2,  'alive',   24.12, 120.62, '苗栗縣三義鄉',   '夜間車燈照到兩隻石虎，疑似母子',             '[]'),
  (NULL, '台灣獼猴', 15, 'alive',   22.63, 120.51, '高雄市壽山',     '壽山獼猴群，共約 15 隻，行為正常',           '[]'),
  (NULL, '山羌',     1,  'injured', 23.52, 120.80, '嘉義縣阿里山鄉', '發現受傷山羌，腿部疑似骨折，已通知救傷單位', '[]'),
  (NULL, '台灣藍鵲', 3,  'alive',   25.17, 121.55, '台北市陽明山',   '陽明山發現台灣藍鵲家族，共三隻',             '[]'),
  (NULL, '領角鴞',   1,  'alive',   24.78, 121.01, '桃園市復興區',   '夜間聽到鳴叫後循聲發現，停在枯木上',         '[]'),
  (NULL, '水鹿',     4,  'alive',   23.47, 121.22, '花蓮縣玉里鎮',   '傍晚在農地旁發現水鹿群，共四隻',             '[]'),
  (NULL, '白鼻心',   1,  'dead',    24.51, 120.82, '新竹縣尖石鄉',   '路邊發現疑似路殺個體，已通報林業署',         '[]'),
  (NULL, '台灣野豬', 3,  'alive',   23.18, 120.42, '台南市楠西區',   '農地附近發現野豬破壞農作物',                 '[]'),
  (NULL, '赤腹松鼠', 6,  'alive',   25.08, 121.23, '新北市三峽區',   '郊山步道旁活動頻繁，不怕人',                 '[]');
