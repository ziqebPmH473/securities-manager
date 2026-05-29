// Cloudflare Pages Function: 価格取得プロキシ
// ブラウザから直接 Yahoo Finance を叩くと CORS で失敗するため、ここで中継する。
// GET /api/price?symbols=AAPL,7203.T,USDJPY=X
//   → { "AAPL": { price, prevClose, high5y, high52w, currency }, ... }
//
// 設計上の位置づけ: 価格・為替は「アプリ側キャッシュ」に置く一時データ。
// このプロキシはその取得元（Yahoo, 15〜20分遅延）。将来 Finnhub(米株ほぼRT)も追加可能。

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const symbols = (url.searchParams.get('symbols') || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (symbols.length === 0) {
    return json({ error: 'symbols パラメータが必要です' }, 400);
  }

  const out = {};
  await Promise.all(symbols.map(async (sym) => {
    try {
      out[sym] = await fetchOne(sym);
    } catch (e) {
      out[sym] = { error: String(e && e.message || e) };
    }
  }));

  return json(out);
}

async function fetchOne(symbol) {
  // 週足5年分を取得し、現在値・前日終値・5年高値・52週高値を算出
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1wk`;
  const res = await fetch(u, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; securities-manager/1.0)' },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const data = await res.json();
  const r = data && data.chart && data.chart.result && data.chart.result[0];
  if (!r) throw new Error('データなし');

  const meta = r.meta || {};
  const highs = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].high) || [];
  let high5y = 0;
  for (const h of highs) { if (typeof h === 'number' && h > high5y) high5y = h; }

  return {
    price: num(meta.regularMarketPrice),
    prevClose: num(meta.chartPreviousClose ?? meta.previousClose),
    high5y: high5y || num(meta.fiftyTwoWeekHigh),
    high52w: num(meta.fiftyTwoWeekHigh),
    currency: meta.currency || null,
    fetchedAt: new Date().toISOString(),
  };
}

function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

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
