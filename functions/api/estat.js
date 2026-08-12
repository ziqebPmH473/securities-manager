// Cloudflare Pages Function: e-Stat（政府統計の総合窓口）取得プロキシ
// 日本の CPI・鉱工業生産など、FRED（OECD配信）が更新停止した日本の指標をここから取る。
//
// GET /api/estat?op=list&q=消費者物価指数        … 統計表を検索（statsDataId を調べる用）
// GET /api/estat?op=meta&id=0003427113           … その表の分類項目（絞り込みに使うコード）を返す
// GET /api/estat?op=data&id=0003427113&cd=...    … 実データを [[YYYY-MM-DD, 値], ...] で返す
//
// 要 E_STAT_APP_ID（Cloudflare Pages の環境変数）。未設定なら 503 を返す（FRED と違い代替経路が無い）。

const BASE = 'https://api.e-stat.go.jp/rest/3.0/app/json';
const CACHE_TTL = 6 * 3600;
const SOURCE_NOTE = '出典: e-Stat（政府統計の総合窓口）';
const THIN_MAX = 320, THIN_RECENT = 200;

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const op = url.searchParams.get('op') || 'data';
  const appId = context.env && context.env.E_STAT_APP_ID;
  if (!appId) return json({ error: 'E_STAT_APP_ID が未設定です（Cloudflare Pages の環境変数に登録してください）' }, 503);

  try {
    if (op === 'list') return json(await opList(appId, url));
    if (op === 'meta') return json(await opMeta(appId, url));
    return json(await opData(appId, url));
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502);
  }
}

// ---- 統計表の検索（statsDataId を調べる。実装時の確認用で、通常の画面表示では使わない） ----
async function opList(appId, url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) throw new Error('q パラメータが必要です');
  const u = `${BASE}/getStatsList?appId=${encodeURIComponent(appId)}&searchWord=${encodeURIComponent(q)}&limit=40&statsNameList=Y`;
  const d = await getJson(u);
  const root = d && d.GET_STATS_LIST && d.GET_STATS_LIST.DATALIST_INF;
  const rows = toArray(root && root.TABLE_INF);
  return {
    count: (root && root.NUMBER) || rows.length,
    tables: rows.map(t => ({
      id: t['@id'],
      stat: pick(t.STAT_NAME),
      gov: pick(t.GOV_ORG),
      title: pick(t.TITLE) + (t.TITLE_SPEC ? ' / ' + Object.values(t.TITLE_SPEC).join(' ') : ''),
      cycle: t.CYCLE,
      survey: t.SURVEY_DATE,
      updated: t.UPDATED_DATE,
      rows: t.TOTAL_NUMBER,
    })),
    source: SOURCE_NOTE,
  };
}

// ---- 表のメタ情報（分類コード。どのコードで絞ると欲しい系列になるかを調べる用） ----
async function opMeta(appId, url) {
  const id = reqId(url);
  const d = await getJson(`${BASE}/getMetaInfo?appId=${encodeURIComponent(appId)}&statsDataId=${encodeURIComponent(id)}`);
  const meta = d && d.GET_META_INFO && d.GET_META_INFO.METADATA_INF;
  const objs = toArray(meta && meta.CLASS_INF && meta.CLASS_INF.CLASS_OBJ);
  return {
    title: pick(meta && meta.TABLE_INF && meta.TABLE_INF.TITLE),
    classes: objs.map(o => ({
      id: o['@id'], name: o['@name'],
      // 項目が多い表があるので先頭30件だけ返す（探索用途には十分）
      items: toArray(o.CLASS).slice(0, 30).map(c => ({ code: c['@code'], name: c['@name'], unit: c['@unit'] })),
      total: toArray(o.CLASS).length,
    })),
    source: SOURCE_NOTE,
  };
}

// ---- 実データ ----
// cd パラメータは e-Stat の絞り込みをそのまま通す（例: cdCat01=0001&cdArea=00000）。
// 返す形は /api/macro と同じ { obs:[[YYYY-MM-DD,値],...], freq, last }。
async function opData(appId, url) {
  const id = reqId(url);
  const p = new URLSearchParams();
  p.set('appId', appId);
  p.set('statsDataId', id);
  p.set('metaGetFlg', 'N');
  p.set('cntGetFlg', 'N');
  p.set('limit', '5000');
  // cdCat01 / cdArea / cdTab / cdTime など、e-Stat が受け付ける絞り込みをそのまま転送する。
  // 想定外のキーを通さないよう cd で始まるものだけに限定する。
  for (const [k, v] of url.searchParams) {
    if (/^cd[A-Za-z0-9_]{0,20}$/.test(k) && v) p.set(k, v);
  }
  const d = await getJson(`${BASE}/getStatsData?${p.toString()}`);
  const st = d && d.GET_STATS_DATA && d.GET_STATS_DATA.STATISTICAL_DATA;
  const result = d && d.GET_STATS_DATA && d.GET_STATS_DATA.RESULT;
  if (result && String(result.STATUS) !== '0') throw new Error(`e-Stat ${result.STATUS}: ${result.ERROR_MSG || ''}`);
  const values = toArray(st && st.DATA_INF && st.DATA_INF.VALUE);
  if (!values.length) throw new Error('データなし（絞り込み条件を見直してください）');

  const obs = [];
  for (const v of values) {
    const date = timeToDate(v['@time']);
    const n = Number(v.$);
    if (date && isFinite(n)) obs.push([date, n]);
  }
  if (!obs.length) throw new Error('数値として読める観測値がありません');
  obs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // 同じ時点が複数返る（分類の絞り込み不足）場合は、意図しない合算を避けるため明示的に弾く
  const dup = obs.length - new Set(obs.map(o => o[0])).size;
  if (dup > 0) throw new Error(`同じ時点の値が${dup}件重複しています。cdCat 等でさらに絞り込んでください`);

  return { obs: thin(obs), freq: guessFreq(obs), last: obs[obs.length - 1], source: SOURCE_NOTE };
}

// e-Stat の @time は「YYYYMMDD形式のコード」。月次=YYYY0M0M（例 202607→"2026000707"風）ではなく
// 実際は 年(4)＋区分(2)＋期(2)。例: 2026年7月＝"2026000707"ではなく "202607" ではない点に注意し、
// 実データで確認できた形（10桁: YYYY + 種別2 + 期2 ... ）と 6桁/8桁の両方を許容する。
function timeToDate(t) {
  const s = String(t || '');
  // 10桁: YYYY(4) + 分類(2) + 期(2) + 予備(2)。月次は分類=00・期=月、四半期は分類=10・期=四半期
  if (/^\d{10}$/.test(s)) {
    const y = s.slice(0, 4), kind = s.slice(4, 6), n = parseInt(s.slice(6, 8), 10);
    if (kind === '01' || kind === '00') return `${y}-${String(Math.min(12, Math.max(1, n))).padStart(2, '0')}-01`; // 月次
    if (kind === '02' || kind === '10') return `${y}-${String(Math.min(12, Math.max(1, n * 3 - 2))).padStart(2, '0')}-01`; // 四半期→期初月
    return `${y}-01-01`; // 年次
  }
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{6}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-01`;
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  return null;
}

function thin(obs) {
  if (obs.length <= THIN_MAX) return obs;
  const recent = obs.slice(obs.length - THIN_RECENT);
  const older = obs.slice(0, obs.length - THIN_RECENT);
  const want = THIN_MAX - THIN_RECENT, step = older.length / want;
  const out = [];
  for (let i = 0; i < want; i++) out.push(older[Math.floor(i * step)]);
  out[0] = older[0];
  return out.concat(recent);
}
function guessFreq(obs) {
  if (obs.length < 3) return '';
  const gaps = [];
  for (let i = 1; i < obs.length; i++) gaps.push((Date.parse(obs[i][0]) - Date.parse(obs[i - 1][0])) / 86400000);
  gaps.sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  return med <= 4 ? '日次' : med <= 10 ? '週次' : med <= 45 ? '月次' : med <= 120 ? '四半期' : '年次';
}

function reqId(url) {
  const id = (url.searchParams.get('id') || '').trim();
  if (!/^\d{6,12}$/.test(id)) throw new Error('id（statsDataId）が不正です');
  return id;
}
async function getJson(u) {
  const res = await fetch(u, {
    headers: { 'User-Agent': 'securities-manager/1.0' },
    cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`e-Stat HTTP ${res.status}`);
  return res.json();
}
const toArray = (v) => v == null ? [] : (Array.isArray(v) ? v : [v]);
const pick = (v) => (v && typeof v === 'object') ? (v.$ || v['@name'] || '') : (v || '');

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
