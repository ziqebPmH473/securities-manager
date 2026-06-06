// N2b+N3 検証用: _appdata読取 → サーバーで現在値を取得 → 買い増しサイン計算 → メール本文を作成。
// GET /api/notify-run            … 送信せずプレビュー（メール本文・サイン一覧を返す）
// GET /api/notify-run?send=1     … 実際にメール送信（Resend）
// GET /api/notify-run?near=3     … 近接の閾値%を変更
import { readAppData } from '../lib/sheets.js';
import { computeSignals } from '../lib/portfolio.js';
import { fetchFreshPrices, mergeFreshPrices } from '../lib/prices.js';
import { buildSignalEmail, sendResend } from '../lib/notify.js';

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const doSend = url.searchParams.get('send') === '1';
    const near = parseFloat(url.searchParams.get('near'));

    const bundle = await readAppData(context.env);
    const fresh = await fetchFreshPrices(url.origin, bundle.securities || []);
    mergeFreshPrices(bundle, fresh);

    const signals = computeSignals(bundle, { nearPct: isFinite(near) ? near : 5 });
    const asOf = new Date().toISOString() + '（サーバー取得の最新値）';
    const email = buildSignalEmail(signals, asOf);

    let sent = null;
    if (doSend) sent = await sendResend(context.env, email);

    return json({
      ok: true,
      freshPrices: Object.keys(fresh).length,
      reached: signals.filter(s => s.reached).length,
      near: signals.filter(s => !s.reached).length,
      sent,                       // ?send=1 のとき送信結果
      subject: email.subject,
      preview: email.text,        // メール本文プレビュー
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
