// GET /api/portfolio-history … 資産推移（日次総資産）を返す。クライアントの折れ線グラフ用。
// 総資産＝純資産に近い機微情報のため、クライアントのGoogleログイントークン（Authorization: Bearer <token>）を
// 検証し、(1) トークンが本アプリのクライアントID向け かつ (2) 許可メール(settings.google.allowedEmails)に一致
// する場合のみ返す。許可メール未設定なら本アプリ向けトークンであれば許可（クライアント側の挙動に合わせる）。
import { readPortfolioHistory, verifyGoogleToken, readAppDataBundle } from '../lib/sheets.js';

export async function onRequestGet(context) {
  try {
    const token = (context.request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ ok: false, error: 'Googleログインが必要です（資産推移は本人のみ閲覧可）。' }, 401);

    const info = await verifyGoogleToken(token);
    if (!info || !info.email) return json({ ok: false, error: 'トークンを検証できませんでした。再ログインしてください。' }, 401);

    // 本アプリのOAuthクライアントID向けトークンか（他アプリのトークンを弾く）
    const clientId = context.env && context.env.GOOGLE_OAUTH_CLIENT_ID;
    if (clientId && info.aud && info.aud !== clientId) return json({ ok: false, error: 'このアプリ向けのログインではありません。' }, 403);

    // 許可メール照合（バンドルの settings.google.allowedEmails。未設定なら本アプリ向けトークンで許可）
    let allowed = [];
    try {
      const bundle = await readAppDataBundle(context.env);
      const raw = bundle && bundle.settings && bundle.settings.google && bundle.settings.google.allowedEmails;
      allowed = String(raw || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    } catch (_) { /* 読めない場合は allowed 空のまま＝本アプリ向けトークンで許可 */ }
    if (allowed.length && !allowed.includes(info.email)) return json({ ok: false, error: '許可されていないアカウントです: ' + info.email }, 403);

    const { snapshots } = await readPortfolioHistory(context.env);
    return json({ ok: true, snapshots });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
