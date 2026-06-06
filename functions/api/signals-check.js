// N2検証用エンドポイント: サーバーが _appdata を読み、買い増しサインを計算できるか確認する。
// GET /api/signals-check  （?near=5 で残り下落率の閾値%を変更可）
// キャッシュ価格（最後の「価格更新」時点）で判定するため、アプリの「サイン」タブと一致するはず。
import { readAppData } from '../lib/sheets.js';
import { computeSignals } from '../lib/portfolio.js';

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const near = parseFloat(url.searchParams.get('near'));
    const bundle = await readAppData(context.env);
    const signals = computeSignals(bundle, { nearPct: isFinite(near) ? near : 5 });
    return json({
      ok: true,
      asOf: bundle.lastPriceUpdate || null,
      reached: signals.filter(s => s.reached).length,
      near: signals.filter(s => !s.reached).length,
      count: signals.length,
      signals,
    });
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
