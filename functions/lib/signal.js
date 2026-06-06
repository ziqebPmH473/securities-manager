// 買い増しサイン判定の共通コア（クライアント app.js の calc.evaluate と同一ロジック）。
// サーバー（Cloudflare Functions/Cron）でも使えるよう store 等のグローバルに依存しない純関数にする。
// 呼び出し側が「銘柄・ルール・価格・高値・保有・買い取引」の素データを渡し、判定結果を受け取る。
//
// 通知機能 N2（判定のサーバー移植）の土台。原典: app.js calc.lastBuyInfo / baseHigh / baseHighDate / evaluate。
// ※フロント(app.js)は当面そのまま。N2確定時に app.js 側もこのモジュールへ寄せて二重管理を解消する。

// 基準高値モードの解決（銘柄個別上書き > ルール > '5y'）
function resolveMode(baseHighMode, ruleBaseHighMode) {
  return baseHighMode || ruleBaseHighMode || '5y';
}

// 前回購入情報: 買い取引の最新 > 手動の前回購入価格 > 取得単価(みなし)。日付は取引日 or 手動の前回購入日。
export function resolveLastBuy({ buys, prevBuyPrice, prevBuyDate, holding }) {
  const sorted = (buys || []).slice().sort((a, b) => (a.tradedAt < b.tradedAt ? 1 : -1));
  if (sorted.length) return { price: sorted[0].price, source: 'txn', date: sorted[0].tradedAt || null };
  const manualDate = prevBuyDate || null;
  if (typeof prevBuyPrice === 'number') return { price: prevBuyPrice, source: 'manual', date: manualDate };
  const qty = (holding && holding.qty) || 0, avgCost = (holding && holding.avgCost) || 0;
  if (qty > 0 && avgCost > 0) return { price: avgCost, source: 'みなし', date: manualDate };
  return { price: null, source: null, date: manualDate };
}

// 基準高値（モードに応じた 5年/52週/全期間/手動）
export function resolveBaseHigh({ baseHighMode, ruleBaseHighMode, baseHighManual, highs }) {
  const mode = resolveMode(baseHighMode, ruleBaseHighMode);
  if (mode === 'manual') return typeof baseHighManual === 'number' ? baseHighManual : null;
  const p = highs || {};
  if (mode === '52w') return p.high52w || null;
  if (mode === 'all') return p.highAll || p.high5y || null;
  return p.high5y || null; // 5y デフォルト
}

// 基準高値が「付いた日付」(YYYY-MM-DD)。manual・日付未取得は null（高値更新判定を発動させない＝安全側）
export function resolveBaseHighDate({ baseHighMode, ruleBaseHighMode, highs }) {
  const mode = resolveMode(baseHighMode, ruleBaseHighMode);
  if (mode === 'manual') return null;
  const p = highs || {};
  if (mode === '52w') return p.high52wDate || null;
  if (mode === 'all') return p.highAllDate || p.high5yDate || null;
  return p.high5yDate || null; // 5y デフォルト
}

// 買い増し/初回購入の判定。
// 入力:
//   market, enabled, price, fixedBuyPrice, baseHighMode, baseHighManual, prevBuyPrice, prevBuyDate
//   rule: { initialDropPct, addonDropPct, baseHighMode, highResetMode }
//   highs: { high5y, high52w, highAll, high5yDate, high52wDate, highAllDate }
//   holding: { qty, avgCost }
//   buys: [{ price, tradedAt }]
//   recoAmount?: number（任意・推奨購入額。判定には使わずそのまま返す）
// 返り値: { type, base, baseSource, trigger, price, remainingDropPct, reached, recoAmount, recoCcy } または null
export function evaluateSignal(input) {
  const {
    market, enabled, price, fixedBuyPrice,
    baseHighMode, baseHighManual, prevBuyPrice, prevBuyDate,
    rule, highs, holding, buys, recoAmount,
  } = input || {};
  if (market === 'FUND' || enabled === false) return null;
  if (price == null) return null;
  const th = { qty: (holding && holding.qty) || 0, avgCost: (holding && holding.avgCost) || 0 };
  const lb = resolveLastBuy({ buys, prevBuyPrice, prevBuyDate, holding: th });
  const ruleBaseHighMode = rule && rule.baseHighMode;

  const fixed = (typeof fixedBuyPrice === 'number' && fixedBuyPrice > 0) ? fixedBuyPrice : null;
  let type = (th.qty <= 0 && lb.price == null) ? 'initial' : 'addon';
  let base, trigger, baseSource;
  if (fixed != null) {
    // 買増固定値: ルール計算でなく手入力の固定トリガー（丸めなし）
    trigger = fixed; base = fixed; baseSource = '固定';
  } else if (type === 'initial') {
    base = resolveBaseHigh({ baseHighMode, ruleBaseHighMode, baseHighManual, highs }); baseSource = 'high';
    if (base == null) return null;
    trigger = base * (1 - rule.initialDropPct / 100);
  } else {
    const bh = resolveBaseHigh({ baseHighMode, ruleBaseHighMode, baseHighManual, highs });
    const bhDate = resolveBaseHighDate({ baseHighMode, ruleBaseHighMode, highs });
    // 高値更新時は初回ルールで判定（rule.highResetMode）。前回購入より後に最高値更新＝高値の日付が前回購入日より後（時間軸判定）。
    if (rule.highResetMode && lb.date && bhDate && bhDate > lb.date && bh != null) {
      base = bh; baseSource = '高値更新'; trigger = base * (1 - rule.initialDropPct / 100);
    } else {
      base = lb.price != null ? lb.price : bh;
      baseSource = lb.price != null ? lb.source : 'high';
      if (base == null) return null;
      trigger = base * (1 - rule.addonDropPct / 100);
    }
  }
  // 次回購入の丸め（固定値以外・切捨て）: 米株=1ドル単位（10ドル未満は0.1ドル）、日本株=円未満切捨て
  if (fixed == null) {
    if (market === 'US') trigger = trigger >= 10 ? Math.floor(trigger) : Math.floor(trigger * 10) / 10;
    else trigger = Math.floor(trigger);
  }
  const remainingDropPct = (price - trigger) / price * 100; // >0: あとこれだけ下落で到達
  const recoCcy = market === 'US' ? 'USD' : 'JPY';
  return {
    type, base, baseSource, trigger, price, remainingDropPct, reached: price <= trigger,
    recoAmount: recoAmount == null ? null : recoAmount, recoCcy,
    lastBuyPrice: lb.price, lastBuyDate: lb.date, // 前回購入（前回からの下落率の算出用）
  };
}
