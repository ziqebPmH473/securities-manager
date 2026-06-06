// 保有データを返す/メールを送る内部エンドポイントを秘密トークンで保護する。
// 環境変数 NOTIFY_TRIGGER_TOKEN を設定し、?token=<値> か Authorization: Bearer <値> で一致を要求。
// 未設定の場合は「未保護」を避けるため拒否（fail-closed）。

export function checkToken(context) {
  const required = context.env && context.env.NOTIFY_TRIGGER_TOKEN;
  if (!required) return { ok: false, status: 500, error: 'NOTIFY_TRIGGER_TOKEN（保護トークン）が未設定です。Cloudflareに設定してください。' };
  const url = new URL(context.request.url);
  const fromQuery = url.searchParams.get('token');
  const fromHeader = (context.request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const provided = fromQuery || fromHeader;
  if (provided !== required) return { ok: false, status: 401, error: 'トークンが必要です（?token=）' };
  return { ok: true };
}
