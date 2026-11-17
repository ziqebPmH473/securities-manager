// 日本株ランキング（Yahoo!ファイナンス日本版）の取得・解析。/api/ranking と /api/open-ranking で共用。
// Yahoo!ファイナンス日本版は東証の株価をリアルタイム表示（ページ注記・isRealTime で確認 2026-11-18）。
// ---------- 日本株（Yahoo!ファイナンス日本版ランキングを解析） ----------
// term=daily, type に応じたランキング。__NEXT_DATA__(JSON) からリストを抽出する。
// 種別→Yahoo Japanランキングのパス。marketCapitalHigh/up/down は確認済。tradingValueHigh(売買代金)は推定→本番検証。
export const JP_TYPE = { turnover: 'tradingValueHigh', marketcap: 'marketCapitalHigh', gainers: 'up', losers: 'down' };
// 市場フィルタ。全=tokyoAll / プライム=tokyo1 / スタンダード=tokyo2 / グロース=tokyoM（すみぽん提供URLで確認）。日経採用はYahoo側に無し。
export const JP_MARKET = { all: 'tokyoAll', prime: 'tokyo1', standard: 'tokyo2', growth: 'tokyoM' };
export async function rankJp(kind, sub, count) {
  return (await rankJpPage(kind, sub, 1, { count })).items;
}
// 1ページ（50件）分を取得。page=2 で51〜100位。updatedAt はページの「更新日時」（例 "2026/11/17 18:40"）。
// opts.cacheTtl: Cloudflare側キャッシュ秒（寄り付きランキングは鮮度優先で短くする）
export async function rankJpPage(kind, sub, page = 1, opts = {}) {
  const type = JP_TYPE[kind] || 'marketCapitalHigh';
  const mk = JP_MARKET[sub] || 'tokyoAll';
  const u = `https://finance.yahoo.co.jp/stocks/ranking/${type}?market=${mk}&term=daily${page > 1 ? '&page=' + page : ''}`;
  const res = await fetch(u, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', 'Accept-Language': 'ja' },
    cf: { cacheTtl: opts.cacheTtl != null ? opts.cacheTtl : 120, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`yahoo-jp ${res.status}`);
  const html = await res.text();
  const um = html.match(/"updateDateTime\\?":\\?"([0-9/]+ [0-9:]+)/);
  return { items: parseJpRanking(html, opts.count || 50, kind), updatedAt: um ? um[1] : null };
}
// Yahoo Japan ランキングのHTMLを解析。各行: <a .../quote/CODE.T>NAME</a> + <li>CODE</li><li>東証PRM</li>。
// コード・名称・市場区分＋ランキング指標(時価総額/売買代金。単位=百万円等→円換算)＋取引値・前日比・出来高を抽出。
// 5年高値・1年/3年安値などはクライアントが /api/price?highs=1 で補完（取れた時は現在値・前日比もそちらを優先）。
// 2026-11-11: 同じ行に 取引値・前日比（額と%）・出来高 も載っているので一緒に読む。
//   以前は「現在値・前日比は取得元に無い」前提で /api/price（ログイン必須）だけに頼っており、
//   未ログイン/トークン失効/Yahoo 429 のいずれでも日本株ランキングの現在値・前日比が全行「—」になった。
//   列は種別で違う（売買代金: 取引値/前日比/売買代金、時価総額: 取引値/発行済み株式数/時価総額(百万円)/単元株数、
//   値上がり・値下がり: 取引値/前日比/出来高）ため、見出し<th scope="col">の文言で列を対応づける。
export function parseJpRanking(html, count, kind) {
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
export function cleanName(name) {
  if (!name) return name;
  const orig = String(name).trim();
  let s = orig.replace(/(株式会社|\(株\)|（株）|㈱)/g, '');
  const EN = /[,，]?\s*(Incorporated|Inc|Corporation|Corp|Company|Co|Limited|Ltd|P\.?L\.?C|LLC|N\.?V|S\.?A|A\.?G)\.?$/i;
  s = s.replace(EN, '').replace(EN, '').replace(/[\s,，・]+$/, '').trim();
  return s || orig;
}
