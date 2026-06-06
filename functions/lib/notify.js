// メール通知（Resend）。買い増しサイン一覧をメール本文に整形して送る。
// 通知機能 N3。環境変数: RESEND_API_KEY（必須）/ NOTIFY_EMAIL（受信先）/ NOTIFY_FROM（送信元・既定 onboarding@resend.dev）

const RESEND_URL = 'https://api.resend.com/emails';

function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// サイン一覧 → { subject, text, html }。
// dateLabel 例「6/7」、marketLabel 例「米国株」。形式はすみぽん指定（2026-06-07）。
export function buildSignalEmail(signals, dateLabel, marketLabel) {
  const reached = signals.filter(s => s.reached);
  const near = signals.filter(s => !s.reached);
  const sym = (m) => m === 'US' ? '$' : '¥';
  const n = (v) => v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const cur = (s, v) => v == null ? '—' : sym(s.market) + n(v);
  const spct = (v) => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; // 前日比（符号つき）
  const dpct = (v) => v == null ? '—' : v.toFixed(1) + '%';                       // 前回から/残り
  const kind = (s) => s.type === 'initial' ? '初回' : '買増';
  const amt = (s) => s.buyAmount == null ? '—' : sym(s.market) + n(s.buyAmount);
  const head = (s) => `[${kind(s)}] ${s.ticker} ${s.name}  現在値 ${cur(s, s.price)}(${spct(s.dayChangePct)}) 前回から${dpct(s.dropFromPrev)} → 買増ライン ${cur(s, s.trigger)}`;
  const lineReached = (s) => `${head(s)} ／購入額 ${amt(s)}`;
  const lineNear = (s) => `${head(s)} 残り ${dpct(s.remainingDropPct)} ／購入額 ${amt(s)}`;

  const L = [];
  L.push('〇到達');
  L.push(reached.length ? reached.map(lineReached).join('\n') : '（なし）');
  L.push('');
  L.push('〇接近');
  L.push(near.length ? near.map(lineNear).join('\n') : '（なし）');
  const text = L.join('\n');

  const ml = marketLabel || '全市場';
  const subject = `【${ml}】${dateLabel || ''} 購入基準価格通知`;
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
