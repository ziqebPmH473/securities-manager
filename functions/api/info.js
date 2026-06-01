// Cloudflare Pages Function: ティッカー情報取得プロキシ
// 単一:   GET /api/info?symbol=AAPL
// バッチ: GET /api/info?symbols=AAPL,7203.T,0131103C.T
//   → 単一: { name, sector, ... }  /  バッチ: { "AAPL": {...}, "7203.T": {...} }
//
// 取得戦略（Yahoo Finance v7 quote は認証必須で使用不可）:
//   日本株/投信: Yahoo!ファイナンス日本版（finance.yahoo.co.jp）から日本語名・基準価額を取得
//   米国株:     Yahoo Finance v8/chart（名前）+ v10/quoteSummary or Finnhub（ファンダ）
//   セクター/業種/ファンダ: v10/quoteSummary（取れれば）

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const single = (url.searchParams.get('symbol') || '').trim();
  const multi = (url.searchParams.get('symbols') || '').split(',').map(s => s.trim()).filter(Boolean);
  const finnhubKey = context.env?.FINNHUB_API_KEY;

  if (single) {
    try { return json(await fetchInfo(single, finnhubKey)); }
    catch (e) { return json({ error: String(e?.message || e) }, 500); }
  }
  if (multi.length) {
    const out = {};
    await Promise.all(multi.map(async (sym) => {
      try { out[sym] = await fetchInfo(sym, finnhubKey); }
      catch (e) { out[sym] = { error: String(e?.message || e) }; }
    }));
    return json(out);
  }
  return json({ error: 'symbol または symbols パラメータが必要です' }, 400);
}

function symbolType(sym) {
  if (sym.endsWith('.T') && /^[0-9A-Z]{8}\.T$/.test(sym)) return 'fund';
  if (sym.endsWith('.T')) return 'jp';
  return 'us';
}

async function fetchInfo(symbol, finnhubKey) {
  const type = symbolType(symbol);
  if (type === 'fund') return fetchFundInfo(symbol);
  if (type === 'jp')   return fetchJpInfo(symbol);
  return fetchUsInfo(symbol, finnhubKey);
}

// ---------- 日本株 ----------
async function fetchJpInfo(symbol) {
  // 日本語名は Yahoo!ファイナンス日本版から、ファンダは quoteSummary から
  const [jpName, chart, summary] = await Promise.all([
    fetchYahooJpName(symbol).catch(() => null),
    fetchChartMeta(symbol).catch(() => null),
    fetchQuoteSummary(symbol).catch(() => null),
  ]);
  return {
    name:      cleanName(jpName) || cleanName(chart?.name) || null,
    sector:    summary?.sector || null,
    industry:  summary?.industry || null,
    marketCap: summary?.marketCap ?? null,
    per:       summary?.per ?? null,
    eps:       summary?.eps ?? null,
    dividend:  summary?.dividend ?? null,
    sharesOut: summary?.sharesOut ?? null,
    currency:  chart?.currency || 'JPY',
    quoteType: chart?.instrumentType || null, // EQUITY/ETF/MUTUALFUND（詳細種別の判定に使用）
  };
}

// 銘柄名から法人格表記のみを省略（株式会社/(株)/㈱ / Inc. / Corporation / Co., Ltd. 等）
// Group/Holdings/Class などは社名の一部のことが多いので残す
function cleanName(name) {
  if (!name) return null;
  const orig = String(name).trim();
  let s = orig;
  // 日本語: 「株式会社」「(株)」「（株）」「㈱」を除去
  s = s.replace(/(株式会社|\(株\)|（株）|㈱)/g, '');
  // 英語の法人格サフィックスを末尾から最大2回除去（"Co., Ltd." 等の連結対応）
  const EN = /[,，]?\s*(Incorporated|Inc|Corporation|Corp|Company|Co|Limited|Ltd|P\.?L\.?C|LLC|N\.?V|S\.?A|A\.?G)\.?$/i;
  s = s.replace(EN, '').replace(EN, '');
  s = s.replace(/[\s,，・]+$/, '').trim();
  return s || orig;
}

// ---------- 米国株 ----------
async function fetchUsInfo(symbol, finnhubKey) {
  // 日本語名は Yahoo!ファイナンス日本版から（例: AAPL→アップル）、無ければ英語名(chart)
  const [jpName, chart, summary] = await Promise.all([
    fetchYahooJpName(symbol).catch(() => null),
    fetchChartMeta(symbol).catch(() => null),
    fetchQuoteSummary(symbol).catch(() => null),
  ]);
  let fh = null;
  if (finnhubKey && (!summary || summary.per == null)) {
    fh = await fetchFinnhubMetric(symbol, finnhubKey).catch(() => null);
  }
  return {
    name:      cleanName(jpName) || cleanName(chart?.name) || null,
    sector:    summary?.sector || null,
    industry:  summary?.industry || null,
    marketCap: summary?.marketCap ?? fh?.marketCap ?? null,
    per:       summary?.per ?? fh?.per ?? null,
    eps:       summary?.eps ?? fh?.eps ?? null,
    dividend:  summary?.dividend ?? fh?.dividend ?? null,
    sharesOut: summary?.sharesOut ?? null,
    currency:  chart?.currency || 'USD',
    quoteType: chart?.instrumentType || null, // EQUITY/ETF/MUTUALFUND（詳細種別の判定に使用）
  };
}

// ---------- 投資信託 ----------
async function fetchFundInfo(symbol) {
  const code = symbol.replace(/\.T$/, '');
  const d = await fetchYahooJpFund(code).catch(() => null);
  return {
    name:     d?.name || null,
    sector:   null, industry: null, marketCap: null,
    per: null, eps: null, dividend: null,
    currency: 'JPY',
    quoteType: 'MUTUALFUND',
    nav:      d?.nav ?? null, // 基準価額
  };
}

// ---------- 取得ヘルパー ----------
async function fetchWithTimeout(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// Yahoo!ファイナンス日本版（株式）から日本語の銘柄名を取得
async function fetchYahooJpName(symbol) {
  const res = await fetchWithTimeout(`https://finance.yahoo.co.jp/quote/${encodeURIComponent(symbol)}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja' },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!res.ok) return null;
  const html = await res.text();
  return extractJpName(html);
}

// Yahoo!ファイナンス日本版（投信）から名称・基準価額を取得
async function fetchYahooJpFund(code) {
  const res = await fetchWithTimeout(`https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const name = extractJpName(html);
  // 基準価額: og:description や本文から「基準価額 12,345円」を拾う（best-effort）
  let nav = null;
  const m = html.match(/基準価額[^0-9]{0,8}([0-9,]+)\s*円/);
  if (m) { const v = parseFloat(m[1].replace(/,/g, '')); if (isFinite(v)) nav = v; }
  return { name, nav };
}

// HTMLの<title>等から銘柄名を抽出（「トヨタ自動車(株)【7203】…」→「トヨタ自動車(株)」）
function extractJpName(html) {
  // og:title 優先
  let m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  let title = m ? m[1] : null;
  if (!title) {
    m = html.match(/<title>([^<]+)<\/title>/i);
    title = m ? m[1] : null;
  }
  if (!title) return null;
  // 【コード】や ：、- 以降を除去
  let name = title.split(/[【\[]/)[0].split(/[：:]/)[0].split(' - ')[0].trim();
  return name || null;
}

async function fetchChartMeta(symbol) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const res = await fetchWithTimeout(u, { headers: { 'User-Agent': 'securities-manager/1.0' }, cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw new Error(`chart ${res.status}`);
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('chart データなし');
  return { name: meta.longName || meta.shortName || null, currency: meta.currency || null, instrumentType: meta.instrumentType || null };
}

async function fetchQuoteSummary(symbol) {
  const u = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=assetProfile,summaryDetail,defaultKeyStatistics`;
  let res;
  try { res = await fetchWithTimeout(u, { headers: { 'User-Agent': 'securities-manager/1.0' }, cf: { cacheTtl: 3600, cacheEverything: true } }); }
  catch { return null; }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || data?.quoteSummary?.error) return null;
  const r = data?.quoteSummary?.result?.[0];
  if (!r) return null;
  const ap = r.assetProfile || {}, sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {};
  return {
    sector: ap.sector || null,
    industry: ap.industry || null,
    marketCap: n(sd.marketCap) ? Math.round(sd.marketCap.raw / 1e6) : (n(ks.marketCap) ? Math.round(ks.marketCap.raw / 1e6) : null),
    per: n(sd.trailingPE) ? sd.trailingPE.raw : (n(ks.trailingPE) ? ks.trailingPE.raw : null),
    eps: n(ks.trailingEps) ? ks.trailingEps.raw : null,
    dividend: n(sd.dividendRate) ? sd.dividendRate.raw : null,
    sharesOut: n(ks.sharesOutstanding) ? ks.sharesOutstanding.raw : null, // 発行済株式数（時価総額=株価×これ で随時算出）
  };
}

async function fetchFinnhubMetric(symbol, token) {
  let res;
  try { res = await fetchWithTimeout(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${token}`, { headers: { 'User-Agent': 'securities-manager/1.0' } }); }
  catch { return null; }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const m = data?.metric || {};
  return {
    marketCap: num(m.marketCapitalization),
    per: num(m['peBasicExclExtraTTM']) || num(m['peTTM']),
    eps: num(m['epsBasicExclExtraItemsTTM']),
    dividend: num(m['dividendPerShareAnnual']),
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
