// クライアント向けの「公開設定」を返す（秘密でない値のみ）。
// OAuthクライアントIDやスプレッドシートIDをリポジトリに置かず Cloudflare env から配る。
// これらは元々ブラウザに露出する公開情報なのでトークン保護は不要。
// 環境変数: GOOGLE_OAUTH_CLIENT_ID（ブラウザOAuthのクライアントID）/ GOOGLE_SHEET_ID（スプレッドシートID）
export async function onRequestGet(context) {
  const env = context.env || {};
  return new Response(JSON.stringify({
    clientId: env.GOOGLE_OAUTH_CLIENT_ID || null,
    spreadsheetId: env.GOOGLE_SHEET_ID || null,
  }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'max-age=300' } });
}
