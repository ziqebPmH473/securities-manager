// Cloudflare Pages Function: YouTube動画のAI要約（フェーズN3・Gemini）
//   GET /api/youtube-summary?v=VIDEOID → { summary } または { error }
// Google Gemini API（GEMINI_API_KEY 必須）に YouTube URL を渡し、投資関連の要点を日本語で要約させる。
// 長時間動画はトークン/時間を要するため 55秒でタイムアウト。結果はクライアントが ytSummaries にキャッシュ＆同期＝1動画1回。
const MODEL = 'gemini-2.0-flash'; // 動画(YouTube URL)入力対応モデル
const PROMPT = `あなたは投資情報の編集者です。次のYouTube動画を視聴し、投資・株式・マーケットに関係する要点だけを日本語で簡潔にまとめてください。
- 箇条書き5〜8点。各行は簡潔に。
- 具体的な銘柄名・数値・相場観・売買判断・注目テーマがあれば必ず含める。
- 投資に無関係な雑談・挨拶・宣伝は省く。
- 動画に投資・マーケットの話題がほとんど無い場合は「投資に関する内容は見当たりませんでした。」とだけ書く。
- 前置きや「以下に要約します」等は不要。要点のみ。`;

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const v = (url.searchParams.get('v') || '').trim();
  if (!/^[\w-]{6,20}$/.test(v)) return json({ error: 'invalid video id' }, 400);
  const key = context.env && context.env.GEMINI_API_KEY;
  if (!key) return json({ error: 'GEMINI_API_KEY が未設定です（Cloudflareの環境変数に設定してください）' });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55000);
  try {
    const api = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        contents: [{ parts: [
          { text: PROMPT },
          { fileData: { fileUri: `https://www.youtube.com/watch?v=${v}` } },
        ] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 900 },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
      return json({ error: 'Gemini: ' + String(msg).slice(0, 300) });
    }
    const cand = data.candidates && data.candidates[0];
    const parts = cand && cand.content && cand.content.parts;
    const text = Array.isArray(parts) ? parts.map(p => p.text || '').join('').trim() : '';
    if (!text) {
      const reason = (cand && cand.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason) || 'empty';
      return json({ error: '要約を取得できませんでした（' + reason + '）' });
    }
    return json({ summary: text });
  } catch (e) {
    const aborted = e && (e.name === 'AbortError');
    return json({ error: aborted ? '要約がタイムアウトしました（動画が長すぎる可能性）' : ('取得失敗: ' + String(e && e.message || e).slice(0, 200)) });
  } finally { clearTimeout(timer); }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
