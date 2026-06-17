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

function displayName(bundle, sec) {
  if (sec.nameOverride) return sec.nameOverride;
  const meta = (bundle.meta || {})[priceKey(sec)] || {};
  return meta.name || sec.name || sec.ticker;
}
const round1 = (v) => v == null ? null : Math.round(v * 10) / 10;
const round2 = (v) => v == null ? null : Math.round(v * 100) / 100;
const numOrNull = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
const pctFromBase = (price, base) => (price != null && base) ? (price - base) / base * 100 : null;

// 最後に購入した証券会社（買い取引の最新→無ければ保有の最新更新）。app.js calc.lastBroker と同等。
function lastBroker(bundle, sec) {
  const buys = (bundle.transactions || [])
    .filter(t => t.securityId === sec.id && t.type === 'buy' && t.broker)
    .sort((a, b) => (a.tradedAt < b.tradedAt ? 1 : -1));
  if (buys.length) return buys[0].broker;
  const hs = (bundle.holdings || []).filter(h => h.securityId === sec.id && h.broker);
  if (!hs.length) return null;
  hs.sort((a, b) => {
    const aq = h => (h.quantity > 0 ? 1 : 0);
    if (aq(a) !== aq(b)) return aq(b) - aq(a);
    return (a.updatedAt || '') < (b.updatedAt || '') ? 1 : -1;
  });
  return hs[0].broker || null;
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
    const p = (bundle.prices || {})[priceKey(sec)] || {};
    const meta = (bundle.meta || {})[priceKey(sec)] || {};
    const rule = ruleFor(bundle, sec);
    const th = totalHolding(bundle, sec.id);
    const price = ev.price;
    const dayChangePct = (price != null && p.prevClose) ? (price - p.prevClose) / p.prevClose * 100 : null;
    const dropFromPrev = (price != null && ev.lastBuyPrice) ? (price - ev.lastBuyPrice) / ev.lastBuyPrice * 100 : null;
    // 保有・損益
    const valueN = (th.qty > 0 && price != null) ? th.qty * price : null;
    const costN = (th.qty > 0) ? th.qty * th.avgCost : null;
    const pnl = (th.qty > 0 && th.avgCost > 0 && price != null) ? (price - th.avgCost) / th.avgCost * 100 : null;
    const buyCount = (bundle.transactions || []).filter(t => t.securityId === sec.id && t.type === 'buy').length;
    // ファンダ（meta。app.js calc.* と同等の随時算出つき）
    const eps = numOrNull(meta.eps);
    const per = (eps && eps > 0 && price != null) ? price / eps : numOrNull(meta.per);
    const dividend = meta.dividend != null ? meta.dividend : ((meta.divYield != null && price != null) ? meta.divYield / 100 * price : null);
    const divYield = meta.divYield != null ? meta.divYield : ((meta.dividend != null && price) ? meta.dividend / price * 100 : null);
    const yieldOnCost = (dividend != null && th.avgCost) ? dividend / th.avgCost * 100 : null;
    const marketCap = (meta.sharesOut && price != null) ? price * meta.sharesOut / 1e6 : numOrNull(meta.marketCap); // 単位:百万
    // 適用区分（初/増/高/固）
    const trigBasis = ev.baseSource === '固定' ? '固' : ev.baseSource === '高値更新' ? '高' : ev.type === 'initial' ? '初' : '増';
    out.push({
      ticker: sec.ticker, market: sec.market, name: displayName(bundle, sec),
      type: ev.type, baseSource: ev.baseSource,
      price, dayChangePct: round2(dayChangePct), dropFromPrev: round1(dropFromPrev),
      trigger: ev.trigger, remainingDropPct: round1(ev.remainingDropPct),
      reached: ev.reached,
      buyAmount: ev.recoAmount, ccy: ev.recoCcy,
      // ▼追加: 表（サイン一覧）に出せる項目すべて
      base: ev.base, trigBasis,
      prevBuyPrice: ev.lastBuyPrice, prevBuyDate: ev.lastBuyDate,
      prevClose: numOrNull(p.prevClose),
      dayAmt: (price != null && p.prevClose != null) ? round2(price - p.prevClose) : null,
      high5y: numOrNull(p.high5y), high52w: numOrNull(p.high52w), low1y: numOrNull(p.low1y), low3y: numOrNull(p.low3y),
      dropFrom5y: round1(pctFromBase(price, p.high5y)), dropFrom52w: round1(pctFromBase(price, p.high52w)),
      riseFrom1y: round1(pctFromBase(price, p.low1y)), riseFrom3y: round1(pctFromBase(price, p.low3y)),
      qty: th.qty || null, avgCost: th.qty > 0 ? th.avgCost : null,
      value: valueN != null ? Math.round(valueN) : null, cost: costN != null ? Math.round(costN) : null,
      pnl: round1(pnl), buyCount: buyCount || null,
      category: sec.category || null, ruleName: rule.name || null,
      rating: sec.rating || sec.overallGrade || null,
      fixedBuyPrice: typeof sec.fixedBuyPrice === 'number' ? sec.fixedBuyPrice : null,
      broker: lastBroker(bundle, sec),
      sector: meta.sector || null, industry: meta.industry || null,
      marketCap, dividend, divYield: round2(divYield), yieldOnCost: round2(yieldOnCost),
      per: round2(per), pbr: numOrNull(meta.pbr), eps,
      marginRatio: numOrNull(meta.marginRatio),
    });
  }
  out.sort((a, b) => (a.reached === b.reached ? a.remainingDropPct - b.remainingDropPct : (a.reached ? -1 : 1)));
  return out;
}

// 資産推移用: 円換算の総資産・取得原価（保有>0 の日本株・米国株を合算）。為替は bundle.fx.USDJPY。
// 価格未取得は取得単価で代替。為替未取得の米株は合計から除外。
export function computeTotalsJpy(bundle) {
  const fx = bundle.fx && (bundle.fx.USDJPY != null ? bundle.fx.USDJPY : bundle.fx.usdjpy);
  const rate = (fx != null && isFinite(fx)) ? fx : null;
  let totalJpy = 0, costJpy = 0;
  for (const sec of (bundle.securities || [])) {
    if (sec.market !== 'JP' && sec.market !== 'US') continue;
    const th = totalHolding(bundle, sec.id);
    if (!(th.qty > 0)) continue;
    const p = (bundle.prices || {})[priceKey(sec)] || {};
    const price = (p.price != null) ? p.price : th.avgCost; // 価格未取得は取得単価で代替
    const valN = th.qty * price, costN = th.qty * th.avgCost;
    if (sec.market === 'US') {
      if (rate == null) continue; // 為替未取得の米株は合計から除外
      totalJpy += valN * rate; costJpy += costN * rate;
    } else {
      totalJpy += valN; costJpy += costN;
    }
  }
  return { totalJpy: Math.round(totalJpy), costJpy: Math.round(costJpy) };
}

// 資産推移（積み上げ）用: 総資産・取得原価＋内訳（カテゴリ別/市場別/市場×種別ETF・個別）を円換算で返す。
export function computeBreakdowns(bundle) {
  const fx = bundle.fx && (bundle.fx.USDJPY != null ? bundle.fx.USDJPY : bundle.fx.usdjpy);
  const rate = (fx != null && isFinite(fx)) ? fx : null;
  let totalJpy = 0, costJpy = 0;
  const byCategory = {}, byMarket = {}, byMarketType = {};
  const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };
  for (const sec of (bundle.securities || [])) {
    if (sec.market !== 'JP' && sec.market !== 'US') continue;
    const th = totalHolding(bundle, sec.id);
    if (!(th.qty > 0)) continue;
    const p = (bundle.prices || {})[priceKey(sec)] || {};
    const price = (p.price != null) ? p.price : th.avgCost;
    let valJpy = th.qty * price, costJ = th.qty * th.avgCost;
    if (sec.market === 'US') { if (rate == null) continue; valJpy *= rate; costJ *= rate; }
    valJpy = Math.round(valJpy); costJ = Math.round(costJ);
    totalJpy += valJpy; costJpy += costJ;
    // ラベルは取込/クライアントと一致: 市場=日本株/米国株、種別=ETF/個別株。
    // ETF判定は app.js detailTypeOf 相当（保存値→meta.quoteType→銘柄名にETF）。
    const mk = sec.market === 'JP' ? '日本株' : '米国株';
    const meta = (bundle.meta || {})[priceKey(sec)] || {};
    const nm = displayName(bundle, sec) || '';
    const dt = sec.detailType || (((meta.quoteType || '').toUpperCase() === 'ETF' || /ETF|ＥＴＦ/i.test(nm)) ? 'ETF' : '個別株');
    const isETF = (dt === 'ETF');
    add(byCategory, isETF ? 'ETF' : (sec.category || '未分類'), valJpy); // ETFはカテゴリ別バンドとして分離
    add(byMarket, mk, valJpy);
    add(byMarketType, `${mk}・${isETF ? 'ETF' : '個別株'}`, valJpy);
  }
  return { totalJpy, costJpy, byCategory, byMarket, byMarketType };
}
