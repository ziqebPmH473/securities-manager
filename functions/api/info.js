// Cloudflare Pages Function: ティッカー情報取得プロキシ
// GET /api/info?symbol=AAPL  または  /api/info?symbol=7203.T
//   → { name, sector, industry, marketCap, per, eps, dividend, currency, longName, error? }
//
// Yahoo Finance quoteSummary を使い、銘柄名・セクター・業種・ファンダを返す。
// 価格は /api/price に任せ、ここは「銘柄の属性情報」専用。

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const symbol = (url.searchParams.get('symbol') || '').trim();

  if (!symbol) return json({ error: 'symbol パラメータが必要です' }, 400);

  try {
    const result = await fetchInfo(symbol);
    return json(result);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
}

async function fetchInfo(symbol) {
  const modules = 'assetProfile,summaryDetail,financialData,defaultKeyStatistics,quoteType';
  const u = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&lang=ja&region=JP`;
  const res = await fetch(u, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; securities-manager/1.0)' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const data = await res.json();
  const r = data && data.quoteSummary && data.quoteSummary.result && data.quoteSummary.result[0];
  if (!r) throw new Error('データなし');

  const qt  = r.quoteType || {};
  const ap  = r.assetProfile || {};
  const sd  = r.summaryDetail || {};
  const ks  = r.defaultKeyStatistics || {};
  const fd  = r.financialData || {};

  // 銘柄名: 日本語名 or 英語名
  const name = qt.longName || qt.shortName || '';

  // 時価総額: summaryDetail.marketCap → defaultKeyStatistics.marketCap の順で取得
  const marketCap = num(sd.marketCap && sd.marketCap.raw) || num(ks.marketCap && ks.marketCap.raw);

  return {
    name:       name || null,
    longName:   qt.longName || null,
    shortName:  qt.shortName || null,
    sector:     ap.sector || null,
    industry:   ap.industry || null,
    marketCap:  marketCap ? Math.round(marketCap / 1e6) : null, // → 百万単位
    per:        num(sd.trailingPE && sd.trailingPE.raw) || num(ks.trailingPE && ks.trailingPE.raw) || null,
    eps:        num(ks.trailingEps && ks.trailingEps.raw) || null,
    dividend:   num(sd.dividendRate && sd.dividendRate.raw) || null,
    currency:   sd.currency || qt.currency || null,
    exchange:   qt.exchange || null,
    quoteType:  qt.quoteType || null,
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
