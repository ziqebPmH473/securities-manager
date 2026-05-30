// Cloudflare Pages Function: ティッカー情報取得プロキシ
// GET /api/info?symbol=AAPL  または  /api/info?symbol=7203.T
//   → { name, sector, industry, marketCap, per, eps, dividend, currency, exchange, error? }
//
// 取得戦略（Yahoo Finance v7 は認証必須となり使用不可）:
//   1. v8/chart        → 銘柄名・通貨（最も安定。価格取得と同じ経路）
//   2. v10/quoteSummary → セクター・業種・ファンダメンタル（取れれば）
//   3. Finnhub          → FINNHUB_API_KEY があればファンダを補完

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const symbol = (url.searchParams.get('symbol') || '').trim();
  if (!symbol) return json({ error: 'symbol パラメータが必要です' }, 400);

  const finnhubKey = context.env?.FINNHUB_API_KEY;

  try {
    const result = await fetchInfo(symbol, finnhubKey);
    return json(result);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
}

async function fetchInfo(symbol, finnhubKey) {
  // --- Step1: v8/chart で銘柄名・通貨を取得（確実） ---
  const chart = await fetchChartMeta(symbol).catch(() => null);

  // --- Step2: v10/quoteSummary でセクター・ファンダを取得（失敗しても続行） ---
  const summary = await fetchQuoteSummary(symbol).catch(() => null);

  // --- Step3: Finnhub でファンダを補完（APIキーがある US 株のみ） ---
  let finnhub = null;
  const isUS = !symbol.endsWith('.T');
  if (finnhubKey && isUS && (!summary || summary.per == null)) {
    finnhub = await fetchFinnhubMetric(symbol, finnhubKey).catch(() => null);
  }

  return {
    name:      chart?.name || summary?.name || null,
    sector:    summary?.sector || null,
    industry:  summary?.industry || null,
    marketCap: summary?.marketCap ?? finnhub?.marketCap ?? null,
    per:       summary?.per ?? finnhub?.per ?? null,
    eps:       summary?.eps ?? finnhub?.eps ?? null,
    dividend:  summary?.dividend ?? finnhub?.dividend ?? null,
    currency:  chart?.currency || null,
    exchange:  chart?.exchange || null,
  };
}

// タイムアウト付きfetch（ハング防止）
async function fetchWithTimeout(url, opts = {}, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally { clearTimeout(t); }
}

// v8/chart: 銘柄名・通貨（価格取得と同じ安定エンドポイント）
async function fetchChartMeta(symbol) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const res = await fetchWithTimeout(u, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; securities-manager/1.0)' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`chart ${res.status}`);
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('chart データなし');
  return {
    name:     meta.longName || meta.shortName || null,
    currency: meta.currency || null,
    exchange: meta.exchangeName || meta.fullExchangeName || null,
  };
}

// v10/quoteSummary: セクター・業種・ファンダメンタル
async function fetchQuoteSummary(symbol) {
  const modules = 'assetProfile,summaryDetail,defaultKeyStatistics';
  const u = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`;
  let res;
  try {
    res = await fetchWithTimeout(u, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; securities-manager/1.0)' },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
  } catch { return null; }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || data?.quoteSummary?.error) return null;
  const r = data?.quoteSummary?.result?.[0];
  if (!r) return null;

  const ap = r.assetProfile || {};
  const sd = r.summaryDetail || {};
  const ks = r.defaultKeyStatistics || {};

  return {
    sector:    ap.sector || null,
    industry:  ap.industry || null,
    marketCap: n(sd.marketCap) ? Math.round(sd.marketCap.raw / 1e6) : (n(ks.marketCap) ? Math.round(ks.marketCap.raw / 1e6) : null),
    per:       n(sd.trailingPE) ? sd.trailingPE.raw : (n(ks.trailingPE) ? ks.trailingPE.raw : null),
    eps:       n(ks.trailingEps) ? ks.trailingEps.raw : null,
    dividend:  n(sd.dividendRate) ? sd.dividendRate.raw : null,
  };
}

// Finnhub: ファンダメンタル補完（US株・APIキーあり時のみ）
async function fetchFinnhubMetric(symbol, token) {
  const u = `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${token}`;
  let res;
  try {
    res = await fetchWithTimeout(u, { headers: { 'User-Agent': 'securities-manager/1.0' } });
  } catch { return null; }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const m = data?.metric || {};
  return {
    marketCap: num(m.marketCapitalization),
    per:       num(m['peBasicExclExtraTTM']) || num(m['peTTM']),
    eps:       num(m['epsBasicExclExtraItemsTTM']),
    dividend:  num(m['dividendPerShareAnnual']),
  };
}

function n(obj) { return obj && typeof obj.raw === 'number' && isFinite(obj.raw); }
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
