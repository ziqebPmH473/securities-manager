// N1検証用エンドポイント: サーバーがサービスアカウントで _appdata を読めるか確認する。
// GET /api/sheet-check
// 機密（保有額・銘柄名等）は返さず、件数などの安全なサマリーのみ返す。
import { readAppData } from '../lib/sheets.js';
import { checkToken } from '../lib/auth.js';

export async function onRequestGet(context) {
  try {
    const auth = checkToken(context);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
    const b = await readAppData(context.env);
    const arr = (k) => Array.isArray(b[k]) ? b[k].length : 0;
    const summary = {
      ok: true,
      counts: {
        securities: arr('securities'),
        holdings: arr('holdings'),
        transactions: arr('transactions'),
        rules: arr('rules'),
        categories: arr('categories'),
        prices: b.prices ? Object.keys(b.prices).length : 0,
        meta: b.meta ? Object.keys(b.meta).length : 0,
      },
      lastPriceUpdate: b.lastPriceUpdate || null,
      lastInfoDate: b.lastInfoDate || null,
      hasColPrefs: !!b._colPrefs,
    };
    return json(summary);
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
