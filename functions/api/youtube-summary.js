// Cloudflare Pages Function: YouTube動画のAI要約（フェーズN3・Gemini）
//   GET /api/youtube-summary?v=VIDEOID[&models=m1,m2,...] → { summary, model, fellBack } または { error }
// 「東証マーケット振り返り」ツール(stock-slide-generator/analyze.js)と同仕様:
//   モデルは優先順の配列で受け取り、上限(429)・一時エラーはリトライ→次の下位モデルへ降格。全滅なら再試行を促す。
// Gemini に YouTube URL を fileData で渡す。長尺対策で低解像度＋前半45分に制限。結果はクライアントが ytSummaries にキャッシュ&同期。
const DEFAULT_CHAIN = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'];
const PROMPT = `次のYouTube動画を視聴し、投資・株式・マーケットの観点で日本語のニュース記事風にまとめてください。

出力形式（この形だけを出力し、ラベルや記号<>は絶対に書かない）:
1行目: この動画の投資的な中身を25〜45字で要約したニュース見出し（Yahooニュース風・体言止め可）。動画タイトルの丸写しは禁止し、中身を要約する。
2行目: 空行
3行目以降: 要点の箇条書き。各行を「・」で始め、5〜8点。具体的な銘柄名・数値・相場観・売買判断・注目テーマを含める。

ルール:
- 投資に無関係な雑談・挨拶・宣伝は省く。
- 動画に投資・マーケットの話題がほとんど無い場合は、1行目を「投資に関する内容なし」とし、3行目に「投資に関する内容は見当たりませんでした。」とだけ書く。
- 「見出し」「本文」等のラベルや <>【】 などの記号は書かない。要素そのものだけを出力する。前置き・後書きも不要。`;

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

  const debug = url.searchParams.get('debug') === '1';   // どの組み合わせで通ったかを返す（切り分け用）

  let lastStatus = 0, lastRaw = '', vi = 0, tried = [];
  for (let i = 0; i < chain.length; i++) {
    const m = chain[i];
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 55000);
      try {
        const res = await fetch(ENDPOINT(m, key), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(makeBody(v, VARIANTS[vi])), signal: ctrl.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          const cand = data.candidates && data.candidates[0];
          const parts = cand && cand.content && cand.content.parts;
          const text = Array.isArray(parts) ? parts.map(p => p.text || '').join('').trim() : '';
          if (text) {
            const { headline, summary } = splitHeadline(text);
            return json({ headline, summary, model: m, fellBack: i > 0, usage: data.usageMetadata || null,
              variant: debug ? VARIANTS[vi].name : undefined, tried: debug ? tried : undefined });
          }
          // 空応答（安全ブロック等）は一時エラー扱いにせず次モデルへ
          lastRaw = (cand && cand.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason) || 'empty';
          lastStatus = 200;
          break;
        }
        lastStatus = res.status;
        lastRaw = (data && data.error && data.error.message) || ('HTTP ' + res.status);
        tried.push(`${m}/${VARIANTS[vi].name}: ${String(lastRaw).slice(0, 80)}`);
        // ★リクエストの作りが受け付けられない（invalid argument）場合は、モデルを替えても同じ。
        //   videoMetadata(fps/切り出し)・mediaResolution・thinkingConfig を1つずつ落として作り直す。
        //   Gemini 側の仕様変更で従来の指定が弾かれるようになっても、単純な形に落ちて動き続ける。
        if (isBadRequest(res.status, lastRaw) && vi < VARIANTS.length - 1) {
          vi++; attempt = -1; continue;   // 同じモデルのまま次の組み合わせで再挑戦
        }
        if (!isTransient(res.status, lastRaw)) break;   // このモデルでは無理→次のモデルへ
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
  if (isBadRequest(lastStatus, lastRaw)) {
    return json({ error: '要約リクエストが受け付けられませんでした（Gemini側の仕様変更の可能性）。動画が非公開・限定公開・年齢制限の場合も同じエラーになります。',
      detail: String(lastRaw).slice(0, 300), tried });
  }
  return json({ error: '全モデルが混雑/上限のようです。少し待って「要約し直す」でお試しください。（最後のエラー: ' + jpError(lastStatus, lastRaw) + '）', detail: String(lastRaw).slice(0, 300), tried: debug ? tried : undefined });
}

// リクエストの作り方を段階的に単純化する組み合わせ。上から順に試し、invalid argument なら次へ落とす。
// 全部盛り（低解像度＋0.2fps＋前半60分）が通るなら従来どおりトークンを節約できる。
const VARIANTS = [
  { name: 'full',      fps: true,  clip: true,  mediaRes: true,  noThink: true },
  { name: 'no-fps',    fps: false, clip: true,  mediaRes: true,  noThink: true },
  { name: 'no-media',  fps: false, clip: true,  mediaRes: false, noThink: true },
  { name: 'no-clip',   fps: false, clip: false, mediaRes: false, noThink: true },
  { name: 'minimal',   fps: false, clip: false, mediaRes: false, noThink: false },
];
function makeBody(v, opt) {
  // 低解像度＋フレームレートを大きく下げる(0.2fps=5秒に1コマ)＝映像トークンを激減させ音声(ナレーション)は維持。
  // 実測 約39トークン/秒 なので前半60分でも約14万トークンでTPM上限(25万/分)内。長尺は前半60分のみ要約。
  const fd = { fileData: { fileUri: `https://www.youtube.com/watch?v=${v}` } };
  const vm = {};
  if (opt.clip) { vm.startOffset = '0s'; vm.endOffset = '3600s'; }
  if (opt.fps) vm.fps = 0.2;
  if (Object.keys(vm).length) fd.videoMetadata = vm;
  // thinkingBudget:0＝思考を無効化（思考が出力トークンを食って本文が途中で切れるのを防ぐ）
  const gc = { temperature: 0.3, maxOutputTokens: 1500 };
  if (opt.mediaRes) gc.mediaResolution = 'MEDIA_RESOLUTION_LOW';
  if (opt.noThink) gc.thinkingConfig = { thinkingBudget: 0 };
  return { contents: [{ role: 'user', parts: [{ text: PROMPT }, fd] }], generationConfig: gc };
}
// 「リクエストの作りが悪い」系のエラー（モデルを替えても直らない）
function isBadRequest(status, raw) {
  return status === 400 && /invalid argument|unsupported|unknown name|cannot find field|invalid json/i.test(String(raw || ''));
}

// 出力を「見出し（最初の実質行）」と「本文（残り）」に分割。
// モデルが <見出し>/<本文> 等のラベルを出力しても除去する（空行・ラベル行を捨てて最初の実文を見出しに）。
function splitHeadline(text) {
  const isLabel = (l) => /^[<【[(]?\s*(見出し|本文|タイトル|要約|概要|headline|summary|title|body)\s*[>】\])]?\s*[:：]?\s*$/i.test(l);
  const lines = String(text).split('\n').map(l => l.trim()).filter(l => l && !isLabel(l)); // 空行・ラベル行を除去
  const headline = (lines[0] || '').replace(/^[・\-*#>「」\s]+/, '').replace(/^(見出し|タイトル)\s*[:：]\s*/, '').replace(/[「」]/g, '').trim();
  const summary = lines.slice(1).join('\n').trim();
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
