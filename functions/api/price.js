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
  // highs=1 の時だけ5年/52週高値を取得（Yahoo追加呼び出し）。通常の価格更新は price のみ＝1銘柄1呼び出しに抑え、
  // Cloudflareの「1リクエストあたりサブリクエスト上限(約50)」超過で多数銘柄が失敗する問題を防ぐ。
  const withHighs = url.searchParams.get('highs') === '1';

  const finnhubKey = context.env && context.env.FINNHUB_API_KEY;
  const out = {};
  await Promise.all(symbols.map(async (sym) => {
    try {
      out[sym] = await fetchOne(sym, finnhubKey, { mode, range, withHighs });
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
  if (opts.mode === 'light') return fetchYahoo(symbol, type, opts.range || '5d', false);
  if (type === 'us' && finnhubKey) return fetchFinnhub(symbol, finnhubKey, opts.withHighs);
  return fetchYahoo(symbol, type, opts.range, opts.withHighs);
}

// ---------- Finnhub（米株ほぼリアルタイム） ----------
// 通常(withHighs=false): Finnhub quote の1呼び出しのみ（サブリクエスト節約）。
// withHighs=true: 5年/52週高値のため Yahoo を1回だけ追加（計2呼び出し）。metric呼び出しは廃止。
async function fetchFinnhub(symbol, token, withHighs) {
  const quoteRes = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${token}`, {
    headers: { 'User-Agent': 'securities-manager/1.0' },
  });
  const q = quoteRes.ok ? await quoteRes.json().catch(() => ({})) : {};

  let high5y = null, high52w = null, high5yDate = null, high52wDate = null, yq = null;
  // 高値が必要な時のみ Yahoo を追加（高値は日中ほぼ不変なので毎回は取らない）
  if (withHighs) {
    try {
      yq = await fetchYahooChart(symbol, '5y', '1mo');
      high5y = yq.high5y || null; high52w = yq.high52w || null;
      high5yDate = yq.high5yDate; high52wDate = yq.high52wDate;
    } catch (_) { /* 失敗時は高値なし（クライアントが既存値を保持） */ }
  }

  // 価格: Finnhub が値を返さない銘柄（例: LDOS で c=0/null）は Yahoo にフォールバック（1呼び出し）
  let price = num(q.c), prevClose = num(q.pc), source = 'finnhub';
  if (price == null || price === 0) {
    if (yq && yq.price != null) { price = yq.price; prevClose = yq.prevClose ?? prevClose; source = 'yahoo(fallback)'; }
    else {
      try { const y2 = await fetchYahooChart(symbol, '1mo', '1d'); if (y2.price != null) { price = y2.price; prevClose = y2.prevClose ?? prevClose; source = 'yahoo(fallback)'; if (high5y == null && y2.high5y) high5y = y2.high5y; } } catch (_) {}
    }
  }

  return { price, prevClose, high5y, high52w, high5yDate, high52wDate, currency: 'USD', source, fetchedAt: new Date().toISOString() };
}

// ---------- Yahoo Finance ----------
// Finnhubキー無しの米株・日本株はこちら（1呼び出し）。withHighs=false の通常更新は短期間取得で軽く（高値はnull→クライアントが既存値保持）。
async function fetchYahoo(symbol, type, rangeOverride, withHighs) {
  // 高値が必要な時だけ長期間(5y/1y)。通常は短期間(1mo)で価格・前日比のみ。
  const range = rangeOverride || (type === 'fund' ? '1y' : (withHighs ? '5y' : '1mo'));
  // 日足で取得する。週足だと chartPreviousClose が「前週終値」になり前日比が壊れるため。
  // 前日終値は日足の終値配列の最後から2番目を使う（下記 fetchYahooChart）。
  const interval = '1d';
  const q = await fetchYahooChart(symbol, range, interval);
  const wantHighs = withHighs && type !== 'fund';
  return {
    price:    q.price,
    prevClose: q.prevClose,
    high5y:   wantHighs ? q.high5y : null,   // 通常更新では高値を返さない（クライアントが既存値を保持）
    high52w:  wantHighs ? q.high52w : null,
    high5yDate:  wantHighs ? q.high5yDate : null,   // 高値が付いた日（高値更新判定用）
    high52wDate: wantHighs ? q.high52wDate : null,
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
