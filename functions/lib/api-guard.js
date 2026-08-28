// 鍵つきAPI（Gemini / Finnhub / FRED / e-Stat / Workers AI）を第三者の直叩きから守る。
//
// 通す条件は次のいずれか:
//   (a) NOTIFY_TRIGGER_TOKEN 一致 … 定時通知Cronなどサーバー内部からの呼び出し
//   (b) 本アプリのGoogleアクセストークン（aud = GOOGLE_OAUTH_CLIENT_ID）で、
//       かつ ALLOWED_EMAILS に含まれるメールアドレス
//
// ALLOWED_EMAILS 未設定なら「本アプリにログインできた人なら誰でも」まで緩む（aud照合のみ）。
// GOOGLE_OAUTH_CLIENT_ID 未設定（＝ローカル wrangler で .dev.vars 無し）なら検証不能なので通す。
// 本番では両方 Cloudflare の環境変数に設定してあることが前提。
//
// tokeninfo は1リクエストごとに叩くと遅い（/api/price は40銘柄ずつ分割で何度も呼ばれる）ため、
// 同一 isolate 内で5分だけ結果をキャッシュする。

const CACHE = new Map();          // accessToken → { at, info }
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 50;             // isolate は使い捨てだが念のため上限を設ける

function bearer(request) {
  return (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
}

async function tokenInfo(accessToken) {
  const hit = CACHE.get(accessToken);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.info;
  let info = null;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(accessToken));
    if (r.ok) {
      const d = await r.json();
      info = { email: String(d.email || '').toLowerCase(), aud: d.aud || d.azp || '' };
    }
  } catch (_) { info = null; }
  if (CACHE.size >= CACHE_MAX) CACHE.clear();
  CACHE.set(accessToken, { at: Date.now(), info });
  return info;
}

// 通ってよければ null、ダメなら Response（そのまま return できる）を返す。
export async function guardApi(context) {
  const { request, env } = context;

  // (a) 内部トークン（Cron・サーバー間呼び出し）
  const internal = env && env.NOTIFY_TRIGGER_TOKEN;
  if (internal) {
    const url = new URL(request.url);
    const provided = url.searchParams.get('token') || bearer(request);
    if (provided && provided === internal) return null;
  }

  // 検証材料が無い環境（ローカル開発）は素通し
  const clientId = env && env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) return null;

  // (b) 本アプリのGoogleログイン
  const token = bearer(request);
  if (!token) return deny('このAPIはログインが必要です。アプリからGoogleログインしてください。', 401);

  const info = await tokenInfo(token);
  if (!info || !info.email) return deny('トークンを検証できませんでした。再ログインしてください。', 401);
  if (info.aud !== clientId) return deny('このアプリ向けのログインではありません。', 403);

  const allowed = String((env && env.ALLOWED_EMAILS) || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(info.email)) {
    return deny('許可されていないアカウントです: ' + info.email, 403);
  }
  return null;
}

function deny(error, status) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
