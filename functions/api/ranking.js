// Cloudflare Pages Function: マーケットのランキング取得
// GET /api/ranking?market=US|JP&kind=turnover|marketcap|gainers|losers&sub=all|prime|standard|growth|nikkei&count=20
//   → { items: [{ code, name, price, changePct, prevClose, value, volume, marketCap, market }], kind, market, source }
// 1リクエストで上位N件＋株価・前日比がまとめて返るため、銘柄ごとのAPI呼び出しは不要（制限に優しい）。

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const market = (url.searchParams.get('market') || 'US').toUpperCase();
  const kind = url.searchParams.get('kind') || 'turnover';
  const sub = url.searchParams.get('sub') || 'all';
  const count = Math.min(50, Math.max(1, parseInt(url.searchParams.get('count') || '20', 10)));
  // デバッグ: 日本株の __NEXT_DATA__ 構造を確認（ランキング配列のパス特定用）
  if (url.searchParams.get('debug') === '1' && market === 'JP') {
    try { return json(await debugJp(JP_TYPE[kind] || 'marketCapitalHigh', JP_MARKET[sub] || 'tokyoAll')); }
    catch (e) { return json({ error: String(e && e.message || e) }); }
  }
  try {
    const items = market === 'JP' ? await rankJp(kind, sub, count) : await rankUs(kind, count);
    return json({ market, kind, sub, items, source: market === 'JP' ? 'yahoo-jp' : 'yahoo-screener' });
  } catch (e) {
    return json({ market, kind, sub, items: [], error: String(e && e.message || e) }, 200);
  }
}

// ---------- 米国株（Yahoo predefined screener。認証不要） ----------
const US_SCR = { turnover: 'most_actives', marketcap: 'most_actives', gainers: 'day_gainers', losers: 'day_losers' };
async function rankUs(kind, count) {
  const scr = US_SCR[kind] || 'most_actives';
  // 売買代金/時価総額は並べ替えのため多めに取得
  const fetchN = (kind === 'turnover' || kind === 'marketcap') ? 100 : Math.max(count, 25);
  const u = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=${fetchN}&scrIds=${scr}`;
  const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; securities-manager/1.0)' }, cf: { cacheTtl: 120, cacheEverything: true } });
  if (!res.ok) throw new Error(`screener ${res.status}`);
  const data = await res.json();
  const quotes = (data && data.finance && data.finance.result && data.finance.result[0] && data.finance.result[0].quotes) || [];
  let items = quotes.filter(q => q && q.symbol).map(q => {
    const price = num(q.regularMarketPrice), vol = num(q.regularMarketVolume), mc = num(q.marketCap);
    // 配当は同じレスポンスに含まれる（追加取得ゼロ）。yieldは小数(0.0518)なので%へ。
    // 表示通貨(currency)と財務通貨(financialCurrency)が違うADR(ITUB/BBD/SKHY等)は
    // 配当がBRL/KRW建てなのに株価がUSDで、Yahooのyield自体が壊れる(39%/1912%)。この場合は載せない。
    const divOk = !(q.currency && q.financialCurrency && q.currency !== q.financialCurrency);
    const dy = divOk ? num(q.trailingAnnualDividendYield) : null;
    return {
      code: q.symbol,
      name: cleanName(q.shortName || q.longName || q.symbol),
      price, changePct: num(q.regularMarketChangePercent),
      prevClose: num(q.regularMarketPreviousClose),
      volume: vol, marketCap: mc,
      turnover: (price != null && vol != null) ? price * vol : null, // 売買代金=価格×出来高
      dividend: divOk ? num(q.trailingAnnualDividendRate) : null,
      divYield: dy != null ? dy * 100 : null,
      exchange: q.fullExchangeName || q.exchange || null,
      market: 'US',
    };
  });
  if (kind === 'turnover') items.sort((a, b) => (b.turnover || 0) - (a.turnover || 0));
  else if (kind === 'marketcap') items.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
  // gainers/losers は screener が並べ替え済み
  return items.slice(0, count);
}

// ---------- 日本株（Yahoo!ファイナンス日本版ランキングを解析） ----------
// term=daily, type に応じたランキング。__NEXT_DATA__(JSON) からリストを抽出する。
// 種別→Yahoo Japanランキングのパス。marketCapitalHigh/up/down は確認済。tradingValueHigh(売買代金)は推定→本番検証。
const JP_TYPE = { turnover: 'tradingValueHigh', marketcap: 'marketCapitalHigh', gainers: 'up', losers: 'down' };
// 市場フィルタ。全=tokyoAll / プライム=tokyo1 / スタンダード=tokyo2 / グロース=tokyoM（すみぽん提供URLで確認）。日経採用はYahoo側に無し。
const JP_MARKET = { all: 'tokyoAll', prime: 'tokyo1', standard: 'tokyo2', growth: 'tokyoM' };
async function rankJp(kind, sub, count) {
  const type = JP_TYPE[kind] || 'marketCapitalHigh';
  const mk = JP_MARKET[sub] || 'tokyoAll';
  const u = `https://finance.yahoo.co.jp/stocks/ranking/${type}?market=${mk}&term=daily`;
  const res = await fetch(u, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', 'Accept-Language': 'ja' },
    cf: { cacheTtl: 120, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`yahoo-jp ${res.status}`);
  const html = await res.text();
  return parseJpRanking(html, count, kind);
}
// Yahoo Japan ランキングのHTMLを解析。各行: <a .../quote/CODE.T>NAME</a> + <li>CODE</li><li>東証PRM</li>。
// コード・名称・市場区分＋ランキング指標(時価総額/売買代金。単位=百万円等→円換算)＋取引値・前日比・出来高を抽出。
// 5年高値・1年/3年安値などはクライアントが /api/price?highs=1 で補完（取れた時は現在値・前日比もそちらを優先）。
// 2026-11-11: 同じ行に 取引値・前日比（額と%）・出来高 も載っているので一緒に読む。
//   以前は「現在値・前日比は取得元に無い」前提で /api/price（ログイン必須）だけに頼っており、
//   未ログイン/トークン失効/Yahoo 429 のいずれでも日本株ランキングの現在値・前日比が全行「—」になった。
//   列は種別で違う（売買代金: 取引値/前日比/売買代金、時価総額: 取引値/発行済み株式数/時価総額(百万円)/単元株数、
//   値上がり・値下がり: 取引値/前日比/出来高）ため、見出し<th scope="col">の文言で列を対応づける。
function parseJpRanking(html, count, kind) {
  const items = []; const seen = new Set();
  // 見出し（先頭2列＝順位・名称を除いた、数値セルの並び）
  const heads = [...html.matchAll(/<th[^>]*scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map(x => x[1].replace(/<[^>]+>/g, '').trim()).slice(2);
  const re = /\/quote\/([0-9A-Z]{4})\.T"[^>]*>([^<]{1,50})<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null && items.length < count) {
    const code = m[1]; if (seen.has(code)) continue; seen.add(code);
    const name = cleanName(decodeEntities(m[2].trim()));
    const end = html.indexOf('</tr>', m.index);
    const row = html.slice(m.index, end > m.index ? Math.min(end, m.index + 6000) : m.index + 2600);
    const sm = row.slice(0, 500).match(/東証([A-Z]+)/);
    const it = { code, name, market: 'JP', section: sm ? jpSection(sm[1]) : null, price: null, changePct: null, prevClose: null, volume: null, turnover: null, marketCap: null };
    // 数値セルを順に取り出し、各セル内の「値＋単位」を列挙（前日比セルは 額 と % の2つ）
    const cells = row.match(/<td[^>]*RankingTable__detail[\s\S]*?<\/td>/g) || [];
    const nums = cells.map(c => [...c.matchAll(/StyledNumber__value__[^"]*">([^<]+)<\/span>(?:<span class="StyledNumber__suffix__[^"]*">([^<]+)<\/span>)?/g)]
      .map(x => ({ n: parseFloat(x[1].replace(/[,+\s]/g, '')), unit: x[2] || '' })).filter(x => isFinite(x.n)));
    let change = null;
    heads.forEach((h, i) => {
      const v = nums[i]; if (!v || !v.length) return;
      if (/取引値/.test(h)) it.price = v[0].n;
      else if (/前日比/.test(h)) { change = v[0].unit === '%' ? null : v[0].n; const p = v.find(x => x.unit === '%'); if (p) it.changePct = p.n; }
      else if (/売買代金/.test(h)) it.turnover = scaleJpUnit(v[0].n, v[0].unit || h);
      else if (/時価総額/.test(h)) it.marketCap = scaleJpUnit(v[0].n, v[0].unit || h);
      else if (/出来高/.test(h)) it.volume = v[0].n;
    });
    if (it.price != null && change != null) it.prevClose = it.price - change;
    // 見出しで対応づけられなかった時の保険（従来方式）: 強調セル＝ランキング指標（時価総額 or 売買代金）
    if ((kind === 'marketcap' && it.marketCap == null) || (kind === 'turnover' && it.turnover == null)) {
      const hm = row.match(/detail--highlight[\s\S]{0,200}?StyledNumber__value__[^"]*">([\d,.]+)<\/span>(?:<span class="StyledNumber__suffix__[^"]*">([^<]+)<\/span>)?/);
      const metric = hm ? scaleJpUnit(parseFloat(hm[1].replace(/,/g, '')), hm[2] || '') : null;
      if (kind === 'marketcap') it.marketCap = metric; else it.turnover = metric;
    }
    items.push(it);
  }
  return items;
}
function scaleJpUnit(n, unit) { if (!isFinite(n)) return null; if (/兆/.test(unit)) return n * 1e12; if (/億/.test(unit)) return n * 1e8; if (/百万/.test(unit)) return n * 1e6; if (/千/.test(unit)) return n * 1e3; return n; }
function jpSection(c) { return c === 'PRM' ? 'プライム' : c === 'STD' ? 'スタンダード' : c === 'GRT' ? 'グロース' : '東証' + c; }
function decodeEntities(s) { return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
// 法人格表記を除去（保有銘柄と同ルール）。日本語(株式会社/(株)/㈱)＋英語(Inc/Corp/Ltd等)。
function cleanName(name) {
  if (!name) return name;
  const orig = String(name).trim();
  let s = orig.replace(/(株式会社|\(株\)|（株）|㈱)/g, '');
  const EN = /[,，]?\s*(Incorporated|Inc|Corporation|Corp|Company|Co|Limited|Ltd|P\.?L\.?C|LLC|N\.?V|S\.?A|A\.?G)\.?$/i;
  s = s.replace(EN, '').replace(EN, '').replace(/[\s,，・]+$/, '').trim();
  return s || orig;
}

// デバッグ: ページHTTP状況と __NEXT_DATA__ の構造サンプルを返す（ランキング配列のキー/パス特定用）
async function debugJp(type, mk) {
  const u = `https://finance.yahoo.co.jp/stocks/ranking/${type}?market=${mk || 'tokyoAll'}&term=daily`;
  const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', 'Accept-Language': 'ja' } });
  const out = { url: u, status: res.status };
  if (!res.ok) return out;
  const html = await res.text();
  out.htmlLen = html.length;
  out.hasNextData = html.includes('__NEXT_DATA__');
  out.hasPreloaded = html.includes('__PRELOADED_STATE__');
  out.quoteLinkCount = (html.match(/\/quote\/\d{4}\.T/g) || []).length;
  // 市場区分テキストが行ごとにあるか（市場列を各銘柄の区分にできるか判定）
  out.primeCount = (html.match(/プライム/g) || []).length;
  out.standardCount = (html.match(/スタンダード/g) || []).length;
  out.growthCount = (html.match(/グロース/g) || []).length;
  // 最初の銘柄リンク周辺のHTMLを返す（行構造を見て解析を書くため）
  const idx = html.search(/\/quote\/\d{4}\.T/);
  out.snippetAroundFirstQuote = idx >= 0 ? html.slice(Math.max(0, idx - 250), idx + 2600) : null;
  // 強調セル（ランキング指標=売買代金/時価総額）の中身を確認
  const hi = idx >= 0 ? html.indexOf('detail--highlight', idx) : -1;
  out.highlightSnippet = hi >= 0 ? html.slice(hi, hi + 350) : null;
  return out;
}

function num(v) { if (typeof v === 'number' && isFinite(v)) return v; if (typeof v === 'string') { const n = parseFloat(v.replace(/[,，円%\s]/g, '')); return isFinite(n) ? n : null; } return null; }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
}
