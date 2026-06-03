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

  // mode=light: 指数・為替など「現在値と前日比だけ」必要な軽量取得。
  //   5年分の日足を取らず短期間(range既定5d)だけ取得し、Finnhub経由も避けて高速化する。
  const mode = url.searchParams.get('mode');
  const range = url.searchParams.get('range') || (mode === 'light' ? '5d' : null);

  const finnhubKey = context.env && context.env.FINNHUB_API_KEY;
  const out = {};
  await Promise.all(symbols.map(async (sym) => {
    try {
      out[sym] = await fetchOne(sym, finnhubKey, { mode, range });
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

async function fetchOne(symbol, finnhubKey, opts = {}) {
  const type = symbolType(symbol);
  // 軽量モード: 高値不要・短期間のみ。Finnhub経由(米株3往復)を避けYahooの短期間取得に統一して高速化
  if (opts.mode === 'light') return fetchYahoo(symbol, type, opts.range || '5d');
  if (type === 'us' && finnhubKey) return fetchFinnhub(symbol, finnhubKey);
  return fetchYahoo(symbol, type, opts.range);
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
  const q = quoteRes.ok ? await quoteRes.json().catch(() => ({})) : {};
  const metric = metricRes.ok ? (await metricRes.json().catch(() => ({}))).metric || {} : {};

  // 5年高値: Finnhub の metric には 52w high があるが 5y は無いため、直近 52w high を採用
  // より正確な5年高値は Yahoo で補完取得（失敗してもフォールバック）。高値の日付も取得（高値更新判定用）
  let high5y = num(metric['52WeekHigh']);
  let high5yDate = null, high52wDate = null, yq = null;
  try {
    yq = await fetchYahooChart(symbol, '5y', '1mo');
    if (yq.high5y > 0) { high5y = yq.high5y; high5yDate = yq.high5yDate; }
    high52wDate = yq.high52wDate;
  } catch (_) { /* Yahoo5y失敗→Finnhubの52w highで代用（日付は不明） */ }

  // 価格: Finnhub が値を返さない銘柄（例: LDOS で c=0/null）は Yahoo にフォールバック
  let price = num(q.c), prevClose = num(q.pc), source = 'finnhub';
  if ((price == null || price === 0) && yq && yq.price != null) {
    price = yq.price; prevClose = yq.prevClose ?? prevClose; source = 'yahoo(fallback)';
  }
  // それでも取れなければ日足で再取得（5y/1mo で価格が空のケースの保険）
  if (price == null) {
    try { const y2 = await fetchYahooChart(symbol, '1mo', '1d'); if (y2.price != null) { price = y2.price; prevClose = y2.prevClose ?? prevClose; source = 'yahoo(fallback)'; } } catch (_) {}
  }

  return {
    price,
    prevClose,
    high5y: high5y || (yq && yq.high5y) || null,
    high52w:  num(metric['52WeekHigh']) || (yq && yq.high52w) || null,
    high5yDate,
    high52wDate,
    currency: 'USD',
    source,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------- Yahoo Finance ----------
async function fetchYahoo(symbol, type, rangeOverride) {
  const range = rangeOverride || (type === 'fund' ? '1y' : '5y');
  // 日足で取得する。週足だと chartPreviousClose が「前週終値」になり前日比が壊れるため。
  // 前日終値は日足の終値配列の最後から2番目を使う（下記 fetchYahooChart）。
  const interval = '1d';
  const q = await fetchYahooChart(symbol, range, interval);
  return {
    price:    q.price,
    prevClose: q.prevClose,
    high5y:   type === 'fund' ? null : q.high5y,   // 投信は高値不要（判定対象外）
    high52w:  q.high52w,
    high5yDate:  type === 'fund' ? null : q.high5yDate,   // 高値が付いた日（高値更新判定用）
    high52wDate: type === 'fund' ? null : q.high52wDate,
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

  // 52週高値（直近52週の最大値）。高値が付いた日付も記録（高値更新判定で「前回購入後に高値更新したか」を見るため）
  const now = Date.now() / 1000;
  const ts = r.timestamp || [];
  const yr52 = 52 * 7 * 24 * 3600;
  let high52w = 0, high5y = 0, high5yTs = null, high52wTs = null;
  highs.forEach((h, i) => {
    if (typeof h !== 'number') return;
    if (h > high5y) { high5y = h; high5yTs = ts[i] || null; }
    if (ts[i] && (now - ts[i]) < yr52 && h > high52w) { high52w = h; high52wTs = ts[i]; }
  });
  const toDate = (t) => (typeof t === 'number') ? new Date(t * 1000).toISOString().slice(0, 10) : null;

  // 現在値: regularMarketPrice が空なら終値配列の最後（当日 or 直近）で補完（取得漏れ防止）
  const price = num(meta.regularMarketPrice) ?? (closes.length ? closes[closes.length - 1] : null);
  return {
    price,
    prevClose: num(prevClose),
    high5y:   high5y || num(meta.fiftyTwoWeekHigh),
    high52w:  high52w || num(meta.fiftyTwoWeekHigh),
    high5yDate:  toDate(high5yTs),   // 5年高値が付いた日（YYYY-MM-DD）
    high52wDate: toDate(high52wTs),  // 52週高値が付いた日
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
