// メール通知（Resend）。買い増しサイン一覧をメール本文に整形して送る。
// 通知機能 N3。環境変数: RESEND_API_KEY（必須）/ NOTIFY_EMAIL（受信先）/ NOTIFY_FROM（送信元・既定 onboarding@resend.dev）

const RESEND_URL = 'https://api.resend.com/emails';

function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// サイン一覧 → { subject, text, html }。marketLabel は件名・見出しに付ける任意ラベル（例「日本株」）
export function buildSignalEmail(signals, asOf, marketLabel) {
  const ml = marketLabel ? ` ${marketLabel}` : '';
  const reached = signals.filter(s => s.reached);
  const near = signals.filter(s => !s.reached);
  const cur = (s, v) => v == null ? '—' : (s.market === 'US' ? '$' : '¥') + v;
  const line = (s) => {
    const kind = s.type === 'initial' ? '初回' : '買増';
    const reco = s.recoAmount != null ? `／推奨 ${(s.recoCcy === 'USD' ? '$' : '¥')}${s.recoAmount}` : '';
    return `・[${kind}] ${s.ticker}（${s.market}）  現在 ${cur(s, s.price)} → 次回 ${cur(s, s.trigger)}  残り ${s.remainingDropPct}%${reco}`;
  };
  const L = [];
  L.push(`買い増しサイン通知${ml}`);
  L.push(`基準価格: ${asOf || '—'}`);
  L.push('');
  L.push(`■ 到達（今が買い時）: ${reached.length}件`);
  L.push(reached.length ? reached.map(line).join('\n') : '（なし）');
  L.push('');
  L.push(`■ もうすぐ（残りわずか）: ${near.length}件`);
  L.push(near.length ? near.map(line).join('\n') : '（なし）');
  const text = L.join('\n');
  const subject = `【買い増しサイン${ml}】到達 ${reached.length}件 / もうすぐ ${near.length}件`;
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
