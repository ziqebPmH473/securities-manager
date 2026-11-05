// Cloudflare Pages Function: 株価指数の PER（株価収益率）取得プロキシ
// GET /api/per?src=nikkei   … 日経平均 PER（予想・日次）  … 日経 Indexes「日経平均 PER・PBR」ページ
// GET /api/per?src=sp500    … S&P500 PER（実績・月次）    … multpl.com（Shiller データ。1871年〜）
// GET /api/per?src=ndx      … NASDAQ100 PER（実績・当日） … Yahoo Finance の QQQ（NASDAQ100連動ETF）trailingPE
//   → { id, obs:[["YYYY-MM-DD", 値], ...], freq, src, note, at }   （/api/macro の1系列と同じ形）
//
// ★日経のページは Cloudflare のボット認証（JS チャレンジ）が掛かることがあり、サーバーからの
//   取得が通らない場合がある。その時は { error, blocked:true } を返し、クライアント側は
//   「ページの表をコピーして貼り付け」で取り込む経路（macroPerPaste）に案内する。
// ★NASDAQ100 は無料で履歴を配っている所が無いため、当日値だけ返しクライアント側で日々積み上げる。
import { guardApi } from '../lib/api-guard.js';

const UA = 'securities-manager/1.0 (+https://github.com/ziqebPmH473/securities-manager)';
const CACHE_TTL = 3 * 3600;      // エッジキャッシュ3時間（PER の更新は日次）
const THIN_MAX = 320, THIN_RECENT = 200;   // /api/macro と同じ間引き規則（同期対象の肥大防止）

const SOURCES = {
  nikkei: { url: 'https://indexes.nikkei.co.jp/nkave/archives/data?list=per', note: '出典: 日経平均プロフィル（日本経済新聞社）', freq: '日次' },
  sp500:  { url: 'https://www.multpl.com/s-p-500-pe-ratio/table/by-month',     note: '出典: multpl.com（S&P500 実績PER・月次）',   freq: '月次' },
  ndx:    { url: 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/QQQ?modules=summaryDetail,defaultKeyStatistics', note: '出典: Yahoo Finance（QQQ の実績PER）', freq: '日次' },   // 失敗時は finance.yahoo.com/quote/QQQ/ のページ本文へフォールバック
};

export async function onRequestGet(context) {
  const denied = await guardApi(context);   // 鍵つきAPI: 本人のGoogleログイン or 内部トークンのみ
  if (denied) return denied;
  const url = new URL(context.request.url);
  const src = (url.searchParams.get('src') || '').trim().toLowerCase();
  const def = SOURCES[src];
  if (!def) return json({ error: 'src は nikkei / sp500 / ndx のいずれかです' }, 400);
  try {
    const obs = src === 'nikkei' ? await fetchNikkei(def) : src === 'sp500' ? await fetchMultpl(def) : await fetchYahooPe(def);
    if (!obs.length) throw new Error('データなし (' + src + ')');
    return json({ id: src, obs: thin(obs), freq: def.freq, src, note: def.note, at: new Date().toISOString() });
  } catch (e) {
    const msg = String((e && e.message) || e);
    return json({ error: msg, blocked: /ボット認証/.test(msg), src }, 502);
  }
}

async function getText(u, extraHeaders) {
  const res = await fetchWithTimeout(u, {
    headers: Object.assign({ 'User-Agent': UA, 'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8' }, extraHeaders || {}),
    cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
  });
  const text = await res.text();
  // Cloudflare の JS チャレンジ（人間かどうかの確認ページ）。HTML は返るがデータは無い
  if (res.headers.get('cf-mitigated') === 'challenge' || /_cf_chl_opt|cf-chl|Just a moment/.test(text.slice(0, 4000))) {
    throw new Error('取得元のボット認証にブロックされました（' + new URL(u).host + '）');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} (${new URL(u).host})`);
  return text;
}

// ---- 日経平均 PER（日経 Indexes のページの表を読む） ----
// 表の列構成がページ側で変わっても拾えるように、見出しに「PER」を含む列を探し、見つからなければ
// 「日付の後にある 3〜200 の範囲の最初の数値」を PER とみなす（株価は 1万以上・PBR は 3 未満なので混ざらない）。
async function fetchNikkei(def) {
  const html = await getText(def.url, { 'Accept-Language': 'ja,en;q=0.8' });
  return parsePerTable(html);
}
export function parsePerTable(html) {
  const out = new Map();
  let perCol = -1;
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (tr.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || []).map(c => strip(c));
    if (!cells.length) continue;
    const hi = cells.findIndex(c => /PER/i.test(c));
    if (hi >= 0 && !cells.some(c => DATE_RE.test(c))) { perCol = hi; continue; }   // 見出し行
    const row = parsePerRow(cells, perCol);
    if (row) out.set(row[0], row[1]);
  }
  return [...out.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
}
// セル配列（または貼り付け1行の分割）から [日付, PER] を取り出す。クライアントの貼り付け取込と同じ規則。
export const DATE_RE = /(\d{4})\s*[.\/\-年]\s*(\d{1,2})\s*[.\/\-月]\s*(\d{1,2})/;
export function parsePerRow(cells, perCol) {
  const di = cells.findIndex(c => DATE_RE.test(c));
  if (di < 0) return null;
  const m = cells[di].match(DATE_RE);
  const date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if (isNaN(Date.parse(date))) return null;
  let v = null;
  if (perCol >= 0 && perCol < cells.length && perCol !== di) v = num(cells[perCol]);
  if (v == null || v < 3 || v > 200) {
    v = null;
    for (let i = di + 1; i < cells.length; i++) {
      const n = num(cells[i]);
      if (n != null && n >= 3 && n <= 200) { v = n; break; }
    }
  }
  return v == null ? null : [date, v];
}

// ---- S&P500 PER（multpl.com の月次表） ----
// 行: <td>Nov 1, 2026</td><td><abbr title="Estimate">†</abbr> 25.06</td>（† は推定値。値はそのまま使う）
const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
async function fetchMultpl(def) {
  const html = await getText(def.url);
  return parseMultpl(html);
}
export function parseMultpl(html) {
  const out = new Map();
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (tr.match(/<td[\s\S]*?<\/td>/gi) || []).map(c => strip(c));
    if (cells.length < 2) continue;
    const m = cells[0].match(/^([A-Za-z]{3})\w*\s+(\d{1,2}),\s*(\d{4})$/);
    const mo = m && MONTHS[m[1].toLowerCase()];
    if (!mo) continue;
    const v = num(cells[1].replace(/[†*]/g, ''));
    if (v == null || v <= 0) continue;
    if (m[3] < '1970') continue;   // 1871年〜あるが、全期間表示が間延びするので1970年以降に絞る（間引き後320点）
    // 月初の値が原則。月の途中の行（最新の推定値）は、その月の値として上書きせず別日付で残す
    out.set(`${m[3]}-${mo}-${m[2].padStart(2, '0')}`, v);
  }
  return [...out.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
}

// ---- NASDAQ100 PER（QQQ の trailingPE。当日値だけ） ----
// quoteSummary（JSON API）は本番の Cloudflare からブロックされることがある（2026-11-06 実機で「—」）ので、
// 失敗したら Yahoo Finance（米国版）の QQQ ページ本文の「PE Ratio (TTM)」を読む（開発環境で 26.65 を確認）。
async function fetchYahooPe(def) {
  try { return await fetchYahooPeApi(def); }
  catch (e1) {
    try { return await fetchYahooPePage(); }
    catch (e2) { throw new Error(`QQQ の PER が取れませんでした（API: ${String((e1 && e1.message) || e1)} / ページ: ${String((e2 && e2.message) || e2)}）`); }
  }
}
async function fetchYahooPePage() {
  const html = await getText('https://finance.yahoo.com/quote/QQQ/');
  const pe = parseYahooPagePe(html);
  if (pe == null) throw new Error('PE Ratio (TTM) が見つかりません');
  return [[new Date().toISOString().slice(0, 10), pe]];
}
export function parseYahooPagePe(html) {
  // 例: <span class="label ...">PE Ratio (TTM)</span> <span class="value ...">26.65</span>
  const m = html.match(/PE Ratio \(TTM\)[\s\S]{0,400}?>\s*([\d.,]+)\s*</);
  const v = m ? parseFloat(m[1].replace(/,/g, '')) : NaN;
  return (isFinite(v) && v > 0) ? Math.round(v * 100) / 100 : null;
}
async function fetchYahooPeApi(def) {
  const text = await getText(def.url, { 'Accept': 'application/json' });
  let d = null;
  try { d = JSON.parse(text); } catch (_) { throw new Error('Yahoo の応答がJSONではありません'); }
  const r = d && d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0];
  if (!r) throw new Error((d && d.quoteSummary && d.quoteSummary.error && d.quoteSummary.error.description) || 'Yahoo quoteSummary データなし');
  const sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {};
  const raw = (x) => (x && typeof x.raw === 'number' && isFinite(x.raw)) ? x.raw : null;
  const pe = raw(sd.trailingPE) ?? raw(ks.trailingPE) ?? raw(sd.forwardPE) ?? raw(ks.forwardPE);
  if (pe == null || pe <= 0) throw new Error('QQQ の PER が取れませんでした');
  return [[new Date().toISOString().slice(0, 10), Math.round(pe * 100) / 100]];
}

// ---- 共通 ----
function strip(html) {
  return html.replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))   // multpl は値の前に &#x2002;（空白）を置く
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/[\s\u2000-\u200b\u3000]+/g, ' ').trim();
}
function num(s) {
  if (s == null) return null;
  const t = String(s).replace(/[,，\s]/g, '').replace(/[０-９．]/g, ch => ch === '．' ? '.' : String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  if (!/^[-+]?\d+(\.\d+)?$/.test(t)) return null;
  const v = parseFloat(t);
  return isFinite(v) ? v : null;
}
// 直近 THIN_RECENT 点はそのまま、それ以前を等間隔に間引いて THIN_MAX 点以内にする（/api/macro と同じ）
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
async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
  });
}
