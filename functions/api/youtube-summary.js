// Cloudflare Pages Function: YouTube動画のAI要約（フェーズN3・Gemini）
//   GET /api/youtube-summary?v=VIDEOID[&models=m1,m2,...] → { summary, model, fellBack } または { error }
// 「東証マーケット振り返り」ツール(stock-slide-generator/analyze.js)と同仕様:
//   モデルは優先順の配列で受け取り、上限(429)・一時エラーはリトライ→次の下位モデルへ降格。全滅なら再試行を促す。
// Gemini に YouTube URL を fileData で渡す。長尺対策で低解像度＋前半45分に制限。結果はクライアントが ytSummaries にキャッシュ&同期。
const DEFAULT_CHAIN = ['gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'];
const PROMPT = `あなたは投資メディアの編集者です。次のYouTube動画を視聴し、投資・株式・マーケットの観点で日本語のニュース記事風にまとめてください。
出力は必ず次の形式（1行目＝見出し、空行、3行目以降＝本文）:

<見出し>
（1行だけ。この動画の投資的な中身を要約したYahooニュース風の見出し。25〜45字程度。体言止め可。動画タイトルをそのまま書かない＝中身を要約する。記号や「見出し:」等のラベルは付けない）

<本文>
・箇条書き5〜8点。具体的な銘柄名・数値・相場観・売買判断・注目テーマを含める。

ルール:
- 投資に無関係な雑談・挨拶・宣伝は省く。
- 動画に投資・マーケットの話題がほとんど無い場合は、見出しを「投資に関する内容なし」とし、本文に「投資に関する内容は見当たりませんでした。」とだけ書く。
- 前置きや「以下にまとめます」等は不要。`;

const ENDPOINT = (model, key) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
const isTransient = (status, raw) => status === 429 || status >= 500 || /quota|rate|exhaust|limit:\s*0|overload|high demand|unavailable|temporarily|try again|resource has been exhausted/i.test(raw || '');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const v = (url.searchParams.get('v') || '').trim();
  if (!/^[\w-]{6,20}$/.test(v)) return json({ error: 'invalid video id' }, 400);
  const key = context.env && context.env.GEMINI_API_KEY;
  if (!key || key === 'xxxxx') return json({ error: 'APIキーが未設定です（Cloudflareの環境変数 GEMINI_API_KEY を設定してください）' });

  const models = (url.searchParams.get('models') || '').split(',').map(s => s.trim()).filter(Boolean);
  const chain = models.length ? models.slice(0, 6) : DEFAULT_CHAIN;

  const body = {
    contents: [{ role: 'user', parts: [
      { text: PROMPT },
      // 前半15分に制限＋低解像度＝トークンを無料枠のTPM上限(25万/分)内に収める（45分だと約49万で2倍超過するため）。長尺は前半のみ要約。
      { fileData: { fileUri: `https://www.youtube.com/watch?v=${v}` }, videoMetadata: { startOffset: '0s', endOffset: '900s' } },
    ] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 900, mediaResolution: 'MEDIA_RESOLUTION_LOW' },
  };

  let lastStatus = 0, lastRaw = '';
  for (let i = 0; i < chain.length; i++) {
    const m = chain[i];
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 55000);
      try {
        const res = await fetch(ENDPOINT(m, key), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          const cand = data.candidates && data.candidates[0];
          const parts = cand && cand.content && cand.content.parts;
          const text = Array.isArray(parts) ? parts.map(p => p.text || '').join('').trim() : '';
          if (text) { const { headline, summary } = splitHeadline(text); return json({ headline, summary, model: m, fellBack: i > 0, usage: data.usageMetadata || null }); }
          // 空応答（安全ブロック等）は一時エラー扱いにせず次モデルへ
          lastRaw = (cand && cand.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason) || 'empty';
          lastStatus = 200;
          break;
        }
        lastStatus = res.status;
        lastRaw = (data && data.error && data.error.message) || ('HTTP ' + res.status);
        if (!isTransient(res.status, lastRaw)) return json({ error: jpError(res.status, lastRaw), detail: String(lastRaw).slice(0, 300), model: m });
        // 上限(TPM/回数)超過は同モデルで再試行しても同じ上限に当たり無駄にトークンを食う→即次モデルへ。過負荷/5xxのみ再試行
        const isQuota = res.status === 429 || /quota|exhaust|rate|limit/i.test(lastRaw);
        if (attempt === 0 && !isQuota) { await delay(800); continue; }
      } catch (e) {
        lastRaw = (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || String(e));
        if (attempt === 0 && lastRaw !== 'timeout') { await delay(800); continue; }
      } finally { clearTimeout(timer); }
      break; // 次モデルへ
    }
  }
  if (lastRaw === 'timeout') return json({ error: '要約がタイムアウトしました（動画が長すぎる可能性）。' });
  return json({ error: '全モデルが混雑/上限のようです。少し待って「要約し直す」でお試しください。（最後のエラー: ' + jpError(lastStatus, lastRaw) + '）', detail: String(lastRaw).slice(0, 300) });
}

// 出力を「見出し（1行目）」と「本文（残り）」に分割。ラベルや記号は除去。
function splitHeadline(text) {
  const lines = String(text).split('\n');
  let hi = 0;
  while (hi < lines.length && !lines[hi].trim()) hi++;         // 先頭の空行を飛ばす
  let headline = (lines[hi] || '').trim().replace(/^(見出し|タイトル)\s*[:：]\s*/, '').replace(/^[・\-*#>「」\s]+/, '').replace(/[「」]/g, '').trim();
  const summary = lines.slice(hi + 1).join('\n').replace(/^\s*本文\s*[:：]?\s*/i, '').trim();
  return { headline: headline.slice(0, 60), summary: summary || String(text).trim() };
}
// Geminiの英語エラーを日本語のわかりやすい文言に変換
function jpError(status, raw) {
  const m = String(raw || '').toLowerCase();
  if (status === 429 || m.includes('quota') || m.includes('rate limit') || m.includes('exceeded') || m.includes('exhaust')) return 'Geminiの無料枠の上限に達しました';
  if (status === 400 && (m.includes('api key') || m.includes('api_key'))) return 'APIキーが不正です';
  if (status === 403 || m.includes('permission') || m.includes('forbidden')) return 'APIキーの権限がありません（Generative Language APIの有効化を確認）';
  if (status === 404 || m.includes('not found')) return 'モデルが見つかりません（モデル名の可能性）';
  if (m.includes('unsupported') || m.includes('invalid argument')) return '動画を処理できませんでした（非公開/限定公開/年齢制限などの可能性）';
  return String(raw || 'unknown').slice(0, 120);
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
