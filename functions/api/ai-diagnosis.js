// Cloudflare Pages Function: AI相場診断（Gemini）
//   POST /api/ai-diagnosis  body: { data: <クライアントが組んだ相場・サイン等のJSON>, models: [m1,...](任意) }
//   → { text, model, fellBack, usage } または { error }
// youtube-summary.js と同じ GEMINI_API_KEY・同じ「上位モデルから試し、上限(429)等は下位へ降格」方式。
// 動画と違いテキストのみなのでリクエスト形は単純（VARIANTS 相当は不要）。
// ★プライバシー方針（2026-08-28 すみぽん決定）: 金額はクライアント側で送らない（銘柄・比率・サイン・マクロのみ）。
//   このAPIは受け取った data をそのままプロンプトに埋めるだけで、内容の追加取得はしない。
const DEFAULT_CHAIN = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'];

const PROMPT = `あなたは日本の個人投資家を補佐する投資分析アシスタントです。
以下のJSONは、利用者の株式管理ツールが今この瞬間に持っているデータです（金額は含まれません。比率のみ）。
- indices: 主要指数の現在値と前日比%
- fx: ドル円
- macro: マクロ指標の最新値（label/値/単位/観測日）
- macroAlerts: 利用者が設定した警告条件のうち、いま成立しているもの
- portfolio: 保有の構成比（市場別・カテゴリ別・上位銘柄の比率%）
- signals.reached: 利用者自身の買い増しルールに「到達」した銘柄(=ルール上は今が買い時)
- signals.near: 到達まで残り5%以内の銘柄
  各銘柄: ticker/name/market(JP=日本株,US=米国株)/sector/rating(格付)/grade(総合評価)/buyGrade(買い時評価)/
  priority(購入優先順位・小さいほど優先)/dropFrom5y(5年高値からの下落率%)/remainToTrigger(到達まで残り下落%)/
  portfolioPct(ポートフォリオ内比率%)/scenario(株価シナリオ上の現在位置)/earnDays(次回決算まで日数)/note(利用者の分析メモ)
- news: 直近のニュース見出し（cat=カテゴリ）

このデータ**のみ**を根拠に、次の4部構成で日本語の診断を書いてください。

【相場環境】
・指数・マクロ・成立中の警告から、いまの相場全体の位置づけを3〜5行で。強気/中立/警戒のどれ寄りかを明示。

【買い候補の優先順位】
・signals.reached（無ければ near）から最大5銘柄を優先順に。各行「1. ティッカー 銘柄名 — 理由」。
・理由はデータ内の事実（下落率・格付・比率・シナリオ位置・ニュース）を引用。ポートフォリオ比率が高すぎる銘柄は集中リスクを指摘。

【見送り・注意】
・今回は見送りが妥当な銘柄と理由（悪材料ニュース・決算直前(earnDays が 0〜7)・シナリオ弱気圏割れ・比率過大など）。該当なしなら「特になし」。

【全体への注意】
・マクロ・相場環境から見た、今買い増すこと自体へのリスクを1〜3行。

ルール:
- 将来の株価を断定しない（「上がる」ではなく「データ上は〜」の形）。
- データに無いことを事実のように書かない。知識で補う場合は「一般に」と明示。
- 最終判断は利用者に委ねる一文で締める。
- Markdownの見出し記号(#)や太字(**)は使わない。上の【】と「・」の箇条書きだけで構成する。

データ:
`;

const ENDPOINT = (model, key) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
const isTransient = (status, raw) => status === 429 || status >= 500 || /quota|rate|exhaust|limit:\s*0|overload|high demand|unavailable|temporarily|try again|resource has been exhausted/i.test(raw || '');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function onRequestPost(context) {
  const key = context.env && context.env.GEMINI_API_KEY;
  if (!key || key === 'xxxxx') return json({ error: 'APIキーが未設定です（Cloudflareの環境変数 GEMINI_API_KEY を設定してください）' });

  let body = null;
  try { body = await context.request.json(); } catch (_) {}
  const data = body && body.data;
  if (!data || typeof data !== 'object') return json({ error: 'data がありません' }, 400);
  const dataStr = JSON.stringify(data);
  if (dataStr.length > 200000) return json({ error: '診断データが大きすぎます' }, 400);

  const models = Array.isArray(body.models) ? body.models.map(s => String(s).trim()).filter(Boolean) : [];
  const chain = models.length ? models.slice(0, 6) : DEFAULT_CHAIN;

  const reqBody = {
    contents: [{ role: 'user', parts: [{ text: PROMPT + dataStr }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 3000 },
  };

  let lastStatus = 0, lastRaw = '';
  for (let i = 0; i < chain.length; i++) {
    const m = chain[i];
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 55000);
      try {
        const res = await fetch(ENDPOINT(m, key), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody), signal: ctrl.signal,
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok) {
          const cand = d.candidates && d.candidates[0];
          const parts = cand && cand.content && cand.content.parts;
          const text = Array.isArray(parts) ? parts.map(p => p.text || '').join('').trim() : '';
          if (text) return json({ text, model: m, fellBack: i > 0, usage: d.usageMetadata || null });
          lastRaw = (cand && cand.finishReason) || (d.promptFeedback && d.promptFeedback.blockReason) || 'empty';
          lastStatus = 200;
          break; // 空応答（安全ブロック等）→次モデルへ
        }
        lastStatus = res.status;
        lastRaw = (d && d.error && d.error.message) || ('HTTP ' + res.status);
        if (!isTransient(res.status, lastRaw)) break;   // このモデルでは無理→次のモデルへ
        // 上限超過は同モデル再試行しても無駄→即次モデルへ。過負荷/5xxのみ再試行
        const isQuota = res.status === 429 || /quota|exhaust|rate|limit/i.test(lastRaw);
        if (attempt === 0 && !isQuota) { await delay(800); continue; }
      } catch (e) {
        lastRaw = (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || String(e));
        if (attempt === 0 && lastRaw !== 'timeout') { await delay(800); continue; }
      } finally { clearTimeout(timer); }
      break; // 次モデルへ
    }
  }
  if (lastRaw === 'timeout') return json({ error: '診断がタイムアウトしました。少し待ってお試しください。' });
  return json({ error: '全モデルが混雑/上限のようです。少し待ってお試しください。（最後のエラー: ' + jpError(lastStatus, lastRaw) + '）', detail: String(lastRaw).slice(0, 300) });
}

// Geminiの英語エラーを日本語のわかりやすい文言に変換（youtube-summary.js と同種）
function jpError(status, raw) {
  const m = String(raw || '').toLowerCase();
  if (status === 429 || m.includes('quota') || m.includes('rate limit') || m.includes('exceeded') || m.includes('exhaust')) return 'Geminiの無料枠の上限に達しました';
  if (status === 400 && (m.includes('api key') || m.includes('api_key'))) return 'APIキーが不正です';
  if (status === 403 || m.includes('permission') || m.includes('forbidden')) return 'APIキーの権限がありません（Generative Language APIの有効化を確認）';
  if (status === 404 || m.includes('not found')) return 'モデルが見つかりません（モデル名の可能性）';
  return String(raw || 'unknown').slice(0, 120);
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
