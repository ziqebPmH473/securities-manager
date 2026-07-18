// Cloudflare Pages Function: 経済ニュース見出しの取得（フェーズN1）
// GET /api/news → { items: [{ title, link, source, pubDate }], at }
// 無料の公式RSS（見出し＋リンク＋時刻のみ）を複数まとめて返す。本文は取得しない（著作権上、
// 見出し一覧→クリックで元記事へ飛ぶ構成）。カテゴリ分類はクライアント側（キーワードルール）で行う。

// broad:true のフィードは総合ニュース（スポーツ・生活・車等が混ざる）なので MARKET_RE で経済関連だけ通す。
// broad なしは経済・マーケット専門メディアのため全通し。
// ※ 日経本体（news/markets）は公式RSSが無く assets.wor.jp（第三者の再配信）経由。継続性リスクがあるため
//   止まっても他フィードで成立するよう複数ソース構成にしている。source は表示名。
const FEEDS = [
  // 経済・マーケット専門（全通し・良質）
  { url: 'https://assets.wor.jp/rss/rdf/nikkei/markets.rdf', source: '日経マーケット' },
  { url: 'https://business.nikkei.com/rss/sns/nb.rdf', source: '日経ビジネス' },
  // 総合ニュース・汎用フィード（経済キーワードで絞り込み。俳句・歴史・生活記事等を除去）
  { url: 'https://toyokeizai.net/list/feed/rss', source: '東洋経済', broad: true },
  { url: 'https://diamond.jp/list/feed/rss/dol', source: 'ダイヤモンド', broad: true },
  { url: 'https://assets.wor.jp/rss/rdf/nikkei/news.rdf', source: '日経', broad: true },
  { url: 'https://news.yahoo.co.jp/rss/topics/business.xml', source: 'Yahoo!ニュース', splitSuffix: true },
  { url: 'https://news.yahoo.co.jp/rss/categories/business.xml', source: 'Yahoo!経済', broad: true, splitSuffix: true },
  { url: 'https://www3.nhk.or.jp/rss/news/cat5.xml', source: 'NHK' },
  // ブルームバーグ英語版（米国株・マクロ。英語見出し）。頻繁に更新されるため max で件数を抑え日本語ソースを圧迫しない
  { url: 'https://feeds.bloomberg.com/markets/news.rss', source: 'Bloomberg', max: 8 },
  { url: 'https://feeds.bloomberg.com/economics/news.rss', source: 'Bloomberg', max: 6 },
];

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  // 銘柄別ニュース（フェーズN2・米国株）: /api/news?symbol=AAPL → Finnhub company-news（無料枠・既存キー）
  const symbol = url.searchParams.get('symbol');
  if (symbol) {
    try { return json(await companyNews(context, symbol)); }
    catch (e) { return json({ items: [], error: String(e && e.message || e) }); }
  }
  const results = await Promise.allSettled(FEEDS.map(f => fetchFeed(f)));
  const items = [];
  const errors = [];
  for (const r of results) {
    if (r.status === 'fulfilled') items.push(...r.value);
    else errors.push(String(r.reason && r.reason.message || r.reason));
  }
  // リンクで重複排除（トピックスとカテゴリ新着で同一記事が来る）
  const seen = new Set();
  const uniq = items.filter(it => {
    const k = it.link;
    if (!k || seen.has(k)) return false;
    seen.add(k); return true;
  });
  uniq.sort((a, b) => (b.pubDate || '') < (a.pubDate || '') ? -1 : 1);
  return json({ items: uniq.slice(0, 120), at: new Date().toISOString(), errors: errors.length ? errors : undefined });
}

// Finnhub company-news（直近14日・最大20件）。キー未設定なら空を返す（クライアントはRSS一致分のみ表示）
async function companyNews(context, symbol) {
  const key = context.env && context.env.FINNHUB_API_KEY;
  if (!key) return { items: [], note: 'no-key' };
  const day = 86400 * 1000;
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 14 * day).toISOString().slice(0, 10);
  const u = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol.toUpperCase())}&from=${from}&to=${to}&token=${key}`;
  const res = await fetch(u, { cf: { cacheTtl: 600, cacheEverything: true } });
  if (!res.ok) throw new Error(`finnhub ${res.status}`);
  const arr = await res.json();
  const items = (Array.isArray(arr) ? arr : []).slice(0, 20).map(n => ({
    title: n.headline, link: n.url, source: n.source || 'Finnhub',
    pubDate: n.datetime ? new Date(n.datetime * 1000).toISOString() : null,
  })).filter(it => it.title && it.link);
  return { items, at: new Date().toISOString() };
}

async function fetchFeed(f) {
  // 各フィードに個別タイムアウト（6秒）。遅い1本が全体を止めないよう AbortController で打ち切る。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  let res;
  try {
    res = await fetch(f.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; securities-manager/1.0)' },
      cf: { cacheTtl: 300, cacheEverything: true }, // 5分エッジキャッシュ（配信元への負荷も抑える）
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`${f.source} ${res.status}`);
  const xml = await res.text();
  let items = parseRss(xml, f.source, f.splitSuffix);
  // 広域フィード（Yahoo!経済カテゴリ等）は車・生活・エンタメ系が大量に混ざる。
  // マーケット・経済関連キーワードに一致する見出しだけ通す（トピックス/NHKは編集済みなので全通し）
  if (f.broad) items = items.filter(it => MARKET_RE.test(it.title));
  if (f.max) items = items.slice(0, f.max); // 更新頻度の高いフィードの件数上限（一覧の偏り防止）
  return items;
}

const MARKET_RE = /株|投資|市場|市況|経済|景気|金利|為替|円安|円高|ドル円|日銀|FRB|FOMC|決算|業績|増益|減益|赤字|黒字|配当|上場|IPO|証券|債券|国債|インフレ|物価|関税|増税|減税|消費税|GDP|雇用|賃金|資産|銀行|金融|保険|不動産価格|原油|金価格|半導体|輸出|輸入|貿易|買収|合併|TOB|倒産|日経平均|TOPIX|ダウ|ナスダック/;

// RSS 2.0 の <item> を正規表現で抽出（Workers に DOMParser は無い）。title/link/pubDate のみ使用
function parseRss(xml, source, splitSuffix) {
  const items = [];
  const re = /<item[\s>][\s\S]*?<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < 80) {
    const chunk = m[0];
    let title = clean(tag(chunk, 'title'));
    // 「見出し ｜ カテゴリ ｜ 媒体名」形式（東洋経済等）は先頭セグメント=見出しだけにする。
    // 末尾の媒体名（例:東洋経済オンライン）に含まれる語が MARKET_RE や銘柄名に誤ヒットするのを防ぐ。
    if (title && /[｜|]/.test(title)) { const seg = title.split(/\s*[｜|]\s*/); if (seg.length > 1 && seg[0].length >= 6) title = seg[0].trim(); }
    // RSS1.0(RDF)/2.0はlinkが要素値、Atomは<link href=...>属性。両対応
    let link = clean(tag(chunk, 'link'));
    if (!link) { const lm = chunk.match(/<link[^>]*href=["']([^"']+)["']/); if (lm) link = lm[1]; }
    if (!title || !link) continue;
    const pub = tag(chunk, 'pubDate') || tag(chunk, 'dc:date') || tag(chunk, 'updated') || tag(chunk, 'published');
    let iso = null;
    if (pub) { const d = new Date(pub.trim()); if (!isNaN(d)) iso = d.toISOString(); }
    // 本文（要約）: description/summary/content から抜粋（銘柄・タグ判定を見出しだけでなく本文でも行うため）。
    // ※RSSに入るのは記事全文ではなく要約スニペット。全文は取得しない（著作権・スクレイピング回避）。
    let desc = clean(tag(chunk, 'description') || tag(chunk, 'summary') || tag(chunk, 'content:encoded') || tag(chunk, 'content'));
    if (desc) desc = desc.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    // Yahoo!の見出しだけ末尾に「(配信元)」が付く。表示用に分離し source を配信元名に置き換える
    // （日経ビジネス等はコラム名がカッコ書きされるので分離しない＝splitSuffix指定フィードのみ）
    let t = title, src = source;
    if (splitSuffix) {
      const pm = t.match(/^(.*)\(([^()]{2,20})\)$/);
      if (pm && !/^[0-9.,%美$¥]+$/.test(pm[2])) { t = pm[1].trim(); src = pm[2]; }
    }
    items.push({ title: t, link, source: src, pubDate: iso, desc: desc || undefined });
  }
  return items;
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : null;
}

// CDATA・HTMLエンティティを素のテキストに
function clean(s) {
  if (!s) return null;
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&').trim() || null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
