// Cloudflare Pages Function: マクロ経済指標（FRED）取得プロキシ
// GET /api/macro?ids=CPIAUCSL,DGS10&start=2016-01-01
//   → { series: { "CPIAUCSL": { obs:[["2016-01-01",236.9],...], freq, src }, ... }, at, source }
//
// データ源: FRED®（セントルイス連邦準備銀行）
//   1) FRED_API_KEY が設定されていれば公式API（api.stlouisfed.org）
//   2) 未設定なら fredgraph.csv（キー不要の公開CSV）へ自動フォールバック
//      → キー発行前でも動く。キーを入れると公式API経路に切り替わる（コード変更不要）
//
// 返す観測値は「間引き済み」（THIN_MAX 点まで）。日次系列を10年ぶん生のまま返すと
// クライアントのキャッシュ（store.data.macro＝Google同期対象）が肥大するため、
// 直近 THIN_RECENT 点は生のまま・それ以前を等間隔サンプリングして解像度と容量を両立する。
import { guardApi } from '../lib/api-guard.js';

const THIN_MAX = 320;      // 1系列あたりの最大点数
const THIN_RECENT = 200;   // 直近この点数は間引かない（最近の細かい動きを保つ）
const MAX_IDS = 30;        // 1リクエストの系列数上限（Cloudflareのサブリクエスト上限対策）
const CACHE_TTL = 6 * 3600; // エッジキャッシュ6時間（FREDの更新は日次〜四半期なので十分）
const SOURCE_NOTE = 'Source: FRED®, Federal Reserve Bank of St. Louis';

export async function onRequestGet(context) {
  const denied = await guardApi(context);   // 鍵つきAPI: 本人のGoogleログイン or 内部トークンのみ
  if (denied) return denied;
  const url = new URL(context.request.url);
  const ids = (url.searchParams.get('ids') || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!ids.length) return json({ error: 'ids パラメータが必要です' }, 400);
  if (ids.length > MAX_IDS) return json({ error: `ids は最大 ${MAX_IDS} 件です` }, 400);
  // 系列IDは英数字のみ（外部URLへそのまま乗せるので厳格に検証する）
  const bad = ids.find(id => !/^[A-Z0-9]{2,32}$/.test(id));
  if (bad) return json({ error: `系列IDの形式が不正です: ${bad}` }, 400);

  const start = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('start') || '')
    ? url.searchParams.get('start')
    : defaultStart();

  const key = context.env && context.env.FRED_API_KEY;
  const series = {};
  await Promise.all(ids.map(async (id) => {
    try {
      series[id] = key ? await fetchFredApi(id, key, start) : await fetchFredCsv(id, start);
    } catch (e) {
      // 公式API側が落ちた/キーが無効な場合はCSVで再挑戦（片方が死んでも表示が止まらないように）
      if (key) {
        try { series[id] = await fetchFredCsv(id, start); return; } catch (_) { /* 下でエラー返却 */ }
      }
      series[id] = { error: String((e && e.message) || e) };
    }
  }));

  return json({ series, at: new Date().toISOString(), source: SOURCE_NOTE, via: key ? 'api' : 'csv' });
}

// 既定の取得開始日＝約15年前の1/1（四半期系列でも60点、月次で180点は確保できる）
function defaultStart() {
  const y = new Date().getUTCFullYear() - 15;
  return `${y}-01-01`;
}

// ---------- FRED 公式API（要 API キー） ----------
async function fetchFredApi(id, key, start) {
  const u = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}`
    + `&api_key=${encodeURIComponent(key)}&file_type=json&observation_start=${start}`;
  const res = await fetch(u, {
    headers: { 'User-Agent': 'securities-manager/1.0' },
    cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`FRED api ${res.status} (${id})`);
  const d = await res.json();
  const rows = (d && d.observations) || [];
  const obs = [];
  for (const o of rows) {
    const v = num(o && o.value);
    if (o && o.date && v != null) obs.push([o.date, v]);
  }
  if (!obs.length) throw new Error(`データなし (${id})`);
  return pack(obs, 'api');
}

// ---------- fredgraph.csv（キー不要のフォールバック） ----------
// 形式: 1行目 "observation_date,SERIESID"、以降 "YYYY-MM-DD,値"。欠測は空文字 or "."。
async function fetchFredCsv(id, start) {
  const u = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`;
  const res = await fetch(u, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; securities-manager/1.0)' },
    cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`FRED csv ${res.status} (${id})`);
  const text = await res.text();
  // 存在しない系列IDだとHTML（404ページ）が返るので、CSVでない応答は明示エラーにする
  if (/^\s*</.test(text)) throw new Error(`系列が見つかりません (${id})`);
  const obs = [];
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const c = line.indexOf(',');
    if (c < 0) continue;
    const date = line.slice(0, c).trim();
    const v = num(line.slice(c + 1).trim());
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && v != null) obs.push([date, v]);
  }
  if (!obs.length) throw new Error(`データなし (${id})`);
  return pack(obs, 'csv');
}

// 観測値を間引いて返却形に整える。頻度（日次/週次/月次/四半期）は日付間隔の中央値から推定。
function pack(obs, src) {
  obs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { obs: thin(obs), freq: guessFreq(obs), last: obs[obs.length - 1], src };
}

// 直近 THIN_RECENT 点は残し、それ以前を等間隔に間引いて全体を THIN_MAX 点以内にする。
// 最古の点と最新の点は必ず残す（グラフの端が欠けないように）。
function thin(obs) {
  if (obs.length <= THIN_MAX) return obs;
  const recent = obs.slice(obs.length - THIN_RECENT);
  const older = obs.slice(0, obs.length - THIN_RECENT);
  const want = THIN_MAX - THIN_RECENT;
  const step = older.length / want;
  const out = [];
  for (let i = 0; i < want; i++) out.push(older[Math.floor(i * step)]);
  if (out[0] !== older[0]) out[0] = older[0];
  return out.concat(recent);
}

// 日付間隔の中央値から更新頻度を推定（表示ラベル用。判定ロジックには使わない）
function guessFreq(obs) {
  if (obs.length < 3) return '';
  const gaps = [];
  for (let i = 1; i < obs.length; i++) {
    gaps.push((Date.parse(obs[i][0]) - Date.parse(obs[i - 1][0])) / 86400000);
  }
  gaps.sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  if (med <= 4) return '日次';
  if (med <= 10) return '週次';
  if (med <= 45) return '月次';
  if (med <= 120) return '四半期';
  return '年次';
}

function num(v) {
  if (v == null || v === '' || v === '.') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}
