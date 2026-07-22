// Cloudflare Pages Function: 短文翻訳（ニュース英語見出し/要約の日本語化）
// POST /api/translate {texts:[...], sl, tl} → { translated:[...] }（入力順・同件数）
// GET  /api/translate?q=...&q=...&sl=en&tl=ja も後方互換で受ける（単一は ?text=...）
//
// 2段フォールバック（前段で訳せなかった分だけ次へ）:
//   1) clients5 dict-chrome-ex … 複数qを1リクエストで翻訳。URLが長くなりすぎないよう6000文字単位でチャンク分割
//   2) gtx single … 1件ずつ（レート制限を避け最大10件まで）
// ※ Gemini フォールバックは「動画要約と回数上限を共有して枯らすのが不安」（2026-07-22 すみぽん判断）のため
//   使わない。両方失敗した分はクライアントが原文フォールバック＋5分後に再試行。
// 旧実装の問題: ①GETのみ＝大きいバッチでURLがCFの上限(16KB)を超えリクエスト自体が失敗
// ②cacheEverything(24h)が上流の失敗レスポンスまで固定化＝直っても同じ記事が失敗し続ける（キャッシュ廃止。
// 翻訳結果はクライアントが newsTrans にキャッシュ＆同期するのでサーバー側キャッシュは不要）
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  let texts = url.searchParams.getAll('q');
  const single = url.searchParams.get('text');
  if (!texts.length && single) texts = [single];
  return run(context, texts, url.searchParams.get('sl') || 'auto', url.searchParams.get('tl') || 'ja');
}
export async function onRequestPost(context) {
  let body = null;
  try { body = await context.request.json(); } catch (_) {}
  const texts = body && Array.isArray(body.texts) ? body.texts : [];
  return run(context, texts, (body && body.sl) || 'auto', (body && body.tl) || 'ja');
}

async function run(context, texts, sl, tl) {
  // 長文は除外せず先頭1500文字に切り詰め（除外すると件数がズレて対応付けが崩れる・長文が永久に翻訳不能になる）
  texts = texts.map(t => String(t || '').slice(0, 1500)).filter(t => t).slice(0, 40);
  if (!texts.length) return json({ error: 'no text', translated: [] }, 400);
  const out = new Array(texts.length).fill('');

  // 1) clients5 をURL長セーフなチャンクで
  let chunk = [], chunkIdx = [], len = 0;
  const flush = async () => {
    if (!chunk.length) return;
    const r = await batchClients5(chunk, sl, tl);
    if (r) r.forEach((v, k) => { out[chunkIdx[k]] = v; });
    chunk = []; chunkIdx = []; len = 0;
  };
  for (let i = 0; i < texts.length; i++) {
    const enc = encodeURIComponent(texts[i]).length + 3;
    if (len + enc > 6000 && chunk.length) await flush();
    chunk.push(texts[i]); chunkIdx.push(i); len += enc;
  }
  await flush();

  // 2) 取れなかった分を gtx で1件ずつ（最大10件＝連打による429を避ける）
  const miss = out.map((v, i) => v ? null : i).filter(v => v != null);
  for (const i of miss.slice(0, 10)) out[i] = await gtxSingle(texts[i], sl, tl);
  return json({ translated: out });
}

// clients5 dict-chrome-ex は複数 q を ["訳1","訳2",...] で返す（1リクエストで完結）
async function batchClients5(texts, sl, tl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const qs = texts.map(t => 'q=' + encodeURIComponent(t)).join('&');
    const u = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&${qs}`;
    const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; securities-manager/1.0)' }, signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    // 複数qは文字列配列。単一qは ["訳"] または [["訳","原",...]] の形があり得るので正規化
    let arr = data;
    if (Array.isArray(arr) && arr.length && Array.isArray(arr[0])) arr = arr.map(x => Array.isArray(x) ? x[0] : x);
    if (!Array.isArray(arr) || arr.length !== texts.length || arr.some(x => typeof x !== 'string' || !x)) return null;
    return arr;
  } catch (_) { return null; }
  finally { clearTimeout(timer); }
}

async function gtxSingle(text, sl, tl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; securities-manager/1.0)' }, signal: ctrl.signal });
    if (!res.ok) return '';
    const data = await res.json();
    return Array.isArray(data && data[0]) ? data[0].map(s => (s && s[0]) || '').join('') : '';
  } catch (_) { return ''; }
  finally { clearTimeout(timer); }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
