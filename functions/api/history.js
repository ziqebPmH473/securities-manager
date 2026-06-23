// Cloudflare Pages Function: 価格履歴の時系列取得プロキシ
// GET /api/history?symbol=AAPL&range=2y&interval=1wk
//   → { symbol, points:[[unixSec, close], ...], meta:{ price, currency } }   （従来＝終値のみ。チャート折れ線用）
// GET /api/history?symbol=AAPL&range=3y&interval=1d&format=ohlcv
//   → { symbol, bars:[{ t, o, h, l, c, v, adj }, ...], meta:{ price, currency } }  （ローソク足・テクニカル分析用）
//
// Yahoo Finance chart の配列を返す。format=ohlcv 指定時のみ OHLCV＋調整後終値を返す（後方互換）。

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const symbol = (url.searchParams.get('symbol') || '').trim();
  const range = url.searchParams.get('range') || '2y';
  const interval = url.searchParams.get('interval') || '1wk';
  const format = (url.searchParams.get('format') || '').trim();
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
    const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
    const meta = r.meta || {};
    const metaOut = { price: num(meta.regularMarketPrice), currency: meta.currency || null };

    if (format === 'ohlcv') {
      const opens = q.open || [], highs = q.high || [], lows = q.low || [], closes = q.close || [], vols = q.volume || [];
      const adj = (r.indicators && r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose) || [];
      const bars = [];
      for (let i = 0; i < ts.length; i++) {
        const o = opens[i], h = highs[i], l = lows[i], c = closes[i];
        // 終値が無い足（休場・未確定）はスキップ。OHLCのいずれか欠けは中立に終値で補完
        if (!(typeof c === 'number' && isFinite(c))) continue;
        bars.push({
          t: ts[i],
          o: num(o) != null ? o : c,
          h: num(h) != null ? h : c,
          l: num(l) != null ? l : c,
          c,
          v: num(vols[i]) != null ? vols[i] : 0,
          adj: num(adj[i]) != null ? adj[i] : c,
        });
      }
      return json({ symbol, bars, meta: metaOut });
    }

    const closes = q.close || [];
    const points = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (typeof c === 'number' && isFinite(c)) points.push([ts[i], c]);
    }
    return json({ symbol, points, meta: metaOut });
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
