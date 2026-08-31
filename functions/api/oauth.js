// Google OAuth の認可コード交換／リフレッシュ（リフレッシュトークン方式・2026-09-01）
// 従来のブラウザ完結GIS暗黙フローは「1時間で失効する入場券」しかもらえず、無音更新も
// サードパーティCookie頼みで失敗しやすく、毎朝ログイン画面が出ていた。
// この関数で「長期の合鍵（refresh_token）」を初回ログイン時に取得し、以後はサーバー経由で
// 入場券を無音再発行する（一般的なWebサービスの「ずっとログイン状態」と同じ仕組み）。
//
// 環境変数: GOOGLE_OAUTH_CLIENT_ID（既存）＋ GOOGLE_CLIENT_SECRET（サーバー専用の秘密の鍵）。
// GOOGLE_CLIENT_SECRET 未設定なら 501 を返し、フロントは従来方式のまま動く（段階導入・設定した瞬間に有効化）。
//
// POST {action:'exchange', code}          → {access_token, refresh_token, expires_in, scope}
// POST {action:'refresh', refresh_token}  → {access_token, refresh_token:null, expires_in, scope}
// refresh_token 自体が秘密（持っている人だけが更新できる）なので追加の認証は不要。
// id_token 等の余計な項目は返さない。
export async function onRequestPost(context) {
  const env = context.env || {};
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID, secret = env.GOOGLE_CLIENT_SECRET;
  const json = (o, status = 200) => new Response(JSON.stringify(o), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
  if (!clientId || !secret) return json({ error: 'not_configured' }, 501);
  let body = null;
  try { body = await context.request.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }
  const params = new URLSearchParams({ client_id: clientId, client_secret: secret });
  if (body && body.action === 'exchange' && body.code) {
    params.set('grant_type', 'authorization_code');
    params.set('code', String(body.code));
    params.set('redirect_uri', 'postmessage'); // GISポップアップ（code client）の決まり文句
  } else if (body && body.action === 'refresh' && body.refresh_token) {
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', String(body.refresh_token));
  } else return json({ error: 'bad_request' }, 400);
  let r, d;
  try {
    r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString(),
    });
    d = await r.json();
  } catch (_) { return json({ error: 'upstream_failed' }, 502); }
  // 400=コード/合鍵が無効（アクセス取り消し等）→フロントは合鍵を破棄して従来方式へフォールバック
  if (!r.ok) return json({ error: (d && d.error) || 'oauth_failed' }, r.status === 400 ? 400 : 502);
  return json({
    access_token: d.access_token,
    refresh_token: d.refresh_token || null, // exchange の初回同意時のみ返る。refresh では null
    expires_in: d.expires_in,
    scope: d.scope || '',
  });
}
