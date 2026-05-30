// Cloudflare Pages Function: 株式分割・併合の取得プロキシ
// GET /api/splits?symbols=AAPL,7203.T
//   → { "AAPL": { splits:[{date:'YYYY-MM-DD', ratio, num, den, label}] }, ... }
//
// Yahoo Finance chart の events=split から、実施済みの分割/併合履歴を返す。
// ratio = numerator/denominator（1:5分割→5、5:1併合→0.2）。
// ※ 実施前（予告）の分割は安定して取得できないため、実施日以降のみ。

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const syms = (url.searchParams.get('symbols') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!syms.length) return json({ error: 'symbols パラメータが必要です' }, 400);
  const out = {};
  await Promise.all(syms.map(async (sym) => {
    try { out[sym] = await fetchSplits(sym); }
    catch (e) { out[sym] = { error: String(e && e.message || e) }; }
  }));
  return json(out);
}

async function fetchSplits(symbol) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1d&events=split`;
  const res = await fetchWithTimeout(u, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; securities-manager/1.0)' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const data = await res.json();
  const r = data && data.chart && data.chart.result && data.chart.result[0];
  const splitsObj = (r && r.events && r.events.splits) || {};
  const list = [];
  for (const k in splitsObj) {
    const s = splitsObj[k];
    const num = s.numerator, den = s.denominator;
    if (!num || !den) continue;
    const d = new Date((s.date || 0) * 1000);
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    list.push({ date, ratio: num / den, num, den, label: s.splitRatio || `${num}:${den}` });
  }
  list.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { splits: list };
}

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
