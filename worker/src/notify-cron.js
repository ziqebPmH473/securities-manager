// Cloudflare Cron Worker（GitHub非依存）。定時に証券ツールの通知エンドポイントを叩くだけ。
// どの cron で起きたかで市場を決め、/api/notify-run?send=1&market=XX を呼ぶ。
// 環境変数: NOTIFY_BASE_URL（必須・wrangler.toml）/ NOTIFY_TRIGGER_TOKEN（任意・secret）

async function trigger(env, market) {
  const base = env.NOTIFY_BASE_URL;
  const token = env.NOTIFY_TRIGGER_TOKEN || '';
  let url = `${base}/api/notify-run?send=1&market=${market}`;
  if (token) url += `&token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const body = await res.text();
  return { market, status: res.status, body: body.slice(0, 300) };
}

export default {
  // 定時実行（Cron）。event.cron で起動した式が分かる → 市場を決定。
  // 米国株は "0 15,22 * * 1-5"、それ以外（日本株の2式）は JP。
  async scheduled(event, env, ctx) {
    const market = event.cron === '0 15,22 * * 1-5' ? 'US' : 'JP';
    ctx.waitUntil((async () => {
      try {
        const r = await trigger(env, market);
        console.log(`[notify] cron=${event.cron} market=${market} status=${r.status} ${r.body}`);
      } catch (e) {
        console.log(`[notify] error market=${market}: ${e && e.message}`);
      }
    })());
  },

  // 手動テスト用: このWorkerのURLを開くと即送信。?market=JP / ?market=US / 省略で両方。
  // 外部からの悪用を防ぐため token 必須（NOTIFY_TRIGGER_TOKEN を設定し ?token=… で一致）。
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const token = env.NOTIFY_TRIGGER_TOKEN;
    if (!token || url.searchParams.get('token') !== token) {
      return new Response('Not found', { status: 404 });
    }
    const m = (url.searchParams.get('market') || '').toUpperCase();
    const markets = (m === 'JP' || m === 'US') ? [m] : ['JP', 'US'];
    const results = [];
    for (const mk of markets) {
      try { results.push(await trigger(env, mk)); }
      catch (e) { results.push({ market: mk, error: String(e && e.message) }); }
    }
    return new Response(JSON.stringify({ ok: true, results }, null, 2), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  },
};
