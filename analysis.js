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

  // 指数移動平均（EMA）。配列長と同じ長さ、最初の有効値は SMA で種をまく。
  function ema(vals, period) {
    const out = new Array(vals.length).fill(null);
    const k = 2 / (period + 1);
    let prev = null, seed = 0, cnt = 0;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (!isNum(v)) { out[i] = prev; continue; }
      if (prev == null) { seed += v; cnt++; if (cnt === period) { prev = seed / period; out[i] = prev; } }
      else { prev = v * k + prev * (1 - k); out[i] = prev; }
    }
    return out;
  }

  // RSI（Wilder方式）。配列長と同じ長さ、period本たまるまで null。
  function rsi(closes, period) {
    const out = new Array(closes.length).fill(null);
    let avgG = 0, avgL = 0;
    for (let i = 1; i < closes.length; i++) {
      const ch = closes[i] - closes[i - 1];
      const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
      if (i <= period) { avgG += g; avgL += l; if (i === period) { avgG /= period; avgL /= period; out[i] = 100 - 100 / (1 + (avgL === 0 ? 100 : avgG / avgL)); } }
      else { avgG = (avgG * (period - 1) + g) / period; avgL = (avgL * (period - 1) + l) / period; out[i] = 100 - 100 / (1 + (avgL === 0 ? 100 : avgG / avgL)); }
    }
    return out;
  }

  // MACD（fast/slow/signal）。{macd:[], signal:[], hist:[]}
  function macd(closes, fast, slow, sig) {
    const ef = ema(closes, fast), es = ema(closes, slow);
    const macdLine = closes.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
    const signal = ema(macdLine.map(v => v == null ? NaN : v), sig).map(v => (v != null && isFinite(v)) ? v : null);
    const hist = macdLine.map((v, i) => (v != null && signal[i] != null) ? v - signal[i] : null);
    return { macd: macdLine, signal, hist };
  }

  // ボリンジャーバンド（SMA period ± k*標準偏差）。各点で配列を返す（period未満は null）。
  function bollinger(closes, period, k) {
    const mid = sma(closes, period), lower = [], upper = [];
    for (let i = 0; i < closes.length; i++) {
      if (mid[i] == null) { lower.push(null); upper.push(null); continue; }
      let sum = 0; for (let j = i - period + 1; j <= i; j++) { const d = closes[j] - mid[i]; sum += d * d; }
      const sd = Math.sqrt(sum / period);
      lower.push(mid[i] - k * sd); upper.push(mid[i] + k * sd);
    }
    return { mid, lower, upper };
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

    // テクニカル指標（RSI / MACD）。サブチャート用に系列も保持。
    const rsiArr = rsi(closes, 14);
    const mac = macd(closes, 12, 26, 9);
    res.rsi = rsiArr[n - 1];
    res.rsiSeries = rsiArr;
    res.macd = { macd: mac.macd[n - 1], signal: mac.signal[n - 1], hist: mac.hist[n - 1] };
    res.macdSeries = mac;
    // MACDゴールデンクロス（直近でmacdがsignalを上抜け）/ RSI状態
    let macdCross = 'none';
    for (let i = n - 1; i >= Math.max(1, n - 6); i--) {
      if (mac.macd[i] != null && mac.signal[i] != null && mac.macd[i - 1] != null && mac.signal[i - 1] != null) {
        if (mac.macd[i - 1] <= mac.signal[i - 1] && mac.macd[i] > mac.signal[i]) { macdCross = 'golden'; break; }
        if (mac.macd[i - 1] >= mac.signal[i - 1] && mac.macd[i] < mac.signal[i]) { macdCross = 'dead'; break; }
      }
    }
    res.macdCross = macdCross;
    res.rsiState = res.rsi == null ? null : res.rsi <= 30 ? 'oversold' : res.rsi >= 70 ? 'overbought' : 'neutral';

    const pv = pivots(closes, struct.pivotWin);
    res.pivots = pv;
    // 逆張りスコア集計に使うスカラー（52週高値乖離・MA乖離・直近下ヒゲ・5/25日線回復）
    const high52w = maxHigh(bars, Math.max(0, n - 252), n - 1).v;
    res.dev52w = pct(lastClose, high52w);
    res.maDev25 = res.ma.ma25 ? pct(lastClose, res.ma.ma25) : null;
    res.maDev200 = res.ma.ma200 ? pct(lastClose, res.ma.ma200) : null;
    const lastBar = bars[n - 1]; const lbRng = (lastBar.h - lastBar.l) || 1e-9;
    res.lastLowerWick = (lastBar.c - lastBar.l) / lbRng;
    const ma5 = sma(closes, 5)[n - 1];
    res.above5 = ma5 != null && lastClose > ma5;
    res.above25 = res.ma.ma25 != null && lastClose > res.ma.ma25;
    const baseCtx = { avgVol20, lastVol, lastClose, ma200Pos, ma200Slope, rsiSeries: rsiArr, ma: { ma25: ma25[n - 1], ma75: ma75[n - 1], ma200: ma200[n - 1] } };

    res.byPattern.range = measureRange(bars, closes, pv, struct, baseCtx);
    res.byPattern.doubleBottom = measureDoubleBottom(bars, closes, pv, struct, baseCtx);
    res.byPattern.cup = measureCup(bars, closes, pv, struct, baseCtx);
    res.byPattern.ascTriangle = measureAscTriangle(bars, closes, pv, struct, baseCtx);
    res.byPattern.roundBottom = measureRoundBottom(bars, closes, pv, struct, baseCtx, ma25, ma75);
    res.byPattern.invHS = measureInvHS(bars, closes, pv, struct, baseCtx);
    res.byPattern.flag = measureFlag(bars, closes, pv, struct, baseCtx);
    res.byPattern.baseOnBase = measureBaseOnBase(bars, closes, pv, struct, baseCtx, sma(closes, 50));
    res.byPattern.undercutRally = measureUndercutRally(bars, closes, pv, struct, baseCtx);
    res.byPattern.sellingClimax = measureSellingClimax(bars, closes, pv, struct, baseCtx);
    res.byPattern.rsiDivergence = measureRsiDivergence(bars, closes, pv, struct, baseCtx);
    res.byPattern.bollingerRecover = measureBollinger(bars, closes, pv, struct, baseCtx);
    res.byPattern.maDeviation = measureMaDeviation(bars, closes, pv, struct, baseCtx);
    res.byPattern.gapFill = measureGapFill(bars, closes, pv, struct, baseCtx);
    res.byPattern.volDryUp = measureVolDryUp(bars, closes, pv, struct, baseCtx);
    res.byPattern.hsTop = measureHSTop(bars, closes, pv, struct, baseCtx);
    res.byPattern.doubleTop = measureDoubleTop(bars, closes, pv, struct, baseCtx);
    res.byPattern.newLowHighVol = measureNewLowHighVol(bars, closes, pv, struct, baseCtx);
    res.byPattern.bearFlag = measureBearFlag(bars, closes, pv, struct, baseCtx);
    res.byPattern.descTriangle = measureDescTriangle(bars, closes, pv, struct, baseCtx);
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

  // --- ラウンドボトム（長期低迷からの回復） ---
  function measureRoundBottom(bars, closes, pv, struct, ctx, ma25, ma75) {
    const n = bars.length;
    if (n < 180) return null;
    const bottom = minLow(bars, 0, n - 1);
    const preHigh = maxHigh(bars, 0, Math.max(1, bottom.i)).v;
    const preDropPct = pct(bottom.v, preHigh); // 負（下落率）
    // 底値+15%以内に滞在した割合（全期間）
    const zone = bottom.v * 1.15; let inZone = 0; for (let i = 0; i < n; i++) if (bars[i].l <= zone) inZone++;
    const baseStayRatio = inZone / n * 100;
    // 安値切り上げ: 直近60日の最安値 > その前120日の最安値
    const recentLow = minLow(bars, Math.max(0, n - 60), n - 1).v;
    const priorLow = minLow(bars, Math.max(0, n - 180), Math.max(1, n - 60)).v;
    const lowsRising = recentLow > priorLow ? 1 : 0;
    const maImproved = (ma25[n - 1] != null && ma75[n - 1] != null && ma25[n - 1] > ma75[n - 1]) ? 1 : 0;
    const volRising = avgVol(bars, n, 50) > avgVol(bars, Math.max(50, n - 100), 150) ? 1 : 0;
    const aboveMa200 = ctx.ma200Pos === 'above' ? 1 : 0;
    const breakoutRatio = pct(ctx.lastClose, maxHigh(bars, Math.max(0, n - 60), n - 1).v);
    return {
      metrics: { preDropPct, baseStayRatio, lowsRising, maImproved, volRising, aboveMa200, breakoutRatio },
      levels: { bottom: bottom.v, breakLevel: maxHigh(bars, Math.max(0, n - 60), n - 1).v, failLevel: recentLow },
      marks: [{ t: bars[bottom.i].t, price: bottom.v, label: '底', up: false }],
    };
  }

  // --- 逆三尊（左肩・頭・右肩の3安値） ---
  function measureInvHS(bars, closes, pv, struct, ctx) {
    const lows = pv.lo, highs = pv.hi;
    if (lows.length < 3) return null;
    const last3 = lows.slice(-3); const [lsI, hI, rsI] = last3;
    const ls = bars[lsI].l, head = bars[hI].l, rs = bars[rsI].l;
    const headDeepest = (head < ls && head < rs) ? 1 : 0;
    const shoulderSym = head ? Math.abs(ls - rs) / head * 100 : 999;
    const rsAboveHead = head ? rs / head : 0;
    const neck1 = maxHigh(bars, lsI, hI).v, neck2 = maxHigh(bars, hI, rsI).v;
    const neckline = Math.max(neck1, neck2);
    const necklineSlope = neck1 ? Math.abs(neck2 - neck1) / neck1 * 100 : 999;
    const breakoutRatio = pct(ctx.lastClose, neckline);
    const breakoutVolRatio = ctx.avgVol20 ? ctx.lastVol / ctx.avgVol20 : 0;
    return {
      metrics: { headDeepest, shoulderSym, rsAboveHead, necklineSlope, breakoutRatio, breakoutVolRatio },
      levels: { neckline, breakLevel: neckline, failLevel: head, head, leftShoulder: ls, rightShoulder: rs },
      marks: [
        { t: bars[lsI].t, price: ls, label: '左肩', up: false },
        { t: bars[hI].t, price: head, label: '頭', up: false },
        { t: bars[rsI].t, price: rs, label: '右肩', up: false },
      ],
    };
  }

  // --- フラッグ・ペナント（急騰→浅い短期調整→再ブレイク） ---
  function measureFlag(bars, closes, pv, struct, ctx) {
    const n = bars.length;
    if (n < 40) return null;
    // ポール: 直近30日内で最大の上昇区間（簡易: 直近35日前→直近15日前の上昇）
    const poleA = Math.max(0, n - 35), poleEnd = Math.max(poleA + 1, n - 12);
    const poleLow = minLow(bars, poleA, poleEnd), poleHigh = maxHigh(bars, poleLow.i, poleEnd);
    const poleRisePct = pct(poleHigh.v, poleLow.v);
    const poleVol = avgVol(bars, poleEnd, Math.max(3, poleEnd - poleLow.i)) ;
    // フラッグ: ポール以降の調整
    const flagA = poleHigh.i, flagHigh = maxHigh(bars, flagA, n - 1).v, flagLow = minLow(bars, flagA, n - 1).v;
    const flagDepthPct = Math.abs(pct(flagLow, flagHigh));
    const flagDays = n - 1 - flagA;
    const flagVol = avgVol(bars, n, Math.max(3, flagDays || 5));
    const breakoutRatio = pct(ctx.lastClose, flagHigh);
    const breakoutVolRatio = ctx.avgVol20 ? ctx.lastVol / ctx.avgVol20 : 0;
    return {
      metrics: { poleRisePct, flagDepthPct, flagDays, flagVolRatio: poleVol ? flagVol / poleVol : 1, breakoutRatio, breakoutVolRatio },
      levels: { breakLevel: flagHigh, failLevel: flagLow, poleHigh: poleHigh.v },
      marks: [{ t: bars[poleLow.i].t, price: poleLow.v, label: 'ポール起点', up: false }, { t: bars[poleHigh.i].t, price: poleHigh.v, label: 'ポール天井', up: true }],
    };
  }

  // --- ベース・オン・ベース（第1ベースのブレイク→浅い第2ベース→再ブレイク） ---
  function measureBaseOnBase(bars, closes, pv, struct, ctx, ma50) {
    const n = bars.length;
    if (n < 80) return null;
    // 第1ベース上限: 直近120〜40日前の最高値、その後ブレイクし第2ベースを形成と仮定
    const firstA = Math.max(0, n - 120), firstB = Math.max(firstA + 1, n - 40);
    const firstHigh = maxHigh(bars, firstA, firstB).v;
    // 第2ベース: 直近40日の高安
    const secHigh = maxHigh(bars, Math.max(0, n - 40), n - 1).v, secLow = minLow(bars, Math.max(0, n - 40), n - 1).v;
    const firstBroke = secLow > firstHigh * 0.97 ? 1 : 0; // 第1ベース上限を概ね上抜けて推移
    const secDepthPct = Math.abs(pct(secLow, secHigh));
    const aboveMa50 = (ma50[n - 1] != null && ctx.lastClose > ma50[n - 1]) ? 1 : 0;
    const breakoutRatio = pct(ctx.lastClose, secHigh);
    const breakoutVolRatio = ctx.avgVol20 ? ctx.lastVol / ctx.avgVol20 : 0;
    return {
      metrics: { firstBroke, secDepthPct, aboveMa50, breakoutRatio, breakoutVolRatio },
      levels: { firstHigh, breakLevel: secHigh, failLevel: secLow },
      marks: [{ t: bars[Math.max(0, n - 40)] ? bars[Math.max(0, n - 40)].t : bars[0].t, price: secLow, label: '第2ベース安値', up: false }],
    };
  }

  // --- 三尊天井（警戒）3高値・頭最高 ---
  function measureHSTop(bars, closes, pv, struct, ctx) {
    const highs = pv.hi;
    if (highs.length < 3) return null;
    const [lsI, hI, rsI] = highs.slice(-3);
    const ls = bars[lsI].h, head = bars[hI].h, rs = bars[rsI].h;
    const headHighest = (head > ls && head > rs) ? 1 : 0;
    const rsBelowHead = head ? rs / head : 0;            // <0.95 が望ましい
    const shoulderSym = ls ? Math.abs(ls - rs) / ls * 100 : 999;
    const neckline = Math.min(minLow(bars, lsI, hI).v, minLow(bars, hI, rsI).v);
    const breakdownRatio = pct(ctx.lastClose, neckline);  // 負=割れ
    return {
      metrics: { headHighest, rsBelowHead, shoulderSym, breakdownRatio },
      levels: { neckline, failLevel: neckline, head },
      marks: [{ t: bars[hI].t, price: head, label: '頭', up: true }, { t: bars[lsI].t, price: ls, label: '左肩', up: true }, { t: bars[rsI].t, price: rs, label: '右肩', up: true }],
    };
  }

  // --- ダブルトップ（警戒）2高値が近い ---
  function measureDoubleTop(bars, closes, pv, struct, ctx) {
    const highs = pv.hi;
    if (highs.length < 2) return null;
    const i1 = highs[highs.length - 2], i2 = highs[highs.length - 1];
    const h1 = bars[i1].h, h2 = bars[i2].h;
    const highGapPct = Math.abs(pct(h2, h1));
    const h2VsH1 = pct(h2, h1);
    const neckline = minLow(bars, i1, i2).v;
    const midDropPct = Math.abs(pct(neckline, h1));
    const breakdownRatio = pct(ctx.lastClose, neckline);
    return {
      metrics: { highGapPct, h2VsH1, midDropPct, breakdownRatio },
      levels: { neckline, failLevel: neckline, high1: h1, high2: h2 },
      marks: [{ t: bars[i1].t, price: h1, label: '第1高値', up: true }, { t: bars[i2].t, price: h2, label: '第2高値', up: true }],
    };
  }

  // --- アンダーカット&ラリー（前回安値を一時割って終値で回復＝売り方の失敗。逆張り） ---
  function measureUndercutRally(bars, closes, pv, struct, ctx) {
    const n = bars.length; if (n < 30) return null;
    const recent = 8, W = 70;
    const a = Math.max(0, n - 1 - W), b = n - 1 - recent;
    if (b <= a + 3) return null;
    const pl = minLow(bars, a, b);                 // 直近の手前の安値（＝支持となっていた前回安値）
    const prevLow = pl.v;
    let ucIdx = -1, ucLow = Infinity;               // 直近 recent 本での最安値（アンダーカット候補）
    for (let i = b + 1; i <= n - 1; i++) { if (bars[i].l < ucLow) { ucLow = bars[i].l; ucIdx = i; } }
    if (ucIdx < 0) return null;
    const undercut = ucLow < prevLow;
    const depthBelow = prevLow ? (prevLow - ucLow) / prevLow * 100 : 0;   // 何%割ったか（正）
    let recovered = false, recIdx = -1;             // アンダーカット日以降の終値で prevLow を回復したか
    for (let i = ucIdx; i <= n - 1; i++) { if (closes[i] > prevLow) { recovered = true; recIdx = i; break; } }
    const ub = bars[ucIdx];
    const volRatio = ctx.avgVol20 ? (ub.v || 0) / ctx.avgVol20 : 0;
    const rng = (ub.h - ub.l) || 1e-9;
    const lowerWick = (ub.c - ub.l) / rng;          // 終値がレンジのどこ（0.5以上＝下ヒゲ）
    const hi = maxHigh(bars, a, n - 1);
    const dropFromHighPct = pct(ub.l, hi.v);        // 売られすぎ文脈（負）
    let rallyHigh = null; if (recIdx >= 0) rallyHigh = maxHigh(bars, recIdx, n - 1).v;
    return {
      metrics: { undercut: undercut ? 1 : 0, depthBelow, recovered: recovered ? 1 : 0, daysSince: n - 1 - ucIdx, volRatio, lowerWick, dropFromHighPct },
      levels: { support: prevLow, failLevel: ucLow, breakLevel: rallyHigh },
      marks: [{ t: bars[pl.i].t, price: prevLow, label: '前回安値', up: false }, { t: ub.t, price: ucLow, label: '一時割れ', up: false }],
    };
  }

  // --- セリングクライマックス（投げ売りの最終局面。出来高急増＋値幅拡大＋下ヒゲ＋以後安値維持。逆張り・監視寄り） ---
  function measureSellingClimax(bars, closes, pv, struct, ctx) {
    const n = bars.length; if (n < 65) return null;
    const c0 = closes[n - 1], c20 = closes[n - 21], c60 = closes[n - 61];
    const drop20 = c20 ? pct(c0, c20) : 0, drop60 = c60 ? pct(c0, c60) : 0;  // 負
    let climaxIdx = -1, maxV = -1;                  // 直近10本で出来高最大日＝クライマックス候補
    for (let i = n - 10; i <= n - 1; i++) { if (i < 1) continue; const v = bars[i].v || 0; if (v > maxV) { maxV = v; climaxIdx = i; } }
    if (climaxIdx < 1) return null;
    const cb = bars[climaxIdx];
    const av = avgVol(bars, climaxIdx, 20) || ctx.avgVol20;
    const volRatio = av ? (cb.v || 0) / av : 0;
    const rng = (cb.h - cb.l) || 1e-9;
    let sumRng = 0, cnt = 0; for (let i = climaxIdx - 20; i < climaxIdx; i++) { if (i < 0) continue; sumRng += (bars[i].h - bars[i].l); cnt++; }
    const rangeExp = cnt ? rng / (sumRng / cnt) : 0;
    const closePos = (cb.c - cb.l) / rng;           // 終値がレンジのどこ（上半分＝下ヒゲ/反発）
    let heldLow = true;                             // 以後クライマックス安値を終値で割らない
    for (let i = climaxIdx + 1; i <= n - 1; i++) { if (closes[i] < cb.l) { heldLow = false; break; } }
    return {
      metrics: { drop20, drop60, volRatio, rangeExp, closePos, heldLow: heldLow ? 1 : 0, daysSince: n - 1 - climaxIdx },
      levels: { support: cb.l, failLevel: cb.l },
      marks: [{ t: cb.t, price: cb.l, label: 'クライマックス安値', up: false }],
    };
  }

  // --- RSIダイバージェンス（株価は安値更新もRSIは切り上げ＝下落の勢い鈍化。逆張り） ---
  function measureRsiDivergence(bars, closes, pv, struct, ctx) {
    const lows = pv.lo; if (lows.length < 2 || !ctx.rsiSeries) return null;
    const i1 = lows[lows.length - 2], i2 = lows[lows.length - 1];
    const pl1 = bars[i1].l, pl2 = bars[i2].l;
    const r1 = ctx.rsiSeries[i1], r2 = ctx.rsiSeries[i2];
    if (r1 == null || r2 == null) return null;
    return {
      metrics: { lowerLow: pl2 < pl1 ? 1 : 0, rsiHigherLow: r2 > r1 ? 1 : 0, r1, r2, rsiImprove: r2 - r1, priceDropPct: pct(pl2, pl1) },
      levels: { support: pl2 },
      marks: [{ t: bars[i1].t, price: pl1, label: '安値1', up: false }, { t: bars[i2].t, price: pl2, label: '安値2', up: false }],
    };
  }
  // --- ボリンジャー -2σ下方逸脱からの回復（沿って下げ続けず、バンド内に戻る。逆張り） ---
  function measureBollinger(bars, closes, pv, struct, ctx) {
    const n = bars.length; if (n < 25) return null;
    const bb = bollinger(closes, 20, 2);
    let breachIdx = -1;
    for (let i = n - 10; i <= n - 1; i++) { if (i < 20) continue; if (bb.lower[i] != null && closes[i] < bb.lower[i]) { breachIdx = i; break; } }
    let recovered = false;
    if (breachIdx >= 0) for (let i = breachIdx; i <= n - 1; i++) { if (bb.lower[i] != null && closes[i] > bb.lower[i]) { recovered = true; break; } }
    const ma5 = sma(closes, 5)[n - 1];
    return {
      metrics: { breached: breachIdx >= 0 ? 1 : 0, recovered: recovered ? 1 : 0, daysSince: breachIdx >= 0 ? n - 1 - breachIdx : -1, above5: (ma5 != null && ctx.lastClose > ma5) ? 1 : 0, rsiNow: ctx.rsiSeries ? ctx.rsiSeries[n - 1] : null },
      levels: { support: bb.lower[n - 1] != null ? bb.lower[n - 1] : null },
      marks: breachIdx >= 0 ? [{ t: bars[breachIdx].t, price: bars[breachIdx].l, label: '-2σ割れ', up: false }] : [],
    };
  }
  // --- 移動平均線からの大幅下方乖離（売られすぎ候補。確認＝下ヒゲ/出来高/5日線回復。逆張り） ---
  function measureMaDeviation(bars, closes, pv, struct, ctx) {
    const n = bars.length; if (n < 30) return null;
    const c = ctx.lastClose;
    const lb = bars[n - 1]; const rng = (lb.h - lb.l) || 1e-9;
    const ma5 = sma(closes, 5)[n - 1];
    return {
      metrics: {
        dev25: ctx.ma.ma25 ? pct(c, ctx.ma.ma25) : null, dev75: ctx.ma.ma75 ? pct(c, ctx.ma.ma75) : null, dev200: ctx.ma.ma200 ? pct(c, ctx.ma.ma200) : null,
        lowerWick: (lb.c - lb.l) / rng, above5: (ma5 != null && c > ma5) ? 1 : 0, volRatio: ctx.avgVol20 ? (lb.v || 0) / ctx.avgVol20 : 0,
      },
      levels: { support: ctx.ma.ma25 || null }, marks: [],
    };
  }
  // --- 窓開け急落後の下げ止まり（悪材料で窓を開けて急落→その後安値を割らない/窓埋め。逆張り・要ファンダ注意） ---
  function measureGapFill(bars, closes, pv, struct, ctx) {
    const n = bars.length; if (n < 10) return null;
    let gapIdx = -1;
    for (let i = n - 10; i <= n - 1; i++) { if (i < 1) continue; const pc = bars[i - 1].c, plw = bars[i - 1].l; if (bars[i].o < pc * 0.95 || bars[i].h < plw) { gapIdx = i; break; } }
    if (gapIdx < 0) return null;
    const gb = bars[gapIdx];
    let heldLow = true; for (let i = gapIdx + 1; i <= n - 1; i++) { if (closes[i] < gb.l) { heldLow = false; break; } }
    let filledHigh = false; for (let i = gapIdx + 1; i <= n - 1; i++) { if (closes[i] > gb.h) { filledHigh = true; break; } }
    return {
      metrics: { gapPct: pct(gb.o, bars[gapIdx - 1].c), heldLow: heldLow ? 1 : 0, filledHigh: filledHigh ? 1 : 0, daysSince: n - 1 - gapIdx, volRatio: ctx.avgVol20 ? (gb.v || 0) / ctx.avgVol20 : 0 },
      levels: { support: gb.l, failLevel: gb.l, breakLevel: gb.h },
      marks: [{ t: gb.t, price: gb.l, label: '窓開け安値', up: false }, { t: gb.t, price: gb.h, label: '窓開け高値', up: true }],
    };
  }
  // --- 出来高減少を伴う下落（売り圧力の鈍化。単独でなく補助条件。逆張り） ---
  function measureVolDryUp(bars, closes, pv, struct, ctx) {
    const n = bars.length; if (n < 65) return null;
    const drop20 = closes[n - 21] ? pct(closes[n - 1], closes[n - 21]) : 0;
    const av20 = avgVol(bars, n, 20), av60 = avgVol(bars, n, 60);
    let dV = 0, dN = 0, uV = 0, uN = 0;
    for (let i = n - 20; i < n; i++) { if (i < 1) continue; if (closes[i] < closes[i - 1]) { dV += bars[i].v || 0; dN++; } else { uV += bars[i].v || 0; uN++; } }
    return {
      metrics: { drop20, volDownRatio: av60 ? av20 / av60 : 1, downLtUp: ((dN ? dV / dN : 0) < (uN ? uV / uN : 0)) ? 1 : 0 },
      levels: {}, marks: [],
    };
  }

  // ===== 逆張りの警戒パターン（底抜け継続/底打ち失敗。点灯したら逆張り総合を減点） =====
  // --- 安値更新＋出来高増加（売りが枯れず新規売り。逆張りで最も避けたい） ---
  function measureNewLowHighVol(bars, closes, pv, struct, ctx) {
    const n = bars.length; if (n < 25) return null;
    const a = Math.max(0, n - 60), b = n - 2;
    if (b <= a) return null;
    const pl = minLow(bars, a, b); const recentLow = pl.v;
    const c = ctx.lastClose;
    return {
      metrics: { belowLow: c < recentLow ? 1 : 0, breakPct: pct(c, recentLow), volRatio: ctx.avgVol20 ? (ctx.lastVol || 0) / ctx.avgVol20 : 0 },
      levels: { support: recentLow, failLevel: recentLow },
      marks: [{ t: bars[pl.i].t, price: recentLow, label: '直近安値', up: false }],
    };
  }
  // --- ベアフラッグ（急落→小反発→再下落。自律反発後の二段下げ） ---
  function measureBearFlag(bars, closes, pv, struct, ctx) {
    const n = bars.length; if (n < 40) return null;
    const a = Math.max(0, n - 40);
    const hi = maxHigh(bars, a, n - 15);
    const lo = minLow(bars, hi.i, n - 1);
    const dropPct = pct(lo.v, hi.v);
    if (dropPct > -15) return null;
    const rb = maxHigh(bars, lo.i, n - 1);
    const flagLow = minLow(bars, rb.i, n - 1).v;
    const c = ctx.lastClose;
    let dV = 0, dN = 0; for (let i = hi.i; i <= lo.i; i++) { dV += bars[i].v || 0; dN++; }
    let rV = 0, rN = 0; for (let i = lo.i; i <= rb.i; i++) { rV += bars[i].v || 0; rN++; }
    return {
      metrics: { dropPct, reboundPct: pct(rb.v, lo.v), volDecline: ((rN ? rV / rN : 0) < (dN ? dV / dN : 0)) ? 1 : 0, breakBelow: (c < flagLow * 0.98 || c < lo.v) ? 1 : 0, breakPct: pct(c, flagLow) },
      levels: { support: flagLow, failLevel: lo.v },
      marks: [{ t: bars[hi.i].t, price: hi.v, label: '急落前高値', up: true }, { t: bars[lo.i].t, price: lo.v, label: '急落安値', up: false }],
    };
  }
  // --- 下降三角持ち合いの下抜け（支持は水平・高値切り下げ→支持割れ） ---
  function measureDescTriangle(bars, closes, pv, struct, ctx) {
    const highs = pv.hi, lows = pv.lo; if (highs.length < 2 || lows.length < 2) return null;
    const h1 = bars[highs[highs.length - 2]].h, h2 = bars[highs[highs.length - 1]].h;
    const lo1 = bars[lows[lows.length - 2]].l, lo2 = bars[lows[lows.length - 1]].l;
    const support = Math.min(lo1, lo2);
    const c = ctx.lastClose;
    return {
      metrics: { highsFalling: h2 < h1 ? 1 : 0, flatSupport: Math.abs(pct(lo2, lo1)) <= 5 ? 1 : 0, breakdown: c < support * 0.98 ? 1 : 0, breakPct: pct(c, support), volRatio: ctx.avgVol20 ? (ctx.lastVol || 0) / ctx.avgVol20 : 0 },
      levels: { support, failLevel: support, resistance: h2 },
      marks: [{ t: bars[highs[highs.length - 2]].t, price: h1, label: '高値1', up: true }, { t: bars[highs[highs.length - 1]].t, price: h2, label: '高値2(切下げ)', up: true }, { t: bars[lows[lows.length - 1]].t, price: support, label: '支持線', up: false }],
    };
  }

  // ===== 採点（score） =====
  // ステータス: 0=該当なし 1=形成中 2=完成間近 3=ブレイク済み 4=失敗（逆張りは CONTRA_STATUS_LABEL で語彙差し替え）
  function score(meas, th) {
    th = mergeThresholds(th);
    const out = { patterns: {}, best: null, warn: null };
    if (!meas || !meas.byPattern) return out;
    const fns = {
      cup: scoreCup, range: scoreRange, doubleBottom: scoreDoubleBottom, ascTriangle: scoreAscTriangle,
      roundBottom: scoreRoundBottom, invHS: scoreInvHS, flag: scoreFlag, baseOnBase: scoreBaseOnBase,
      undercutRally: scoreUndercutRally, sellingClimax: scoreSellingClimax,
      rsiDivergence: scoreRsiDivergence, bollingerRecover: scoreBollinger, maDeviation: scoreMaDeviation, gapFill: scoreGapFill, volDryUp: scoreVolDryUp,
      hsTop: scoreHSTop, doubleTop: scoreDoubleTop,
      newLowHighVol: scoreNewLowHighVol, bearFlag: scoreBearFlag, descTriangle: scoreDescTriangle,
    };
    for (const key of Object.keys(fns)) {
      const m = meas.byPattern[key];
      out.patterns[key] = m ? fns[key](m.metrics, th) : { score: 0, status: 0 };
    }
    // 総合＝そのサイドのパターンのスコア最大（ステータス0を除く）。順張り/逆張りを別算出＋全体best。
    const bestOf = (list) => { let b = null; for (const key of list) { const p = out.patterns[key]; if (!p || p.status === 0 || p.status === 4) continue; if (!b || p.score > b.score) b = { pattern: key, score: p.score, status: p.status }; } return b; };
    out.bestTrend = bestOf(TREND_PATTERNS);   // そのサイドで最強の「単独パターン名＋強さ」（情報表示用）
    out.bestContra = bestOf(CONTRA_PATTERNS);
    out.best = bestOf(BUY_PATTERNS);
    // 総合＝確認ゲート方式（単独はキャップ、独立した確認が増えるほど高得点）。max方式の「1つ100で総合100」を回避。
    out.trendTotal = sideTotal(out.patterns, TREND_PATTERNS, 'trend', meas);
    out.contraTotal = sideTotal(out.patterns, CONTRA_PATTERNS, 'contra', meas);
    out.totalScore = Math.max(out.trendTotal, out.contraTotal);
    out.contraScore = out.contraTotal; // 後方互換（既存の列/ドロワーが参照）＝逆張り総合（確認ゲート）
    // 警戒シグナル＝警戒パターンのスコア最大
    let warn = null;
    for (const key of WARN_PATTERNS) {
      const p = out.patterns[key]; if (!p || p.status === 0) continue;
      if (!warn || p.score > warn.score) warn = { pattern: key, score: p.score, status: p.status };
    }
    out.warn = warn;
    return out;
  }

  const inRange = (v, lo, hi) => v >= lo && v <= hi;

  // 逆張り: アンダーカット&ラリー
  function scoreUndercutRally(m) {
    let s = 0;
    if (m.undercut) s += 15;
    if (m.recovered) s += 25;                       // 終値で回復＝最重要
    if (m.volRatio >= 1.5) s += 15;                 // 投げ売り出来高
    if (m.lowerWick >= 0.5) s += 15;                // 下ヒゲ
    if (m.depthBelow > 0 && m.depthBelow <= 4) s += 10; // 浅い割れ＝だまし下げ
    if (m.dropFromHighPct <= -15) s += 10;          // 売られすぎ文脈
    if (m.daysSince <= 6) s += 10;
    let status = 0;
    if (m.undercut) status = m.recovered ? (m.daysSince <= 6 ? 3 : 2) : (m.daysSince > 6 ? 4 : 1);
    return { score: Math.min(100, Math.round(s)), status };
  }
  // 逆張り: セリングクライマックス（買いより監視寄り。安値維持で下げ止まり）
  function scoreSellingClimax(m) {
    let s = 0;
    const bigDrop = m.drop20 <= -20 || m.drop60 <= -30;
    if (bigDrop) s += 20;
    if (m.volRatio >= 2.0) s += 20;                 // 出来高急増
    if (m.rangeExp >= 1.5) s += 15;                 // 値幅拡大
    if (m.closePos >= 0.5) s += 15;                 // 終値レンジ上半分＝下ヒゲ/反発
    if (m.heldLow) s += 20;                         // 以後安値を割らない
    if (m.daysSince >= 1 && m.daysSince <= 8) s += 10;
    let status = 0;
    if (bigDrop && (m.volRatio >= 2 || m.rangeExp >= 1.5)) {
      status = 2;                                   // 投げ売り発生＝下げ止まり候補
      if (m.heldLow && m.daysSince >= 3) status = 3; // 安値維持＝反転確認寄り
      if (!m.heldLow) status = 4;                   // 安値割れ継続＝危険
    } else if (m.drop20 <= -12) status = 1;         // 売られすぎ
    return { score: Math.min(100, Math.round(s)), status };
  }
  // 逆張り: RSIダイバージェンス
  function scoreRsiDivergence(m) {
    let s = 0;
    const diverge = m.lowerLow && m.rsiHigherLow;
    if (diverge) s += 30;
    if (m.r1 < 30) s += 20;
    if (m.rsiImprove >= 5) s += 20;
    if (m.r2 >= 30 && m.r1 < 30) s += 15;
    let status = 0;
    if (diverge) status = (m.r2 >= 30 && m.r1 < 30) ? 3 : (m.r1 < 35 ? 2 : 1);
    return { score: Math.min(100, Math.round(s)), status };
  }
  // 逆張り: ボリンジャー -2σ回復
  function scoreBollinger(m) {
    let s = 0;
    if (m.breached) s += 15;
    if (m.recovered) s += 30;
    if (m.above5) s += 20;
    if (m.rsiNow != null && m.rsiNow >= 30 && m.rsiNow < 50) s += 10;
    if (m.daysSince >= 0 && m.daysSince <= 6) s += 10;
    let status = 0;
    if (m.breached) status = m.recovered ? (m.above5 ? 3 : 2) : 1;
    return { score: Math.min(100, Math.round(s)), status };
  }
  // 逆張り: MA大幅下方乖離
  function scoreMaDeviation(m) {
    let s = 0;
    const deep = (m.dev25 != null && m.dev25 <= -10) || (m.dev75 != null && m.dev75 <= -15) || (m.dev200 != null && m.dev200 <= -25);
    if (deep) s += 30;
    if (m.lowerWick >= 0.5) s += 15;
    if (m.volRatio >= 1.5) s += 10;
    if (m.above5) s += 20;
    let status = 0;
    if (deep) status = m.above5 ? 3 : ((m.lowerWick >= 0.5 || m.volRatio >= 1.5) ? 2 : 1);
    return { score: Math.min(100, Math.round(s)), status };
  }
  // 逆張り: 窓開け急落後の下げ止まり
  function scoreGapFill(m) {
    let s = 0;
    if (m.gapPct <= -5) s += 15;
    if (m.heldLow) s += 25;
    if (m.filledHigh) s += 25;
    if (m.daysSince >= 2 && m.daysSince <= 10) s += 10;
    let status = 0;
    if (m.gapPct <= -3) { status = m.filledHigh ? 3 : (m.heldLow ? 2 : 1); if (!m.heldLow) status = 4; }
    return { score: Math.min(100, Math.round(s)), status };
  }
  // 逆張り: 出来高減少を伴う下落（補助条件）
  function scoreVolDryUp(m) {
    let s = 0;
    const falling = m.drop20 <= -10;
    if (falling && m.volDownRatio < 0.8) s += 30;
    if (m.downLtUp) s += 20;
    let status = 0;
    if (falling && (m.volDownRatio < 0.85 || m.downLtUp)) status = 2;
    else if (falling) status = 1;
    return { score: Math.min(100, Math.round(s)), status };
  }
  // 総合＝確認ゲート方式。単独シグナルはキャップ(60)、独立した確認(他の status≥2 のシグナル＋文脈)が
  // 増えるほど高得点。「1つだけ点灯したら買い」を避け、複数の根拠が一致したものを高く評価する。
  // base*0.6+25+confirms*8: 単独60→確認1で〜80→確認2-3で90+。weight/上限はここで調整可。
  function sideTotal(patterns, list, side, meas) {
    let bestScore = 0, c3 = 0, c2 = 0;
    // status 4（失敗/下抜け継続）は否定材料なので加点に含めない。status3(反転確認/ブレイク)を重く、status2(候補)を軽く数える。
    for (const p of list) { const x = patterns[p]; if (!x || x.status === 0 || x.status === 4) continue; if (x.score > bestScore) bestScore = x.score; if (x.status === 3) c3++; else if (x.status === 2) c2++; }
    if (bestScore === 0) return 0;
    // 確認＝最強以外のシグナルの一致（status3=1.0 / status2=0.5）。最強の1つ分を除く。
    let confirms = Math.max(0, (c3 + c2 * 0.5) - 1);
    if (side === 'trend') {
      if (meas.ma200Pos === 'above' && meas.ma200Slope === 'up') confirms += 1;       // トレンド一致
      if (meas.macdCross === 'golden') confirms += 0.5;
    } else {
      if (meas.rsiState === 'oversold' || (meas.dev52w != null && meas.dev52w <= -25)) confirms += 1; // 売られすぎ文脈
      if (meas.macdCross === 'golden' || meas.above5) confirms += 0.5;                  // モメンタム反転の兆し
    }
    confirms = Math.min(3.5, confirms); // 確認数の上限（飽和＝みんな100、を回避して順位がつくように）
    // 単独シグナルは最大55（候補止まり）。確認があるほど上げるが、上限95で100張り付きを避け順位を散らす。
    let total = confirms <= 0.5 ? Math.min(bestScore, 55) : Math.min(95, Math.round(bestScore * 0.5 + 12 + confirms * 9));
    // 逆張りは「底抜け継続/底打ち失敗」の警戒が点灯したら減点（まだ早い）。安値更新+出来高増は買い見送り級。
    if (side === 'contra') {
      const nlv = patterns.newLowHighVol;
      const strongDanger = nlv && nlv.status >= 2;                         // 安値更新＋出来高増
      const otherWarn = ['bearFlag', 'descTriangle'].some(p => patterns[p] && patterns[p].status >= 2)
        || (patterns.doubleBottom && patterns.doubleBottom.status === 4)    // 二番底失敗
        || (patterns.gapFill && patterns.gapFill.status === 4);             // ギャップ後の安値更新
      if (strongDanger) total = Math.min(total, 35);
      else if (otherWarn) total = Math.max(0, total - 20);
    }
    return total;
  }

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

  function scoreRoundBottom(m, th) {
    let s = 0;
    if (m.preDropPct <= -30) s += 15;
    if (m.baseStayRatio >= 30) s += 15;
    if (m.lowsRising) s += 15;
    if (m.maImproved) s += 15;
    if (m.volRising) s += 10;
    if (m.aboveMa200) s += 15;
    const broke = m.breakoutRatio >= th.common.breakPct;
    if (broke) s += 15;
    let status = 1;
    if (broke) status = 3;
    else if (m.aboveMa200 && m.maImproved) status = 2;
    return { score: Math.round(s), status };
  }

  function scoreInvHS(m, th) {
    const k = th.common; let s = 0;
    if (m.headDeepest) s += 20;
    if (m.shoulderSym <= 15) s += 15;
    if (m.rsAboveHead >= 1.05) s += 15;
    if (m.necklineSlope <= 15) s += 15;
    const broke = m.breakoutRatio >= k.breakPct;
    if (broke) s += 20;
    if (m.breakoutVolRatio >= k.volMult) s += 15;
    let status = m.headDeepest ? 1 : 0;
    if (broke) status = 3; else if (m.breakoutRatio >= -2) status = 2;
    return { score: Math.round(s), status };
  }

  function scoreFlag(m, th) {
    const k = th.common; let s = 0;
    if (m.poleRisePct >= 15) s += 25;
    if (inRange(m.flagDepthPct, 5, 20)) s += 15; else if (m.flagDepthPct <= 30) s += 7;
    if (inRange(m.flagDays, 5, 25)) s += 10;
    if (m.flagVolRatio < 1) s += 10;
    const broke = m.breakoutRatio >= k.breakPct;
    if (broke) s += 25;
    if (m.breakoutVolRatio >= k.volMultWeak) s += 15;
    let status = m.poleRisePct >= 15 ? 1 : 0;
    if (broke) status = 3; else if (m.breakoutRatio >= -2 && m.poleRisePct >= 15) status = 2;
    return { score: Math.round(s), status };
  }

  function scoreBaseOnBase(m, th) {
    const k = th.common; let s = 0;
    if (m.firstBroke) s += 25;
    if (m.secDepthPct <= 15) s += 25; else if (m.secDepthPct <= 20) s += 12;
    if (m.aboveMa50) s += 20;
    const broke = m.breakoutRatio >= k.breakPct;
    if (broke) s += 20;
    if (m.breakoutVolRatio >= k.volMultWeak) s += 10;
    let status = m.firstBroke ? 1 : 0;
    if (broke) status = 3; else if (m.firstBroke && m.breakoutRatio >= -2) status = 2;
    return { score: Math.round(s), status };
  }

  // 警戒系: スコアが高い＝危険度が高い。ステータス 3=ネックライン割れ(発生) / 2=完成間近 / 1=形成中
  function scoreHSTop(m, th) {
    let s = 0;
    if (m.headHighest) s += 25;
    if (m.rsBelowHead <= 0.95) s += 20;
    if (m.shoulderSym <= 15) s += 15;
    const broke = m.breakdownRatio <= -th.common.breakPct;
    if (broke) s += 40;
    let status = m.headHighest ? 1 : 0;
    if (broke) status = 3; else if (m.headHighest && m.rsBelowHead <= 0.97) status = 2;
    return { score: Math.round(s), status };
  }

  // 逆張り警戒: 安値更新＋出来高増加（高いほど危険）
  function scoreNewLowHighVol(m) {
    let s = 0; const broke = m.belowLow && m.breakPct <= -0.5;
    if (broke) s += 40;
    if (m.volRatio >= 1.5) s += 40; if (m.volRatio >= 2) s += 10;
    let status = 0;
    if (broke && m.volRatio >= 1.5) status = 3; else if (broke) status = 2; else if (m.breakPct <= 2) status = 1;
    return { score: Math.min(100, Math.round(s)), status };
  }
  // 逆張り警戒: ベアフラッグ
  function scoreBearFlag(m) {
    let s = 0;
    if (m.dropPct <= -20) s += 20;
    if (m.reboundPct > 0 && m.reboundPct <= 15) s += 20;
    if (m.volDecline) s += 20;
    if (m.breakBelow) s += 40;
    let status = 0;
    if (m.dropPct <= -15 && m.reboundPct <= 20) status = m.breakBelow ? 3 : 1;
    return { score: Math.min(100, Math.round(s)), status };
  }
  // 逆張り警戒: 下降三角持ち合いの下抜け
  function scoreDescTriangle(m) {
    let s = 0;
    if (m.highsFalling) s += 25;
    if (m.flatSupport) s += 20;
    if (m.breakdown) s += 35;
    if (m.volRatio >= 1.5) s += 20;
    let status = 0;
    if (m.highsFalling && m.flatSupport) status = m.breakdown ? 3 : (m.breakPct <= 2 ? 2 : 1);
    return { score: Math.min(100, Math.round(s)), status };
  }

  function scoreDoubleTop(m, th) {
    let s = 0;
    if (m.highGapPct <= 8) s += 25;
    if (m.h2VsH1 <= 3) s += 20;
    if (m.midDropPct >= 8) s += 15;
    const broke = m.breakdownRatio <= -th.common.breakPct;
    if (broke) s += 40;
    let status = m.highGapPct <= 8 ? 1 : 0;
    if (broke) status = 3; else if (m.highGapPct <= 8) status = 2;
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
      best, bestTrend: sc.bestTrend, bestContra: sc.bestContra, trendTotal: sc.trendTotal, contraTotal: sc.contraTotal, totalScore: sc.totalScore, contraScore: sc.contraScore, warn: sc.warn, patterns: sc.patterns, metrics, levels, marks, evidence,
      ma: meas.ma, ma200Pos: meas.ma200Pos, ma200Slope: meas.ma200Slope,
      rsi: meas.rsi, rsiState: meas.rsiState, macd: meas.macd, macdCross: meas.macdCross,
      dev52w: meas.dev52w, above5: meas.above5,
    };
  }

  // 保存済み結果（patterns＋文脈）から総合を再計算する。集計式を変えても再取得なしで反映できる。
  function recomputeTotals(stored) {
    if (!stored || !stored.patterns) return null;
    const meas = {
      ma200Pos: stored.ma200Pos, ma200Slope: stored.ma200Slope,
      macdCross: stored.macdCross, rsiState: stored.rsiState,
      dev52w: stored.dev52w != null ? stored.dev52w : null,
      above5: stored.above5,
    };
    const trendTotal = sideTotal(stored.patterns, TREND_PATTERNS, 'trend', meas);
    const contraTotal = sideTotal(stored.patterns, CONTRA_PATTERNS, 'contra', meas);
    return { trendTotal, contraTotal, totalScore: Math.max(trendTotal, contraTotal) };
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

  // ===== RSI / MACD サブチャート（折れ線・ヒストグラム） =====
  // series は表示用バー(disp)に整合した配列にして渡す。横位置は candleSVG と同じ等間隔。
  function rsiSVG(series, opts) {
    opts = opts || {}; const W = opts.width || 760, H = opts.height || 90, pad = { l: 56, r: 92, t: 14, b: 14 };
    const N = series.length, plotW = W - pad.l - pad.r;
    const cx = i => pad.l + (i + 0.5) / N * plotW;
    const py = v => pad.t + (1 - v / 100) * (H - pad.t - pad.b);
    let bands = '';
    [30, 50, 70].forEach(lv => { const y = py(lv).toFixed(1); bands += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="var(--border)" stroke-width="1" stroke-dasharray="${lv === 50 ? '1 4' : '3 3'}"/><text x="${pad.l - 6}" y="${+y + 3}" fill="var(--muted)" font-size="9" text-anchor="end">${lv}</text>`; });
    let path = '', started = false;
    series.forEach((v, i) => { if (v == null) { started = false; return; } path += (started ? 'L' : 'M') + cx(i).toFixed(1) + ' ' + py(v).toFixed(1) + ' '; started = true; });
    const last = series[series.length - 1];
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;background:var(--panel);border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px">
      <text x="${pad.l}" y="10" fill="var(--muted)" font-size="9">RSI(14)${last != null ? ' ' + last.toFixed(0) : ''}</text>
      ${bands}<path d="${path}" fill="none" stroke="#7c3aed" stroke-width="1.3"/></svg>`;
  }
  function macdSVG(m, opts) {
    opts = opts || {}; const W = opts.width || 760, H = opts.height || 90, pad = { l: 56, r: 92, t: 14, b: 14 };
    const N = m.macd.length, plotW = W - pad.l - pad.r;
    const vals = []; m.macd.forEach(v => { if (v != null) vals.push(v); }); m.signal.forEach(v => { if (v != null) vals.push(v); }); m.hist.forEach(v => { if (v != null) vals.push(v); });
    let lo = Math.min(...vals, 0), hi = Math.max(...vals, 0); if (lo === hi) { lo -= 1; hi += 1; }
    const cx = i => pad.l + (i + 0.5) / N * plotW;
    const py = v => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
    const cw = Math.max(1, plotW / N * 0.6);
    let hist = ''; m.hist.forEach((v, i) => { if (v == null) return; const y0 = py(0), y = py(v); hist += `<rect x="${(cx(i) - cw / 2).toFixed(1)}" y="${Math.min(y0, y).toFixed(1)}" width="${cw.toFixed(1)}" height="${Math.max(1, Math.abs(y - y0)).toFixed(1)}" fill="${v >= 0 ? 'rgba(22,163,74,.5)' : 'rgba(220,38,38,.5)'}"/>`; });
    const line = (arr, col) => { let p = '', st = false; arr.forEach((v, i) => { if (v == null) { st = false; return; } p += (st ? 'L' : 'M') + cx(i).toFixed(1) + ' ' + py(v).toFixed(1) + ' '; st = true; }); return `<path d="${p}" fill="none" stroke="${col}" stroke-width="1.3"/>`; };
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;background:var(--panel);border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px">
      <text x="${pad.l}" y="10" fill="var(--muted)" font-size="9">MACD(12,26,9)</text>
      <line x1="${pad.l}" y1="${py(0).toFixed(1)}" x2="${W - pad.r}" y2="${py(0).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
      ${hist}${line(m.macd, '#0ea5e9')}${line(m.signal, '#f59e0b')}</svg>`;
  }

  // ラベル・分類
  const PATTERN_LABEL = {
    cup: 'カップウィズハンドル', range: 'レンジブレイク', doubleBottom: 'ダブルボトム', ascTriangle: 'アセンディングトライアングル',
    roundBottom: 'ラウンドボトム', invHS: '逆三尊', flag: 'フラッグ/ペナント', baseOnBase: 'ベース・オン・ベース',
    undercutRally: 'アンダーカット&ラリー', sellingClimax: 'セリングクライマックス',
    rsiDivergence: 'RSIダイバージェンス', bollingerRecover: 'ボリンジャー-2σ回復', maDeviation: 'MA大幅下方乖離', gapFill: '窓開け急落の下げ止まり', volDryUp: '出来高減少下落',
    hsTop: '三尊天井(警戒)', doubleTop: 'ダブルトップ(警戒)',
    newLowHighVol: '安値更新＋出来高増(警戒)', bearFlag: 'ベアフラッグ(警戒)', descTriangle: '下降三角の下抜け(警戒)',
  };
  // 順張り（上に抜けたら買い）と 逆張り（下げ止まり/反転を拾う）でシグナルを分類。総合スコアは各サイドで別算出。
  const TREND_PATTERNS = ['cup', 'range', 'ascTriangle', 'flag', 'baseOnBase'];
  const CONTRA_PATTERNS = ['doubleBottom', 'invHS', 'roundBottom', 'undercutRally', 'sellingClimax', 'rsiDivergence', 'bollingerRecover', 'maDeviation', 'gapFill', 'volDryUp'];
  const BUY_PATTERNS = [...TREND_PATTERNS, ...CONTRA_PATTERNS];
  const WARN_PATTERNS = ['hsTop', 'doubleTop'];                       // 順張り(高値圏の天井)系の警戒
  const CONTRA_WARN_PATTERNS = ['newLowHighVol', 'bearFlag', 'descTriangle']; // 逆張り(底抜け継続)系の警戒
  const PATTERN_SIDE = (p) => CONTRA_PATTERNS.includes(p) ? 'contra' : TREND_PATTERNS.includes(p) ? 'trend' : 'warn';
  const STATUS_LABEL = { 0: '—', 1: '形成中', 2: '完成間近', 3: 'ブレイク済み', 4: '失敗' };
  // 逆張り用のステータス語彙（売られすぎ→下げ止まり→反転確認→下抜け継続）。状態intは共通(0-4)で意味だけ差し替え。
  const CONTRA_STATUS_LABEL = { 0: '—', 1: '売られすぎ', 2: '下げ止まり候補', 3: '反転確認', 4: '下抜け継続' };

  globalThis.TA = {
    DEFAULT_THRESHOLDS, DEFAULT_STRUCT, PATTERN_LABEL, BUY_PATTERNS, WARN_PATTERNS, STATUS_LABEL,
    TREND_PATTERNS, CONTRA_PATTERNS, CONTRA_WARN_PATTERNS, PATTERN_SIDE, CONTRA_STATUS_LABEL,
    measure, score, analyze, recomputeTotals, candleSVG, rsiSVG, macdSVG, toWeekly, sma, rsi, macd, bollinger, mergeThresholds,
  };
})();
