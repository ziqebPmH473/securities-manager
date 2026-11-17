// Cloudflare Pages Function: マーケットのランキング取得
// GET /api/ranking?market=US|JP&kind=turnover|marketcap|gainers|losers&sub=all|prime|standard|growth|nikkei&count=20
//   → { items: [{ code, name, price, changePct, prevClose, value, volume, marketCap, market }], kind, market, source }
import { rankJp, JP_TYPE, JP_MARKET, cleanName } from '../lib/jp-ranking.js';
// 1リクエストで上位N件＋株価・前日比がまとめて返るため、銘柄ごとのAPI呼び出しは不要（制限に優しい）。

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const market = (url.searchParams.get('market') || 'US').toUpperCase();
  const kind = url.searchParams.get('kind') || 'turnover';
  const sub = url.searchParams.get('sub') || 'all';
  const count = Math.min(50, Math.max(1, parseInt(url.searchParams.get('count') || '20', 10)));
  // デバッグ: 日本株の __NEXT_DATA__ 構造を確認（ランキング配列のパス特定用）
  if (url.searchParams.get('debug') === '1' && market === 'JP') {
    try { return json(await debugJp(JP_TYPE[kind] || 'marketCapitalHigh', JP_MARKET[sub] || 'tokyoAll')); }
    catch (e) { return json({ error: String(e && e.message || e) }); }
  }
  try {
    const items = market === 'JP' ? await rankJp(kind, sub, count) : await rankUs(kind, count);
    return json({ market, kind, sub, items, source: market === 'JP' ? 'yahoo-jp' : 'yahoo-screener' });
  } catch (e) {
    return json({ market, kind, sub, items: [], error: String(e && e.message || e) }, 200);
  }
}

// ---------- 米国株（Yahoo predefined screener。認証不要） ----------
const US_SCR = { turnover: 'most_actives', marketcap: 'most_actives', gainers: 'day_gainers', losers: 'day_losers' };
async function rankUs(kind, count) {
  const scr = US_SCR[kind] || 'most_actives';
  // 売買代金/時価総額は並べ替えのため多めに取得
  const fetchN = (kind === 'turnover' || kind === 'marketcap') ? 100 : Math.max(count, 25);
  const u = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=${fetchN}&scrIds=${scr}`;
  const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; securities-manager/1.0)' }, cf: { cacheTtl: 120, cacheEverything: true } });
  if (!res.ok) throw new Error(`screener ${res.status}`);
  const data = await res.json();
  const quotes = (data && data.finance && data.finance.result && data.finance.result[0] && data.finance.result[0].quotes) || [];
  let items = quotes.filter(q => q && q.symbol).map(q => {
    const price = num(q.regularMarketPrice), vol = num(q.regularMarketVolume), mc = num(q.marketCap);
    // 配当は同じレスポンスに含まれる（追加取得ゼロ）。yieldは小数(0.0518)なので%へ。
    // 表示通貨(currency)と財務通貨(financialCurrency)が違うADR(ITUB/BBD/SKHY等)は
    // 配当がBRL/KRW建てなのに株価がUSDで、Yahooのyield自体が壊れる(39%/1912%)。この場合は載せない。
    const divOk = !(q.currency && q.financialCurrency && q.currency !== q.financialCurrency);
    const dy = divOk ? num(q.trailingAnnualDividendYield) : null;
    return {
      code: q.symbol,
      name: cleanName(q.shortName || q.longName || q.symbol),
      price, changePct: num(q.regularMarketChangePercent),
      prevClose: num(q.regularMarketPreviousClose),
      volume: vol, marketCap: mc,
      turnover: (price != null && vol != null) ? price * vol : null, // 売買代金=価格×出来高
      dividend: divOk ? num(q.trailingAnnualDividendRate) : null,
      divYield: dy != null ? dy * 100 : null,
      exchange: q.fullExchangeName || q.exchange || null,
      market: 'US',
    };
  });
  if (kind === 'turnover') items.sort((a, b) => (b.turnover || 0) - (a.turnover || 0));
  else if (kind === 'marketcap') items.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
  // gainers/losers は screener が並べ替え済み
  return items.slice(0, count);
}

// デバッグ: ページHTTP状況と __NEXT_DATA__ の構造サンプルを返す（ランキング配列のキー/パス特定用）
async function debugJp(type, mk) {
  const u = `https://finance.yahoo.co.jp/stocks/ranking/${type}?market=${mk || 'tokyoAll'}&term=daily`;
  const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', 'Accept-Language': 'ja' } });
  const out = { url: u, status: res.status };
  if (!res.ok) return out;
  const html = await res.text();
  out.htmlLen = html.length;
  out.hasNextData = html.includes('__NEXT_DATA__');
  out.hasPreloaded = html.includes('__PRELOADED_STATE__');
  out.quoteLinkCount = (html.match(/\/quote\/\d{4}\.T/g) || []).length;
  // 市場区分テキストが行ごとにあるか（市場列を各銘柄の区分にできるか判定）
  out.primeCount = (html.match(/プライム/g) || []).length;
  out.standardCount = (html.match(/スタンダード/g) || []).length;
  out.growthCount = (html.match(/グロース/g) || []).length;
  // 最初の銘柄リンク周辺のHTMLを返す（行構造を見て解析を書くため）
  const idx = html.search(/\/quote\/\d{4}\.T/);
  out.snippetAroundFirstQuote = idx >= 0 ? html.slice(Math.max(0, idx - 250), idx + 2600) : null;
  // 強調セル（ランキング指標=売買代金/時価総額）の中身を確認
  const hi = idx >= 0 ? html.indexOf('detail--highlight', idx) : -1;
  out.highlightSnippet = hi >= 0 ? html.slice(hi, hi + 350) : null;
  return out;
}

function num(v) { if (typeof v === 'number' && isFinite(v)) return v; if (typeof v === 'string') { const n = parseFloat(v.replace(/[,，円%\s]/g, '')); return isFinite(n) ? n : null; } return null; }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
}
