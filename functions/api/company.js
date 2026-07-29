// 会社概要（株探）
//   GET /api/company?symbols=7203.T,AAPL  → { "7203.T": {summary}, "AAPL": {summary}, ... }
//
// 取得元は株探の基本情報ページの「会社情報 → 概要」。
//   JP: https://kabutan.jp/stock/?code=7203        …  <th scope='row'>概要</th><td>…</td>
//   US: https://us.kabutan.jp/stocks/AAPL          …  <th class="…">概要</th><td class="pt-2 …">…</td>
// どちらも「概要」の th の直後の td にプレーンテキストで入っている（実測で確認・2026-07-29）。
//
// 概要は年単位でしか変わらない情報なので、クライアント側は「未取得の銘柄だけ」取りに行き、
// 銘柄マスタ（store.data.meta[priceKey].summary）に保存して使い回す。1銘柄=1サブリクエスト。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const syms = (url.searchParams.get('symbols') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
  if (!syms.length) return json({});
  const out = {};
  await Promise.all(syms.map(async (sym) => {
    try { out[sym] = await fetchSummary(sym); } catch (_) { out[sym] = { error: true }; }
  }));
  return json(out);
}

async function fetchSummary(symbol) {
  const jp = /\.T$/i.test(symbol);
  const code = symbol.replace(/\.T$/i, '');
  const target = jp
    ? `https://kabutan.jp/stock/?code=${encodeURIComponent(code)}`
    : `https://us.kabutan.jp/stocks/${encodeURIComponent(code.toUpperCase())}`;
  const r = await fetchGuard(target, 8000);
  if (!r.ok) return { error: true };
  const html = await r.text();
  const summary = pickSummary(html);
  return summary ? { summary } : {};
}

// 「概要」の th → 直後の td のテキストを取り出す。タグ除去・実体参照の復元・空白の正規化まで行う。
function pickSummary(html) {
  const m = /概要\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/.exec(html);
  if (!m) return '';
  const txt = m[1]
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return txt.slice(0, 400); // 想定は100〜200字。異常に長い時は保険で切る
}

async function fetchGuard(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }, signal: ac.signal });
  } finally { clearTimeout(t); }
}

function json(o) {
  return new Response(JSON.stringify(o), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=86400' },
  });
}
