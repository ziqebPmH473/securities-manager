// Cloudflare Pages Function: 決算日（前回/次回）取得
//   GET /api/earnings?symbols=AAPL,7203.T,6758.T  → { "AAPL": {next,nextEstimate,prev,exDiv}, ... }
// 次回決算日: Yahoo quoteSummary calendarEvents（crumb ハンドシェイクが必要）。日米とも取得可・isEarningsDateEstimate 付き。
// 前回決算日: 実際の開示発表日を使う。JP=TDnet(yanoshin) の「決算短信」/ US=SEC EDGAR の 10-Q/10-K/20-F/6-K の最新提出日。
//   ※ symbols は Yahoo 形式（日本株=コード.T、米国株=ティッカー）。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const syms = (url.searchParams.get('symbols') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
  if (!syms.length) return json({});
  let cr = null;
  try { cr = await getCrumb(); } catch (_) { cr = null; }
  const out = {};
  await Promise.all(syms.map(async (sym) => {
    const [next, prev] = await Promise.all([
      fetchNext(sym, cr).catch(() => null),
      fetchPrev(sym).catch(() => null),
    ]);
    out[sym] = {
      next: next ? next.date : null,
      nextEstimate: next ? !!next.estimate : null,
      exDiv: next ? next.exDiv : null,
      prev: prev ? prev.prev : null,
      prev2: prev ? prev.prev2 : null, // 直近2回目の決算日（決算間隔＝四半期/半期/通期の推定に使う）
    };
  }));
  return json(out);
}

// ---------- 次回決算日（Yahoo calendarEvents） ----------
let _crumbCache = null; // { cookie, crumb, at }
async function getCrumb() {
  if (_crumbCache && (Date.now() - _crumbCache.at) < 25 * 60 * 1000) return _crumbCache;
  // Cookie を取得（fc.yahoo.com は404を返すが Set-Cookie は付く。ダメなら query2 から）
  let cookie = '';
  for (const u of ['https://fc.yahoo.com/', 'https://query2.finance.yahoo.com/v10/finance/quoteSummary/AAPL']) {
    try {
      const r = await fetchGuard(u, 6000);
      const sc = r.headers.get('set-cookie');
      if (sc) { cookie = sc.split(';')[0]; if (cookie) break; }
    } catch (_) {}
  }
  const rc = await fetchGuard('https://query1.finance.yahoo.com/v1/test/getcrumb', 6000, { Cookie: cookie });
  const crumb = (await rc.text()).trim();
  if (!crumb || crumb.length > 40 || /[<{}]/.test(crumb)) throw new Error('crumb取得失敗');
  _crumbCache = { cookie, crumb, at: Date.now() };
  return _crumbCache;
}
async function fetchNext(symbol, cr) {
  if (!cr) return null;
  const u = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=calendarEvents&crumb=${encodeURIComponent(cr.crumb)}`;
  const r = await fetchGuard(u, 8000, { Cookie: cr.cookie });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  const ce = d && d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0] && d.quoteSummary.result[0].calendarEvents;
  const e = ce && ce.earnings;
  if (!e) return null;
  const arr = Array.isArray(e.earningsDate) ? e.earningsDate : [];
  const date = arr.length ? (arr[0].fmt || null) : null; // 'YYYY-MM-DD'
  const exDiv = ce.exDividendDate && ce.exDividendDate.fmt ? ce.exDividendDate.fmt : null;
  return { date, estimate: !!e.isEarningsDateEstimate, exDiv };
}

// ---------- 前回決算日（実際の発表日＝開示） ----------
async function fetchPrev(symbol) {
  if (/\.T$/i.test(symbol)) return prevJp(symbol.replace(/\.T$/i, ''));
  return prevUs(symbol);
}
// JP: TDnet の「決算短信」（四半期/通期）の直近2回の pubdate。業績修正・配当・自己株は除外して「決算そのもの」を拾う。
async function prevJp(code) {
  const c = String(code || '').trim();
  if (!/^[0-9A-Za-z]{4}$/.test(c)) return { prev: null, prev2: null };
  const u = `https://webapi.yanoshin.jp/webapi/tdnet/list/${encodeURIComponent(c)}.json?limit=30`;
  const r = await fetchGuard(u, 8000);
  if (!r.ok) return { prev: null, prev2: null };
  const data = await r.json().catch(() => null);
  const items = (data && data.items) || [];
  const dates = [];
  for (const w of items) {
    const t = w.Tdnet || w;
    const title = t.title || '';
    if (!/決算短信/.test(title) || /訂正/.test(title)) continue; // 決算短信のみ（訂正・業績修正・配当・月次は除外）
    const iso = isoOf(t.pubdate);
    if (iso) dates.push(iso.slice(0, 10));
  }
  return topTwo(dates);
}
// US: EDGAR の決算書類の直近2回の提出日。8-K/Form4 等が多い銘柄(例 MSFT)だと一括取得では決算書類が
// 取得窓の外に押し出されるため、決算に相当する書式を種別指定(type=)で直接引く。
// 10-Q/10-K（米国企業）＋ 6-K（外国企業ADR＝半期決算が多い）をカバー。各書式2件ずつ取り、新しい順に上位2つ。
async function prevUs(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z.\-]{1,8}$/.test(t)) return { prev: null, prev2: null };
  const forms = ['10-Q', '10-K', '6-K'];
  const per = await Promise.all(forms.map(f => edgarDates(t, f, 2).catch(() => [])));
  return topTwo([].concat(...per));
}
async function edgarDates(ticker, type, count) {
  const u = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(ticker)}&type=${encodeURIComponent(type)}&count=${count}&output=atom`;
  // SEC EDGAR は User-Agent に連絡先が必要。既存の disclosure.js と同じヘッダに合わせる。
  const r = await fetchGuard(u, 8000, { 'User-Agent': 'securities-manager/1.0 (contact: mutenka1000@gmail.com)', 'Accept': 'application/json, application/atom+xml, */*' });
  if (!r.ok) return [];
  const xml = await r.text();
  const out = []; const re = /<entry>([\s\S]*?)<\/entry>/g; let m;
  while ((m = re.exec(xml))) {
    const c = m[1];
    const form = (c.match(/term="([^"]+)"/) || [])[1] || (c.match(/<filing-type>([^<]+)<\/filing-type>/) || [])[1] || '';
    if (!form || form.replace(/\/A$/, '') !== type) continue; // 種別指定でも別書式が返ることがあるので照合
    const date = (c.match(/<filing-date>([^<]+)<\/filing-date>/) || [])[1] || (c.match(/<updated>([^<]+)<\/updated>/) || [])[1] || '';
    if (date) out.push(String(date).slice(0, 10));
  }
  return out;
}
// 日付配列から新しい順に上位2つ（重複除去）
function topTwo(dates) {
  const uniq = [...new Set((dates || []).filter(Boolean))].sort((a, b) => a < b ? 1 : -1);
  return { prev: uniq[0] || null, prev2: uniq[1] || null };
}

// ---------- 共通 ----------
async function fetchGuard(u, ms, extraHeaders) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*', ...(extraHeaders || {}) }, signal: ctrl.signal, cf: { cacheTtl: 0 } });
  } finally { clearTimeout(timer); }
}
// TDnet pubdate（"YYYY-MM-DD HH:MM:SS" JST）を ISO へ
function isoOf(s) {
  if (!s) return null;
  const str = String(s).trim();
  let d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) d = new Date(str + 'T00:00:00+09:00');
  else d = new Date(str.replace(' ', 'T') + '+09:00');
  return isNaN(d) ? null : d.toISOString();
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
