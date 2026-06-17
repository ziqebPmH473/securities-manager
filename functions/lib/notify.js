// メール通知（Resend）。買い増しサイン一覧をメール本文に整形して送る。
// 通知機能 N3。環境変数: RESEND_API_KEY（必須）/ NOTIFY_EMAIL（受信先）/ NOTIFY_FROM（送信元・既定 onboarding@resend.dev）
//
// 本文・件名はマスタ・設定（store.data.settings.notify）からテンプレート（プレースホルダ式）で
// 自由に組み立てられる。テンプレ未設定の区分は下記 DEFAULT_NOTIFY_TPL にフォールバック。
// ★プレビュー用の同等ロジックがクライアント側 app.js にも二重実装されている（ビルド無し構成のため）。
//   プレースホルダの意味・既定文面を変える時は両方を必ず合わせること。

const RESEND_URL = 'https://api.resend.com/emails';

function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// 既定テンプレート（現行の文面と完全一致）。market 別に上書きされていなければこれを使う。
export const DEFAULT_NOTIFY_TPL = {
  subject: '【{market}】{date} 購入基準価格通知',
  reached: {
    header: '〇到達',
    line: '[{kind}] {ticker} {name}  現在値 {price}({dayChange}) 前回から{dropFromPrev} → 買増ライン {trigger} ／購入額 {buyAmount}',
    empty: '（なし）',
  },
  near: {
    header: '〇接近',
    line: '[{kind}] {ticker} {name}  現在値 {price}({dayChange}) 前回から{dropFromPrev} → 買増ライン {trigger} 残り {remaining} ／購入額 {buyAmount}',
    empty: '（なし）',
  },
};

// settings.notify と market(JP/US/'') から、欠けを既定で埋めた実効テンプレを返す。
export function resolveNotifyTpl(notifyCfg, market) {
  const byMarket = (notifyCfg && notifyCfg.byMarket) || {};
  const m = byMarket[market] || {};
  const d = DEFAULT_NOTIFY_TPL;
  const sec = (key) => ({
    header: (m[key] && m[key].header != null && m[key].header !== '') ? m[key].header : d[key].header,
    line:   (m[key] && m[key].line   != null && m[key].line   !== '') ? m[key].line   : d[key].line,
    empty:  (m[key] && m[key].empty  != null && m[key].empty  !== '') ? m[key].empty  : d[key].empty,
  });
  return {
    subject: (m.subject != null && m.subject !== '') ? m.subject : d.subject,
    reached: sec('reached'),
    near: sec('near'),
  };
}

// テンプレ文字列の {key} を vars[key] に置換。未知のキーはそのまま残す（入力ミスに気づけるように）。
function applyTpl(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (mm, k) => (k in vars ? String(vars[k] ?? '') : mm));
}

// サイン1件 → プレースホルダ変数（整形済み・記号/単位つき）。
function signalVars(s) {
  const sym = (s.market === 'US') ? '$' : '¥';
  const n = (v) => (v == null ? null : v.toLocaleString('en-US', { maximumFractionDigits: 2 }));
  const cur = (v) => (v == null ? '—' : sym + n(v));
  const spct = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%');
  const dpct = (v) => (v == null ? '—' : v.toFixed(1) + '%');
  return {
    kind: s.type === 'initial' ? '初回' : '買増',
    ticker: s.ticker ?? '',
    name: s.name ?? '',
    market: s.market ?? '',
    price: cur(s.price),
    priceRaw: n(s.price) ?? '—',
    dayChange: spct(s.dayChangePct),
    dropFromPrev: dpct(s.dropFromPrev),
    trigger: cur(s.trigger),
    remaining: dpct(s.remainingDropPct),
    buyAmount: s.buyAmount == null ? '—' : sym + n(s.buyAmount),
  };
}

// サイン一覧 → { subject, text, html }。
// dateLabel 例「6/7」、marketLabel 例「米国株」、market は区分キー（'JP'|'US'|''）。
// notifyCfg は store.data.settings.notify（無ければ既定テンプレ）。
export function buildSignalEmail(signals, dateLabel, marketLabel, notifyCfg, market) {
  const reached = signals.filter(s => s.reached);
  const near = signals.filter(s => !s.reached);
  const tpl = resolveNotifyTpl(notifyCfg, market || '');

  const renderLines = (list, lineTpl, emptyTpl) =>
    (list.length ? list.map(s => applyTpl(lineTpl, signalVars(s))).join('\n') : emptyTpl);

  const L = [];
  L.push(tpl.reached.header);
  L.push(renderLines(reached, tpl.reached.line, tpl.reached.empty));
  L.push('');
  L.push(tpl.near.header);
  L.push(renderLines(near, tpl.near.line, tpl.near.empty));
  const text = L.join('\n');

  const subjVars = {
    market: marketLabel || '全市場',
    date: dateLabel || '',
    reachedCount: reached.length,
    nearCount: near.length,
    totalCount: signals.length,
  };
  const subject = applyTpl(tpl.subject, subjVars);
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif"><pre style="font:13px/1.7 ui-monospace,monospace;white-space:pre-wrap;margin:0">${escapeHtml(text)}</pre></div>`;
  return { subject, text, html };
}

// Resend でメール送信
export async function sendResend(env, { subject, text, html }) {
  const key = env && env.RESEND_API_KEY;
  const to = env && env.NOTIFY_EMAIL;
  const from = (env && env.NOTIFY_FROM) || 'onboarding@resend.dev';
  if (!key) throw new Error('RESEND_API_KEY が未設定です');
  if (!to) throw new Error('NOTIFY_EMAIL が未設定です');
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body && (body.message || body.name)) || JSON.stringify(body);
    throw new Error('Resend送信失敗 ' + res.status + '：' + String(msg).slice(0, 400));
  }
  return { id: (body && body.id) || null, to, from };
}
