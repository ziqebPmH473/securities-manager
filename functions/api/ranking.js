// Cloudflare Pages Function: マーケットのランキング取得
// GET /api/ranking?market=US|JP&kind=turnover|marketcap|gainers|losers&sub=all|prime|standard|growth|nikkei&count=20
//   → { items: [{ code, name, price, changePct, prevClose, value, volume, marketCap, market }], kind, market, source }
// 1リクエストで上位N件＋株価・前日比がまとめて返るため、銘柄ごとのAPI呼び出しは不要（制限に優しい）。

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const market = (url.searchParams.get('market') || 'US').toUpperCase();
  const kind = url.searchParams.get('kind') || 'turnover';
  const sub = url.searchParams.get('sub') || 'all';
  const count = Math.min(50, Math.max(1, parseInt(url.searchParams.get('count') || '20', 10)));
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
    return {
      code: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price, changePct: num(q.regularMarketChangePercent),
      prevClose: num(q.regularMarketPreviousClose),
      volume: vol, marketCap: mc,
      value: kind === 'marketcap' ? mc : (price != null && vol != null ? price * vol : null), // 売買代金=価格×出来高
      market: 'US',
    };
  });
  if (kind === 'turnover') items.sort((a, b) => (b.value || 0) - (a.value || 0));
  else if (kind === 'marketcap') items.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
  // gainers/losers は screener が並べ替え済み
  return items.slice(0, count);
}

// ---------- 日本株（Yahoo!ファイナンス日本版ランキングを解析） ----------
// term=daily, type に応じたランキング。__NEXT_DATA__(JSON) からリストを抽出する。
const JP_TYPE = { turnover: 'tradingValue', marketcap: 'marketCapHigh', gainers: 'up', losers: 'down' };
const JP_MARKET = { all: 'all', prime: 'tokyoPrime', standard: 'tokyoStandard', growth: 'tokyoGrowth', nikkei: 'nikkei225' };
async function rankJp(kind, sub, count) {
  const type = JP_TYPE[kind] || 'tradingValue';
  const mk = JP_MARKET[sub] || 'all';
  const u = `https://finance.yahoo.co.jp/stocks/ranking/${type}?market=${mk}&term=daily`;
  const res = await fetch(u, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', 'Accept-Language': 'ja' },
    cf: { cacheTtl: 120, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`yahoo-jp ${res.status}`);
  const html = await res.text();
  // __NEXT_DATA__ のJSONを抽出
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('NEXT_DATA なし');
  let nd; try { nd = JSON.parse(m[1]); } catch (_) { throw new Error('NEXT_DATA parse失敗'); }
  // ランキング配列を深さ優先で探索（code/price 等を持つ配列を見つける）
  const list = findRankingArray(nd);
  if (!list) throw new Error('ランキング配列なし');
  const items = list.slice(0, count).map(r => normalizeJpRow(r)).filter(Boolean);
  return items;
}
// JSONを再帰探索し、銘柄ランキングらしき配列を返す
function findRankingArray(obj, depth = 0) {
  if (!obj || depth > 8) return null;
  if (Array.isArray(obj)) {
    if (obj.length >= 3 && obj.every(x => x && typeof x === 'object') &&
        obj.some(x => (x.code || x.symbol || x.stockCode) && (x.price != null || x.regularMarketPrice != null || x.tradingValue != null || x.marketCap != null))) {
      return obj;
    }
    for (const v of obj) { const r = findRankingArray(v, depth + 1); if (r) return r; }
    return null;
  }
  if (typeof obj === 'object') {
    for (const k in obj) { const r = findRankingArray(obj[k], depth + 1); if (r) return r; }
  }
  return null;
}
function normalizeJpRow(r) {
  const code = String(r.code || r.symbol || r.stockCode || '').replace(/\.T$/, '').trim();
  if (!/^[0-9A-Za-z]{4}$/.test(code)) return null;
  const price = num(r.price ?? r.regularMarketPrice ?? r.lastPrice);
  return {
    code, name: r.name || r.shortName || r.stockName || code,
    price, changePct: num(r.changeRate ?? r.regularMarketChangePercent ?? r.priceChangeRate),
    prevClose: num(r.previousPrice ?? r.regularMarketPreviousClose),
    volume: num(r.volume ?? r.regularMarketVolume),
    marketCap: num(r.marketCap ?? r.totalPrice),
    value: num(r.tradingValue ?? r.marketCap ?? r.totalPrice) ?? (price != null && r.volume ? price * num(r.volume) : null),
    market: 'JP',
  };
}

function num(v) { if (typeof v === 'number' && isFinite(v)) return v; if (typeof v === 'string') { const n = parseFloat(v.replace(/[,，円%\s]/g, '')); return isFinite(n) ? n : null; } return null; }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
}
