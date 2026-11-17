// 寄り付きランキング（日本株・東証の市場区分別 値上がり率／値下がり率 上位）。
// GET /api/open-ranking                       … ランキングJSON（アプリの「寄り付き」画面用。公開データのみ）
// GET /api/open-ranking?send=1&token=XXX      … メール送信（Cron が平日 JST 9:10 に叩く）
// GET /api/open-ranking?min=100&count=10      … 低位株の除外基準（円・既定100）／各ランキングの件数（既定10）
//
// 取得元は Yahoo!ファイナンス日本版のランキング（東証はリアルタイム表示）。9:10 時点の「前日終値からの騰落率」
// ＝寄り付き直後の値動き。寄り付いていない（特別気配の）銘柄はランキングに載らないことがある。
// 100円未満（低位株）は除外。上位に低位株が多くて10件に満たない時は2ページ目（51〜100位）まで見る。
// サブリクエスト: 3区分×2種×最大2ページ = 最大12回（＋送信時の_appdata読取・メール送信）。上限50に収まる。
import { rankJpPage } from '../lib/jp-ranking.js';
import { readAppDataBundle } from '../lib/sheets.js';
import { sendResend } from '../lib/notify.js';
import { checkToken } from '../lib/auth.js';

const SEGMENTS = [['prime', 'プライム'], ['standard', 'スタンダード'], ['growth', 'グロース']];

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const doSend = url.searchParams.get('send') === '1';
  const min = num(url.searchParams.get('min'), 100);
  const count = Math.min(30, Math.max(1, Math.round(num(url.searchParams.get('count'), 10))));
  try {
    if (doSend) {
      const auth = checkToken(context);
      if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
    }
    const data = await buildOpenRanking(min, count);

    // preview=1: メール本文の確認用（登録銘柄の印なし・送信しない）
    if (!doSend && url.searchParams.get('preview') === '1') { const e = buildEmail(data, null, min); return json({ ok: true, subject: e.subject, preview: e.text }); }
    if (!doSend) return json({ ok: true, ...data });

    // 休場日（土日祝・年末年始）はランキングが前営業日のまま → 送らない
    if (!data.tradingDay) return json({ ok: true, skipped: `本日の更新がないため送信スキップ（休場日の可能性。ランキング更新日時: ${data.updatedAt || '不明'}）`, updatedAt: data.updatedAt });

    // 登録銘柄・保有銘柄に印を付ける（best-effort。読めなくても送る）
    let mine = null;
    try { mine = myCodes(await readAppDataBundle(context.env)); } catch (_) { mine = null; }
    const email = buildEmail(data, mine, min);
    const sent = await sendResend(context.env, email);
    return json({ ok: true, sent, subject: email.subject, preview: email.text });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}

async function buildOpenRanking(min, count) {
  const jobs = [];
  for (const [sub] of SEGMENTS) for (const kind of ['gainers', 'losers']) jobs.push(topFiltered(kind, sub, min, count));
  const res = await Promise.all(jobs);
  let updatedAt = null;
  const segments = SEGMENTS.map(([sub, label], i) => {
    const g = res[i * 2], l = res[i * 2 + 1];
    for (const r of [g, l]) if (r.updatedAt && (!updatedAt || r.updatedAt > updatedAt)) updatedAt = r.updatedAt;
    return { sub, label, gainers: g.items, losers: l.items, error: g.error || l.error || null };
  });
  const today = jstNow().toISOString().slice(0, 10).replace(/-/g, '/'); // "2026/11/18"
  return { date: today, updatedAt, tradingDay: !!(updatedAt && updatedAt.startsWith(today)), min, count, segments };
}

// 1区分×1種類: 100円未満を除いて上位count件。足りなければ2ページ目も見る。
async function topFiltered(kind, sub, min, count) {
  const out = []; let updatedAt = null; let error = null;
  for (let page = 1; page <= 2 && out.length < count; page++) {
    try {
      const r = await rankJpPage(kind, sub, page, { cacheTtl: 30 });
      if (!updatedAt) updatedAt = r.updatedAt;
      for (const it of r.items) {
        if (out.length >= count) break;
        if (it.price == null || it.price < min || it.changePct == null) continue;
        out.push({ code: it.code, name: it.name, price: it.price, prevClose: it.prevClose, changePct: it.changePct, volume: it.volume });
      }
      if (r.items.length < 50) break; // 最終ページ
    } catch (e) { error = String(e && e.message || e); break; }
  }
  return { items: out, updatedAt, error };
}

// 登録銘柄（日本株）のコード → '保有' | '登録'
function myCodes(bundle) {
  const m = new Map();
  const secs = (bundle && bundle.securities) || [];
  const held = new Set(((bundle && bundle.holdings) || []).filter(h => (+h.quantity || 0) > 0).map(h => h.securityId));
  for (const s of secs) {
    if (!s || s.deleted || s.market !== 'JP' || !s.ticker) continue;
    const code = String(s.ticker).replace(/\.T$/i, '').toUpperCase();
    m.set(code, held.has(s.id) ? '保有' : (m.get(code) || '登録'));
  }
  return m;
}

function buildEmail(data, mine, min) {
  const t = jstNow();
  const dateLabel = `${t.getUTCMonth() + 1}/${t.getUTCDate()}`;
  const asOf = data.updatedAt ? data.updatedAt.slice(11) : '';
  const subject = `寄り付きランキング ${dateLabel}${asOf ? `（${asOf}時点）` : ''}`;
  const mark = c => { const v = mine && mine.get(c); return v === '保有' ? '★' : v === '登録' ? '☆' : '　'; };
  const pct = v => (v > 0 ? '+' : '') + v.toFixed(2) + '%';
  const yen = v => v == null ? '—' : v.toLocaleString('ja-JP', { maximumFractionDigits: 1 });
  const line = (it, i) => `${String(i + 1).padStart(2, ' ')}. ${mark(it.code)}${it.code} ${it.name}  ${pct(it.changePct)}  ${yen(it.price)}円（前日 ${yen(it.prevClose)}）`;
  const L = [];
  L.push(`東証 市場区分別の値上がり率・値下がり率 上位${data.count}（${min}円未満は除外）`);
  L.push(`ランキング更新: ${data.updatedAt || '不明'}　★=保有中 ☆=登録銘柄`);
  for (const s of data.segments) {
    L.push('', `■ ${s.label}`);
    if (s.error) L.push(`  ※取得エラー: ${s.error}`);
    L.push('【値上がり率】');
    if (!s.gainers.length) L.push('  （該当なし）'); else s.gainers.forEach((it, i) => L.push(line(it, i)));
    L.push('【値下がり率】');
    if (!s.losers.length) L.push('  （該当なし）'); else s.losers.forEach((it, i) => L.push(line(it, i)));
  }
  L.push('', '※9:10時点の前日終値比。寄り付いていない（特別気配の）銘柄は載らないことがあります。');
  const text = L.join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif"><pre style="font:13px/1.7 ui-monospace,monospace;white-space:pre-wrap;margin:0">${escapeHtml(text)}</pre></div>`;
  return { subject, text, html };
}

function jstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function num(v, d) { const n = parseFloat(v); return isFinite(n) ? n : d; }
function escapeHtml(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
