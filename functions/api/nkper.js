// Cloudflare Pages Function: 日経平均の「加重平均PER」をツール側で算出するための部品API
//
// 日経が公表している PER（indexes.nikkei.co.jp の「PER・PBR」ページ）はボット認証付きで自動取得できない。
// そこで、同サイトが静的ファイルとして配っている **構成銘柄一覧（ウエートCSV）**（認証なしで取れる）で
// 225銘柄を特定し、Yahoo!ファイナンス日本版の各銘柄ページから 時価総額・発行済株式数・EPS を取って、
// 日経が公表している「加重平均」PER と同じ定義で自分で計算する。
//
//   加重平均 PER = Σ 時価総額_i / Σ 純利益_i      （純利益_i ≒ EPS_i × 発行済株式数_i）
//   ※日経は「加重平均」（時価総額合計÷純利益合計）と「指数ベース」（日経平均÷指数ベースEPS）の2つを公表している。
//     ツールで算出するのは前者。2026-11-05 実測: ツール 15.96倍 vs 日経公表 15.80倍（差1%）。
//     指数ベースは株価換算係数の大きい銘柄（ソフトバンクG等＝会社予想なし・日経予想で補われる）に左右され、再現できなかった。
//
// EPS は 会社予想（参考指標の EPS）。未公表（---）の銘柄は 実績EPS ≒ ROE(実績)×BPS(実績) で代用する（epsSrc:'actual'）。
// 2026-11-05 時点で 225銘柄中19銘柄が未公表（三菱UFJ・ソフトバンクG・キーエンス・キオクシア・中外製薬など＝時価総額の15%）。
//
// 225銘柄ぶんを1回の Function で取ると Cloudflare のサブリクエスト上限（無料50）を超えるため、
// クライアントが batch 単位（既定25銘柄）で呼び、手元で合算する（/api/price の40銘柄分割と同じ考え方）。
//
// GET /api/nkper?op=weights            → { date, n, rows:[{code, w}] }   （構成銘柄とウエートの一覧。確認用）
// GET /api/nkper?batch=0&size=25       → { date, batch, size, total, items:[{code, w, eps, epsSrc, price, per, mc, sh}] }
//     mc=時価総額（百万円）, sh=発行済株式数, w=指数ウエート（指数ベースの参考用）
//
// 出典: 日経平均プロフィル（日本経済新聞社）／Yahoo!ファイナンス
import { guardApi } from '../lib/api-guard.js';

const WEIGHT_URL = 'https://indexes.nikkei.co.jp/nkave/archives/file/nikkei_stock_average_weight_jp.csv';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'; // info.js と同じ（UA無しだと Yahoo!JP が 500 を返す）
const MAX_SIZE = 40;   // 1回のサブリクエスト数の上限（ウエートCSV1件＋銘柄ページ）

export async function onRequestGet(context) {
  const denied = await guardApi(context);
  if (denied) return denied;
  const url = new URL(context.request.url);
  try {
    const weights = await fetchWeights();
    if (url.searchParams.get('op') === 'weights') return json({ date: weights.date, n: weights.rows.length, rows: weights.rows });
    const size = Math.min(MAX_SIZE, Math.max(1, parseInt(url.searchParams.get('size') || '25', 10) || 25));
    const batch = Math.max(0, parseInt(url.searchParams.get('batch') || '0', 10) || 0);
    const rows = weights.rows.slice(batch * size, batch * size + size);
    const items = await Promise.all(rows.map(async (r) => {
      try {
        const q = await fetchYahooJp(r.code);
        return { code: r.code, w: r.w, eps: q.eps, epsSrc: q.epsSrc, price: q.price, per: q.per, mc: q.mc, sh: q.sh };
      } catch (e) {
        return { code: r.code, w: r.w, eps: null, epsSrc: null, price: null, per: null, mc: null, sh: null, error: String((e && e.message) || e) };
      }
    }));
    return json({ date: weights.date, batch, size, total: weights.rows.length, items, at: new Date().toISOString() });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502);
  }
}

// ---- 構成銘柄ウエート（日経の静的CSV・Shift_JIS） ----
// Workers の TextDecoder は Shift_JIS を扱えないが、必要なのは 日付・コード・ウエート（すべてASCII）だけなので
// latin1 として読んで正規表現で拾う（社名などの日本語部分は捨てる）。
// 行の例: "2026/10/30","1332","ニッスイ","水産","消費","0.0592%"
async function fetchWeights() {
  const res = await fetchWithTimeout(WEIGHT_URL, {
    headers: { 'User-Agent': 'securities-manager/1.0' },
    cf: { cacheTtl: 24 * 3600, cacheEverything: true },   // 月1回程度しか変わらない
  });
  if (!res.ok) throw new Error(`ウエートCSV HTTP ${res.status}`);
  const text = new TextDecoder('latin1').decode(await res.arrayBuffer());
  return parseWeights(text);
}
export function parseWeights(text) {
  const rows = [];
  let date = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^"(\d{4}\/\d{2}\/\d{2})","([0-9A-Z]{4})",.*"([\d.]+)%"\s*$/);
    if (!m) continue;
    const w = parseFloat(m[3]) / 100;
    if (!isFinite(w) || w <= 0) continue;
    date = m[1].replace(/\//g, '-');
    rows.push({ code: m[2], w });
  }
  if (!rows.length) throw new Error('ウエートCSVを読み取れませんでした');
  return { date, rows };
}

// ---- Yahoo!ファイナンス日本版（1銘柄）: EPS(会社予想)・前日終値・PER(会社予想)・時価総額(百万円)・発行済株式数 ----
// EPS(会社予想) が無い銘柄は 実績EPS ≒ ROE(実績)×BPS(実績)/100 で代用（epsSrc:'actual'）。両方無ければ null。
// 「参考指標」の各項目は _DataListItem__name の直後の _StyledNumber__value（info.js の jpRefMetric と同じ規則）。
async function fetchYahooJp(code) {
  const res = await fetchWithTimeout(`https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}.T`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`Yahoo!JP HTTP ${res.status}`);
  const html = await res.text();
  let eps = jpRefMetric(html, 'EPS'), epsSrc = eps != null ? 'forecast' : null;
  if (eps == null) {
    const roe = jpRefMetric(html, 'ROE'), bps = jpRefMetric(html, 'BPS');
    if (roe != null && bps != null) { eps = Math.round(roe * bps) / 100; epsSrc = 'actual'; }
  }
  return { eps, epsSrc, price: jpRefMetric(html, '前日終値'), per: jpRefMetric(html, 'PER'),
           mc: jpRefMetric(html, '時価総額'), sh: jpRefMetric(html, '発行済株式数') };
}
export function jpRefMetric(html, label) {
  const re = new RegExp('_DataListItem__name[^>]*>' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '<');
  const m = re.exec(html);
  if (!m) return null;
  const after = html.slice(m.index, m.index + 1400);
  // 赤字企業の EPS は「-123.45」のようにマイナス付き。符号も拾う（益回りをマイナスのまま合算するため）
  const vm = after.match(/_StyledNumber__value[^>]*>(-?[\d.,]+)</);
  if (!vm) return null;
  const v = parseFloat(vm[1].replace(/,/g, ''));
  return isFinite(v) ? v : null;
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
