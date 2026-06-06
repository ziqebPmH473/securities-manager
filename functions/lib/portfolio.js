// バンドル（_appdata から読んだ store.data 相当）→ 買い増しサイン一覧を計算する（サーバー側）。
// 判定そのものは signal.js（クライアントと同一ロジック）。ここはデータの取り回し（保有集計・ルール解決・価格参照）。
// 通知機能 N2。原典: app.js calc.totalHolding / evaluate / buyAmount, store.categoryAmountFor, priceKey。
import { evaluateSignal } from './signal.js';

function priceKey(sec) { return `${sec.market}:${sec.ticker}`; }

function ruleFor(bundle, sec) {
  const rules = bundle.rules || [];
  return rules.find(r => r.id === sec.ruleId) || rules.find(r => r.isDefault) || rules[0] || {};
}

function totalHolding(bundle, secId) {
  const hs = (bundle.holdings || []).filter(h => h.securityId === secId);
  let qty = 0, cost = 0;
  for (const h of hs) { qty += (h.quantity || 0); cost += (h.avgCost || 0) * (h.quantity || 0); }
  return { qty, avgCost: qty > 0 ? cost / qty : 0 };
}

function categoryAmount(bundle, cat, market) {
  const c = (bundle.categories || []).find(x => x.category === cat);
  if (!c) return null;
  if (market === 'US') return c.amountUsd != null ? c.amountUsd : (c.amountJpy || 0) / 100;
  return c.amountJpy || 0;
}

// 1銘柄の判定（バンドル＋キャッシュ価格を使う）。価格未取得や投信・無効は null。
export function evalSecurity(bundle, sec) {
  const p = (bundle.prices || {})[priceKey(sec)] || {};
  const rule = ruleFor(bundle, sec);
  const th = totalHolding(bundle, sec.id);
  const buys = (bundle.transactions || [])
    .filter(t => t.securityId === sec.id && t.type === 'buy')
    .map(t => ({ price: t.price, tradedAt: t.tradedAt }));
  const recoAmount = (sec.buyAmount != null && sec.buyAmount !== '')
    ? Number(sec.buyAmount)
    : (categoryAmount(bundle, sec.category, sec.market) || null);
  return evaluateSignal({
    market: sec.market, enabled: sec.enabled, price: p.price == null ? null : p.price,
    fixedBuyPrice: sec.fixedBuyPrice, baseHighMode: sec.baseHighMode, baseHighManual: sec.baseHighManual,
    prevBuyPrice: sec.prevBuyPrice, prevBuyDate: sec.prevBuyDate,
    rule: { initialDropPct: rule.initialDropPct, addonDropPct: rule.addonDropPct, baseHighMode: rule.baseHighMode, highResetMode: rule.highResetMode },
    highs: p, holding: th, buys, recoAmount,
  });
}

// 買い増しサイン（到達 or 残り下落率 <= nearPct）の銘柄一覧。到達→残り少ない順。
export function computeSignals(bundle, opts = {}) {
  const nearPct = opts.nearPct != null ? opts.nearPct : 5;
  const out = [];
  for (const sec of (bundle.securities || [])) {
    const ev = evalSecurity(bundle, sec);
    if (!ev || ev.remainingDropPct == null) continue;
    const hit = ev.reached || ev.remainingDropPct <= nearPct;
    if (!hit) continue;
    out.push({
      ticker: sec.ticker, market: sec.market,
      type: ev.type, baseSource: ev.baseSource,
      price: ev.price, trigger: ev.trigger,
      remainingDropPct: Math.round(ev.remainingDropPct * 10) / 10,
      reached: ev.reached,
      recoAmount: ev.recoAmount, recoCcy: ev.recoCcy,
    });
  }
  out.sort((a, b) => (a.reached === b.reached ? a.remainingDropPct - b.remainingDropPct : (a.reached ? -1 : 1)));
  return out;
}
