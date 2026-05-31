// Cloudflare Pages Function: 価格履歴（終値の時系列）取得プロキシ
// GET /api/history?symbol=AAPL&range=2y&interval=1wk
//   → { symbol, points:[[unixSec, close], ...], meta:{ price, currency } }
//
// 銘柄詳細画面のチャート用。Yahoo Finance chart の終値配列を返す。

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const symbol = (url.searchParams.get('symbol') || '').trim();
  const range = url.searchParams.get('range') || '2y';
  const interval = url.searchParams.get('interval') || '1wk';
  if (!symbol) return json({ error: 'symbol パラメータが必要です' }, 400);
  try {
    const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
    const res = await fetchWithTimeout(u, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; securities-manager/1.0)' },
      cf: { cacheTtl: 600, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`Yahoo ${res.status}`);
    const data = await res.json();
    const r = data && data.chart && data.chart.result && data.chart.result[0];
    if (!r) throw new Error('データなし');
    const ts = r.timestamp || [];
    const closes = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
    const points = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (typeof c === 'number' && isFinite(c)) points.push([ts[i], c]);
    }
    const meta = r.meta || {};
    return json({ symbol, points, meta: { price: num(meta.regularMarketPrice), currency: meta.currency || null } });
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 502);
  }
}

function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

async function fetchWithTimeout(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
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
