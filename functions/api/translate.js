// Cloudflare Pages Function: 短文翻訳（ニュース英語見出し/要約の日本語化）
// GET /api/translate?q=...&q=...&sl=en&tl=ja → { translated:[...] }（入力順）／単一は ?text=... でも可
// Google翻訳の非公式エンドポイントを利用（公式APIではなく規約グレー・暫定）。壊れたらクライアントが原文フォールバック。
//   ・第1候補: clients5 dict-chrome-ex（複数qを1リクエストで翻訳＝レート制限に強い）
//   ・第2候補: gtx single（1件ずつ）
// 翻訳結果はクライアントが store.data.newsTrans にキャッシュ＆同期＝同一記事の再翻訳は起きない。
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  let texts = url.searchParams.getAll('q');
  const single = url.searchParams.get('text');
  if (!texts.length && single) texts = [single];
  const sl = url.searchParams.get('sl') || 'auto';
  const tl = url.searchParams.get('tl') || 'ja';
  // 長文は「除外」ではなく先頭1500文字に切り詰めて翻訳する。
  // 旧: length>1200 を filter で落としていたため、①長い要約は翻訳が常に失敗（毎回「翻訳を取得できません
  // でした」）②バッチ内の1件が落ちると translated の件数がズレ、クライアント側の対応付けが崩れて
  // 別記事の訳が混ざり得た。切り詰めなら件数が常に一致し、長文も冒頭だけは翻訳される。
  texts = texts.map(t => String(t || '').slice(0, 1500)).filter(t => t).slice(0, 30);
  if (!texts.length) return json({ error: 'no text', translated: [] }, 400);

  let translated = await batchClients5(texts, sl, tl);
  if (!translated) { // フォールバック: 1件ずつ gtx
    translated = [];
    for (const t of texts) translated.push(await gtxSingle(t, sl, tl));
  }
  return json({ translated });
}

// clients5 dict-chrome-ex は複数 q を ["訳1","訳2",...] で返す（1リクエストで完結）
async function batchClients5(texts, sl, tl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const qs = texts.map(t => 'q=' + encodeURIComponent(t)).join('&');
    const u = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&${qs}`;
    const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; securities-manager/1.0)' }, signal: ctrl.signal, cf: { cacheTtl: 86400, cacheEverything: true } });
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
    const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; securities-manager/1.0)' }, signal: ctrl.signal, cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!res.ok) return '';
    const data = await res.json();
    return Array.isArray(data && data[0]) ? data[0].map(s => (s && s[0]) || '').join('') : '';
  } catch (_) { return ''; }
  finally { clearTimeout(timer); }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
