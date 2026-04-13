/**
 * 從 iNaturalist API 抓取台灣野生動物物種資料，寫入 Supabase species 表
 * 使用方式：node scripts/fetch-species.js
 *
 * 資料來源：iNaturalist (place_id=234 台灣)
 * 中文名稱：locale=zh-TW，有觀測紀錄且社群確認的物種優先
 */

require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// 分類設定
const TAXA = [
  { iconic: 'Mammalia',         cat: '哺乳類', icon: '🦌', maxPages: 5  },
  { iconic: 'Aves',             cat: '鳥類',   icon: '🦅', maxPages: 15 },
  { iconic: 'Reptilia',         cat: '爬蟲類', icon: '🦎', maxPages: 5  },
  { iconic: 'Amphibia',         cat: '兩棲類', icon: '🐸', maxPages: 3  },
  { iconic: 'Actinopterygii',   cat: '魚類',   icon: '🐟', maxPages: 10 },
  { iconic: 'Insecta',          cat: '昆蟲類', icon: '🦋', maxPages: 20 },
];

const TAIWAN_PLACE_ID = 234;
const PER_PAGE = 200;
const DELAY_MS = 1500; // iNaturalist rate limit: 100 req/min

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchPage(iconic, page) {
  try {
    const res = await axios.get('https://api.inaturalist.org/v1/taxa', {
      params: {
        place_id:    TAIWAN_PLACE_ID,
        rank:        'species',
        iconic_taxa: iconic,
        locale:      'zh-TW',
        per_page:    PER_PAGE,
        page,
        order_by:    'observations_count',
        order:       'desc',
      },
      headers: { 'User-Agent': 'WildlifePlatform-TW/1.0' },
      timeout: 20000,
    });
    return res.data;
  } catch (e) {
    console.error(`  ❌ 抓取失敗 (page ${page}):`, e.message);
    return null;
  }
}

async function processTaxon(taxonConfig) {
  const { iconic, cat, icon, maxPages } = taxonConfig;
  console.log(`\n📦 抓取 ${cat}（${iconic}）...`);

  const species = [];
  let page = 1;

  while (page <= maxPages) {
    process.stdout.write(`  第 ${page} 頁...`);
    const data = await fetchPage(iconic, page);

    if (!data || !data.results?.length) {
      console.log(' 無資料，停止');
      break;
    }

    for (const taxon of data.results) {
      const nameZh = taxon.preferred_common_name || '';
      const nameSci = taxon.name || '';
      const nameEn = (taxon.english_common_name || '');

      // 跳過沒有中文名的物種
      if (!nameZh) continue;
      // 跳過純英文（沒中文）
      if (/^[a-zA-Z\s\-']+$/.test(nameZh)) continue;

      species.push({
        category: cat,
        name_zh:  nameZh,
        name_en:  nameEn || nameSci,
        icon:     icon,
      });
    }

    console.log(` 取得 ${data.results.length} 筆（有中文名：${species.length} 筆累計）`);

    if (data.total_results <= page * PER_PAGE) {
      console.log('  已到最後一頁');
      break;
    }

    page++;
    await sleep(DELAY_MS);
  }

  return species;
}

async function upsertToSupabase(species) {
  const BATCH = 100;
  let total = 0;

  for (let i = 0; i < species.length; i += BATCH) {
    const batch = species.slice(i, i + BATCH);
    const { error } = await supabase
      .from('species')
      .upsert(batch, { onConflict: 'name_zh,category', ignoreDuplicates: true });

    if (error) {
      console.error(`  ❌ 寫入失敗:`, error.message);
    } else {
      total += batch.length;
      process.stdout.write(`\r  寫入進度: ${total}/${species.length}`);
    }
  }
  console.log('');
}

async function main() {
  console.log('🦌 台灣野生動物物種資料匯入工具');
  console.log('================================');
  console.log('資料來源：iNaturalist (台灣觀測紀錄)');
  console.log('');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('❌ 請確認 .env 有設定 SUPABASE_URL 和 SUPABASE_SERVICE_KEY');
    process.exit(1);
  }

  const allSpecies = [];

  for (const taxon of TAXA) {
    const results = await processTaxon(taxon);
    allSpecies.push(...results);
    console.log(`  ✅ ${taxon.cat} 共 ${results.length} 筆有中文名物種`);
    await sleep(2000);
  }

  // 去除重複（同名同分類）
  const seen = new Set();
  const unique = allSpecies.filter(s => {
    const key = `${s.category}|${s.name_zh}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\n📊 總計：${unique.length} 筆（去重後）`);
  console.log('');
  console.log('💾 寫入 Supabase...');
  await upsertToSupabase(unique);

  console.log('');
  console.log('✅ 完成！');

  // 輸出統計
  const counts = {};
  unique.forEach(s => { counts[s.category] = (counts[s.category] || 0) + 1; });
  console.log('\n📈 各分類數量：');
  Object.entries(counts).forEach(([cat, count]) => {
    console.log(`  ${cat}: ${count} 筆`);
  });
}

main().catch(err => {
  console.error('❌ 執行失敗：', err.message);
  process.exit(1);
});
