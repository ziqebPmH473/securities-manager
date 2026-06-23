// テクニカル分析エンジン（チャートパターン判定＋ローソク足描画）。
// 外部ライブラリ不要・純JavaScript。globalThis.TA として公開し app.js から使う。
// 設計: ANALYSIS_PLAN.md（§3 共通部品 / §3.5 計測と採点の分離 / §4 パターン条件 / §6 描画）
//   - measure(bars, struct) … データ依存の「計測」。実測値(metrics)・水準(levels)・MA・ピボットを出す
//   - score(measure, thresholds) … しきい値依存の「採点」。metrics をしきい値と比較して加点
//   - analyze = score(measure(...)) … 1銘柄ぶんの結果
// パターン算出は Yahoo quote の分割調整済み OHLC（split-adjusted）をそのまま使う。

(function () {
  'use strict';

  // ===== 既定しきい値（§4 の数値・ChatGPT整理を初期値に。画面で変更可） =====
  const DEFAULT_THRESHOLDS = {
    common: {
      breakPct: 2,        // ブレイク: 終値が水準を何%超えたら突破とみなすか
      volMult: 1.5,       // 出来高増: 20日平均の何倍で「増加」とみなすか
      volMultWeak: 1.3,   // 弱め条件用
    },
    cup: {
      priorRisePct: 30,   // 事前上昇（過去3〜12か月）
      cupDepthMin: 12, cupDepthMax: 35,     // カップ深さ%
      cupDaysMin: 35, cupDaysMax: 325,      // カップ期間(営業日)
      rightLeftRatio: 0.90,                 // 右高値 ≥ 左高値×?
      handleDepthMin: 3, handleDepthMax: 15,// ハンドル深さ%
    },
    range: {
      lookbackMin: 60, lookbackMax: 250,    // レンジ期間(営業日)
      widthMin: 10, widthMax: 50,           // レンジ幅%
      touchHigh: 2, touchLow: 2,            // 上限接触/下限反発の回数
      inRangeRatio: 80,                     // レンジ内滞在率%
    },
    doubleBottom: {
      priorDropPct: 20,   // 事前下落
      lowGapPct: 8,       // 2安値の近さ(以内%)
      low2FloorPct: 3,    // 第2安値が第1安値を下回ってよい上限%（=low1×(1-?)）
      reboundPct: 10,     // 中間反発%
    },
    ascTriangle: {
      flatTopPct: 5,      // 上値抵抗線の水平さ(ばらつき%以内)
      narrowing: 0.7,     // 値幅縮小(直近/初期 ≤ ?)
    },
  };

  // 構造検出パラメータ（ピボット窓・接近許容）。変更時は再計測が要る（§3.5）。
  const DEFAULT_STRUCT = {
    pivotWin: 5,        // ピボット検出の前後本数（日足）
    touchTolPct: 5,     // 「水準への接近」の許容%（接触カウント用）
    weeklyForLong: true,// 3年以上は表示を週足ローソクにする
  };

  // ===== 数値ヘルパ =====
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const pct = (a, b) => (b ? (a - b) / b * 100 : 0);

  // 単純移動平均。配列長と同じ長さで返し、足りない区間は null。
  function sma(vals, period) {
    const out = new Array(vals.length).fill(null);
    let sum = 0, cnt = 0;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (isNum(v)) { sum += v; cnt++; }
      if (i >= period) { const old = vals[i - period]; if (isNum(old)) { sum -= old; cnt--; } }
      if (i >= period - 1 && cnt > 0) out[i] = sum / cnt;
    }
    return out;
  }

  // ATR(平均真の値幅)。直近値のみ返す（参考指標）。
  function atr(bars, period) {
    if (bars.length < 2) return null;
    let sum = 0, n = 0;
    for (let i = Math.max(1, bars.length - period); i < bars.length; i++) {
      const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
      const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      if (isNum(tr)) { sum += tr; n++; }
    }
    return n ? sum / n : null;
  }

  // 直近 period 本の平均出来高（i を含まず i 直前まで）。
  function avgVol(bars, i, period) {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - period); k < i; k++) { const v = bars[k].v; if (isNum(v) && v > 0) { sum += v; n++; } }
    return n ? sum / n : 0;
  }

  // 日足→週足集約（週内: 始=最初/高=最大/安=最小/終=最後/出来高=合計）。
  function toWeekly(bars) {
    const out = [];
    let cur = null, curKey = null;
    for (const b of bars) {
      const d = new Date(b.t * 1000);
      // ISO週キー（年＋週番号の近似: 木曜基準でなく簡易に「年+週」で十分）
      const onejan = Date.UTC(d.getUTCFullYear(), 0, 1);
      const wk = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - onejan) / 86400000 / 7);
      const key = d.getUTCFullYear() * 100 + wk;
      if (key !== curKey) {
        if (cur) out.push(cur);
        cur = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 };
        curKey = key;
      } else {
        cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += (b.v || 0); cur.t = b.t;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  // ピボット高値/安値（終値ベース。ヒゲ誤判定を避ける）。前後 win 本の中で極値となる位置。
  function pivots(closes, win) {
    const hi = [], lo = [];
    for (let i = win; i < closes.length - win; i++) {
      let isH = true, isL = true;
      for (let k = i - win; k <= i + win; k++) {
        if (k === i) continue;
        if (closes[k] >= closes[i]) isH = false;
        if (closes[k] <= closes[i]) isL = false;
      }
      if (isH) hi.push(i);
      if (isL) lo.push(i);
    }
    return { hi, lo };
  }

  // 区間 [a,b] の最大高値/最小安値の位置と値
  function maxHigh(bars, a, b) { let mi = a, mv = -Infinity; for (let i = a; i <= b; i++) if (bars[i].h > mv) { mv = bars[i].h; mi = i; } return { i: mi, v: mv }; }
  function minLow(bars, a, b) { let mi = a, mv = Infinity; for (let i = a; i <= b; i++) if (bars[i].l < mv) { mv = bars[i].l; mi = i; } return { i: mi, v: mv }; }

  // ===== 計測（measure） =====
  // 戻り: { asOf, lastClose, lastVol, avgVol20, ma:{}, pivots, byPattern:{cup,range,...:{metrics,levels,marks}} }
  function measure(bars, struct) {
    struct = Object.assign({}, DEFAULT_STRUCT, struct || {});
    const n = bars.length;
    const res = { asOf: bars[n - 1] ? bars[n - 1].t : null, lastClose: null, byPattern: {}, ma: {}, pivots: { hi: [], lo: [] } };
    if (n < 60) return res; // 最低限のデータが無ければ計測しない

    const closes = bars.map(b => b.c);
    const lastClose = closes[n - 1];
    const avgVol20 = avgVol(bars, n, 20);
    const lastVol = bars[n - 1].v || 0;
    res.lastClose = lastClose; res.avgVol20 = avgVol20; res.lastVol = lastVol;
    res.atr = atr(bars, 14);

    // 移動平均（日足）
    const ma25 = sma(closes, 25), ma75 = sma(closes, 75), ma200 = sma(closes, 200);
    res.ma = { ma25: ma25[n - 1], ma75: ma75[n - 1], ma200: ma200[n - 1] };
    const ma200Pos = (res.ma.ma200 != null) ? (lastClose >= res.ma.ma200 ? 'above' : 'below') : null;
    const ma200Slope = (ma200[n - 1] != null && ma200[n - 21] != null) ? (ma200[n - 1] >= ma200[n - 21] ? 'up' : 'down') : null;
    res.ma200Pos = ma200Pos; res.ma200Slope = ma200Slope;

    const pv = pivots(closes, struct.pivotWin);
    res.pivots = pv;

    res.byPattern.range = measureRange(bars, closes, pv, struct, { avgVol20, lastVol, lastClose });
    res.byPattern.doubleBottom = measureDoubleBottom(bars, closes, pv, struct, { avgVol20, lastVol, lastClose, ma200Pos, ma200Slope });
    res.byPattern.cup = measureCup(bars, closes, pv, struct, { avgVol20, lastVol, lastClose, ma200Pos, ma200Slope });
    res.byPattern.ascTriangle = measureAscTriangle(bars, closes, pv, struct, { avgVol20, lastVol, lastClose });
    return res;
  }

  // --- レンジブレイク ---
  function measureRange(bars, closes, pv, struct, ctx) {
    const n = bars.length;
    const L = Math.min(n - 1, 250);
    const a = n - 1 - L, b = n - 6; // 直近5本はブレイク判定用に除外してレンジを取る
    if (a < 0 || b <= a) return null;
    const hi = maxHigh(bars, a, b), lo = minLow(bars, a, b);
    const rangeHigh = hi.v, rangeLow = lo.v;
    const widthPct = pct(rangeHigh, rangeLow);
    const tol = struct.touchTolPct / 100;
    let touchHigh = 0, touchLow = 0, inRange = 0, total = 0;
    for (let i = a; i <= b; i++) {
      total++;
      if (bars[i].h >= rangeHigh * (1 - tol)) touchHigh++;
      if (bars[i].l <= rangeLow * (1 + tol)) touchLow++;
      if (closes[i] >= rangeLow && closes[i] <= rangeHigh) inRange++;
    }
    const lastClose = ctx.lastClose;
    const breakoutRatio = pct(lastClose, rangeHigh);          // 上限を何%超えたか（負=未突破）
    const breakoutVolRatio = ctx.avgVol20 ? ctx.lastVol / ctx.avgVol20 : 0;
    const lookbackDays = total;
    return {
      metrics: { lookbackDays, widthPct, touchHigh, touchLow, inRangeRatio: total ? inRange / total * 100 : 0, breakoutRatio, breakoutVolRatio },
      levels: { resistance: rangeHigh, support: rangeLow, breakLevel: rangeHigh, failLevel: rangeLow },
      marks: [{ t: bars[hi.i].t, price: rangeHigh, label: '上限', up: true }, { t: bars[lo.i].t, price: rangeLow, label: '下限', up: false }],
    };
  }

  // --- ダブルボトム ---
  function measureDoubleBottom(bars, closes, pv, struct, ctx) {
    const lows = pv.lo;
    if (lows.length < 2) return null;
    // 直近2つの安値（新しい方=low2、その前=low1）
    const i2 = lows[lows.length - 1], i1 = lows[lows.length - 2];
    const low2 = bars[i2].l, low1 = bars[i1].l;
    const neck = maxHigh(bars, i1, i2);
    const neckline = neck.v;
    const lowGapPct = Math.abs(pct(low2, low1));
    const low2VsLow1 = pct(low2, low1);            // 第2安値の第1安値比（負=下回る）
    const reboundPct = pct(neckline, low1);
    const gapDays = i2 - i1;
    // 事前下落: i1 の前 ~120日からの下落
    const preA = Math.max(0, i1 - 120);
    const preDropPct = pct(bars[i1].l, maxHigh(bars, preA, i1).v); // 負の値（下落）
    // 第2安値周辺の出来高 ≤ 第1安値周辺
    const vol1 = avgVol(bars, Math.min(bars.length, i1 + 3), 6);
    const vol2 = avgVol(bars, Math.min(bars.length, i2 + 3), 6);
    const breakoutRatio = pct(ctx.lastClose, neckline);
    const breakoutVolRatio = ctx.avgVol20 ? ctx.lastVol / ctx.avgVol20 : 0;
    return {
      metrics: {
        lowGapPct, low2VsLow1, gapDays, reboundPct, preDropPct,
        vol2OverVol1: vol1 ? vol2 / vol1 : 1, breakoutRatio, breakoutVolRatio,
      },
      levels: { low1, low2, neckline, breakLevel: neckline, failLevel: Math.min(low1, low2) },
      marks: [
        { t: bars[i1].t, price: low1, label: '第1安値', up: false },
        { t: bars[i2].t, price: low2, label: '第2安値', up: false },
        { t: bars[neck.i].t, price: neckline, label: 'ネックライン', up: true },
      ],
    };
  }

  // --- カップウィズハンドル（近似検出） ---
  function measureCup(bars, closes, pv, struct, ctx) {
    const n = bars.length;
    const highs = pv.hi;
    if (highs.length < 2) return null;
    // 右高値候補: ハンドル形成前の直近の高値（末尾から30本以上手前）
    let rightI = -1;
    for (let k = highs.length - 1; k >= 0; k--) { if (highs[k] <= n - 1 - 3) { rightI = highs[k]; break; } }
    if (rightI < 0) return null;
    // 左高値候補: rightI より十分前で最大の高値
    const leftSearchB = rightI - 20;
    if (leftSearchB <= 0) return null;
    const leftSearchA = Math.max(0, rightI - 325);
    const left = maxHigh(bars, leftSearchA, leftSearchB);
    const leftI = left.i, leftPeak = left.v;
    if (rightI - leftI < 30) return null;
    // カップ底: 左高値と右高値の間の最安値
    const bottom = minLow(bars, leftI, rightI);
    const cupBottom = bottom.v, bottomI = bottom.i;
    const rightPeak = bars[rightI].h;
    // ハンドル: 右高値以降の最安値（末尾まで）
    const handle = minLow(bars, rightI, n - 1);
    const handleLow = handle.v;
    const handleHigh = rightPeak;
    // U字: カップ底+10%以内に滞在した日数割合
    const zone = cupBottom * 1.10;
    let inZone = 0; for (let i = leftI; i <= rightI; i++) if (bars[i].l <= zone) inZone++;
    const uShape = (rightI - leftI) ? inZone / (rightI - leftI) : 0;
    const leftSide = bottomI - leftI, rightSide = rightI - bottomI;
    const leftRightRatio = rightSide ? leftSide / rightSide : 0;
    // 事前上昇: 左高値の前~250日からの上昇率
    const preA = Math.max(0, leftI - 250);
    const priorRisePct = pct(leftPeak, minLow(bars, preA, leftI).v);
    const cupDepthPct = Math.abs(pct(cupBottom, leftPeak));     // 正の深さ%
    const handleDepthPct = Math.abs(pct(handleLow, rightPeak));
    const rightLeftPeakRatio = leftPeak ? rightPeak / leftPeak : 0;
    const cupDays = rightI - leftI;
    const handleDays = n - 1 - rightI;
    const handleVol = avgVol(bars, n, Math.max(2, handleDays || 5));
    const cupRightVol = avgVol(bars, rightI, 30);
    const breakoutRatio = pct(ctx.lastClose, handleHigh);
    const breakoutVolRatio = ctx.avgVol20 ? ctx.lastVol / ctx.avgVol20 : 0;
    return {
      metrics: {
        priorRisePct, cupDepthPct, cupDays, uShape, leftRightRatio,
        rightLeftPeakRatio, handleDepthPct, handleDays,
        handleVolRatio: cupRightVol ? handleVol / cupRightVol : 1,
        breakoutRatio, breakoutVolRatio, ma200Pos: ctx.ma200Pos, ma200Slope: ctx.ma200Slope,
      },
      levels: { leftPeak, cupBottom, rightPeak, handleHigh, handleLow, breakLevel: handleHigh, failLevel: handleLow },
      marks: [
        { t: bars[leftI].t, price: leftPeak, label: '左高値', up: true },
        { t: bars[bottomI].t, price: cupBottom, label: 'カップ底', up: false },
        { t: bars[rightI].t, price: rightPeak, label: '右高値', up: true },
        { t: bars[handle.i].t, price: handleLow, label: 'ハンドル安値', up: false },
      ],
    };
  }

  // --- アセンディングトライアングル ---
  function measureAscTriangle(bars, closes, pv, struct, ctx) {
    const n = bars.length;
    const L = Math.min(n - 1, 120);
    const a = n - 1 - L;
    const highsInWin = pv.hi.filter(i => i >= a);
    const lowsInWin = pv.lo.filter(i => i >= a);
    if (highsInWin.length < 2 || lowsInWin.length < 2) return null;
    const hVals = highsInWin.map(i => bars[i].h);
    const topMax = Math.max(...hVals), topMin = Math.min(...hVals), topAvg = hVals.reduce((s, v) => s + v, 0) / hVals.length;
    const flatTopPct = topAvg ? (topMax - topMin) / topAvg * 100 : 999; // 上値のばらつき%
    // 安値の傾き（最初と最後のピボット安値）
    const lo1 = lowsInWin[0], lo2 = lowsInWin[lowsInWin.length - 1];
    const lowsRising = bars[lo2].l > bars[lo1].l;
    const lowSlopePct = pct(bars[lo2].l, bars[lo1].l);
    // 値幅縮小
    const firstRange = bars[highsInWin[0]].h - bars[lowsInWin[0]].l;
    const lastRange = bars[highsInWin[highsInWin.length - 1]].h - bars[lowsInWin[lowsInWin.length - 1]].l;
    const narrowing = firstRange ? lastRange / firstRange : 1;
    const resistance = topAvg;
    const breakoutRatio = pct(ctx.lastClose, topMax);
    const breakoutVolRatio = ctx.avgVol20 ? ctx.lastVol / ctx.avgVol20 : 0;
    return {
      metrics: { flatTopPct, lowsRising: lowsRising ? 1 : 0, lowSlopePct, narrowing, breakoutRatio, breakoutVolRatio },
      levels: { resistance: topMax, breakLevel: topMax, supportStart: bars[lo1].l, supportEnd: bars[lo2].l, failLevel: bars[lo2].l },
      marks: [
        { t: bars[lo1].t, price: bars[lo1].l, label: '安値1', up: false },
        { t: bars[lo2].t, price: bars[lo2].l, label: '安値2', up: false },
      ],
    };
  }

  // ===== 採点（score） =====
  // ステータス: 0=該当なし 1=形成中 2=完成間近 3=ブレイク済み 4=失敗
  function score(meas, th) {
    th = mergeThresholds(th);
    const out = { patterns: {}, best: null };
    if (!meas || !meas.byPattern) return out;
    const fns = { cup: scoreCup, range: scoreRange, doubleBottom: scoreDoubleBottom, ascTriangle: scoreAscTriangle };
    for (const key of Object.keys(fns)) {
      const m = meas.byPattern[key];
      out.patterns[key] = m ? fns[key](m.metrics, th) : { score: 0, status: 0 };
    }
    // 最有力＝スコア最大（ステータス0を除く）
    let best = null;
    for (const key of Object.keys(out.patterns)) {
      const p = out.patterns[key];
      if (p.status === 0) continue;
      if (!best || p.score > best.score) best = { pattern: key, score: p.score, status: p.status };
    }
    out.best = best;
    return out;
  }

  const inRange = (v, lo, hi) => v >= lo && v <= hi;

  function scoreCup(m, th) {
    const c = th.cup, k = th.common; let s = 0;
    if (m.priorRisePct >= c.priorRisePct || (m.ma200Pos === 'above' && m.ma200Slope === 'up')) s += 15;
    if (inRange(m.cupDepthPct, c.cupDepthMin, c.cupDepthMax)) s += 15; else if (inRange(m.cupDepthPct, 10, 50)) s += 7;
    if (inRange(m.cupDays, c.cupDaysMin, c.cupDaysMax)) s += 10;
    const notV = m.uShape >= 0.2 && inRange(m.leftRightRatio, 0.4, 2.5);
    if (notV) s += 15;
    if (m.rightLeftPeakRatio >= c.rightLeftRatio) s += 10; else if (m.rightLeftPeakRatio >= 0.85) s += 5;
    if (inRange(m.handleDepthPct, c.handleDepthMin, c.handleDepthMax)) s += 10; else if (m.handleDepthPct <= 20) s += 5;
    if (m.handleVolRatio < 1) s += 10;
    const broke = m.breakoutRatio >= k.breakPct && m.breakoutVolRatio >= k.volMult;
    if (broke) s += 15;
    let status = 1;
    if (broke) status = 3;
    else if (m.handleDepthPct > 25) status = 4;             // ハンドル深すぎ＝失敗
    else if (m.breakoutRatio >= -1) status = 2;             // ハンドル高値直下＝完成間近
    return { score: Math.round(s), status };
  }

  function scoreRange(m, th) {
    const r = th.range, k = th.common; let s = 0;
    if (inRange(m.lookbackDays, r.lookbackMin, r.lookbackMax)) s += 15;
    if (inRange(m.widthPct, r.widthMin, r.widthMax)) s += 10;
    if (m.touchHigh >= r.touchHigh) s += 15;
    if (m.touchLow >= r.touchLow) s += 10;
    if (m.inRangeRatio >= r.inRangeRatio) s += 15;
    const broke = m.breakoutRatio >= k.breakPct;
    if (broke) s += 20;
    if (m.breakoutVolRatio >= k.volMult) s += 15;
    let status = 1;
    if (broke && m.breakoutVolRatio >= k.volMult) status = 3;
    else if (broke) status = 3;
    else if (m.breakoutRatio >= -2) status = 2;
    return { score: Math.round(s), status };
  }

  function scoreDoubleBottom(m, th) {
    const d = th.doubleBottom, k = th.common; let s = 0;
    if (m.preDropPct <= -d.priorDropPct) s += 10;
    if (m.lowGapPct <= d.lowGapPct) s += 20;
    if (m.low2VsLow1 >= -d.low2FloorPct) s += 15;
    if (inRange(m.gapDays, 20, 120)) s += 10;
    if (m.reboundPct >= d.reboundPct) s += 10;
    if (m.vol2OverVol1 <= 1) s += 15;
    const broke = m.breakoutRatio >= k.breakPct;
    if (broke) s += 15;
    if (m.breakoutVolRatio >= k.volMultWeak) s += 5;
    let status = 1;
    if (m.low2VsLow1 < -8) status = 4;                       // 第2安値が大きく割れ＝失敗(下落継続)
    else if (broke) status = 3;
    else if (m.breakoutRatio >= -2) status = 2;
    return { score: Math.round(s), status };
  }

  function scoreAscTriangle(m, th) {
    const a = th.ascTriangle, k = th.common; let s = 0;
    if (m.flatTopPct <= a.flatTopPct) s += 20;
    if (m.lowsRising) s += 25;
    if (inRange(m.lowSlopePct, 0.001, 100)) s += 0; // 既に lowsRising に含む
    s += 10; // 形成期間（窓内で算出済み＝既定で満たすとみなす）
    if (m.narrowing <= a.narrowing) s += 10;
    const broke = m.breakoutRatio >= k.breakPct;
    if (broke) s += 20;
    if (m.breakoutVolRatio >= k.volMult) s += 15;
    let status = 1;
    if (broke && m.breakoutVolRatio >= k.volMult) status = 3;
    else if (broke) status = 3;
    else if (m.breakoutRatio >= -2) status = 2;
    return { score: Math.round(s), status };
  }

  // ===== まとめ =====
  function mergeThresholds(th) {
    const base = JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS));
    if (!th) return base;
    for (const grp of Object.keys(base)) Object.assign(base[grp], th[grp] || {});
    return base;
  }

  // 1銘柄ぶんを計測＋採点。chart 用に必要な levels/marks/ma も保持。
  function analyze(bars, thresholds, struct) {
    const meas = measure(bars, struct);
    const sc = score(meas, thresholds);
    // 保存用に metrics と levels を抽出（再採点に使う・APIなしで再描画できる最小限）
    const metrics = {}, levels = {}, marks = {};
    for (const key of Object.keys(meas.byPattern)) {
      const m = meas.byPattern[key];
      if (m) { metrics[key] = m.metrics; levels[key] = m.levels; marks[key] = m.marks; }
    }
    const best = sc.best;
    const evidence = best ? buildEvidence(best.pattern, meas) : { ma200Pos: meas.ma200Pos, ma200Slope: meas.ma200Slope };
    return {
      asOf: meas.asOf, lastClose: meas.lastClose,
      best, patterns: sc.patterns, metrics, levels, marks, evidence,
      ma: meas.ma, ma200Pos: meas.ma200Pos, ma200Slope: meas.ma200Slope,
    };
  }

  function buildEvidence(pattern, meas) {
    const e = { pattern, ma200Pos: meas.ma200Pos, ma200Slope: meas.ma200Slope };
    const m = meas.byPattern[pattern];
    if (m) { e.metrics = m.metrics; e.levels = m.levels; }
    return e;
  }

  // ===== ローソク足 SVG（共通部品） =====
  // candleSVG(bars, opts) bars=表示用OHLC配列（日足 or 週足）。
  // opts: { hlines:[{price,color,label,dash}], marks:[{t,price,color,label,up}],
  //         mas:[{values:[...同長...],color,label}], width,height,title }
  function candleSVG(bars, opts) {
    opts = opts || {};
    const W = opts.width || 760, H = opts.height || 320;
    const pad = { l: 56, r: 92, t: 12, b: 40 };
    const volH = 46; // 出来高サブチャートの高さ
    const plotB = H - pad.b - volH;
    if (!bars || !bars.length) return '<div class="muted">データなし</div>';
    let dmin = Infinity, dmax = -Infinity;
    bars.forEach(b => { dmin = Math.min(dmin, b.l); dmax = Math.max(dmax, b.h); });
    (opts.hlines || []).forEach(h => { if (isNum(h.price)) { dmin = Math.min(dmin, h.price); dmax = Math.max(dmax, h.price); } });
    if (!isFinite(dmin) || dmin === dmax) { dmin -= 1; dmax += 1; }
    const step = niceStep((dmax - dmin) || 1, 5);
    const ymin = Math.floor(dmin / step) * step, ymax = Math.ceil(dmax / step) * step;
    const N = bars.length;
    const plotW = W - pad.l - pad.r;
    const cw = Math.max(1, plotW / N * 0.66); // ローソク実体幅
    const cx = (i) => pad.l + (i + 0.5) / N * plotW;
    const py = (v) => pad.t + (1 - (v - ymin) / (ymax - ymin)) * (plotB - pad.t);
    const maxVol = Math.max(1, ...bars.map(b => b.v || 0));
    const vy = (v) => H - pad.b - (v / maxVol) * volH;

    // Y目盛
    let grid = '';
    for (let v = ymin; v <= ymax + step * 1e-6; v += step) {
      const y = py(v).toFixed(1);
      grid += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
      grid += `<text x="${pad.l - 6}" y="${(+y + 3).toFixed(1)}" fill="var(--muted)" font-size="10" text-anchor="end">${fmtNum(v)}</text>`;
    }
    // X年ラベル
    let xlab = '', lastYear = null;
    bars.forEach((b, i) => { const yr = new Date(b.t * 1000).getFullYear(); if (yr !== lastYear) { lastYear = yr; const x = cx(i).toFixed(1); xlab += `<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${plotB}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2 4"/><text x="${x}" y="${H - pad.b + 14}" fill="var(--muted)" font-size="10" text-anchor="middle">${yr}</text>`; } });

    // ローソク＋出来高
    let candles = '', vols = '';
    const up = 'var(--green, #16a34a)', dn = 'var(--red, #dc2626)';
    bars.forEach((b, i) => {
      const x = cx(i), col = b.c >= b.o ? up : dn;
      const yo = py(b.o), yc = py(b.c), yh = py(b.h), yl = py(b.l);
      const top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
      candles += `<line x1="${x.toFixed(1)}" y1="${yh.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yl.toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
      candles += `<rect x="${(x - cw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${cw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}"/>`;
      const v = b.v || 0; vols += `<rect x="${(x - cw / 2).toFixed(1)}" y="${vy(v).toFixed(1)}" width="${cw.toFixed(1)}" height="${(H - pad.b - vy(v)).toFixed(1)}" fill="${col}" opacity="0.35"/>`;
    });

    // 移動平均線
    let maLines = '';
    (opts.mas || []).forEach(ma => {
      const d = ma.values.map((v, i) => v == null ? null : `${cx(i).toFixed(1)} ${py(v).toFixed(1)}`).filter(Boolean);
      if (d.length > 1) {
        let path = '', started = false;
        ma.values.forEach((v, i) => { if (v == null) { started = false; return; } path += (started ? 'L' : 'M') + cx(i).toFixed(1) + ' ' + py(v).toFixed(1) + ' '; started = true; });
        maLines += `<path d="${path}" fill="none" stroke="${ma.color}" stroke-width="1.2" opacity="0.9"/>`;
        maLines += `<text x="${W - pad.r + 4}" y="${py(ma.values[ma.values.length - 1] ?? ymax).toFixed(1)}" fill="${ma.color}" font-size="9">${esc(ma.label)}</text>`;
      }
    });

    // 水平ライン（買いトリガー/失敗/ネックライン/抵抗・支持）
    let hl = '';
    (opts.hlines || []).forEach(h => {
      if (!isNum(h.price)) return;
      const y = py(h.price).toFixed(1), dash = h.dash || '5 3';
      hl += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="${h.color}" stroke-width="1.2" stroke-dasharray="${dash}"/>`;
      hl += `<text x="${W - pad.r + 4}" y="${(+y + 3)}" fill="${h.color}" font-size="9.5">${esc(h.label)} ${fmtNum(h.price)}</text>`;
    });
    // マーカー（ピボット等）
    let mk = '';
    (opts.marks || []).forEach(m => {
      const i = nearestIndex(bars, m.t); if (i < 0) return;
      const x = cx(i).toFixed(1), y = py(m.price).toFixed(1), col = m.color || 'var(--accent)';
      mk += `<circle cx="${x}" cy="${y}" r="3" fill="${col}"/>`;
      mk += `<text x="${x}" y="${(+y + (m.up ? -6 : 13)).toFixed(1)}" fill="${col}" font-size="9" text-anchor="middle">${esc(m.label || '')}</text>`;
    });
    // 期間内の高値・安値マーカー（既定で表示。opts.showHL===false で無効化）
    if (opts.showHL !== false) {
      let hiI = 0, loI = 0, hiV = -Infinity, loV = Infinity;
      bars.forEach((b, i) => { if (b.h > hiV) { hiV = b.h; hiI = i; } if (b.l < loV) { loV = b.l; loI = i; } });
      const hx = cx(hiI).toFixed(1), hy = py(hiV);
      const lx = cx(loI).toFixed(1), ly = py(loV);
      mk += `<circle cx="${hx}" cy="${hy.toFixed(1)}" r="3.5" fill="#c026d3"/><text x="${hx}" y="${(hy - 6).toFixed(1)}" fill="#c026d3" font-size="10" text-anchor="middle">高値 ${fmtNum(hiV)}</text>`;
      mk += `<circle cx="${lx}" cy="${ly.toFixed(1)}" r="3.5" fill="#0d9488"/><text x="${lx}" y="${(ly + 14).toFixed(1)}" fill="#0d9488" font-size="10" text-anchor="middle">安値 ${fmtNum(loV)}</text>`;
    }

    const title = opts.title ? `<text x="${pad.l}" y="${pad.t - 1}" fill="var(--muted)" font-size="10">${esc(opts.title)}</text>` : '';
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;background:var(--panel);border:1px solid var(--border);border-radius:8px">
      ${grid}${xlab}${vols}${candles}${maLines}${hl}${mk}${title}
    </svg>`;
  }

  function nearestIndex(bars, t) {
    if (!isNum(t)) return -1;
    let best = -1, bd = Infinity;
    for (let i = 0; i < bars.length; i++) { const d = Math.abs(bars[i].t - t); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  function niceStep(range, target) {
    const raw = range / target, mag = Math.pow(10, Math.floor(Math.log10(raw))), norm = raw / mag;
    const f = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return f * mag;
  }
  function fmtNum(v) { if (!isNum(v)) return '—'; const a = Math.abs(v); return a >= 1000 ? Math.round(v).toLocaleString() : a >= 1 ? v.toFixed(2) : v.toFixed(4); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ラベル
  const PATTERN_LABEL = { cup: 'カップウィズハンドル', range: 'レンジブレイク', doubleBottom: 'ダブルボトム', ascTriangle: 'アセンディングトライアングル' };
  const STATUS_LABEL = { 0: '—', 1: '形成中', 2: '完成間近', 3: 'ブレイク済み', 4: '失敗' };

  globalThis.TA = {
    DEFAULT_THRESHOLDS, DEFAULT_STRUCT, PATTERN_LABEL, STATUS_LABEL,
    measure, score, analyze, candleSVG, toWeekly, sma, mergeThresholds,
  };
})();
