// Cloudflare Pages Function: 短文翻訳（ニュース英語見出し/要約の日本語化）
// GET /api/translate?text=...&sl=en&tl=ja → { translated }
// Google翻訳の非公式エンドポイント(gtx)を利用。※公式APIではなく規約グレー・予告なく壊れ得る「暫定」実装。
//   壊れた場合はクライアントが原文（英語）にフォールバックする。将来は Gemini/DeepL 等の正式APIへ差し替え可能。
// 翻訳結果はクライアント側で store.data.newsTrans にキャッシュ＆同期するため、同一記事の再翻訳は起きない。
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const q = url.searchParams.get('text');
  const sl = url.searchParams.get('sl') || 'auto';
  const tl = url.searchParams.get('tl') || 'ja';
  if (!q) return json({ error: 'no text' }, 400);
  if (q.length > 1200) return json({ error: 'too long' }, 400);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(q)}`;
    const res = await fetch(u, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; securities-manager/1.0)' },
      signal: ctrl.signal,
      cf: { cacheTtl: 86400, cacheEverything: true }, // 同一テキストはエッジで1日キャッシュ（端末横断で再翻訳を抑制）
    });
    if (!res.ok) throw new Error('translate ' + res.status);
    const data = await res.json();
    // gtx形式: data[0] = [[訳文, 原文, ...], ...]。訳文セグメントを連結
    const translated = Array.isArray(data && data[0]) ? data[0].map(s => (s && s[0]) || '').join('') : '';
    if (!translated) throw new Error('empty');
    return json({ translated });
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 200);
  } finally { clearTimeout(timer); }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
