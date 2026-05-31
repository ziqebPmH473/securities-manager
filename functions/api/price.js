// Cloudflare Pages Function: 価格取得プロキシ
// GET /api/price?symbols=AAPL,7203.T,0131103C.T,USDJPY=X
//   → { "AAPL": { price, prevClose, high5y, high52w, currency, source }, ... }
//
// 優先度:
//   US株/ETF: FINNHUB_API_KEY が設定されていれば Finnhub（ほぼリアルタイム）、なければ Yahoo
//   JP株・投信: Yahoo Finance（15〜20分遅延。投信は日次基準価額）
//   為替(USDJPY=X): Yahoo

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const symbols = (url.searchParams.get('symbols') || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (symbols.length === 0) return json({ error: 'symbols パラメータが必要です' }, 400);

  const finnhubKey = context.env && context.env.FINNHUB_API_KEY;
  const out = {};
  await Promise.all(symbols.map(async (sym) => {
    try {
      out[sym] = await fetchOne(sym, finnhubKey);
    } catch (e) {
      out[sym] = { error: String(e && e.message || e) };
    }
  }));
  return json(out);
}

// シンボルの種別を判定
function symbolType(sym) {
  if (sym === 'USDJPY=X') return 'fx';
  // 投信: 8桁英数字.T（例: 0131103C.T）
  if (sym.endsWith('.T') && /^[0-9A-Z]{8}\.T$/.test(sym)) return 'fund';
  // 日本株: 4桁数字.T（例: 7203.T）
  if (sym.endsWith('.T') && /^\d{4}\.T$/.test(sym)) return 'jp';
  // 日本株（その他 .T 付き）
  if (sym.endsWith('.T')) return 'jp';
  return 'us';
}

async function fetchOne(symbol, finnhubKey) {
  const type = symbolType(symbol);
  if (type === 'us' && finnhubKey) return fetchFinnhub(symbol, finnhubKey);
  return fetchYahoo(symbol, type);
}

// ---------- Finnhub（米株ほぼリアルタイム） ----------
async function fetchFinnhub(symbol, token) {
  const [quoteRes, metricRes] = await Promise.all([
    fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${token}`, {
      headers: { 'User-Agent': 'securities-manager/1.0' },
    }),
    fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${token}`, {
      headers: { 'User-Agent': 'securities-manager/1.0' },
    }),
  ]);
  if (!quoteRes.ok) throw new Error(`Finnhub quote ${quoteRes.status}`);
  const q = await quoteRes.json();
  const metric = metricRes.ok ? (await metricRes.json()).metric || {} : {};

  // 5年高値: Finnhub の metric には 52w high があるが 5y は無いため、直近 52w high を採用
  // より正確な5年高値は Yahoo で補完取得（失敗してもフォールバック）
  let high5y = num(metric['52WeekHigh']);
  try {
    const yq = await fetchYahooChart(symbol, '5y', '1mo');
    const highs = yq.highs || [];
    let maxH = 0;
    for (const h of highs) if (h > maxH) maxH = h;
    if (maxH > 0) high5y = maxH;
  } catch (_) { /* Yahoo5y失敗→Finnhubの52w highで代用 */ }

  return {
    price:    num(q.c),
    prevClose: num(q.pc),
    high5y,
    high52w:  num(metric['52WeekHigh']),
    currency: 'USD',
    source:   'finnhub',
    fetchedAt: new Date().toISOString(),
  };
}

// ---------- Yahoo Finance ----------
async function fetchYahoo(symbol, type) {
  const range = type === 'fund' ? '1y' : '5y';
  // 日足で取得する。週足だと chartPreviousClose が「前週終値」になり前日比が壊れるため。
  // 前日終値は日足の終値配列の最後から2番目を使う（下記 fetchYahooChart）。
  const interval = '1d';
  const q = await fetchYahooChart(symbol, range, interval);
  return {
    price:    q.price,
    prevClose: q.prevClose,
    high5y:   type === 'fund' ? null : q.high5y,   // 投信は高値不要（判定対象外）
    high52w:  q.high52w,
    currency: q.currency,
    source:   'yahoo',
    fundNav:  type === 'fund' ? q.price : null,     // 投信の場合は基準価額として扱う
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchYahooChart(symbol, range, interval) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(u, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; securities-manager/1.0)' },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status} (${symbol})`);
  const data = await res.json();
  const r = data && data.chart && data.chart.result && data.chart.result[0];
  if (!r) throw new Error('データなし');

  const meta = r.meta || {};
  const quotes = r.indicators && r.indicators.quote && r.indicators.quote[0];
  const highs = (quotes && quotes.high) || [];

  // 前日終値＝日足終値配列（null除外）の最後から2番目。
  // 場中は最後が当日partial／引け後は最後が当日確定で、いずれも len-2 が前営業日終値になる。
  const closes = ((quotes && quotes.close) || []).filter(c => typeof c === 'number');
  const prevClose = closes.length >= 2
    ? closes[closes.length - 2]
    : num(meta.regularMarketPreviousClose ?? meta.chartPreviousClose ?? meta.previousClose);

  // 52週高値（直近52週の最大値）
  const now = Date.now() / 1000;
  const ts = r.timestamp || [];
  const yr52 = 52 * 7 * 24 * 3600;
  let high52w = 0, high5y = 0;
  highs.forEach((h, i) => {
    if (typeof h !== 'number') return;
    if (h > high5y) high5y = h;
    if (ts[i] && (now - ts[i]) < yr52 && h > high52w) high52w = h;
  });

  return {
    price:    num(meta.regularMarketPrice),
    prevClose: num(prevClose),
    high5y:   high5y || num(meta.fiftyTwoWeekHigh),
    high52w:  high52w || num(meta.fiftyTwoWeekHigh),
    currency: meta.currency || null,
    highs,
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
