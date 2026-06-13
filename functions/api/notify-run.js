// 定時通知の実体（N2b+N3+N4）: _appdata読取 → サーバーで現在値取得 → 判定 → メール送信。
// GET /api/notify-run                       … 送信せずプレビュー（本文・サイン一覧）
// GET /api/notify-run?send=1                … 実際にメール送信（Resend）
// GET /api/notify-run?send=1&market=JP      … 日本株のみ（US も可）。定時バッチが市場別に叩く
// GET /api/notify-run?send=1&token=XXX      … NOTIFY_TRIGGER_TOKEN を設定している場合は必須
// GET /api/notify-run?near=3                … 近接の閾値%
import { readAppDataBundle, writePortfolioSnapshot } from '../lib/sheets.js';
import { computeSignals, computeBreakdowns } from '../lib/portfolio.js';
import { fetchFreshPrices, mergeFreshPrices } from '../lib/prices.js';
import { buildSignalEmail, sendResend } from '../lib/notify.js';
import { checkToken } from '../lib/auth.js';

const MARKET_LABEL = { JP: '日本株', US: '米国株' };

export async function onRequestGet(context) {
  try {
    // 保有サインを返す/メールを送るため、トークン必須（外部からの閲覧・送信を防止）
    const auth = checkToken(context);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

    const url = new URL(context.request.url);
    const doSend = url.searchParams.get('send') === '1';
    const near = parseFloat(url.searchParams.get('near'));
    const market = (url.searchParams.get('market') || '').toUpperCase(); // ''|'JP'|'US'

    const bundle = await readAppDataBundle(context.env);
    const fresh = await fetchFreshPrices(url.origin, bundle.securities || []);
    mergeFreshPrices(bundle, fresh);

    let signals = computeSignals(bundle, { nearPct: isFinite(near) ? near : 5 });
    if (market === 'JP' || market === 'US') signals = signals.filter(s => s.market === market);

    // 資産推移: 当日(JST)の円換算総資産を portfolio-history.json へ記録（best-effort・通知には影響させない）。
    // フォルダがSAに「編集者」共有されていないと失敗するが、その場合も snapshot.error に入れて続行。
    let snapshot = null;
    try {
      const t = computeBreakdowns(bundle);
      if (t.totalJpy || t.costJpy) {
        const dateStr = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // JSTの日付
        const rec = { date: dateStr, totalJpy: t.totalJpy, costJpy: t.costJpy, byCategory: t.byCategory, byMarket: t.byMarket, byMarketType: t.byMarketType };
        await writePortfolioSnapshot(context.env, rec);
        snapshot = { date: dateStr, totalJpy: t.totalJpy, costJpy: t.costJpy, byMarket: t.byMarket, byMarketType: t.byMarketType };
      } else snapshot = { skipped: '保有ゼロ/未集計' };
    } catch (e) { snapshot = { error: String(e && e.message || e) }; }

    // 件名の日付は JST（UTC+9）の M/D
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const dateLabel = `${jst.getUTCMonth() + 1}/${jst.getUTCDate()}`;
    const email = buildSignalEmail(signals, dateLabel, MARKET_LABEL[market] || '');

    let sent = null, skipped = null;
    if (doSend) {
      if (signals.length === 0) skipped = 'サインなしのため送信スキップ';
      else sent = await sendResend(context.env, email);
    }

    return json({
      ok: true,
      market: market || 'ALL',
      source: bundle._source || null,
      freshPrices: Object.keys(fresh).length,
      reached: signals.filter(s => s.reached).length,
      near: signals.filter(s => !s.reached).length,
      snapshot,
      sent, skipped,
      subject: email.subject,
      preview: email.text,
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
