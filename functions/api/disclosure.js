// Cloudflare Pages Function: 開示・決算（フェーズN4）
//   GET /api/disclosure?recent=1[&limit=100]     → TDnet直近の適時開示（日本株・全社）
//   GET /api/disclosure?market=JP&code=7203       → TDnet 銘柄別
//   GET /api/disclosure?market=US&ticker=AAPL      → SEC EDGAR 銘柄別（提出書類。form種別を日本語ラベル化）
// 返却: { items:[{ code, company, title, link, pubDate, form, market, kind }] }
//   kind: 'earnings'（決算/業績/配当）| 'disclosure'（その他開示）

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  try {
    if (url.searchParams.get('recent')) {
      const limit = Math.min(150, Math.max(10, parseInt(url.searchParams.get('limit') || '100', 10)));
      return json({ items: await tdnetRecent(limit) });
    }
    const market = (url.searchParams.get('market') || 'JP').toUpperCase();
    if (market === 'US') return json({ items: await edgar(url.searchParams.get('ticker')) });
    return json({ items: await tdnetByCode(url.searchParams.get('code')) });
  } catch (e) {
    return json({ items: [], error: String(e && e.message || e) }, 200);
  }
}

// ---------- TDnet（適時開示・yanoshin webapi。無料） ----------
async function tdnetRecent(limit) {
  const u = `https://webapi.yanoshin.jp/webapi/tdnet/list/recent.json?limit=${limit}`;
  return tdnetParse(await fetchJson(u, 8000));
}
async function tdnetByCode(code) {
  const c = String(code || '').trim();
  if (!/^[0-9A-Za-z]{4}$/.test(c)) return [];
  const u = `https://webapi.yanoshin.jp/webapi/tdnet/list/${encodeURIComponent(c)}.json?limit=20`;
  return tdnetParse(await fetchJson(u, 8000));
}
function tdnetParse(data) {
  const items = (data && data.items) || [];
  return items.map(w => {
    const t = w.Tdnet || w;
    const code5 = String(t.company_code || '');
    const code = code5.length >= 5 ? code5.slice(0, 4) : code5; // TDnetは5桁(末尾0)。4桁コードへ
    const title = t.title || '';
    return {
      code, company: t.company_name || '', title,
      link: t.document_url || '', pubDate: isoOf(t.pubdate),
      form: null, market: 'JP', kind: earningsKind(title),
    };
  }).filter(x => x.title && x.link);
}
function earningsKind(title) { return /決算|業績|配当|増配|減配|自己株|株式分割|剰余金/.test(title) ? 'earnings' : 'disclosure'; }

// ---------- SEC EDGAR（提出書類。form種別を日本語化） ----------
const EDGAR_FORM_JP = {
  '10-K': '年次報告書 (10-K)', '10-Q': '四半期報告書 (10-Q)', '8-K': '重要事象の報告 (8-K)',
  '20-F': '外国企業 年次報告 (20-F)', '6-K': '外国企業 臨時報告 (6-K)', '40-F': '年次報告 (40-F)',
  'DEF 14A': '株主総会招集通知 (DEF 14A)', 'S-1': '新規上場登録 (S-1)', 'S-3': '登録届出 (S-3)',
  '424B': '目論見書 (424B)', '4': '内部者取引報告 (Form 4)', '3': '内部者 初回報告 (Form 3)',
  '5': '内部者 年次報告 (Form 5)', 'SC 13D': '大量保有報告 (13D)', 'SC 13G': '大量保有報告 (13G)',
  '13F-HR': '機関投資家 保有報告 (13F)', 'FWP': '目論見書関連 (FWP)', '11-K': '従業員持株報告 (11-K)',
};
function edgarFormJp(f) {
  if (!f) return '提出書類';
  if (EDGAR_FORM_JP[f]) return EDGAR_FORM_JP[f];
  const base = f.replace(/\/A$/, ''); // 訂正版(/A)
  return (EDGAR_FORM_JP[base] ? EDGAR_FORM_JP[base].replace(/\)$/, '・訂正)') : `提出書類 (${f})`);
}
async function edgar(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z.\-]{1,8}$/.test(t)) return [];
  const u = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(t)}&type=&count=60&output=atom`;
  const xml = await fetchText(u, 8000);
  const items = [];
  // 表示価値の高い書類のみ（決算/重要事象/年次・四半期/株主総会/登録届出）。内部者取引(3/4/5)/144/SD等の定型ノイズは除外
  const KEEP = /^(10-K|10-Q|8-K|20-F|6-K|40-F|DEF 14A|S-1|S-3|424B|F-1|11-K)(\/A)?$/;
  const re = /<entry>([\s\S]*?)<\/entry>/g; let m;
  while ((m = re.exec(xml)) && items.length < 10) {
    const c = m[1];
    const form = (c.match(/term="([^"]+)"/) || [])[1] || (c.match(/<filing-type>([^<]+)<\/filing-type>/) || [])[1] || '';
    const date = (c.match(/<filing-date>([^<]+)<\/filing-date>/) || [])[1] || (c.match(/<updated>([^<]+)<\/updated>/) || [])[1] || '';
    const href = (c.match(/<filing-href>([^<]+)<\/filing-href>/) || [])[1] || (c.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
    if (!form || !href || !KEEP.test(form)) continue;
    items.push({
      code: t, company: '', title: edgarFormJp(form),
      link: href.replace(/&amp;/g, '&'), pubDate: isoOf(date),
      form, market: 'US', kind: /10-K|10-Q|20-F|6-K/.test(form) ? 'earnings' : 'disclosure',
    });
  }
  return items;
}

// ---------- 共通 ----------
async function fetchJson(u, ms) { const r = await fetchGuard(u, ms); if (!r.ok) throw new Error('http ' + r.status); return r.json(); }
async function fetchText(u, ms) { const r = await fetchGuard(u, ms); if (!r.ok) throw new Error('http ' + r.status); return r.text(); }
async function fetchGuard(u, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(u, {
      headers: { 'User-Agent': 'securities-manager/1.0 (contact: mutenka1000@gmail.com)', 'Accept': 'application/json, application/atom+xml, */*' },
      signal: ctrl.signal, cf: { cacheTtl: 300, cacheEverything: true },
    });
  } finally { clearTimeout(timer); }
}
function isoOf(s) {
  if (!s) return null;
  s = String(s).trim();
  let d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d = new Date(s + 'T00:00:00+09:00');      // 日付のみ（EDGAR filing-date）
  else if (/[TZ+]/.test(s)) d = new Date(s);                                    // ISO
  else d = new Date(s.replace(' ', 'T') + '+09:00');                            // "YYYY-MM-DD HH:MM:SS"（TDnet=JST）
  return isNaN(d) ? null : d.toISOString();
}
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
