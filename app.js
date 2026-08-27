/* 証券管理ツール — MVP (ログインなし / localStorage保存)
 *
 * 構成メモ:
 *  - データは localStorage に保存（将来 Google スプレッドシートへ移行予定）
 *  - 価格・為替は「キャッシュ」扱いで、/api/price (Yahoo中継) から取得 or 手入力
 *  - 買い増し判定: 初回=基準高値-40% / 買い増し=前回購入価格-20%（ルールマスタで変更可・銘柄ごとに割当可）
 *  - 金額はカテゴリ別マスタ（日本株=円 / 米国株=÷100ドル）
 *  - 評価額・損益は原通貨ベース。円換算は併記（米株のみ為替換算）
 *  - 市場(米国株/日本株/投信)を分離して表示。一覧はソート/フィルタ対応
 *  - 銘柄分析結果（評価・★・推奨カテゴリ等）を銘柄に紐づけ。Excel貼付けで一括取込
 */
// アプリのバージョン（v{YYYYMMDD}-{HHMM} JST）。コミットのたびに必ず更新し、すみぽんへ報告する（CLAUDE.md ルール8）。
// マスタ（設定）画面の最上部に表示。index.html の ?v= キャッシュバスターも同じ日時に揃える。
const APP_VERSION = 'v20260827-1820';

'use strict';

// ---------- 定数・初期データ ----------
const STORAGE_KEY = 'sm_data_v1';

// ===== IndexedDB（大容量データの保存先。localStorage 約5MB制限の外・§16.7.5） =====
// techAnalysis（テクニカル分析結果）と同期の基準(syncBase)をここに置く。localStorage は
// 「本体データ＋同期基準のコピー」で実質2倍消費し上限97%に達した（2026-08-18 実測）ための退避先。
// IndexedDB が使えない環境では idb.ok=false になり、従来どおり localStorage に保存する（後方互換）。
const idb = {
  _dbp: null, ok: (typeof indexedDB !== 'undefined'),
  _open() {
    if (this._dbp) return this._dbp;
    this._dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open('sm_idb', 1);
        req.onupgradeneeded = () => { try { req.result.createObjectStore('kv'); } catch (_) {} };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { idb.ok = false; resolve(null); };
        req.onblocked = () => { idb.ok = false; resolve(null); };
      } catch (_) { idb.ok = false; resolve(null); }
    });
    return this._dbp;
  },
  async get(key) {
    const db = await this._open(); if (!db) return undefined;
    return new Promise((resolve) => {
      try {
        const rq = db.transaction('kv').objectStore('kv').get(key);
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => resolve(undefined);
      } catch (_) { resolve(undefined); }
    });
  },
  async set(key, val) {
    const db = await this._open(); if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (_) { resolve(false); }
    });
  },
  async del(key) {
    const db = await this._open(); if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (_) { resolve(false); }
    });
  },
};
// テクニカル分析結果(techAnalysis)の保持上限（localStorage 約5MB対策。実測でここが全体の約8割を占めていた）
const TECH_HISTORY_MAX = 26;   // スコア履歴の点数（容量対策で52→26。現状どこからも読まれていない・§16.7.4）
const TECH_UNREG_DAYS = 14;    // 未登録銘柄（分析タブのトップ50等）の分析結果を残す日数
const TECH_UNREG_MAX = 30;     // 未登録銘柄の分析結果の最大保持件数（新しい順。実測54件→30件に圧縮）

const DEFAULT_CATEGORIES = [
  { category: '王道・鉄板', label: '文明のインフラ', amountJpy: 80000, amountUsd: 800, sortOrder: 1, color: 'gold' },
  { category: '主力・成長', label: '世界的覇権', amountJpy: 60000, amountUsd: 600, sortOrder: 2, color: 'blue' },
  { category: '準主力', label: '地域覇者・ニッチ', amountJpy: 50000, amountUsd: 500, sortOrder: 3, color: 'cyan' },
  { category: '防御・配当', label: '成熟・安定', amountJpy: 40000, amountUsd: 400, sortOrder: 4, color: 'green' },
  { category: '有望な投機', label: '宝くじのエース', amountJpy: 25000, amountUsd: 250, sortOrder: 5, color: 'orange' },
  { category: 'お遊び', label: '記念・優待', amountJpy: 15000, amountUsd: 150, sortOrder: 6, color: 'purple' },
  { category: '対象外', label: '投資不適格', amountJpy: 0, amountUsd: 0, sortOrder: 7, color: 'gray' },
];

// 投資カテゴリ（分析結果のカテゴリ＝どういう枠か。高配当/テーマ株 等のラベル）。金額とは無関係のラベルマスタ。
// 既存の「カテゴリ（投資額カテゴリ）」とは別管理。色は LABEL_COLORS を共有。
const DEFAULT_INVEST_CATEGORIES = [
  { name: 'テーマ',    color: 'cyan',   sortOrder: 1 },
  { name: 'お遊び',    color: 'purple', sortOrder: 2 },
  { name: 'コア',      color: 'gold',   sortOrder: 3 },
  { name: '王道',      color: 'brass',  sortOrder: 4 },
  { name: '主力',      color: 'blue',   sortOrder: 5 },
  { name: '準主力',    color: 'gray',   sortOrder: 6 },
  { name: '投機',      color: 'orange', sortOrder: 7 },
  { name: '宝くじ',    color: 'pink',   sortOrder: 8 },
  { name: '防御・配当', color: 'green',  sortOrder: 9 },
];
// 銘柄ラベル（投資テーマ・分類）マスタ。1銘柄に複数付与できるタグ。前提が崩れた時に
// ラベルで絞って一括判断（売却等）する用途。色・並び順のみ持つ（金額とは無関係）。
const DEFAULT_LABELS = [
  { name: '半導体',  color: 'blue',   sortOrder: 1 },
  { name: '宇宙',    color: 'purple', sortOrder: 2 },
  { name: '防衛',    color: 'gray',   sortOrder: 3 },
  { name: '高配当',  color: 'green',  sortOrder: 4 },
];

// ラベル色プリセット（カテゴリ・格付け等のマスタで共有。将来ルール名など他ラベルにも流用可）。
// key を categories[].color / grades[].color に保存し、labelColorStyle() でインライン style を生成する。
const LABEL_COLORS = [
  { key: 'gray',   name: 'グレー', bg: 'var(--panel-3)',    border: 'var(--border)', text: 'var(--muted)' },
  { key: 'brass',  name: '真鍮',   bg: 'var(--brass-soft)', border: '#e8dcc2',       text: 'var(--brass-d)' },
  { key: 'blue',   name: '青',     bg: '#eef3fb',           border: '#aac4e6',       text: '#2a5599' },
  { key: 'green',  name: '緑',     bg: '#eef7f1',           border: '#9ccbb0',       text: 'var(--up-ink)' },
  { key: 'red',    name: '赤',     bg: '#fbeeee',           border: '#e3a9a5',       text: 'var(--down-ink)' },
  { key: 'gold',   name: '金',     bg: '#fbf3e0',           border: '#d6ad5b',       text: '#9a6a12' },
  { key: 'purple', name: '紫',     bg: '#f1edf8',           border: '#e3d9f1',       text: '#6a4ca8' },
  { key: 'cyan',   name: 'シアン', bg: '#eafafc',           border: '#bfe3ea',       text: '#0e7490' },
  { key: 'orange', name: '橙',     bg: 'var(--warn-soft)',  border: '#ecd9b3',       text: 'var(--warn)' },
  { key: 'pink',   name: '桃',     bg: '#fdeef4',           border: '#f3c9da',       text: '#b13a6a' },
];
const LABEL_COLOR_MAP = Object.fromEntries(LABEL_COLORS.map(c => [c.key, c]));
function labelColorStyle(key) {
  const c = LABEL_COLOR_MAP[key];
  return c ? `background:${c.bg};border-color:${c.border};color:${c.text}` : '';
}

// 銘柄格付け（S/A/B/C/D）の色マスタ。値・順位は GRADE_RANK 固定、ここでは表示色だけを管理する。
const DEFAULT_GRADES = [
  { grade: 'S', color: 'gold',  desc: '最上位' },
  { grade: 'A', color: 'green', desc: '優良' },
  { grade: 'B', color: 'blue',  desc: '標準' },
  { grade: 'C', color: 'gray',  desc: '要検討' },
  { grade: 'D', color: 'red',   desc: '不適格' },
];

const DEFAULT_RULE = {
  id: 1, name: '標準ルール', initialDropPct: 40, addonDropPct: 20, baseHighMode: '5y', isDefault: true,
};

// マトリックスの取得価額レンジ（円換算・1銘柄あたり）。max未満で区分・最後はmax=nullで「それ以上」。色はソリッドなhex。
const DEFAULT_MATRIX_BANDS = [
  { max: 100000,  label: '〜10万',    color: '#eef3fb' },
  { max: 300000,  label: '10〜30万',  color: '#c9dcf4' },
  { max: 500000,  label: '30〜50万',  color: '#8fb4e8' },
  { max: 1000000, label: '50〜100万', color: '#4f82cf' },
  { max: null,    label: '100万〜',   color: '#274b87' },
];
// マトリックス レンジ設定の色パレット（ソリッド。青ランプ＋アクセント色）
const MATRIX_BAND_COLORS = ['#eef3fb', '#c9dcf4', '#8fb4e8', '#4f82cf', '#274b87', '#eef7f1', '#9ccbb0', '#3a7d44', '#fbf3e0', '#d6ad5b', '#fbeeee', '#e3a9a5', '#c0392b', '#f1edf8', '#9b7cc8', '#6a4ca8', '#f4f4f6', '#c8ccd4', '#6b7280'];
// 背景色(hex)に対する文字色（明度で白/濃紺を出し分け）。hex以外（旧データ）は濃紺。
function mxText(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#15233c';
  const n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) < 140 ? '#fff' : '#15233c';
}
function mxChipStyle(color) { return `background:${color};color:${mxText(color)};border:1px solid rgba(0,0,0,.08)`; }
// ソリッド色のスウォッチ選択UI（colorSwatchPicker と同じ .color-pick 構造。pickColor が hidden input に hex を格納）
function solidSwatchPicker(name, selected) {
  return `<div class="color-pick" data-name="${esc(name)}">${MATRIX_BAND_COLORS.map(c => `
    <button type="button" class="cswatch${c === selected ? ' on' : ''}" data-key="${c}" title="${c}" style="background:${c};color:${mxText(c)};border-color:rgba(0,0,0,.15)" onclick="pickColor(this)">A</button>`).join('')}
    <input type="hidden" name="${esc(name)}" value="${esc(selected || '')}"></div>`;
}
const DEFAULT_MATRIX_USDJPY = 100; // 「全部」表示・米国株取得額の円換算レート（初期値。マスタで変更可）
// 前日終値の取得ロジック版。上げると当日でも refreshPrevCloses を一度だけ再計算（取引所TZ今日基準の修正を即反映）。
// 5: 休場日・寄り付き前に前日比が0%に潰れる不具合の修正（前日終値の基準日を現在値のセッションに）を全銘柄へ反映。
const PREVCLOSE_VER = 6;

const MARKET_LABEL = { US: '米国株', JP: '日本株', FUND: '投信' };
const MARKET_CCY = { US: '$', JP: '¥', FUND: '¥' };
const BASE_HIGH_LABEL = { '5y': '5年高値', '52w': '52週高値', 'all': '上場来高値', 'manual': '手動指定' };
const BROKERS = ['SBI', '楽天', 'Webull', 'moomoo', 'SMBC日興', 'マネックス'];
const ACCOUNTS = ['特定', 'NISA', '一般'];
// ---------- カラム定義 ----------
// 全カラムのマスタ定義。配列の順＝表示順のベース（ピッカーで個別に並び替え可）
// markets に含む画面でのみ選択可能。'SIGNAL' はサインタブ。
const ALLM = ['US','JP','FUND','SIGNAL','ANALYSIS'];
const STKM = ['US','JP','SIGNAL','ANALYSIS'];
const MASTER_COLS = [
  { key: 'ticker',      label: 'コード',           left: true,  markets: ALLM, noSort: false, narrow: true },
  { key: 'name',        label: '銘柄名',           left: true,  markets: ALLM, noSort: false },
  { key: 'detailType',  label: '詳細種別',         left: true,  markets: STKM, noSort: false },
  { key: 'market',      label: '市場',             left: true,  markets: ['SIGNAL'], noSort: false },
  { key: 'broker',      label: '証券会社',         left: true,  markets: ALLM, noSort: false },
  { key: 'sigType',     label: '種別',             left: true,  markets: ['SIGNAL'], noSort: false },
  { key: 'price',       label: '現在値',           left: false, markets: ALLM, noSort: false },
  { key: 'day',         label: '前日比',           left: false, markets: ALLM, noSort: false },
  { key: 'prevClose',   label: '前日終値',         left: false, markets: ALLM, noSort: false },
  { key: 'dayAmt',      label: '前日比値幅',       left: false, markets: ALLM, noSort: false },
  { key: 'extPrice',    label: '時間外',           left: false, markets: ['US', 'SIGNAL'], noSort: false },
  { key: 'trigger',     label: '次回購入',         left: false, markets: STKM, noSort: false },
  { key: 'trigBasis',   label: '適用区分',         left: true,  markets: STKM, noSort: true, narrow: true },
  { key: 'reachKind',   label: '到達区分',         left: true,  markets: STKM, noSort: false, narrow: true },
  { key: 'base',        label: '基準値',           left: false, markets: ['SIGNAL'], noSort: false },
  { key: 'drop',        label: '残り下落率',       left: false, markets: STKM, noSort: false },
  { key: 'dropPrev',    label: '残り下落率(前日)', left: false, markets: STKM, noSort: false },
  { key: 'high5y',      label: '5年高値',          left: false, markets: STKM, noSort: false },
  { key: 'high52w',     label: '52週高値',         left: false, markets: STKM, noSort: false },
  { key: 'dropFrom5y',  label: '5年高値からの下落率', left: false, markets: STKM, noSort: false },
  { key: 'dropFrom52w', label: '52週高値からの下落率', left: false, markets: STKM, noSort: false },
  { key: 'low1y',       label: '1年安値',          left: false, markets: STKM, noSort: false },
  { key: 'low3y',       label: '3年安値',          left: false, markets: STKM, noSort: false },
  { key: 'riseFrom1y',  label: '1年安値からの上昇率', left: false, markets: STKM, noSort: false },
  { key: 'riseFrom3y',  label: '3年安値からの上昇率', left: false, markets: STKM, noSort: false },
  { key: 'prevBuyPrice', label: '前回購入単価',     left: false, markets: STKM, noSort: false },
  { key: 'prevBuyDate',  label: '前回購入日',       left: true,  markets: STKM, noSort: false },
  { key: 'earnPrev',     label: '前回決算',          left: true,  markets: STKM, noSort: false },
  { key: 'earnNext',     label: '次回決算',          left: true,  markets: STKM, noSort: false },
  { key: 'dropFromPrev', label: '前回からの下落率', left: false, markets: STKM, noSort: false },
  { key: 'sector',      label: 'セクター',         left: true,  markets: STKM, noSort: false },
  { key: 'industry',    label: '業種',             left: true,  markets: STKM, noSort: false },
  { key: 'marketCap',   label: '時価総額',          left: false, markets: STKM, noSort: false },
  // 市場の時価総額1位（日米別）まで何倍か。例: 1位NVDA 4.99T に対しMU 1.00T なら「3.99倍」(=+399%の上昇余地)
  { key: 'capToTop',    label: '時価1位まで',       left: false, markets: STKM, noSort: false },
  { key: 'turnover',    label: '売買代金',          left: false, markets: STKM, noSort: false },
  { key: 'value',       label: '評価額',           left: false, markets: ALLM, noSort: false },
  { key: 'cost',        label: '取得価額',         left: false, markets: ALLM, noSort: false },
  { key: 'origCost',    label: '購入額（本来）',    left: false, markets: ALLM, noSort: false },
  { key: 'acqJpy',      label: '取得円(円)',       left: false, markets: STKM, noSort: false },
  // 資産に占める割合（分母はツールバーの「比率の分母」で切替＝日米合計/表示中/市場別/手入力）
  { key: 'ratioValue',  label: '評価額比率',       left: false, markets: STKM, noSort: false },
  { key: 'ratioCost',   label: '取得額比率',       left: false, markets: STKM, noSort: false },
  { key: 'pnl',         label: '損益率',           left: false, markets: ALLM, noSort: false },
  { key: 'avgCost',     label: '取得単価',         left: false, markets: ALLM, noSort: false },
  { key: 'qty',         label: '数量',             left: false, markets: ALLM, noSort: false },
  { key: 'buyCount',    label: '購入回数',         left: false, markets: ALLM, noSort: false },
  { key: 'buyAmount',   label: '買い増し予定額',    left: false, markets: ALLM, noSort: false },
  { key: 'reco',        label: '推奨購入額',       left: false, markets: ALLM, noSort: false },
  { key: 'category',    label: 'カテゴリ',         left: true,  markets: ALLM, noSort: false },
  { key: 'investCategory', label: '投資カテゴリ',  left: true,  markets: ALLM, noSort: false },
  { key: 'labels',      label: '銘柄ラベル',       left: true,  markets: ALLM, noSort: false },
  { key: 'ruleName',    label: '買い増しルール',    left: true,  markets: ALLM, noSort: false },
  { key: 'fixedBuyPrice', label: '買増固定値',       left: false, markets: STKM, noSort: false },
  { key: 'addonFromHigh', label: '買増を初回基準',    left: true,  markets: STKM, noSort: false, narrow: true },
  { key: 'rating',      label: '銘柄格付',         left: true,  markets: STKM, noSort: false },
  { key: 'per',         label: 'PER',              left: false, markets: STKM, noSort: false },
  { key: 'pbr',         label: 'PBR',              left: false, markets: STKM, noSort: false },
  { key: 'psr',         label: 'PSR',              left: false, markets: ['US'], noSort: false },
  { key: 'dividend',    label: '配当/株',          left: false, markets: STKM, noSort: false },
  { key: 'divYield',    label: '配当利回り',       left: false, markets: STKM, noSort: false },
  { key: 'yieldOnCost', label: '取得利回り',       left: false, markets: STKM, noSort: false },
  { key: 'eps',         label: 'EPS',              left: false, markets: STKM, noSort: false },
  // 目標指標から逆算した株価（参考値・判定には未使用）。目標値そのもの(targetPer/Pbr/Yield)は
  // 銘柄編集フォーム・カルテ・取込で扱い、表には「算出株価」だけ出す（2026-08-01 すみぽん決定）
  { key: 'targetPerPrice',   label: '目標PER株価',   left: false, markets: STKM, noSort: false },
  { key: 'targetPbrPrice',   label: '目標PBR株価',   left: false, markets: STKM, noSort: false },
  { key: 'targetYieldPrice', label: '目標利回り株価', left: false, markets: STKM, noSort: false },
  { key: 'marginRatio', label: '信用倍率',         left: false, markets: ['JP', 'SIGNAL'], noSort: false },
  // 取り込んだ銘柄分析結果（既定非表示・列設定で表示可）
  { key: 'overallGrade', label: '総合評価',        left: true,  markets: STKM, noSort: false },
  { key: 'buyGrade',     label: '買い時評価',      left: true,  markets: STKM, noSort: false },
  { key: 'priority',     label: '購入優先順位',    left: false, markets: STKM, noSort: false },
  { key: 'stars',        label: '★(ﾊﾞﾘｭ/強/ﾘｽｸ)', left: true,  markets: STKM, noSort: true },
  { key: 'analysisDate', label: '評価日',          left: true,  markets: STKM, noSort: false },
  { key: 'analysisNote', label: '分析メモ',        left: true,  markets: STKM, noSort: true },
  // 株価シナリオ分析（短期・中期の予想レンジ。既定非表示・列設定で表示可）。位置=現在値がどのレンジか（派生）
  { key: 'stScenario',    label: '短期シナリオ',       left: true,  markets: STKM, noSort: false },
  { key: 'mtScenario',    label: '中期シナリオ',       left: true,  markets: STKM, noSort: false },
  { key: 'stScenPos',     label: '短期シナリオ位置',   left: true,  markets: STKM, noSort: false },
  { key: 'mtScenPos',     label: '中期シナリオ位置',   left: true,  markets: STKM, noSort: false },
  { key: 'scenarioDate',  label: 'シナリオ分析日',     left: true,  markets: STKM, noSort: false },
  { key: 'scenarioPrice', label: 'シナリオ時株価',     left: false, markets: STKM, noSort: false },
  { key: 'memo',        label: 'メモ',             left: true,  markets: ALLM, noSort: true },
  // 元本売却（情報管理のみ・既定非表示）
  { key: 'principalSold',       label: '元本売却済み',   left: true,  markets: ALLM, noSort: false },
  { key: 'principalSoldAmount', label: '売却済み元本額', left: false, markets: ALLM, noSort: false },
  // テクニカル分析（分析タブ専用）。各シグナルの強さ(0-100)。総合は順張り/逆張りで別評価。
  { key: 'anaTotal',    label: '総合買いシグナル', left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaTrend',    label: '順張り総合',       left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaContra',   label: '逆張り総合',       left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaCup',      label: 'カップ',           left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaRange',    label: 'レンジブレイク',   left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaWbottom',  label: 'ダブルボトム',     left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaAsc',      label: 'アセンディング',   left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaRound',    label: 'ラウンドボトム',   left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaInvHS',    label: '逆三尊',           left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaUndercut', label: 'アンダーカット&ラリー', left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaClimax',   label: 'セリングクライマックス', left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaRsiDiv',   label: 'RSIダイバージェンス', left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaBoll',     label: 'ボリンジャー-2σ回復', left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaMaDev',    label: 'MA大幅下方乖離',   left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaGap',      label: '窓開け下げ止まり', left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaVolDry',   label: '出来高減少下落',   left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaFlag',     label: 'フラッグ',         left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaBase',     label: 'ベースオンベース', left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaWarn',     label: '順張り警戒',       left: true,  markets: ['ANALYSIS'], noSort: false },
  { key: 'anaWarnC',    label: '逆張り警戒',       left: true,  markets: ['ANALYSIS'], noSort: false },
  // 警戒パターン個別列（集約＝順張り警戒/逆張り警戒。詳細サイドバーと対応）
  { key: 'anaHsTop',    label: '三尊天井',         left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaDblTop',   label: 'ダブルトップ',     left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaNewLow',   label: '安値更新+出来高',  left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaBearFlag', label: 'ベアフラッグ',     left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaDescTri',  label: '下降三角',         left: false, markets: ['ANALYSIS'], noSort: false },
  // 確認に効く文脈指標（総合の加点条件）。200日線=順張りの確認 / RSI・5日線・52週乖離=逆張りの確認 / MACD=共通
  { key: 'anaMa200',    label: '200日線',          left: true,  markets: ['ANALYSIS'], noSort: false },
  { key: 'anaRSI',      label: 'RSI',              left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'ana5d',       label: '5日線',            left: true,  markets: ['ANALYSIS'], noSort: false },
  { key: 'anaDev52w',   label: '52週乖離',         left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaMACD',     label: 'MACD',             left: true,  markets: ['ANALYSIS'], noSort: false },
  { key: 'anaStatus',   label: 'ステータス',       left: true,  markets: ['ANALYSIS'], noSort: false },
  { key: 'anaBuy',      label: '買い候補',         left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaFail',     label: '失敗ライン',       left: false, markets: ['ANALYSIS'], noSort: false },
  { key: 'anaDate',     label: '分析日',           left: true,  markets: ['ANALYSIS'], noSort: false },
];
// デフォルト表示列（市場ごと）。表示順は MASTER_COLS の順、ここに含まれるkeyが初期表示
const DEFAULT_VISIBLE = {
  US:   ['ticker','name','price','day','prevClose','dayAmt','extPrice','trigger','trigBasis','drop','dropPrev','high5y','high52w','prevBuyPrice','prevBuyDate','dropFromPrev','dropFrom5y','low1y','low3y','riseFrom1y','riseFrom3y','sector','industry','marketCap','capToTop','turnover','value','cost','origCost','ratioValue','ratioCost','pnl','avgCost','qty','buyCount','buyAmount','category','investCategory','labels','ruleName','fixedBuyPrice','rating','targetPerPrice','targetPbrPrice','targetYieldPrice'],
  JP:   ['ticker','name','price','day','prevClose','dayAmt','trigger','trigBasis','drop','dropPrev','high5y','high52w','prevBuyPrice','prevBuyDate','dropFromPrev','dropFrom5y','low1y','low3y','riseFrom1y','riseFrom3y','sector','industry','marketCap','capToTop','turnover','marginRatio','value','cost','origCost','ratioValue','ratioCost','pnl','avgCost','qty','buyCount','buyAmount','category','investCategory','labels','ruleName','fixedBuyPrice','rating','targetPerPrice','targetPbrPrice','targetYieldPrice'],
  FUND: ['ticker','name','price','value','cost','pnl','avgCost','qty','buyCount','buyAmount','category'],
  SIGNAL: ['ticker','name','market','broker','sigType','price','day','prevClose','dayAmt','drop','dropPrev','reachKind','trigger','trigBasis','base','prevBuyPrice','prevBuyDate','dropFromPrev','dropFrom5y','ratioValue','ratioCost','buyAmount','reco','ruleName','fixedBuyPrice','rating'],
  ANALYSIS:   ['ticker','name','price','anaContra','anaTotal','anaWbottom','anaInvHS','anaRound','anaUndercut','anaClimax','anaRsiDiv','anaBoll','anaMaDev','anaGap','anaVolDry','anaWarnC','anaRSI','anaDev52w','ana5d','anaMACD','anaStatus','anaDate'],
  ANALYSIS_T: ['ticker','name','price','anaTrend','anaTotal','anaCup','anaRange','anaAsc','anaFlag','anaBase','anaWarn','anaMa200','anaMACD','anaStatus','anaDate'],
  // マーケットランキングタブ（既定＝現状維持）。順位/コード/名称は先頭固定列で、ここには含めない。
  MKTRANK: ['market','price','day','high5y','dropFrom5y','turnover','marketCap','capToTop'],
};
// マーケットランキングで列設定に出せる項目（追加取得ゼロで出せる市場データ＋登録済み銘柄のツール内情報）。
// MASTER_COLS に実在するkeyのみ（resetColPrefs 側で実在チェックして交差を取る）。表示順もこの順。
const MKTRANK_KEYS = ['market','price','day','prevClose','dayAmt','high5y','dropFrom5y','high52w','dropFrom52w','low1y','low3y','riseFrom1y','riseFrom3y','turnover','marketCap','capToTop','sector','industry','category','investCategory','labels','ruleName','rating','per','pbr','dividend','divYield','buyAmount'];
// このうち「市場データ列」＝ランキング取得値(it)から描画する（store.data.prices を参照しない）。残りは登録済み銘柄のみ COL_RENDERERS(sec) に委譲。
const MKTRANK_IT_KEYS = new Set(['market','price','day','prevClose','dayAmt','high5y','dropFrom5y','high52w','dropFrom52w','low1y','low3y','riseFrom1y','riseFrom3y','turnover','marketCap']);
// 配当は米株のみランキング取得値に含まれる（USスクリーナーの同一レスポンス＝追加取得ゼロ）。
// 日本株ランキングのHTMLには無いので、it に値が無ければ登録済み銘柄のマスタ値へフォールバックする両対応列。
// capToTop（時価1位まで）もハイブリッド: 時価総額ランキングは it.marketCap から算出でき、
// 売買代金/値上がり等のランキングには時価総額が無いので登録済み銘柄の値（calc）へフォールバックする。
const MKTRANK_HYBRID_KEYS = new Set(['dividend','divYield','capToTop']);
const COL_PREFS_KEY = 'sm_colprefs_v2';

// 分析メタの取込列マッピング（Excel「銘柄分析結果」のヘッダ名 → 内部キー）
const ANALYSIS_COLMAP = {
  '評価日': 'analysisDate', '銘柄名': 'ticker', 'ティッカー': 'ticker', 'コード': 'ticker',
  '総合評価': 'overallGrade', '総合ランク': 'overallGrade', '総合': 'overallGrade',
  '銘柄格付': 'rating', '銘柄格付け': 'rating', '格付': 'rating', '格付け': 'rating',
  '買い時評価': 'buyGrade', '買い時': 'buyGrade',
  '推奨投資額': 'recoAmount', 'カテゴリ': 'category', '推奨カテゴリ': 'category',
  '投資カテゴリ': 'investCategory', '銘柄ラベル': 'labels', 'ラベル': 'labels', 'タグ': 'labels',
  'バリュエーション': 'starValuation', '独自の強み': 'starStrength', 'リスク': 'starRisk',
  '備考': 'analysisNote', '評価時点_購入優先順位': 'priority', '購入優先順位': 'priority',
  'セクター': 'sector', '業種': 'industry', '時価総額(百万)': 'marketCap',
  'PER': 'per', 'EPS': 'eps', '年間配当/株': 'dividend',
};
// 取込内部キー → 日本語ラベル（プレビューで「どの列がどの項目に入るか」を見せる用）
const IMPORT_FIELD_LABELS = {
  ticker: 'コード', analysisDate: '評価日', overallGrade: '総合評価', rating: '銘柄格付', buyGrade: '買い時評価',
  recoAmount: '推奨投資額', category: 'カテゴリ', investCategory: '投資カテゴリ', starValuation: 'バリュエーション', starStrength: '独自の強み',
  starRisk: 'リスク', analysisNote: '備考', priority: '購入優先順位', sector: 'セクター', industry: '業種',
  marketCap: '時価総額', per: 'PER', eps: 'EPS', dividend: '年間配当/株',
  broker: '証券会社', accountType: '口座種別', avgCost: '取得単価', quantity: '数量', acquiredCost: '取得価額',
};
// 分析履歴(analyses)に持たせる評価項目。銘柄レコードの平置きは「最新分析のミラー」で、
// 実体はこの項目群を securityId×評価日(analysisDate)ごとに analyses へ積む（履歴）。
// フォーム保存・取込の両方がこの集合を上書き源にする（手入力↔取込↔ミラーで一貫）。
const ANALYSIS_FIELDS = ['overallGrade', 'rating', 'buyGrade', 'starValuation', 'starStrength', 'starRisk', 'priority', 'recoAmount', 'analysisNote'];
// 株価シナリオ分析（短期・中期×弱気/ベース/強気の予想レンジ）。銘柄平置きは「最新シナリオのミラー」で、
// 実体は priceScenarios（securityId×分析日 scenarioDate）へ履歴として積む。銘柄分析(analyses)とは
// 別の分析・別の日付体系なので混ぜない（混ぜると syncLatestAnalysis が互いの値を null で潰す）。
// scenarioPrice=分析時株価（数値）、st*/mt* はレンジ文字列（正規化して「1000~1500」の形で保存）。
const SCENARIO_FIELDS = ['scenarioPrice', 'stBear', 'stBase', 'stBull', 'mtBear', 'mtBase', 'mtBull'];
// レンジ文字列の正規化: 「1000～1500」「1,000〜1,500」「1000-1500」等を「1000~1500」へ。単一値も可。
// 数値化できない入力はそのまま返す（取込データを黙って捨てない。表示はそのまま・位置判定は不可になるだけ）。
function scNormRange(v) {
  if (v == null) return null;
  const s = String(v).normalize('NFKC').trim();
  if (!s) return null;
  const m = s.replace(/[,，円$¥\s]/g, '').match(/^(\d+(?:\.\d+)?)(?:[~〜～\-−–—ー/／]+(\d+(?:\.\d+)?))?$/);
  if (!m) return s;
  const lo = parseFloat(m[1]), hi = m[2] != null ? parseFloat(m[2]) : null;
  if (hi == null) return String(lo);
  return `${Math.min(lo, hi)}~${Math.max(lo, hi)}`;
}
// 正規化済みレンジ文字列 → {lo,hi}（単一値は lo=hi）。解釈できなければ null
function scParseRange(v) {
  if (v == null || v === '') return null;
  const m = String(v).match(/^(\d+(?:\.\d+)?)(?:~(\d+(?:\.\d+)?))?$/);
  if (!m) return null;
  const lo = parseFloat(m[1]);
  return { lo, hi: m[2] != null ? parseFloat(m[2]) : lo };
}
// 表示用: 「1000~1500」→「1,000～1,500」（市場の桁書式）。未正規化の文字列はそのまま見せる
function scFmtRange(v, market) {
  const r = scParseRange(v);
  if (!r) return v ? esc(String(v)) : null;
  return r.lo === r.hi ? fmtAmt(r.lo, market) : `${fmtAmt(r.lo, market)}～${fmtAmt(r.hi, market)}`;
}
// 現在値が短期/中期シナリオのどのレンジにいるか（派生値・表とカルテの「位置」表示用）。
// term='st'|'mt'。戻り: {label, lvl, color} / データ不足は null。
// lvl＝1〜7の位置レベル（1=弱気未満 … 4=ベース圏 … 7=強気超え。ソート・背景色ルールの数値）。
// 一部レンジ未入力でも「弱気=2/ベース=4/強気=6」の基準ランクからレベルを安定して割り当てる。
// color は既定色（LABEL_COLORS のキー。表のタグ・カルテで使用。セル背景はマスタの背景色ルールで変更可）。
const SC_POS_COLORS = { 1: 'red', 2: 'orange', 3: 'gold', 4: 'blue', 5: 'cyan', 6: 'green', 7: 'purple' };
function scPosition(sec, term) {
  const price = calc.price(sec);
  if (price == null) return null;
  const zones = [[sec[term + 'Bear'], '弱気', 2], [sec[term + 'Base'], 'ベース', 4], [sec[term + 'Bull'], '強気', 6]]
    .map(([v, label, rank]) => ({ r: scParseRange(v), label, rank })).filter(z => z.r)
    .sort((a, b) => a.r.lo - b.r.lo);
  if (!zones.length) return null;
  const mk = (label, lvl) => ({ label, lvl, color: SC_POS_COLORS[Math.max(1, Math.min(7, lvl))] || 'gray' });
  if (price < zones[0].r.lo) return mk(`${zones[0].label}未満`, zones[0].rank - 1);
  for (let i = 0; i < zones.length; i++) {
    if (price <= zones[i].r.hi) return mk(`${zones[i].label}圏`, zones[i].rank);
    const next = zones[i + 1];
    if (next && price < next.r.lo) return mk(`${zones[i].label}〜${next.label}`, zones[i].rank + 1);
  }
  return mk(`${zones[zones.length - 1].label}超え`, zones[zones.length - 1].rank + 1);
}
// 保有取込列マッピング（Excel「10_保有株」）
const HOLDING_COLMAP = {
  'ティッカー': 'ticker', '証券会社': 'broker', '口座種別': 'accountType',
  '取得単価': 'avgCost', '数量': 'quantity', '取得価額': 'acquiredCost',
  'セクター': 'sector', '業種': 'industry',
};

// ---------- ストア ----------
const store = {
  data: null,
  load() {
    // techAnalysis は IndexedDB 保存のため localStorage には無い。クロスタブ再読込（storageイベント→load()）で
    // メモリの分析結果を落とさないよう退避して引き継ぐ（落とすと同期で「削除」と誤解釈され Drive から消える）。
    const prevTech = this.data && this.data.techAnalysis;
    try {
      this.data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (_) { this.data = null; }
    if (!this.data) this.data = this.seed();
    if (!this.data.techAnalysis && prevTech) this.data.techAnalysis = prevTech;
    // 後方互換: 欠損キーを補完
    this.data.securities ||= [];
    this.data.holdings ||= [];
    this.data.transactions ||= [];
    this.data.acqLedger ||= [];       // 取得円台帳（米国株・外国株式等取引報告書の明細。取引履歴とは独立）
    // rules は空配列だと既定ルールを失い、後段の rules[0].isDefault で落ちる。
    // 同期マージの削除伝播で空配列が Drive に書かれた場合も含め、空/不正なら既定を再シード（自己修復）
    if (!Array.isArray(this.data.rules) || this.data.rules.length === 0) this.data.rules = [structuredClone(DEFAULT_RULE)];
    this.data.categories ||= structuredClone(DEFAULT_CATEGORIES);
    this.data.investCategories ||= structuredClone(DEFAULT_INVEST_CATEGORIES); // 投資カテゴリ（分析枠ラベル）マスタ
    this.data.labelDefs ||= structuredClone(DEFAULT_LABELS); // 銘柄ラベル（複数タグ）マスタ
    this.data.grades ||= structuredClone(DEFAULT_GRADES); // 格付け色マスタ（S/A/B/C/D の表示色）
    this.data.matrixBands ||= structuredClone(DEFAULT_MATRIX_BANDS); // 分布マトリックスの取得額レンジ（色・しきい値）
    this.data.matrixSettings ||= {};
    if (this.data.matrixSettings.usdJpy == null) this.data.matrixSettings.usdJpy = DEFAULT_MATRIX_USDJPY; // 全部表示の円換算レート
    this.data.prices ||= {};
    // 異常な高値キャッシュの自己修復（2026-08-26）: 上場廃止期間のYahooダミー値（実測: 8303の5年高値553億）を
    // 取り込んでいた場合に破棄する。現在値の1000倍超の高値・安値は実在しない。highsAt も消して
    // 当日の補完取得（refreshAll末尾の高値欠け拾い）で正しい値を取り直させる。サーバー側にも同じフィルタ導入済み。
    for (const p of Object.values(this.data.prices)) {
      if (!p || typeof p.price !== 'number' || p.price <= 0) continue;
      const bad = ['high5y', 'high52w', 'low1y', 'low3y'].some(k => typeof p[k] === 'number' && (p[k] > p.price * 1000 || (p[k] > 0 && p[k] < p.price / 1000)));
      if (bad) { for (const k of ['high5y', 'high52w', 'high5yDate', 'high52wDate', 'low1y', 'low3y', 'low1yDate', 'low3yDate']) p[k] = null; p.highsAt = null; }
    }
    this.data.fx ||= { USDJPY: null };
    this.data.meta ||= {}; // 銘柄情報マスタ（名前・セクター・ファンダ）priceKeyでキャッシュ
    this.data.amountHistory ||= [];   // 金額マスタ変更履歴（版管理）
    this.data.amountSnapshots ||= []; // 銘柄ごとの適用金額スナップショット
    this.data.analyses ||= [];        // 銘柄分析の履歴（securityId×評価日がキー。銘柄平置きは最新のミラー）
    this.data.priceScenarios ||= [];  // 株価シナリオ分析の履歴（securityId×分析日 scenarioDate がキー。平置きは最新のミラー）。同期対象（SCHEMA: records）
    this._migrateAnalyses();          // 後方互換: 平置きの分析を履歴へ1件起こす
    this.data.techAnalysis ||= {};    // テクニカル分析（チャートパターン）結果: priceKey→{lastAnalyzed,best,patterns,metrics,levels,history,_updatedAt}
    this.data.importHistory ||= [];   // 取込履歴
    this.data.lastPriceUpdate ||= null; // 価格更新日時
    this.data.importMappings ||= {};  // 取込フィールド設定（列名・位置）のマスタ
    this.data.importFormats ||= [];   // 汎用取込のフォーマット（列名→フィールド対応）保存
    this.data.importAliases ||= {};   // 取込変換マスタ: ドメイン→{正規化した取込値→マスタ正規値 or '__skip__'}
    this.data.lastInfoDate ||= null;  // 銘柄情報の日次更新を実行した日（YYYY-MM-DD）
    this.data.lastHighsDate ||= null; // 5年/52週高値を取得した日（YYYY-MM-DD）。その日初回の価格更新で高値も取得
    this.data.indices ||= {};         // 参考指数の price/prevClose キャッシュ
    this.data.mktRanking ||= {};      // マーケットランキングのキャッシュ（key→{items(5年高値込),at}）。localStorage保存＋Google同期
    this.data.macro ||= {};           // マクロ指標キャッシュ（FRED系列ID→{obs:[[date,値],...],freq,at}）。同期対象（SCHEMA: map+byAt）
    this.data.macroIdx ||= {};        // 指数・為替キャッシュ（Yahooシンボル→{obs,freq,at}）。重ね合わせ比較用。同期対象（SCHEMA: map+byAt）
    // マクロ指標タブの表示状態（グループ/カード/期間/比較）。★settings に同居させてはいけない。
    // settings は Google連携・比率分母・マトリックス等が共有する1つのオブジェクトで、_updatedAt は
    // 「どれか1つでも変わった時刻」。そこにマクロの表示状態を置くと、他機能・他端末の書き込みが
    // マクロの選択を巻き込んで巻き戻す（実害: 日本を開いていたのに時間が経つとインフレに戻る）。
    // 独立キー＋keyedTs にして、マクロの表示状態を変えた時だけ時刻が動くようにする（ルール7-2）。
    this.data.lastVideoCheck ||= null; // 購読YouTubeの新着を確認した日（YYYY-MM-DD）。日付なので max マージ
    this.data.macroAlerts ||= [];     // マクロ指標の基準値・警告 [{id,seriesId,mode,cmp,value,enabled,updatedAt,deleted}]
    this.data.updates ||= [];         // 更新情報フィード（経済指標の更新・YouTube新着）。NEWバッジとダッシュボードのお知らせ用
    this.data.updSeen ||= {};         // 更新情報の既読（key→既読日時ISO）
    this.data.macroView ||= {};
    this.data.lastMacroDate ||= null; // マクロ指標を自動取得した日（YYYY-MM-DD）。日付なので max マージ
    // v20260813-2216 以前は settings 配下だった。1回だけ引っ越す（自動書き込みが settings._updatedAt を
    // 押し上げるのを止めるため。CLAUDE.md ルール7-2「自動取得・派生キャッシュを settings に入れない」）
    if (this.data.settings) {
      for (const k of ['macroGroup', 'macroCard', 'macroPeriod', 'macroCompare']) {
        if (this.data.settings[k] !== undefined) {
          if (this.data.macroView[k] === undefined) this.data.macroView[k] = this.data.settings[k];
          delete this.data.settings[k];
        }
      }
      if (this.data.settings.lastMacroDate !== undefined) {
        if (!this.data.lastMacroDate) this.data.lastMacroDate = this.data.settings.lastMacroDate;
        delete this.data.settings.lastMacroDate;
      }
    }
    this.data.earnings ||= {};        // 決算日キャッシュ priceKey→{prev,next,nextEstimate,exDiv,at}。1日1回取得・同期
    this.data.settings ||= {};        // 非機密の運用設定（Google連携の clientId 等）
    this.data.mktTopCap ||= {};       // 市場の時価総額1位（US/JP→{code,name,cap,at}）。「時価1位まで」列の分子・自動取得キャッシュ
    // v20260806-0128 以前は settings 配下に置いていた。settings は同期が singleTs（まるごと後勝ち）で、
    // 端末が自動で書くと相手端末の設定変更を巻き戻すため、トップレベルへ移設（1回だけ引っ越し）
    if (this.data.settings.mktTopCap) {
      for (const [k, v] of Object.entries(this.data.settings.mktTopCap)) if (!this.data.mktTopCap[k]) this.data.mktTopCap[k] = v;
      delete this.data.settings.mktTopCap;
    }
    this.data.newsRead ||= {};        // ニュース既読（記事リンク→既読日時ISO）。Google同期対象（sync-merge SCHEMA登録済み）
    this.data.newsSeen ||= {};        // （旧方式の名残・現在未使用）ニュース初見の記録。newsPool の batch 方式へ移行済み
    this.data.newsPool ||= null;      // ニュース一覧の共有プール {items,at,prevAt,_updatedAt}。「更新」で取得しGoogle同期（全端末で同じ一覧・同じ○の色）
    try { localStorage.removeItem('sm_news_cache'); } catch (_) {} // 旧・端末ローカル保存の掃除（newsPool同期方式へ移行）
    this.data.newsTags ||= [];        // ニュース注目タグ（保有登録なしの企業/人物/テーマ名）[{id,name}]。見出し一致で別色チップ表示・Google同期
    this.data.newsHidden ||= {};      // ニュース非表示（記事リンク→非表示日時ISO）。一覧から除外・復元可・Google同期
    this.data.newsTrans ||= {};       // ニュース翻訳キャッシュ（記事リンク→{t:訳題,d:訳要約,at}）。1記事1回だけ翻訳・Google同期
    this.data.newsPrefs ||= {};       // ニュース表示設定（hideCats:「すべて」から除外するカテゴリ / hideDiscTypes:非表示にする開示種類）・同期
    this.data.newsPrefs.hideCats ||= [];
    this.data.newsPrefs.hideDiscTypes ||= [];
    this.data.discTypeDefs ||= structuredClone(DEFAULT_DISC_TYPES); // 開示種別マスタ（分類・キーワード）。ユーザー編集可・同期
    this.data.ytChannels ||= structuredClone(DEFAULT_YT_CHANNELS); // YouTube購読チャンネル（動画取得元）。ユーザー編集可・同期
    this.data.ytSummaries ||= {};     // 動画要約キャッシュ（videoId→{summary,at}）。1動画1回だけ生成・同期
    this.data.listedMaster ||= [];    // 全上場銘柄マスタ（自動タグ用）[{code,name}]。JPX一覧を取込・同期
    this.data.listedMasterInfo ||= null; // 上場マスタの取込メタ {date:'YYYYMMDD',importedAt,count,fileName}（いつ時点のデータか）
    // 共通ドル円換算レート（マスタ評価用＝背景色ルールのUS金額判定・マトリックス円換算で共用）。
    // 旧マトリックス設定(matrixSettings.usdJpy)があれば引き継ぐ。初期値は1ドル=100円。
    if (this.data.settings.masterUsdJpy == null) {
      const mx = this.data.matrixSettings && this.data.matrixSettings.usdJpy;
      this.data.settings.masterUsdJpy = (mx != null && isFinite(mx)) ? mx : DEFAULT_MATRIX_USDJPY;
    }
    if (this.data.settings.ytModel === undefined) this.data.settings.ytModel = 'gemini-3.5-flash-lite'; // 動画要約の既定モデル（500回/日）。未設定時のみ
    if (this.data.settings.ytAutoSummary === undefined) this.data.settings.ytAutoSummary = true; // 新着動画の要約を裏で自動生成（一覧を開いた時）
    this.data.cfRules = migrateCfRules(this.data.cfRules); // 列の背景色ルール（マスタ管理）。未定義は既定シード／旧フラット型は移行
    for (const k in DEFAULT_IMPORT_MAPPINGS) {
      this.data.importMappings[k] = { ...DEFAULT_IMPORT_MAPPINGS[k], ...(this.data.importMappings[k] || {}) };
    }
    this.data.seq ||= 1;
    if (!this.data.rules.some(r => r.isDefault)) this.data.rules[0].isDefault = true;
    // 後方互換: カテゴリに米国株金額が無ければ日本株の÷100で補完
    for (const c of this.data.categories) if (c.amountUsd == null) c.amountUsd = (c.amountJpy || 0) / 100;
    // 後方互換: 色未設定のカテゴリは、既定カテゴリと同名なら既定色を補完（既存ユーザーにも初期色を反映）
    for (const c of this.data.categories) {
      if (c.color == null) { const d = DEFAULT_CATEGORIES.find(x => x.category === c.category); if (d) c.color = d.color; }
    }
    // 起動時にテクニカル分析結果を自動整理（容量超過の主因だったため）。減った分は次の保存で反映される
    try { if (this._pruneTechAnalysis() > 0) this.save(); } catch (_) {}
    return this.data;
  },
  // localStorage 向けの JSON。IndexedDB が使える環境では techAnalysis を除外する（IDB 側に保存・§16.7.5）。
  // メモリ(this.data)と同期バンドル(dataBundle)には残るので、端末間同期・画面表示は従来どおり。
  _lsJson() {
    if (!idb.ok) return JSON.stringify(this.data);
    const rest = Object.assign({}, this.data);
    delete rest.techAnalysis;
    return JSON.stringify(rest);
  },
  save() {
    // techAnalysis は IndexedDB へ（失敗は無視＝次の save で再書込される。IDB不可なら _lsJson が本体に含める）
    if (idb.ok) idb.set('techAnalysis', this.data.techAnalysis || {}).catch(() => {});
    try { localStorage.setItem(STORAGE_KEY, this._lsJson()); }
    catch (e) {
      // localStorage は1オリジン約5MB。超過(QuotaExceededError)時は「再取得できるキャッシュ」だけ捨てて再保存を試みる。
      const quota = e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014 || /quota|exceeded/i.test(e.message || ''));
      if (!quota) throw e;
      const freedKB = Math.round(this._freeCacheSpace() / 1024);
      try {
        localStorage.setItem(STORAGE_KEY, this._lsJson());
        if (typeof toast === 'function') toast(`保存容量が上限に近づいたため、再取得できるキャッシュ（市場ランキング/参考指数/翻訳/分析）約${freedKB}KBを整理して保存しました`, 5000);
      } catch (e2) {
        // 最終手段: ニュース一覧プールも捨てて再試行（「更新」で取り直せる・銘柄データ優先）。
        // ※取得直後に捨てると「ローカル無し vs Driveの古い一覧」で同期が古い方を採用し、
        //   タブ復帰時に新着記事が消える事故が起きたため、プール破棄は本当に最後の手段に限定する。
        if (this.data.newsPool) this.data.newsPool = null;
        try {
          localStorage.setItem(STORAGE_KEY, this._lsJson());
          if (typeof toast === 'function') toast('保存容量が上限のため、ニュース一覧の保存を一時的に見送りました（「更新」で取り直せます）。マスタのデータ整理をおすすめします', 7000);
        } catch (e3) {
          if (typeof toast === 'function') toast('ブラウザの保存容量が上限です。マスタ→「上場銘柄マスタ」で「全消去」するか、不要な保有/取込データを整理してください', 7000);
          throw e3;
        }
      }
    }
  },
  // 再取得できるキャッシュ（市場ランキング・参考指数・ニュース翻訳・登録外の分析結果）を破棄して容量を空ける。
  // 戻り値=解放したおよそのバイト数。※動画要約(ytSummaries)はGeminiのAPIコスト、ニュース一覧(newsPool)は
  // 同期の巻き戻り事故防止のため、ここでは消さない（newsPool は save() の最終手段でのみ破棄）。
  _freeCacheSpace() {
    let freed = 0;
    const drop = (k) => { const v = this.data[k]; if (v && typeof v === 'object' && Object.keys(v).length) { freed += JSON.stringify(v).length; this.data[k] = {}; } };
    drop('mktRanking'); drop('indices'); drop('newsTrans');
    drop('macro'); drop('macroIdx');   // マクロ指標・指数の履歴（約190KB）。「更新」で取り直せる
    freed += this._pruneTechAnalysis(true); // 登録外の分析結果も強めに整理（過去実測で最大の容量食い）
    return freed;
  },
  // テクニカル分析結果の自動整理（容量対策。localStorageの大半を占めていたため）。
  //  - 登録していない銘柄（分析タブの売買代金トップ50は入れ替わるので orphan 化する）は TECH_UNREG_DAYS 日で破棄
  //  - 登録外の保持件数は TECH_UNREG_MAX 件まで（新しい順）
  //  - スコア履歴は TECH_HISTORY_MAX 点まで
  // 保有・登録済み銘柄の分析結果は消さない。aggressive=true で登録外を当日分以外すべて破棄。
  _pruneTechAnalysis(aggressive) {
    const ta = this.data.techAnalysis;
    if (!ta || typeof ta !== 'object') return 0;
    const sizeOf = (v) => { try { return JSON.stringify(v).length; } catch (_) { return 0; } };
    const reg = new Set();
    for (const s of this.data.securities || []) { try { reg.add(priceKey(s)); } catch (_) {} }
    const cutoff = new Date(Date.now() - (aggressive ? 0 : TECH_UNREG_DAYS) * 86400000).toISOString().slice(0, 10);
    let freed = 0; const unreg = [];
    for (const k of Object.keys(ta)) {
      const r = ta[k] || {};
      if (!reg.has(k)) {
        const d = String(r.lastAnalyzed || '');
        if (!d || d < cutoff) { freed += sizeOf(r); delete ta[k]; continue; }
        unreg.push([k, d]);
      }
      const h = r.history;
      if (Array.isArray(h) && h.length > TECH_HISTORY_MAX) { const b = sizeOf(h); r.history = h.slice(-TECH_HISTORY_MAX); freed += b - sizeOf(r.history); }
    }
    if (unreg.length > TECH_UNREG_MAX) { // 登録外が多すぎる分は新しい順に残す
      unreg.sort((a, b) => String(b[1]).localeCompare(String(a[1])));
      for (const [k] of unreg.slice(TECH_UNREG_MAX)) { freed += sizeOf(ta[k]); delete ta[k]; }
    }
    return freed;
  },
  seed() {
    return {
      securities: [], holdings: [], transactions: [], acqLedger: [],
      rules: [structuredClone(DEFAULT_RULE)],
      categories: structuredClone(DEFAULT_CATEGORIES),
      investCategories: structuredClone(DEFAULT_INVEST_CATEGORIES),
      labelDefs: structuredClone(DEFAULT_LABELS),
      grades: structuredClone(DEFAULT_GRADES),
      prices: {}, fx: { USDJPY: null }, meta: {}, amountHistory: [], amountSnapshots: [], analyses: [], techAnalysis: {},
      importHistory: [], lastPriceUpdate: null, seq: 1,
    };
  },
  nextId() { return this.data.seq++; },
  _now() { return new Date().toISOString(); },
  // レコードの編集時刻を打つ。sync-merge.js の 3-way マージは records を updatedAt の新しい方で採る（両在時）。
  // store.data の records 要素を「書き換えた／新規作成した」ら必ずこれを呼ぶ（呼ばないとマージで別端末の
  // 古いスナップショットに負けて巻き戻る＝同期漏れ）。取引適用・取得円編集・マスタ改名波及なども対象。
  touch(rec) { if (rec) rec.updatedAt = this._now(); return rec; },

  // securities
  addSecurity(s) { s.id = this.nextId(); s.createdAt = this._now(); s.updatedAt = s.createdAt; this.data.securities.push(s); this.save(); return s; },
  updateSecurity(id, patch) {
    const s = this.data.securities.find(x => x.id === id);
    if (s) {
      s.updatedAt = this._now();
      // カテゴリ変更時は、変更前カテゴリの適用金額をスナップショットに残す
      if (patch.category !== undefined && patch.category !== s.category && s.category) {
        const c = this.data.categories.find(x => x.category === s.category);
        if (c) this.data.amountSnapshots.push({
          id: this.nextId(), securityId: id, category: s.category,
          amountJpy: c.amountJpy, amountUsd: c.amountUsd, recordedAt: this._now(), trigger: 'category_change', updatedAt: this._now(),
        });
      }
      Object.assign(s, patch); this.save();
    }
    return s;
  },
  removeSecurity(id) {
    this.data.securities = this.data.securities.filter(s => s.id !== id);
    this.data.holdings = this.data.holdings.filter(h => h.securityId !== id);
    this.data.transactions = this.data.transactions.filter(t => t.securityId !== id);
    this.data.analyses = (this.data.analyses || []).filter(a => a.securityId !== id);
    this.data.priceScenarios = (this.data.priceScenarios || []).filter(a => a.securityId !== id);
    this.save();
  },
  findSecurity(market, ticker) {
    const t = (ticker || '').trim().toUpperCase();
    return this.data.securities.find(s => s.market === market && (s.ticker || '').toUpperCase() === t);
  },

  // holdings (security×broker×account)
  upsertHolding(h) {
    const found = this.data.holdings.find(x =>
      x.securityId === h.securityId && x.broker === h.broker && x.accountType === h.accountType);
    if (found) { Object.assign(found, h); this.touch(found); }
    else { h.id = this.nextId(); this.touch(h); this.data.holdings.push(h); }
    this.save();
  },
  removeHolding(id) { this.data.holdings = this.data.holdings.filter(h => h.id !== id); this.save(); },
  // 直接編集（取引を介さず数量・平均取得単価を上書き）。source: 'import'|'manual'（更新日も記録）
  setHolding(securityId, broker, accountType, quantity, avgCost, source = 'manual') {
    let h = this.data.holdings.find(x => x.securityId === securityId && x.broker === broker && x.accountType === accountType);
    if (!h) {
      h = { id: this.nextId(), securityId, broker, accountType, quantity: 0, avgCost: 0 };
      this.data.holdings.push(h);
    }
    h.quantity = quantity; h.avgCost = avgCost; h.source = source; h.updatedAt = this._now();
    this.save();
  },
  // 全売却（当該銘柄の全口座を数量0に。保有が無くなるので平均取得単価もクリア）
  sellAll(securityId) {
    for (const h of this.data.holdings.filter(x => x.securityId === securityId)) { h.quantity = 0; h.avgCost = 0; }
    this.save();
  },

  // transactions（保有へ反映）
  addTransaction(t) {
    t.id = this.nextId();
    t.updatedAt = this._now();   // 取引の編集を端末間で伝播させる（sync-merge は records を updatedAt で3-way）
    this.data.transactions.push(t);
    this.applyTransaction(t);
    this.save();
  },
  applyTransaction(t) {
    // 履歴のみ記録（ledgerOnly）: 数量・平均取得単価・取得円(acqJpy)には反映しない。
    // ただし買い回数は加算し、前回購入日・購入回数・高値更新判定など「トランザクション走査ベースの
    // 派生値」（lastBuyInfo/buyCount/取引サマリー）には通常どおり反映される。過去の購入履歴を、現在の
    // 保有（取込/手入力済みで既に正しい）を崩さずに登録する用途。SEC: ledgerOnly
    if (t.ledgerOnly) {
      if (t.type === 'buy') {
        const sec = this.data.securities.find(s => s.id === t.securityId);
        if (sec) { sec.buyCount = (sec.buyCount || 0) + 1; this.touch(sec); }
      }
      return;
    }
    const findLot = () => this.data.holdings.find(x =>
      x.securityId === t.securityId && x.broker === t.broker && x.accountType === t.accountType);
    if (t.type === 'buy') {
      let h = findLot();
      if (!h) { h = { id: this.nextId(), securityId: t.securityId, broker: t.broker, accountType: t.accountType, quantity: 0, avgCost: 0 }; this.data.holdings.push(h); }
      const totalCost = h.avgCost * h.quantity + t.price * t.quantity;
      h.quantity += t.quantity;
      h.avgCost = h.quantity > 0 ? totalCost / h.quantity : 0; // 加重平均
      t._dq = t.quantity;                                      // 実際に適用した数量変化（買い=+）。逆操作で使用
      // 取得円(円)累計: 米国株の受渡金額(円)＝支払った原価が入力されていれば加算（買=+）。SEC-59
      // 逆操作用に実際に加えた額(_dAcq)を記録（settleJpy 無しなら 0）。
      t._dAcq = (t.settleJpy != null) ? t.settleJpy : 0;
      if (t._dAcq) h.acqJpy = (h.acqJpy || 0) + t._dAcq;
      this.touch(h);
      // 購入回数を加算
      const sec = this.data.securities.find(s => s.id === t.securityId);
      if (sec) { sec.buyCount = (sec.buyCount || 0) + 1; this.touch(sec); }
    } else { // sell: 既存ロットの数量のみ減算（平均取得単価は不変）。対応ロットが無ければ保有は触らない（空ロットを作らない）
      const h = findLot();
      if (!h) { t._dq = 0; t._dAcq = 0; return; }             // 一致する保有ロットが無い売り＝保有に影響なし
      const qtyBefore = h.quantity;
      const removed = Math.min(t.quantity, qtyBefore);         // 実際に減った数量（在庫を超えてマイナスにしない）
      h.quantity -= removed;
      t._dq = -removed;                                        // 逆操作はこの実減少分だけ戻す（非対称による幽霊ロットを防止）
      // 取得円(円)＝取得原価。売却は「売った数量ぶんの原価」を按分して除く。SEC-59改。
      // 売りの受渡金額（＝受け取った代金）は原価ではないので取得円には使わない（利益売却で原価がマイナスになるのを防ぐ）。
      let dAcq = 0;
      if (h.acqJpy != null && qtyBefore > 1e-12) {
        const removedCost = h.acqJpy * (removed / qtyBefore);
        h.acqJpy -= removedCost;
        if (Math.abs(h.acqJpy) < 1e-6) h.acqJpy = 0;           // 端数掃除（全売却で綺麗に0・マイナス化を防ぐ）
        dAcq = -removedCost;                                   // 逆操作で戻す除去原価（負）
      }
      t._dAcq = dAcq;
      if (h.quantity === 0) h.avgCost = 0;
      this.touch(h);
    }
    this._pruneEmptyHoldings(t.securityId);
  },
  // 数量0・取得単価0・取得円なしの空ロットを除去（売買の打ち消しで残る0株ロットの掃除）。
  // 取込/手入力で作った保有は source で保護し、消さない。
  _pruneEmptyHoldings(securityId) {
    this.data.holdings = this.data.holdings.filter(h =>
      h.securityId !== securityId || h.quantity > 1e-9 || h.avgCost > 0
      || (h.acqJpy != null && Math.abs(h.acqJpy) > 1e-6) || h.source === 'import' || h.source === 'manual');
  },
  // applyTransaction の逆操作（取引の削除・編集時に保有への影響を取り消す）。
  // 買い=数量と取得原価を差し引き／売り=実際に減った数量(_dq)を戻す。ledgerOnly は買い回数のみ戻す。
  reverseTransaction(t) {
    if (t.ledgerOnly) {
      if (t.type === 'buy') { const sec = this.data.securities.find(s => s.id === t.securityId); if (sec && sec.buyCount) { sec.buyCount = Math.max(0, sec.buyCount - 1); this.touch(sec); } }
      return;
    }
    const h = this.data.holdings.find(x => x.securityId === t.securityId && x.broker === t.broker && x.accountType === t.accountType);
    if (h) {
      if (t.type === 'buy') {
        const dq = (t._dq != null ? t._dq : t.quantity);       // 適用した数量（買い=+）
        const totalCost = h.avgCost * h.quantity - t.price * dq;
        h.quantity = Math.max(0, h.quantity - dq);
        h.avgCost = h.quantity > 0 ? Math.max(0, totalCost) / h.quantity : 0;
        // 取得円: 適用時に加えた原価(_dAcq)を戻す（旧データは settleJpy で代替）
        const dAcq = (t._dAcq != null) ? t._dAcq : (t.settleJpy != null ? t.settleJpy : 0);
        if (dAcq) h.acqJpy = (h.acqJpy || 0) - dAcq;
      } else {
        const removed = (t._dq != null ? -t._dq : t.quantity); // 実際に減った数量だけ戻す（旧データは数量で代替）
        h.quantity += removed;
        // 取得円: 適用時に按分除去した原価(_dAcq は負)を戻す。旧データは settleJpy を買い戻す（＝加算）で代替。
        const dAcq = (t._dAcq != null) ? t._dAcq : (t.settleJpy != null ? -t.settleJpy : 0);
        if (dAcq) h.acqJpy = (h.acqJpy || 0) - dAcq;
      }
      this.touch(h);
    }
    if (t.type === 'buy') { const sec = this.data.securities.find(s => s.id === t.securityId); if (sec && sec.buyCount) { sec.buyCount = Math.max(0, sec.buyCount - 1); this.touch(sec); } }
    this._pruneEmptyHoldings(t.securityId);
  },
  // 取引の削除（保有への影響を取り消してから除去）
  removeTransaction(id) {
    const t = this.data.transactions.find(x => x.id === id); if (!t) return;
    this.reverseTransaction(t);
    this.data.transactions = this.data.transactions.filter(x => x.id !== id);
    this.save();
  },
  // 取引の編集（旧効果を取り消し→値を更新→新効果を適用）。patch は type/price/quantity/broker/accountType/tradedAt/settleJpy/ledgerOnly/skipPrevBuy
  updateTransaction(id, patch) {
    const t = this.data.transactions.find(x => x.id === id); if (!t) return;
    this.reverseTransaction(t);
    // settleJpy/ledgerOnly/skipPrevBuy は未指定なら消す（フォーム送信値で完全上書き＝チェックを外せば解除される）
    delete t.settleJpy; delete t.ledgerOnly; delete t.skipPrevBuy;
    Object.assign(t, patch);
    this.applyTransaction(t);
    this.touch(t);   // 取引の編集を端末間で伝播（sync-merge の updatedAt タイブレーク）
    this.save();
  },
  // 既存取引の受渡金額(円)だけを更新（保有数量・平均取得単価・購入回数には一切触らない）。
  // settleJpy は取得円(acqJpy)累計にしか効かない（買い=加算/売り=減算・ledgerOnlyは対象外）ので、
  // その差分だけを保有に反映する。reverse→apply 方式だと一部売却済みロットで reverseTransaction が
  // 数量を Math.max(0,…) でクランプし、さらに空ロットの prune で保有が作り直されて数量が壊れるため使わない。
  // settleJpy=null で受渡金額をクリア。save しない版（一括用に呼び元でまとめて save）。
  setTransactionSettle(id, settleJpy) {
    const t = this.data.transactions.find(x => x.id === id); if (!t) return false;
    // 買いの受渡金額(円)＝支払った原価なので取得円に反映。売りの受渡金額は代金（原価でない）ため取得円に反映しない。
    if (!t.ledgerOnly && t.type === 'buy') {
      const h = this.data.holdings.find(x => x.securityId === t.securityId && x.broker === t.broker && x.accountType === t.accountType);
      if (h) {
        const old = (t._dAcq != null) ? t._dAcq : (t.settleJpy != null ? t.settleJpy : 0); // 旧寄与（買い＝加算した原価）
        if (old) h.acqJpy = (h.acqJpy || 0) - old;             // 旧寄与を取り消し
        const add = settleJpy != null ? settleJpy : 0;
        if (add) h.acqJpy = (h.acqJpy || 0) + add;             // 新寄与を加算
        t._dAcq = add;
        this.touch(h);
      }
    }
    if (settleJpy == null) delete t.settleJpy; else t.settleJpy = settleJpy;
    this.touch(t);
    return true;
  },

  // ===== 取得円台帳（acqLedger） =====
  // 外国株式等取引報告書の明細を [ティッカー×証券会社×口座] キーで蓄積する台帳（取得円の正本）。
  // 取引履歴(transactions)とは完全に独立（前回購入日・購入回数・買い増し判定に影響しない）。
  // 「反映」で acqLedgerCompute の計算結果を保有の取得円(acqJpy)へ差分確認つきで書き込む。
  addAcqLedgerRows(rows) {
    for (const r of rows) { r.id = this.nextId(); this.touch(r); this.data.acqLedger.push(r); }
    this.save();
    return rows.length;
  },
  updateAcqLedgerRow(id, patch) {
    const r = this.data.acqLedger.find(x => x.id === id); if (!r) return;
    Object.assign(r, patch); this.touch(r); this.save();
  },
  removeAcqLedgerRow(id) {
    this.data.acqLedger = this.data.acqLedger.filter(x => x.id !== id); this.save();
  },
  removeAcqLedgerRows(ids) {
    const s = new Set(ids);
    this.data.acqLedger = this.data.acqLedger.filter(x => !s.has(x.id)); this.save();
  },

  // rules
  rule(id) { return this.data.rules.find(r => r.id === id) || this.defaultRule(); },
  defaultRule() { return this.data.rules.find(r => r.isDefault) || this.data.rules[0]; },
  addRule(r) { r.id = this.nextId(); this.touch(r); this.data.rules.push(r); this.save(); return r; },
  updateRule(id, patch) {
    const r = this.data.rules.find(x => x.id === id);
    if (r) { Object.assign(r, patch); this.touch(r); this.save(); }
    return r;
  },
  removeRule(id) {
    if (this.data.rules.length <= 1) return false;
    const wasDefault = this.data.rules.find(r => r.id === id)?.isDefault;
    this.data.rules = this.data.rules.filter(r => r.id !== id);
    // 当該ルール参照銘柄は既定へ戻す（銘柄側の変更も伝播させる）
    for (const s of this.data.securities) if (s.ruleId === id) { s.ruleId = null; this.touch(s); }
    if (wasDefault && !this.data.rules.some(r => r.isDefault)) { this.data.rules[0].isDefault = true; this.touch(this.data.rules[0]); }
    this.save();
    return true;
  },
  setDefaultRule(id) {
    for (const r of this.data.rules) { r.isDefault = (r.id === id); this.touch(r); }
    this.save();
  },

  // categories
  categoryAmount(cat) {
    const c = this.data.categories.find(x => x.category === cat);
    return c ? c.amountJpy : 0;
  },
  // 市場別のカテゴリ金額（US=米国株金額(ドル)、JP/FUND=日本株金額(円)）
  categoryAmountFor(cat, market) {
    const c = this.data.categories.find(x => x.category === cat);
    if (!c) return 0;
    if (market === 'US') return c.amountUsd != null ? c.amountUsd : (c.amountJpy || 0) / 100;
    return c.amountJpy || 0;
  },
  addCategory(c) {
    c.sortOrder = c.sortOrder || (Math.max(0, ...this.data.categories.map(x => x.sortOrder)) + 1);
    this.touch(c); this.data.categories.push(c); this.save();
  },
  // 取込変換マスタ: 正規化した取込値→マスタ正規値（または '__skip__'）を記憶
  setAlias(domain, normRaw, value) {
    (this.data.importAliases[domain] ||= {})[normRaw] = value; this.save();
  },
  updateCategory(oldName, patch) {
    const c = this.data.categories.find(x => x.category === oldName);
    if (!c) return;
    const newName = patch.category;
    // 金額変更を検知したら版管理（履歴＋銘柄スナップショット）
    const jpyChanged = patch.amountJpy != null && patch.amountJpy !== c.amountJpy;
    const usdChanged = patch.amountUsd != null && patch.amountUsd !== c.amountUsd;
    if (jpyChanged || usdChanged) {
      const now = this._now();
      // 変更前金額を、当該カテゴリの全銘柄にスナップショット
      for (const s of this.data.securities.filter(x => x.category === oldName)) {
        this.data.amountSnapshots.push({
          id: this.nextId(), securityId: s.id, category: oldName,
          amountJpy: c.amountJpy, amountUsd: c.amountUsd, recordedAt: now, trigger: 'master_change', updatedAt: now,
        });
      }
      // 変更履歴（旧→新）
      this.data.amountHistory.push({
        id: this.nextId(), category: newName || oldName,
        prevJpy: c.amountJpy, prevUsd: c.amountUsd,
        newJpy: patch.amountJpy ?? c.amountJpy, newUsd: patch.amountUsd ?? c.amountUsd,
        changedAt: now, updatedAt: now,
      });
    }
    Object.assign(c, patch);
    this.touch(c);
    // カテゴリ名を変えたら、参照している銘柄も追従（銘柄側の変更も伝播）
    if (newName && newName !== oldName) {
      for (const s of this.data.securities) if (s.category === oldName) { s.category = newName; this.touch(s); }
    }
    this.save();
  },
  removeCategory(name) {
    this.data.categories = this.data.categories.filter(c => c.category !== name);
    for (const s of this.data.securities) if (s.category === name) { s.category = null; this.touch(s); }
    this.save();
  },
  // 投資カテゴリ（分析枠ラベル）マスタ。金額は持たない（名前・色・並び順のみ）。
  addInvestCategory(c) {
    c.sortOrder = c.sortOrder || (Math.max(0, ...this.data.investCategories.map(x => x.sortOrder || 0)) + 1);
    this.touch(c); this.data.investCategories.push(c); this.save();
  },
  updateInvestCategory(oldName, patch) {
    const c = this.data.investCategories.find(x => x.name === oldName);
    if (!c) return;
    const newName = patch.name;
    Object.assign(c, patch);
    this.touch(c);
    if (newName && newName !== oldName) {
      for (const s of this.data.securities) if (s.investCategory === oldName) { s.investCategory = newName; this.touch(s); }
    }
    this.save();
  },
  removeInvestCategory(name) {
    this.data.investCategories = this.data.investCategories.filter(c => c.name !== name);
    for (const s of this.data.securities) if (s.investCategory === name) { s.investCategory = null; this.touch(s); }
    this.save();
  },
  // 銘柄ラベル（複数タグ）マスタ。名前・色・並び順のみ。sec.labels（配列）が参照する。
  addLabelDef(c) {
    c.sortOrder = c.sortOrder || (Math.max(0, ...this.data.labelDefs.map(x => x.sortOrder || 0)) + 1);
    this.touch(c); this.data.labelDefs.push(c); this.save();
  },
  updateLabelDef(oldName, patch) {
    const c = this.data.labelDefs.find(x => x.name === oldName);
    if (!c) return;
    const newName = patch.name;
    Object.assign(c, patch);
    this.touch(c);
    if (newName && newName !== oldName) {
      for (const s of this.data.securities) if (Array.isArray(s.labels) && s.labels.includes(oldName)) { s.labels = s.labels.map(l => l === oldName ? newName : l); this.touch(s); }
    }
    this.save();
  },
  removeLabelDef(name) {
    this.data.labelDefs = this.data.labelDefs.filter(c => c.name !== name);
    for (const s of this.data.securities) if (Array.isArray(s.labels) && s.labels.includes(name)) { s.labels = s.labels.filter(l => l !== name); this.touch(s); }
    this.save();
  },

  // 銘柄情報マスタ（meta）への書き込み。key = `${market}:${ticker}`
  setMeta(key, obj) {
    this.data.meta[key] = { ...(this.data.meta[key] || {}), ...obj, updatedAt: this._now() };
    this.save();
  },

  // ===== 銘柄分析の履歴（analyses） =====
  // 1銘柄×1評価日=1レコード。同期マージは自然キー `securityId|analysisDate`（sync-merge.js）。
  // 銘柄レコードの平置き分析フィールドは「最新評価日のミラー」で、表・ソート・既存配線はそれを参照する。
  analysesOf(secId) { return (this.data.analyses || []).filter(a => a.securityId === secId); },
  // 評価日の新しい順（同日は updatedAt 新しい方）の先頭＝最新分析
  _analysisCmp(a, b) { return a.analysisDate < b.analysisDate ? 1 : a.analysisDate > b.analysisDate ? -1 : ((a.updatedAt || '') < (b.updatedAt || '') ? 1 : -1); },
  analysesSorted(secId) { return this.analysesOf(secId).slice().sort((a, b) => this._analysisCmp(a, b)); },
  latestAnalysis(secId) { const l = this.analysesSorted(secId); return l[0] || null; },
  // 履歴へ upsert（securityId×analysisDate がキー）。fields は ANALYSIS_FIELDS のサブセット（空キーは触らない）。
  upsertAnalysis(secId, analysisDate, fields) {
    if (!analysisDate) return null;
    this.data.analyses ||= [];
    const now = this._now();
    let a = this.data.analyses.find(x => x.securityId === secId && x.analysisDate === analysisDate);
    if (a) Object.assign(a, fields, { updatedAt: now });
    else { a = { id: this.nextId(), securityId: secId, analysisDate, ...fields, createdAt: now, updatedAt: now }; this.data.analyses.push(a); }
    this.save();
    return a;
  },
  // 最新分析を銘柄平置きへミラー（評価日＋ANALYSIS_FIELDS）。履歴を更新したら必ず呼ぶ。
  syncLatestAnalysis(secId) {
    const sec = this.data.securities.find(s => s.id === secId);
    if (!sec) return;
    const a = this.latestAnalysis(secId);
    if (!a) return;
    sec.analysisDate = a.analysisDate;
    for (const k of ANALYSIS_FIELDS) sec[k] = (a[k] !== undefined ? a[k] : null);
    sec.updatedAt = this._now();
    this.save();
  },
  // 後方互換: 平置き分析（analysisDate あり）をまだ履歴に無ければ1件起こす。idは新規・自然キーで重複防止。
  _migrateAnalyses() {
    let added = false;
    for (const s of this.data.securities || []) {
      if (!s.analysisDate) continue;
      if (this.data.analyses.some(a => a.securityId === s.id && a.analysisDate === s.analysisDate)) continue;
      const rec = { id: this.nextId(), securityId: s.id, analysisDate: s.analysisDate, createdAt: s.updatedAt || this._now(), updatedAt: s.updatedAt || this._now() };
      for (const k of ANALYSIS_FIELDS) if (s[k] != null) rec[k] = s[k];
      this.data.analyses.push(rec); added = true;
    }
    if (added) this.save();
  },

  // ===== 株価シナリオ分析の履歴（priceScenarios） =====
  // 1銘柄×1分析日(scenarioDate)=1レコード。銘柄分析(analyses)とは別の分析なので別マスタ（混ぜると
  // 互いのミラーが null で潰し合う）。同期マージは自然キー `ps:securityId|scenarioDate`（sync-merge.js）。
  scenariosOf(secId) { return (this.data.priceScenarios || []).filter(a => a.securityId === secId); },
  scenariosSorted(secId) {
    return this.scenariosOf(secId).slice().sort((a, b) =>
      a.scenarioDate < b.scenarioDate ? 1 : a.scenarioDate > b.scenarioDate ? -1 : ((a.updatedAt || '') < (b.updatedAt || '') ? 1 : -1));
  },
  latestScenario(secId) { const l = this.scenariosSorted(secId); return l[0] || null; },
  // 履歴へ upsert（securityId×scenarioDate がキー）。fields は SCENARIO_FIELDS のサブセット（渡さないキーは触らない）
  upsertScenario(secId, scenarioDate, fields) {
    if (!scenarioDate) return null;
    this.data.priceScenarios ||= [];
    const now = this._now();
    let a = this.data.priceScenarios.find(x => x.securityId === secId && x.scenarioDate === scenarioDate);
    if (a) Object.assign(a, fields, { updatedAt: now });
    else { a = { id: this.nextId(), securityId: secId, scenarioDate, ...fields, createdAt: now, updatedAt: now }; this.data.priceScenarios.push(a); }
    this.save();
    return a;
  },
  // 最新シナリオを銘柄平置きへミラー（scenarioDate＋SCENARIO_FIELDS）。履歴を更新したら必ず呼ぶ
  syncLatestScenario(secId) {
    const sec = this.data.securities.find(s => s.id === secId);
    if (!sec) return;
    const a = this.latestScenario(secId);
    if (!a) return;
    sec.scenarioDate = a.scenarioDate;
    for (const k of SCENARIO_FIELDS) sec[k] = (a[k] !== undefined ? a[k] : null);
    sec.updatedAt = this._now();
    this.save();
  },

  // 株式分割・併合を適用（比率 r。1:5分割→5 / 5:1併合→0.2）
  // mode='full': 保有(数量×r/単価÷r)＋手入力＋取引 を調整 / mode='manual': 手入力＋取引のみ（保有は取込済みとして触らない）
  // 金額（取得価額・1回購入額）・算出値（PER等）・自動取得値は触らない
  applySplit(secId, date, ratio, mode = 'full') {
    const sec = this.data.securities.find(s => s.id === secId); if (!sec || !ratio) return;
    const r = ratio;
    if (mode === 'full') {
      for (const h of this.data.holdings.filter(x => x.securityId === secId)) { h.quantity *= r; h.avgCost /= r; h.updatedAt = this._now(); }
    }
    // 手入力項目・手動取引は両モードで調整（変更した security/transaction は updatedAt を打って同期漏れを防ぐ）
    let secChanged = false;
    if (typeof sec.prevBuyPrice === 'number') { sec.prevBuyPrice /= r; secChanged = true; }
    if (typeof sec.baseHighManual === 'number') { sec.baseHighManual /= r; secChanged = true; }
    if (typeof sec.fixedBuyPrice === 'number') { sec.fixedBuyPrice /= r; secChanged = true; }
    // 株価シナリオ（分析時株価・予想レンジ）も株価水準なので調整。履歴も調整しないと
    // 次の syncLatestScenario で未調整の履歴値が平置きへミラーされ戻ってしまう
    const scAdj = (o) => {
      let ch = false;
      if (typeof o.scenarioPrice === 'number') { o.scenarioPrice /= r; ch = true; }
      for (const k of ['stBear', 'stBase', 'stBull', 'mtBear', 'mtBase', 'mtBull']) {
        const p = scParseRange(o[k]);
        if (p) { o[k] = p.lo === p.hi ? String(p.lo / r) : `${p.lo / r}~${p.hi / r}`; ch = true; }
      }
      return ch;
    };
    if (scAdj(sec)) secChanged = true;
    for (const ps of (this.data.priceScenarios || []).filter(x => x.securityId === secId)) { if (scAdj(ps)) this.touch(ps); }
    for (const t of this.data.transactions.filter(t => t.securityId === secId && t.tradedAt && t.tradedAt < date)) { t.price /= r; t.quantity *= r; this.touch(t); }
    // 自動取得の価格キャッシュ（現在値・前日終値・5年/52週高値）は触らない。
    // Yahoo はEx-date以降は分割調整済みの値を返すため、削除せず手入力項目だけ調整する（次の価格更新で最新化）。
    const hrec = (sec.splitHistory || []).find(x => x.date === date);
    if (hrec) { hrec.status = 'applied'; hrec.appliedAt = this._now(); hrec.mode = mode; secChanged = true; }
    if (secChanged) this.touch(sec);
    this.save();
  },
};

// ---------- Google連携（GIS＝ブラウザ完結。clientId 未設定なら休眠） ----------
// データ同期は Drive 自動マージ同期(dsync)に一本化。Sheets手動保存/読込（旧）は廃止し、
// OAuthスコープから機微な spreadsheets を外して drive.file のみに軽量化（同意手順の簡素化）。
// サーバー(CF env)から配る公開設定（clientId）。リポジトリに置かない。
let _serverConfig = {};
async function loadServerConfig() {
  try { const r = await fetch('/api/config'); if (r.ok) _serverConfig = (await r.json()) || {}; } catch (_) {}
}
// OAuthスコープ: Drive(アプリ作成ファイルのみ)＋本人確認。spreadsheets は廃止。
const GSCOPE = 'https://www.googleapis.com/auth/drive.file openid email';
const gsync = {
  _token: null, _email: null, _scope: '', _refreshExpMs: 0, _refreshing: null,
  hasDrive() { return !!(this._scope && this._scope.indexOf('drive.file') >= 0); },
  // === アクセストークンの永続化（リロードでログインを保つ） ===
  // GISの無音再取得(prompt:'')はサードパーティCookieブロックで失敗しやすいため、トークン自体を
  // localStorageに保存し、失効(約1時間)まではGoogleへ通信せず即復帰する。drive.fileスコープ限定の
  // 短命トークン＆個人ツール前提。失効後はサイレント再取得→不可なら手動ログイン。
  _TOKEN_KEY: 'sm_gtoken',
  _writeToken(token, scope, email, expMs) {
    try { localStorage.setItem(this._TOKEN_KEY, JSON.stringify({ t: token, s: scope || '', e: email || '', x: expMs })); } catch (_) {}
  },
  _clearToken() { try { localStorage.removeItem(this._TOKEN_KEY); } catch (_) {} },
  _loadToken() {
    try { const o = JSON.parse(localStorage.getItem(this._TOKEN_KEY) || 'null'); if (o && o.t && o.x && Date.now() < o.x) return o; } catch (_) {}
    return null;
  },
  _expMs(expiresInSec) { return Date.now() + Math.max(0, ((expiresInSec || 3600) - 60)) * 1000; }, // 60秒マージン
  // ローカル設定が空なら サーバー(CF env)の公開設定で補う（新端末は入力不要でログイン可）
  cfg() {
    const g = (store.data.settings && store.data.settings.google) || {};
    return {
      clientId: g.clientId || _serverConfig.clientId || '',
      allowedEmails: g.allowedEmails || '',
    };
  },
  // GISスクリプトを必要時のみ読み込む（未設定なら一切読み込まない）
  async ensureGis() {
    if (window.google && google.accounts && google.accounts.oauth2) return;
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true;
      s.onload = res; s.onerror = () => rej(new Error('Google Identity Services の読み込みに失敗'));
      document.head.appendChild(s);
    });
  },
  // 許可メール照合＋トークン確定（callbackから呼ぶ）
  async _onToken(r, resolve, reject) {
    try {
      const token = r.access_token; this._scope = r.scope || '';
      const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } }).then(x => x.json());
      const email = ((info && info.email) || '').toLowerCase();
      const allow = (this.cfg().allowedEmails || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
      if (allow.length && !allow.includes(email)) { this._token = null; this._clearToken(); toast(`許可されていないアカウントです: ${email}`); return resolve(false); }
      this._token = token; this._email = email;
      this._writeToken(token, this._scope, email, this._expMs(r.expires_in)); // リロード後も保持
      toast(`ログイン: ${email || 'OK'}`);
      try { render(); } catch (_) {}   // ログイン成功で即UI更新（未ログイン警告を消す・状態反映）。syncNow完了を待たない
      resolve(true);
      try { if (typeof dsync !== 'undefined') dsync.afterSignIn(); } catch (_) {}   // 自動同期ONなら初回マージ
    } catch (e) { reject(e); }
  },
  // ★モバイル対応: タップ→ポップアップの間に await を挟まない。GIS が読込済みなら同期で
  //   requestAccessToken を呼ぶ（スマホはタップ直後の同期呼び出しでないとポップアップを塞ぐ）。
  signIn(force) {
    const cfg = this.cfg();
    return new Promise((resolve, reject) => {
      if (!cfg.clientId) { toast('クライアントIDを設定してください'); return resolve(false); }
      const launch = () => {
        try {
          const tc = google.accounts.oauth2.initTokenClient({
            client_id: cfg.clientId,
            scope: GSCOPE,
            callback: (r) => (r && r.access_token) ? this._onToken(r, resolve, reject) : reject(new Error('トークン取得失敗')),
            error_callback: (e) => reject(new Error((e && e.type) || 'OAuthエラー')),
          });
          tc.requestAccessToken({ prompt: force ? 'consent' : '' });   // 同期で呼ぶ＝タップのユーザー操作を維持
        } catch (e) { reject(e); }
      };
      if (window.google && google.accounts && google.accounts.oauth2) launch();   // 既読込→同期で即ポップアップ
      else this.ensureGis().then(launch).catch(reject);                            // 未読込時のみフォールバック
    });
  },
  // サイレント再取得: ポップアップ無し(prompt:'')でアクセストークンを更新する。
  // トークンは約1時間で失効するため、401時や同期前に呼んで「セッションが生きていれば無音で延長」する。
  // GIS未読込/clientId未設定/セッション無効なら false（その場合のみ手動再ログインが要る）。
  refresh() {
    // 進行中の再取得があれば同じPromiseを共有する。起動時に restoreSession・dsync(_driveFetch/afterSignIn)
    // など複数経路から同時に呼ばれると、各回 requestAccessToken でログイン画面が二重に開く不具合の対策。
    if (this._refreshing) return this._refreshing;
    const cfg = this.cfg();
    this._refreshing = new Promise((resolve) => {
      if (!cfg.clientId || !(window.google && google.accounts && google.accounts.oauth2)) return resolve(false);
      try {
        const tc = google.accounts.oauth2.initTokenClient({
          client_id: cfg.clientId,
          scope: GSCOPE,
          callback: (r) => { if (r && r.access_token) { this._token = r.access_token; this._scope = r.scope || this._scope; this._refreshExpMs = this._expMs(r.expires_in); this._writeToken(this._token, this._scope, this._email, this._refreshExpMs); resolve(true); } else resolve(false); },
          error_callback: () => resolve(false),
        });
        tc.requestAccessToken({ prompt: '' });   // 無音更新（同意画面を出さない）
      } catch (_) { resolve(false); }
    }).finally(() => { this._refreshing = null; });
    return this._refreshing;
  },
  // リロード後のログイン復元: ①保存済みトークンが生きていれば無通信で即復帰（サードパーティCookie
  // 不要・これが主役）。②保存が無い/失効していれば、Googleの生きたセッションから無音再取得を試す
  // （Cookieが通れば成功）。どちらも不可なら静かに未ログインのまま＝従来どおり手動ログイン（悪化なし）。
  // 起動時に1回だけ呼ぶ想定。
  async restoreSession() {
    const cfg = this.cfg();
    if (this._token) return true;
    // ① 保存済みトークン（失効前）→ Googleへ通信せず即ログイン状態に戻す
    const saved = this._loadToken();
    if (saved) {
      this._token = saved.t; this._scope = saved.s || ''; this._email = saved.e || '';
      try { render(); } catch (_) {}
      try { if (typeof dsync !== 'undefined') dsync.afterSignIn(); } catch (_) {}
      // 注意: ここで無音再取得(refresh)を呼ばない。保存トークンは失効前で有効なため再取得は不要で、
      // GISの再取得はCookieブロック時にGoogleのアカウント選択画面を開いてしまう（リロード毎に出る不具合の原因）。
      // 失効後は Drive アクセスの401時に必要に応じて再取得する。
      return true;
    }
    // ② 保存が無い/失効 → サイレント再取得（セッション＆Cookieが生きていれば成功）
    if (!cfg.clientId) return false;
    try { await this.ensureGis(); } catch (_) { return false; }
    if (!await this.refresh()) return false;                    // 無音取得不可（Cookieブロック等）は静かに諦める
    try {
      const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + this._token } }).then(x => x.json());
      const email = ((info && info.email) || '').toLowerCase();
      const allow = (cfg.allowedEmails || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
      if (allow.length && !allow.includes(email)) { this._token = null; this._scope = ''; this._clearToken(); return false; } // 許可外は復元しない
      this._email = email;
      this._writeToken(this._token, this._scope, email, this._refreshExpMs || this._expMs(3600)); // メール込みで保存し直す
    } catch (_) { /* userinfo取得失敗でもトークンは有効＝続行（メール表示だけ空になる） */ }
    try { render(); } catch (_) {}                              // 「未ログイン」警告を消し状態反映
    try { if (typeof dsync !== 'undefined') dsync.afterSignIn(); } catch (_) {} // 自動同期ONなら初回マージ
    return true;
  },
};

// ---------- Drive 自動マージ同期（aoiro方式・SyncMerge を利用） ----------
// Drive上の securities-manager/data.json を base/local/remote で3-wayマージし、両端末が収束。
// トークンは gsync と共用（スコープに drive.file を追加済み）。clientId 未設定なら休眠。
const DSYNC_FOLDER = 'securities-manager';
const DSYNC_FILE = 'data.json';
const dsync = {
  _busy: false, _timer: null, _lastSnap: '', _started: false,
  enabled() { try { return localStorage.getItem('sm_drive_autosync') === '1'; } catch (_) { return false; } },
  setEnabled(on) { try { localStorage.setItem('sm_drive_autosync', on ? '1' : '0'); } catch (_) {} },
  syncedAt() { try { return localStorage.getItem('sm_sync_at'); } catch (_) { return null; } },
  // 同期の基準(base)＝dataBundle 全体のコピー。localStorage に置くと本体と合わせて容量を実質2倍
  // 使うため IndexedDB に保存する（§16.7.5）。毎回 IDB から読む＝全タブ共有もこれまでどおり
  // （2026-08-13 のクロスタブ対策を壊さない。メモリにキャッシュすると別タブの更新で古くなる）。
  async _loadBaseRaw() {
    if (idb.ok) {
      const v = await idb.get('syncBase');
      if (typeof v === 'string' && v) return v;
      // 移行(初回): 旧版は localStorage 'sm_sync_base'。IDB へ移して localStorage から外す（約5MB枠の解放）
      let ls = null; try { ls = localStorage.getItem('sm_sync_base'); } catch (_) {}
      if (ls) { await idb.set('syncBase', ls); try { localStorage.removeItem('sm_sync_base'); } catch (_) {} return ls; }
      return '{}';
    }
    try { return localStorage.getItem('sm_sync_base') || '{}'; } catch (_) { return '{}'; }
  },
  _saveBaseRaw(json) {
    if (idb.ok) { idb.set('syncBase', json).catch(() => {}); return; }
    try { localStorage.setItem('sm_sync_base', json); } catch (_) {}
  },
  // 基準点のクリア（リセット/インポート/バックアップ復元用）。IDB と旧 localStorage の両方を消す
  _clearBase() {
    try { localStorage.removeItem('sm_sync_base'); localStorage.removeItem('sm_sync_at'); } catch (_) {}
    if (idb.ok) idb.del('syncBase').catch(() => {});
  },
  _snapshot() { return JSON.stringify(dataBundle()); },

  async _driveFetch(url, opts = {}, _retried) {
    // トークン無し→まずサイレント再取得を試す（セッションが生きていればポップアップ無しで復帰）
    if (!gsync._token) { const ok = await gsync.refresh(); if (!ok) throw new Error('Googleログインが必要です'); }
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + gsync._token } });
    if (res.status === 401 && !_retried) {
      // 失効→サイレント再取得して1回だけ再試行。ダメなら手動再ログインを促す。
      const ok = await gsync.refresh();
      if (ok) return this._driveFetch(url, opts, true);
      gsync._token = null; gsync._clearToken(); throw new Error('Google認証の期限切れ。再ログインしてください');
    }
    if (res.status === 401) { gsync._token = null; gsync._clearToken(); throw new Error('Google認証の期限切れ。再ログインしてください'); }
    return res;
  },
  // 非ok時にDrive APIのエラーメッセージ本文を取り出す（403の原因＝スコープ不足/API未有効 を見分けるため）
  async _bodyMsg(res) {
    try { const t = await res.text(); try { const j = JSON.parse(t); return (j.error && (j.error.message || j.error.status)) || t.slice(0, 300); } catch (_) { return t.slice(0, 300); } } catch (_) { return ''; }
  },
  async _driveJson(url, opts) {
    const res = await this._driveFetch(url, opts);
    if (!res.ok) throw new Error(`Drive API ${res.status}：${await this._bodyMsg(res)}`);
    return res.json();
  },
  async _ensureFolder() {
    const q = encodeURIComponent(`name='${DSYNC_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const d = await this._driveJson(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`);
    if (d.files && d.files.length) return d.files[0].id;
    const cd = await this._driveJson('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: DSYNC_FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
    });
    return cd.id;
  },
  async _findFile(folderId) {
    const q = encodeURIComponent(`name='${DSYNC_FILE}' and '${folderId}' in parents and trashed=false`);
    const d = await this._driveJson(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,modifiedTime)&spaces=drive`);
    return (d.files && d.files[0]) || null;
  },
  // 資産推移の空ファイル portfolio-history.json を「ユーザー所有」で1度だけ作成する。
  // サーバー(サービスアカウント)は容量ゼロで新規作成できない（403）が、ユーザー所有の既存ファイルへの
  // 更新(PATCH)は可能なため、作成はクライアントが担い、日次の書き込みはサーバーが行う分担にする。
  async ensureHistoryFile(folderId) {
    if (this._histEnsured) return;
    try {
      folderId = folderId || await this._ensureFolder();
      const q = encodeURIComponent(`name='portfolio-history.json' and '${folderId}' in parents and trashed=false`);
      const d = await this._driveJson(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`);
      if (d.files && d.files.length) { this._histEnsured = true; return; }
      const boundary = 'phc' + Math.random().toString(36).slice(2);
      const meta = { name: 'portfolio-history.json', parents: [folderId] };
      const content = '{"snapshots":[]}';
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
      const r = await this._driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
      });
      if (r.ok) this._histEnsured = true;
    } catch (_) { /* best-effort */ }
  },
  // 過去データを portfolio-history.json に統合（日付キーで upsert）。返り値=統合後の日数。
  async historyMerge(incoming) {
    const folderId = await this._ensureFolder();
    const q = encodeURIComponent(`name='portfolio-history.json' and '${folderId}' in parents and trashed=false`);
    const d = await this._driveJson(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`);
    const fileId = (d.files && d.files[0]) ? d.files[0].id : null;
    let snaps = [];
    if (fileId) { try { const j = JSON.parse(await this._readFile(fileId)); snaps = Array.isArray(j) ? j : (j.snapshots || []); } catch (_) {} }
    const map = new Map(snaps.map(s => [s.date, s]));
    for (const s of incoming) map.set(s.date, { ...(map.get(s.date) || {}), ...s }); // 同日は取込で上書き（マージ）
    const merged = [...map.values()].sort((a, b) => a.date < b.date ? -1 : 1);
    const content = JSON.stringify({ snapshots: merged, updatedAt: new Date().toISOString() });
    if (fileId) {
      const r = await this._driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: content });
      if (!r.ok) throw new Error('履歴更新失敗 ' + r.status);
    } else {
      const boundary = 'phm' + Math.random().toString(36).slice(2);
      const meta = { name: 'portfolio-history.json', parents: [folderId] };
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
      const r = await this._driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
      if (!r.ok) throw new Error('履歴作成失敗 ' + r.status);
    }
    return merged.length;
  },
  async _readFile(id) {
    const r = await this._driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
    if (!r.ok) throw new Error(`Drive読込失敗 ${r.status}：${await this._bodyMsg(r)}`);
    return r.text();
  },
  async _writeFile(folderId, fileId, content) {
    if (fileId) {
      const r = await this._driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,modifiedTime`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: content,
      });
      if (!r.ok) throw new Error(`Drive更新失敗 ${r.status}：${await this._bodyMsg(r)}`);
      return r.json();
    }
    const boundary = 'sm' + Math.random().toString(36).slice(2);
    const meta = { name: DSYNC_FILE, parents: [folderId] };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
    const r = await this._driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
    if (!r.ok) throw new Error(`Drive作成失敗 ${r.status}：${await this._bodyMsg(r)}`);
    return r.json();
  },

  // 1回の同期: Drive読込→3-wayマージ→ローカル反映→Drive書込→base更新
  async syncNow() {
    if (this._busy) return null;
    // トークン無し or Drive権限が無い→同意画面を出して付与（force）
    if (!gsync._token || !gsync.hasDrive()) { const ok = await gsync.signIn(true); if (!ok) return null; }
    this._busy = true;
    try {
      const folderId = await this._ensureFolder();
      await this.ensureHistoryFile(folderId); // 資産推移の空ファイルをユーザー所有で用意（サーバーはこれをPATCH更新）
      const file = await this._findFile(folderId);
      let remote = {}, remoteRaw = null;
      if (file) {
        // ★読み込み失敗を「Drive=空」と誤解して続行しない（2026-08-27 の事故の発生源）。
        //   空扱いで3-wayマージすると、ローカル未変更のキーが軒並み「remoteで削除された」と誤解釈され、
        //   設定（タブの並び等）・株価/銘柄名/決算日キャッシュが消えたバンドルが Drive に書き戻されて
        //   全端末へ伝播した。中止しても次の自動同期（25秒間隔）でやり直されるだけで実害はない。
        remoteRaw = await this._readFile(file.id);   // 通信失敗は throw ＝この同期を中止
        try { remote = JSON.parse(remoteRaw); } catch (_) {
          throw new Error('Driveの同期データが読めません（ファイル破損の可能性）。マスタ画面のバックアップ復元を検討してください');
        }
      }
      // その日最初の同期で、上書き前のDrive内容を1世代バックアップ（最大5世代・best-effort）
      if (remoteRaw) await this.backupDailyOnce(remoteRaw);
      // techAnalysis の IndexedDB 読み込み完了を待つ（§16.7.5）。未ロード＝空のまま bundle を作ると
      // 3-way マージが「ローカルで全削除」と誤解釈し、Drive・他端末の分析結果まで消える。
      await (store.idbReady || Promise.resolve());
      const local = dataBundle();
      const localJson = JSON.stringify(local);  // Drive書込(await)中にローカルが変わったかの判定基準
      const base = JSON.parse(await this._loadBaseRaw());
      const merged = SyncMerge.mergeBundle(base, local, remote);
      // マージの削除伝播で rules が空になると restore 時に rules[0].isDefault で落ちる。
      // 空なら既定ルールを補い、Drive 側にも壊れた空配列を残さない（自己修復）
      if (!Array.isArray(merged.rules) || merged.rules.length === 0) merged.rules = [structuredClone(DEFAULT_RULE)];
      const json = JSON.stringify(merged);                 // 変更前にシリアライズ
      await this._writeFile(folderId, file ? file.id : null, json);
      this._saveBaseRaw(json);
      // Driveの読み書き（await）中にローカルが変わっていたら、その変更を merged に取り込んでから反映する。
      // 以前は merged をそのまま restoreBundle していたため、同期の往復中に確定した変更が
      // 「同期開始時点のスナップショット」で丸ごと巻き戻っていた（実害: ニュース「更新」で増えた記事が
      //  少し経つと更新前の状態に戻る。取得に最大25秒かかるので自動同期(25秒間隔)と重なりやすい）。
      // base=同期開始時のローカル / local=現在のローカル / remote=merged で3-wayすると、
      // 「同期中に変わったキーだけ」現在の値が勝ち、他は merged のまま。
      let apply = merged;
      const curJson = this._snapshot();
      if (curJson !== localJson) {
        apply = SyncMerge.mergeBundle(local, JSON.parse(curJson), merged);
        if (!Array.isArray(apply.rules) || apply.rules.length === 0) apply.rules = [structuredClone(DEFAULT_RULE)];
      }
      restoreBundle(apply);                                // ローカル反映（apply は以後変更されてよい）
      try { localStorage.setItem('sm_sync_at', new Date().toISOString()); } catch (_) {}
      // 同期中の変更はまだ Drive に載っていない → _lastSnap を「書き込んだ内容」にしておくと
      // 次の自動同期で差分ありと判定され、取りこぼさず push される。
      this._lastSnap = (apply === merged) ? this._snapshot() : json;
      return apply;
    } finally { this._busy = false; }
  },
  // 変更があれば同期（自動・ポップアップは出さない）。トークン失効時はサイレント再取得を試み、
  // セッションが生きていれば手動ログイン無しで同期を継続する（ダメなら静かにスキップ）。
  async _maybeSync() {
    if (!this.enabled() || this._busy || !gsync.cfg().clientId) return;
    if (!gsync._token || !gsync.hasDrive()) { const ok = await gsync.refresh(); if (!ok || !gsync.hasDrive()) return; }
    if (this._snapshot() === this._lastSnap) return;
    try { await this.syncNow(); } catch (_) {}
  },
  // サインイン直後に呼ぶ: 自動同期ONなら初回マージ
  afterSignIn() {
    if (!this.enabled()) return;
    this.syncNow().then(() => { render(); }).catch(() => {});
  },
  // 自動同期ループ開始（インターバル＋タブ非表示/離脱）。未ログイン時は何もしない（ポップアップ無し）
  startAuto() {
    if (this._started) return; this._started = true;
    this._lastSnap = this._snapshot();
    this._timer = setInterval(() => this._maybeSync(), 25000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this._maybeSync(); });
    window.addEventListener('beforeunload', () => { this._maybeSync(); });
  },

  // ===== Drive 世代バックアップ（最大5世代） =====
  // data.json と同じ securities-manager フォルダに backup-YYYYMMDD-HHMMSS.json として保存。
  // _findFile は name='data.json' 限定なので本体同期とは干渉しない。
  _backupDay() { try { return localStorage.getItem('sm_backup_day'); } catch (_) { return null; } },
  _setBackupDay(d) { try { localStorage.setItem('sm_backup_day', d); } catch (_) {} },
  _backupFileName() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
  },
  async _createBackupFile(folderId, name, content) {
    const boundary = 'smb' + Math.random().toString(36).slice(2);
    const meta = { name, parents: [folderId] };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
    const r = await this._driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
    if (!r.ok) throw new Error(`バックアップ作成失敗 ${r.status}：${await this._bodyMsg(r)}`);
    return r.json();
  },
  async listBackups(folderId) {
    const q = encodeURIComponent(`name contains 'backup-' and '${folderId}' in parents and trashed=false`);
    const d = await this._driveJson(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&spaces=drive`);
    return (d.files || []).sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)); // 新しい→古い
  },
  async _pruneBackups(folderId, keep) {
    const files = await this.listBackups(folderId);
    for (const f of files.slice(keep)) {
      try { await this._driveFetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: 'DELETE' }); } catch (_) {}
    }
  },
  // 任意のJSON文字列を世代バックアップとして保存し最大5世代に剪定。失敗は呼び出し側で握りつぶす（best-effort）
  async makeBackup(content) {
    if (!content) return null;
    const folderId = await this._ensureFolder();
    const created = await this._createBackupFile(folderId, this._backupFileName(), content);
    try { await this._pruneBackups(folderId, 5); } catch (_) {}
    return created;
  },
  // その日まだ世代を作っていなければ1世代だけ作る（同期内から呼ぶ・best-effort）
  async backupDailyOnce(content) {
    try {
      if (!content || this._backupDay() === today()) return;
      await this.makeBackup(content);
      this._setBackupDay(today());
    } catch (_) { /* バックアップ失敗で同期は止めない */ }
  },
  // 世代バックアップから復元（この端末を正本化＝基準点クリアで次回同期に反映）。
  // _lastSnap は敢えて更新しない＝復元後の状態が差分として検知され、次回同期でDriveへpushされる。
  async restoreFromBackup(fileId) {
    const obj = JSON.parse(await this._readFile(fileId));
    restoreBundle(obj);
    this._clearBase();
  },
};
function gsaveSettings(f) {
  store.data.settings = store.data.settings || {};
  store.data.settings.google = { clientId: f.gClientId.value.trim(), allowedEmails: f.gAllowed.value.trim() };
  store.data.settings._updatedAt = store._now(); // 同期マージで両端末変更時に新しい方を採るため
  store.save(); toast('Google連携設定を保存しました'); renderMaster();
}
function gsyncStatus(html) { const el = document.getElementById('gsync-status'); if (el) el.innerHTML = html; }
async function gsyncSignIn() {
  gsyncStatus('<span class="muted">ログイン中…（ポップアップで承認してください）</span>');
  try { const ok = await gsync.signIn(); gsyncStatus(ok ? `<span class="pos">✓ ログイン中：${esc(gsync._email || 'OK')}</span>` : '<span class="neg">ログインできませんでした（許可アカウント/テストユーザーを確認）</span>'); }
  catch (e) { gsyncStatus('<span class="neg">ログイン失敗：' + esc(e.message || String(e)) + '</span>'); }
}
// Drive自動同期 トグル/手動
function dsyncToggle(on) {
  dsync.setEnabled(on);
  if (on) {
    dsync.startAuto();
    dsync.syncNow().then(() => { toast('Drive自動同期: ON（同期しました）'); renderMaster(); }).catch(e => toast('同期失敗: ' + (e && e.message || e), 5000));
  } else { toast('Drive自動同期: OFF'); }
}
async function dsyncNow() {
  try {
    // Drive権限が無ければ同意画面（タップ直下で呼ぶ＝ポップアップを塞がない）
    if (!gsync._token || !gsync.hasDrive()) { const ok = await gsync.signIn(true); if (!ok) return; }
    await withBusy('Driveと同期中…', () => dsync.syncNow(), '同期しました');
    renderMaster();
  } catch (e) { toast('同期失敗: ' + (e && e.message || e), 5000); }
}
// backup-YYYYMMDD-HHMMSS.json → 「2026-06-11 07:35:58」の表示名へ
function backupLabel(f) {
  const m = /backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(f.name || '');
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  return f.name || f.id;
}
// Driveの世代バックアップ一覧を出し、選んだ世代で復元
async function openDriveBackups() {
  showModal('Driveのバックアップ', '<p class="muted">読み込み中…</p>');
  try {
    if (!gsync._token || !gsync.hasDrive()) { const ok = await gsync.signIn(true); if (!ok) { closeModal(); return; } }
    const folderId = await dsync._ensureFolder();
    const files = await dsync.listBackups(folderId);
    if (!files.length) { showModal('Driveのバックアップ', '<p class="muted">まだバックアップがありません。Drive自動同期がONなら、その日最初の同期時に自動作成されます。</p>'); return; }
    const rows = files.map((f) => `<div class="btn-row" style="justify-content:space-between;align-items:center;margin:8px 0;gap:12px">
        <span>🗂 ${esc(backupLabel(f))}</span>
        <button class="btn" onclick="restoreDriveBackup('${esc(f.id)}','${esc(backupLabel(f))}')">この時点に復元</button>
      </div>`).join('');
    showModal('Driveのバックアップ（新しい順・最大5世代）', rows + '<p class="muted grp-note" style="margin-top:10px">復元すると現在のデータを選んだ世代で置き換えます（置き換え前に現データをJSONで自動ダウンロード）。</p>');
  } catch (e) { showModal('Driveのバックアップ', '<p class="neg">読み込み失敗：' + esc(e && e.message || String(e)) + '</p>'); }
}
async function restoreDriveBackup(id, label) {
  if (!confirm(`「${label}」の時点に復元します。現在のデータはこの世代で置き換わります。\n（置き換え前に現データをJSONで自動ダウンロードします）よろしいですか？`)) return;
  try { exportData(); } catch (_) { /* 失敗しても復元は続行 */ }
  try {
    await withBusy('バックアップから復元中…', () => dsync.restoreFromBackup(id), '復元しました');
    closeModal(); render(); renderMaster();
  } catch (e) { toast('復元失敗: ' + (e && e.message || e), 5000); }
}

// ---------- 計算 ----------
// 1描画中だけ有効な計算メモ。render() の間だけ evaluate/totalHolding/lastBuyInfo を
// 銘柄ごとに1回だけ計算して使い回す（同じ描画内で保有・取引履歴の走査を何度もやり直さない）。
// 描画の外では常にその場計算（メモOFF）＝古い値が残らない。データ変更→save→render で毎回作り直す。
let _calcMemo = null;
function calcMemoBegin() { _calcMemo = { ev: new Map(), th: new Map(), lb: new Map() }; }
function calcMemoEnd() { _calcMemo = null; }
const calc = {
  fx() { return store.data.fx.USDJPY || null; },

  // 当該銘柄の現在値（キャッシュ）
  price(sec) {
    const p = store.data.prices[priceKey(sec)];
    return p && typeof p.price === 'number' ? p.price : null;
  },

  // 銘柄情報マスタ（名前・セクター等のキャッシュ）
  metaOf(sec) { return store.data.meta[priceKey(sec)] || {}; },
  // 表示名: 手動上書き(nameOverride) > マスタ名(日本語優先) > 旧レコード名(後方互換) > ティッカー
  displayName(sec) { if (sec.nameOverride) return sec.nameOverride; const meta = this.metaOf(sec); return meta.name || sec.name || sec.ticker; },
  // フィールド取得: 手動上書き(<key>Override) > マスタ優先 > 旧レコード値(後方互換)（セクター/業種/時価総額/PER/配当）
  field(sec, key) {
    const ov = sec[key + 'Override']; if (ov != null && ov !== '') return ov; // 手動上書き（自動取得で潰れない）
    const meta = this.metaOf(sec); if (meta[key] != null && meta[key] !== '') return meta[key]; const v = sec[key]; return (v != null && v !== '') ? v : null;
  },
  // 高値（priceキャッシュ）
  high5y(sec) { const p = store.data.prices[priceKey(sec)] || {}; return p.high5y ?? null; },
  high52w(sec) { const p = store.data.prices[priceKey(sec)] || {}; return p.high52w ?? null; },
  // 安値（priceキャッシュ。情報表示用・判定には未使用）
  low1y(sec) { const p = store.data.prices[priceKey(sec)] || {}; return p.low1y ?? null; },
  low3y(sec) { const p = store.data.prices[priceKey(sec)] || {}; return p.low3y ?? null; },
  // 各種「〜からの下落率」（現在値 vs 基準。負=基準より下）
  dropFrom(sec, base) { return pctFromBase(this.price(sec), base); },
  dropFromPrev(sec) { return this.dropFrom(sec, this.lastBuyPrice(sec)); },
  // 安値からの上昇率（現在値 vs 安値。正=安値より上＝安値からどれだけ戻したか）
  riseFrom1y(sec) { return pctFromBase(this.price(sec), this.low1y(sec)); },
  riseFrom3y(sec) { return pctFromBase(this.price(sec), this.low3y(sec)); },
  // 前日終値時点での「次回購入(トリガー)まで残り下落率」。(前日終値 − トリガー)/前日終値。
  // 既存の残り下落率(現在値ベース)と同じ符号（正=あとこれだけ下落で到達 / 負=超過）。
  remainingDropPrev(sec) {
    const ev = this.evaluate(sec); if (!ev || ev.trigger == null) return null;
    const pc = (store.data.prices[priceKey(sec)] || {}).prevClose;
    if (pc == null || !pc) return null;
    return (pc - ev.trigger) / pc * 100;
  },
  dropFrom5y(sec) { return this.dropFrom(sec, this.high5y(sec)); },
  dropFrom52w(sec) { return this.dropFrom(sec, this.high52w(sec)); },
  // 到達区分: 本日=到達 かつ 前営業日(前日終値)で未到達→'新'、両日とも到達→'続'、未到達→null。
  // 前営業日の到達は「前日終値 ≤ 次回購入(トリガー)」で判定（残り下落率(前日)と同じ前日終値ベース）。
  reachKind(sec) {
    const ev = this.evaluate(sec); if (!ev || !ev.reached || ev.trigger == null) return null;
    const pc = (store.data.prices[priceKey(sec)] || {}).prevClose;
    const prevReached = pc != null ? pc <= ev.trigger : false;
    return prevReached ? '続' : '新';
  },

  // 銘柄の合計保有（全口座合算）
  totalHolding(secId) {
    if (_calcMemo) { const m = _calcMemo.th; if (m.has(secId)) return m.get(secId); const v = this._totalHolding(secId); m.set(secId, v); return v; }
    return this._totalHolding(secId);
  },
  _totalHolding(secId) {
    const hs = store.data.holdings.filter(h => h.securityId === secId);
    let qty = 0, cost = 0;
    for (const h of hs) { qty += h.quantity; cost += h.avgCost * h.quantity; }
    return { qty, avgCost: qty > 0 ? cost / qty : 0, acquiredCost: cost };
  },

  // 前回購入単価の情報 {price, source, date}。source: 'txn'(買い取引)|'manual'(登録値)|'みなし'(取得単価)|null
  // date(YYYY-MM-DD): 高値更新判定で「前回購入後に高値更新したか」を見るため。
  //   取引履歴があればその日付。無ければ手動入力の前回購入日(prevBuyDate)を使う（価格は手動値でも取得単価=みなしでもよい）。
  lastBuyInfo(sec) {
    if (_calcMemo) { const m = _calcMemo.lb; if (m.has(sec.id)) return m.get(sec.id); const v = this._lastBuyInfo(sec); m.set(sec.id, v); return v; }
    return this._lastBuyInfo(sec);
  },
  _lastBuyInfo(sec) {
    // skipPrevBuy が立つ買い取引は「前回購入」の候補から外す（単価・日付とも使わない）。
    // 保有数量・平均取得単価・購入回数・取引サマリーには通常どおり反映される（ledgerOnly とは独立）。
    const buys = store.data.transactions
      .filter(t => t.securityId === sec.id && t.type === 'buy' && !t.skipPrevBuy)
      .sort((a, b) => (a.tradedAt < b.tradedAt ? 1 : -1));
    if (buys.length) return { price: buys[0].price, source: 'txn', date: buys[0].tradedAt || null };
    // 取引履歴が無い場合の前回購入日は手動入力(prevBuyDate)を採用。価格は手動値→みなし(取得単価)の順で決める。
    const manualDate = sec.prevBuyDate || null;
    // 手動の前回購入価格。前回購入日(prevBuyDate)も任意入力可（高値更新判定の日付比較に使う）
    if (typeof sec.prevBuyPrice === 'number') return { price: sec.prevBuyPrice, source: 'manual', date: manualDate };
    // 未登録なら取得単価を「みなし前回購入単価」として使用（前回購入日を入れていれば高値更新判定に使える）
    const th = this.totalHolding(sec.id);
    if (th.qty > 0 && th.avgCost > 0) return { price: th.avgCost, source: 'みなし', date: manualDate };
    return { price: null, source: null, date: manualDate };
  },
  lastBuyPrice(sec) { return this.lastBuyInfo(sec).price; },

  // 最後に購入した証券会社（買い取引の最新→無ければ保有の最新更新→無ければnull）
  lastBroker(sec) {
    const buys = store.data.transactions
      .filter(t => t.securityId === sec.id && t.type === 'buy' && t.broker)
      .sort((a, b) => (a.tradedAt < b.tradedAt ? 1 : -1));
    if (buys.length) return buys[0].broker;
    const hs = store.data.holdings.filter(h => h.securityId === sec.id && h.broker);
    if (!hs.length) return null;
    hs.sort((a, b) => {
      const aq = h => (h.quantity > 0 ? 1 : 0);
      if (aq(a) !== aq(b)) return aq(b) - aq(a);            // 保有あり優先
      return (a.updatedAt || '') < (b.updatedAt || '') ? 1 : -1; // 更新が新しい順
    });
    return hs[0].broker || null;
  },

  // PER = 株価/EPS（随時算出）。EPS無ければ取得済みPER
  per(sec) { const eps = this.field(sec, 'eps'); const p = this.price(sec); if (eps && eps > 0 && p != null) return p / eps; return this.field(sec, 'per'); },
  // PBR（取得値）。日本版ページ参考指標 or Finnhub/quoteSummary 由来
  pbr(sec) { return this.field(sec, 'pbr'); },
  // PSR（株価売上高倍率。米国株のみ取得）
  psr(sec) { return this.field(sec, 'psr'); },
  // 1株配当（取得値があればそれ、無ければ 配当利回り%×現在値 から逆算）。日本株はper-share未取得でも利回りから求める。
  dividendPerShare(sec) {
    const d = this.field(sec, 'dividend'); if (d != null) return d;
    const y = this.field(sec, 'divYield'); const p = this.price(sec);
    return (y != null && p != null) ? y / 100 * p : null;
  },
  // 取得利回り＝1株配当÷取得単価×100（取得単価ベースの配当利回り＝簿価利回り）
  yieldOnCost(sec) {
    const dps = this.dividendPerShare(sec); if (dps == null) return null;
    const th = this.totalHolding(sec.id); const cost = th.avgCost;
    return cost ? dps / cost * 100 : null;
  },
  // 信用倍率（日本株のみ・週次。情報マスタの最新値）
  marginRatio(sec) { return this.field(sec, 'marginRatio'); },
  // 時価総額(百万) = 株価×発行済株式数/1e6（随時算出）。無ければ取得済み時価総額
  marketCap(sec) { const sh = this.field(sec, 'sharesOut'); const p = this.price(sec); if (sh && p != null) return p * sh / 1e6; return this.field(sec, 'marketCap'); },
  // 市場の時価総額1位（同じ市場＝日米別）まで何倍か = 1位の時価総額 ÷ 自分の時価総額。
  // 例: 1位 5T・自分 1T → 5.00倍（＝+400%）。1位自身は 1.00倍で、原則1倍を下回らない。
  capToTop(sec) {
    const t = topMarketCap(sec.market); if (!t) return null;
    const v = this.marketCap(sec); if (v == null || v <= 0) return null;
    return t.cap / (v * 1e6);
  },
  // 売買代金（原通貨・実額）= 現在値×当日出来高。出来高は価格キャッシュ優先、無ければ銘柄情報(meta)から。
  // （Finnhub利用の米株は価格更新で出来高が入らないため、銘柄情報更新=Yahoo chart の出来高で補完）
  turnover(sec) { const p = store.data.prices[priceKey(sec)] || {}; const pr = this.price(sec); const vol = p.volume != null ? p.volume : this.field(sec, 'volume'); return (pr != null && vol != null) ? pr * vol : null; },
  // 配当利回り(%)。日本版ページの配当利回り(divYield)があれば優先、無ければ 1株配当/株価 で算出。
  divYield(sec) { const y = this.field(sec, 'divYield'); if (y != null) return y; const d = this.field(sec, 'dividend'); const p = this.price(sec); return (d != null && p) ? d / p * 100 : null; },

  // ===== 目標指標から逆算した株価（参考値。買い増し判定には一切使わない） =====
  // 端数処理は次回購入（買い増しライン）と同じ floorBuyPrice に揃える（2026-08-01 すみぽん指示）。
  // 銘柄ごとに手入力した目標値（targetPer / targetPbr / targetYield）を満たす株価を出す。
  // EPS・配当・PBR は決算や増配で動くため、算出結果も自動で動く（固定値ではない）。
  // 目標PER: EPS × 目標PER
  targetPerPrice(sec) { const t = sec.targetPer, e = this.field(sec, 'eps'); return (t > 0 && e != null && e > 0) ? floorBuyPrice(e * t, sec.market) : null; },
  // 目標PBR: BPS × 目標PBR。BPS(1株純資産)は取得していないので「現在値 ÷ 現在PBR」で逆算する
  targetPbrPrice(sec) { const t = sec.targetPbr, b = this.pbr(sec), p = this.price(sec); return (t > 0 && b > 0 && p != null) ? floorBuyPrice(p / b * t, sec.market) : null; },
  // 目標配当利回り: 1株配当 ÷ (目標利回り% ÷ 100)。
  // 1株配当は dividendPerShare（未取得なら「配当利回り×現在値」の推定値＝主に日本株）。
  targetYieldPrice(sec) { const t = sec.targetYield, d = this.dividendPerShare(sec); return (t > 0 && d != null && d > 0) ? floorBuyPrice(d / (t / 100), sec.market) : null; },

  baseHigh(sec) {
    const rule = store.rule(sec.ruleId);
    const mode = sec.baseHighMode || rule.baseHighMode || '5y';
    if (mode === 'manual') return typeof sec.baseHighManual === 'number' ? sec.baseHighManual : null;
    const p = store.data.prices[priceKey(sec)] || {};
    if (mode === '52w') return p.high52w || null;
    if (mode === 'all') return p.highAll || p.high5y || null;
    return p.high5y || null; // 5y デフォルト
  },

  // 基準高値が「付いた日付」(YYYY-MM-DD)。高値更新判定（前回購入後に高値更新したか）で使う。
  // manualモードや日付未取得（旧キャッシュ）は null → 高値更新判定は発動しない（安全側）
  baseHighDate(sec) {
    const rule = store.rule(sec.ruleId);
    const mode = sec.baseHighMode || rule.baseHighMode || '5y';
    if (mode === 'manual') return null;
    const p = store.data.prices[priceKey(sec)] || {};
    if (mode === '52w') return p.high52wDate || null;
    if (mode === 'all') return p.highAllDate || p.high5yDate || null;
    return p.high5yDate || null; // 5y デフォルト
  },

  // 判定結果: { type, base, trigger, price, remainingDropPct, reached, recoAmount, recoCcy }
  evaluate(sec) {
    if (_calcMemo) { const m = _calcMemo.ev; if (m.has(sec.id)) return m.get(sec.id); const v = this._evaluate(sec); m.set(sec.id, v); return v; }
    return this._evaluate(sec);
  },
  _evaluate(sec) {
    if (sec.market === 'FUND' || sec.enabled === false) return null;
    const price = this.price(sec);
    if (price == null) return null;
    const rule = store.rule(sec.ruleId);
    const th = this.totalHolding(sec.id);
    const lb = this.lastBuyInfo(sec);

    const fixed = (typeof sec.fixedBuyPrice === 'number' && sec.fixedBuyPrice > 0) ? sec.fixedBuyPrice : null;
    let type = (th.qty <= 0 && lb.price == null) ? 'initial' : 'addon';
    let base, trigger, baseSource;
    if (fixed != null) {
      // 買増固定値: ルール計算でなく手入力の固定トリガーを使う（丸めなし）
      trigger = fixed; base = fixed; baseSource = '固定';
    } else if (type === 'initial') {
      base = this.baseHigh(sec); baseSource = 'high';
      if (base == null) return null;
      trigger = base * (1 - rule.initialDropPct / 100);
    } else if (sec.addonFromHigh) {
      // 「買い増しも初回基準」フラグ: 買い増しでも常に初回と同じ判定＝基準高値×(1−初回下落率)。
      // 前回購入単価に依らずトリガーが動かない（1回目を少額で買っても次回購入ラインが下がらず、
      // 同じ初回ライン＝例:−40%で残り全額を買い増せる）。買い増し下落率(addonDropPct)は使わない。
      const bh = this.baseHigh(sec);
      if (bh == null) return null;
      base = bh; baseSource = '初回固定'; trigger = base * (1 - rule.initialDropPct / 100);
    } else {
      const bh = this.baseHigh(sec);
      const bhDate = this.baseHighDate(sec);
      // 高値更新時は初回ルールで判定（rule.highResetMode）。
      // 「前回購入より後に最高値を更新した」場合のみ＝基準高値が付いた日付が前回購入日より後（時間軸で判定）。
      // 取引履歴の日付(lb.date)と高値の日付(bhDate)が両方そろう時だけ発動。
      // 旧ロジック（bh>lb.price の値比較）は、暴落後に買った銘柄が常に高値更新扱いになる誤判定があったため日付ベースに変更。
      if (rule.highResetMode && lb.date && bhDate && bhDate > lb.date && bh != null) {
        base = bh; baseSource = '高値更新'; trigger = base * (1 - rule.initialDropPct / 100);
      } else {
        base = lb.price != null ? lb.price : bh;
        baseSource = lb.price != null ? lb.source : 'high';
        if (base == null) return null;
        trigger = base * (1 - rule.addonDropPct / 100);
      }
    }
    // 次回購入の丸め（固定値以外・端数切捨て）: 米株=1ドル単位（10ドル未満は0.1ドル）、日本株=円未満切捨て
    if (fixed == null) trigger = floorBuyPrice(trigger, sec.market);
    const remainingDropPct = (price - trigger) / price * 100; // >0: あとこれだけ下落で到達
    const recoCcy = sec.market === 'US' ? 'USD' : 'JPY';
    const recoAmount = this.buyAmount(sec);
    return { type, base, baseSource, trigger, price, remainingDropPct, reached: price <= trigger, recoAmount, recoCcy };
  },

  // 1回の購入額（原通貨）。銘柄に手入力があればそれを優先、無ければカテゴリ金額から転記
  buyAmount(sec) {
    if (sec.buyAmount != null && sec.buyAmount !== '') return Number(sec.buyAmount);
    const amt = store.categoryAmountFor(sec.category, sec.market);
    return amt || null;
  },
  // 購入回数（手入力 or 買い取引数）
  buyCount(sec) {
    if (sec.buyCount != null) return sec.buyCount;
    return store.data.transactions.filter(t => t.securityId === sec.id && t.type === 'buy').length;
  },

  // 評価額（原通貨）。価格未取得は null
  valueNative(sec) {
    // 投信は自動価格が無い。保有（証券会社×口座）ごとの手入力評価額(h.evalJpy)を優先合算し、
    // 未入力の保有だけ共有単価×口数で概算補完（どちらも無ければ null）
    if (sec.market === 'FUND') {
      const hs = store.data.holdings.filter(h => h.securityId === sec.id);
      const price = this.price(sec);
      if (hs.some(h => h.evalJpy != null) || price != null) {
        return hs.reduce((a, h) => a + (h.evalJpy != null ? h.evalJpy : (price != null ? price * (h.quantity || 0) : 0)), 0);
      }
      return null;
    }
    const price = this.price(sec);
    const th = this.totalHolding(sec.id);
    if (price == null) return null;
    return price * th.qty;
  },
  // 取得原価（原通貨）。価格に依存せず常に分かる
  costNative(sec) { return this.totalHolding(sec.id).acquiredCost; },
  // 購入額（本来・原通貨）。一旦売却→他社で買い直し（損出し）等で「最初の購入額」を残したい用途。
  // 保有レコードごとに、売却前購入額(origBuyAmount)が入っていればそれ、無ければ取得価額(取得単価×数量)を採用して合算する。
  originalCostNative(sec) {
    return store.data.holdings
      .filter(h => h.securityId === sec.id)
      .reduce((a, h) => a + (h.origBuyAmount != null ? h.origBuyAmount : h.avgCost * h.quantity), 0);
  },
  // 評価額（原通貨）。価格未取得時は取得原価で代替（合計に含めるため）
  valueOrCostNative(sec) {
    const v = this.valueNative(sec);
    return v != null ? v : this.costNative(sec);
  },
  // 損益率（原通貨ベース。為替に依存しない）
  pnlPctNative(sec) {
    // 投信は自動単価が無く評価額が保有ごとの手入力(h.evalJpy)。評価額ベースで損益率を出す
    if (sec.market === 'FUND') {
      const v = this.valueNative(sec), c = this.costNative(sec);
      return (v == null || !(c > 0)) ? null : (v - c) / c * 100;
    }
    const th = this.totalHolding(sec.id);
    const price = this.price(sec);
    if (price == null || th.qty <= 0 || !th.avgCost) return null;
    return (price - th.avgCost) / th.avgCost * 100;
  },
  // 前日比の金額（円換算）。market指定で市場別、未指定で全体。{amount, prevValue, pct}
  dayChangeJpy(market) {
    let amt = 0, prevVal = 0;
    for (const h of store.data.holdings) {
      if (!(h.quantity > 0)) continue;
      const sec = store.data.securities.find(s => s.id === h.securityId); if (!sec) continue;
      if (market && sec.market !== market) continue;
      const p = store.data.prices[priceKey(sec)] || {};
      if (p.price == null || p.prevClose == null) continue;
      const dJ = this.toJpy(sec.market, h.quantity * (p.price - p.prevClose));
      const pJ = this.toJpy(sec.market, h.quantity * p.prevClose);
      if (dJ == null || pJ == null) continue;
      amt += dJ; prevVal += pJ;
    }
    return { amount: amt, prevValue: prevVal, pct: prevVal > 0 ? amt / prevVal * 100 : null };
  },
  // 参考指数の前日比%
  indexChangePct(key) {
    const ix = (store.data.indices || {})[key];
    if (!ix || ix.price == null || !ix.prevClose) return null;
    return (ix.price - ix.prevClose) / ix.prevClose * 100;
  },
  // 原通貨→円換算（米株は為替、JP/FUNDはそのまま）。為替未取得の米株は null
  toJpy(market, nativeAmt) {
    if (nativeAmt == null) return null;
    if (market === 'US') { const fx = this.fx(); return fx != null ? nativeAmt * fx : null; }
    return nativeAmt;
  },
};

function priceKey(sec) { return `${sec.market}:${sec.ticker}`; }

// ===== 決算日（前回/次回）ヘルパ =====
// キャッシュ: store.data.earnings[priceKey] = { prev, next, nextEstimate, exDiv, at }
//   prev = 実際の発表日（TDnet決算短信 / EDGAR 10-Q等の提出日）, next = Yahooの次回決算予定日, nextEstimate = Yahooが推定した日か
function earnOf(sec) { return (store.data.earnings && store.data.earnings[priceKey(sec)]) || null; }
function _ymd(d) { const y = d.getFullYear(), m = d.getMonth() + 1, dd = d.getDate(); return `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`; }
function _parseYmd(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
function _todayYmd() { const d = new Date(); return _ymd(d); }
function _addMonths(ymd, n) { const d = _parseYmd(ymd); if (!d) return null; d.setMonth(d.getMonth() + n); return _ymd(d); }
function _diffDays(a, b) { const da = _parseYmd(a), db = _parseYmd(b); if (!da || !db) return null; return Math.round((db - da) / 86400000); }
function fmtEarnMD(ymd) { const d = _parseYmd(ymd); return d ? `${d.getMonth() + 1}/${d.getDate()}` : ''; }   // 8/6
function fmtEarnYMD(ymd) { const d = _parseYmd(ymd); return d ? `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` : '-'; } // 2026/8/6

// 決算間隔（月）。直近2回の決算日 prev2→prev の間隔から四半期(3)/半期(6)/通期(12)を推定。既定は四半期(3)。
function _monthsBetween(a, b) { const da = _parseYmd(a), db = _parseYmd(b); if (!da || !db) return null; return (db.getFullYear() - da.getFullYear()) * 12 + (db.getMonth() - da.getMonth()); }
function earnCadence(e) {
  if (e && e.prev && e.prev2) { const mo = _monthsBetween(e.prev2, e.prev); if (mo != null && mo >= 1) { if (mo <= 4) return 3; if (mo <= 8) return 6; return 12; } }
  return 3; // 既定は四半期
}
// 決算日の整理: prev(実績) / 確定予定(confirmedNext) / 推定(estNext=前回+決算間隔)。
// 推定は「決算間隔+1ヶ月」を過ぎても発表が来ない＝間隔判定が外れ／不定期決算なので無効化（半期銘柄がソート上位に残り続けるのを防ぐ）。
// 「予定日を過ぎたのに prev が古いまま」への対処（2026-07-29）:
//   ソース側は発表当日〜翌日には反映されない（US=Nasdaqの Date Reported は1〜2日遅れ、
//   JP=Yahooは発表と同時に予定日を消す）。この間、予定日は過去・prev は前四半期のままになり、
//   画面上は「次回決算が消えて、前回決算が古いまま」に見える。
//   → 過ぎた予定日(next)を **発表済み（見込み）** として prev に繰り上げ、次回＝そこ+決算間隔で推定する。
//     ソースが本物の prev を返した時点で自動的に置き換わる。45日以上前の予定日は誤りの可能性があるため使わない。
function earnInfo(sec) {
  const e = earnOf(sec);
  if (!e) return null;
  const today = _todayYmd();
  const prev = e.prev || null;                                   // 取得できた前回決算日だけ。推測で埋めない
  const schedule = (e.next && !e.nextEstimate) ? e.next : null;  // Yahoo/Nasdaq 確定の予定日（過去日を含む生の値）
  // 「次回」としての予定日は未来（当日を含む）のものだけ。過ぎた予定日は次回ではないので外す
  // （ソースが消しても手元には残す＝ラベルが決算直後の数日それを出すため。schedule で参照する）
  const confirmedNext = (schedule && _diffDays(today, schedule) >= 0) ? schedule : null;
  let estNext = null;
  if (!confirmedNext) {
    const raw = prev ? _addMonths(prev, earnCadence(e)) : (e.next || null); // 予定日が無ければ 前回+決算間隔 を推定
    if (raw && _diffDays(today, raw) >= -31) estNext = raw; // 推定日を1ヶ月以上過ぎたら「わからない」扱い
  }
  return { prev, prev2: e.prev2 || null, schedule, confirmedNext, estNext };
}
// 銘柄名の横／上部に出すラベル。近い決算・直近発表のときだけ返す（無ければ null）。
//   { text, cls, sub }  cls: earn-soon(予定) / earn-done(発表) / earn-est(ごろ)
// 前営業日・翌営業日（土日をスキップ。祝日は考慮しない簡易版）
function _prevBizYmd() { const d = new Date(); d.setDate(d.getDate() - 1); while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1); return _ymd(d); }
function _nextBizYmd() { const d = new Date(); d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); return _ymd(d); }
function earnLabel(sec) {
  const info = earnInfo(sec); if (!info) return null;
  const today = _todayYmd();
  const pb = _prevBizYmd(), nb = _nextBizYmd();
  // 赤強調（すみぽん仕様 2026-07-23）: 発表=当日・前営業日 / 予定=前営業日・当日・翌営業日
  const urgentPrev = (d) => d === today || d === pb;
  const urgentNext = (d) => d === today || d === pb || d === nb;
  const { prev, schedule, estNext } = info;
  // 表示期間の考え方（2026-07-29 すみぽん決定）:
  //   「いつから」＝決算が近いと分かる期間（予定=7日前 / 推定=14日前。またぐかの判断に使う）
  //   「いつまで」＝決算直後に株価が動く理由として決算を疑える期間＝どれも【7日後まで】。
  //   それを過ぎたら決算は株価と関係が薄いのでラベルは出さない。
  //   ※ 予定日・推定日を過ぎても7日は出す。前回決算日の取得がソース側の遅れで1〜2日空くため、
  //     ここで切ると「決算があったのにラベルが何も出ない」空白ができる（実際に発生した）。
  const AFTER = 7;
  // 1) 直近に発表があった（前回発表から7日以内）
  if (prev) { const g = _diffDays(prev, today); if (g !== null && g >= 0 && g <= AFTER) return { text: `${fmtEarnMD(prev)}発表`, cls: 'earn-done' + (urgentPrev(prev) ? ' earn-urgent' : '') }; }
  // 2) 予定日（確定）が近い／過ぎて間もない（7日前〜7日後）。過ぎても発表日を取得できていない間はこれを出す
  if (schedule) { const g = _diffDays(today, schedule); if (g !== null && g >= -AFTER && g <= 7) return { text: `${fmtEarnMD(schedule)}予定`, cls: 'earn-soon' + (urgentNext(schedule) ? ' earn-urgent' : '') }; }
  // 3) 推定が近い／過ぎて間もない（14日前〜7日後）。推定時は前回決算日も併記（推定は不確実なので赤強調はしない）
  if (estNext) { const g = _diffDays(today, estNext); if (g !== null && g >= -AFTER && g <= 14) return { text: `${fmtEarnMD(estNext)}ごろ`, cls: 'earn-est', sub: prev ? `前回${fmtEarnMD(prev)}` : '' }; }
  return null;
}
// ラベルのHTML（一覧の銘柄名の横・上部共通）。size='sm' は一覧用の小型。
function earnLabelHtml(sec, opts) {
  const l = earnLabel(sec); if (!l) return '';
  const sub = (opts && opts.withSub && l.sub) ? `<span class="earn-sub">${esc(l.sub)}</span>` : '';
  return `<span class="earn-chip ${l.cls}" title="決算">${esc(l.text)}${sub ? ' ' + sub : ''}</span>`;
}
// 決算情報セクション用の値（推定は出さない。予定日不明は「-」）
function earnPrevText(sec) { const i = earnInfo(sec); return i && i.prev ? fmtEarnYMD(i.prev) : '-'; }
function earnNextText(sec) { const i = earnInfo(sec); return i && i.confirmedNext ? fmtEarnYMD(i.confirmedNext) : '-'; }
// 次回決算の「実効日」（確定予定＞推定）。列・上部表示・ソート用。{ date, kind:'予定'|'ごろ' } or null
// ラベルと同じ日付・同じ区分になるようにする（すみぽん指示 2026-07-29）:
//   予定日を取得できていれば「予定」、無ければ 前回+サイクル の「ごろ」。
//   予定日を過ぎても【発表日をまだ取得できていない間（7日以内）】はその予定日を「予定」で出す
//   （＝ラベルが `7/27予定` の時に列が `7/27ごろ` になるズレを無くす）。
//   発表日を取得できたら（prev >= 予定日）その予定日は過去のものなので、次は推定「ごろ」に切り替わる。
function earnEffNext(sec) {
  const i = earnInfo(sec); if (!i) return null;
  if (i.confirmedNext) return { date: i.confirmedNext, kind: '予定' };
  if (i.schedule && (!i.prev || i.prev < i.schedule)) {
    const g = _diffDays(_todayYmd(), i.schedule);
    if (g !== null && g >= -7) return { date: i.schedule, kind: '予定' };
  }
  if (i.estNext) return { date: i.estNext, kind: 'ごろ' };
  return null;
}
// 会社概要（株探の「会社情報→概要」を銘柄マスタにキャッシュしたもの）。未取得は ''。
function companySummary(sec) { return ((calc.metaOf(sec) || {}).summary) || ''; }
// 詳細ドロワー・カルテ上部の決算日表示（株探風の日付テキスト。ラベル/ピルにはしない）。
// 上部に出すのは「決算が近い or 直近に発表があった」ときだけ（それ以外は下の決算情報セクションで確認）。
function earnTopHtml(sec) {
  if (!earnLabel(sec)) return '';
  const i = earnInfo(sec); if (!i) return '';
  const eff = earnEffNext(sec);
  const prevS = i.prev ? fmtEarnYMD(i.prev) : '-';
  const nextS = eff ? (eff.kind === '予定' ? `${fmtEarnYMD(eff.date)}（予定）` : `${fmtEarnYMD(eff.date)}ごろ`) : '-';
  if (prevS === '-' && nextS === '-') return '';
  return `<span class="earn-top" title="決算発表日"><span class="muted">決算</span> 前回 <b>${esc(prevS)}</b> ／ 次回 <b>${esc(nextS)}</b></span>`;
}
// 次回決算までの日数（実効日基準。ソート用。無ければ大きな値で末尾へ）
function earnNextDays(sec) { const eff = earnEffNext(sec); if (!eff) return null; const d = _diffDays(_todayYmd(), eff.date); return d; }
// 決算日の再取得間隔（日）。次回決算までの距離で段階的に空ける（全銘柄を毎日取り直すのをやめる）。
//   ・直近発表（前回から7日以内）… 毎日（発表直後は次回予定日が確定・更新されやすい）
//   ・確定予定日あり … 14日以内=毎日 / 15〜30日=3日 / 31日以上=7日
//   ・推定のみ（前回+決算間隔の憶測） … 推定日は±2週間ズレるので毎日の窓を2週間広げ(28日)、遠くても3日まで。
//     推定銘柄の再取得の主目的は「予定日」ではなく prev（実際の発表日）の更新確認で、
//     「M/D発表」ラベルの窓が7日しかないため7日間隔だと発表を取り逃す。
//   ・推定が無効化（間隔判定ミス/不定期でいつ来るか不明） … 3日
//   ・完全未取得 … 毎日（実際の再試行抑制は refreshEarnings の tryAt=60分バックオフが担う）
function earnRefetchInterval(sec) {
  const i = earnInfo(sec);
  if (!i) return 1;
  const today = _todayYmd();
  if (!i.prev && !i.confirmedNext && !i.estNext) return 1;
  if (i.prev) { const g = _diffDays(i.prev, today); if (g !== null && g >= 0 && g <= 7) return 1; }
  if (i.confirmedNext) { const d = _diffDays(today, i.confirmedNext); if (d === null || d <= 14) return 1; return d <= 30 ? 3 : 7; }
  if (i.estNext) { const d = _diffDays(today, i.estNext); return (d === null || d <= 28) ? 1 : 3; }
  return 3;
}
// Yahoo Finance シンボル変換:
//   JP株  → 7203.T
//   投信  → 0131103C.T（ファンドコード.T形式）
//   US株  → AAPL（そのまま）
function yahooSymbol(sec) {
  if (sec.market === 'JP') return `${sec.ticker}.T`;
  if (sec.market === 'FUND') return `${sec.ticker}.T`;
  return sec.ticker;
}
// 株探の個別銘柄チャートURL（米株 us.kabutan / 日本株 kabutan）。
function kabutanUrl(sec) {
  const tk = (sec.ticker || '').trim();
  if (sec.market === 'US') return `https://us.kabutan.jp/stocks/${encodeURIComponent(tk)}/chart`;
  return `https://kabutan.jp/stock/chart?code=${encodeURIComponent(tk)}`;
}

// 参考指数（前日比の参考表示用）。market は表示グループ。
// ※TOPIXは Yahoo の指数シンボル(^TPX/998405.T等)が取得不可のため、1306.T（TOPIX連動ETF）を前日比の参考に使用。
const INDICES = [
  { key: 'n225', sym: '^N225', label: '日経平均', market: 'JP' },
  { key: 'topix', sym: '1306.T', label: 'TOPIX', market: 'JP', note: '連動ETF' },
  { key: 'nikkeifut', sym: 'NIY=F', label: '日経先物', market: 'JP' },
  { key: 'sp500', sym: '^GSPC', label: 'S&P500', market: 'US' },
  { key: 'ndx', sym: '^NDX', label: 'NASDAQ100', market: 'US' },
  { key: 'soxx', sym: 'SOXX', label: 'SOX(半導体)', market: 'US' },
];

// ---------- 市場時間（JST基準・DST自動。土日は休場。祝日は考慮せず開場扱い） ----------
function jstNow() { const j = new Date(Date.now() + 9 * 3600000); return { day: j.getUTCDay(), min: j.getUTCHours() * 60 + j.getUTCMinutes() }; }
// 米国サマータイム（3月第2日曜〜11月第1日曜）判定
function usDST(ms) {
  const d = new Date(ms), y = d.getUTCFullYear();
  const mar = new Date(Date.UTC(y, 2, 1)), start = Date.UTC(y, 2, 1 + ((7 - mar.getUTCDay()) % 7) + 7);
  const nov = new Date(Date.UTC(y, 10, 1)), end = Date.UTC(y, 10, 1 + ((7 - nov.getUTCDay()) % 7));
  return ms >= start && ms < end;
}
// 日本株 ザラ場(9:00-15:30)＋遅延考慮で16:00まで。月〜金。
function jpRegularOpen() { const { day, min } = jstNow(); return day >= 1 && day <= 5 && min >= 540 && min < 960; }
// 決算日取得をスキップする時間帯: 日本株ザラ場・米国レギュラー・それぞれの寄り30分前（月〜金）。
// 場中は株価取得を最速にしたい（決算日は場外の株価更新で1日1回取れれば十分）。
function earnSkipNow() {
  if (jpRegularOpen() || usRegularOpen()) return true;
  const { day, min } = jstNow();
  if (day >= 1 && day <= 5 && min >= 510 && min < 540) return true;                  // 日本株 寄り前30分（8:30-9:00 JST）
  const regStart = usDST(Date.now()) ? 1350 : 1410;                                  // 米国レギュラー開始（JST分）
  if (day >= 1 && day <= 5 && min >= regStart - 30 && min < regStart) return true;   // 米国株 寄り前30分
  return false;
}
// 米国株 レギュラー時間（JST換算・DST自動）。夏22:30〜翌5:00 / 冬23:30〜翌6:00。窓は深夜をまたぐ。
function usRegularOpen() {
  const { day, min } = jstNow(), dst = usDST(Date.now());
  const regStart = dst ? 1350 : 1410, regEndNext = dst ? 300 : 360;
  if (day >= 1 && day <= 5 && min >= regStart) return true;     // 夜側（Mon-Fri）
  if (day >= 2 && day <= 6 && min < regEndNext) return true;    // 翌朝側（Tue-Sat）
  return false;
}
// 米国株 時間外フェーズ 'pre'|'post'|null（JST換算・DST自動）。夏 pre17:00-22:30 / post 翌5:00-9:00。
function usExtPhase() {
  const { day, min } = jstNow(), dst = usDST(Date.now());
  const preStart = dst ? 1020 : 1080, regStart = dst ? 1350 : 1410, regEndNext = dst ? 300 : 360, postEndNext = dst ? 540 : 600;
  if (day >= 1 && day <= 5 && min >= preStart && min < regStart) return 'pre';
  if (day >= 2 && day <= 6 && min >= regEndNext && min < postEndNext) return 'post';
  return null;
}
// 直近のレギュラー引け(ms)。終値を既に持っているかの判定に使う。土日は前営業日まで遡る（祝日は無視）。
function lastCloseJpMs() { const n = new Date(); for (let b = 0; b < 7; b++) { const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - b, 6, 30, 0)); const w = d.getUTCDay(); if (w >= 1 && w <= 5 && d.getTime() <= Date.now()) return d.getTime(); } return Date.now() - 864e5; } // 15:30JST=6:30UTC
function lastCloseUsMs() { const h = usDST(Date.now()) ? 20 : 21; const n = new Date(); for (let b = 0; b < 7; b++) { const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - b, h, 0, 0)); const w = d.getUTCDay(); if (w >= 1 && w <= 5 && d.getTime() <= Date.now()) return d.getTime(); } return Date.now() - 864e5; } // 16:00ET

// ---------- 価格取得 ----------
const api = {
  // opts.withHighs=true で5年/52週高値も取得（日次/その日初回）。通常は価格のみ＝軽く・既存高値を保持。
  // 市場が閉場中で当日の終値を既に持っている銘柄はスキップ（再取得しない）。米株の時間外(プレ/アフター)は別取得。
  async refreshAll(opts = {}) {
    const withHighs = opts.withHighs === true;
    // 投信(FUND)は自動価格が無く（評価額は手入力）、Yahooに無い協会コードへの無駄な問い合わせで
    // 更新が遅くなるため価格取得対象から除外する
    const allSecs = store.data.securities.filter(s => s.ticker && s.market !== 'FUND');
    const lightSymbols = ['USDJPY=X', ...INDICES.map(ix => ix.sym)];
    if (allSecs.length === 0 && lightSymbols.length === 0) return;
    // 取得対象を選別: withHighs(日次)は全件。通常は「開場中 or 価格未取得 or 当日終値を未取得」のみ取得（閉場中で終値済みはスキップ）。
    const lastJp = lastCloseJpMs(), lastUs = lastCloseUsMs();
    const needsFetch = (s) => {
      if (withHighs) return true;
      const p = store.data.prices[priceKey(s)];
      const fetched = p && p.fetchedAt ? Date.parse(p.fetchedAt) : 0;
      if (s.market === 'JP') return jpRegularOpen() || !(p && p.price != null) || fetched < lastJp;
      if (s.market === 'US') return usRegularOpen() || !(p && p.price != null) || fetched < lastUs;
      return true;
    };
    const secs = allSecs.filter(needsFetch);
    const holdSymbols = secs.map(yahooSymbol);
    // Cloudflareのサブリクエスト上限(約50/リクエスト)対策で小バッチに分割。
    // ★重要: 米株はFinnhubが失敗/レート制限/非対応(c=0)だと1銘柄でFinnhub＋Yahooの【2サブリクエスト】を使う。
    //   旧BATCH=40だと全フォールバック時に最大80サブリクエスト→上限超過で後半銘柄の取得がまるごと失敗し、
    //   現在値が更新されず「前日終値のまま」固定される不具合があった。2倍を見込み20(=最大40)に下げて上限内に収める。
    //   withHighsは5年日足も取るため小さめ(10)。
    const BATCH = withHighs ? 10 : 20;
    const batches = [];
    for (let i = 0; i < holdSymbols.length; i += BATCH) batches.push(holdSymbols.slice(i, i + BATCH));
    let quotes = {}, lightQuotes = {};
    try {
      // バッチが終わるたびに件数を進める（並行取得なので完了順に加算）。初回/日次は重いので進捗が動くと安心。
      let doneSym = 0; const totalSym = holdSymbols.length;
      if (totalSym) busyMsg(`${withHighs ? '株価・5年高値' : '株価'}を取得中… 0/${totalSym}件`);
      const reqs = batches.map(b =>
        fetch(`/api/price?symbols=${encodeURIComponent(b.join(','))}${withHighs ? '&highs=1' : ''}`)
          .then(r => r.ok ? r.json() : {}).catch(() => ({}))
          .then(res => { doneSym = Math.min(doneSym + b.length, totalSym); busyMsg(`${withHighs ? '株価・5年高値' : '株価'}を取得中… ${doneSym}/${totalSym}件`); return res; }));
      const lightIdx = reqs.length;
      reqs.push(fetch(`/api/price?mode=light&symbols=${encodeURIComponent(lightSymbols.join(','))}`).then(r => r.ok ? r.json() : {}).catch(() => ({})));
      const results = await Promise.all(reqs);
      lightQuotes = results[lightIdx] || {};
      quotes = Object.assign({}, ...results.slice(0, lightIdx));
    } catch (e) {
      toast('価格取得に失敗（手入力で更新できます）');
      return;
    }
    let usFinn = 0, usYah = 0; // 米株のソース内訳（finnhub=ほぼリアルタイム / yahoo=15〜20分遅延）
    for (const sec of secs) {
      const q = quotes[yahooSymbol(sec)];
      if (q && !q.error && q.price != null) {
        const prev = store.data.prices[priceKey(sec)] || {}; // 高値は通常更新では返らない→既存値を保持
        store.data.prices[priceKey(sec)] = {
          ...prev,
          price: q.price,
          // 前日終値は通常の価格取得では一切上書きしない。Finnhub の pc も Yahoo 長期配列も一部銘柄で
          // 前々日終値になり不正確なため、信頼できる日次 light(range=1d) 取得(refreshPrevCloses)のみを正とし、
          // ここでは常に既存のキャッシュ値を保持する（前日終値は1日1回確定すれば足りる）。
          prevClose: prev.prevClose ?? null,
          prevCloseDate: prev.prevCloseDate ?? null,
          high5y: q.high5y != null ? q.high5y : (prev.high5y ?? null),
          high52w: q.high52w != null ? q.high52w : (prev.high52w ?? null),
          high5yDate: q.high5yDate != null ? q.high5yDate : (prev.high5yDate ?? null),
          high52wDate: q.high52wDate != null ? q.high52wDate : (prev.high52wDate ?? null),
          // 高値を実際に取得できた日を銘柄ごとに記録（=成功日）。取れなかった時は既存値を保持。
          // 全体フラグ(lastHighsDate)は失敗しても立つため「取得済みなのに古い高値のまま」が起きる。
          // 銘柄単位の成功日で「今日まだ取れていない銘柄」を下で取り直す（GLW 230.5固定バグ）。
          highsAt: q.high5y != null ? today() : (prev.highsAt ?? null),
          // 高値の「取得を試みた日」（成否問わず）。withHighs=highs=1 の時だけ更新。
          // Yahooが5年高値を返せない銘柄は highsAt が永久に古いまま→毎回の補完取得で毎回リトライされてしまう。
          // 試行日＋連続失敗回数を記録し、下の補完取得を「失敗が浅いうちは毎回／恒久失敗は1日1回」に切替。
          highsTriedAt: withHighs ? today() : (prev.highsTriedAt ?? null),
          // 連続失敗回数（成功で0にリセット）。一時的失敗は数回で回復するので毎回リトライ、恒久失敗はこれが増える。
          // highs を投げていない通常更新（withHighs=false）では判定材料が無いので据え置く。
          highsFail: withHighs ? (q.high5y != null ? 0 : (prev.highsFail || 0) + 1) : (prev.highsFail ?? 0),
          low1y: q.low1y != null ? q.low1y : (prev.low1y ?? null),
          low3y: q.low3y != null ? q.low3y : (prev.low3y ?? null),
          low1yDate: q.low1yDate != null ? q.low1yDate : (prev.low1yDate ?? null),
          low3yDate: q.low3yDate != null ? q.low3yDate : (prev.low3yDate ?? null),
          volume: q.volume != null ? q.volume : (prev.volume ?? null), // 当日出来高（売買代金算出用・未取得時は前回値を保持）
          fetchedAt: q.fetchedAt,
        };
        if (sec.market === 'US' && q.source) { if (/finnhub/.test(q.source)) usFinn++; else usYah++; }
      }
    }
    // ソース表示は「最初の1銘柄」ではなく米株全体の多数決にする（先頭銘柄がFinnhub非対応/レート制限で
    // フォールバックすると、全体がFinnhubでも『Yahoo』表示になり誤解を生んでいた）。内訳も保存しツールチップに出す。
    if (usFinn || usYah) {
      store.data.lastPriceSource = usFinn >= usYah ? 'finnhub' : 'yahoo';
      store.data.lastPriceSrcCounts = { finnhub: usFinn, yahoo: usYah };
    }
    if (withHighs) store.data.lastHighsDate = today(); // 高値はこの取得で最新化
    const fx = lightQuotes['USDJPY=X'];
    if (fx && fx.price != null) store.data.fx.USDJPY = fx.price;
    store.data.indices = store.data.indices || {};
    for (const ix of INDICES) {
      const q = lightQuotes[ix.sym];
      if (q && !q.error && q.price != null) store.data.indices[ix.key] = { price: q.price, prevClose: q.prevClose, fetchedAt: q.fetchedAt };
    }
    store.data.lastPriceUpdate = new Date().toISOString();
    store.save();
    // 前日終値を取得（light=range=5d を取引所TZの今日基準で選別＝プレ前/休場/日中の市場日替わりでも常に正しい）。
    // ガードは「最後の取得から5分以上経過 or ロジック版更新」のみ＝時間スロットル。
    // 旧・日付キー方式(JST暦日/ET暦日)は端末時刻やセッション状態のエッジで再取得を取りこぼし、
    // 前日終値が前々日のまま固定される不具合が出た（API側の選別は正しいのにフロントが取り直さない）。
    // 価格更新は手動主体で頻度が低いため、毎回近い頻度で取り直しても負荷は小さく、常に最新で確実。
    const lastPC = store.data.lastPrevCloseAt ? Date.parse(store.data.lastPrevCloseAt) : 0;
    if (!(Date.now() - lastPC < 5 * 60 * 1000) || store.data.prevCloseVer !== PREVCLOSE_VER) {
      try { await this.refreshPrevCloses(allSecs); store.data.lastPrevCloseAt = new Date().toISOString(); store.data.prevCloseVer = PREVCLOSE_VER; store.save(); } catch (_) {}
    }
    // 米株の時間外(プレ/アフター)を別取得＝時間外列に表示。レギュラー/閉場中は時間外をクリア（当日レギュラー取得でNULL）。
    await this.refreshExtended(allSecs);
    // 高値(5年/52週)が「今日まだ取得成功していない」銘柄を補完取得する（withHighs の成否に関わらず常時）。
    // ・未取得の新規/取込銘柄（highsAt が無い＝欠け）
    // ・その日の日次高値取得が失敗して古い高値のまま固定された銘柄（highsAt が過去日）
    // どちらも highsAt !== today() で拾える。成功済み（highsAt===today）は skip＝毎回の再取得はしない。
    // 全体フラグ(lastHighsDate)は失敗でも立つため使わず、銘柄ごとの成功日(prices[k].highsAt)で判定する。
    // ※ secs ではなく allSecs で判定（現在値取得済みで今回対象外の銘柄も高値だけ古いことがあるため）。
    // ★恒久的に高値を取れない銘柄（Yahooが5年チャートを返せないティッカー）は highsAt が永久に古いため、
    //   従来は毎回の価格更新で毎回リトライされていた（「5年高値を取得中… 1/1件」が毎回）。連続失敗回数 highsFail で切替:
    //   ・失敗が浅いうち（<HIGHS_FAIL_BACKOFF回）は毎回リトライ＝一時的失敗を当日中に素早く回復・新規銘柄も即取得
    //   ・それを超えたら恒久失敗とみなし highsTriedAt を見て1日1回だけ試す（翌日再試行＝ティッカー復活で拾える）
    const HIGHS_FAIL_BACKOFF = 3;
    {
      const staleHigh = allSecs.filter(s => {
        const p = store.data.prices[priceKey(s)] || {};
        if (p.highsAt === today()) return false;                    // 今日取得成功済みは対象外
        if ((p.highsFail || 0) < HIGHS_FAIL_BACKOFF) return true;    // 失敗が浅い/新規＝毎回リトライ
        return p.highsTriedAt !== today();                          // 恒久失敗は1日1回に抑制
      });
      // highs=1 は5年日足も取るためサブリクエストが重い。10件ずつに分割して上限内に収める
      for (let i = 0; i < staleHigh.length; i += 10) { busyMsg(`5年高値を取得中… ${Math.min(i + 10, staleHigh.length)}/${staleHigh.length}件`); try { await this.refreshPrice(staleHigh.slice(i, i + 10)); } catch (_) {} }
    }
    // 名前未取得の銘柄だけ銘柄情報を取得（refreshMeta が「銘柄情報を取得中… n/m件」を表示）
    const need = secs.filter(s => !(store.data.meta[priceKey(s)] && store.data.meta[priceKey(s)].name));
    if (need.length) await this.refreshMeta(need);
    // 決算日（前回/次回）を1日1回取得（銘柄ごとの成功日 earnings[k].at で判定＝高値と同方式）。
    // 場中（日本株ザラ場・米国レギュラー）と各市場の寄り30分前は、株価を早く見たいのでスキップし場外の更新で取得する。
    // ★await しない＝バックグラウンド実行。取得に時間がかかっても busy オーバーレイを閉じて操作可能にし、
    //   進捗はトップバー下の細いバーに表示する（earnProgress）。完了時に表示へ反映。
    if (!earnSkipNow()) this.refreshEarningsBg(allSecs);
    // ランキング順位バッジは「株価更新時だけ」取得（タブ表示のたびの取得をやめ、保有銘柄タブの引っかかりを解消）。
    // 1日1回のキャッシュを尊重（force無し）。取得後にバッジだけ反映するため再描画。
    busyMsg('ランキング順位を取得中…');
    toast('価格を更新しました');
    loadRankBadges().then(() => { if (_rankTop) preserveTableScroll(render); });
  },

  // 決算日取得のバックグラウンド実行ラッパー。busy オーバーレイでは待たせず（＝操作可能なまま）、
  // 進捗はトップバー下の細いバー（earnProgress）に表示する。多重起動は抑止（実行中なら何もしない）。
  // 取得できた銘柄があれば完了時に一覧へ反映（インライン編集中はユーザーの編集内容を壊すため再描画しない）。
  async refreshEarningsBg(allSecs) {
    if (this._earnBgRunning) return;
    this._earnBgRunning = true;
    try {
      const updated = await this.refreshEarnings(allSecs);
      if (updated > 0 && !inlineEditOn) preserveTableScroll(render);
    } catch (_) { /* 取得失敗は無視（次回の株価更新で再試行される） */ }
    finally { this._earnBgRunning = false; earnProgressHide(); }
  },

  // 決算日（前回/次回）を /api/earnings で取得し store.data.earnings にキャッシュ。取得できた銘柄数を返す。
  // 銘柄ごとの取得成功日 at で「その日1回だけ」に抑制（高値の highsAt と同方式）。Yahoo形式(JP=code.T)で問い合わせ。
  async refreshEarnings(allSecs) {
    // ETF・投信は決算が無いので対象外（詳細種別の手動指定＋自動判定）。従来はETFにも毎回問い合わせ→
    // 常にデータ無し→「未取得」のまま永遠に再試行され、株価更新のたびに「決算日を取得中…N件」が出続けていた。
    const secs = (allSecs || store.data.securities).filter(s => s.ticker && (s.market === 'JP' || s.market === 'US') && detailTypeOf(s) !== 'ETF');
    const td = today();
    // 今日成功済み(at===td)はスキップ。データ無し/失敗だった銘柄(tryAt)は60分間隔でだけ再試行する
    // （ソース側の同時アクセス制限からの当日回復は許しつつ、株価更新のたびの全件リトライをやめる）
    // さらに、取得済みの銘柄は「次回決算までの距離」で再取得間隔を空ける（earnRefetchInterval）。
    // 決算が1ヶ月以上先の銘柄を毎日取り直すのは無駄で、場外の株価更新を無駄に長くしていた。
    const stale = secs.filter(s => {
      const e = store.data.earnings[priceKey(s)] || {};
      if (e.at === td) return false;
      if (e.tryAt && Date.now() - Date.parse(e.tryAt) < 3600000) return false;
      if (e.at) { const gap = _diffDays(e.at, td); if (gap !== null && gap < earnRefetchInterval(s)) return false; }
      return true;
    });
    if (!stale.length) return 0;
    const symOf = (s) => s.market === 'JP' ? `${s.ticker}.T` : String(s.ticker).toUpperCase();
    const keyBySym = new Map(stale.map(s => [symOf(s), priceKey(s)]));
    let updatedCount = 0;
    // US=最大4サブリクエスト/銘柄。Cloudflareのサブリクエスト上限を避け8件ずつ
    earnProgress(0, stale.length);
    for (let i = 0; i < stale.length; i += 8) {
      const batch = stale.slice(i, i + 8);
      const q = batch.map(symOf).join(',');
      let res = null;
      try { res = await fetch(`/api/earnings?symbols=${encodeURIComponent(q)}`).then(r => r.ok ? r.json() : null); } catch (_) { res = null; }
      const gotAt = new Set();
      if (res) {
        for (const [sym, d] of Object.entries(res)) {
          const k = keyBySym.get(sym); if (!k) continue;
          // 前回も次回も無し＝データ無し or ソース側ブロック → 成功扱いにしない（既存値は消さない）
          if (!d.prev && !d.next) continue;
          // 部分取得（片方だけ返る）で既存の良い値を潰さないようにマージする。
          //  ・next: 新しい値が無ければ既存を残す（Yahooは発表と同時に予定日を消すため、過ぎた予定日も
          //    「発表済み（見込み）」の根拠として earnInfo が使う。45日で自動的に無視される）
          //  ・prev/prev2: 新しい prev が既存より新しい時だけ組で入れ替える（古い prev で巻き戻さない）
          const cur = store.data.earnings[k] || {};
          const useNewPrev = !cur.prev || (d.prev && d.prev > cur.prev);
          store.data.earnings[k] = {
            next: d.next || cur.next || null,
            nextEstimate: d.next ? !!d.nextEstimate : !!cur.nextEstimate,
            exDiv: d.exDiv || cur.exDiv || null,
            prev: useNewPrev ? (d.prev || null) : cur.prev,
            prev2: useNewPrev ? (d.prev2 || null) : (cur.prev2 || null),
            at: td,
          };
          gotAt.add(k);
        }
      }
      // 取れなかった銘柄は試行時刻(tryAt)だけ記録し、60分間は再試行しない（既存値は保持）
      const nowIso = new Date().toISOString();
      for (const s of batch) { const k = priceKey(s); if (!gotAt.has(k)) store.data.earnings[k] = { ...(store.data.earnings[k] || {}), tryAt: nowIso }; }
      updatedCount += gotAt.size;
      earnProgress(Math.min(i + 8, stale.length), stale.length);
    }
    store.save();
    return updatedCount;
  },

  // 米株のプレ/アフター価格を「時間外」列(prices.extPrice/extType)に保存。
  // レギュラー時間中はクリア（当日レギュラーを取得＝時間外は無効）。アフター終了後〜翌プレ前は当日アフター終値を保持・表示。
  // 取得は: プレ/アフター中はライブ更新、ギャップ(アフター後)は当日アフター終値が未取得の銘柄だけ（次プレまで再取得しない）。
  async refreshExtended(allSecs) {
    const usSecs = (allSecs || store.data.securities).filter(s => s.market === 'US' && s.ticker);
    if (!usSecs.length) return;
    if (usRegularOpen()) { // レギュラー中 → 時間外クリア
      let changed = false;
      for (const s of usSecs) { const p = store.data.prices[priceKey(s)]; if (p && (p.extPrice != null || p.extType)) { p.extPrice = null; p.extType = null; p.extDate = null; changed = true; } }
      if (changed) store.save();
      return;
    }
    const phase = usExtPhase(); // 'pre' | 'post' | null（=アフター後ギャップ）
    const need = usSecs.filter(s => {
      if (phase) return true; // プレ/アフター中はライブ更新
      const p = store.data.prices[priceKey(s)] || {}; // ギャップ: 当日アフター終値を未取得なら取りに行く
      return !(p.extDate === today() && p.extType === 'post');
    });
    if (!need.length) return; // 既に当日アフター終値あり → 次のプレまで取得しない
    const syms = need.map(yahooSymbol);
    const BATCH = 20;
    const batches = [];
    for (let i = 0; i < syms.length; i += BATCH) batches.push(syms.slice(i, i + BATCH));
    let quotes = {};
    try {
      const results = await Promise.all(batches.map(b => fetch(`/api/price?ext=1&symbols=${encodeURIComponent(b.join(','))}`).then(r => r.ok ? r.json() : {}).catch(() => ({}))));
      quotes = Object.assign({}, ...results);
    } catch (_) { return; }
    for (const s of need) {
      const q = quotes[yahooSymbol(s)]; const p = store.data.prices[priceKey(s)];
      if (!p || !q || q.error) continue;
      p.extPrice = q.extPrice != null ? q.extPrice : null;
      p.extType = q.extType || null;
      p.extDate = q.extPrice != null ? today() : null; // 当日の時間外値を保持した印
    }
    store.save();
  },

  // 前日終値を信頼できる方法で取得してキャッシュ（1日1回でよい）。
  // mode=light（range=1d）で取得し、API側は meta.chartPreviousClose（Yahoo がサーバ側で算出する
  // 「本当の前営業日終値」）を前日終値に使う。これが最も堅牢。
  // ※以前は range=5d で日足配列から「今日より前の最後の有効終値」を選んでいたが、Yahoo が昨日の日足を
  //   null 欠損させると一昨日を前日終値と誤認し、変動率が壊れた（実例: IBM 07-14がnull→07-13の290.23を
  //   前日終値にして-24%表示。正は chartPreviousClose=217.07で約+1%。PGRも同様に-10.9%と過大表示）。
  //   chartPreviousClose は日足の歯抜けに影響されず、休場・プレ前でも前営業日を正しく指す。
  // 引け日(prevCloseDate)は range=1d では配列から取れないため prevBizDate() の近似を使う（値は正、日付は表示注記のみ）。
  async refreshPrevCloses(secs) {
    secs = (secs || []).filter(s => s && s.ticker);
    if (!secs.length) return;
    const pd = prevBizDate(); // 引け日は近似（range=1d は日足配列を持たないため）
    const syms = [...new Set(secs.map(yahooSymbol))];
    const BATCH = 40;
    const batches = [];
    for (let i = 0; i < syms.length; i += BATCH) batches.push(syms.slice(i, i + BATCH));
    let quotes = {};
    try {
      const results = await Promise.all(batches.map(b =>
        fetch(`/api/price?mode=light&symbols=${encodeURIComponent(b.join(','))}`).then(r => r.ok ? r.json() : {}).catch(() => ({}))));
      quotes = Object.assign({}, ...results);
    } catch (_) { return; }
    for (const sec of secs) {
      const q = quotes[yahooSymbol(sec)];
      if (!q || q.error || q.prevClose == null) continue; // 取れない時は既存値を保持（壊さない）
      const key = priceKey(sec);
      const p = store.data.prices[key] || (store.data.prices[key] = {});
      p.prevClose = q.prevClose;
      p.prevCloseDate = q.prevCloseDate || pd; // APIの実引け日を優先（休場反映）。無ければ近似
    }
    store.save();
  },

  // 指定銘柄だけ価格（＋5年/52週高値）を取得して保存。新規追加銘柄（保有/ウォッチ問わず）の即時反映用。
  // refreshAll は全銘柄＋指数を取り日次更新後の新規追加では走らないため、ピンポイント取得を用意。
  async refreshPrice(secs) {
    secs = (secs || []).filter(s => s && s.ticker);
    if (secs.length === 0) return;
    const symbols = [...new Set(secs.map(yahooSymbol))];
    let res;
    try {
      // 新規追加銘柄は高値も必要なので highs=1（少数なのでサブリクエスト上限は問題なし）
      res = await fetch(`/api/price?highs=1&symbols=${encodeURIComponent(symbols.join(','))}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch (e) { return; }
    const quotes = await res.json();
    for (const sec of secs) {
      const q = quotes[yahooSymbol(sec)];
      if (q && !q.error && q.price != null) {
        const prev = store.data.prices[priceKey(sec)] || {};
        store.data.prices[priceKey(sec)] = {
          price: q.price,
          // 前日終値は highs=1 の値(Finnhub pc/Yahoo長期配列)を使わず、下の refreshPrevCloses で確定する。
          prevClose: prev.prevClose ?? null, prevCloseDate: prev.prevCloseDate ?? null,
          // 高値・安値は取れた時だけ更新。null で既存の正しい高値を潰さない（取得失敗時に基準値が壊れる）。
          high5y: q.high5y != null ? q.high5y : (prev.high5y ?? null),
          high52w: q.high52w != null ? q.high52w : (prev.high52w ?? null),
          high5yDate: q.high5yDate ?? prev.high5yDate ?? null, high52wDate: q.high52wDate ?? prev.high52wDate ?? null, // 高値が付いた日（高値更新判定用）
          low1y: q.low1y != null ? q.low1y : (prev.low1y ?? null), low3y: q.low3y != null ? q.low3y : (prev.low3y ?? null),
          low1yDate: q.low1yDate ?? prev.low1yDate ?? null, low3yDate: q.low3yDate ?? prev.low3yDate ?? null, // 安値が付いた日（情報表示用）
          highsAt: q.high5y != null ? today() : (prev.highsAt ?? null), // 高値取得の成功日（銘柄単位）
          highsTriedAt: today(), // 高値取得を試みた日（この経路は常に highs=1）。成否問わず更新
          highsFail: q.high5y != null ? 0 : (prev.highsFail || 0) + 1, // 連続失敗回数（成功で0）。恒久失敗の毎回リトライ抑制に使う
          volume: q.volume != null ? q.volume : (prev.volume ?? null), // 当日出来高（売買代金算出用）
          fetchedAt: q.fetchedAt,
        };
      }
    }
    store.save();
    // 前日終値を信頼できる light(range=1d) で確定（新規追加銘柄の即時反映）
    try { await this.refreshPrevCloses(secs); } catch (_) {}
  },

  // 銘柄情報マスタを取得して store.data.meta にキャッシュ。
  // 1銘柄=最大4サブリクエスト(日本語名/chart/quoteSummary/Finnhub)のため、全銘柄を1リクエストに
  // まとめると Cloudflareのサブリクエスト上限(約50)やFinnhubレート制限を超え、後半（特に時価総額）が
  // 取りこぼされる。→ 小分けバッチ(8銘柄)で順次取得する。
  async refreshMeta(secs) {
    // 引数なし（日次/全体更新）では投信を除外。投信名はコードマスタの「名称取得」で個別に取得する
    secs = secs || store.data.securities.filter(s => s.ticker && s.market !== 'FUND');
    if (secs.length === 0) return;
    const symbols = [...new Set(secs.map(yahooSymbol))];
    const CHUNK = 8;
    const infos = {};
    const bm = document.getElementById('busy-msg');
    const ov = document.getElementById('busy-overlay');
    for (let i = 0; i < symbols.length; i += CHUNK) {
      const part = symbols.slice(i, i + CHUNK);
      if (bm && ov && !ov.hidden) bm.textContent = `銘柄情報を更新中… ${Math.min(i + CHUNK, symbols.length)}/${symbols.length}`;
      try {
        const res = await fetch(`/api/info?symbols=${encodeURIComponent(part.join(','))}`);
        if (res.ok) Object.assign(infos, await res.json());
      } catch (_) { /* この塊は失敗→次の塊へ（部分取得を許容） */ }
    }
    try {
      for (const sec of secs) {
        const d = infos[yahooSymbol(sec)];
        if (d && !d.error) {
          const key = priceKey(sec);
          const ex = store.data.meta[key] || {};
          const inc = clean(d);
          // 日本語名は英語フォールバックで上書きしない（取得のたびに名称がブレないように）
          if (inc.name && ex.name && hasJa(ex.name) && !hasJa(inc.name)) delete inc.name;
          // 取得内容が空（名称もファンダも取れず）なら meta を書かない。updatedAt だけ進めると
          // マルチ端末同期（meta は updatedAt の新しい方が勝つ）で「空の新しいエントリ」が
          // 別端末の正しい名称を上書きしてしまう（＝銘柄名が証券コードに戻る）ため。
          if (!Object.keys(inc).length) continue;
          store.data.meta[key] = { ...ex, ...inc, updatedAt: store._now() };
        }
      }
      store.save();
    } catch (_) { /* 保存失敗は無視（手入力可） */ }
  },

  // 会社概要（株探の「会社情報→概要」）を銘柄マスタ(meta.summary)にキャッシュ。
  // 概要は年単位でしか変わらないので **未取得の銘柄だけ** 取りに行く（1銘柄=1リクエスト・以後0回）。
  // force=true（「銘柄情報を更新」＝洗い替え）のときだけ全銘柄を取り直す。
  async refreshCompany(allSecs, opts = {}) {
    const force = !!opts.force;
    const secs = (allSecs || store.data.securities)
      .filter(s => s.ticker && (s.market === 'JP' || s.market === 'US'))
      .filter(s => force || !((store.data.meta[priceKey(s)] || {}).summary));
    if (!secs.length) return;
    const CHUNK = 8; // 1銘柄=1サブリクエスト。Cloudflareのサブリクエスト上限に余裕を持たせる
    for (let i = 0; i < secs.length; i += CHUNK) {
      const part = secs.slice(i, i + CHUNK);
      busyMsg(`会社概要を取得中… ${Math.min(i + CHUNK, secs.length)}/${secs.length}件`);
      const q = part.map(yahooSymbol).join(',');
      let res = null;
      try { res = await fetch(`/api/company?symbols=${encodeURIComponent(q)}`).then(r => r.ok ? r.json() : null); } catch (_) { res = null; }
      if (!res) continue;
      for (const s of part) {
        const d = res[yahooSymbol(s)];
        if (!d || !d.summary) continue;            // 取れなかった銘柄は既存値を消さない（次回また試す）
        const key = priceKey(s);
        const ex = store.data.meta[key] || {};
        if (ex.summary === d.summary) continue;    // 変化なしなら updatedAt を進めない（同期の無駄な競合を避ける）
        store.data.meta[key] = { ...ex, summary: d.summary, summaryAt: today(), updatedAt: store._now() };
      }
    }
    store.save();
  },

  // 起動時の日次更新: 1日1回だけ 銘柄名/セクター/業種/高値 をまとめて更新（名称変更や高値の日次反映用）
  async dailyStartup() {
    if (store.data.securities.every(s => !s.ticker)) return;
    if (store.data.lastInfoDate === today()) return; // 本日実行済み
    store.data.lastInfoDate = today(); store.save();
    await this.refreshAll({ withHighs: true }); // 日次は高値（52週/5年）も取得。価格＋名前未取得分
    await this.refreshMeta();             // 全銘柄の名前/セクター/業種/ファンダを日次更新（日本語名は維持）
    try { await this.refreshCompany(); } catch (_) {}  // 会社概要は未取得の銘柄だけ（既に持っていれば0リクエスト）
    await this.checkSplits();             // 分割検知（承認待ちは「分割」タブのバッジで通知）
    render();
  },

  // 株式分割・併合を検知。過去（今日より前）の新規分割は履歴に記録のみ、当日以降は承認待ちで返す
  async checkSplits() {
    const secs = store.data.securities.filter(s => s.ticker && s.market !== 'FUND');
    if (!secs.length) return [];
    const symbols = [...new Set(secs.map(yahooSymbol))];
    // splits.js は 1シンボル=1 Yahoo fetch のため、全銘柄を1リクエストにまとめると
    // Cloudflare の1リクエストあたりサブリクエスト上限(~50)を超えて全件失敗する（SEC-203）。
    // refreshPrice/refreshMeta と同様に 15件ずつチャンク分割し、部分失敗は次チャンクへ。
    const CHUNK = 15;
    const data = {};
    for (let i = 0; i < symbols.length; i += CHUNK) {
      const part = symbols.slice(i, i + CHUNK);
      try {
        const res = await fetch(`/api/splits?symbols=${encodeURIComponent(part.join(','))}`);
        if (res.ok) Object.assign(data, await res.json());
      } catch (_) { /* このチャンクは諦めて次へ */ }
    }
    const td = today(); const now = new Date().toISOString(); const pending = [];
    for (const sec of secs) {
      const info = data[yahooSymbol(sec)];
      if (!info || info.error || !Array.isArray(info.splits)) continue;
      sec.splitHistory ||= [];
      const known = new Set(sec.splitHistory.map(h => h.date));
      for (const sp of info.splits) {
        if (known.has(sp.date)) continue;
        if (sp.date < td) {
          // 過去: 記録のみ（承認・調整なし＝既に反映済みとみなす）
          sec.splitHistory.push({ date: sp.date, ratio: sp.ratio, label: sp.label, status: 'recorded', recordedAt: now });
        } else {
          // 当日以降: 承認待ち
          sec.splitHistory.push({ date: sp.date, ratio: sp.ratio, label: sp.label, status: 'pending', recordedAt: now });
          pending.push({ secId: sec.id, date: sp.date, ratio: sp.ratio, label: sp.label });
        }
      }
    }
    store.save();
    return pending;
  },
};
function hasJa(s) { return /[^\x00-\x7F]/.test(String(s || '')); }
// null/空を除いたオブジェクトを返す（既存マスタ値を上書きしないため）
function clean(o) {
  const r = {};
  for (const k in o) if (o[k] != null && o[k] !== '') r[k] = o[k];
  return r;
}

// ---------- ルーター/描画 ----------
const app = document.getElementById('app');
let currentView = 'dashboard';
// 保有銘柄タブ内の市場（US/JP 切替）。列設定は市場ごとに保持される
let holdingsMarket = 'US';
// ダッシュボードの値動きTopの市場フィルタ
let dashMoverMarket = 'ALL';
function setDashMoverMarket(m) { dashMoverMarket = m; renderDashboard(); }
// 一覧のコード/銘柄名フリーワード検索
let holdingsSearch = '';
// IME変換中フラグ。変換確定前は再描画しない（変換が中断され文字が末尾にしか入らない問題の対策・SEC-112）
window._imeComposing = false;
function setHoldingsSearch(v) {
  const el0 = document.getElementById('hold-search');
  const caret = el0 ? el0.selectionStart : v.length; // 実カーソル位置を保持（末尾固定にしない）
  holdingsSearch = v;
  if (window._imeComposing) return; // 変換中は再描画せず、compositionend で反映
  renderMarket(holdingsMarket);
  const el = document.getElementById('hold-search');
  if (el) { el.focus(); const p = Math.min(caret, el.value.length); el.setSelectionRange(p, p); }
}

// ---------- サイドナビ（リデザイン） ----------
const NAV_GROUPS = [
  { group: 'メイン', items: [
    { id: 'dashboard', label: 'ダッシュボード', icon: 'dashboard' },
    { id: 'market',    label: 'マーケット',     icon: 'podium' },
    { id: 'macro',     label: 'マクロ指標',     icon: 'gauge', badge: 'new:macro' },
    { id: 'news',      label: 'ニュース',       icon: 'news', badge: 'new:video' },
    { id: 'holdings',  label: '保有銘柄',       icon: 'holdings' },
    { id: 'trade',     label: '銘柄カルテ',     icon: 'trade' },
    { id: 'signals',   label: '買い増しサイン', icon: 'signal', badge: 'sig' },
    { id: 'analysis',  label: '分析',           icon: 'search' },
    { id: 'report',    label: 'レポート',       icon: 'report' },
  ] },
  { group: 'データ', items: [
    { id: 'import',    label: '取込',           icon: 'upload' },
    { id: 'secmaster', label: '銘柄マスタ',     icon: 'master' },
    { id: 'splits',    label: '株式分割',       icon: 'splits', badge: 'split' },
    { id: 'transfer',  label: '転記用',         icon: 'transfer' },
  ] },
  { group: '設定', items: [
    { id: 'master',    label: 'マスタ・設定',   icon: 'settings' },
  ] },
];
const PAGE_TITLE = {
  dashboard: 'ダッシュボード', market: 'マーケット', holdings: '保有銘柄', signals: '買い増しサイン',
  report: 'レポート', import: '取込', secmaster: '銘柄マスタ', splits: '株式分割', trade: '銘柄カルテ',
  transfer: '転記用', master: 'マスタ・設定', us: '米国株', jp: '日本株', analysis: '分析（チャートパターン）',
  news: 'ニュース', macro: 'マクロ指標',
};
const ICON_PATHS = {
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  holdings: 'M3 5h18M3 12h18M3 19h18',
  signal: 'M3 17l6-6 4 4 8-8M21 7v5h-5',
  report: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  master: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  splits: 'M6 3v6a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v6M18 3v6a3 3 0 0 1-3 3H9a3 3 0 0 0-3 3v6',
  transfer: 'M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 6.6 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H2a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 3.6 6.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3 1.6 1.6 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8 1.6 1.6 0 0 0 1.5 1H22a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  dense: 'M3 5h18M3 9h18M3 13h18M3 17h18M3 21h18',
  loose: 'M3 5h18M3 12h18M3 19h18',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  columns: 'M3 3h18v18H3zM12 3v18M3 9h18',
  filter: 'M3 4h18l-7 8v6l-4 2v-8z',
  copy: 'M9 9h11v11H9zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  trade: 'M7 10 3 6l4-4M3 6h12a4 4 0 0 1 4 4M17 14l4 4-4 4M21 18H9a4 4 0 0 1-4-4',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  news: 'M4 4h13v16H6a2 2 0 0 1-2-2zM17 8h3v10a2 2 0 0 1-2 2M8 8h5M8 12h5M8 16h5',
  // マクロ指標＝メーター（景気の温度計）。買い増しサイン(signal)と同じ折れ線アイコンだったので変更
  gauge: 'M3 19a9 9 0 1 1 18 0M12 19l4.5-5.5M12 19h.01',
  // マーケット＝ランキングの表彰台。レポート(report)と同じ棒グラフアイコンだったので変更
  podium: 'M3 21h18M9 21v-8h6v8M9 13H4v8M20 21v-5h-5M12 3l1.3 2.7 3 .4-2.2 2.1.5 3-2.6-1.4-2.6 1.4.5-3L7.7 6.1l3-.4z',
};
// SVGアイコン生成。クラス省略時はナビ用(nav-ico)
function svgIcon(name, cls = 'nav-ico') {
  const d = ICON_PATHS[name] || '';
  const paths = d.split('M').filter(Boolean).map(seg => `<path d="M${seg}"/>`).join('');
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
function navIcon(name) { return svgIcon(name, 'nav-ico'); }
function renderNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const active = (id) => (id === currentView || (id === 'holdings' && (currentView === 'us' || currentView === 'jp')));
  const ready = !!(typeof store !== 'undefined' && store && store.data);
  const sig = (ready && typeof allSignals === 'function') ? allSignals().length : 0;
  const split = (ready && typeof pendingSplits === 'function') ? pendingSplits().length : 0;
  const badgeVal = (b) => b === 'sig' ? sig : b === 'split' ? split : 0;
  // 'new:種別' は件数ではなく「NEW」を出す（経済指標の更新・YouTube動画の新着）
  const newBadge = (b) => (ready && typeof updUnseenCount === 'function' && b.startsWith('new:')) ? updUnseenCount(b.slice(4)) : 0;
  nav.innerHTML = navOrderedGroups().map(grp => `
    <div class="nav-group">
      <div class="nav-label">${grp.group}</div>
      ${grp.items.map(it => {
        const isNew = !!(it.badge && it.badge.startsWith('new:'));
        const bv = it.badge ? (isNew ? newBadge(it.badge) : badgeVal(it.badge)) : 0;
        const badge = (it.badge && bv > 0)
          ? (isNew ? `<span class="nav-badge nav-new" title="${bv}件の新着">NEW</span>`
                   : `<span class="nav-badge ${it.badge === 'split' ? 'amber' : ''}">${bv}</span>`)
          : '';
        return `<button class="nav-item ${active(it.id) ? 'active' : ''}" data-view="${it.id}">${navIcon(it.icon)}<span class="lbl">${it.label}</span>${badge}</button>`;
      }).join('')}
    </div>`).join('');
  nav.querySelectorAll('.nav-item').forEach(b => b.onclick = () => go(b.dataset.view));
}

// ダッシュボードの「更新情報」一覧の高さを残りスペースに合わせる。
// ダッシュボードは元々ちょうど収まっていた（実測: 余り5px）ので、12件そのまま出すと
// 310px ぶんページが溢れる。空きがあれば広げ、足りなければ縮めて枠内スクロールにする（ルール6）。
function fitUpdList() {
  // ★ID指定。マクロ警告カードも .upd-list を使うので、クラスだけで探すとそちらを縮めてしまい
  //   更新情報が縮まない（実測: ダッシュボードが305pxはみ出した）。
  const el = document.getElementById('upd-feed-list');
  if (!el) return;
  const main = document.querySelector('main.content');
  if (!main) return;
  el.style.maxHeight = '';
  const natural = el.scrollHeight;             // 中身そのままの高さ
  let h = Math.min(natural, 300);              // 出しても300pxまで
  el.style.maxHeight = h + 'px';
  const overflow = main.scrollHeight - main.clientHeight;
  if (overflow > 1) {
    // 縮める下限は84px（約2行）。ただし**自然高さを超えて広げない**こと。
    // 単純に Math.max(120, ...) にすると、更新情報が0件で自然高さ40pxの時に120pxへ膨らみ、
    // 空の枠が無駄に場所を取る（実測: 0件なのにセクション225px）。
    h = Math.max(Math.min(84, natural), h - overflow);   // 下限は約2行。3行固定にするとダッシュボードが収まらない
  }
  el.style.maxHeight = h + 'px';
}

// 一覧のソート/フィルタ・カラム設定（市場ごと）。デフォルトはティッカー順
const listState = {
  US:     { sortKey: 'ticker', sortDir: 1, broker: '', account: '', category: '', detailType: '' },
  JP:     { sortKey: 'ticker', sortDir: 1, broker: '', account: '', category: '', detailType: '' },
  FUND:   { sortKey: 'ticker', sortDir: 1, broker: '', account: '', category: '', detailType: '' },
  SIGNAL: { sortKey: 'drop',   sortDir: 1, broker: '', account: '', category: '', detailType: '' },
  ANALYSIS:   { sortKey: 'anaContra', sortDir: -1, broker: '', account: '', category: '', detailType: '' },
  ANALYSIS_T: { sortKey: 'anaTrend',  sortDir: -1, broker: '', account: '', category: '', detailType: '' },
  MKTRANK:    { sortKey: 'rank',      sortDir: 1,  broker: '', account: '', category: '', detailType: '' }, // マーケットランキングタブの列設定・ソート
};
// カラム設定: 市場ごとに [{key, visible}] の配列
let colPrefs = {};
function loadColPrefs() {
  try { colPrefs = JSON.parse(localStorage.getItem(COL_PREFS_KEY)) || {}; } catch(_) { colPrefs = {}; }
}
function saveColPrefs() { localStorage.setItem(COL_PREFS_KEY, JSON.stringify(colPrefs)); }
// ユーザーが実際に列を編集した時だけ呼ぶ。市場ごとの編集時刻(_ts)を更新し、同期マージで「最新の編集が勝つ」
// 判定に使う。reconcile/reset（画面表示に伴う受動的な補完）では呼ばない＝別端末の本物の編集を上書きしない。
function touchColPrefs(market) {
  if (!colPrefs._ts || typeof colPrefs._ts !== 'object') colPrefs._ts = {};
  colPrefs._ts[market] = new Date().toISOString();
  saveColPrefs();
}
// バックアップ/同期用の“全状態”バンドル。store.data に加え列設定(colPrefs)も同梱（_colPrefs）
function dataBundle() { return Object.assign({}, store.data, { _colPrefs: colPrefs, _filterPresets: fltPresets }); }
// バンドルを復元（store.data ＋ 列設定 ＋ フィルターパターン）。各 _xxx が無い旧バックアップとも互換
function restoreBundle(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('データ形式が不正です');
  const cp = obj._colPrefs; delete obj._colPrefs;
  const fp = obj._filterPresets; delete obj._filterPresets;
  store.data = obj; store.save();
  if (cp && typeof cp === 'object') { colPrefs = cp; saveColPrefs(); }
  if (Array.isArray(fp)) { fltPresets = fp; saveFilterPresets(); }
  store.load(); loadColPrefs(); loadFilterPresets();
}

// ===== 銘柄名・コードの検索正規化 =====
// 半角/全角（英数字）・ひらがな/カタカナの差を吸収して一致させる。
//  NFKC で全角英数字→半角・半角カナ→全角カナに統一 → 小文字化 → カタカナをひらがなへ寄せる。
function searchNorm(s) {
  if (s == null) return '';
  let t = String(s);
  try { t = t.normalize('NFKC'); } catch (_) {}
  t = t.toLowerCase();
  // カタカナ→ひらがな（U+30A1〜U+30F6 を 0x60 引いてひらがな域へ）
  t = t.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  return t;
}
// 銘柄がコード/銘柄名でクエリに一致するか（正規化込み）
function secMatchesQuery(sec, rawQuery) {
  const q = searchNorm(rawQuery).trim();
  if (!q) return true;
  return searchNorm(sec.ticker || '').includes(q) || searchNorm(calc.displayName(sec)).includes(q);
}

// ===== 共通列フィルター（分析 / 個別銘柄 / 銘柄マスタで共用） =====
// scope: 'holdings' | 'analysis' | 'secmaster'
// ・分析/個別銘柄のライブ状態は localStorage に保存し次回起動時に復元（銘柄マスタは保存しない）
// ・パターン（名前付きプリセット）は3タブ共通の1リスト
const FILTER_STATE_KEY = 'sm_filters_v1';
const FILTER_PRESETS_KEY = 'sm_filter_presets_v1';
// open=詳細パネルの開閉（保存しない）。presetId=ツールバーで適用中のパターン（手編集で空に戻す）。
// not={key:true}=その項目を「除外」条件として使う（選択肢＝選んだ値を除く / 数値＝範囲の外だけ残す）。
const fltState = {
  holdings:  { open: false, presetId: '', rows: [], num: {}, sel: {}, not: {} },
  analysis:  { open: false, presetId: '', rows: [], num: {}, sel: {}, not: {} },
  secmaster: { open: false, presetId: '', rows: [], num: {}, sel: {}, not: {} },
  news:      { open: false, presetId: '', rows: [], num: {}, sel: {}, not: {} }, // ニュースの銘柄フィルタ（保有銘柄と同じ機構を流用）
};
let fltPresets = []; // [{id, name, rows:[{key}], num:{key:{min,max}}, sel:{key:[vals]}, not:{key:true}}]
function loadFilterState() {
  try {
    const o = JSON.parse(localStorage.getItem(FILTER_STATE_KEY) || '{}');
    for (const sc of ['holdings', 'analysis', 'news']) {
      const s = o[sc]; if (!s || typeof s !== 'object') continue;
      fltState[sc] = { open: false, presetId: s.presetId || '', rows: Array.isArray(s.rows) ? s.rows : [], num: s.num || {}, sel: s.sel || {}, not: s.not || {} };
    }
  } catch (_) {}
}
function saveFilterState() {
  const o = {};
  for (const sc of ['holdings', 'analysis', 'news']) { const s = fltState[sc]; o[sc] = { presetId: s.presetId, rows: s.rows, num: s.num, sel: s.sel, not: s.not }; }
  try { localStorage.setItem(FILTER_STATE_KEY, JSON.stringify(o)); } catch (_) {}
}
function loadFilterPresets() { try { fltPresets = JSON.parse(localStorage.getItem(FILTER_PRESETS_KEY)) || []; } catch (_) { fltPresets = []; } }
function saveFilterPresets() { try { localStorage.setItem(FILTER_PRESETS_KEY, JSON.stringify(fltPresets)); } catch (_) {} }

// 選択肢フィルタの仕様（カテゴリカルな列）。opts=[[値,表示],…], val=銘柄→値。数値列なら null。
function fltSelectSpec(key) {
  const distinct = (getter, sort) => { const set = new Set(); for (const s of store.data.securities) { if (s.market !== 'US' && s.market !== 'JP') continue; const v = getter(s); if (v != null && v !== '') set.add(v); } const arr = [...set]; arr.sort(sort || ((a, b) => String(a).localeCompare(String(b), 'ja'))); return arr.map(v => [v, v]); };
  switch (key) {
    case 'market': return { opts: [['US', '米国株'], ['JP', '日本株']], val: s => s.market };
    case 'detailType': return { opts: [['個別株', '個別株'], ['ETF', 'ETF'], ['投資信託', '投資信託']], val: s => detailTypeOf(s) };
    case 'broker': return { opts: distinct(s => calc.lastBroker(s)), val: s => calc.lastBroker(s) || '' };
    case 'category': return { opts: distinct(s => s.category), val: s => s.category || '' };
    case 'investCategory': return { opts: distinct(s => s.investCategory), val: s => s.investCategory || '' };
    case 'labels': return { opts: [...(store.data.labelDefs || [])].sort((a, b) => a.sortOrder - b.sortOrder).map(d => [d.name, d.name]), val: s => secLabels(s), multi: true };
    case 'ruleName': return { opts: distinct(s => { const r = store.rule(s.ruleId); return r ? r.name : ''; }), val: s => { const r = store.rule(s.ruleId); return r ? r.name : ''; } };
    case 'sector': return { opts: distinct(s => calc.field(s, 'sector')), val: s => calc.field(s, 'sector') || '' };
    case 'industry': return { opts: distinct(s => calc.field(s, 'industry')), val: s => calc.field(s, 'industry') || '' };
    case 'rating': return { opts: [['S', 'S'], ['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D']], val: s => s.rating || s.overallGrade || '' };
    case 'overallGrade': return { opts: [['S', 'S'], ['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D']], val: s => s.overallGrade || '' };
    case 'buyGrade': return { opts: [['S', 'S'], ['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D']], val: s => s.buyGrade || '' };
    case 'reachKind': return { opts: [['新', '新規到達'], ['続', '継続中'], ['－', '未到達']], val: s => calc.reachKind(s) || '－' };
    case 'principalSold': return { opts: [['1', '売却済み'], ['0', '未売却']], val: s => s.principalSold ? '1' : '0' };
    case 'held': return { opts: [['1', '保有'], ['0', '未保有']], val: s => (calc.totalHolding(s.id).qty > 0 ? '1' : '0') };
    case 'anaMACD': return { opts: [['golden', 'GC'], ['dead', 'DC'], ['none', '—']], val: s => { const r = techOf(s); return r ? (r.macdCross || 'none') : ''; } };
    case 'anaStatus': return { opts: [['1', '形成中'], ['2', '完成間近'], ['3', 'ブレイク済み'], ['4', '失敗']], val: s => { const r = techOf(s); return r && r.best ? String(r.best.status) : ''; } };
    case 'anaMa200': return { opts: [['above', '上'], ['below', '下']], val: s => { const r = techOf(s); return r ? (r.ma200Pos || '') : ''; } };
    case 'ana5d': return { opts: [['1', '上'], ['0', '下']], val: s => { const r = techOf(s); return r && r.above5 != null ? (r.above5 ? '1' : '0') : ''; } };
    case 'anaDate': return { opts: [['done', '分析済み'], ['none', '未分析']], val: s => techOf(s) ? 'done' : 'none' };
    default: return null;
  }
}
// scope のフィルター対象列一覧（選択肢列＝sel / 数値列＝num）
const SECMASTER_FILTER_KEYS = ['market', 'detailType', 'sector', 'industry', 'rating', 'overallGrade', 'buyGrade', 'priority', 'ruleName', 'category'];
function filterScopeBase(scope) {
  if (scope === 'analysis') return 'ANALYSIS';
  return holdingsMarket === 'JP' ? 'JP' : holdingsMarket === 'FUND' ? 'FUND' : 'US';
}
function filterableCols(scope) {
  let keys;
  if (scope === 'secmaster') {
    keys = SECMASTER_FILTER_KEYS.map(k => { const mc = MASTER_COLS.find(c => c.key === k); return { key: k, label: mc ? mc.label : k }; });
  } else {
    // holdings / analysis / news は同じ列セット（＝保有銘柄フィルタのパターンをニュースでもそのまま適用できる）。
    // news は日米どちらの列も対象（横断）。全スコープ共通で「保有状況（保有/未保有）」も使える。
    keys = [{ key: 'held', label: '保有状況（保有/未保有）' }];
    const seen = new Set(['held']);
    for (const c of MASTER_COLS) {
      if (c.key === 'ticker' || c.key === 'name' || seen.has(c.key)) continue;
      if (scope === 'news') { if (!(c.markets.includes('JP') || c.markets.includes('US'))) continue; }
      else if (!c.markets.includes(filterScopeBase(scope))) continue;
      keys.push({ key: c.key, label: c.label }); seen.add(c.key);
    }
  }
  const sample = store.data.securities.find(s => s.market === 'US' || s.market === 'JP');
  const out = [];
  for (const { key, label } of keys) {
    const spec = fltSelectSpec(key);
    if (spec) { if (spec.opts.length) out.push({ key, label, type: 'sel' }); }
    else { const v = sample ? sortValue(sample, key) : null; if (typeof v === 'number') out.push({ key, label, type: 'num' }); }
  }
  return out;
}
// 列フィルタ適用（数値＝範囲 / 選択肢＝いずれかに一致）。scope に無効な列は無視。
// not[key]=true の項目は判定を反転＝「除外」条件（例: セクター=金融 を除く / PER 30〜50 を除く）。
// 除外では値なし・非数値の銘柄は「条件に当てはまらない＝除外されない」ので残す（絞り込みと逆の扱い）。
function applyColFilters(secs, scope) {
  const st = fltState[scope];
  const valid = new Set(filterableCols(scope).map(c => c.key));
  const nt = st.not || {};
  for (const key in st.num) {
    if (!valid.has(key)) continue;
    const { min, max } = st.num[key]; if (min == null && max == null) continue;
    const inRange = s => { const v = sortValue(s, key); if (typeof v !== 'number' || !isFinite(v)) return false; if (min != null && v < min) return false; if (max != null && v > max) return false; return true; };
    secs = nt[key] ? secs.filter(s => !inRange(s)) : secs.filter(inRange);
  }
  for (const key in st.sel) {
    if (!valid.has(key)) continue;
    const want = st.sel[key]; if (!Array.isArray(want) || !want.length) continue;
    const spec = fltSelectSpec(key); if (!spec) continue;
    const set = new Set(want.map(String));
    // 複数値（ラベル）＝いずれか一致 / 単一値＝一致
    const hit = spec.multi ? (s => (spec.val(s) || []).some(v => set.has(String(v)))) : (s => set.has(String(spec.val(s) ?? '')));
    secs = nt[key] ? secs.filter(s => !hit(s)) : secs.filter(hit);
  }
  return secs;
}
function fltActiveCount(scope) {
  const st = fltState[scope]; let n = 0;
  for (const k in st.num) { const r = st.num[k]; if (r && (r.min != null || r.max != null)) n++; }
  for (const k in st.sel) { if (Array.isArray(st.sel[k]) && st.sel[k].length) n++; }
  return n;
}
function fltRerender(scope) {
  if (scope === 'analysis') renderAnalysis();
  else if (scope === 'secmaster') renderSecMaster();
  else if (scope === 'news') renderNews();
  else render();
}
function fltPersist(scope) { if (scope === 'holdings' || scope === 'analysis' || scope === 'news') saveFilterState(); }
// 詳細パネルの開閉。全再描画（一覧の再計算）を避け、パネルDOMだけ出し入れする。
// これで開閉ラグが消える（一覧は据え置き）。想定外の構造ならフォールバックで従来どおり再描画。
function fltToggle(scope) {
  const st = fltState[scope];
  st.open = !st.open;
  const host = document.getElementById('flt-host-' + scope);
  if (!host) { fltRerender(scope); return; }
  host.innerHTML = st.open
    ? (scope === 'secmaster' ? `<div style="padding:0 16px">${filterPanelHtml(scope)}</div>` : filterPanelHtml(scope))
    : '';
  const btn = document.getElementById('flt-toggle-' + scope);
  if (btn) btn.outerHTML = fltToggleBtnHtml(scope);
  scheduleFit(); // パネル分の高さ変化に合わせて表の枠を再フィット
}
function fltAddFilter(scope, key) {
  const st = fltState[scope];
  if (!key || st.rows.some(r => r.key === key)) { fltRerender(scope); return; }
  if (!filterableCols(scope).some(c => c.key === key)) { fltRerender(scope); return; }
  st.rows.push({ key }); st.presetId = ''; fltPersist(scope); fltRerender(scope);
  const el = document.querySelector(`.afl-row[data-key="${key}"] input`);
  if (el && el.type === 'number') el.focus();
}
function fltRemoveFilter(scope, key) {
  const st = fltState[scope];
  st.rows = st.rows.filter(r => r.key !== key); delete st.num[key]; delete st.sel[key]; delete st.not[key];
  st.presetId = ''; fltPersist(scope); fltRerender(scope);
}
function fltSetNum(scope, key, which, v) {
  const st = fltState[scope]; const o = (st.num[key] = st.num[key] || {});
  const n = (v === '' || v == null) ? null : parseFloat(v); o[which] = isNaN(n) ? null : n;
  st.presetId = ''; fltPersist(scope); fltRerender(scope);
}
function fltToggleSel(scope, key, idx) {
  const spec = fltSelectSpec(key); if (!spec || !spec.opts[idx]) return;
  const st = fltState[scope]; const val = String(spec.opts[idx][0]);
  const arr = (st.sel[key] = st.sel[key] || []); const at = arr.indexOf(val);
  if (at >= 0) arr.splice(at, 1); else arr.push(val);
  st.presetId = ''; fltPersist(scope); fltRerender(scope);
}
// 項目ごとの「含む(絞り込み) ⇔ 除く(除外)」切替
function fltToggleNot(scope, key) {
  const st = fltState[scope];
  if (!st.not) st.not = {};
  if (st.not[key]) delete st.not[key]; else st.not[key] = true;
  st.presetId = ''; fltPersist(scope); fltRerender(scope);
}
function fltClear(scope) {
  const st = fltState[scope]; st.rows = []; st.num = {}; st.sel = {}; st.not = {}; st.presetId = '';
  fltPersist(scope); fltRerender(scope);
}
// パターン（プリセット）：現在の条件を名前付きで保存。3タブ共通の1リスト。
function fltSavePreset(scope) {
  const st = fltState[scope];
  if (!st.rows.length) { toast('保存する条件がありません'); return; }
  const name = (prompt('パターン名を入力してください') || '').trim();
  if (!name) return;
  const rows = st.rows.map(r => ({ key: r.key }));
  const num = {}, sel = {}, not = {};
  for (const r of st.rows) { if (st.num[r.key]) num[r.key] = { ...st.num[r.key] }; if (st.sel[r.key]) sel[r.key] = [...st.sel[r.key]]; if (st.not && st.not[r.key]) not[r.key] = true; }
  const ex = fltPresets.find(p => p.name === name);
  let pid;
  // 同名があれば内容更新＆復活（deleted解除）。updatedAt で同期マージの新しい方が勝つ。
  if (ex) { ex.rows = rows; ex.num = num; ex.sel = sel; ex.not = not; ex.deleted = false; ex.updatedAt = store._now(); pid = ex.id; }
  else { pid = 'p' + Date.now(); fltPresets.push({ id: pid, name, rows, num, sel, not, updatedAt: store._now() }); }
  fltState[scope].presetId = pid; // 保存後はそのパターンが選択中の状態に
  saveFilterPresets(); fltPersist(scope); fltRerender(scope);
  toast(`パターン「${name}」を保存しました`);
}
// パターン適用（ツールバーのセレクトから）。空＝フィルター解除。詳細パネルは自動で開かない。
function fltApplyPreset(scope, id) {
  const st = fltState[scope];
  if (!id) { st.rows = []; st.num = {}; st.sel = {}; st.not = {}; st.presetId = ''; fltPersist(scope); fltRerender(scope); return; }
  const p = fltPresets.find(x => String(x.id) === String(id)); if (!p || p.deleted) return;
  const valid = new Set(filterableCols(scope).map(c => c.key));
  st.rows = (p.rows || []).filter(r => valid.has(r.key)).map(r => ({ key: r.key }));
  st.num = {}; st.sel = {}; st.not = {};
  for (const k in (p.num || {})) if (valid.has(k)) st.num[k] = { ...p.num[k] };
  for (const k in (p.sel || {})) if (valid.has(k)) st.sel[k] = [...p.sel[k]];
  for (const k in (p.not || {})) if (valid.has(k) && p.not[k]) st.not[k] = true;
  st.presetId = String(id);
  fltPersist(scope); fltRerender(scope);
}
function fltDeletePreset(scope, id) {
  if (!id) { fltRerender(scope); return; }
  const p = fltPresets.find(x => String(x.id) === String(id));
  if (p && !confirm(`パターン「${p.name}」を削除しますか？`)) { fltRerender(scope); return; }
  // 配列から消さずトンボストン化（削除を同期で伝播・他端末で勝手に復活させない）
  { const t = fltPresets.find(x => String(x.id) === String(id)); if (t) { t.deleted = true; t.updatedAt = store._now(); } }
  // 削除したパターンを各タブで適用中だったら選択を外す
  for (const sc of ['holdings', 'analysis', 'secmaster']) if (fltState[sc].presetId === String(id)) fltState[sc].presetId = '';
  saveFilterPresets(); saveFilterState(); fltRerender(scope);
}
// フィルターパネルのHTML（① 項目を追加 →② 値を設定 / パターンの適用・保存・削除）
function filterPanelHtml(scope) {
  const st = fltState[scope];
  const cols = filterableCols(scope);
  const colMap = Object.fromEntries(cols.map(c => [c.key, c]));
  const addable = cols.filter(c => !st.rows.some(r => r.key === c.key));
  const addOpts = `<option value="">＋ フィルター項目を追加…</option>`
    + addable.map(c => `<option value="${c.key}">${esc(c.label)}（${c.type === 'sel' ? '選択' : '範囲'}）</option>`).join('');
  const rows = st.rows.map(r => {
    const c = colMap[r.key]; if (!c) return '';
    let ctrl;
    if (c.type === 'sel') {
      const spec = fltSelectSpec(r.key);
      const arr = (st.sel[r.key] || []).map(String);
      ctrl = `<div class="afl-chks">` + spec.opts.map(([v, l], i) => {
        const on = arr.includes(String(v));
        return `<label class="afl-chk${on ? ' on' : ''}"><input type="checkbox" ${on ? 'checked' : ''} onchange="fltToggleSel('${scope}','${r.key}',${i})">${esc(String(l))}</label>`;
      }).join('') + `</div>`;
    } else {
      const rg = st.num[r.key] || {};
      ctrl = `<input type="number" class="afl-num" placeholder="最小" value="${rg.min ?? ''}" onchange="fltSetNum('${scope}','${r.key}','min',this.value)"><span class="afl-tilde">〜</span><input type="number" class="afl-num" placeholder="最大" value="${rg.max ?? ''}" onchange="fltSetNum('${scope}','${r.key}','max',this.value)">`;
    }
    // 含む(絞り込み) / 除く(除外) の切替。除外時は行を赤系にして一目で分かるようにする
    const isNot = !!(st.not && st.not[r.key]);
    const modeBtn = `<button class="afl-mode${isNot ? ' not' : ''}" onclick="fltToggleNot('${scope}','${r.key}')" title="クリックで「含む（この条件で絞り込む）⇔ 除く（この条件に当てはまる銘柄を除外）」を切替">${isNot ? '除く' : '含む'}</button>`;
    return `<div class="afl-row${isNot ? ' not' : ''}" data-key="${r.key}"><span class="afl-l">${esc(c.label)}</span>${modeBtn}<div class="afl-ctrl">${ctrl}</div><button class="afl-x" title="削除" onclick="fltRemoveFilter('${scope}','${r.key}')">×</button></div>`;
  }).join('');
  const presetList = fltPresets.filter(p => !p.deleted);
  const presetDel = presetList.length ? `<select class="afl-add" onchange="fltDeletePreset('${scope}',this.value)"><option value="">パターン削除…</option>${presetList.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>` : '';
  return `<div class="ana-panel afl-panel">
    <div class="afl-head"><b>列フィルター</b><span class="muted">項目を追加して条件を設定。各行の「含む／除く」で除外条件にもできます。「パターン保存」で名前を付けると、次回からツールバーの選択だけで呼び出せます。</span><div class="tb-spacer"></div>
      <button class="btn btn-sm" onclick="fltSavePreset('${scope}')">現在の条件をパターン保存</button>
      ${presetDel}
      <select class="afl-add" onchange="fltAddFilter('${scope}',this.value)">${addOpts}</select>
      ${fltActiveCount(scope) || st.rows.length ? `<button class="btn btn-sm" onclick="fltClear('${scope}')">クリア</button>` : ''}</div>
    ${st.rows.length ? `<div class="afl-rows">${rows}</div>` : `<div class="muted afl-empty">「＋ フィルター項目を追加」から絞り込みたい項目を選んでください。</div>`}
  </div>`;
}
// ツールバー用フィルター操作（共通）: 常設のパターン選択 ＋ 詳細パネル開閉ボタン。
// パターンは作って選ぶだけで使えるよう常時表示。詳細（項目の行）はボタンを押した時だけ開く。
function filterBtnHtml(scope) {
  const st = fltState[scope];
  const presetSel = `<select class="flt-preset" title="保存したパターンを適用" onchange="fltApplyPreset('${scope}',this.value)">`
    + `<option value="">パターン: なし</option>`
    + fltPresets.filter(p => !p.deleted).map(p => `<option value="${p.id}" ${st.presetId === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')
    + `</select>`;
  return presetSel + fltToggleBtnHtml(scope);
}
// 「詳細」開閉ボタン単体（開閉時に全再描画せずこのボタンだけ差し替えて矢印/件数/活性を更新するため分離）
function fltToggleBtnHtml(scope) {
  const st = fltState[scope];
  const n = fltActiveCount(scope);
  return `<button id="flt-toggle-${scope}" class="btn btn-sm${n ? ' active' : ''}" onclick="fltToggle('${scope}')" title="フィルターの詳細設定">${svgIcon('filter', '')} 詳細${n ? ` (${n})` : ''} ${st.open ? '▲' : '▼'}</button>`;
}

// 列幅(px)。colPrefsのwidth上書き優先、無ければキー/種別ごとの既定。
function colDefaultWidth(key) {
  const mc = MASTER_COLS.find(c => c.key === key) || {};
  if (key === 'ticker') return 64;
  if (key === 'name') return 200;
  if (key === 'market' || key === 'detailType') return 72;
  if (key === 'trigBasis') return 64; // 1文字バッジ（初/増/高/固）
  if (key === 'addonFromHigh') return 84; // 「初回基準」タグ or —
  if (key === 'extPrice') return 92;  // 時間外価格＋種別タグ
  if (key === 'prevClose') return 96; // 前日終値＋引け日(MM-DD)
  if (key === 'dayAmt') return 88;    // 前日比の値幅（符号つき金額）
  if (key === 'prevBuyDate') return 100; // YYYY-MM-DD
  if (['targetPerPrice', 'targetPbrPrice', 'targetYieldPrice'].includes(key)) return 96; // 見出しが長い＋金額
  if (key === 'earnPrev' || key === 'earnNext') return 96; // YYYY/M/D
  if (['createdAt', 'updatedAt', 'analysisDate'].includes(key)) return 92;
  if (key === 'stars') return 120;
  if (key === 'analysisNote' || key === 'memo') return 160;
  if (key === 'stScenario' || key === 'mtScenario') return 210; // 弱気/ベース/強気を「/」区切りで1行
  if (key === 'stScenPos' || key === 'mtScenPos') return 100;   // 位置タグ（「弱気〜ベース」等）
  if (key === 'scenarioDate') return 92;
  if (key === 'labels') return 150; // 複数タグ
  if (key === 'origCost') return 96; // 金額（本来の購入額）
  if (key === 'capToTop') return 92; // 見出し「時価1位まで」＋「3.99倍」
  if (key === 'ratioValue' || key === 'ratioCost') return 84; // 「12.34%」＋バー
  if (key === 'anaWarn' || key === 'anaWarnC') return 150; // パターン名＋スコア
  if (key === 'anaMa200') return 72;
  if (key === 'ana5d') return 58;
  if (key === 'anaDev52w') return 80;
  return mc.left ? 110 : 84; // 左寄せ(テキスト系)は広め・数値は狭め
}
function colWidthPx(item) { return Math.max(40, item.width || colDefaultWidth(item.key)); }
// 列設定「列の固定」。colPrefs['<scope>#sticky']＝左から固定する表示列数（0=固定なし）。
// 未設定は null（既定＝コード・銘柄名の自動検出）。疑似キーは mergeColPrefs3way で市場と同様に
// キー単位＋_ts でマージされるので、sync-merge.js の変更は不要。
function colStickyCount(scope) {
  const v = colPrefs[scope + '#sticky'];
  return (typeof v === 'number' && v >= 0) ? v : null;
}
function getColOrder(market) {
  if (!colPrefs[market]) resetColPrefs(market);
  else reconcileColPrefs(market);
  return colPrefs[market];
}
// 列の利用可否を決める基準市場。分析の順張りビュー(ANALYSIS_T)は ANALYSIS と同じ列群を使う
// （列レイアウトとソートだけ別プロファイルで持つ）。
function colBaseMarket(market) { return market === 'ANALYSIS_T' ? 'ANALYSIS' : market; }
// そのスコープで利用可能な MASTER_COLS を MASTER_COLS の順で返す。
// MKTRANK はマーケットランキング専用の明示リスト(MKTRANK_KEYS・実在チェック済)を使う。
function colsForScope(market) {
  if (market === 'MKTRANK') { const set = new Set(MKTRANK_KEYS); return MASTER_COLS.filter(c => set.has(c.key)); }
  const base = colBaseMarket(market);
  return MASTER_COLS.filter(c => c.markets.includes(base));
}
function resetColPrefs(market) {
  const visible = new Set(DEFAULT_VISIBLE[market]);
  colPrefs[market] = colsForScope(market).map(c => ({
    key: c.key, visible: visible.has(c.key),
  }));
  saveColPrefs();
}
// 保存済み設定に、新規追加カラムを補完し、廃止カラムを除去（アプリ更新対応）
function reconcileColPrefs(market) {
  const scopeCols = colsForScope(market);
  const validKeys = scopeCols.map(c => c.key);
  const validSet = new Set(validKeys);
  const have = new Set(colPrefs[market].map(c => c.key));
  const visible = new Set(DEFAULT_VISIBLE[market]);
  let arr = colPrefs[market].filter(c => validSet.has(c.key)); // 廃止カラム除去
  // 未保持の新カラムをスコープ既定の順序で挿入
  let changed = arr.length !== colPrefs[market].length;
  for (const mc of scopeCols) {
    if (have.has(mc.key)) continue;
    arr.push({ key: mc.key, visible: visible.has(mc.key) });
    changed = true;
  }
  if (changed) { colPrefs[market] = arr; saveColPrefs(); }
}

// ---------- カラムレンダラー ----------
// 業種・セクターの英語→日本語表記。米国株は Finnhub/quoteSummary が英語で返すため、表示時に変換する。
// 未収録の値は英語のまま表示（網羅は順次拡充）。日本株はもともと日本語なので素通り。
const INDUSTRY_JA = {
  // GICSセクター（Yahoo quoteSummary）
  'Technology': 'テクノロジー', 'Financial Services': '金融', 'Healthcare': 'ヘルスケア', 'Health Care': 'ヘルスケア',
  'Consumer Cyclical': '一般消費財', 'Consumer Defensive': '生活必需品', 'Communication Services': 'コミュニケーション',
  'Industrials': '資本財・サービス', 'Energy': 'エネルギー', 'Basic Materials': '素材', 'Real Estate': '不動産', 'Utilities': '公益事業',
  // Finnhub finnhubIndustry / 業種
  'Semiconductors': '半導体', 'Software': 'ソフトウェア', 'Hardware': 'ハードウェア', 'Technology Hardware': 'ハードウェア',
  'Communications': '通信機器', 'Communications Equipment': '通信機器', 'Telecommunication': '通信', 'Telecommunications': '通信',
  'Media': 'メディア', 'Internet': 'インターネット', 'Retail': '小売', 'Specialty Retail': '専門小売',
  'Pharmaceuticals': '医薬品', 'Biotechnology': 'バイオテクノロジー', 'Banking': '銀行', 'Banks': '銀行',
  'Insurance': '保険', 'Diversified Financials': '総合金融', 'Capital Markets': '資本市場', 'Consumer Finance': '消費者金融',
  'Automobiles': '自動車', 'Auto Manufacturers': '自動車', 'Aerospace & Defense': '航空宇宙・防衛', 'Aerospace': '航空宇宙',
  'Machinery': '機械', 'Industrial Conglomerates': 'コングロマリット', 'Electrical Equipment': '電気機器',
  'Chemicals': '化学', 'Metals & Mining': '金属・鉱業', 'Oil & Gas': '石油・ガス', 'Energy Equipment & Services': 'エネルギー機器',
  'Food Products': '食品', 'Beverages': '飲料', 'Tobacco': 'たばこ', 'Consumer products': '消費財', 'Consumer Products': '消費財',
  'Textiles, Apparel & Luxury Goods': '繊維・アパレル・高級品', 'Hotels, Restaurants & Leisure': 'ホテル・レジャー',
  'Airlines': '航空', 'Transportation': '運輸', 'Logistics & Transportation': '物流・運輸', 'Road & Rail': '道路・鉄道',
  'Building': '建設', 'Construction': '建設', 'Trading Companies & Distributors': '商社・流通', 'Marine': '海運',
  'IT Services': 'ITサービス', 'Professional Services': '専門サービス', 'Commercial Services & Supplies': '商業サービス',
  'Entertainment': 'エンターテインメント', 'Interactive Media & Services': 'インタラクティブメディア', 'Restaurants': 'レストラン',
  'Household Products': '家庭用品', 'Personal Products': 'パーソナルケア', 'Real Estate Management & Development': '不動産管理・開発',
  'Electric Utilities': '電力', 'Gas Utilities': 'ガス', 'Water Utilities': '水道', 'Packaging': '包装',
};
function jpInd(v) { return v ? (INDUSTRY_JA[v] || v) : v; }

// 各カラムの td を返す関数。引数: (sec, ctx)
const muted = '<span class="muted">—</span>';
// みなし（取得単価を前回購入単価とみなす）の省スペース表示。数値の「前」に付けて桁ズレを防ぐ
const MINASHI = '<span class="muted" title="みなし（前回購入単価が未登録のため取得単価を使用）" style="cursor:help">≒</span>';
// 買増固定値（手入力のトリガー）マーカー。数値の前に付ける。
const FIXED_MARK = '<span class="muted" title="買増固定値（ルール計算でなく手入力のトリガー）" style="cursor:help">固</span>';
const pctTd = (v) => `<td class="${cls(v)}">${v != null ? signed(v) + '%' : '—'}</td>`;
// ---------- 列の背景色ルール（マスタ管理・画面から設定可能） ----------
// 値の範囲ごとに背景色を割り当てる。適用先の画面（保有銘柄/買い増しサイン/銘柄マスタ/マーケット）を複数選択可。
// 旧ハードコード（前日比・5年高値比・前回比）は defaultCfRules() に移行し、store.data.cfRules を唯一の参照元とする。
const CF_SCREENS = [
  { id: 'holdings', label: '保有銘柄' },
  { id: 'signal',   label: '買い増しサイン' },
  { id: 'master',   label: '銘柄マスタ' },
  { id: 'market',   label: 'マーケット' },
  { id: 'analysis', label: '分析' },
];
// 背景色ルールを設定できる数値列（設定UIの選択肢）。
const CF_NUMERIC_KEYS = ['price', 'day', 'extPrice', 'trigger', 'base', 'drop', 'dropPrev', 'high5y', 'high52w', 'dropFrom5y', 'dropFrom52w', 'low1y', 'low3y', 'riseFrom1y', 'riseFrom3y', 'prevBuyPrice', 'dropFromPrev', 'marketCap', 'capToTop', 'turnover', 'value', 'cost', 'origCost', 'acqJpy', 'ratioValue', 'ratioCost', 'pnl', 'avgCost', 'qty', 'buyCount', 'buyAmount', 'reco', 'fixedBuyPrice', 'per', 'pbr', 'psr', 'dividend', 'divYield', 'yieldOnCost', 'eps', 'priority', 'marginRatio', 'principalSoldAmount', 'anaTotal', 'anaCup', 'anaRange', 'anaWbottom', 'anaAsc', 'anaRound', 'anaInvHS', 'anaFlag', 'anaBase', 'anaWarn', 'anaRSI', 'anaBuy', 'anaFail', 'stScenPos', 'mtScenPos'];
// 現在描画中の画面（背景色ルールの適用先絞り込みに使用）。render() で更新。
let cfScreen = 'holdings';
function cfNewId() { return 'cf_' + Math.random().toString(36).slice(2, 9); }
// 既定の背景色ルール。1グループ＝「列×適用画面の組」で、複数の範囲(ranges)を持つ。範囲は min(以上)〜max(以下)、
// 上にある範囲ほど優先（先頭一致）。旧ハードコード（前日比/5年高値比/前回比）を移行。初回のみ全画面に適用。
function defaultCfRules() {
  const all = CF_SCREENS.map(s => s.id);
  // 既定グループは固定id（cf_def_*）にする。ランダムidだと端末ごとに別idの既定が生まれ、
  // id키ーの3-wayマージで既定どうしが重複合算してしまう。固定idなら同一視され、編集や削除
  // （トンボストン）が updatedAt で正しく既定に勝てる。seed段階では updatedAt を付けない
  // （= remote のユーザー編集に負ける）。reset 操作のときだけ後段で updatedAt を打つ。
  const G = (col, ranges) => ({ id: 'cf_def_' + col, col, screens: all.slice(), ranges });
  return [
    // 前日比: 上昇=緑系 / 下落=赤系
    G('day', [
      { min: 10, max: null, bg: 'rgba(34,197,94,.45)' }, { min: 5, max: 10, bg: 'rgba(34,197,94,.20)' },
      { min: null, max: -10, bg: 'rgba(239,68,68,.45)' }, { min: -10, max: -5, bg: 'rgba(239,68,68,.20)' },
    ]),
    // 5年高値からの下落率: 薄スレート→黄→橙→赤
    G('dropFrom5y', [
      { min: null, max: -80, bg: 'rgba(239,68,68,.52)' }, { min: -80, max: -60, bg: 'rgba(249,115,22,.46)' },
      { min: -60, max: -40, bg: 'rgba(234,179,8,.40)' }, { min: -40, max: -35, bg: 'rgba(148,163,184,.22)' },
    ]),
    // 前回からの下落率: -10/-15/-20/-40/-50 の5段階
    G('dropFromPrev', [
      { min: null, max: -50, bg: 'rgba(159,18,57,.50)' }, { min: -50, max: -40, bg: 'rgba(239,68,68,.48)' },
      { min: -40, max: -20, bg: 'rgba(249,115,22,.42)' }, { min: -20, max: -15, bg: 'rgba(234,179,8,.32)' },
      { min: -15, max: -10, bg: 'rgba(148,163,184,.22)' },
    ]),
  ];
}
// 旧フラット型（1ルール=1範囲: {col,min,max,bg,screens}）→ グループ型（{col,screens,ranges:[...]}）へ移行。
// 既にグループ型ならそのまま。未定義は既定をシード。空配列はユーザーの全削除状態として尊重。
function migrateCfRules(rules) {
  if (!Array.isArray(rules)) return defaultCfRules();
  if (!rules.length) return rules;
  if (rules[0] && Array.isArray(rules[0].ranges)) return cfNormalizeDefaultIds(rules); // 既にグループ型
  const groups = []; const map = {};
  for (const r of rules) {
    const k = r.col + '|' + JSON.stringify(r.screens || []);
    if (!map[k]) { map[k] = { id: cfNewId(), col: r.col, screens: (r.screens || []).slice(), ranges: [] }; groups.push(map[k]); }
    map[k].ranges.push({ min: r.min ?? null, max: r.max ?? null, bg: r.bg });
  }
  return cfNormalizeDefaultIds(groups);
}
// 旧シードの既定（ランダムid・未編集）を固定id(cf_def_*)へ寄せる。内容が既定と完全一致するグループだけ
// id を付け替える（＝ユーザーが編集した既定は別物として温存）。これで端末間の id 不一致による既定の
// 重複合算を防ぐ。冪等（既に cf_def_* なら何もしない）。
function cfNormalizeDefaultIds(groups) {
  // 既定の判定は ranges（色と範囲）の一致で行う。screens は既定の構成が増減した履歴があり
  // （例: 'analysis' 画面の後付け）、screens まで含めると旧シード既定が一致せず再キーできない。
  const defRangesByCol = {};
  for (const d of defaultCfRules()) defRangesByCol[d.col] = JSON.stringify(d.ranges);
  const usedDef = new Set(groups.filter(g => typeof g.id === 'string' && g.id.startsWith('cf_def_')).map(g => g.id));
  for (const g of groups) {
    if (typeof g.id === 'string' && g.id.startsWith('cf_def_')) continue;
    const want = 'cf_def_' + g.col;
    if (usedDef.has(want)) continue; // 同colの固定id既定が既にある→重複付与しない
    if (defRangesByCol[g.col] && defRangesByCol[g.col] === JSON.stringify(g.ranges)) {
      g.id = want; usedDef.add(want);
    }
  }
  return groups;
}
// 共通ドル円換算レート（マスタ評価用）。背景色ルールのUS金額判定とマトリックス円換算で共用。
// 編集は「マスタ・設定 → ドル円換算レート」。初期値 DEFAULT_MATRIX_USDJPY(=100)。
function masterUsdJpy() {
  const s = store.data.settings || {};
  if (s.masterUsdJpy != null && isFinite(s.masterUsdJpy) && s.masterUsdJpy > 0) return s.masterUsdJpy;
  const mx = store.data.matrixSettings && store.data.matrixSettings.usdJpy; // 後方互換
  return (mx != null && isFinite(mx) && mx > 0) ? mx : DEFAULT_MATRIX_USDJPY;
}
// ===== 資産に占める割合（比率列） =====
// 分母の選び方（store.data.settings.ratioDenom に保存＝Google同期対象。localStorage 単独保存はしない）。
//   both   … 日米合計（登録済み全銘柄・US+JP の評価額/取得額合計）
//   shown  … 表示している範囲（検索・列フィルタ適用後に表に出ている行の合計）
//   market … 表示している分類（行が属する市場＝日本株なら日本株合計・米国株なら米国株合計）
//   manual … 手入力の金額（円 or ドル。ドルは共通レートで円換算）
const RATIO_DENOM_LABEL = { both: '日米合計', shown: '表示中の合計', market: '市場別（日/米）', manual: '手入力額' };
function ratioDenomMode() {
  const v = (store.data.settings || {}).ratioDenom;
  return RATIO_DENOM_LABEL[v] ? v : 'both';
}
// 手入力の分母（円換算後）。未設定・0以下は null（＝比率を出さない）
function ratioManualJpy() {
  const s = store.data.settings || {};
  const a = s.ratioManualAmount;
  if (a == null || !isFinite(a) || a <= 0) return null;
  return s.ratioManualCcy === 'USD' ? a * masterUsdJpy() : a;
}
// 原通貨→円換算（比率用）。為替未取得の米株は共通レート（マスタ・設定）で代替し、分母から欠落させない。
function ratioJpy(market, nativeAmt) {
  if (nativeAmt == null) return null;
  const v = calc.toJpy(market, nativeAmt);
  if (v != null) return v;
  return market === 'US' ? nativeAmt * masterUsdJpy() : nativeAmt;
}
function ratioValJpy(sec) { return ratioJpy(sec.market, calc.valueOrCostNative(sec)) || 0; }
function ratioCostJpy(sec) { return ratioJpy(sec.market, calc.costNative(sec)) || 0; }
// 描画中の表のスコープ（比率列の分母）。marketRow から参照するため描画直前にセットする。
let ratioCtx = null;
// shownSecs = その表に実際に出ている銘柄（分母 'shown' 用）。省略時は 'shown' でも日米合計にフォールバック。
// forceMode を渡すと設定を無視してその分母で計算する（銘柄カルテ＝常に日米合計）。
function buildRatioCtx(shownSecs, forceMode) {
  const mode = forceMode || ratioDenomMode();
  const sum = (list) => list.reduce((a, s) => { a.v += ratioValJpy(s); a.c += ratioCostJpy(s); return a; }, { v: 0, c: 0 });
  const stocks = () => store.data.securities.filter(s => s.market === 'US' || s.market === 'JP');
  if (mode === 'manual') {
    const j = ratioManualJpy();
    const d = j != null ? { v: j, c: j } : null;
    return { mode, label: RATIO_DENOM_LABEL.manual, get: () => d };
  }
  if (mode === 'market') {
    const cache = {};
    return { mode, label: RATIO_DENOM_LABEL.market, get: (sec) => (cache[sec.market] || (cache[sec.market] = sum(stocks().filter(s => s.market === sec.market)))) };
  }
  if (mode === 'shown' && Array.isArray(shownSecs)) {
    const d = sum(shownSecs);
    return { mode, label: RATIO_DENOM_LABEL.shown, get: () => d };
  }
  const d = sum(stocks());
  return { mode: 'both', label: RATIO_DENOM_LABEL.both, get: () => d };
}
// 比率(%)。分母が無い/0、または分子が0（＝未保有・保有額0）なら null＝「—」表示。
// 「0.00%」を並べても情報にならず、保有ゼロの行が数字で埋まって読みにくいため。
function ratioPct(sec, kind, ctx) {
  const c = ctx || ratioCtx || buildRatioCtx(null);
  const d = c.get(sec);
  if (!d) return null;
  const den = kind === 'cost' ? d.c : d.v;
  if (!(den > 0)) return null;
  const numr = kind === 'cost' ? ratioCostJpy(sec) : ratioValJpy(sec);
  if (!(numr > 0)) return null;
  return numr / den * 100;
}
// 比率セル（％テキスト＋背景バー）。バー幅は 100% を上限にクリップ。
function ratioTd(sec, kind) {
  const c = ratioCtx || buildRatioCtx(null);
  const p = ratioPct(sec, kind, c);
  if (p == null) return `<td>${muted}</td>`;
  const d = c.get(sec);
  const den = kind === 'cost' ? d.c : d.v;
  const numr = kind === 'cost' ? ratioCostJpy(sec) : ratioValJpy(sec);
  const title = `${kind === 'cost' ? '取得額' : '評価額'} ${yen(numr)} ÷ ${c.label} ${yen(den)}`;
  return `<td class="ratio-td" title="${esc(title)}"><span class="ratio-bar" style="width:${Math.max(0, Math.min(100, p)).toFixed(1)}%"></span><span class="ratio-v">${p.toFixed(2)}%</span></td>`;
}
// 詳細ドロワー用の1行テキスト（評価額比率 / 取得額比率＋分母ラベル）
function ratioSummaryHtml(sec) {
  const c = ratioCtx || buildRatioCtx(null);
  const pv = ratioPct(sec, 'value', c), pc = ratioPct(sec, 'cost', c);
  const f = p => p != null ? `${p.toFixed(2)}%` : '—';
  return `${f(pv)} <span class="muted" style="font-weight:400;font-size:11px">/ 取得額 ${f(pc)}（分母: ${esc(c.label)}）</span>`;
}
// 銘柄カルテ用（2026-07-29 すみぽん指示）: 1銘柄を単体で見る画面なので
// **評価額ベース・分母は日米合計に固定**する。ツールバーの分母設定・取得額比率は出さない。
// 理由: 取得額比率は分母（全銘柄の取得額合計）と分子（この銘柄の取得額）の時点がそろわず、
// 「資産に占める割合」としては解釈しづらいため。
function karteRatioHtml(sec) {
  const c = buildRatioCtx(null, 'both'); // 日米合計（ツールバーの分母設定に依存しない）
  const p = ratioPct(sec, 'value', c);
  if (p == null) return '—';
  return `${p.toFixed(2)}% <span class="muted" style="font-weight:400;font-size:11px">（評価額 / 日米合計）</span>`;
}
// 分母切替のツールバー（保有銘柄一覧・買い増しサイン共通）
function ratioToolbarHtml() {
  const s = store.data.settings || {};
  const mode = ratioDenomMode();
  const opts = Object.keys(RATIO_DENOM_LABEL).map(k => `<option value="${k}" ${mode === k ? 'selected' : ''}>${RATIO_DENOM_LABEL[k]}</option>`).join('');
  // 金額は桁区切り表示（type=number だとカンマを表示できないため text＋inputmode で数字キーパッドを出す）
  const manual = mode === 'manual' ? `
    <input id="ratio-manual-amt" type="text" inputmode="decimal" value="${s.ratioManualAmount != null ? num(s.ratioManualAmount) : ''}" placeholder="金額" style="width:130px;text-align:right" oninput="ratioManualFormat(this)" onchange="setRatioManual()">
    <select id="ratio-manual-ccy" onchange="setRatioManual()"><option value="JPY" ${s.ratioManualCcy !== 'USD' ? 'selected' : ''}>円</option><option value="USD" ${s.ratioManualCcy === 'USD' ? 'selected' : ''}>ドル</option></select>` : '';
  return `<span class="ratio-ctl" title="比率列（評価額比率・取得額比率）の分母">
    <span class="muted">比率の分母</span>
    <select onchange="setRatioDenom(this.value)">${opts}</select>${manual}</span>`;
}
function setRatioDenom(v) {
  if (!RATIO_DENOM_LABEL[v]) return;
  store.data.settings = store.data.settings || {};
  store.data.settings.ratioDenom = v;
  store.data.settings._updatedAt = store._now(); // 同期マージ用（settings は singleTs）
  store.save(); render();
}
// 手入力額を打ちながら桁区切り（カンマ）を付ける。全角数字・カンマ・¥/$ は取り除いて解釈。
function ratioNumOf(str) {
  const t = String(str == null ? '' : str)
    .replace(/[０-９．]/g, c => '０１２３４５６７８９'.indexOf(c) >= 0 ? String('０１２３４５６７８９'.indexOf(c)) : '.')
    .replace(/[^0-9.]/g, '');
  const v = parseFloat(t);
  return isFinite(v) ? v : null;
}
function ratioManualFormat(el) {
  const raw = el.value;
  const dec = /\.\d*$/.test(raw.replace(/,/g, '')) ? raw.replace(/,/g, '').match(/\.\d*$/)[0] : ''; // 「1234.」入力中も維持
  const v = ratioNumOf(raw);
  if (v == null) { el.value = raw.replace(/[^0-9.]/g, ''); return; }
  el.value = Math.floor(v).toLocaleString('ja-JP') + dec;
  try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) {}
}
function setRatioManual() {
  const a = ratioNumOf((document.getElementById('ratio-manual-amt') || {}).value);
  const ccy = (document.getElementById('ratio-manual-ccy') || {}).value === 'USD' ? 'USD' : 'JPY';
  store.data.settings = store.data.settings || {};
  store.data.settings.ratioManualAmount = isFinite(a) && a > 0 ? a : null;
  store.data.settings.ratioManualCcy = ccy;
  store.data.settings._updatedAt = store._now();
  store.save(); render();
}
// 背景色判定で「US（ドル建て）→円換算」する対象の列（ネイティブ通貨の金額・株価系）。
// %・倍率・株数・スコア・既に円建ての取得円(acqJpy)は対象外。表示は$のまま、色だけ円換算で判定する。
const CF_MONEY_KEYS = new Set(['price', 'dayAmt', 'trigger', 'base', 'high5y', 'high52w', 'low1y', 'low3y', 'prevBuyPrice', 'marketCap', 'turnover', 'value', 'cost', 'origCost', 'avgCost', 'buyAmount', 'reco', 'fixedBuyPrice', 'dividend', 'eps', 'principalSoldAmount', 'targetPerPrice', 'targetPbrPrice', 'targetYieldPrice']);
// US の金額系の素の値を共通レートで円換算（背景色判定用）。それ以外はそのまま返す。
function cfConvVal(key, market, v) {
  if (v == null || !isFinite(v)) return v;
  if (market === 'US' && CF_MONEY_KEYS.has(key)) return v * masterUsdJpy();
  return v;
}
// 値 v が key列・screen画面でマッチする背景色（グループ→範囲を順に走査、先頭一致優先）。無ければ ''。
function cfBgFor(key, v, screen) {
  if (v == null || !isFinite(v)) return '';
  const groups = store.data.cfRules || [];
  for (const g of groups) {
    if (g.deleted) continue;            // トンボストン（削除済み・同期保持用）は適用しない
    if (g.col !== key) continue;
    if (g.screens && g.screens.length && !g.screens.includes(screen)) continue;
    for (const r of (g.ranges || [])) {
      if ((r.min == null || v >= r.min) && (r.max == null || v <= r.max)) return r.bg;
    }
  }
  return '';
}
// style属性文字列（描画中画面 or 指定画面）。<td ...> に直接埋め込む用途。
function cfStyle(key, v, screen) { const bg = cfBgFor(key, v, screen || cfScreen); return bg ? ` style="background:${bg}"` : ''; }
// レンダラーが返す <td...> に背景色をマージ注入（既存 style があれば前置で合成）。
function cfInject(cellHtml, key, v, screen) {
  const bg = cfBgFor(key, v, screen || cfScreen);
  if (!bg) return cellHtml;
  if (/^<td[^>]*\sstyle="/.test(cellHtml)) return cellHtml.replace(/^(<td[^>]*\sstyle=")/, `$1background:${bg};`);
  return cellHtml.replace(/^<td/, `<td style="background:${bg}"`);
}
// 背景色ルール判定に使う、列の数値（表示値に対応）。null=対象外/値なし。
function cfCellValue(key, sec, ctx) {
  switch (key) {
    case 'price': return ctx.price;
    case 'day': return ctx.dayChg;
    case 'prevClose': return ctx.prevCloseV;
    case 'dayAmt': return ctx.dayAmt;
    case 'extPrice': { const p = store.data.prices[priceKey(sec)] || {}; if (p.extPrice == null) return null; const base = p.price != null ? p.price : p.prevClose; return (base && p.extPrice) ? (p.extPrice - base) / base * 100 : null; }
    case 'trigger': return ctx.ev ? ctx.ev.trigger : null;
    case 'base': return ctx.ev ? ctx.ev.base : null;
    case 'drop': return ctx.ev ? ctx.ev.remainingDropPct : null;
    case 'dropPrev': return calc.remainingDropPrev(sec);
    case 'high5y': return ctx.high5y;
    case 'high52w': return ctx.high52w;
    case 'dropFrom5y': return calc.dropFrom5y(sec);
    case 'dropFrom52w': return calc.dropFrom52w(sec);
    case 'low1y': return ctx.low1y;
    case 'low3y': return ctx.low3y;
    case 'riseFrom1y': return calc.riseFrom1y(sec);
    case 'riseFrom3y': return calc.riseFrom3y(sec);
    case 'prevBuyPrice': return ctx.prevBuy;
    case 'dropFromPrev': return calc.dropFromPrev(sec);
    case 'marketCap': return calc.marketCap(sec);
    case 'capToTop': return calc.capToTop(sec);
    case 'turnover': return calc.turnover(sec);
    case 'value': return ctx.th.qty ? ctx.valN : null;
    case 'cost': return ctx.th.qty ? ctx.th.acquiredCost : null;
    case 'origCost': return calc.originalCostNative(sec) || null;
    case 'acqJpy': { if (sec.market === 'US') { const hs = store.data.holdings.filter(h => h.securityId === sec.id); return hs.some(h => h.acqJpy != null) ? hs.reduce((a, h) => a + (h.acqJpy || 0), 0) : null; } return ctx.th.qty ? ctx.th.avgCost * ctx.th.qty : null; }
    case 'ratioValue': return ratioPct(sec, 'value');
    case 'ratioCost': return ratioPct(sec, 'cost');
    case 'pnl': return ctx.pnlPct;
    case 'avgCost': return ctx.th.qty ? ctx.th.avgCost : null;
    case 'qty': return ctx.th.qty || null;
    case 'buyCount': return ctx.buyCnt || null;
    case 'buyAmount': return ctx.buyAmt;
    case 'reco': return ctx.recoAmt;
    case 'fixedBuyPrice': return typeof sec.fixedBuyPrice === 'number' ? sec.fixedBuyPrice : null;
    case 'per': return calc.per(sec);
    case 'pbr': return calc.pbr(sec);
    case 'psr': return calc.psr(sec);
    case 'dividend': return calc.field(sec, 'dividend');
    case 'divYield': return calc.divYield(sec);
    case 'yieldOnCost': return calc.yieldOnCost(sec);
    case 'eps': return calc.field(sec, 'eps');
    case 'targetPerPrice': return calc.targetPerPrice(sec);
    case 'targetPbrPrice': return calc.targetPbrPrice(sec);
    case 'targetYieldPrice': return calc.targetYieldPrice(sec);
    case 'priority': return sec.priority;
    // シナリオ位置レベル（1=弱気未満〜7=強気超え）。マスタの背景色ルールでこの数値に色を設定できる
    case 'stScenPos': return scPosition(sec, 'st')?.lvl ?? null;
    case 'mtScenPos': return scPosition(sec, 'mt')?.lvl ?? null;
    case 'marginRatio': return sec.market === 'JP' ? calc.marginRatio(sec) : null;
    case 'principalSoldAmount': return sec.principalSoldAmount;
    case 'anaTotal': return techComposite(sec);
    case 'anaTrend': return techSideScore(sec, 'trend');
    case 'anaContra': return techSideScore(sec, 'contra');
    case 'anaRsiDiv': return techPatScore(sec, 'rsiDivergence');
    case 'anaBoll': return techPatScore(sec, 'bollingerRecover');
    case 'anaMaDev': return techPatScore(sec, 'maDeviation');
    case 'anaGap': return techPatScore(sec, 'gapFill');
    case 'anaVolDry': return techPatScore(sec, 'volDryUp');
    case 'anaCup': return techPatScore(sec, 'cup');
    case 'anaRange': return techPatScore(sec, 'range');
    case 'anaWbottom': return techPatScore(sec, 'doubleBottom');
    case 'anaAsc': return techPatScore(sec, 'ascTriangle');
    case 'anaRound': return techPatScore(sec, 'roundBottom');
    case 'anaInvHS': return techPatScore(sec, 'invHS');
    case 'anaUndercut': return techPatScore(sec, 'undercutRally');
    case 'anaClimax': return techPatScore(sec, 'sellingClimax');
    case 'anaFlag': return techPatScore(sec, 'flag');
    case 'anaBase': return techPatScore(sec, 'baseOnBase');
    case 'anaWarn': { const w = techWarnSide(sec, 'trend'); return w ? w.score : null; }
    case 'anaWarnC': { const w = techWarnSide(sec, 'contra'); return w ? w.score : null; }
    case 'anaHsTop': return techPatScore(sec, 'hsTop');
    case 'anaDblTop': return techPatScore(sec, 'doubleTop');
    case 'anaNewLow': return techPatScore(sec, 'newLowHighVol');
    case 'anaBearFlag': return techPatScore(sec, 'bearFlag');
    case 'anaDescTri': return techPatScore(sec, 'descTriangle');
    case 'anaMa200': { const r = techOf(sec); return r && r.ma200Pos ? r.ma200Pos : null; }
    case 'ana5d': { const r = techOf(sec); return r && r.above5 != null ? (r.above5 ? '上' : '下') : null; }
    case 'anaDev52w': { const r = techOf(sec); return r && r.dev52w != null ? r.dev52w : null; }
    case 'anaRSI': { const r = techOf(sec); return r ? (r.rsi ?? null) : null; }
    case 'anaBuy': return techLevel(sec, 'buy');
    case 'anaFail': return techLevel(sec, 'fail');
    default: return null;
  }
}
// 銘柄名の表記正規化＋略記（表のラベルに情報を詰めるため）。
// 全角英数・スペースを半角化し、冗長な社名語を略記（ホールディングス→HD / フィナンシャルグループ→FG / グループ→G）。
function nameAbbr(name) {
  let s = String(name || '');
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)); // 全角英数→半角
  s = s.replace(/[　\s]+/g, ' ').trim();                                                  // 全角/連続スペース→半角1つ
  s = s.replace(/ホールディングス|ホールディング/g, 'HD');
  s = s.replace(/フィナンシャル・?グループ/g, 'FG');
  s = s.replace(/グループ/g, 'G');
  return s;
}
// 表ラベル用の略記名（保有・サイン等の名称列で使用）
function displayNameAbbr(sec) { return nameAbbr(calc.displayName(sec)); }
// 株価シナリオのセル（弱気/ベース/強気の順に「/」区切りで1行。改行で行が高くなるのはNG・2026-08-25 すみぽん指示）。term='st'|'mt'
function scenarioTd(s, term) {
  const parts = ['Bear', 'Base', 'Bull'].map(k => scFmtRange(s[term + k], s.market));
  if (!parts.some(Boolean)) return `<td class="l"><span class="muted">—</span></td>`;
  const title = `${term === 'st' ? '短期' : '中期'}シナリオ（弱気 / ベース / 強気）${s.scenarioDate ? `　分析日 ${s.scenarioDate}` : ''}`;
  return `<td class="l" style="font-size:11px;white-space:nowrap" title="${esc(title)}">${parts.map(p => p || '<span class="muted">—</span>').join(' <span class="muted">/</span> ')}</td>`;
}
// 現在値がシナリオのどのレンジにいるか（派生）。タグはレベル別の既定色（SC_POS_COLORS）、
// セル背景はマスタの背景色ルール（レベル1〜7の数値・cfCellValue）で変更できる
function scenarioPosTd(s, term) {
  const p = scPosition(s, term);
  if (!p) return `<td class="l"><span class="muted">—</span></td>`;
  const price = calc.price(s);
  return `<td class="l" title="現在値 ${price != null ? fmtAmt(price, s.market) : '—'} の位置（レベル ${p.lvl}/7。1=弱気未満〜7=強気超え。背景色ルールはこのレベル値で設定）"><span class="tag" style="${labelColorStyle(p.color)}">${esc(p.label)}</span></td>`;
}
const COL_RENDERERS = {
  ticker:    (s,c) => `<td class="l col-code"><span class="tk ${s.market.toLowerCase()}" style="cursor:pointer" onclick="openSecurityDetail(${s.id})">${esc(s.ticker)}</span></td>`,
  name:      (s,c) => { const onName = cfScreen === 'analysis' ? `openAnalysisDetail('${s.market}','${esc(String(s.ticker))}')` : `openSecurityDetail(${s.id})`; return `<td class="l">${rankBadgeHtml(s)}${earnLabelHtml(s)}<strong class="lnk-ext nm-strong" onclick="${onName}" title="${esc(calc.displayName(s))}">${esc(displayNameAbbr(s))}</strong>${detailTypeOf(s) === 'ETF' ? ` <span class="tag detail-etf">ETF</span>` : ''}${s.watch ? ` <span class="tag watch">注意</span>` : ''}</td>`; },
  market:    (s,c) => `<td class="l"><span class="tag ${s.market.toLowerCase()}">${MARKET_LABEL[s.market]}</span></td>`,
  detailType: (s,c) => { const dt = detailTypeOf(s); return `<td class="l"><span class="tag detail-${dt === 'ETF' ? 'etf' : dt === '投資信託' ? 'fund' : 'stock'}">${esc(dt)}</span></td>`; },
  broker:    (s,c) => { const b = calc.lastBroker(s); return `<td class="l">${b ? esc(b) : muted}</td>`; },
  sigType:   (s,c) => `<td class="l">${c.ev ? (c.ev.type === 'initial' ? '初回購入' : '買い増し') : muted}</td>`,
  // 現在値: 価格があれば株探チャートへの外部リンク。未取得時は手入力ボタンのまま。
  price:     (s,c) => `<td>${c.price != null ? `<a href="${kabutanUrl(s)}" target="_blank" rel="noopener" class="lnk-ext">${fmtAmt(c.price, c.market)}</a>` : c.priceCell}</td>`,
  // 時間外: 米株プレ/アフター価格＋変動率（対・直近レギュラー終値）＋種別タグ。
  // 基準は p.price（regularMarketPrice＝直近レギュラー終値: プレ中=昨日終値 / アフター中=当日終値）。
  // p.prevClose は日足の「最後から2番目」で前々日終値になりプレで1日ズレるため使わない。
  extPrice:  (s,c) => { const p = store.data.prices[priceKey(s)] || {}; if (p.extPrice == null) return `<td>${muted}</td>`; const lbl = p.extType === 'pre' ? 'プレ' : p.extType === 'post' ? 'アフター' : ''; const base = p.price != null ? p.price : p.prevClose; const d = (base && p.extPrice) ? (p.extPrice - base) / base * 100 : null; return `<td class="${d != null ? cls(d) : ''}">${fmtAmt(p.extPrice, c.market)}${d != null ? ` <span style="font-size:11px">${signed(d)}%</span>` : ''} <span class="muted" style="font-size:10px">${lbl}</span></td>`; },
  // 前日比: 株探チャートへの外部リンク。条件付き背景・文字色(緑/赤)は維持。
  day:       (s,c) => { const v = c.dayChg; return `<td class="${cls(v)}"><a href="${kabutanUrl(s)}" target="_blank" rel="noopener" class="lnk-ext">${v != null ? signed(v) + '%' : '—'}</a></td>`; },
  // 前日終値: 日次 light(range=1d) 取得の確定値。引け日(MM-DD)を小さく併記。
  prevClose: (s,c) => `<td>${c.prevCloseV != null ? fmtAmt(c.prevCloseV, c.market) : muted}${c.prevCloseDate ? ` <span class="muted" style="font-size:10px" title="${c.prevCloseDate}の終値">${c.prevCloseDate.slice(5)}</span>` : ''}</td>`,
  // 前日比値幅: 現在値−前日終値（原通貨）。符号つき・緑/赤。
  dayAmt:    (s,c) => { const v = c.dayAmt; return `<td class="${cls(v)}">${v != null ? (v >= 0 ? '+' : '−') + fmtAmt(Math.abs(v), c.market) : '—'}</td>`; },
  trigger:   (s,c) => `<td>${c.ev ? (c.ev.baseSource === 'みなし' ? MINASHI : c.ev.baseSource === '固定' ? FIXED_MARK : '') + c.m(c.ev.trigger) : muted}</td>`,
  // 適用区分: 次回購入・残り下落率がどのルール分岐で算出されたか（初=初回 / 増=買い増し / 高=高値更新 / 固=買増固定値 / —=判定外）
  trigBasis: (s,c) => {
    const ev = c.ev;
    if (!ev) return `<td class="l">${muted}</td>`;
    let code, title;
    if (ev.baseSource === '固定') { code = '固'; title = '買増固定値（手入力の固定トリガー）'; }
    else if (ev.baseSource === '高値更新') { code = '高'; title = '高値更新（前回購入より後に最高値更新→初回ルールで判定）'; }
    else if (ev.baseSource === '初回固定') { code = '初'; title = '買い増しも初回基準（基準高値×初回下落率で固定・前回購入単価に依らない）'; }
    else if (ev.type === 'initial') { code = '初'; title = '初回購入（基準高値から初回下落率）'; }
    else { code = '増'; title = '買い増し（前回購入単価から買い増し下落率）'; }
    return `<td class="l"><span class="tag basis-${code === '初' ? 'init' : code === '増' ? 'addon' : code === '高' ? 'high' : 'fixed'}" title="${title}">${code}</span></td>`;
  },
  // 到達区分: 新=本日新たに到達 / 続=前日に続き到達。前日終値ベース（残り下落率(前日)と同基準）。
  reachKind: (s,c) => {
    const k = calc.reachKind(s);
    if (!k) return `<td class="l">${muted}</td>`;
    const title = k === '新' ? '本日あらたに買い増しラインへ到達（前日終値では未到達）' : '前営業日に続き到達中';
    return `<td class="l"><span class="tag reach-${k === '新' ? 'new' : 'cont'}" title="${title}">${k}</span></td>`;
  },
  // 残り下落率: 到達後はマイナス値（超過幅）も表示（SEC-38）。到達=赤(reached)、残り5%以内=near。
  drop:      (s,c) => !c.ev ? `<td>${muted}</td>`
                    : `<td class="drop ${c.ev.reached ? 'reached' : (c.ev.remainingDropPct <= 5 ? 'near' : 'far')}" title="${c.ev.reached ? 'トリガー超過（到達）' : 'あとこれだけ下落で到達'}">${c.ev.remainingDropPct.toFixed(1)}%</td>`,
  dropPrev:  (s,c) => { const v = calc.remainingDropPrev(s); return v == null ? `<td>${muted}</td>` : `<td class="drop ${v <= 0 ? 'reached' : (v <= 5 ? 'near' : 'far')}" title="前日終値時点で次回購入(トリガー)まで">${v.toFixed(1)}%</td>`; },
  high5y:    (s,c) => `<td>${c.high5y != null ? fmtAmt(c.high5y, c.market) : muted}</td>`,
  high52w:   (s,c) => `<td>${c.high52w != null ? fmtAmt(c.high52w, c.market) : muted}</td>`,
  dropFrom5y:  (s,c) => pctTd(calc.dropFrom5y(s)),
  dropFrom52w: (s,c) => pctTd(calc.dropFrom52w(s)),
  low1y:    (s,c) => `<td>${c.low1y != null ? fmtAmt(c.low1y, c.market) : muted}</td>`,
  low3y:    (s,c) => `<td>${c.low3y != null ? fmtAmt(c.low3y, c.market) : muted}</td>`,
  riseFrom1y: (s,c) => pctTd(calc.riseFrom1y(s)),
  riseFrom3y: (s,c) => pctTd(calc.riseFrom3y(s)),
  prevBuyPrice: (s,c) => { const lb = calc.lastBuyInfo(s); return `<td>${lb.price != null ? (lb.source === 'みなし' ? MINASHI : '') + fmtAmt(lb.price, c.market) : muted}</td>`; },
  // 前回購入日: 判定に使う実効値（取引履歴の最新買い日→無ければ手動入力の前回購入日）
  prevBuyDate: (s,c) => { const d = calc.lastBuyInfo(s).date; return `<td class="l">${d ? esc(d) : muted}</td>`; },
  earnPrev: (s,c) => { const t = earnPrevText(s); return `<td class="l" title="前回決算発表日">${t === '-' ? muted : esc(t)}</td>`; },
  // 次回決算（予定＝確定 / ごろ＝前回+4ヶ月の推定を含む）。ソートは実効日で近い順。
  earnNext: (s,c) => { const eff = earnEffNext(s); if (!eff) return `<td class="l" title="次回決算">${muted}</td>`; const days = earnNextDays(s); const dtxt = (days != null && days >= 0 && days <= 60) ? ` <span class="muted">(あと${days}日)</span>` : ''; return `<td class="l" title="次回決算（予定/推定込み）">${esc(fmtEarnYMD(eff.date))} <span class="muted">${eff.kind}</span>${dtxt}</td>`; },
  dropFromPrev: (s,c) => pctTd(calc.dropFromPrev(s)),
  sector:    (s,c) => { const v = calc.field(s,'sector'); return `<td class="l">${v ? esc(jpInd(v)) : muted}</td>`; },
  industry:  (s,c) => { const v = calc.field(s,'industry'); return `<td class="l">${v ? esc(jpInd(v)) : muted}</td>`; },
  // 時価総額: 兆/億/万（米株は$T/B）表記に統一（売買代金と同形式）。marketCapは百万単位なので×1e6で実額化
  marketCap: (s,c) => { const v = calc.marketCap(s); return `<td title="時価総額">${v != null ? fmtTurnover(v * 1e6, c.market) : muted}</td>`; },
  // 時価1位まで: 市場の時価総額1位まで何倍か（5T/1T＝5.00倍＝+400%）。タイトルに1位の銘柄・時価総額・％を出す
  // （セルHTMLは capToTopTd。保有銘柄・銘柄マスタ・マーケットのランキングで同じ見た目にするため共通化）
  capToTop:  (s,c) => capToTopTd(s.market, calc.capToTop(s)),
  turnover:  (s,c) => { const v = calc.turnover(s); return `<td title="現在値×当日出来高">${v != null ? fmtTurnover(v, c.market) : muted}</td>`; },
  value:     (s,c) => `<td>${c.th.qty ? fmtAmt(c.valN, c.market) + c.noPriceMark : muted}</td>`,
  cost:      (s,c) => `<td>${c.th.qty ? c.m(c.th.acquiredCost) : muted}</td>`,
  // 購入額（本来）: 保有レコードごとに 売却前購入額(あれば) or 取得価額 を合算。損出しで売却後も最初の購入額を残す用途
  origCost:  (s,c) => { const v = calc.originalCostNative(s); return `<td title="売却前購入額があればそれ・無ければ取得価額を保有ごとに合算">${v ? c.m(v) : muted}</td>`; },
  // 取得円(円): 米株=保有のacqJpy(取得円)合計（取込/手入力したもの）、日本株=取得単価×数量
  acqJpy:    (s,c) => {
    let v = null;
    if (s.market === 'US') { const hs = store.data.holdings.filter(h => h.securityId === s.id); if (hs.some(h => h.acqJpy != null)) v = Math.round(hs.reduce((a, h) => a + (h.acqJpy || 0), 0)); }
    else v = c.th.qty ? Math.round(c.th.avgCost * c.th.qty) : null;
    return `<td>${v != null ? num(v) : muted}</td>`;
  },
  // 資産に占める割合（円換算ベース）。分母は ratioCtx（ツールバーの「比率の分母」）
  ratioValue: (s,c) => ratioTd(s, 'value'),
  ratioCost:  (s,c) => ratioTd(s, 'cost'),
  pnl:       (s,c) => pctTd(c.pnlPct),
  avgCost:   (s,c) => `<td>${c.th.qty ? fmtAmt(c.th.avgCost, c.market) : muted}</td>`,
  qty:       (s,c) => `<td>${c.th.qty ? fmtQty(c.th.qty, c.market) : '<span class="muted">0</span>'}</td>`,
  buyCount:  (s,c) => `<td>${c.buyCnt ? num(c.buyCnt) : muted}</td>`,
  buyAmount: (s,c) => `<td>${c.buyAmt != null ? fmtAmtInt(c.buyAmt) : muted}</td>`,
  reco:      (s,c) => `<td>${c.recoAmt ? fmtAmtInt(c.recoAmt) : muted}</td>`,
  category:  (s,c) => `<td class="l">${categoryTag(s.category)}</td>`,
  investCategory: (s,c) => `<td class="l">${investCategoryTag(s.investCategory)}</td>`,
  labels:    (s,c) => `<td class="l">${labelsTag(s)}</td>`,
  ruleName:  (s,c) => { const r = store.rule(s.ruleId); return `<td class="l">${r ? esc(r.name) : muted}</td>`; },
  fixedBuyPrice: (s,c) => `<td>${typeof s.fixedBuyPrice === 'number' ? fmtAmt(s.fixedBuyPrice, c.market) : muted}</td>`,
  addonFromHigh: (s,c) => `<td class="l">${s.addonFromHigh ? '<span class="tag" title="買い増しも初回基準（基準高値×初回下落率）でトリガー固定">初回基準</span>' : muted}</td>`,
  rating:    (s,c) => `<td class="l">${gradeBadge(s)}</td>`,
  per:       (s,c) => { const v = calc.per(s); return `<td>${v != null ? num(v) : muted}</td>`; },
  pbr:       (s,c) => { const v = calc.pbr(s); return `<td>${v != null ? num(v) : muted}</td>`; },
  psr:       (s,c) => { const v = calc.psr(s); return `<td>${v != null ? num(v) : muted}</td>`; },
  dividend:  (s,c) => { const v = calc.field(s,'dividend'); return `<td>${v != null ? c.m(v) : muted}</td>`; },
  divYield:  (s,c) => { const v = calc.divYield(s); return `<td>${v != null ? v.toFixed(2) + '%' : muted}</td>`; },
  // 取得利回り＝1株配当÷取得単価。取得時点のコストに対する配当利回り（簿価利回り）。
  yieldOnCost: (s,c) => { const v = calc.yieldOnCost(s); return `<td title="取得単価ベースの配当利回り（1株配当÷取得単価）">${v != null ? v.toFixed(2) + '%' : muted}</td>`; },
  eps:       (s,c) => { const v = calc.field(s,'eps'); return `<td>${v != null ? c.m(v) : muted}</td>`; },
  // 目標指標から逆算した株価（参考値）。目標値が未入力・元データ未取得なら「—」。title に根拠を出す
  targetPerPrice: (s,c) => { const v = calc.targetPerPrice(s); const e = calc.field(s,'eps');
    return `<td title="${s.targetPer > 0 ? `目標PER ${num(s.targetPer)} × EPS ${e != null ? num(e) : '—'}` : '目標PER 未設定'}">${v != null ? fmtAmt(v, c.market) : muted}</td>`; },
  targetPbrPrice: (s,c) => { const v = calc.targetPbrPrice(s); const b = calc.pbr(s);
    return `<td title="${s.targetPbr > 0 ? `目標PBR ${num(s.targetPbr)}（現在PBR ${b != null ? num(b) : '—'}）` : '目標PBR 未設定'}">${v != null ? fmtAmt(v, c.market) : muted}</td>`; },
  targetYieldPrice: (s,c) => { const v = calc.targetYieldPrice(s); const d = calc.dividendPerShare(s);
    return `<td title="${s.targetYield > 0 ? `目標利回り ${num(s.targetYield)}% ÷ 1株配当 ${d != null ? fmtAmt(d, c.market) : '—'}` : '目標利回り 未設定'}">${v != null ? fmtAmt(v, c.market) : muted}</td>`; },
  // 信用倍率（日本株のみ・週次）。最新＋前週分。値クリックで信用残時系列ページを開く。
  marginRatio: (s,c) => {
    if (s.market !== 'JP') return `<td>${muted}</td>`;
    const meta = calc.metaOf(s); const r = meta.marginRatio;
    if (r == null) return `<td>${muted}</td>`;
    const url = `https://finance.yahoo.co.jp/quote/${esc(s.ticker)}.T/history?styl=margin`;
    const prev = meta.marginRatioPrev != null ? ` <span class="muted" style="font-size:10px" title="前週 ${esc(meta.marginDatePrev || '')}">(前週 ${num(meta.marginRatioPrev)})</span>` : '';
    return `<td title="信用倍率 ${esc(meta.marginDate || '')}（クリックで信用残時系列）"><a href="${url}" target="_blank" rel="noopener" class="lnk-ext">${num(r)}</a>${prev}</td>`;
  },
  overallGrade: (s,c) => `<td class="l">${s.overallGrade ? `<span class="grade grade-${esc(String(s.overallGrade).toLowerCase())}">${esc(s.overallGrade)}</span>` : muted}</td>`,
  buyGrade:  (s,c) => `<td class="l">${s.buyGrade ? `<span class="grade grade-${esc(String(s.buyGrade).toLowerCase())}">${esc(s.buyGrade)}</span>` : muted}</td>`,
  priority:  (s,c) => `<td>${s.priority != null ? num(s.priority) : muted}</td>`,
  stars:     (s,c) => { const a = [s.starValuation, s.starStrength, s.starRisk]; return `<td class="l">${a.some(x => x != null) ? a.map(x => x ?? '—').join('/') : muted}</td>`; },
  analysisDate: (s,c) => `<td class="l">${s.analysisDate ? esc(s.analysisDate) : muted}</td>`,
  analysisNote: (s,c) => `<td class="l" title="${esc(s.analysisNote || '')}">${s.analysisNote ? esc(String(s.analysisNote).slice(0, 24)) + (s.analysisNote.length > 24 ? '…' : '') : muted}</td>`,
  // 株価シナリオ: 弱/ベ/強の3レンジを1セルに（列を増やしすぎない・2026-08-25 すみぽん決定）
  stScenario:   (s,c) => scenarioTd(s, 'st'),
  mtScenario:   (s,c) => scenarioTd(s, 'mt'),
  stScenPos:    (s,c) => scenarioPosTd(s, 'st'),
  mtScenPos:    (s,c) => scenarioPosTd(s, 'mt'),
  scenarioDate: (s,c) => `<td class="l">${s.scenarioDate ? esc(s.scenarioDate) : muted}</td>`,
  scenarioPrice: (s,c) => `<td title="シナリオ分析時点の株価${s.scenarioDate ? `（${esc(s.scenarioDate)}）` : ''}">${typeof s.scenarioPrice === 'number' ? fmtAmt(s.scenarioPrice, c.market) : muted}</td>`,
  memo:      (s,c) => `<td class="l" title="${esc(s.memo || '')}">${s.memo ? esc(String(s.memo).slice(0, 24)) + (s.memo.length > 24 ? '…' : '') : muted}</td>`,
  // 元本売却（情報管理のみ）。金額は銘柄の原通貨
  principalSold:       (s,c) => `<td class="l">${s.principalSold ? '<span class="tag">売却済</span>' : muted}</td>`,
  principalSoldAmount: (s,c) => `<td>${s.principalSoldAmount != null ? fmtAmt(s.principalSoldAmount, c.market) : muted}</td>`,
  // テクニカル分析（分析タブ）。スコアは0-100で色分け。値は techAnalysis から取得。
  anaTotal:    (s,c) => anaScoreCell(techComposite(s)),
  anaTrend:    (s,c) => anaScoreCell(techSideScore(s, 'trend')),
  anaContra:   (s,c) => anaScoreCell(techSideScore(s, 'contra')),
  anaUndercut: (s,c) => anaPatCell(s, 'undercutRally'),
  anaClimax:   (s,c) => anaPatCell(s, 'sellingClimax'),
  anaRsiDiv:   (s,c) => anaPatCell(s, 'rsiDivergence'),
  anaBoll:     (s,c) => anaPatCell(s, 'bollingerRecover'),
  anaMaDev:    (s,c) => anaPatCell(s, 'maDeviation'),
  anaGap:      (s,c) => anaPatCell(s, 'gapFill'),
  anaVolDry:   (s,c) => anaPatCell(s, 'volDryUp'),
  anaCup:      (s,c) => anaPatCell(s, 'cup'),
  anaRange:    (s,c) => anaPatCell(s, 'range'),
  anaWbottom:  (s,c) => anaPatCell(s, 'doubleBottom'),
  anaAsc:      (s,c) => anaPatCell(s, 'ascTriangle'),
  anaRound:    (s,c) => anaPatCell(s, 'roundBottom'),
  anaInvHS:    (s,c) => anaPatCell(s, 'invHS'),
  anaFlag:     (s,c) => anaPatCell(s, 'flag'),
  anaBase:     (s,c) => anaPatCell(s, 'baseOnBase'),
  anaWarn:     (s,c) => anaWarnCell(techWarnSide(s, 'trend')),
  anaWarnC:    (s,c) => anaWarnCell(techWarnSide(s, 'contra')),
  anaHsTop:    (s,c) => anaWarnPatCell(s, 'hsTop'),
  anaDblTop:   (s,c) => anaWarnPatCell(s, 'doubleTop'),
  anaNewLow:   (s,c) => anaWarnPatCell(s, 'newLowHighVol'),
  anaBearFlag: (s,c) => anaWarnPatCell(s, 'bearFlag'),
  anaDescTri:  (s,c) => anaWarnPatCell(s, 'descTriangle'),
  anaMa200:    (s,c) => { const r = techOf(s); if (!r || !r.ma200Pos) return `<td class="l">${muted}</td>`; const pos = r.ma200Pos === 'above' ? '上' : r.ma200Pos === 'below' ? '下' : '—'; const sl = r.ma200Slope === 'up' ? '↗' : r.ma200Slope === 'down' ? '↘' : ''; const ok = r.ma200Pos === 'above' && r.ma200Slope === 'up'; return `<td class="l" style="color:${ok ? 'var(--green)' : 'var(--muted)'};font-weight:600" title="順張りの確認＝株価が200日線の上＆上向き">${pos}${sl}</td>`; },
  ana5d:       (s,c) => { const r = techOf(s); if (!r || r.above5 == null) return `<td class="l">${muted}</td>`; return `<td class="l" style="color:${r.above5 ? 'var(--green)' : 'var(--muted)'};font-weight:600" title="逆張りの確認＝終値が5日線の上（短期反転の兆し）">${r.above5 ? '上' : '下'}</td>`; },
  anaDev52w:   (s,c) => { const r = techOf(s); if (!r || r.dev52w == null) return `<td>${muted}</td>`; const v = r.dev52w; const col = v <= -25 ? 'var(--green)' : v >= -5 ? 'var(--muted)' : 'var(--amber)'; return `<td style="text-align:right;color:${col};font-weight:600" title="52週高値からの乖離。-25%以下で逆張りの売られすぎ確認">${v > 0 ? '+' : ''}${Math.round(v)}%</td>`; },
  anaRSI:      (s,c) => { const r = techOf(s); if (!r || r.rsi == null) return `<td>${muted}</td>`; const col = r.rsi <= 30 ? 'var(--green)' : r.rsi >= 70 ? 'var(--red)' : 'var(--text)'; return `<td style="text-align:right;color:${col};font-weight:600">${Math.round(r.rsi)}</td>`; },
  anaMACD:     (s,c) => { const r = techOf(s); if (!r || !r.macdCross) return `<td class="l">${muted}</td>`; const map = { golden: ['GC', 'var(--green)'], dead: ['DC', 'var(--red)'], none: ['—', 'var(--muted)'] }; const [lbl, col] = map[r.macdCross] || map.none; return `<td class="l" style="color:${col}">${lbl}</td>`; },
  anaStatus:   (s,c) => { const r = techOf(s); const b = r && r.best; return `<td class="l">${b ? `<span style="color:${anaStatusColor(b.status)};font-weight:600">${esc(TA.STATUS_LABEL[b.status])}</span>` : muted}</td>`; },
  anaBuy:      (s,c) => { const v = techLevel(s, 'buy'); return `<td>${v != null ? `<span style="color:var(--green)">${fmtAmt(v, c.market)}</span>` : muted}</td>`; },
  anaFail:     (s,c) => { const v = techLevel(s, 'fail'); return `<td>${v != null ? `<span style="color:var(--red)">${fmtAmt(v, c.market)}</span>` : muted}</td>`; },
  anaDate:     (s,c) => { const r = techOf(s); return `<td class="l muted" style="font-size:11px">${r && r.lastAnalyzed ? esc(r.lastAnalyzed) : '<span style="color:var(--amber)">未分析</span>'}</td>`; },
};

// ----- テクニカル分析の値ヘルパ（COL_RENDERERS／sortValue／cfCellValue から共用） -----
function techOf(sec) { return store.data.techAnalysis[priceKey(sec)] || null; }
// 総合＝確認ゲート方式（単独はキャップ・確認が増えるほど高得点）。旧データ(totalScore無し)は best.score にフォールバック。
// 総合は保存済み patterns から「その場で再計算」する（集計式を変えても再分析なしで最新値になる）。
// 旧データ(patterns無し)のみ保存済みの値/best にフォールバック。
function techTotals(sec) { const r = techOf(sec); if (!r) return null; if (r.patterns && TA.recomputeTotals) { const t = TA.recomputeTotals(r); if (t) return t; } return { trendTotal: r.trendTotal, contraTotal: r.contraTotal, totalScore: r.totalScore }; }
function techComposite(sec) { const r = techOf(sec); if (!r) return null; const t = techTotals(sec); if (t && t.totalScore != null) return t.totalScore; return r.best ? r.best.score : null; }
function techSideScore(sec, side) { const r = techOf(sec); if (!r) return null; const t = techTotals(sec); const v = t ? (side === 'trend' ? t.trendTotal : t.contraTotal) : null; if (v != null) return v; const b = side === 'trend' ? r.bestTrend : r.bestContra; return b ? b.score : null; }
// そのサイドで最強の「単独パターン」（名前＋強さ）。総合とは別に“何が点灯しているか”を示す情報用。
function techBestPattern(sec, side) { const r = techOf(sec); return r ? (side === 'trend' ? r.bestTrend : r.bestContra) : null; }
// パターンの素点（0-100）。分析済みなら status に関わらず常に数値を返す（未確認=部分一致でも「近さ」を出す）。未分析/未計算のみ null。
function techPatScore(sec, pat) { const r = techOf(sec); return r && r.patterns && r.patterns[pat] ? r.patterns[pat].score : null; }
function techPat(sec, pat) { const r = techOf(sec); return r && r.patterns && r.patterns[pat] ? r.patterns[pat] : null; }
// パターン列セル：分析済みは常に数値。status0=未確認(灰)、status4=失敗(赤+✕)、status1-3=強さ色。未分析のみ「—」。
function anaPatCell(sec, pat) {
  const p = techPat(sec, pat);
  if (!p) return `<td style="text-align:right">${muted}</td>`;
  const v = p.score;
  if (p.status === 0) return `<td style="text-align:right" title="未確認（条件は未成立・形だけの部分一致）"><span style="color:var(--muted);font-weight:500">${v}</span></td>`;
  if (p.status === 4) return `<td style="text-align:right" title="失敗・崩れ（このパターンは否定材料）"><span style="color:var(--red);font-weight:700">${v}<span style="font-size:9px;vertical-align:1px">✕</span></span></td>`;
  return `<td style="text-align:right"><span style="color:${anaScoreColor(v)};font-weight:700">${v}</span></td>`;
}
// 警戒シグナルをサイド別に取得。trend=天井(三尊/ダブルトップ) / contra=底抜け継続(安値更新+出来高/ベアフラッグ/下降三角)。
function techWarnSide(sec, side) {
  const r = techOf(sec); if (!r || !r.patterns) return null;
  const list = side === 'trend' ? (TA.WARN_PATTERNS || []) : (TA.CONTRA_WARN_PATTERNS || []);
  let best = null;
  for (const p of list) { const x = r.patterns[p]; if (!x || x.status === 0) continue; if (!best || x.score > best.score) best = { pattern: p, score: x.score, status: x.status }; }
  return best;
}
function anaWarnCell(w) { return `<td class="l">${w ? `<span style="color:var(--red);font-weight:600">${esc(TA.PATTERN_LABEL[w.pattern] || '')} ${w.score}</span>` : muted}</td>`; }
// 警戒パターンの個別セル：点灯（status≥1）は赤、未点灯(status0)は灰。買いパターンと違い高スコア＝危険なので赤系。
function anaWarnPatCell(sec, pat) {
  const p = techPat(sec, pat);
  if (!p) return `<td style="text-align:right">${muted}</td>`;
  if (p.status === 0) return `<td style="text-align:right" title="未点灯（部分一致）"><span style="color:var(--muted);font-weight:500">${p.score}</span></td>`;
  return `<td style="text-align:right" title="警戒点灯（売り材料）"><span style="color:var(--red);font-weight:700">${p.score}</span></td>`;
}
function techLevel(sec, kind) {
  const r = techOf(sec); if (!r || !r.best || !r.levels) return null;
  const lv = r.levels[r.best.pattern]; if (!lv) return null;
  return kind === 'buy' ? (lv.breakLevel ?? lv.neckline ?? lv.resistance ?? null) : (lv.failLevel ?? null);
}
function anaScoreColor(v) { return v == null ? 'var(--muted)' : v >= 80 ? 'var(--green)' : v >= 60 ? '#0ea5e9' : v >= 40 ? 'var(--amber)' : 'var(--muted)'; }
function anaStatusColor(st) { return ({ 3: 'var(--green)', 2: '#0ea5e9', 1: 'var(--muted)', 4: 'var(--red)' })[st] || 'var(--muted)'; }
function anaScoreCell(v) { return `<td style="text-align:right"><span style="color:${anaScoreColor(v)};font-weight:700">${v == null ? '—' : v}</span></td>`; }

// ---------- SEC-94: 一覧のExcel風インライン編集モード ----------
// 編集モード（誤操作防止のトグル）。ONの間だけ対象セルが入力欄になる。米国株/日本株/銘柄マスタ共通。
let inlineEditOn = false;
// ナビゲーション用: 現在テーブルの編集可能列キー順(_ieCols) / 行(銘柄ID)順(_ieRowIds)
let _ieCols = [], _ieRowIds = [];

// 数値文字列 → number|null（空欄や非数値は null）
function ieNum(v) { const t = String(v ?? '').trim(); if (t === '') return null; const n = parseFloat(t); return isNaN(n) ? null : n; }
// 当該銘柄の保有が「ちょうど1件」の時だけインライン編集可（0件/複数は保有フォームへ誘導）
function ieSingleHolding(secId) { const hs = store.data.holdings.filter(h => h.securityId === secId); return hs.length === 1 ? hs[0] : null; }

// 編集対象フィールド定義。kind:'sec'=銘柄属性（store.updateSecurity） / 'hold'=単一保有（数量・取得単価）
// split:true は分割調整に関わる項目（変更時のみ manualUpdatedAt を更新＝フォームと同じ。SEC-34）
const INLINE_FIELDS = {
  category:      { kind: 'sec', type: 'select', get: s => s.category || '', patch: v => ({ category: v || null }),
                   options: () => [{ v: '', l: '未設定' }, ...[...store.data.categories].sort((a, b) => a.sortOrder - b.sortOrder).map(c => ({ v: c.category, l: c.category }))] },
  investCategory: { kind: 'sec', type: 'select', get: s => s.investCategory || '', patch: v => ({ investCategory: v || null }),
                   options: () => [{ v: '', l: '未設定' }, ...[...store.data.investCategories].sort((a, b) => a.sortOrder - b.sortOrder).map(c => ({ v: c.name, l: c.name }))] },
  ruleName:      { kind: 'sec', type: 'select', get: s => String(s.ruleId || store.defaultRule().id), patch: v => ({ ruleId: parseInt(v, 10) }),
                   options: () => store.data.rules.map(r => ({ v: String(r.id), l: r.name + (r.isDefault ? '（既定）' : '') })) },
  detailType:    { kind: 'sec', type: 'select', get: s => s.detailType || '', patch: v => ({ detailType: v || null }),
                   options: (s) => [{ v: '', l: '自動（' + autoDetailType(s) + '）' }, { v: '個別株', l: '個別株' }, { v: 'ETF', l: 'ETF' }] },
  prevBuyPrice:  { kind: 'sec', type: 'number', split: true, get: s => s.prevBuyPrice ?? '', patch: v => ({ prevBuyPrice: ieNum(v) }) },
  prevBuyDate:   { kind: 'sec', type: 'date',   get: s => s.prevBuyDate || '', patch: v => ({ prevBuyDate: v || null }) },
  fixedBuyPrice: { kind: 'sec', type: 'number', split: true, get: s => s.fixedBuyPrice ?? '', patch: v => ({ fixedBuyPrice: ieNum(v) }) },
  principalSold: { kind: 'sec', type: 'select', get: s => s.principalSold ? '1' : '', patch: v => ({ principalSold: v === '1' }),
                   options: () => [{ v: '', l: '—' }, { v: '1', l: '売却済' }] },
  principalSoldAmount: { kind: 'sec', type: 'number', get: s => s.principalSoldAmount ?? '', patch: v => ({ principalSoldAmount: ieNum(v) }) },
  buyAmount:     { kind: 'sec', type: 'number', get: s => s.buyAmount ?? '', patch: v => ({ buyAmount: ieNum(v) }) },
  buyCount:      { kind: 'sec', type: 'number', get: s => s.buyCount ?? '', patch: v => ({ buyCount: v === '' ? null : (parseInt(v, 10) || 0) }) },
  memo:          { kind: 'sec', type: 'text', get: s => s.memo || '', patch: v => ({ memo: v.trim() || null }) },
  analysisNote:  { kind: 'sec', type: 'text', get: s => s.analysisNote || '', patch: v => ({ analysisNote: v.trim() || null }) },
  qty:           { kind: 'hold', type: 'number', field: 'quantity', get: h => h.quantity ?? '' },
  avgCost:       { kind: 'hold', type: 'number', field: 'avgCost', get: h => h.avgCost ?? '' },
};

// 1セル分の編集用 <td> を返す（編集不可・非該当は null を返し呼び出し側で通常レンダラーへフォールバック）
function ieCellHtml(sec, key, ctx) {
  const f = INLINE_FIELDS[key];
  if (!f) return null;
  const market = sec.market;
  // 数値欄は type="text" + inputmode（上下キーで増減しない＝直接入力のみ）。保存は明示ボタン式なので onchange では store へ書かない
  const attrs = `data-id="${sec.id}" data-k="${key}" onkeydown="ieKey(event)"`;
  if (f.kind === 'hold') {
    const h = ieSingleHolding(sec.id);
    if (!h) { // 0件 or 複数保有 → クリックで保有フォームを開く（数量/単価は口座別のため一意に決められない）
      const th = ctx ? ctx.th : calc.totalHolding(sec.id);
      const disp = key === 'qty' ? (th.qty ? fmtQty(th.qty, market) : '0') : (th.qty ? fmtAmt(th.avgCost, market) : '—');
      const n = store.data.holdings.filter(x => x.securityId === sec.id).length;
      const tip = n > 1 ? '複数保有のため保有フォームで編集' : '保有フォームで追加';
      return `<td class="ie-link" onclick="openHoldingsForm(${sec.id})" title="${tip}">${disp} <span class="ie-formmark">⧉</span></td>`;
    }
    const dv = esc(String(f.get(h) ?? ''));
    return `<td class="ie-cell"><input class="ie-input ie-num" type="text" inputmode="decimal" autocomplete="off" value="${dv}" onfocus="this.select()" oninput="ieMark(this)" ${attrs}></td>`;
  }
  const val = f.get(sec);
  if (f.type === 'select') {
    const opts = f.options(sec).map(o => `<option value="${esc(o.v)}" ${o.v === val ? 'selected' : ''}>${esc(o.l)}</option>`).join('');
    return `<td class="ie-cell"><select class="ie-input" oninput="ieMark(this)" ${attrs}>${opts}</select></td>`;
  }
  const dv = esc(String(val ?? ''));
  if (f.type === 'date') return `<td class="ie-cell"><input class="ie-input ie-date" type="date" value="${dv}" oninput="ieMark(this)" ${attrs}></td>`;
  // 自由記述（メモ・分析メモ）は左寄せテキスト入力（decimal入力モードにしない）。改行はインラインでは扱えないため単一行編集
  if (f.type === 'text') return `<td class="ie-cell"><input class="ie-input ie-text l" type="text" autocomplete="off" value="${dv}" oninput="ieMark(this)" ${attrs}></td>`;
  return `<td class="ie-cell"><input class="ie-input ie-num" type="text" inputmode="decimal" autocomplete="off" value="${dv}" onfocus="this.select()" oninput="ieMark(this)" ${attrs}></td>`;
}

// セルが store の値から変化しているか
function ieCellChanged(el) {
  const id = parseInt(el.dataset.id, 10), key = el.dataset.k, f = INLINE_FIELDS[key];
  const sec = store.data.securities.find(s => s.id === id); if (!f || !sec) return false;
  if (f.kind === 'hold') { const h = ieSingleHolding(id); if (!h) return false; return (h[f.field] ?? 0) !== (ieNum(el.value) ?? 0); }
  return String(f.get(sec)) !== String(el.value).trim();
}
// 入力のたびに変更（未保存）ハイライトと件数表示を更新
function ieMark(el) { el.classList.toggle('ie-dirty', ieCellChanged(el)); ieUpdatePending(); }
function ieDirty() { return [...document.querySelectorAll('.ie-input')].some(ieCellChanged); }
function ieUpdatePending() {
  const el = document.getElementById('ie-pending'); if (!el) return;
  const n = [...document.querySelectorAll('.ie-input')].filter(ieCellChanged).length;
  el.textContent = n ? `未保存 ${n} 件` : '変更なし';
  el.classList.toggle('has-pending', n > 0);
}
// 1セルを store へ確定（変化が無ければ false）。保存ボタンから一括で呼ぶ
function ieCommitEl(el) {
  if (!ieCellChanged(el)) return false;
  const id = parseInt(el.dataset.id, 10), key = el.dataset.k, f = INLINE_FIELDS[key];
  const sec = store.data.securities.find(s => s.id === id); if (!f || !sec) return false;
  if (f.kind === 'hold') { const h = ieSingleHolding(id); if (!h) return false; h[f.field] = ieNum(el.value) ?? 0; h.source = 'manual'; h.updatedAt = store._now(); store.save(); return true; }
  const patch = f.patch(el.value);
  if (f.split) { const k = Object.keys(patch)[0]; if ((sec[k] ?? null) !== (patch[k] ?? null)) patch.manualUpdatedAt = store._now(); }
  store.updateSecurity(id, patch); return true;
}
// 「保存」: 入力欄の値をまとめて store へ確定し、派生列も含めて再描画
function ieSaveAll() {
  let n = 0; document.querySelectorAll('.ie-input').forEach(el => { if (ieCommitEl(el)) n++; });
  preserveTableScroll(render);
  toast(n ? `${n} 件を保存しました` : '変更はありませんでした');
}
// 「取消（破棄）」: 入力中の変更を捨てて store の値に戻す
function ieDiscardAll() {
  if (ieDirty() && !confirm('入力した変更を破棄して元に戻しますか？')) return;
  preserveTableScroll(render);
}

// Excel風キー移動: Enter=下 / Shift+Enter=上 / Tab=右 / Shift+Tab=左 / Esc=このセルを取消。
// 保存は明示ボタン式なので移動では store へ書かない（間違えても保存前なら戻せる）。
function ieKey(e) {
  const el = e.target, k = e.key;
  if (k === 'Enter') { e.preventDefault(); ieNav(el, e.shiftKey ? 'up' : 'down'); }
  else if (k === 'Tab') { e.preventDefault(); ieNav(el, e.shiftKey ? 'left' : 'right'); }
  else if (k === 'Escape') { e.preventDefault(); ieRevert(el); }
}
// このセルだけ store の値に戻す
function ieRevert(el) {
  const id = parseInt(el.dataset.id, 10), key = el.dataset.k, f = INLINE_FIELDS[key];
  const sec = store.data.securities.find(s => s.id === id);
  if (f && sec) { if (f.kind === 'hold') { const h = ieSingleHolding(id); el.value = h ? (f.get(h) ?? '') : ''; } else el.value = f.get(sec); }
  el.classList.remove('ie-dirty'); ieUpdatePending(); el.blur();
}
// 次の入力欄へフォーカス移動。入力欄でない行（保有複数等）は飛ばして探索。端で停止。
function ieNav(el, dir) {
  let ci = _ieCols.indexOf(el.dataset.k), ri = _ieRowIds.indexOf(parseInt(el.dataset.id, 10));
  if (ci < 0 || ri < 0 || !_ieCols.length) return;
  const find = (r, c) => document.querySelector(`.ie-input[data-id="${_ieRowIds[r]}"][data-k="${_ieCols[c]}"]`);
  let guard = _ieCols.length * _ieRowIds.length + 1;
  while (guard-- > 0) {
    if (dir === 'right') { ci++; if (ci >= _ieCols.length) { ci = 0; ri++; } }
    else if (dir === 'left') { ci--; if (ci < 0) { ci = _ieCols.length - 1; ri--; } }
    else if (dir === 'down') ri++;
    else if (dir === 'up') ri--;
    if (ri < 0 || ri >= _ieRowIds.length) return;
    const t = find(ri, ci);
    if (t) { t.focus(); if (t.tagName === 'INPUT' && t.select) { try { t.select(); } catch (_) {} } return; }
  }
}
function toggleInlineEdit() {
  // 未保存の変更があるまま終了しようとしたら確認（誤って閉じてのロスを防ぐ）
  if (inlineEditOn && ieDirty() && !confirm('保存していない変更があります。破棄して編集モードを終了しますか？')) return;
  inlineEditOn = !inlineEditOn; preserveTableScroll(render);
}
// コード・銘柄名（と先頭の選択列）を横スクロール時に左端固定。table-layout/auto 両対応。
// 既定は先頭から連続する「選択列→コード→銘柄名」のみ固定（途中に他列が挟まる並べ替え時は固定しない＝レイアウト破綻防止）。
// scope（US/JP/SIGNAL/MKTRANK/ANALYSIS等）を渡すと、列設定の「列の固定」（colPrefs['<scope>#sticky']＝
// 左から固定する表示列数。0=固定なし）を優先する（2026-08-25 すみぽん依頼）。
function applyStickyCols(table, scope) {
  if (!table || !table.tHead || !table.tBodies[0]) return;
  const headRow = table.tHead.rows[0];
  // 代表データ行は「ヘッダと同じ列数」の行を選ぶ。サインの🔴到達等のグループ見出し行（colspan＝1セル）を
  // 拾うとコード/銘柄名の列検出が壊れ、銘柄名が固定されない不具合になるため除外する。
  const bodyRow = [...table.tBodies[0].rows].find(r => r.cells.length === (headRow ? headRow.cells.length : 0));
  if (!headRow || !bodyRow) return;
  [...table.rows].forEach(r => [...r.cells].forEach(c => { if (c.colSpan > 1) return; c.classList.remove('stick', 'stick-edge'); c.style.left = ''; }));
  const fixedN = scope != null ? colStickyCount(scope) : null;
  const contiguous = [];
  if (fixedN != null) {
    // ユーザー指定: 表示列の左から fixedN 列（先頭に選択チェックボックス列がある表はそれも含めて固定）。0=固定なし
    if (fixedN > 0) {
      const hasSel = !!(bodyRow.cells[0] && bodyRow.cells[0].querySelector && bodyRow.cells[0].querySelector('input[type="checkbox"]'));
      const total = Math.min((hasSel ? 1 : 0) + fixedN, bodyRow.cells.length);
      for (let i = 0; i < total; i++) contiguous.push(i);
    }
  } else {
    const want = new Set([0]); // 先頭=選択(チェックボックス)列
    [...bodyRow.cells].forEach((td, i) => {
      if (i === 0) return;
      if (td.classList.contains('col-code')) want.add(i);                 // コード
      else if (td.querySelector && td.querySelector('.nm-strong')) want.add(i); // 銘柄名
    });
    for (let i = 0; want.has(i); i++) contiguous.push(i); // 0から連続するものだけ
  }
  let left = 0;
  contiguous.forEach((ci, n) => {
    const w = headRow.cells[ci] ? headRow.cells[ci].getBoundingClientRect().width : 0;
    [...table.rows].forEach(r => {
      const c = r.cells[ci]; if (!c || c.colSpan > 1) return; // 横結合(グループ見出し)セルは触らない＝inlineのleft:0固定を保つ
      c.classList.add('stick'); if (n === contiguous.length - 1) c.classList.add('stick-edge');
      c.style.left = left + 'px';
    });
    left += w;
  });
}

function render() {
  // この描画中だけ計算メモを有効化（evaluate/totalHolding/lastBuyInfo を銘柄ごとに1回に）。
  // 入れ子render時は最外側だけがメモの寿命を管理する。
  const memoOwner = !_calcMemo;
  if (memoOwner) calcMemoBegin();
  try {
    _render();
  } finally {
    if (memoOwner) calcMemoEnd();
  }
}
function _render() {
  updateHeader();
  ensureTopMarketCap();   // 「時価1位まで」列の分子（市場の時価総額1位）が未取得/前日なら裏で1回だけ取得
  // 比率列の分母（既定＝日米合計）。表を持つ画面は各 render 内で表示中の集合を渡して上書きする
  ratioCtx = buildRatioCtx(null);
  updateSignalBadge();
  updateSplitBadge();
  // 背景色ルールの適用先画面を現在ビューから決定（us/jp は保有銘柄と同じ列・描画なので holdings 扱い）
  cfScreen = ({ market: 'market', holdings: 'holdings', us: 'holdings', jp: 'holdings', signals: 'signal', secmaster: 'master', analysis: 'analysis' })[currentView] || 'holdings';
  switch (currentView) {
    case 'dashboard': renderDashboard(); break;
    case 'market': renderMarketTab(); break;
    case 'macro': renderMacro(); break;
    case 'news': renderNews(); break;
    case 'holdings': renderMarket(holdingsMarket); break;
    case 'us': renderMarket('US'); break;
    case 'jp': renderMarket('JP'); break;
    case 'signals': renderSignals(); break;
    case 'analysis': renderAnalysis(); break;
    case 'trade': renderTradeEntry(); break;
    case 'splits': renderSplitsTab(); break;
    case 'report': renderReport(); break;
    case 'secmaster': renderSecMaster(); break;
    case 'import': renderImport(); break;
    case 'transfer': renderTransfer(); break;
    case 'master': renderMaster(); break;
  }
  scheduleFit();
  // ランキング順位バッジはここ（タブ表示）では取得しない。株価更新時（api.refreshAll 末尾）にのみ取得する。
  // 以前は保有銘柄/株式/サインを開くたびに /api/ranking を叩き、遅延時にタブ表示が引っかかっていた。
}

// 一覧テーブルの枠(.table-wrap)の高さを画面に合わせて制限し、枠内スクロール＋見出し固定を成立させる。
// （横スクロールを枠内に保ったまま thead を固定するため。ページ全体は極力スクロールさせない）
// fitListTables を「レイアウト確定後」に実行する。初回描画/マーケットは中身が非同期で後から増えるため、
// 同期測定だと高さが小さく max-height が付かずページ全体がスクロールしてしまう（市場切替で再描画されると直る現象の原因）。
// 即時＋requestAnimationFrame（二重）＋タイムアウトの保険で、確定後の高さで枠内スクロール化する。
let _fitRaf = null;
function scheduleFit() {
  fitListTables();
  if (_fitRaf) cancelAnimationFrame(_fitRaf);
  _fitRaf = requestAnimationFrame(() => requestAnimationFrame(() => { _fitRaf = null; fitListTables(); }));
  setTimeout(fitListTables, 80);
}
// 一覧テーブルを「枠内スクロール」にする。実際のスクロール領域は body ではなく main.content（overflow-y:auto）。
// なので“あふれ”は main.content の scrollHeight−clientHeight で測り、その分だけ表の枠(.table-wrap)を縮めて
// main.content が一切スクロールしないようにする（＝外側スクロールなし・表の枠の中だけスクロール）。
// 収まっている時は何もしない（自然高さ。余白で引き伸ばさない）。
function fitListTables() {
  const main = document.querySelector('main.content');
  if (!main) return;
  fitUpdList();   // ダッシュボードの更新情報も残りスペースに合わせる（表より先に確定させる）
  // .macro-managed はマクロ指標タブが自前で高さを決める枠（macroFitTable）。ここで触ると
  // グラフ高さの計算と食い合って毎回ちらつくので対象外にする。
  const wraps = [...main.querySelectorAll('.section .table-wrap:not(.macro-managed)')];
  wraps.forEach(w => { w.style.maxHeight = ''; w.style.minHeight = ''; }); // 一旦解除して自然高さを測る
  if (!wraps.length) return;
  // main.content の縦あふれ量（>0 なら外側スクロールが出る状態）
  const overflow = main.scrollHeight - main.clientHeight;
  if (overflow <= 1) return; // 収まっている＝枠制限不要（保有銘柄が収まっている時はここで終わり）
  // 一番背の高い表の枠を、あふれた分だけ縮めて枠内スクロール化。
  // ただし「その枠を縮めれば収まる」場合だけ実施する（＝表が溢れの主因の単一テーブル系ビュー）。
  // 転記用のようにフォーム等の非テーブルが主因の時は、小さな表を縮めても二重スクロールになるだけなので
  // 何もしない（実コンテンツとしてページ＝main.content をスクロールさせる）。
  const w = wraps.reduce((a, b) => (b.offsetHeight > a.offsetHeight ? b : a), wraps[0]);
  if (w.offsetHeight - overflow >= 160) {
    w.style.maxHeight = (w.offsetHeight - overflow - 2) + 'px';
  }
}
// 指数マーキー: 指数がマーキー窓に収まるなら流さない（is-scrolling 無し＝静止）。あふれる時だけ
// 同内容を2連結して translateX(-50%) でシームレスに流す。窓幅は可変（リサイズ/ログイン警告の有無）なので
// 状態が変わった時だけ作り直す（不要な作り直しでアニメが先頭に戻るのを防ぐ）。ドル円は別要素で固定表示。
function layoutTickerMarquee() {
  const tickers = document.getElementById('tickers');
  if (!tickers) return;
  const marquee = tickers.querySelector('.tickers-marquee');
  const track = tickers.querySelector('.tickers-track');
  if (!marquee || !track) return;
  const idx = tickers._idxItems || '';
  const isDup = track.dataset.dup === '1';
  const singleW = isDup ? track.scrollWidth / 2 : track.scrollWidth; // 複製中は半分が単一内容の幅
  const need = singleW > marquee.clientWidth + 4;
  if (need && !isDup) {
    track.innerHTML = idx + idx; track.dataset.dup = '1';
    track.classList.add('is-scrolling'); marquee.classList.add('is-scrolling');
  } else if (!need && isDup) {
    track.innerHTML = idx; track.dataset.dup = '0';
    track.classList.remove('is-scrolling'); marquee.classList.remove('is-scrolling');
  }
}
let _fitTimer = null;
// ===== 別タブ／別ウィンドウの保存を取り込む（「時間が経つと元に戻る」の根本対策・2026-08-13）=====
// このアプリは同じブラウザで複数タブを開ける。store.data は**タブごとのメモリ**にあるのに、
// 同期の基準 sm_sync_base は localStorage で**全タブ共有**。そのため:
//   タブAで「日本」に変更→同期（Drive=jp / base=jp）→ 開きっぱなしのタブBのメモリは infl のまま
//   → タブBが同期すると base=jp / local(B)=infl / remote=jp となり「Bが意図的に infl に変えた」と
//      判定され、infl が Drive に押し戻される → しばらくして選択が元に戻る
// storage イベントは「変更したタブ以外」で発火するので、ここで読み直せば古い内容を持ち続けなくなる。
// マクロの表示グループだけでなく、タブ・列設定・設定全般で起きていた同じ症状の共通原因。
let _xtabTimer = null;
window.addEventListener('storage', (e) => {
  if (e.key && e.key !== STORAGE_KEY) return;   // 本体データ以外（同期base・トークン等）は無視
  clearTimeout(_xtabTimer);
  _xtabTimer = setTimeout(() => {
    try {
      store.load(); loadColPrefs(); loadFilterPresets();
      // techAnalysis は IndexedDB 保存（sm_data_v1 に無い）。別タブが分析を実行していた場合に備えて
      // IDB から読み直す（古いメモリのままだと、別タブ追加分が同期で「削除」と誤解釈されうる）
      if (idb.ok) idb.get('techAnalysis').then(v => { if (v && typeof v === 'object') store.data.techAnalysis = v; }).catch(() => {});
    } catch (_) { return; }
    // 入力中・モーダル/ドロワー表示中は描画し直さない（打鍵や編集中の内容を消さないため）。
    // データだけ取り込んでおけば、次の描画から新しい内容になる。
    const ae = document.activeElement;
    const editing = ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
    const overlayOpen = ['modal-overlay', 'drawer-overlay'].some(id => { const el = document.getElementById(id); return el && !el.hidden; });
    if (!editing && !overlayOpen) render();
  }, 150);
});
window.addEventListener('resize', () => { clearTimeout(_fitTimer); _fitTimer = setTimeout(() => { if (document.querySelector('#app .mx-table')) { fitMatrix(); sizeMatrixChips(); } fitListTables(); layoutTickerMarquee(); if (document.getElementById('portfolio-chart') && (_assetSnaps || []).length >= 2) renderAssetChart(); if (document.getElementById('macro-chart')) renderMacroChart(); }, 120); });

// 再描画をはさんでも一覧テーブルの横/縦スクロール位置を維持する（ソート・編集保存・一括変更等で左上に戻らないように）。
// 縦は .table-wrap（枠内スクロール）と main.content（ページ相当のスクロール。ルール6）の両方を保存する。
// ★復元は多段リトライ: fitListTables が遅れて max-height を付けるまで .table-wrap はスクロール不能で、
//   早いタイミングの復元だけだと 0 のまま確定してしまう（実害: 編集保存で表の一番上に戻る）。
function preserveTableScroll(fn) {
  const w = document.querySelector('#app .table-wrap');
  const main = document.querySelector('main.content');
  const sl = w ? w.scrollLeft : 0, st = w ? w.scrollTop : 0;
  const mt = main ? main.scrollTop : 0;
  fn();
  if (!(sl || st || mt)) return;
  const apply = () => {
    const w2 = document.querySelector('#app .table-wrap');
    if (w2) { w2.scrollLeft = sl; w2.scrollTop = st; }
    const m2 = document.querySelector('main.content');
    if (m2) m2.scrollTop = mt;
  };
  apply(); requestAnimationFrame(apply); setTimeout(apply, 30); setTimeout(apply, 150); setTimeout(apply, 350);
}

// colgroup の <col> タグ。auto=データ幅自動（描画後に実測）／既定=固定px
function colTag(c) {
  return c.auto ? `<col data-autocol="1" style="width:64px">` : `<col style="width:${colWidthPx(c)}px">`;
}
// 自動列（data-autocol）の幅を、ヘッダではなくデータセルの最大実描画幅に合わせて設定する。
// table-layout:fixed を保ったまま、オフスクリーンに各セルのHTMLを複製して幅を実測。
function autoFitColumns(table) {
  if (!table) return;
  const cols = [...table.querySelectorAll('colgroup col')];
  if (!cols.some(c => c.dataset.autocol === '1')) return;
  const sample = table.querySelector('tbody td');
  let font = '13px sans-serif';
  if (sample) { const cs = getComputedStyle(sample); font = (cs.font && cs.font.trim()) ? cs.font : `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; }
  // colspan のグループ見出し行などは列数が合わないので除外
  const rows = [...table.querySelectorAll('tbody tr')].filter(tr => tr.children.length === cols.length);
  // 一括計測: 計測用spanを全セルぶん先に生成→1回のレイアウトでまとめて offsetWidth を読む。
  // 旧実装は「span.innerHTML書換→offsetWidth読み」をセルごとに繰り返し、行×列ぶんの強制リフロー
  // （layout thrashing）で描画が約1秒かかっていた。書込を全て済ませてから読むso計測は1レイアウトで完了。
  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden';
  const spanCss = 'display:inline-block;white-space:nowrap;font:' + font;
  const items = []; // {ci, el}
  cols.forEach((col, ci) => {
    if (col.dataset.autocol !== '1') return;
    rows.forEach(tr => {
      const td = tr.children[ci]; if (!td) return;
      const s = document.createElement('span'); s.style.cssText = spanCss; s.innerHTML = td.innerHTML;
      holder.appendChild(s); items.push({ ci, el: s });
    });
  });
  document.body.appendChild(holder);
  const maxByCol = {};
  for (const it of items) { const w = it.el.offsetWidth; if (w > (maxByCol[it.ci] || 0)) maxByCol[it.ci] = w; } // 読取のみ＝レイアウトは1回
  holder.remove();
  cols.forEach((col, ci) => { if (col.dataset.autocol !== '1') return; col.style.width = Math.max(44, Math.ceil(maxByCol[ci] || 0) + 26) + 'px'; }); // +26 ≒ セル左右パディング
  let total = 0; cols.forEach(c => total += parseFloat(c.style.width) || 0);
  if (total) table.style.width = total + 'px';
}

function updateHeader() {
  const pt = document.getElementById('page-title');
  if (pt) pt.textContent = PAGE_TITLE[currentView] || '証券管理';
  const fx = calc.fx();
  // トップバーの参考指数（全指数）＋ USD/JPY チップ。値は小数2桁まで表示
  const tickers = document.getElementById('tickers');
  if (tickers) {
    const idxNum = (v) => v == null ? '—' : Number(v).toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const tk = (ixDef) => {
      const ix = (store.data.indices || {})[ixDef.key] || {};
      const pct = calc.indexChangePct(ixDef.key);
      const val = ix.price != null ? idxNum(ix.price) : '—';
      // 日経平均・日経先物は「変動幅（変動率）」を表示: 例 +404.74（+0.61%）。他指数は変動率のみ
      let metric;
      if ((ixDef.key === 'n225' || ixDef.key === 'nikkeifut') && ix.price != null && ix.prevClose != null && pct != null) {
        const d = ix.price - ix.prevClose;
        metric = `<span class="t-pct ${cls(d)}">${d >= 0 ? '+' : '−'}${idxNum(Math.abs(d))}（${signed(pct)}%）</span>`;
      } else {
        metric = pct == null ? '<span class="muted">—</span>' : `<span class="t-pct ${cls(pct)}">${signed(pct)}%</span>`;
      }
      return `<div class="ticker"><span class="t-label">${ixDef.label}</span><span class="t-val num">${val}</span>${metric}</div>`;
    };
    const _idxItems = INDICES.map(tk).join('');
    const _fxChip = `<div class="fx-chip"><span class="t-label">USD/JPY</span><span class="t-val num">${fx ? fx.toFixed(2) : '—'}</span></div>`;
    // 指数だけ電光掲示板（マーキー）。ドル円(為替)は流さず右に固定表示。幅が足りれば流さない（layoutTickerMarquee）。
    const _payload = _idxItems + '||' + _fxChip;
    if (tickers._tkLast !== _payload) {
      tickers._tkLast = _payload;
      tickers._idxItems = _idxItems;
      tickers.innerHTML = `<div class="tickers-marquee"><div class="tickers-track">${_idxItems}</div></div><div class="tickers-fx">${_fxChip}</div>`;
      const tr = tickers.querySelector('.tickers-track'); if (tr) tr.dataset.dup = '0';
    }
    layoutTickerMarquee();
  }
  const um = document.getElementById('update-meta');
  if (um) {
    const t = store.data.lastPriceUpdate ? fmtDateTime(store.data.lastPriceUpdate).replace(/^\S+\s/, '') : '—';
    // 米株の価格ソースを併記（finnhub=ほぼリアルタイム / yahoo=15〜20分遅延）。判別・遅延の診断用。
    // ラベルは米株全体の多数決。ツールチップに finnhub/yahoo の内訳を出す（一部だけYahooでも実態がわかる）。
    const src = store.data.lastPriceSource;
    const cnt = store.data.lastPriceSrcCounts;
    const cntStr = cnt ? `（Finnhub ${cnt.finnhub} / Yahoo ${cnt.yahoo}）` : '';
    const srcLabel = src ? (/finnhub/.test(src)
      ? `<span style="color:var(--green,#16a34a)" title="米株の多数がFinnhub（ほぼリアルタイム）${cntStr}。Yahooの分は15〜20分遅延">Finnhub</span>`
      : `<span class="muted" title="米株の多数がYahoo（15〜20分遅延）${cntStr}。Finnhubが非対応銘柄/レート制限でフォールバックしています。リアルタイムにはFinnhubの対応銘柄/上限を確認">Yahoo(遅延)</span>`) : '';
    um.innerHTML = `更新<br><b>${t}</b>${srcLabel ? ` <span style="font-size:10px">${srcLabel}</span>` : ''}`;
  }
  // 未ログイン警告: 自動同期ONなのに未ログイン＝この端末にしか保存されない（他端末と共有されない）
  const lw = document.getElementById('login-warn');
  if (lw) {
    const needSync = dsync.enabled() && gsync.cfg().clientId;
    if (needSync && !gsync._token) {
      lw.hidden = false;
      lw.className = 'login-warn';
      lw.title = '自動同期はONですが未ログインのため、変更はこの端末にしか保存されません。クリックでそのままログインできます';
      lw.innerHTML = '⚠ 未ログイン<br><span>クリックでログイン</span>';
      // クリック＝ユーザー操作のまま即ログイン（画面遷移はしない。スマホはタップ同期でないとポップアップが塞がれるため signIn を直接呼ぶ）。
      lw.onclick = () => { gsyncSignIn(); };
    } else {
      lw.hidden = true;
      lw.onclick = null;
    }
  }
}

function updateSignalBadge() { renderNav(); }
function updateSplitBadge() { /* renderNav() がバッジを描画 */ }

function allSignals() {
  const list = [];
  for (const sec of store.data.securities) {
    const ev = calc.evaluate(sec);
    if (ev && ev.reached) list.push({ sec, ev });
  }
  return list;
}

// ---------- ダッシュボード ----------
function renderDashboard() {
  const markets = ['US', 'JP'];
  const per = {};
  for (const m of markets) per[m] = { valN: 0, costN: 0, cnt: 0, held: 0, noPrice: 0 };

  for (const sec of store.data.securities) {
    const d = per[sec.market]; if (!d) continue;
    d.cnt++;
    const th = calc.totalHolding(sec.id);
    if (th.qty > 0) {
      d.held++;
      d.valN += calc.valueOrCostNative(sec);
      d.costN += calc.costNative(sec);
      if (calc.valueNative(sec) == null) d.noPrice++;
    }
  }

  const fx = calc.fx();
  // 円換算（米株は為替必要）。為替未取得なら米株を円合計から除外し注記
  let totalJpy = 0, costJpy = 0, fxMissing = false;
  for (const m of markets) {
    const vj = calc.toJpy(m, per[m].valN), cj = calc.toJpy(m, per[m].costN);
    if (m === 'US' && (vj == null || cj == null) && per[m].held > 0) { fxMissing = true; continue; }
    totalJpy += vj || 0; costJpy += cj || 0;
  }
  const pnl = totalJpy - costJpy;
  const pnlPct = costJpy > 0 ? pnl / costJpy * 100 : 0;
  const sigCount = allSignals().length;
  const noPriceTotal = markets.reduce((a, m) => a + per[m].noPrice, 0);

  const notes = [];
  if (fxMissing) notes.push('USD/JPY 為替が未取得のため、円換算合計に米国株を含めていません。「価格更新」で取得できます。');
  if (noPriceTotal > 0) notes.push(`価格未取得の保有銘柄が ${noPriceTotal} 件あります（評価額は取得原価で代用表示）。`);

  // 市場ごとの円換算・前日比（円）
  const perJpy = {};
  for (const m of markets) {
    const dc = calc.dayChangeJpy(m);
    perJpy[m] = {
      valJpy: calc.toJpy(m, per[m].valN) || 0,
      costJpy: calc.toJpy(m, per[m].costN) || 0,
      dayJpy: dc.amount || 0,
      dayPct: dc.pct,
      cnt: per[m].held,
    };
  }
  const dayAll = calc.dayChangeJpy();
  const dayJpy = dayAll.amount || 0;
  const dayPct = dayAll.pct;
  const { reached: reachedSecs, near: nearSecs } = signalRows();
  const newReached = reachedSecs.filter(s => calc.reachKind(s) === '新'); // ダッシュボードの表は「新規到達(新)」のみ

  // 本日の値上がり / 値下がり Top5（全株式/米国株/日本株で切替）
  const heldSecs = store.data.securities.filter(s => calc.totalHolding(s.id).qty > 0);
  const moverData = heldSecs.filter(s => dashMoverMarket === 'ALL' ? (s.market === 'US' || s.market === 'JP') : s.market === dashMoverMarket).map(s => {
    const p = store.data.prices[priceKey(s)] || {};
    const dp = (p.price != null && p.prevClose) ? (p.price - p.prevClose) / p.prevClose * 100 : null;
    return { s, dp };
  }).filter(x => x.dp != null).sort((a, b) => b.dp - a.dp);
  const gainers = moverData.slice(0, 5);
  const losers = moverData.slice(-5).reverse();
  const moverSeg = `<div class="seg" style="margin-left:auto">${[['ALL', '全株式'], ['US', '米国株'], ['JP', '日本株']].map(([m, l]) => `<button class="${dashMoverMarket === m ? 'active' : ''}" onclick="setDashMoverMarket('${m}')">${l}</button>`).join('')}</div>`;
  const tkChip = (s) => `<span class="tk ${s.market.toLowerCase()}">${esc(s.market === 'JP' ? s.ticker : (s.ticker || '').slice(0, 4))}</span>`;
  const moverRow = (x) => `<div class="mover-row">${tkChip(x.s)}<span class="mv-name">${esc(calc.displayName(x.s))}</span><span class="${cls(x.dp)}">${signed(x.dp)}%</span></div>`;
  const moverList = (title, list) => `<div class="mover-col"><div class="dr-section-t">${title}</div>${list.length ? list.map(moverRow).join('') : '<div class="muted" style="font-size:12px;padding:4px 0">—</div>'}</div>`;

  const idxCard = (k) => {
    const ix = (store.data.indices || {})[k] || {};
    const v = calc.indexChangePct(k);
    return `<div class="idx-card"><div class="idx-label">${INDICES.find(i => i.key === k)?.label || k}</div>
      <div class="idx-row"><span class="num" style="font-weight:700">${ix.price != null ? Number(ix.price).toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</span>
      <span class="delta ${cls(v)}">${v == null ? '—' : (v > 0 ? '▲' : v < 0 ? '▼' : '') + signed(v) + '%'}</span></div></div>`;
  };
  const mkColor = { JP: '#b23a36', US: '#2a5599' };
  const fxNow = fx ? fx.toFixed(2) : '—';
  const luStr = store.data.lastPriceUpdate ? fmtDateTime(store.data.lastPriceUpdate) : '未取得';

  app.innerHTML = `
    <div class="dashboard-view">
    <div class="page-intro">
      <h2>ダッシュボード <span class="dash-meta">${esc(luStr)} 時点・USD/JPY ${fxNow}</span></h2>
    </div>
    ${notes.map(n => `<div class="notice">${esc(n)}</div>`).join('')}
    ${macroAlertCardHtml()}
    ${updFeedHtml()}
    <div class="cards">
      <div class="stat feature">
        <div class="s-label">総資産（円換算${fxMissing ? '・米株除く' : ''}）</div>
        <div class="s-value"><span class="cur">¥</span>${num(Math.round(totalJpy))}</div>
        <div class="s-sub"><span style="opacity:.7">本日</span>
          <span style="font-weight:700;color:${dayJpy >= 0 ? '#6fd99a' : '#f0928c'}">${dayJpy >= 0 ? '▲' : '▼'} ${yen(Math.abs(dayJpy))}${dayPct != null ? `（${signed(dayPct)}%）` : ''}</span></div>
      </div>
      <div class="stat">
        <div class="s-label">評価損益（円換算）</div>
        <div class="s-value num ${cls(pnl)}">${yen(pnl)}</div>
        <div class="s-sub ${cls(pnl)}" style="font-weight:700">${signed(pnlPct)}%</div>
        <div class="s-foot">取得原価 ${yen(costJpy)}</div>
      </div>
      <div class="stat">
        <div class="s-label">買い増しサイン</div>
        <div class="s-value num ${reachedSecs.length ? 'neg' : ''}">${reachedSecs.length}<span class="s-unit"> 件</span></div>
        <div class="s-sub"><span class="drop reached" style="padding:1px 8px;border-radius:6px">到達 ${reachedSecs.length}</span> <span class="drop near" style="padding:1px 8px;border-radius:6px">もうすぐ ${nearSecs.length}</span></div>
        <div class="s-foot"><span class="lnk" onclick="go('signals')">サイン一覧を見る →</span></div>
      </div>
      <div class="stat">
        <div class="s-label">保有銘柄数</div>
        <div class="s-value num">${heldSecs.length}<span class="s-unit"> 銘柄</span></div>
        <div class="s-sub muted">米 ${perJpy.US.cnt} / 日 ${perJpy.JP.cnt}</div>
      </div>
    </div>

    <div class="dash-grid">
      <div class="section" style="margin-bottom:0">
        <div class="section-head"><h2>市場別の内訳</h2><span class="muted" style="margin-left:auto;font-size:11px">構成比は評価額（円換算）</span></div>
        <div class="breakdown">
          ${markets.map(m => {
            const p = perJpy[m]; const pnlM = p.valJpy - p.costJpy; const pp = p.costJpy ? pnlM / p.costJpy * 100 : null;
            const share = totalJpy ? p.valJpy / totalJpy * 100 : 0;
            return `<div class="bd-row">
              <div style="display:flex;align-items:center;gap:8px"><span class="tag ${m.toLowerCase()}">${MARKET_LABEL[m]}</span><span class="muted" style="font-size:11px">${p.cnt}銘柄</span></div>
              <div class="bd-bar" title="${num(share)}%"><i style="width:${Math.max(0, Math.min(100, share))}%;background:${mkColor[m]}"></i></div>
              <div style="text-align:right"><div class="num" style="font-weight:700">${yen(p.valJpy)}</div><div class="num ${cls(pnlM)}" style="font-size:12px">${pp != null ? signed(pp) + '%' : '—'}</div></div>
            </div>`;
          }).join('')}
        </div>
        <div style="display:flex;align-items:center;padding:10px 16px 0;border-top:1px solid var(--hair)"><span class="dr-section-t" style="margin:0">本日の値動き Top</span>${moverSeg}</div>
        <div class="mover-grid">${moverList('本日の値上がり', gainers)}${moverList('本日の値下がり', losers)}</div>
      </div>

      <div class="section" style="margin-bottom:0">
        <div class="section-head"><h2>本日の動き</h2></div>
        <div style="padding:6px 18px 16px">
          ${markets.map(m => `<div class="dr-row"><span class="k"><span class="tag ${m.toLowerCase()}">${MARKET_LABEL[m]}</span></span><span class="v ${cls(perJpy[m].dayJpy)}">${perJpy[m].dayJpy >= 0 ? '▲' : '▼'} ${yen(Math.abs(perJpy[m].dayJpy))}${perJpy[m].dayPct != null ? ` <span style="font-size:12px">（${signed(perJpy[m].dayPct)}%）</span>` : ''}</span></div>`).join('')}
          <div class="dr-section-t" style="margin-top:16px">参考指数（前日比）</div>
          <div class="idx-grid">${INDICES.map(i => idxCard(i.key)).join('')}</div>
        </div>
      </div>
    </div>

    <div class="section" style="margin-top:14px">
      <div class="section-head head-sm"><h2>買い増しサイン（本日 新規到達）</h2>
        <span class="muted" style="margin-left:8px;font-size:12px">新 ${newReached.length} 件 / 到達計 ${reachedSecs.length} 件</span>
        <button class="btn btn-sm" style="margin-left:auto" onclick="go('signals')">一覧へ</button></div>
      <div class="section-body">${dashSignalsTable()}</div>
    </div>
    </div>`;
}

// ---------- 市場別 一覧 ----------
// 格付のランク順（S が最上位＝昇順で先頭）。アルファベット順ではなくランク順でソート
const GRADE_RANK = { S: 0, A: 1, B: 2, C: 3, D: 4 };
// ソート用の比較値（一覧・サイン共通）
function sortValue(sec, key) {
  const th = calc.totalHolding(sec.id);
  switch (key) {
    case 'rank': return anaTop50Rank[priceKey(sec)] ?? Infinity; // 分析タブ・売買代金トップ50の初期ソート（順位昇順）
    case 'name': return calc.displayName(sec).toLowerCase();
    case 'ticker': return (sec.ticker || '').toLowerCase();
    case 'anaTotal': return techComposite(sec) ?? -Infinity;
    case 'anaTrend': return techSideScore(sec, 'trend') ?? -Infinity;
    case 'anaContra': return techSideScore(sec, 'contra') ?? -Infinity;
    case 'anaRsiDiv': return techPatScore(sec, 'rsiDivergence') ?? -Infinity;
    case 'anaBoll': return techPatScore(sec, 'bollingerRecover') ?? -Infinity;
    case 'anaMaDev': return techPatScore(sec, 'maDeviation') ?? -Infinity;
    case 'anaGap': return techPatScore(sec, 'gapFill') ?? -Infinity;
    case 'anaVolDry': return techPatScore(sec, 'volDryUp') ?? -Infinity;
    case 'anaCup': return techPatScore(sec, 'cup') ?? -Infinity;
    case 'anaRange': return techPatScore(sec, 'range') ?? -Infinity;
    case 'anaWbottom': return techPatScore(sec, 'doubleBottom') ?? -Infinity;
    case 'anaAsc': return techPatScore(sec, 'ascTriangle') ?? -Infinity;
    case 'anaRound': return techPatScore(sec, 'roundBottom') ?? -Infinity;
    case 'anaInvHS': return techPatScore(sec, 'invHS') ?? -Infinity;
    case 'anaUndercut': return techPatScore(sec, 'undercutRally') ?? -Infinity;
    case 'anaClimax': return techPatScore(sec, 'sellingClimax') ?? -Infinity;
    case 'anaFlag': return techPatScore(sec, 'flag') ?? -Infinity;
    case 'anaBase': return techPatScore(sec, 'baseOnBase') ?? -Infinity;
    case 'anaWarn': { const w = techWarnSide(sec, 'trend'); return w ? w.score : -Infinity; }
    case 'anaWarnC': { const w = techWarnSide(sec, 'contra'); return w ? w.score : -Infinity; }
    case 'anaHsTop': return techPatScore(sec, 'hsTop') ?? -Infinity;
    case 'anaDblTop': return techPatScore(sec, 'doubleTop') ?? -Infinity;
    case 'anaNewLow': return techPatScore(sec, 'newLowHighVol') ?? -Infinity;
    case 'anaBearFlag': return techPatScore(sec, 'bearFlag') ?? -Infinity;
    case 'anaDescTri': return techPatScore(sec, 'descTriangle') ?? -Infinity;
    case 'anaMa200': { const r = techOf(sec); if (!r || !r.ma200Pos) return -Infinity; return (r.ma200Pos === 'above' ? 1 : 0) + (r.ma200Slope === 'up' ? 0.5 : 0); }
    case 'ana5d': { const r = techOf(sec); return r && r.above5 != null ? (r.above5 ? 1 : 0) : -Infinity; }
    case 'anaDev52w': { const r = techOf(sec); return r && r.dev52w != null ? r.dev52w : -Infinity; }
    case 'anaRSI': { const r = techOf(sec); return r ? (r.rsi ?? -Infinity) : -Infinity; }
    case 'anaStatus': { const r = techOf(sec); return r && r.best ? r.best.status : -1; }
    case 'anaBuy': return techLevel(sec, 'buy') ?? -Infinity;
    case 'anaFail': return techLevel(sec, 'fail') ?? -Infinity;
    case 'anaDate': { const r = techOf(sec); return r ? (r.lastAnalyzed || '') : ''; }
    case 'market': return sec.market;
    case 'detailType': return detailTypeOf(sec);
    case 'createdAt': return sec.createdAt || '';
    case 'updatedAt': return sec.updatedAt || '';
    case 'broker': return (calc.lastBroker(sec) || '').toLowerCase();
    case 'sigType': { const ev = calc.evaluate(sec); return ev ? ev.type : 'z'; }
    case 'category': { const c = store.data.categories.find(x => x.category === sec.category); return c ? (c.sortOrder ?? 9998) : (sec.category ? 9999 : 10000); }
    case 'investCategory': { const c = store.data.investCategories.find(x => x.name === sec.investCategory); return c ? (c.sortOrder ?? 9998) : (sec.investCategory ? 9999 : 10000); }
    case 'labels': { const ls = secLabels(sec); return ls.length ? Math.min(...ls.map(labelSortIdx)) : 10000; } // ラベル先頭のマスタ順、未設定は末尾
    case 'ruleName': { const r = store.rule(sec.ruleId); return r ? (r.name || '').toLowerCase() : ''; }
    case 'fixedBuyPrice': return sec.fixedBuyPrice ?? -Infinity;
    case 'addonFromHigh': return sec.addonFromHigh ? 1 : 0;
    case 'qty': return th.qty;
    case 'avgCost': return th.avgCost;
    case 'cost': return th.acquiredCost;
    case 'origCost': return calc.originalCostNative(sec) || -Infinity;
    case 'acqJpy': {
      if (sec.market === 'US') { const hs = store.data.holdings.filter(h => h.securityId === sec.id); return hs.some(h => h.acqJpy != null) ? hs.reduce((a, h) => a + (h.acqJpy || 0), 0) : -Infinity; }
      return th.qty ? th.avgCost * th.qty : -Infinity;
    }
    case 'sector': return calc.field(sec, 'sector') || 'zzz';
    case 'industry': return calc.field(sec, 'industry') || 'zzz';
    case 'marketCap': return calc.marketCap(sec) ?? -Infinity;
    case 'capToTop': return calc.capToTop(sec) ?? -Infinity;
    case 'turnover': return calc.turnover(sec) ?? -Infinity;
    case 'per': return calc.per(sec) ?? Infinity;
    case 'pbr': return calc.pbr(sec) ?? Infinity;
    // 目標指標からの逆算株価（未算出は末尾へ）
    case 'targetPerPrice': return calc.targetPerPrice(sec) ?? -Infinity;
    case 'targetPbrPrice': return calc.targetPbrPrice(sec) ?? -Infinity;
    case 'targetYieldPrice': return calc.targetYieldPrice(sec) ?? -Infinity;
    case 'psr': return calc.psr(sec) ?? Infinity;
    case 'divYield': return calc.divYield(sec) ?? -Infinity;
    case 'yieldOnCost': return calc.yieldOnCost(sec) ?? -Infinity;
    case 'eps': return calc.field(sec, 'eps') ?? -Infinity;
    case 'marginRatio': return calc.marginRatio(sec) ?? -Infinity;
    case 'overallGrade': return GRADE_RANK[sec.overallGrade] ?? 99;
    case 'buyGrade': return GRADE_RANK[sec.buyGrade] ?? 99;
    case 'analysisDate': return sec.analysisDate || '';
    // 株価シナリオ: レンジ列はベースレンジ下限で数値ソート（未設定は末尾）。位置列は下(弱気未満)→上(強気超え)の順
    case 'stScenario': return scParseRange(sec.stBase)?.lo ?? scParseRange(sec.stBear)?.lo ?? -Infinity;
    case 'mtScenario': return scParseRange(sec.mtBase)?.lo ?? scParseRange(sec.mtBear)?.lo ?? -Infinity;
    case 'stScenPos': return scPosition(sec, 'st')?.lvl ?? -Infinity;
    case 'mtScenPos': return scPosition(sec, 'mt')?.lvl ?? -Infinity;
    case 'scenarioDate': return sec.scenarioDate || '';
    case 'scenarioPrice': return sec.scenarioPrice ?? -Infinity;
    case 'buyCount': return calc.buyCount(sec) || 0;
    case 'buyAmount': return calc.buyAmount(sec) ?? -Infinity;
    case 'reco': return store.categoryAmountFor(sec.category, sec.market) || -Infinity;
    case 'price': return calc.price(sec) ?? -Infinity;
    case 'high5y': return calc.high5y(sec) ?? -Infinity;
    case 'high52w': return calc.high52w(sec) ?? -Infinity;
    case 'prevBuyPrice': return calc.lastBuyPrice(sec) ?? -Infinity;
    case 'extPrice': { const p = store.data.prices[priceKey(sec)]; return (p && p.extPrice != null) ? p.extPrice : -Infinity; }
    case 'prevBuyDate': return calc.lastBuyInfo(sec).date || '';
    case 'earnPrev': { const i = earnInfo(sec); return (i && i.prev) || '9999-99-99'; } // 未取得は末尾へ
    case 'earnNext': { const eff = earnEffNext(sec); return eff ? eff.date : '9999-99-99'; } // 実効日（予定/推定）で近い順。未取得は末尾

    case 'dropFromPrev': return calc.dropFromPrev(sec) ?? Infinity;
    case 'dropFrom5y': return calc.dropFrom5y(sec) ?? Infinity;
    case 'dropFrom52w': return calc.dropFrom52w(sec) ?? Infinity;
    case 'low1y': return calc.low1y(sec) ?? -Infinity;
    case 'low3y': return calc.low3y(sec) ?? -Infinity;
    case 'riseFrom1y': return calc.riseFrom1y(sec) ?? Infinity;
    case 'riseFrom3y': return calc.riseFrom3y(sec) ?? Infinity;
    case 'value': return calc.valueOrCostNative(sec) ?? -Infinity;
    case 'ratioValue': return ratioPct(sec, 'value') ?? -Infinity;
    case 'ratioCost': return ratioPct(sec, 'cost') ?? -Infinity;
    case 'pnl': return calc.pnlPctNative(sec) ?? -Infinity;
    case 'day': { const p = store.data.prices[priceKey(sec)] || {}; return (p.price != null && p.prevClose) ? (p.price - p.prevClose) / p.prevClose * 100 : -Infinity; }
    case 'prevClose': { const p = store.data.prices[priceKey(sec)] || {}; return p.prevClose ?? -Infinity; }
    case 'dayAmt': { const p = store.data.prices[priceKey(sec)] || {}; return (p.price != null && p.prevClose != null) ? (p.price - p.prevClose) : -Infinity; }
    case 'trigger': { const ev = calc.evaluate(sec); return ev ? ev.trigger : -Infinity; }
    case 'base': { const ev = calc.evaluate(sec); return ev ? ev.base : -Infinity; }
    case 'drop': { const ev = calc.evaluate(sec); return ev ? ev.remainingDropPct : Infinity; }
    case 'dropPrev': return calc.remainingDropPrev(sec) ?? Infinity;
    case 'reachKind': { const k = calc.reachKind(sec); return k === '新' ? 0 : k === '続' ? 1 : 2; }
    case 'rating': return GRADE_RANK[sec.rating || sec.overallGrade] ?? 99;
    case 'priority': return sec.priority ?? Infinity;
    case 'principalSold': return sec.principalSold ? 0 : 1; // 売却済みを先頭に
    case 'principalSoldAmount': return sec.principalSoldAmount ?? -Infinity;
    default: return '';
  }
}
function sortSecurities(secs, market) {
  const st = listState[market];
  const key = st.sortKey, dir = st.sortDir;
  return [...secs].sort((a, b) => {
    const va = sortValue(a, key), vb = sortValue(b, key);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
}

function renderMarket(market) {
  // market は 'US' | 'JP' | 'ALL'。ALL は両市場を1表に表示（列・ソート・フィルタ状態は US 設定を流用）
  const isAll = market === 'ALL';
  const colMkt = isAll ? 'US' : market;       // 列レイアウト/ソート/フィルタ状態のキー
  const st = listState[colMkt];
  const isStock = market !== 'FUND';
  let secs = store.data.securities.filter(s => isAll ? (s.market === 'US' || s.market === 'JP') : s.market === market);
  // 保有有無にかかわらず全銘柄を表示する（2026-06-30 すみぽん要望）。絞り込みは検索＋列フィルタで行う。
  // （旧仕様: 「保有あり(数量>0) または 注意銘柄」のみ表示。列フィルタ追加により撤廃）
  if (holdingsSearch.trim()) secs = secs.filter(s => secMatchesQuery(s, holdingsSearch));
  // 列フィルタ（分析と共通。種別・会社・カテゴリ等はパネルで設定）
  secs = applyColFilters(secs, 'holdings');
  // 比率列の分母。'表示中' はこの絞り込み後の集合が母数（ソートより前に確定させる＝比率ソートも同じ母数で行う）
  ratioCtx = buildRatioCtx(secs);
  secs = sortSecurities(secs, colMkt);

  const ccy = MARKET_CCY[colMkt];
  // 表示するカラム（ユーザー設定済みの順・表示フラグ反映）
  const visOrder = getColOrder(colMkt).filter(c => c.visible);
  const visibleCols = visOrder.map(c => MASTER_COLS.find(m => m.key === c.key)).filter(Boolean);
  // 編集モード(SEC-94): ナビゲーション用に編集可能列キー順・行順を記録
  _ieCols = inlineEditOn ? visibleCols.filter(c => INLINE_FIELDS[c.key]).map(c => c.key) : [];
  _ieRowIds = inlineEditOn ? secs.map(s => s.id) : [];

  const headHtml = colHeadHtml(visibleCols, st, colMkt, ccy);
  // 列幅（table-layout:fixed）。先頭=チェック / 末尾=操作 の固定列＋各列の幅
  // 末尾=操作列（取引/保有/編集の3ボタン）。狭いとボタンが切れるため十分な幅を確保
  const ACTION_W = 196;
  const colgroupHtml = `<colgroup><col style="width:36px">${visOrder.map(c => colTag(c)).join('')}<col style="width:${ACTION_W}px"></colgroup>`;
  // テーブル幅＝列幅合計。width:100%だと固定幅が圧縮され横スクロールが出ないため、合計幅を明示（min-width:100%で不足時は伸長）
  const tableW = 36 + ACTION_W + visOrder.reduce((a, c) => a + colWidthPx(c), 0);

  // サマリー帯の集計（表示中の銘柄＝secs に対して）
  let sumV = 0, sumC = 0, sumD = 0, sumSig = 0;
  for (const sec of secs) {
    const vj = calc.toJpy(sec.market, calc.valueOrCostNative(sec));
    const cj = calc.toJpy(sec.market, calc.costNative(sec));
    sumV += vj || 0; sumC += cj || 0;
    const p = store.data.prices[priceKey(sec)] || {}; const th = calc.totalHolding(sec.id);
    const dN = (p.price != null && p.prevClose) ? (p.price - p.prevClose) * th.qty : null;
    sumD += calc.toJpy(sec.market, dN) || 0;
    const ev = calc.evaluate(sec);
    if (ev && (ev.reached || (ev.remainingDropPct != null && ev.remainingDropPct <= 5))) sumSig++;
  }
  const sumPnl = sumV - sumC; const sumPnlPct = sumC > 0 ? sumPnl / sumC * 100 : null;

  app.innerHTML = `
    <div class="section">
      <div class="toolbar">
        <div class="seg" role="tablist">
          <button class="${market === 'ALL' ? 'active' : ''}" onclick="setHoldingsMarket('ALL')">全株式</button>
          <button class="${market === 'US' ? 'active' : ''}" onclick="setHoldingsMarket('US')">米国株</button>
          <button class="${market === 'JP' ? 'active' : ''}" onclick="setHoldingsMarket('JP')">日本株</button>
        </div>
        <div class="seg" role="tablist" style="margin-left:10px">
          <button class="${market === 'FUND' ? 'active' : ''}" onclick="setHoldingsMarket('FUND')">投資信託</button>
        </div>
        <div class="search">${svgIcon('search', '')}<input id="hold-search" placeholder="コード・銘柄名で検索" value="${esc(holdingsSearch)}" oninput="setHoldingsSearch(this.value)" autocomplete="off">${holdingsSearch ? `<button class="clr" onclick="setHoldingsSearch('')">×</button>` : ''}</div>
        <div class="tb-spacer"></div>
        ${filterBtnHtml('holdings')}
        ${ratioToolbarHtml()}
        <button class="btn btn-sm col-picker-btn" onclick="openColPicker('${colMkt}')" title="列の表示設定">${svgIcon('columns', '')} 列</button>
        <button class="btn btn-sm" onclick="copyDisplayedTable()" title="表示中の表をコピー">${svgIcon('copy', '')} 表コピー</button>
        <button class="btn btn-sm ${inlineEditOn ? 'btn-primary' : ''}" onclick="toggleInlineEdit()" title="一覧上で直接編集（誤操作防止トグル）">${svgIcon('edit', '')} 編集モード${inlineEditOn ? '：ON' : ''}</button>
      </div>
      <div id="flt-host-holdings">${fltState.holdings.open ? filterPanelHtml('holdings') : ''}</div>
      ${inlineEditOn ? `<div class="ie-hint">✏️ 編集モード：対象セル（カテゴリ・ルール・前回購入単価/日・買増固定値・詳細種別・数量・取得単価・買い増し予定額・購入回数・メモ・分析メモ）を直接編集 → <strong>「保存」</strong>で確定。<strong>Tab</strong>=右 / <strong>Enter</strong>=下 / <strong>Esc</strong>=このセルを取消。数量・取得単価は単一保有のみ（複数=⧉で保有フォーム）。
        <span class="tb-spacer"></span>
        <span id="ie-pending" class="ie-pending">変更なし</span>
        <button class="btn btn-sm btn-primary" onclick="ieSaveAll()">保存</button>
        <button class="btn btn-sm" onclick="ieDiscardAll()">取消（破棄）</button>
        <button class="btn btn-sm" onclick="toggleInlineEdit()">編集モード終了</button></div>` : ''}
      <div class="summary-strip">
        <div class="ss"><span class="ss-k">評価額（円換算）</span><span class="ss-v num">${yen(sumV)}</span></div>
        <div class="ss"><span class="ss-k">評価損益</span><span class="ss-v num ${cls(sumPnl)}">${yen(sumPnl)}${sumPnlPct != null ? `<small>${signed(sumPnlPct)}%</small>` : ''}</span></div>
        <div class="ss"><span class="ss-k">本日</span><span class="ss-v num ${cls(sumD)}">${yen(sumD)}</span></div>
        <div class="ss"><span class="ss-k">買い増しサイン</span><span class="ss-v num ${sumSig ? 'neg' : 'muted'}">${sumSig} 件</span></div>
        <div class="tb-spacer"></div>
        <div class="ss"><span class="ss-k">表示</span><span class="ss-v num">${secs.length} 銘柄</span></div>
      </div>
      <div class="bulkbar" style="flex-wrap:wrap">
        <span class="muted" id="bulk-count">選択 0 件</span>
        <span class="muted">を</span>
        <select onchange="holdBulkFieldChange(this.value)">${SM_BULK_FIELDS.map(f => `<option value="${f.key}" ${holdBulkField === f.key ? 'selected' : ''}>${f.label}</option>`).join('')}</select>
        <span class="muted">→</span>
        <span id="hold-bulk-value-wrap">${bulkValueHtml(holdBulkField, 'hold-bulk-value')}</span>
        <button class="btn btn-sm btn-primary" onclick="holdBulkApply()">一括変更</button>
        <span style="width:8px"></span>
        <button class="btn btn-sm btn-danger" onclick="bulkSellAll()">選択を全売却</button>
        <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="openSecurityForm(null, '${colMkt}')">＋ 銘柄を追加</button>
      </div>
      <div class="section-body">
        ${secs.length === 0 ? `<div class="empty">該当する銘柄がありません。</div>` : `
        <div class="table-wrap"><table class="fixed-cols holdings dense ${inlineEditOn ? 'ie-on' : ''}" style="width:${tableW}px">${colgroupHtml}
          <thead><tr><th class="l"><input type="checkbox" id="select-all" onchange="toggleSelectAll(this)"></th>${headHtml}<th class="l"></th></tr></thead>
          <tbody>
            ${secs.map(sec => marketRow(sec, visibleCols, { select: true })).join('')}
          </tbody>
        </table></div>`}
      </div>
    </div>`;
  bindRowSelect();
  autoFitColumns(document.querySelector('#app table.fixed-cols'));
  applyStickyCols(document.querySelector('#app table.fixed-cols'), market);
}

// ヘッダHTML生成（一覧・サイン共通）
function colHeadHtml(visibleCols, st, market, ccy) {
  const ovMap = {}; getColOrder(market).forEach(c => { if (c.labelOverride) ovMap[c.key] = c.labelOverride; });
  return visibleCols.map(col => {
    const mc = MASTER_COLS.find(c => c.key === col.key);
    const cls2 = `${mc.left ? 'l' : ''} ${mc.narrow ? 'col-code' : ''}`.trim();
    const label = ovMap[col.key] ? ovMap[col.key]
      : (['value','cost','buyAmount','reco','high5y','high52w','prevBuyPrice'].includes(col.key) && ccy && ccy !== '¥')
      ? `${mc.label}(${ccy})` : mc.label;
    // 列名のツールチップ。列幅が狭くて見出しが切れても、カーソルを当てれば列名が読める。
    // 見出しを変更している列（labelOverride）は「表示名（元の列名）」で両方出す。
    const tip = esc(ovMap[col.key] ? `${label}（${mc.label}）` : label);
    if (mc.noSort) return `<th class="${cls2}" title="${tip}">${label}</th>`;
    const active = st.sortKey === col.key;
    // 矢印スペースを常時予約（ソートで列幅が変わらないように）
    const arrow = `<span class="sort-arrow">${active ? (st.sortDir === 1 ? '▲' : '▼') : ''}</span>`;
    return `<th class="sortable ${cls2} ${active ? 'active' : ''}" title="${tip}" onclick="setSort('${market}','${col.key}')">${label}${arrow}</th>`;
  }).join('');
}

// チェックボックス選択のバインド（件数表示更新）
function bindRowSelect() {
  const boxes = document.querySelectorAll('.row-select');
  const update = () => {
    const n = document.querySelectorAll('.row-select:checked').length;
    const el = document.getElementById('bulk-count');
    if (el) el.textContent = `選択 ${n} 件`;
  };
  boxes.forEach(b => b.addEventListener('change', update));
  update();
}
function toggleSelectAll(master) {
  document.querySelectorAll('.row-select').forEach(b => { b.checked = master.checked; });
  bindRowSelect();
}
function bulkSellAll() {
  const ids = [...document.querySelectorAll('.row-select:checked')].map(b => parseInt(b.dataset.id, 10));
  if (ids.length === 0) { toast('銘柄を選択してください'); return; }
  const names = ids.map(id => { const s = store.data.securities.find(x => x.id === id); return s ? calc.displayName(s) : ''; }).filter(Boolean);
  if (!confirm(`選択した ${ids.length} 件を全売却します。取引履歴に「売り」を記録し（売値は現在値）、数量を0にします。\n\n${names.join('、')}\n\nよろしいですか？`)) return;
  ids.forEach(id => recordSellAll(id));
  render();
  toast(`${ids.length} 件を全売却しました`);
}

// opts: { select: true で先頭にチェックボックス列, actions: 'list'|'signal' }
// 行コンテキスト（COL_RENDERERS が参照する派生値）を1銘柄分作る。marketRow とマーケットランキング行で共用。
function rowContext(sec) {
  const market = sec.market; // ccy/ev は銘柄の市場で判定（サインタブの混在に対応）
  const th = calc.totalHolding(sec.id);
  const p = store.data.prices[priceKey(sec)] || {};
  const price = p.price ?? null;
  const ccy = MARKET_CCY[market];
  return {
    ccy, market, th,
    ev: market !== 'FUND' ? calc.evaluate(sec) : null,
    price,
    priceCell: price != null ? fmtAmt(price, market) : priceInputBtn(sec),
    noPriceMark: (price == null && th.qty > 0) ? ' <span class="muted" title="価格未取得・取得原価で表示">*</span>' : '',
    valN: calc.valueOrCostNative(sec),
    pnlPct: calc.pnlPctNative(sec),
    // 前日比: 現在値−前日終値（常にライブ値）。寄り付き前や同値引けは 0% と表示する（旧「前」マーカーは廃止）。
    dayChg: (price == null || !p.prevClose) ? null : (price - p.prevClose) / p.prevClose * 100,
    prevCloseV: p.prevClose ?? null,                 // 前日終値（日次 light 取得で確定・列表示用）
    prevCloseDate: p.prevCloseDate ?? null,          // その前日終値がいつの引けか（YYYY-MM-DD）
    dayAmt: (price == null || p.prevClose == null) ? null : (price - p.prevClose), // 前日比の値幅（原通貨）
    buyAmt: calc.buyAmount(sec),
    buyCnt: calc.buyCount(sec),
    recoAmt: store.categoryAmountFor(sec.category, market),
    high5y: calc.high5y(sec),
    high52w: calc.high52w(sec),
    low1y: calc.low1y(sec),
    low3y: calc.low3y(sec),
    prevBuy: calc.lastBuyPrice(sec),
    m: (v) => v != null ? fmtAmt(v, market) : '<span class="muted">—</span>',
  };
}
function marketRow(sec, visibleCols, opts = {}) {
  const market = sec.market; // ccy/ev は銘柄の市場で判定（サインタブの混在に対応）
  const ctx = rowContext(sec);
  const selectTd = opts.select ? `<td class="l"><input type="checkbox" class="row-select" data-id="${sec.id}"></td>` : (opts.lead ? '<td class="l"></td>' : '');
  // 編集モード(SEC-94): 一覧(取引/保有/編集アクションを持つ表)でのみ対象列をインライン入力化。サイン/アクション無しの表は対象外
  const editable = inlineEditOn && opts.actions !== 'signal' && opts.actions !== 'none';
  const dataCells = visibleCols.map(col => {
    if (editable && INLINE_FIELDS[col.key]) { const h = ieCellHtml(sec, col.key, ctx); if (h) return h; }
    const renderer = COL_RENDERERS[col.key];
    let cell = renderer ? renderer(sec, ctx) : `<td></td>`;
    // 背景色ルール（マスタ）を中央注入。描画中画面(cfScreen)で該当列の数値がルールにマッチすれば背景色を付与。
    // US の金額系列は共通レートで円換算した値で判定（表示は$のまま・色だけ円相当）。
    return cfInject(cell, col.key, cfConvVal(col.key, sec.market, cfCellValue(col.key, sec, ctx)));
  }).join('');
  let actionsTd = '';
  let rowAttr = '';
  if (opts.actions === 'analysis') {
    actionsTd = `<td class="l nowrap"><button class="btn btn-sm" onclick="openAnalysisDetail('${sec.market}','${esc(String(sec.ticker))}')">詳細</button></td>`;
    // 行のどこをクリックしても詳細ドロワーを開く（既定のリンク/ボタン/ティッカー/銘柄名リンクは除外）
    rowAttr = ` class="ana-row" style="cursor:pointer" onclick="anaRowClick(event,'${sec.market}','${esc(String(sec.ticker))}')"`;
  } else if (opts.actions === 'signal') {
    actionsTd = `<td class="l nowrap"><button class="btn btn-sm btn-primary" onclick="openTxnForm(${sec.id},'buy')">購入を記録</button></td>`;
  } else if (opts.actions !== 'none') {
    actionsTd = `<td class="l nowrap">
        <button class="btn btn-sm" onclick="openTxnForm(${sec.id})">取引</button>
        <button class="btn btn-sm" onclick="openHoldingsForm(${sec.id})">保有</button>
        <button class="btn btn-sm" onclick="openSecurityForm(${sec.id})">編集</button>
      </td>`;
  }
  return `<tr${rowAttr}>${selectTd}${dataCells}${actionsTd}</tr>`;
}
// 分析タブ: 行クリックで詳細ドロワー。既定のリンク/ボタン/入力/ティッカー/銘柄名リンクの上は除外（それぞれの動作を優先）。
function anaRowClick(e, market, ticker) {
  if (e.target.closest('a, button, input, select, label, .tk, .lnk-ext, .nm-strong')) return;
  openAnalysisDetail(market, ticker);
}

// カテゴリのラベル（マスタの色を反映）。色未設定の旧データは従来の .tag.cat 表示にフォールバック
function categoryTag(cat) {
  if (!cat) return muted;
  const c = (store.data.categories || []).find(x => x.category === cat);
  const st = c && c.color ? labelColorStyle(c.color) : '';
  return `<span class="tag${st ? '' : ' cat'}"${st ? ` style="${st}"` : ''}>${esc(cat)}</span>`;
}
// 投資カテゴリ（分析枠ラベル）のタグ。色は investCategories マスタから。
function investCategoryTag(cat) {
  if (!cat) return muted;
  const c = (store.data.investCategories || []).find(x => x.name === cat);
  const st = c && c.color ? labelColorStyle(c.color) : '';
  return `<span class="tag${st ? '' : ' cat'}"${st ? ` style="${st}"` : ''}>${esc(cat)}</span>`;
}

// 銘柄ラベル（複数タグ）。sec.labels（配列）を色つきタグで並べる。マスタ順に並べ替え。
function secLabels(sec) { return Array.isArray(sec && sec.labels) ? sec.labels.filter(Boolean) : []; }
function labelDefColor(name) { const d = (store.data.labelDefs || []).find(x => x.name === name); return d && d.color ? d.color : 'gray'; }
function labelSortIdx(name) { const d = (store.data.labelDefs || []).find(x => x.name === name); return d ? (d.sortOrder ?? 9998) : 9999; }
function labelsTagOne(name) { const st = labelColorStyle(labelDefColor(name)); return `<span class="tag"${st ? ` style="${st}"` : ''}>${esc(name)}</span>`; }
function labelsTag(sec) {
  const ls = [...secLabels(sec)].sort((a, b) => labelSortIdx(a) - labelSortIdx(b));
  if (!ls.length) return muted;
  return ls.map(labelsTagOne).join(' ');
}
// ラベル文字列（取込/出力用）↔配列。区切りは ; , 、 ／ / | いずれも許容。出力は「; 」区切り。
function parseLabels(str) {
  if (str == null) return [];
  return String(str).split(/[;,、／/｜|]+/).map(s => s.trim()).filter(Boolean);
}
function serializeLabels(arr) { return (Array.isArray(arr) ? arr : []).filter(Boolean).join('; '); }
// 取込で未登録ラベルはマスタへ自動追加（色は自動割当）。既存はそのまま。
function ensureLabelDefs(names) {
  const palette = ['blue', 'purple', 'gray', 'green', 'orange', 'pink', 'cyan', 'gold', 'brass'];
  for (const n of names) {
    if (!n) continue;
    if (!(store.data.labelDefs || []).some(d => d.name === n)) {
      store.addLabelDef({ name: n, color: palette[store.data.labelDefs.length % palette.length] });
    }
  }
}

// 銘柄格付（★評価はツールチップに格納してコンパクトに）。色は格付けマスタ(store.data.grades)を反映
function gradeBadge(sec) {
  const g = sec.rating || sec.overallGrade;
  if (!g) return '<span class="muted">—</span>';
  const stars = [sec.starValuation, sec.starStrength, sec.starRisk].filter(x => x != null);
  const title = stars.length ? ` title="バリュエーション/強み/リスク ★${stars.join('/')}"` : '';
  const gm = (store.data.grades || []).find(x => x.grade === String(g).toUpperCase());
  const st = gm && gm.color ? labelColorStyle(gm.color) : '';
  return `<span class="grade grade-${esc(String(g).toLowerCase())}"${st ? ` style="${st}"` : ''}${title}>${esc(g)}</span>`;
}

// ラベル色プリセットのスウォッチ選択UI（hidden input に key を格納）。スマホでもタップで選べる
function colorSwatchPicker(name, selected) {
  return `<div class="color-pick" data-name="${esc(name)}">${LABEL_COLORS.map(c => `
    <button type="button" class="cswatch${c.key === selected ? ' on' : ''}" data-key="${c.key}" title="${esc(c.name)}" style="${labelColorStyle(c.key)}" onclick="pickColor(this)">A</button>`).join('')}
    <input type="hidden" name="${esc(name)}" value="${esc(selected || '')}"></div>`;
}
function pickColor(btn) {
  const wrap = btn.closest('.color-pick');
  wrap.querySelectorAll('.cswatch').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  const inp = wrap.querySelector('input[type=hidden]');
  if (inp) inp.value = btn.dataset.key;
}

function priceInputBtn(sec) {
  if (sec._virtual) return '<span class="muted">—</span>'; // 仮想銘柄(トップ50の未登録分)は手入力不可
  return `<button class="btn btn-sm" onclick="openPriceInput(${sec.id})">価格入力</button>`;
}

function setSort(market, key) {
  const st = listState[market];
  if (st.sortKey === key) st.sortDir *= -1; else { st.sortKey = key; st.sortDir = 1; }
  preserveTableScroll(render);
}

// ---------- カラムピッカー ----------
let _colPickerMarket = null;
let _dragSrcIdx = null;

// 表示中の一覧（見出し＋表示列・行）をTSVでコピー。コピー前に確認モーダルを表示。
function copyDisplayedTable() {
  const tbl = document.querySelector('#app .table-wrap table');
  if (!tbl) { toast('コピーする表がありません'); return; }
  const lines = [...tbl.querySelectorAll('tr')].map(tr => {
    let cells = [...tr.querySelectorAll('th,td')].slice(1); // 先頭=チェックボックス列を除外
    if (cells.length && cells[cells.length - 1].textContent.trim() === '') cells = cells.slice(0, -1); // 末尾の操作列（空）を除外
    return cells.map(c => c.textContent.replace(/[▲▼]/g, '').trim().replace(/\s+/g, ' ')).join('\t');
  });
  const text = lines.join('\n');
  showModal('表示中の一覧をコピー（確認）', `
    <p class="muted" style="margin:0 0 8px">表示中の列・行をそのままコピーします（${lines.length - 1}件）。内容を確認して「コピー」。</p>
    <textarea id="copytbl-ta" rows="12" style="width:100%;font-family:monospace;font-size:12px;white-space:pre" readonly>${esc(text)}</textarea>
    <div class="form-actions">
      <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
      <button type="button" class="btn btn-primary" onclick="excelExportCopy('copytbl-ta')">コピー</button>
    </div>`, { wide: true });
}

// 分析の列キー → パターンキー（どのシグナルか）。列ピッカーで順張り/逆張りの根拠を示すのに使う。
const ANA_PAT_COL = {
  anaCup: 'cup', anaRange: 'range', anaAsc: 'ascTriangle', anaFlag: 'flag', anaBase: 'baseOnBase',
  anaWbottom: 'doubleBottom', anaInvHS: 'invHS', anaRound: 'roundBottom', anaUndercut: 'undercutRally',
  anaClimax: 'sellingClimax', anaRsiDiv: 'rsiDivergence', anaBoll: 'bollingerRecover', anaMaDev: 'maDeviation',
  anaGap: 'gapFill', anaVolDry: 'volDryUp',
};
// 列キー → 役割タグ {t:表示, c:色}。null＝タグなし。
function anaColTag(key) {
  if (key === 'anaContra') return { t: '逆張り総合', c: 'var(--amber)' };
  if (key === 'anaTrend') return { t: '順張り総合', c: '#0ea5e9' };
  if (key === 'anaTotal') return { t: '総合', c: 'var(--muted)' };
  if (key === 'anaWarn' || key === 'anaHsTop' || key === 'anaDblTop') return { t: '順張り警戒', c: 'var(--red)' };
  if (key === 'anaWarnC' || key === 'anaNewLow' || key === 'anaBearFlag' || key === 'anaDescTri') return { t: '逆張り警戒', c: 'var(--red)' };
  if (key === 'anaMACD') return { t: '共通', c: '#a855f7' };   // ゴールデンクロスは順張り・逆張り両方の確認に使う
  if (key === 'anaMa200') return { t: '順張り', c: '#0ea5e9' }; // 200日線上＋上向き＝順張りの確認
  if (key === 'anaRSI' || key === 'ana5d' || key === 'anaDev52w') return { t: '逆張り', c: 'var(--amber)' }; // 売られすぎ/5日線回復＝逆張りの確認
  if (key === 'anaStatus') return { t: '状態', c: 'var(--muted)' };
  if (key === 'anaBuy' || key === 'anaFail') return { t: '水準', c: 'var(--muted)' };
  const pat = ANA_PAT_COL[key];
  if (pat && window.TA && TA.PATTERN_SIDE) {
    const side = TA.PATTERN_SIDE(pat);
    if (side === 'trend') return { t: '順張り', c: '#0ea5e9' };
    if (side === 'contra') return { t: '逆張り', c: 'var(--amber)' };
    return { t: '警戒', c: 'var(--red)' };
  }
  return null;
}
function anaColTagHtml(key) {
  const tg = anaColTag(key); if (!tg) return '';
  return `<span class="cp-side" style="color:${tg.c};border-color:${tg.c}">${tg.t}</span>`;
}

function openColPicker(market) {
  _colPickerMarket = market;
  const isAna = market === 'ANALYSIS' || market === 'ANALYSIS_T';
  // 設定変更で再描画しても一覧のスクロール位置を維持する
  const _prevScroll = (document.querySelector('.cp-wrapper') || {}).scrollTop || 0;
  const order = getColOrder(market);
  const itemsHtml = order.map((c, i) => {
    const mc = MASTER_COLS.find(m => m.key === c.key);
    if (!mc) return '';
    return `<div class="cp-item" draggable="true" data-idx="${i}"
        ondragstart="cpDragStart(event,${i})" ondragover="cpDragOver(event,${i})" ondrop="cpDrop(event,${i})" ondragend="cpDragEnd()">
      <span class="cp-handle">⠿</span>
      <input type="checkbox" onchange="cpToggle('${c.key}',this.checked)" ${c.visible ? 'checked' : ''} title="表示/非表示" style="width:auto">
      ${isAna ? anaColTagHtml(c.key) : ''}
      <input type="text" value="${esc(c.labelOverride || '')}" placeholder="${esc(mc.label)}" onchange="cpSetLabel('${c.key}', this.value)" title="列名（空欄＝既定: ${esc(mc.label)}）" style="flex:1;min-width:140px">
      <label class="muted" style="display:flex;align-items:center;gap:3px;font-size:11px;white-space:nowrap" title="データの最大幅に自動調整（列名は無視）"><input type="checkbox" ${c.auto ? 'checked' : ''} onchange="cpSetAuto('${c.key}',this.checked)" style="width:auto">自動</label>
      <input type="number" min="40" step="2" value="${colWidthPx(c)}" ${c.auto ? 'disabled' : ''} onfocus="this.select()" onchange="cpSetWidth('${c.key}', this.value)" title="列幅(px)" style="width:74px;text-align:right${c.auto ? ';opacity:.4' : ''}"><span class="muted" style="font-size:11px">px</span>
    </div>`;
  }).join('');
  const other = market === 'US' ? 'JP' : market === 'JP' ? 'US'
    : market === 'ANALYSIS' ? 'ANALYSIS_T' : market === 'ANALYSIS_T' ? 'ANALYSIS' : null;
  const copyBtn = other ? `<button type="button" class="btn btn-sm" onclick="copyColLayout('${market}','${other}')">この列設定を${colMarketLabel(other)}ビューにもコピー</button>` : '';
  showModal('列の表示・並び替え・幅・列名', `
    <p class="muted" style="margin:0 0 8px">チェック=表示/非表示、ハンドル(⠿)ドラッグで並び替え、テキスト=列名（空欄で既定）、数値=列幅(px)。</p>
    ${isAna ? `<p class="muted" style="margin:-4px 0 8px;font-size:11px">タグ＝判断の根拠: <span class="cp-side" style="color:var(--amber);border-color:var(--amber)">逆張り</span> 逆張りの材料 / <span class="cp-side" style="color:#0ea5e9;border-color:#0ea5e9">順張り</span> 順張りの材料 / <span class="cp-side" style="color:#a855f7;border-color:#a855f7">共通</span> 両方の確認(MACD GC) / <span class="cp-side" style="color:var(--red);border-color:var(--red)">警戒</span> 売り材料（順張り＝天井／逆張り＝底抜けで別列）/ 指標・状態・水準は補助。</p>` : ''}
    <div class="btn-row" style="align-items:center;margin:0 0 8px">
      <span class="muted">全列幅を</span>
      <input type="number" id="cp-all-width" min="40" step="2" value="90" onfocus="this.select()" style="width:74px;text-align:right">
      <span class="muted">px に</span>
      <button type="button" class="btn btn-sm" onclick="cpSetAllWidths()">一括設定</button>
      <span style="flex:1"></span>
      <button type="button" class="btn btn-sm" onclick="cpReset()">既定に戻す</button>
    </div>
    <div class="btn-row" style="align-items:center;margin:0 0 8px">
      <span class="muted" title="横スクロール時に左端へ固定する列の範囲">列の固定（横スクロール時）</span>
      <select onchange="cpSetSticky(this.value)" style="width:auto">
        ${(() => {
          const stickyN = colStickyCount(market);
          const vis = order.filter(c => c.visible).slice(0, 12);
          const opts = vis.map((c, i) => { const mc = MASTER_COLS.find(m => m.key === c.key) || {}; return `<option value="${i + 1}" ${stickyN === i + 1 ? 'selected' : ''}>「${esc(c.labelOverride || mc.label || c.key)}」まで（${i + 1}列）</option>`; }).join('');
          return `<option value="" ${stickyN == null ? 'selected' : ''}>既定（コード・銘柄名）</option><option value="0" ${stickyN === 0 ? 'selected' : ''}>固定なし</option>${opts}`;
        })()}
      </select>
    </div>
    <div class="cp-wrapper">
      <div id="cp-list">${itemsHtml}</div>
    </div>
    <div class="form-actions" style="margin-top:12px;flex-wrap:wrap">
      ${copyBtn}
      <button type="button" class="btn btn-primary" onclick="closeModal();render()">適用</button>
    </div>`, { wide: true });
  // 再描画後にスクロール位置を復元（先頭に戻らないように）
  if (_prevScroll) {
    const w = document.querySelector('.cp-wrapper');
    if (w) { w.scrollTop = _prevScroll; requestAnimationFrame(() => { w.scrollTop = _prevScroll; }); }
  }
}
// 列プロファイルの表示名（コピーボタン/トースト用）。市場のほか分析の逆張り/順張りビューも扱う。
function colMarketLabel(m) { return ({ US: '米国株', JP: '日本株', FUND: '投信', SIGNAL: '買い増しサイン', ANALYSIS: '逆張り', ANALYSIS_T: '順張り' })[m] || MARKET_LABEL[m] || m; }
// 列レイアウト（表示/非表示・並び順・幅・列名）を他のプロファイルへコピー。米国株↔日本株 / 逆張り↔順張り。
function copyColLayout(fromMarket, toMarket) {
  reconcileColPrefs(fromMarket);
  colPrefs[toMarket] = colPrefs[fromMarket].map(c => ({ key: c.key, visible: c.visible, width: c.width, labelOverride: c.labelOverride, auto: c.auto }));
  // 列の固定範囲も一緒にコピー（未設定なら相手側も未設定に揃える）
  if (colPrefs[fromMarket + '#sticky'] != null) colPrefs[toMarket + '#sticky'] = colPrefs[fromMarket + '#sticky'];
  else delete colPrefs[toMarket + '#sticky'];
  touchColPrefs(toMarket + '#sticky');
  reconcileColPrefs(toMarket); // toMarket に無い列を除去・新規列を補完（同一列群なので実質そのまま）
  saveColPrefs(); touchColPrefs(toMarket);
  toast(`列設定を${colMarketLabel(toMarket)}ビューにコピーしました`, 4000);
  openColPicker(_colPickerMarket);
}
function cpToggle(key, checked) {
  const order = getColOrder(_colPickerMarket);
  const c = order.find(x => x.key === key);
  if (c) { c.visible = checked; saveColPrefs(); touchColPrefs(_colPickerMarket); }
}
function cpSetWidth(key, px) {
  const order = getColOrder(_colPickerMarket);
  const c = order.find(x => x.key === key);
  if (c) { const n = parseInt(px, 10); c.width = (isNaN(n) || n < 40) ? undefined : n; saveColPrefs(); touchColPrefs(_colPickerMarket); }
}
// 列幅モード: auto=データ最大幅に自動調整（列名無視）／固定=px指定
function cpSetAuto(key, checked) {
  const order = getColOrder(_colPickerMarket);
  const c = order.find(x => x.key === key);
  if (c) { c.auto = !!checked; saveColPrefs(); touchColPrefs(_colPickerMarket); openColPicker(_colPickerMarket); }
}
function cpSetAllWidths() {
  const n = parseInt((document.getElementById('cp-all-width') || {}).value, 10);
  if (isNaN(n) || n < 40) { toast('40以上の幅を入力してください'); return; }
  getColOrder(_colPickerMarket).forEach(c => c.width = n);
  saveColPrefs(); touchColPrefs(_colPickerMarket); openColPicker(_colPickerMarket);
  toast(`全列幅を ${n}px にしました`, 3000);
}
function cpSetLabel(key, val) {
  const order = getColOrder(_colPickerMarket);
  const c = order.find(x => x.key === key);
  if (c) { const v = (val || '').trim(); c.labelOverride = v || undefined; saveColPrefs(); touchColPrefs(_colPickerMarket); }
}
function cpDragStart(e, idx) { _dragSrcIdx = idx; e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('cp-dragging'); }
function cpDragOver(e, idx) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
function cpDrop(e, idx) {
  e.preventDefault();
  if (_dragSrcIdx === null || _dragSrcIdx === idx) return;
  const order = getColOrder(_colPickerMarket);
  const [moved] = order.splice(_dragSrcIdx, 1);
  order.splice(idx, 0, moved);
  saveColPrefs(); touchColPrefs(_colPickerMarket);
  // DOM内で並び替え反映（モーダル再描画）
  openColPicker(_colPickerMarket);
}
function cpDragEnd() { _dragSrcIdx = null; document.querySelectorAll('.cp-dragging').forEach(el => el.classList.remove('cp-dragging')); }
function cpReset() { resetColPrefs(_colPickerMarket); delete colPrefs[_colPickerMarket + '#sticky']; saveColPrefs(); touchColPrefs(_colPickerMarket); touchColPrefs(_colPickerMarket + '#sticky'); openColPicker(_colPickerMarket); }
// 列の固定範囲（''=既定 / 0=固定なし / N=左からN列）。表示列の並び・表示状態が変わっても列数指定として維持される
function cpSetSticky(v) {
  const key = _colPickerMarket + '#sticky';
  if (v === '') delete colPrefs[key];
  else colPrefs[key] = Math.max(0, parseInt(v, 10) || 0);
  saveColPrefs(); touchColPrefs(key);
}

// ---------- サイン一覧 ----------
// 到達（reached）と もうすぐ（残り5%以内）の銘柄を分けて返す
function signalRows() {
  const reached = [], near = [];
  for (const sec of store.data.securities) {
    const ev = calc.evaluate(sec);
    if (!ev) continue;
    if (ev.reached) reached.push(sec);
    else if (ev.remainingDropPct <= 5) near.push(sec);
  }
  return { reached, near };
}

let signalMarketFilter = 'all'; // 'all' | 'JP' | 'US'
function setSignalMarket(m) { signalMarketFilter = m; renderSignals(); }
function renderSignals() {
  const st = listState.SIGNAL;
  let { reached, near } = signalRows();
  if (signalMarketFilter !== 'all') {
    reached = reached.filter(s => s.market === signalMarketFilter);
    near = near.filter(s => s.market === signalMarketFilter);
  }
  // 比率列の分母。'表示中' は到達＋もうすぐの両グループ（この表に出ている行）が母数
  ratioCtx = buildRatioCtx([...reached, ...near]);
  const visOrderS = getColOrder('SIGNAL').filter(c => c.visible);
  const visibleCols = visOrderS.map(c => MASTER_COLS.find(m => m.key === c.key)).filter(Boolean);
  const colCount = visibleCols.length + 1; // +1 = アクション列
  const head = colHeadHtml(visibleCols, st, 'SIGNAL', null);
  // 末尾=操作列（購入を記録ボタン）。狭いと切れるため十分な幅を確保
  const SIG_ACTION_W = 116;
  const sigColgroup = `<colgroup>${visOrderS.map(c => colTag(c)).join('')}<col style="width:${SIG_ACTION_W}px"></colgroup>`;
  const sigTableW = SIG_ACTION_W + visOrderS.reduce((a, c) => a + colWidthPx(c), 0);
  // 到達／もうすぐ を1つの表にまとめ、グループ見出し行で区切る（列幅を揃えるため）
  // colspanセル自体への position:sticky はブラウザで効きにくいため、セル内のラベル(span)を sticky 化して左固定する。
  const groupRow = (label, cls2, n) => `<tr class="sig-group ${cls2}"><td class="l" colspan="${colCount}"><span class="sig-group-label">${label}　${n} 件</span></td></tr>`;
  const bodyRows = (secs) => secs.length
    ? secs.map(sec => marketRow(sec, visibleCols, { actions: 'signal' })).join('')
    : `<tr><td class="muted" colspan="${colCount}" style="padding:12px 16px">該当する銘柄はありません。</td></tr>`;
  const seg = (m, label) => `<button class="${signalMarketFilter === m ? 'active' : ''}" onclick="setSignalMarket('${m}')">${label}</button>`;
  app.innerHTML = `
    <div class="section">
      <div class="section-head">
        <div class="seg" role="tablist">${seg('all', '全市場')}${seg('JP', '日本株')}${seg('US', '米国株')}</div>
        <div style="flex:1"></div>
        ${ratioToolbarHtml()}
        <button class="btn btn-sm col-picker-btn" onclick="openColPicker('SIGNAL')" title="列の表示設定">${svgIcon('columns', '')} 列</button>
      </div>
      <div class="section-body">
        <div class="table-wrap"><table class="fixed-cols holdings dense" style="width:${sigTableW}px">${sigColgroup}
          <thead><tr>${head}<th class="l"></th></tr></thead>
          <tbody>
            ${groupRow('🔴 到達（今が買い時）', 'reached', reached.length)}
            ${bodyRows(sortSecurities(reached, 'SIGNAL'))}
            ${groupRow('🟡 もうすぐ（残り 5% 以内）', 'near', near.length)}
            ${bodyRows(sortSecurities(near, 'SIGNAL'))}
          </tbody>
        </table></div>
      </div>
    </div>`;
  autoFitColumns(document.querySelector('#app table.fixed-cols'));
  applyStickyCols(document.querySelector('#app table.fixed-cols'), 'SIGNAL'); // コード・銘柄名を左端固定（列設定の「列の固定」対応）
  scheduleFit(); // 市場フィルタ切替で renderSignals() を直接呼ばれた時も枠内スクロール化（render() を経由しないため自前で）
}

// ダッシュボード用の簡易サイン表（本日「新規到達(新)」のみ。継続(続)は除外）
function dashSignalsTable() {
  const { reached } = signalRows();
  const newReached = reached.filter(s => calc.reachKind(s) === '新');
  // ダッシュボードは画面いっぱいなので、0件の空表示は詰まった見た目にする（既定の .empty は
  // 上下56pxの余白で134pxも使い、その分だけページがスクロールしていた）
  if (newReached.length === 0) return `<div class="empty empty-sm">本日新しく買い増しサインに到達した銘柄はありません。</div>`;
  const cols = ['ticker', 'name', 'market', 'price', 'drop', 'trigger', 'buyAmount']
    .map(k => MASTER_COLS.find(m => m.key === k));
  const head = cols.map(c => `<th class="${c.left ? 'l' : ''}" title="${esc(c.label)}">${c.label}</th>`).join('');
  const sorted = sortSecurities(newReached, 'SIGNAL');
  return `<div class="table-wrap"><table class="holdings dense">
    <thead><tr>${head}</tr></thead>
    <tbody>${sorted.map(sec => marketRow(sec, cols, { actions: 'none' })).join('')}</tbody>
  </table></div>`;
}

// 金額マスタの変更履歴セクション（版管理の可視化）
function amountHistorySection() {
  const hist = [...(store.data.amountHistory || [])].sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1));
  if (hist.length === 0) return '';
  const rows = hist.slice(0, 30).map(h => `<tr>
    <td class="l">${fmtDateTime(h.changedAt)}</td>
    <td class="l">${esc(h.category)}</td>
    <td>${yen(h.prevJpy)} → <strong>${yen(h.newJpy)}</strong></td>
    <td>$${num(h.prevUsd)} → <strong>$${num(h.newUsd)}</strong></td>
  </tr>`).join('');
  return `<details class="form-group" style="margin:0 16px 14px">
    <summary>金額変更履歴（${hist.length}件）</summary>
    <div class="table-wrap"><table>
      <thead><tr><th class="l">変更日時</th><th class="l">カテゴリ</th><th>日本株(円)</th><th>米国株($)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </details>`;
}

// 銘柄ごとの適用金額スナップショット履歴（モーダル）
function openAmountHistory(secId) {
  const sec = store.data.securities.find(s => s.id === secId);
  const snaps = (store.data.amountSnapshots || []).filter(x => x.securityId === secId)
    .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1));
  const trigLabel = { master_change: 'マスタ金額変更', category_change: 'カテゴリ変更' };
  const cur = store.data.categories.find(c => c.category === sec.category);
  const curRow = `<tr><td class="l">現在</td><td class="l">${sec.category ? categoryTag(sec.category) : '—'}</td>
    <td>${cur ? yen(cur.amountJpy) : '—'}</td><td>${cur ? '$' + num(cur.amountUsd) : '—'}</td></tr>`;
  const rows = snaps.map(s => `<tr>
    <td class="l">${fmtDateTime(s.recordedAt)}<br><span class="muted">${trigLabel[s.trigger] || s.trigger}</span></td>
    <td class="l">${esc(s.category)}</td><td>${yen(s.amountJpy)}</td><td>$${num(s.amountUsd)}</td>
  </tr>`).join('');
  showModal(`適用金額履歴 — ${esc(calc.displayName(sec))}`, `
    <p class="muted">この銘柄に適用されていた1回購入額（カテゴリ金額）の履歴です。最新が上。</p>
    <div class="table-wrap"><table>
      <thead><tr><th class="l">時点</th><th class="l">カテゴリ</th><th>日本株(円)</th><th>米国株($)</th></tr></thead>
      <tbody>${curRow}${rows || ''}</tbody>
    </table></div>
    ${snaps.length === 0 ? '<div class="empty">変更履歴はまだありません。</div>' : ''}
    <div class="form-actions"><button type="button" class="btn" onclick="openSecurityForm(${secId})">← 編集に戻る</button><button type="button" class="btn" onclick="closeModal()">閉じる</button></div>`);
}

// 銘柄ごとの分析履歴（モーダル・閲覧専用）。記録は編集フォームの「分析メタ」保存／分析結果の取込でたまる。
// 評価日=行・項目=列の表で比較しやすく。列幅は固定（table-layout:fixed）し、最長になりがちな分析メモは
// 専用の広い列で折り返し（1文字潰れ防止）、評価日列は横スクロール時も左固定で見出しが残る。
function openAnalysisHistory(secId) {
  const sec = store.data.securities.find(s => s.id === secId);
  const list = store.analysesSorted(secId);
  const dash = '<span class="muted">—</span>';
  const g = (v) => (v != null && v !== '') ? esc(String(v)) : dash;
  const starTxt = (a) => {
    const parts = [a.starValuation, a.starStrength, a.starRisk].map(v => v != null ? '★' + v : '—');
    return parts.every(p => p === '—') ? dash : parts.join('/');
  };
  const ccy = MARKET_CCY[sec.market];
  // 推奨投資額は円建て（分析シート由来）。市場に関わらず yen() で表示する（米株でも "$" を付けない）。
  const amtTxt = (a) => a.recoAmount != null ? yen(a.recoAmount) : dash;
  // カテゴリは分析レコードに保存されていれば各回の値、無ければ先頭(=現在)行のみ銘柄の現在カテゴリで補完
  const catTxt = (a, isFirst) => { const c = a.category || (isFirst ? sec.category : null); return c ? categoryTag(c) : dash; };
  // [見出し, 列幅px]。table-layout:fixed なので幅はこの colgroup で決まる。分析メモは width 未指定＝可変にし、
  // モーダルの余り幅を吸収させる（テーブルとモーダルの幅を一致＝右余白をなくす）。
  const cols = [['評価日', 92], ['総合', 50], ['格付', 50], ['買い時', 60], ['★ ﾊﾞﾘｭ/強/ﾘｽｸ', 122], ['カテゴリ', 96], ['推奨額', 84], ['優先順', 60], ['分析メモ', null]];
  const MEMO_MIN = 240; // 可変メモ列の最小幅。これを下回るとテーブルが横スクロール
  const colgroup = `<colgroup>${cols.map(c => `<col${c[1] ? ` style="width:${c[1]}px"` : ''}>`).join('')}</colgroup>`;
  const minW = cols.reduce((a, c) => a + (c[1] || MEMO_MIN), 0);
  const head = `<tr>${cols.map(c => `<th>${esc(c[0])}</th>`).join('')}</tr>`;
  const rows = list.map((a, i) => `<tr>
    <td>${esc(a.analysisDate)}</td>
    <td>${g(a.overallGrade)}</td>
    <td>${g(a.rating)}</td>
    <td>${g(a.buyGrade)}</td>
    <td style="white-space:nowrap">${starTxt(a)}</td>
    <td>${catTxt(a, i === 0)}</td>
    <td style="white-space:nowrap;text-align:right">${amtTxt(a)}</td>
    <td>${a.priority != null ? a.priority : dash}</td>
    <td class="ah-memo">${a.analysisNote ? esc(a.analysisNote) : dash}</td>
  </tr>`).join('');
  // 株価シナリオ分析の履歴（短期・中期の予想レンジ）。銘柄分析とは別の履歴（priceScenarios）
  const scList = store.scenariosSorted(secId);
  const scCell = (v) => { const f = scFmtRange(v, sec.market); return f || dash; };
  const scRows = scList.map(a => `<tr>
    <td>${esc(a.scenarioDate)}</td>
    <td style="text-align:right">${a.scenarioPrice != null ? fmtAmt(a.scenarioPrice, sec.market) : dash}</td>
    <td>${scCell(a.stBear)}</td><td>${scCell(a.stBase)}</td><td>${scCell(a.stBull)}</td>
    <td>${scCell(a.mtBear)}</td><td>${scCell(a.mtBase)}</td><td>${scCell(a.mtBull)}</td>
  </tr>`).join('');
  const scTable = scList.length ? `
    <h4 style="margin:14px 0 6px">株価シナリオ履歴</h4>
    <div class="table-wrap"><table class="ah-table" style="width:100%;min-width:660px">
      <thead><tr><th>分析日</th><th>分析時株価</th><th>短期弱気</th><th>短期ベース</th><th>短期強気</th><th>中期弱気</th><th>中期ベース</th><th>中期強気</th></tr></thead>
      <tbody>${scRows}</tbody>
    </table></div>` : '';
  showModal(`分析履歴 — ${esc(calc.displayName(sec))}`, `
    <p class="muted">この銘柄の分析評価の履歴です（評価日の新しい順）。記録は銘柄編集フォームの「分析メタ」保存、または分析結果の取込でたまります。先頭が現在の表示値です。横にスクロールできます。</p>
    ${list.length ? `<div class="table-wrap"><table class="ah-table" style="width:100%;min-width:${minW}px">${colgroup}
      <thead>${head}</thead><tbody>${rows}</tbody>
    </table></div>` : '<div class="empty">分析履歴はまだありません。</div>'}
    ${scTable}
    <div class="form-actions"><button type="button" class="btn" onclick="openSecurityForm(${secId})">← 編集に戻る</button><button type="button" class="btn" onclick="closeModal()">閉じる</button></div>`, { wide: true });
}

// 取込履歴セクション
function importHistorySection() {
  const hist = store.data.importHistory || [];
  if (!hist.length) return '';
  const modeLabel = { append: '追加', replace: '洗い替え', upsert: '追加+上書き' };
  const rows = hist.slice(0, 20).map(h => `<tr>
    <td class="l">${fmtDateTime(h.importedAt)}</td>
    <td class="l">${esc(h.broker)}（${(h.markets || []).map(m => MARKET_LABEL[m] || m).join('・')}）</td>
    <td class="l">${modeLabel[h.mode] || h.mode}</td>
    <td>${h.count}</td>
    <td class="l">${h.baseDate ? esc(h.baseDate) : '—'}</td>
  </tr>`).join('');
  return `<details class="form-group" style="margin:0 16px 14px">
    <summary>取込履歴（${hist.length}件）</summary>
    <div class="table-wrap"><table>
      <thead><tr><th class="l">取込日時</th><th class="l">証券会社（市場）</th><th class="l">モード</th><th>件数</th><th class="l">基準日</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </details>`;
}

// 証券会社ごとの最終取込日時（取込忘れ防止）。固定プロファイル単位で最終取込を表示。
function importStatusHtml() {
  const hist = store.data.importHistory || [];
  const last = {};        // 固定プロファイル: profile→entry
  const lastGeneric = {}; // 汎用洗い替え: broker|market→entry
  for (const h of hist) {
    if (h.profile === 'generic' && h.broker) {
      const gk = h.broker + '|' + ((h.markets && h.markets[0]) || '');
      if (!lastGeneric[gk] || (h.importedAt || '') > (lastGeneric[gk].importedAt || '')) lastGeneric[gk] = h;
    } else {
      const k = h.profile || h.broker || '';
      if (!last[k] || (h.importedAt || '') > (last[k].importedAt || '')) last[k] = h;
    }
  }
  const fixed = Object.entries(IMPORT_PROFILES).filter(([, p]) => p.fixed);
  const rows = fixed.map(([k, p]) => {
    const h = last[k];
    const label = p.label.replace(/（.*$/, '').trim(); // 括弧以降を省略（例: SBI 米国株）
    const when = h && h.importedAt ? fmtDateTime(h.importedAt) : '<span class="neg">未取込</span>';
    const cnt = h ? `${h.count}件` : '—';
    return `<tr><td class="l">${esc(label)}</td><td class="l">${when}</td><td>${cnt}</td></tr>`;
  }).join('');
  // 汎用洗い替えの取込（Webull等・固定形式なし）も表示
  const grows = Object.entries(lastGeneric).map(([gk, h]) => {
    const [b, m] = gk.split('|');
    return `<tr><td class="l">${esc(b)} ${MARKET_LABEL[m] || m}（汎用）</td><td class="l">${fmtDateTime(h.importedAt)}</td><td>${h.count}件</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th class="l">証券会社（取込形式）</th><th class="l">最終取込日時</th><th>件数</th></tr></thead>
    <tbody>${rows}${grows}</tbody>
  </table></div>`;
}

// ---------- レポート（SEC-17） ----------
// 取引サマリーの期間: 'all'=全期間 / 'year'=年別（年指定）/ 'month'=月別（年＋月指定）
let reportPeriod = 'all';
let reportYear = new Date().getFullYear();       // 年別・月別で対象の年
let reportMonthNum = new Date().getMonth() + 1;  // 月別で対象の月(1-12)
// 取引サマリーの絞り込み（汎用フィルタ）。市場・銘柄ラベルで金額/件数/一覧を絞る（他の扱いは不変）。
let txnFilter = { market: 'ALL', labels: [], labelMode: 'exclude' }; // labelMode: 'exclude'=選択ラベルを除外 / 'include'=選択ラベルのみ
function refreshTxnSection() { const el = document.getElementById('txn-section'); if (el) el.innerHTML = txnSummaryHtml(); else renderReport(); scheduleFit(); }
function setReportPeriod(p) { reportPeriod = p; refreshTxnSection(); }
function setReportYear(y) { reportYear = parseInt(y, 10) || new Date().getFullYear(); refreshTxnSection(); }
function setReportMonthNum(m) { reportMonthNum = parseInt(m, 10) || (new Date().getMonth() + 1); refreshTxnSection(); }
// 取引データに存在する年の一覧（降順）。無ければ今年のみ。年・月プルダウンの選択肢に使う。
function txnYears() {
  const set = new Set();
  for (const t of store.data.transactions) { const y = (t.tradedAt || '').slice(0, 4); if (/^\d{4}$/.test(y)) set.add(+y); }
  set.add(new Date().getFullYear());
  return [...set].sort((a, b) => b - a);
}
// レポート内タブ: 'assets'=資産集計 / 'txn'=取引サマリー / 'matrix'=分布マトリックス
let reportTab = 'assets';
function setReportTab(t) { reportTab = t; renderReport(); }
// マトリックスの縦軸・横軸は「列にある区分」から選択。市場フィルタ（全部/米国株/日本株）も切替。
const MATRIX_AXES = [
  ['category', 'カテゴリ'], ['rating', '格付'], ['overallGrade', '総合'], ['buyGrade', '買い時'],
  ['market', '市場'], ['detailType', '詳細種別'], ['broker', '証券会社'], ['ruleName', 'ルール'],
  ['sector', 'セクター'], ['priority', '優先順位'],
];
let reportMatrixRow = 'rating';   // 縦軸
let reportMatrixCol = 'category'; // 横軸
let matrixMarket = 'ALL';         // 'ALL' | 'US' | 'JP'
function setReportMatrixRow(f) { reportMatrixRow = f; renderReport(); }
function setReportMatrixCol(f) { reportMatrixCol = f; renderReport(); }
function setMatrixMarket(m) { matrixMarket = m; renderReport(); }
function matrixAxisName(f) { const a = MATRIX_AXES.find(x => x[0] === f); return a ? a[1] : f; }
// ============ マーケット（ランキング）タブ ============
let mktState = { market: 'US', sub: 'all', kind: 'turnover' };
// ランキングキャッシュは store.data.mktRanking に永続化（localStorage保存＋Google同期）。key -> { items(5年高値込), at }
function mktCacheMap() { return (store.data.mktRanking ||= {}); }
let mktBusy = false;
const MKT_KINDS = [['turnover', '売買代金'], ['marketcap', '時価総額'], ['gainers', '値上がり'], ['losers', '値下がり']];
const MKT_JP_SUBS = [['all', '全市場'], ['prime', 'プライム'], ['standard', 'スタンダード'], ['growth', 'グロース']];
function mktKey() { return `${mktState.market}:${mktState.market === 'JP' ? mktState.sub : '-'}:${mktState.kind}`; }
// ---------- 市場の時価総額1位（日米別） ----------
// 「時価1位まで」列の分子。時価総額ランキング(全市場)を取った時に1位を記録する。
// 値は原通貨の実額（US=USD / JP=円）。**store.data.settings には置かない**——settings は同期が
// singleTs（オブジェクトまるごと後勝ち）なので、端末が自動で毎日書き込むと、もう片方の端末が
// 手で変えた設定（画面の並び順 navOrder 等）を丸ごと巻き戻してしまう。ここは自動取得のキャッシュなので
// store.data.mktTopCap（トップレベル・市場ごとに at で3-wayマージ）に置く（sync-merge SCHEMA 登録済み）。
function topMarketCapMap() { return (store.data.mktTopCap ||= {}); }
function topMarketCap(market) { const t = topMarketCapMap()[market]; return (t && t.cap > 0) ? t : null; }
// at は取得時刻(ms)。古い記録で新しい記録を上書きしない（キャッシュ由来と当日取得が競合するため）
function setTopMarketCap(market, it, at) {
  if (!it || !(it.marketCap > 0)) return false;
  const m = topMarketCapMap();
  const cur = m[market] || {};
  const ts = at || Date.now();
  if (cur.at > ts) return false;
  const next = { code: String(it.code || ''), name: it.name || '', cap: it.marketCap, at: ts };
  if (cur.code === next.code && cur.name === next.name && cur.cap === next.cap) return false;
  m[market] = next;
  return true;
}
// 「時価1位まで」の表示テキスト（保有/マスタ/カルテ/詳細/マーケットで共通）。r=倍率（1位の時価総額÷自分）。
// 1位自身（r<=1）は「1位」。tip は1位の銘柄名・時価総額・上昇率。
function capToTopFmt(market, r) {
  const t = topMarketCap(market);
  if (r == null) return { label: null, pct: null, tip: t ? '時価総額が未取得' : '時価総額1位が未取得（取得に失敗しています）' };
  const up = r > 1;
  const pct = up ? `+${((r - 1) * 100).toFixed(0)}%` : '到達済み';
  return {
    label: up ? `${r.toFixed(2)}倍` : '1位',
    pct,
    tip: t ? `${market === 'US' ? '米国株' : '日本株'}の時価総額1位 ${t.name || t.code}(${t.code}) ${fmtTurnover(t.cap, market)} まで ${r.toFixed(2)}倍（${pct}）` : '',
  };
}
// 時価総額（原通貨の実額）から倍率を出す。マーケットのランキング行（保有していない銘柄）用。
function capToTopOf(market, capRaw) {
  const t = topMarketCap(market);
  return (t && capRaw > 0) ? t.cap / capRaw : null;
}
// 「時価1位まで」のセル（表共通）。1位は控えめ表示、未取得は「—」＋理由をtooltipに。
function capToTopTd(market, r) {
  const f = capToTopFmt(market, r);
  const body = f.label == null ? muted : (r > 1 ? esc(f.label) : `<span class="muted">${esc(f.label)}</span>`);
  return `<td title="${esc(f.tip)}">${body}</td>`;
}
// 「時価1位まで」列の分子を自己補完する。未取得（or 前日以前）の市場だけ、時価総額ランキング1件を
// 裏で取得して記録する。株価更新やマーケットタブを待たずに列が埋まるようにするための保険で、
// 1市場あたり1日1回（失敗時もその日の再試行はしない＝毎描画のリトライを防ぐ）。
let _topCapTriedDate = null;
async function ensureTopMarketCap() {
  if (!store.data) return;
  const d = today();
  if (_topCapTriedDate === d) return;
  const need = ['US', 'JP'].filter(mk => { const t = topMarketCap(mk); return !t || !t.at || new Date(t.at).toDateString() !== new Date().toDateString(); });
  if (!need.length) { _topCapTriedDate = d; return; }
  _topCapTriedDate = d;
  let changed = false;
  await Promise.all(need.map(async mk => {
    try {
      const r = await fetch(`/api/ranking?market=${mk}&kind=marketcap&sub=all&count=1`).then(x => x.ok ? x.json() : null).catch(() => null);
      const it = r && r.items && r.items[0];
      if (it && setTopMarketCap(mk, it, Date.now())) changed = true;
    } catch (_) { /* 取得失敗→今日はこのまま「—」。翌日再試行 */ }
  }));
  if (changed) { store.save(); preserveTableScroll(render); }
}
// マーケットタブの時価総額ランキング（全市場）のキャッシュから1位を反映。
// タブを開いた時はキャッシュ表示で再取得しないため、これが無いと表示中のランキングと列の分子がズレる。
function syncTopCapFromCache() {
  let changed = false;
  for (const [market, key] of [['US', 'US:-:marketcap'], ['JP', 'JP:all:marketcap']]) {
    const c = mktCacheMap()[key];
    if (c && c.items && c.items[0] && setTopMarketCap(market, c.items[0], c.at)) changed = true;
  }
  return changed;
}
function setMktMarket(m) { mktState.market = m; if (m === 'US') mktState.sub = 'all'; renderMarketTab(); }
function setMktSub(s) { mktState.sub = s; renderMarketTab(); }
function setMktKind(k) { mktState.kind = k; renderMarketTab(); }
function mktRefresh() { loadRanking(true); }
function mktAbbr(n) { if (n == null) return '—'; const a = Math.abs(n); if (a >= 1e12) return (n / 1e12).toFixed(2) + '兆'; if (a >= 1e8) return (n / 1e8).toFixed(1) + '億'; if (a >= 1e6) return (n / 1e6).toFixed(0) + 'M'; return Number(n).toLocaleString('ja-JP'); }
function mktFetchedAt(ts) { try { return new Date(ts).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } }
function mktKabutan(code, market) { return market === 'US' ? `https://us.kabutan.jp/stocks/${encodeURIComponent(code)}/chart` : `https://kabutan.jp/stock/chart?code=${encodeURIComponent(code)}`; }
function mktFindSec(code, market) { return store.data.securities.find(s => s.market === market && (s.ticker || '').toUpperCase() === String(code).toUpperCase()); }
function mktClickName(code, market) { const s = mktFindSec(code, market); if (s) openSecurityDetail(s.id); else window.open(mktKabutan(code, market), '_blank'); }
// ランキングからの登録。**注意銘柄(watch)にはしない**（2026-08-05 すみぽん指示。
// 注意フラグは自分で警戒する銘柄に付けるもので、ランキングからの登録は単なる銘柄追加）。
async function addRankingWatch(code, market) {
  let s = mktFindSec(code, market);
  const isNew = !s;
  if (!s) s = store.addSecurity({ market, ticker: String(code).toUpperCase(), currency: market === 'US' ? 'USD' : 'JPY', assetClass: 'stock', enabled: true, ruleId: store.defaultRule().id });
  renderMarketTab();
  // 名前・セクター等(meta)と現在値・高値(price)を取得してから完了表示（SEC-129: metaが無いと名前がコードのまま）
  await withBusy(`${code} の銘柄情報を取得中…`, async () => {
    await api.refreshMeta([s]);
    await api.refreshPrice([s]);
  }, isNew ? `${code} を登録しました` : `${code} は登録済みです`);
  renderMarketTab();
  if (currentView === 'secMaster') renderSecMaster();
}
async function loadRanking(force) {
  const key = mktKey();
  if (mktBusy) return;
  // キャッシュ表示のときも、表示するランキングの1位を「時価1位まで」列の分子に反映する
  if (!force && mktCacheMap()[key]) { if (syncTopCapFromCache()) store.save(); renderMarketTab(); return; }
  mktBusy = true; renderMarketTab();
  try {
    const { market, sub, kind } = mktState;
    const r = await fetch(`/api/ranking?market=${market}&kind=${kind}&sub=${sub}&count=50`).then(x => x.ok ? x.json() : { items: [] }).catch(() => ({ items: [] }));
    let items = (r && r.items) || [];
    const symOf = (code) => market === 'JP' ? code + '.T' : code;
    if (items.length) {
      // 5年高値を一括取得（価格APIの highs=1）。日本株はこの呼び出しで現在値・前日比も得る（取得元HTMLに無いため）。
      // 米株の現在値はランキング値を使用。サブリクエスト上限(~50)回避のため mktFetchHighs が15件ずつ分割取得する。
      const hi = await mktFetchHighs(items.map(it => symOf(it.code)));
      items = items.map(it => {
        const q = hi[symOf(it.code)]; const ok = q && !q.error;
        // highs=1 の1回取得で返る値を保持（追加取得ゼロで列を増やせる）。5年高値だけでなく
        // 52週高値・1年/3年安値・前日終値・出来高も列設定で表示できるよう項目に載せる。
        const next = {
          ...it,
          high5y:  ok && q.high5y  != null ? q.high5y  : null,
          high52w: ok && q.high52w != null ? q.high52w : null,
          low1y:   ok && q.low1y   != null ? q.low1y   : null,
          low3y:   ok && q.low3y   != null ? q.low3y   : null,
          volume:  ok && q.volume  != null ? q.volume  : (it.volume ?? null),
        };
        if (market === 'JP') {
          // 日本株はランキング取得元HTMLに現在値・前日比が無いため highs 取得で補う。
          const price = ok ? q.price : null;
          next.price = price;
          next.prevClose = ok && q.prevClose != null ? q.prevClose : null;
          next.changePct = (price != null && ok && q.prevClose) ? (price - q.prevClose) / q.prevClose * 100 : null;
        } else {
          // 米株はランキングに現在値・前日比があるが、前日終値は無いので highs 取得の prevClose を保持。
          next.prevClose = ok && q.prevClose != null ? q.prevClose : (it.prevClose ?? null);
        }
        return next;
      });
    }
    // 米株は名称を日本語化（保有銘柄と同ルール。例 AAPL→アップル）。names=1 は1銘柄1リクエスト。
    // 50件だとCloudflareのサブリクエスト上限(~50/req)に達するため20件ずつ分割取得する。
    if (market === 'US' && items.length) {
      const nm = {};
      for (let i = 0; i < items.length; i += 20) {
        const batch = items.slice(i, i + 20).map(it => it.code);
        const part = await fetch(`/api/info?names=1&symbols=${encodeURIComponent(batch.join(','))}`).then(x => x.ok ? x.json() : {}).catch(() => ({}));
        Object.assign(nm, part);
      }
      items = items.map(it => { const n = nm[it.code]; return (n && n.name) ? { ...it, name: n.name } : it; });
    }
    mktCacheMap()[key] = { items, at: Date.now() };
    // 時価総額ランキング(全市場)の1位を「時価1位まで」列用に記録（今取ったばかりなので最優先）
    if (kind === 'marketcap' && (market === 'US' || sub === 'all') && items[0]) setTopMarketCap(market, items[0], Date.now());
  } catch (_) { mktCacheMap()[key] = { items: [], at: Date.now() }; }
  store.save(); // ランキングキャッシュ（5年高値・取得日時込）を永続化＝localStorage保存＋Google同期に載る
  mktBusy = false; renderMarketTab();
}
// 5年高値を15件ずつ分割取得（Cloudflareの1リクエストあたりサブリクエスト上限~50を回避）。{sym:{high5y,price,prevClose,...}} を返す
async function mktFetchHighs(syms) {
  const out = {};
  for (let i = 0; i < syms.length; i += 15) {
    const batch = syms.slice(i, i + 15);
    const pr = await fetch(`/api/price?highs=1&symbols=${encodeURIComponent(batch.join(','))}`).then(x => x.ok ? x.json() : {}).catch(() => ({}));
    Object.assign(out, pr);
  }
  // 穴埋め: それでも取れなかった銘柄だけ、間を置いて少人数でもう一度。
  // 日本株ランキングは現在値・前日比をこの取得に依存しており、1件でも落ちると
  // 「売買代金だけあって現在値が—」の行になるため、サーバ側リトライに加えて最後に1回さらう。
  const missing = syms.filter(s => { const q = out[s]; return !q || q.error || q.price == null; });
  if (missing.length) {
    await new Promise(r => setTimeout(r, 1500));
    for (let i = 0; i < missing.length; i += 8) {
      const batch = missing.slice(i, i + 8);
      const pr = await fetch(`/api/price?highs=1&symbols=${encodeURIComponent(batch.join(','))}`).then(x => x.ok ? x.json() : {}).catch(() => ({}));
      for (const [k, v] of Object.entries(pr)) if (v && !v.error && v.price != null) out[k] = v;
    }
  }
  return out;
}

// ---------- 市場ランキング上位バッジ（銘柄名の先頭に順位を表示） ----------
// 市場全体の売買代金/時価総額ランキングTOP10に保有銘柄が入っていれば「代金3位」等のバッジを出す。
// 1日1回取得（重いので）。コード→順位の対応表を市場×指標で持つ。
let _rankTop = null;      // { 'JP:turnover': {CODE:rank}, 'JP:marketcap': {...}, 'US:turnover':..., 'US:marketcap':... }
let _rankTopDate = null;  // YYYY-MM-DD（1日1回更新）
let _rankBadgesBusy = false;
async function loadRankBadges(force) {
  if (_rankBadgesBusy) return;
  if (!force && _rankTop && _rankTopDate === today()) return;
  _rankBadgesBusy = true;
  const combos = [['JP', 'turnover'], ['JP', 'marketcap'], ['US', 'turnover'], ['US', 'marketcap']];
  const out = {};
  let capChanged = false;
  try {
    await Promise.all(combos.map(async ([market, kind]) => {
      const map = {};
      try {
        const r = await fetch(`/api/ranking?market=${market}&kind=${kind}&sub=all&count=10`).then(x => x.ok ? x.json() : null).catch(() => null);
        const items = (r && r.items) || [];
        items.slice(0, 10).forEach((it, i) => { if (it.code != null) map[String(it.code).toUpperCase()] = i + 1; });
        // 「時価1位まで」列の分子（市場の時価総額1位）を、このバッジ取得のついでに1日1回更新
        if (kind === 'marketcap' && items[0] && setTopMarketCap(market, items[0])) capChanged = true;
      } catch (_) { /* この指標は取得失敗→空 */ }
      out[`${market}:${kind}`] = map;
    }));
    _rankTop = out; _rankTopDate = today();
    if (capChanged) store.save();
  } finally { _rankBadgesBusy = false; }
}
// 保有銘柄のランキング順位バッジHTML（市場全体TOP10内のときのみ）
function rankBadgeHtml(sec) {
  if (!_rankTop || (sec.market !== 'JP' && sec.market !== 'US')) return '';
  const code = String(sec.ticker || '').toUpperCase();
  const mc = (_rankTop[sec.market + ':marketcap'] || {})[code];
  const to = (_rankTop[sec.market + ':turnover'] || {})[code];
  let h = '';
  if (mc) h += `<span class="rank-badge rb-mcap rb-r${mc <= 3 ? mc : 'n'}" title="時価総額ランキング（市場全体）${mc}位">時価${mc}</span>`;
  if (to) h += `<span class="rank-badge rb-turn rb-r${to <= 3 ? to : 'n'}" title="売買代金ランキング（市場全体）${to}位">代金${to}</span>`;
  return h;
}
// 金額の概数表示（市場別。米株=$B/$T、日本株=億/兆）
function mktAmt(n, market) {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (market === 'US') { if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T'; if (a >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B'; if (a >= 1e6) return '$' + (n / 1e6).toFixed(0) + 'M'; return '$' + Math.round(n).toLocaleString('ja-JP'); }
  if (a >= 1e12) return (n / 1e12).toFixed(2) + '兆'; if (a >= 1e8) return (n / 1e8).toFixed(0) + '億'; return Math.round(n).toLocaleString('ja-JP');
}
// 売買代金/時価総額の表示。日本株=兆/億/万（100億以上は億まで、100億未満は億+万、1億未満は万）。
// 米株=T/B/M（＄記号なし）。
function fmtTurnover(n, market) {
  if (n == null) return null;
  const sign = n < 0 ? '-' : '', a = Math.abs(n);
  if (market === 'US') {
    if (a >= 1e12) return sign + (a / 1e12).toFixed(2) + 'T';
    if (a >= 1e9)  return sign + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6)  return sign + (a / 1e6).toFixed(1) + 'M';
    return sign + Math.round(a).toLocaleString('ja-JP');
  }
  if (a >= 1e12) { const cho = Math.floor(a / 1e12), oku = Math.round((a % 1e12) / 1e8); return sign + cho + '兆' + (oku ? oku + '億' : ''); }
  if (a >= 1e10) return sign + Math.round(a / 1e8) + '億';                                   // 100億以上=億まで
  if (a >= 1e8)  { const oku = Math.floor(a / 1e8), man = Math.round((a % 1e8) / 1e4); return sign + oku + '億' + (man ? man + '万' : ''); } // 1〜100億=億+万
  if (a >= 1e4)  return sign + Math.round(a / 1e4) + '万';                                    // 1億未満=万
  return sign + Math.round(a).toLocaleString('ja-JP');
}
// 市場ラベル（米株=取引所、日本株=各銘柄の実際の市場区分プライム/スタンダード/グロース）
function mktMarketLabel(it, market) {
  if (market === 'US') return it.exchange || '米国株';
  return it.section || '東証'; // 日本株は銘柄ごとの区分
}
// ---- マーケットランキングの列描画（列設定＝MKTRANKスコープ）----
// 市場データ列は「追加取得ゼロ」でランキング取得値(it)から算出（store.data.prices は非参照＝判定に無影響）。
// ツール内情報列（カテゴリ/格付/ラベル等）は登録済み銘柄のみ既存 COL_RENDERERS(sec) に委譲、未登録は「—」。
function mktItValue(it, key, market) {
  const price = it.price ?? null;
  switch (key) {
    case 'market':      return market;
    case 'price':       return price;
    case 'day':         return it.changePct ?? null;
    case 'prevClose':   return it.prevClose ?? null;
    case 'dayAmt':      return (price != null && it.prevClose != null) ? price - it.prevClose : null;
    case 'high5y':      return it.high5y ?? null;
    case 'high52w':     return it.high52w ?? null;
    case 'low1y':       return it.low1y ?? null;
    case 'low3y':       return it.low3y ?? null;
    case 'dropFrom5y':  return pctFromBase(price, it.high5y);
    case 'dropFrom52w': return pctFromBase(price, it.high52w);
    case 'riseFrom1y':  return pctFromBase(price, it.low1y);
    case 'riseFrom3y':  return pctFromBase(price, it.low3y);
    case 'turnover':    return it.turnover ?? null;
    case 'marketCap':   return it.marketCap ?? null;
    case 'dividend':    return it.dividend ?? null;
    case 'divYield':    return it.divYield ?? null;
    default: return null;
  }
}
// ハイブリッド列は it（米株）→ 無ければ登録済み銘柄のマスタ値、の順で解決する。
function mktHybridValue(it, sec, key, market) {
  if (key === 'capToTop') return capToTopOf(market, it.marketCap) ?? (sec ? calc.capToTop(sec) : null);
  const v = mktItValue(it, key, null);
  if (v != null) return v;
  if (!sec) return null;
  return key === 'divYield' ? calc.divYield(sec) : calc.field(sec, 'dividend');
}
// 背景色ルール用の値（時価総額は保有側の列と同じ百万単位に合わせる）
function mktCfValue(it, sec, ctx, key, market) {
  if (key === 'marketCap') return it.marketCap != null ? it.marketCap / 1e6 : null;
  if (MKTRANK_IT_KEYS.has(key)) return mktItValue(it, key, market);
  if (MKTRANK_HYBRID_KEYS.has(key)) return mktHybridValue(it, sec, key, market);
  return sec ? cfCellValue(key, sec, ctx) : null;
}
// 市場データ列の <td>（表示）。値は it 由来。既存ランキングの見た目（かぶたんリンク・億/万表記）を踏襲。
function mktItCell(it, key, market) {
  const v = mktItValue(it, key, market);
  switch (key) {
    case 'market':    return `<td class="l"><span class="tag ${market.toLowerCase()}">${esc(mktMarketLabel(it, market))}</span></td>`;
    case 'price':     return `<td><a href="${mktKabutan(it.code, market)}" target="_blank" rel="noopener" class="lnk-ext">${it.price != null ? fmtAmt(it.price, market) : '—'}</a></td>`;
    case 'day':       return `<td class="${cls(v)}"><a href="${mktKabutan(it.code, market)}" target="_blank" rel="noopener" class="lnk-ext">${v != null ? signed(v) + '%' : '—'}</a></td>`;
    case 'dayAmt':    return `<td class="${cls(v)}">${v != null ? (v > 0 ? '+' : '') + fmtAmt(v, market) : '—'}</td>`;
    case 'prevClose': case 'high5y': case 'high52w': case 'low1y': case 'low3y':
      return `<td>${v != null ? fmtAmt(v, market) : '—'}</td>`;
    case 'dropFrom5y': case 'dropFrom52w': case 'riseFrom1y': case 'riseFrom3y':
      return `<td class="${cls(v)}">${v != null ? signed(v) + '%' : '—'}</td>`;
    case 'turnover':  return `<td>${mktAmt(it.turnover, market)}</td>`;
    case 'marketCap': return `<td>${mktAmt(it.marketCap, market)}</td>`;
    default: return '<td>—</td>';
  }
}
// ハイブリッド列の <td>。配当/株は市場通貨で、配当利回りは%で（保有銘柄の列と同じ書式）。
function mktHybridCell(it, sec, key, market) {
  const v = mktHybridValue(it, sec, key, market);
  if (key === 'capToTop') return capToTopTd(market, v);
  if (v == null) return `<td class="l"><span class="muted">—</span></td>`;
  return key === 'divYield' ? `<td>${v.toFixed(2)}%</td>` : `<td>${fmtAmt(v, market)}</td>`;
}
// ソート値。市場データ列は it 由来、ツール内情報列は登録済み銘柄の sortValue を流用（未登録は末尾）。
function mktSortVal(it, key, market) {
  if (MKTRANK_IT_KEYS.has(key)) { const v = mktItValue(it, key, market); return (typeof v === 'number') ? v : (v == null ? -Infinity : v); }
  const sec = mktFindSec(it.code, market);
  if (MKTRANK_HYBRID_KEYS.has(key)) return mktHybridValue(it, sec, key, market) ?? -Infinity;
  return sec ? sortValue(sec, key) : -Infinity;
}
// ランキング1行（順位・コード・名称は先頭固定、以降は列設定に従う）。
function mktRankRow(it, rank, market, visibleCols) {
  const sec = mktFindSec(it.code, market);   // 登録済みなら実体（ツール内情報を表示）
  const owned = !!sec;
  const ctx = sec ? rowContext(sec) : null;
  const cells = visibleCols.map(col => {
    let cell;
    if (MKTRANK_IT_KEYS.has(col.key)) cell = mktItCell(it, col.key, market);
    else if (MKTRANK_HYBRID_KEYS.has(col.key)) cell = mktHybridCell(it, sec, col.key, market);
    else if (sec) { const r = COL_RENDERERS[col.key]; cell = r ? r(sec, ctx) : '<td class="l"><span class="muted">—</span></td>'; }
    else cell = '<td class="l"><span class="muted">—</span></td>';
    return cfInject(cell, col.key, cfConvVal(col.key, market, mktCfValue(it, sec, ctx, col.key, market)));
  }).join('');
  const codeTd = `<td class="l col-code"><span class="tk ${market.toLowerCase()}" style="cursor:pointer" onclick="mktClickName('${esc(it.code)}','${market}')">${esc(it.code)}</span></td>`;
  const nameTd = `<td class="l"><strong class="lnk-ext nm-strong mkt-name" onclick="mktClickName('${esc(it.code)}','${market}')" title="${esc(it.name || it.code)}">${esc(nameAbbr(it.name || it.code))}</strong>${owned ? ' <span class="tag" title="登録済み">登</span>' : ''}</td>`;
  const actionTd = `<td class="l nowrap">${owned
    ? `<button class="btn btn-sm" disabled title="登録済みの銘柄です">登録済</button>`
    : `<button class="btn btn-sm" onclick="addRankingWatch('${esc(it.code)}','${market}')" title="この銘柄を登録する（注意銘柄にはしない）">＋登録</button>`}</td>`;
  return `<tr><td>${rank}</td>${codeTd}${nameTd}${cells}${actionTd}</tr>`;
}
function renderMarketTab() {
  // ランキング取得は数秒かかり、その間にユーザーが別タブへ移りうる。取得完了後の再描画が
  // #app を無条件に上書きすると「別タブに移ったのに数秒後マーケットに戻される」ように見える。
  // 描画は「マーケットを表示中」の時だけ行う（キャッシュは保存済みなので戻れば表示される）。
  if (currentView !== 'market') return;
  const key = mktKey(); const cache = mktCacheMap()[key]; const items = cache ? cache.items : null;
  const { market, sub, kind } = mktState;
  const mseg = `<div class="seg"><button class="${market === 'US' ? 'active' : ''}" onclick="setMktMarket('US')">米国株</button><button class="${market === 'JP' ? 'active' : ''}" onclick="setMktMarket('JP')">日本株</button></div>`;
  const subseg = market === 'JP' ? `<div class="seg" style="margin-left:6px;flex-wrap:wrap">${MKT_JP_SUBS.map(([v, l]) => `<button class="${sub === v ? 'active' : ''}" onclick="setMktSub('${v}')">${l}</button>`).join('')}</div>` : '';
  const kseg = `<div class="seg">${MKT_KINDS.map(([v, l]) => `<button class="${kind === v ? 'active' : ''}" onclick="setMktKind('${v}')">${l}</button>`).join('')}</div>`;
  // 列設定（保有銘柄と同じ getColOrder/colHeadHtml/colTag/openColPicker を MKTRANK スコープで再利用）
  const st = listState.MKTRANK;
  const ccy = MARKET_CCY[market];
  const visOrder = getColOrder('MKTRANK').filter(c => c.visible);
  const visibleCols = visOrder.map(c => MASTER_COLS.find(m => m.key === c.key)).filter(Boolean);
  let body;
  if (!items) body = '<div class="empty">読み込み中…</div>';
  else if (!items.length) body = '<div class="empty">データを取得できませんでした（休場/時間外、または取得元の仕様変更の可能性）。「更新」で再取得できます。</div>';
  else {
    // 順位は取得順（ランキング順位）を保持。列ヘッダをクリックした時だけ並べ替える。
    let entries = items.map((it, i) => ({ it, rank: i + 1 }));
    if (st.sortKey && st.sortKey !== 'rank') {
      const dir = st.sortDir;
      entries = entries.slice().sort((A, B) => {
        const va = mktSortVal(A.it, st.sortKey, market), vb = mktSortVal(B.it, st.sortKey, market);
        if (va < vb) return -1 * dir; if (va > vb) return 1 * dir; return 0;
      });
    }
    const LEAD = [{ w: 48 }, { w: 70 }, { w: 190 }]; // 順位/コード/名称（先頭固定）
    const ACTION_W = 76;
    const leadW = LEAD.reduce((a, c) => a + c.w, 0);
    const colgroup = `<colgroup>${LEAD.map(c => `<col style="width:${c.w}px">`).join('')}${visOrder.map(c => colTag(c)).join('')}<col style="width:${ACTION_W}px"></colgroup>`;
    const tableW = leadW + ACTION_W + visOrder.reduce((a, c) => a + colWidthPx(c), 0);
    const head = `<th>順位</th><th class="l">コード</th><th class="l">名称</th>${colHeadHtml(visibleCols, st, 'MKTRANK', ccy)}<th class="l"></th>`;
    const rows = entries.map(e => mktRankRow(e.it, e.rank, market, visibleCols)).join('');
    body = `<div class="table-wrap"><table class="fixed-cols holdings dense" style="width:${tableW}px">${colgroup}<thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  app.innerHTML = `
    <div class="section">
      <div class="section-head"><h2>マーケット ランキング（上位50）</h2>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="muted" style="font-size:11px">${cache && cache.at ? '取得：' + mktFetchedAt(cache.at) : ''}</span>
          <button class="btn btn-sm col-picker-btn" onclick="openColPicker('MKTRANK')" title="列の表示・並び替え・幅の設定">${svgIcon('columns', '')} 列</button>
          <button class="btn btn-sm btn-primary" onclick="mktRefresh()" ${mktBusy ? 'disabled' : ''}>${mktBusy ? '取得中…' : '更新'}</button></div></div>
      <div class="toolbar" style="border:none;padding:10px 16px 0;gap:8px;flex-wrap:wrap">${mseg}${subseg}</div>
      <div class="toolbar" style="border:none;padding:8px 16px 0;gap:8px;flex-wrap:wrap"><span class="muted">ランキング</span>${kseg}
        ${market === 'JP' ? '<span class="muted" style="font-size:11px">※日本株の現在値・前日比は価格APIから取得</span>' : ''}</div>
      <div class="section-body" style="padding:12px 16px 16px">${body}</div>
    </div>`;
  autoFitColumns(document.querySelector('#app table.fixed-cols'));
  applyStickyCols(document.querySelector('#app table.fixed-cols'), 'MKTRANK');
  scheduleFit(); // 表を枠内スクロールに（ページ全体でなく表内でスクロール・画面に収める）。非同期データ到着後の高さで確定させる
  if (!items && !mktBusy) loadRanking(false); // タブを開いた時（起動時相当）に自動取得
}

// ---------- ニュースタブ（フェーズN1: RSS見出し一覧＋カテゴリ絞り込み） ----------
// 記事一覧はメモリキャッシュのみ（RSS取得は無料・軽量なので保存しない）。既読だけを
// store.data.newsRead（リンク→既読日時）に保存し Google同期する（sync-merge.js SCHEMA 登録済み）。
let _newsCache = null;   // { items:[{title,link,source,pubDate}], at }
let _newsSeenMark = null; // セッション開始時点のプール取得時刻。黄○＝それより後の「更新」で入った新着。
                          // アプリ開き直し/リロードで青へ戻る。タブ移動→戻るでは消えない（セッション変数のため自然にそうなる）
let newsBusy = false;
let newsHeldOnly = false; // 関連銘柄（登録銘柄に見出し一致）のみ表示
const NEWS_REAL_CATS = ['market', 'earnings', 'disclosure', 'video', 'macro', 'other']; // 「すべて」以外の実カテゴリ
// 表示するカテゴリは newsPrefs.hideCats（非表示カテゴリ）で管理＝インラインのトグルで即切替＆同期保存。
// ただし newsPrefs は Google同期対象のため、裏で同期が走ると「別端末の選択状態」で
// 開いている画面のカテゴリが勝手に切り替わっていた（例: すべて→動画だけ）。
// そこで開いている間はセッション側の選択(_newsHideCatsSession)を優先し、同期では画面を変えない。
// 次回の読み込み時は同期された設定から始まる（＝端末間の引き継ぎ自体は従来どおり）。
let _newsHideCatsSession = null;
function newsHideCats() {
  if (_newsHideCatsSession) return _newsHideCatsSession;
  return (store.data.newsPrefs && store.data.newsPrefs.hideCats) || [];
}
// ニュース画面を開いた時点の選択をセッションに固定（以後、同期で書き換わっても画面は動かさない）
function newsPinCatSession() { if (!_newsHideCatsSession) _newsHideCatsSession = [...((store.data.newsPrefs && store.data.newsPrefs.hideCats) || [])]; }
function newsCatShown(c) { return !newsHideCats().includes(c); }
function newsAllCatsShown() { return NEWS_REAL_CATS.every(newsCatShown); }
function newsToggleCat(c) {
  const p = store.data.newsPrefs || (store.data.newsPrefs = { hideCats: [], hideDiscTypes: [] });
  p.hideCats = p.hideCats || [];
  if (c === 'all') {
    // 全部表示中に押したら全部解除（1つだけ選びやすく）／そうでなければ全部表示
    p.hideCats = newsAllCatsShown() ? [...NEWS_REAL_CATS] : [];
  } else if (newsHideCats().includes(c)) p.hideCats = newsHideCats().filter(x => x !== c);
  else p.hideCats = [...newsHideCats(), c];            // 自動リセットしない（0個でもそのまま）
  p._updatedAt = new Date().toISOString();
  _newsHideCatsSession = [...p.hideCats];              // 自分の操作をセッションにも反映
  store.save(); renderNews();
}
// プールに存在する開示の「まとめ種別（グループ）」（インライン・トグル用。存在するグループだけ出す）
function newsPresentDiscTypes() {
  const set = new Set();
  for (const it of (_newsCache ? _newsCache.items : [])) if (isDiscItem(it)) set.add(disclosureGroup(it));
  return discGroupsOrdered().filter(id => set.has(id));
}
function newsDiscTypeShown(id) { return !((store.data.newsPrefs && store.data.newsPrefs.hideDiscTypes) || []).includes(id); }
function newsToggleDiscType(id) {
  const p = store.data.newsPrefs || (store.data.newsPrefs = { hideCats: [], hideDiscTypes: [] });
  p.hideDiscTypes = p.hideDiscTypes || [];
  const present = newsPresentDiscTypes();
  if (id === 'all') {
    // 全部表示中に押したら（表示中のグループを）全部解除／そうでなければ全部表示
    const allShown = present.every(newsDiscTypeShown);
    p.hideDiscTypes = allShown ? [...new Set([...p.hideDiscTypes, ...present])] : p.hideDiscTypes.filter(x => !present.includes(x));
  } else if (p.hideDiscTypes.includes(id)) p.hideDiscTypes = p.hideDiscTypes.filter(x => x !== id);
  else p.hideDiscTypes = [...p.hideDiscTypes, id];    // 自動リセットしない
  p._updatedAt = new Date().toISOString();
  store.save(); renderNews();
}
let newsShowHidden = false; // 非表示にした記事の一覧（復元用）を表示中か
let newsDays = 0; // 期間フィルタ（0=全て / 1 / 3 / 7 日以内）
let newsMkt = 'all'; // 市場フィルタ（all / JP / US）。関連銘柄・開示の市場で絞る（一般ニュースは市場情報がないので常に表示）
const NEWS_MKTS = [['all', '全市場'], ['JP', '日本株'], ['US', '米国株']];
function setNewsMkt(m) { newsMkt = m; renderNews(); }
// 記事の市場（関連銘柄の市場＋開示元＋英語＝米国寄り）。空＝市場情報なし（一般ニュース）
function newsItemMarkets(it, ms) {
  const set = new Set();
  for (const s of (ms || [])) set.add(s.market);
  if (it.source === '適時開示') set.add('JP');
  if (it.source === 'SEC EDGAR') set.add('US');
  if (it.lang === 'en') set.add('US');
  return set;
}
const NEWS_DAYS = [[0, '全期間'], [1, '24時間'], [3, '3日'], [7, '7日']];
function setNewsDays(d) { newsDays = d; renderNews(); }
const NEWS_CATS = [['all', 'すべて'], ['market', '市況'], ['earnings', '決算'], ['disclosure', '開示'], ['video', '動画'], ['macro', '為替・金利'], ['other', 'その他']];
// YouTube購読チャンネル既定（テスタ公式）。マスタ・設定＞YouTubeチャンネルで編集可
const DEFAULT_YT_CHANNELS = [{ id: 'UCfJEDCUlzQl4-atLp6Z9DcQ', name: 'テスタ' }];
// 要約に使えるGeminiモデル（東証マーケット振り返りツールと同一）。空=自動（優先順に試し上限時は次へ降格）
const YT_MODELS = [
  ['gemini-3.6-flash', 'Gemini 3.6 Flash（20回/日）'],
  ['gemini-3.5-flash', 'Gemini 3.5 Flash（20回/日）'],
  ['gemini-3-flash-preview', 'Gemini 3 Flash（20回/日）'],
  ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite（500回/日）'],
  ['gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite（500回/日）'],
  ['gemini-2.5-flash', 'Gemini 2.5 Flash（20回/日）'],
  ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite（20回/日）'],
];
// 品質優先の並び（自動時のチェーン／固定選択時の降格先の順序）。上ほど高精度、下ほど回数上限が大きい。
const YT_QUALITY_ORDER = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];
function ytModelSetting() { return (store.data.settings && store.data.settings.ytModel) || ''; }
// パネルの「モデル: … ・ 12,345 tok」表記
function ytModelNote(model, tokens, fellBack) {
  if (!model) return '';
  let s = 'モデル: ' + model + (fellBack ? '（降格）' : '');
  if (tokens != null) s += ' ・ ' + Number(tokens).toLocaleString('ja-JP') + ' tok';
  return s;
}
// 要約リクエストに渡すモデル配列。自動＝品質優先の全チェーン／固定＝選択モデルを先頭に置き上限時は他へ降格。
function ytModelChainForRequest() {
  const sel = ytModelSetting();
  if (!sel) return YT_QUALITY_ORDER.slice();
  return [sel, ...YT_QUALITY_ORDER.filter(m => m !== sel)];
}
// 開示の細分類（TDnet/EDGARの見出し・書類種別から判定）。表示設定で種類ごとに除外できる
// 開示種別マスタ（既定）。name=タグ名（＝ID） / group=フィルタタブのまとめ名 / keywords=見出し判定（正規表現・| 区切り）。
// 上から順に最初に一致した種別のタグが付く。groupが同じ種別はニュースの絞り込みタブで束ねられる（タグは種別ごと）。
// ユーザーがマスタ・設定＞開示種別マスタで編集可能（store.data.discTypeDefs）。編集内容はタグ付け・分類の両方に反映される。
const DEFAULT_DISC_TYPES = [
  { name: '月次', group: '決算', keywords: '月次|月度' },
  { name: '決算', group: '決算', keywords: '決算短信|四半期報告書|年次報告書|決算説明|決算報告' },
  { name: '業績修正', group: '決算', keywords: '業績予想|業績修正|上方修正|下方修正|通期予想|配当予想の修正' },
  { name: '配当', group: '決算', keywords: '配当|剰余金の配当|増配|減配' },
  { name: '自己株取得', group: '自己株', keywords: '自己株式.{0,6}(取得|買付|公開買付)|自社株買' },
  { name: '自己株処分', group: '自己株', keywords: '自己株式.{0,6}処分' },
  { name: '株式分割', group: '株式分割', keywords: '株式分割|併合' },
  { name: '株式報酬', group: '株式報酬', keywords: '譲渡制限付株式|ＲＳＵ|RSU|新株予約権|ストックオプション|従業員持株' },
  { name: '人事', group: '人事', keywords: '役員.{0,4}異動|人事異動|代表取締役|取締役.{0,4}(選任|異動)|社長' },
  { name: 'M&A・組織', group: 'M&A・組織', keywords: '買収|合併|子会社.{0,4}(取得|異動|設立)|事業譲渡|会社分割|ＴＯＢ|TOB|株式交換|株式移転' },
  { name: '重要事象(8-K)', group: '重要事象(8-K)', keywords: '重要事象' },
  { name: '株主総会', group: '株主総会', keywords: '株主総会|招集通知' },
  { name: '訂正・変更', group: '訂正・変更', keywords: '開示事項の(変更|訂正)|（訂正）|の一部変更' },
];
const _discReCache = new Map(); // キーワード文字列→コンパイル済み正規表現（マスタ編集時に clear）
function _discRe(kw) { if (_discReCache.has(kw)) return _discReCache.get(kw); let r = null; try { r = new RegExp(kw); } catch (_) { r = null; } _discReCache.set(kw, r); return r; }
function discDefs() { const d = masterRowsLive(store.data.discTypeDefs); return d.length ? d : DEFAULT_DISC_TYPES; }
function disclosureDef(it) {
  const t = (it && it.title) || '';
  for (const d of discDefs()) { if (!d.keywords) continue; const re = _discRe(d.keywords); if (re && re.test(t)) return d; }
  return { name: 'その他開示', group: 'その他開示' };
}
function disclosureType(it) { return disclosureDef(it).name; }          // 名前＝タグ＝ID
function disclosureTypeLabel(name) { return name; }                     // 名前がそのままラベル
function disclosureGroup(it) { return disclosureDef(it).group || 'その他開示'; }
function disclosureGroupLabel(g) { return g; }                          // グループ名がそのままラベル
// 定義順のグループ一覧（フィルタタブの並び）＋末尾に「その他開示」
function discGroupsOrdered() { const out = []; for (const d of discDefs()) { const g = d.group || 'その他開示'; if (!out.includes(g)) out.push(g); } if (!out.includes('その他開示')) out.push('その他開示'); return out; }
// 記事が開示アイテムか（TDnet/EDGAR合流分）
function isDiscItem(it) { return it && (it.source === '適時開示' || it.source === 'SEC EDGAR'); }
// 見出しキーワードでカテゴリ判定。判定順は特異度順（決算→為替・金利→市況→その他）。
// 開示アイテム(TDnet/EDGAR)は item.cat を持つのでそれを優先
function newsCategory(itOrTitle) {
  if (itOrTitle && typeof itOrTitle === 'object') { if (itOrTitle.cat) return itOrTitle.cat; return newsCategory(itOrTitle.title); }
  const t = itOrTitle || '';
  if (/決算|上方修正|下方修正|業績予想|増益|減益|営業利益|純利益|増配|減配|自社株買い|株式分割/.test(t)) return 'earnings';
  if (/円安|円高|ドル円|為替|金利|日銀|FRB|FOMC|利上げ|利下げ|国債|インフレ|物価|CPI|関税/.test(t)) return 'macro';
  if (/日経平均|東証|TOPIX|株式市場|株価|続伸|続落|反発|反落|急騰|急落|ダウ|ナスダック|S&P|米国株|米株|プライム市場|グロース市場|半導体株/.test(t)) return 'market';
  return 'other';
}
async function newsRefresh(auto) {
  if (newsBusy) return;
  newsBusy = true;
  if (!auto) renderNews(); // 「更新」ボタンを取得中…に
  try {
    // クライアント側も保険のタイムアウト（25秒）。サーバーが詰まっても newsBusy を戻す
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      // ニュース(RSS)・登録銘柄の適時開示(TDnet)・購読YouTube動画を並行取得し合流
      const [res, discItems, videoItems] = await Promise.all([
        fetch('/api/news', { signal: ctrl.signal }),
        _newsDiscForHoldings().catch(() => []),
        _newsVideos().catch(() => []),
      ]);
      const data = await res.json();
      let items = (data && Array.isArray(data.items)) ? data.items : [];
      updNoteVideos(videoItems);   // 新着動画を更新情報フィードへ（NEWバッジ・ダッシュボード用）
      store.data.lastVideoCheck = store._now();   // ここで取得済み＝直後の裏取得を省く
      items = items.concat(discItems).concat(videoItems);
      // リンク重複排除・新しい順
      const seen = new Set();
      items = items.filter(it => it.link && !seen.has(it.link) && seen.add(it.link))
        .sort((a, b) => (b.pubDate || '') < (a.pubDate || '') ? -1 : 1);
      if (items.length) newsPoolStore(items, new Date().toISOString());
    } finally { clearTimeout(timer); }
  } catch (_) { /* 失敗時は既存キャッシュのまま。キャッシュ無しなら empty 表示になる */ }
  finally { newsBusy = false; }
  // 取得完了時に別タブへ移っていたら描画しない（マーケットタブと同じ配慮。DESIGN.md参照）
  if (currentView === 'news') renderNews();
  updDailyCheck(true);   // ニュース更新のついでにマクロ指標の更新も確認（動画は上で取得済み）
}
// ===== ニュース一覧の共有プール（store.data.newsPool・Google同期） =====
// 一覧は「更新」ボタンで取得して newsPool に保存し同期する＝全端末が同じ一覧・同じ○の色（2026-07-23 すみぽん要望）。
// タブを開いた時はプール（＝ドライブ同期済みの手持ちデータ）を表示するだけで、ニュースサイトへは取りに行かない。
// ○の色: 未読のうち batch===at（今回の取得で初登場）=黄 / batch===prevAt（前回の取得で初登場）=緑 / それ以前=青。
function newsPoolCache() {
  const p = store.data.newsPool;
  if (!p || !Array.isArray(p.items) || !p.items.length) return _newsCache;
  if (!_newsCache || _newsCache.at !== p.at) {
    // 保存時に落とした動画のサムネ・要約(desc)を表示用コピーへ復元（サムネ=動画IDから再構成 / 要約=ytSummaries）。
    // プール内のオブジェクトを直接書き換えるとスリム化が打ち消される（次のsaveで太って保存される）ためコピーに対して行う。
    const items = p.items.map(it => {
      if (!it.videoId) return it;
      const o = { ...it };
      if (!o.thumb) o.thumb = `https://i.ytimg.com/vi/${o.videoId}/hqdefault.jpg`;
      if (!o.desc) { const s = (store.data.ytSummaries || {})[o.videoId]; if (s && s.summary) o.desc = s.summary; }
      return o;
    });
    _newsCache = { items, at: p.at, prevAt: p.prevAt || null };
  }
  return _newsCache;
}
// 取得結果をプールへ保存。各記事に batch（初めて取得に現れた時刻）を刻む（既存記事は前回の値を引き継ぐ）。
// 容量対策（プールは localStorage と Drive の同期バンドル両方に載るため極力軽く）:
//   最新200件・約200KBまで。動画のサムネ(thumb=IDから再構成可)と要約(desc=ytSummaries から復元可)は保存しない。
//   長い本文は800字に切り詰め（RSSの要約は通常この範囲。表示・翻訳への実害は小）。
function newsPoolStore(items, at) {
  const prev = store.data.newsPool;
  const prevBy = new Map(((prev && prev.items) || []).map(it => [it.link, it]));
  for (const it of items) { const old = prevBy.get(it.link); it.batch = (old && old.batch) || at; }
  let keep = items.slice(0, 200).map(it => {
    const o = { ...it };
    delete o.thumb;
    if (o.videoId) delete o.desc;
    if (typeof o.desc === 'string' && o.desc.length > 800) o.desc = o.desc.slice(0, 800);
    return o;
  });
  let json = JSON.stringify(keep);
  while (json.length > 200000 && keep.length > 50) { keep = keep.slice(0, Math.floor(keep.length / 2)); json = JSON.stringify(keep); }
  store.data.newsPool = { items: keep, at, prevAt: (prev && prev.at) || null, _updatedAt: at };
  _newsCache = null; newsPoolCache(); // 表示用キャッシュを作り直し（動画のサムネ・要約を復元した状態で）
  store.save();
}
// 記事クリック時: 既読を記録（再描画はしない＝リンクを開く動作を妨げず、クラスだけ落とす）。
// リンクは data-link 属性から読む（タブ一覧・銘柄詳細ドロワーの両方で共用）
function newsReadLink(el) {
  const link = el && el.dataset && el.dataset.link;
  if (!link) return;
  store.data.newsRead[link] = new Date().toISOString();
  // 既読は45日で掃除（同期データを無限に増やさない）
  const lim = Date.now() - 45 * 86400 * 1000;
  for (const k in store.data.newsRead) {
    const d = new Date(store.data.newsRead[k]);
    if (isNaN(d) || d.getTime() < lim) delete store.data.newsRead[k];
  }
  store.save();
  el.classList.remove('unread', 'nu-new');
}

// 記事をリンクから探す（要約パネル用）
function newsFindItem(link) { return (_newsCache ? _newsCache.items : []).find(it => it.link === link); }
// 記事クリック→アプリ内の要約パネル（元記事へは直接飛ばない。全文はRSSに無いので要約まで＋元記事リンク）
function newsOpenArticle(ev, el) {
  ev.preventDefault();
  const link = el.dataset.link; if (!link) return;
  // 既読を記録（クラスも落とす）
  store.data.newsRead[link] = new Date().toISOString();
  const lim = Date.now() - 45 * 86400 * 1000;
  for (const k in store.data.newsRead) { const d = new Date(store.data.newsRead[k]); if (isNaN(d) || d.getTime() < lim) delete store.data.newsRead[k]; }
  store.save(); el.classList.remove('unread', 'nu-new');
  const it = newsFindItem(link);
  if (it && it.cat === 'video') { openVideoPanel(it); return; } // 動画はAI要約パネル
  // 要約が無い記事（開示・日経マーケット・Yahoo等）はパネルを出さず一発で元記事を開く
  if (!it || !it.desc) { window.open(link, '_blank'); return; }
  const secs = newsMatchSecs(it), tags = newsMatchTags(it);
  const chips = [
    ...secs.map(s => `<span class="news-sec" onclick="closeModal();openSecurityDetail(${s.id})">${esc(nameAbbr(calc.displayName(s)))}</span>`),
    ...tags.map(t => `<span class="news-tag">${esc(t.name)}</span>`),
    ...newsMatchMajors(it, new Set([...secs.map(s => searchNorm(calc.displayName(s))), ...tags.map(t => searchNorm(t.name))]))
      .map(mj => `<span class="news-listed" onclick="window.open('${mktKabutan(mj.code, mj.market)}','_blank')">${esc(mj.label)}</span>`),
  ].join(' ');
  const isEn = it.lang === 'en';
  const hasTransTitle = isEn && store.data.newsTrans[it.link] && store.data.newsTrans[it.link].t;
  const descPending = isEn && it.desc && !(store.data.newsTrans[it.link] && store.data.newsTrans[it.link].d); // 本文は開いた時に遅延翻訳
  const jaTitle = newsDispTitle(it), jaDesc = newsDispDesc(it);
  const bodyHtml = jaDesc
    ? esc(jaDesc)
    : (descPending ? '<span class="muted">翻訳中…</span>' : '<span class="muted">この記事は要約が配信されていません。元記事でご確認ください。</span>');
  const body = `
    <div class="news-panel">
      <div class="np-meta"><span>${esc(it.source || '')}</span><span>${it.pubDate ? new Date(it.pubDate).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</span>${isEn ? `<span class="news-trans-badge">${hasTransTitle ? '自動翻訳' : 'EN'}</span>` : ''}</div>
      <h3 class="np-title">${esc(jaTitle)}</h3>
      ${hasTransTitle ? `<div class="np-orig muted">原題: ${esc(it.title)}</div>` : ''}
      ${chips ? `<div class="np-chips">${chips}</div>` : ''}
      <div class="np-body" id="np-body-text">${bodyHtml}</div>
      <p class="np-note muted">※ アプリ内に表示できるのは配信元の要約までです（記事全文は著作権のため取得しません）。</p>
      <div class="form-actions" style="margin-top:14px">
        <button type="button" class="btn btn-primary" onclick="window.open('${esc(it.link)}','_blank')">元記事を開く ↗</button>
        <button type="button" class="btn" onclick="closeModal()">閉じる</button>
      </div>
    </div>`;
  showModal('ニュース', body);
  // 英語記事の本文（要約）は開いた時に翻訳して差し替え（未翻訳時のみ）
  if (descPending) newsTranslateDesc(link).then(() => {
    const el = document.getElementById('np-body-text');
    const tr = store.data.newsTrans[link];
    if (el && tr && tr.d) el.textContent = tr.d;
    else if (el) el.innerHTML = '<span class="muted">翻訳を取得できませんでした。' + (it.desc ? '原文: ' + esc(it.desc) : '') + '</span>';
  });
}

// 動画のAI要約パネル。キャッシュ済みなら表示、無ければGeminiで生成→キャッシュ＆同期（1動画1回）。
function openVideoPanel(it) {
  const cached = (store.data.ytSummaries || {})[it.videoId];
  const has = cached && cached.summary;
  const secs = newsMatchSecs(it), tags = newsMatchTags(it);
  const chips = [
    ...secs.map(s => `<span class="news-sec" onclick="closeModal();openSecurityDetail(${s.id})">${esc(nameAbbr(calc.displayName(s)))}</span>`),
    ...tags.map(t => `<span class="news-tag">${esc(t.name)}</span>`),
  ].join(' ');
  const headline = (has && cached.headline) ? cached.headline : it.title;
  const body = `
    <div class="news-panel">
      <div class="np-meta"><span>${esc(it.source || '')}</span><span>${it.pubDate ? new Date(it.pubDate).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</span><span class="news-cat">動画</span></div>
      <h3 class="np-title" id="np-video-headline">${esc(headline)}</h3>
      <div class="np-orig muted">動画タイトル: ${esc(it.title)}</div>
      ${chips ? `<div class="np-chips">${chips}</div>` : ''}
      <div class="np-body" id="np-video-summary">${has ? esc(cached.summary) : '<span class="muted">AIで要約を生成しています…（動画が長いと1分ほどかかります）</span>'}</div>
      <p class="np-note muted"><span id="np-video-model">${has && cached.model ? esc(ytModelNote(cached.model, cached.tokens, false)) : ''}</span></p>
      <p class="np-note muted">※ AIによる自動要約です。誤り（銘柄名・数値の取り違え等）が含まれる場合があります。長い動画は前半を要約する場合があります。正確な内容は動画をご確認ください。</p>
      <div class="form-actions" style="margin-top:14px">
        <button type="button" class="btn btn-primary" onclick="window.open('${esc(it.link)}','_blank')">▶ 動画を開く</button>
        ${has ? `<button type="button" class="btn" id="np-video-regen" onclick="regenVideoSummary('${esc(it.videoId)}')">要約し直す</button>` : ''}
        <button type="button" class="btn" onclick="closeModal()">閉じる</button>
      </div>
    </div>`;
  showModal('動画', body);
  if (!has) generateVideoSummary(it.videoId, true);
}
async function generateVideoSummary(videoId, showInPanel) {
  // 固定選択でも上限時は他モデルへ降格させる（選択モデルを先頭にした降格チェーンを送る）
  const models = ytModelChainForRequest();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 130000); // 降格で複数モデル試すため長め
    let d;
    try { const r = await fetch('/api/youtube-summary?v=' + encodeURIComponent(videoId) + '&models=' + encodeURIComponent(models.join(',')), { signal: ctrl.signal }); d = await r.json(); }
    finally { clearTimeout(timer); }
    if (d && d.summary) {
      const tokens = (d.usage && d.usage.totalTokenCount) || null;
      store.data.ytSummaries[videoId] = { headline: d.headline || '', summary: d.summary, at: new Date().toISOString(), model: d.model, tokens };
      store.save();
      // 一覧の該当動画1行だけ即更新（クリック生成・裏生成どちらも）。画面全体・他行には触れない
      const it = _newsCache && _newsCache.items.find(x => x.videoId === videoId);
      if (it) { it.desc = d.summary; it.lang = undefined; if (currentView === 'news') _patchVideoItemDom(it); } // 要約後は日本語＝翻訳対象から外す（プール項目の変更は直後のsaveで永続化）
      if (showInPanel) {
        const el = document.getElementById('np-video-summary'); if (el) el.textContent = d.summary;
        const ht = document.getElementById('np-video-headline'); if (ht && d.headline) ht.textContent = d.headline;
        const mn = document.getElementById('np-video-model'); if (mn) mn.textContent = ytModelNote(d.model, tokens, d.fellBack);
      }
      return d.summary;
    }
    if (showInPanel) { const el = document.getElementById('np-video-summary'); if (el) el.innerHTML = `<span class="muted">${esc((d && d.error) || '要約を生成できませんでした')}<br>動画をご確認ください。</span>`; }
    return '';
  } catch (e) {
    if (showInPanel) { const el = document.getElementById('np-video-summary'); if (el) el.innerHTML = '<span class="muted">要約の生成に失敗しました（通信エラーまたはタイムアウト）。</span>'; }
    return '';
  }
}
// 新着動画の要約を裏で先に生成（一覧を開いた時）。開いた時に要約が出来ている状態にする＝待ち時間の解消。
// 消費を抑えるため新しい順に最大3件・順次。生成済み/試行済みはスキップ。
let _ytAutoBusy = false;
const _ytTried = new Set();
async function newsAutoSummarizeVideos() {
  if (_ytAutoBusy || !_newsCache) return;
  const sums = store.data.ytSummaries || {};
  // マスタ設定ON=全チャンネル対象 / OFFでも「全動画を自動要約」指定のチャンネルは対象（ytAutoForItem）
  const pend = _newsCache.items.filter(it => it.cat === 'video' && it.videoId && ytAutoForItem(it) && !(sums[it.videoId] && sums[it.videoId].summary) && !_ytTried.has(it.videoId)).slice(0, 2);
  if (!pend.length) return;
  _ytAutoBusy = true;
  try {
    // 順次生成（generateVideoSummary が完了時に該当行だけ差し替える。全体再描画はしない）。
    // TPM(1分あたりトークン)を分散させるため各生成の間に少し待つ。
    for (const it of pend) {
      _ytTried.add(it.videoId);
      await generateVideoSummary(it.videoId, false);
      await new Promise(r => setTimeout(r, 3000));
    }
  } finally { _ytAutoBusy = false; }
}
// 一覧内の該当動画1件だけを差し替え（見出し＝AI見出し／2行目＝動画タイトル）。全体再描画しない＝フィルタ・スクロールを維持。
function _patchVideoItemDom(it) {
  let el = null;
  try { el = document.querySelector(`#app .news-item[data-link="${CSS.escape(it.link)}"]`); } catch (_) {}
  if (!el) return;
  const c = store.data.ytSummaries[it.videoId] || {};
  if (!c.headline) return;
  const titleEl = el.querySelector('.news-title');
  if (titleEl) titleEl.textContent = '▶ ' + c.headline;
  let sub = el.querySelector('.news-preview');
  if (!sub) { sub = document.createElement('span'); sub.className = 'news-preview'; if (titleEl) titleEl.after(sub); }
  sub.classList.remove('muted'); sub.textContent = it.title;
}
function regenVideoSummary(videoId) {
  const el = document.getElementById('np-video-summary'); if (el) el.innerHTML = '<span class="muted">AIで要約を生成しています…</span>';
  const rb = document.getElementById('np-video-regen'); if (rb) rb.remove();
  delete store.data.ytSummaries[videoId]; store.save();
  generateVideoSummary(videoId, true);
}

// ===== 銘柄マッチング（フェーズN2） =====
// 見出しに登録銘柄（JP/US）の名前・コード・ティッカーが含まれるかを判定する。
// 照合パターンは銘柄ごとに生成してキャッシュ（storeに保存しないよう Map。銘柄編集/名称取得で作り直し）
const _newsPatCache = new Map();
function _newsEscReg(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// 日本株の見出し通称（正式名では見出しに出ない銘柄。ticker→通称。|区切りで複数可）。
// 自動生成（トヨタ自動車→トヨタ 等）で拾えるものは載せず、正式名と通称が乖離するものだけ。
const NEWS_JP_ALIAS = {
  '9432': 'NTT', '9433': 'KDDI|au', '9434': 'ソフトバンク', '9984': 'ソフトバンクグループ|ソフトバンクG|SBG',
  '9020': 'JR東日本', '9021': 'JR西日本', '9022': 'JR東海', '9147': '日本通運|日通',
  '8306': '三菱UFJ|MUFG', '8316': '三井住友|SMBC|三井住友FG', '8411': 'みずほ', '8309': '三井住友トラスト',
  '7267': 'ホンダ|本田技研', '7201': '日産', '7269': 'スズキ', '7270': 'SUBARU|スバル', '7211': '三菱自',
  '6501': '日立', '6502': '東芝', '6752': 'パナソニック', '6503': '三菱電機', '6702': '富士通',
  '4502': '武田|タケダ', '4503': 'アステラス', '4568': '第一三共', '4519': '中外製薬',
  '9983': 'ファーストリテイリング|ファストリ|ユニクロ', '6098': 'リクルート', '4661': 'オリエンタルランド|OLC',
  '8058': '三菱商事', '8031': '三井物産', '8053': '住友商事', '2914': 'JT|日本たばこ',
  '6902': 'デンソー', '6981': '村田製作所|ムラタ', '6857': 'アドバンテスト', '8035': '東京エレクトロン|東エレク',
  '6954': 'ファナック', '6367': 'ダイキン', '7974': '任天堂', '9613': 'NTTデータ',
  '9501': '東京電力|東電', '9503': '関西電力|関電', '9531': '東京ガス', '5401': '日本製鉄|日鉄',
  '8801': '三井不動産', '8802': '三菱地所', '2802': '味の素', '2503': 'キリン', '2502': 'アサヒ',
  '4063': '信越化学', '4901': '富士フイルム', '7751': 'キヤノン', '7741': 'HOYA',
  '6861': 'キーエンス', '4755': '楽天', '4385': 'メルカリ', '4751': 'サイバーエージェント',
  '8766': '東京海上', '8750': '第一生命', '6178': '日本郵政', '9201': '日本航空|JAL', '9202': '全日空',
  '3382': 'セブン&アイ', '8267': 'イオン', '9843': 'ニトリ', '4911': '資生堂', '4452': '花王',
  '7011': '三菱重工|三菱重', '7012': '川崎重工', '6920': 'レーザーテック', '6146': 'ディスコ',
  '9766': 'コナミ', '7832': 'バンダイナムコ|バンナム', '4324': '電通', '1605': 'INPEX', '5108': 'ブリヂストン',
};
// 米国主要銘柄の日本語表記（見出しは「米アップル」等のカタカナ表記のため。|区切りで複数可）
const NEWS_US_ALIAS = {
  AAPL: 'アップル', MSFT: 'マイクロソフト', GOOGL: 'グーグル|アルファベット', GOOG: 'グーグル|アルファベット',
  AMZN: 'アマゾン', META: 'メタ・プラットフォームズ|旧フェイスブック', NVDA: 'エヌビディア', TSLA: 'テスラ',
  NFLX: 'ネットフリックス', INTC: 'インテル', QCOM: 'クアルコム', AVGO: 'ブロードコム', TSM: 'TSMC|台湾積体電路',
  BA: 'ボーイング', DIS: 'ディズニー', KO: 'コカ・コーラ|コカコーラ', PEP: 'ペプシコ', MCD: 'マクドナルド',
  SBUX: 'スターバックス', NKE: 'ナイキ', WMT: 'ウォルマート', COST: 'コストコ',
  JNJ: 'ジョンソン・エンド・ジョンソン', PFE: 'ファイザー', MRK: 'メルク', LLY: 'イーライリリー',
  UNH: 'ユナイテッドヘルス', V: 'ビザ', MA: 'マスターカード', AXP: 'アメックス|アメリカン・エキスプレス',
  JPM: 'JPモルガン', GS: 'ゴールドマン・サックス', MS: 'モルガン・スタンレー', BAC: 'バンク・オブ・アメリカ',
  C: 'シティグループ', XOM: 'エクソンモービル', CVX: 'シェブロン', CAT: 'キャタピラー', MMM: 'スリーエム',
  ORCL: 'オラクル', CRM: 'セールスフォース', ADBE: 'アドビ', PYPL: 'ペイパル', UBER: 'ウーバー', PG: 'P&G',
};
// 主要上場銘柄の自動タグ用リスト（保有外でも見出し/本文に出たら別色チップ）。
// 辞書は上の NEWS_JP_ALIAS / NEWS_US_ALIAS を再利用（コード付き＝クリックで株探へ）。将来は全上場マスタ取込で拡張予定。
// 誤検知抑制: 照合語は「3文字以上」または「2文字以上かつ非ASCII（日立・東芝等の漢字2字）」のみ採用（JT/au等の短いASCIIは除外）。
// カタカナを保持したままの正規化（NFKC＋小文字化のみ）。カタカナ社名の「語境界」判定に使う。
// ※ searchNorm はカタカナ→ひらがなに寄せるため、直後が「カタカナの続き」か「ひらがなの助詞」かを区別できない。
function searchNormK(s) { let t = String(s == null ? '' : s); try { t = t.normalize('NFKC'); } catch (_) {} return t.toLowerCase(); }
const _KATA_RE = /[ァ-ヶー]/;
const _isKataWord = (s) => /^[ァ-ヶー]{2,}$/.test(s);
// カタカナ社名が「より長いカタカナ語の一部」でない位置に出現するか。
// 例: 「スーパー」は『スーパーマーケット』(直後がカタカナ)では不一致、『スーパー、値上げ』『スーパーは』では一致。
function _kataHit(textK, alias) {
  let i = textK.indexOf(alias);
  while (i >= 0) {
    const before = i > 0 ? textK[i - 1] : '';
    const after = textK[i + alias.length] || '';
    if (!_KATA_RE.test(before) && !_KATA_RE.test(after)) return true;
    i = textK.indexOf(alias, i + 1);
  }
  return false;
}
// 銘柄名から照合候補（会社種別除去＋略称）を生成
function _masterCands(name) {
  const base = String(name || '').replace(/株式会社|\(株\)|（株）/g, '').replace(/\s+/g, '').trim();
  if (!base) return [];
  const cands = [base, base.replace(/ホールディングス/g, 'HD'), base.replace(/(ホールディングス|HD)$/, ''), base.replace(/グループ$/, ''), base.replace(/グループ$/, 'G')];
  // カタカナ略称は「カタカナ＋漢字/ひらがな」の形のときだけ作る（例: トヨタ自動車→トヨタ）。
  // 全カタカナ名（スーパー・マイクロ・コンピューター等）から先頭を切り出すと「スーパーマーケット」に
  // 誤ヒットするため作らない（区切り「・」やカタカナが続く場合は不採用）。
  const kat = base.match(/^([ァ-ヶー]{3,})(?=[^ァ-ヶー・])/);
  if (kat) cands.push(kat[1]);
  return [...new Set(cands.filter(Boolean))];
}
// 候補を「カタカナ語（語境界つき照合）」と「それ以外（部分一致）」に振り分ける。
// lenient=true は組込み辞書（手作業で精査済み。漢字2字の日立・東芝等を許可）、false は取込マスタ/ランキング（3文字以上）。
function _splitNorms(cands, lenient) {
  const norms = [], kn = [];
  const okPlain = (x) => lenient ? (x.length >= 3 || (x.length >= 2 && /[^\x00-\x7f]/.test(x))) : x.length >= 3;
  for (const c of cands) {
    if (_isKataWord(c)) { const k = searchNormK(c); if (k.length >= 3) kn.push(k); }
    else { const n = searchNorm(c); if (okPlain(n)) norms.push(n); }
  }
  return { norms: [...new Set(norms)], kn: [...new Set(kn)] };
}
// 自動タグ対象リスト（組込み主要辞書＋取込マスタ＋ランキングタブ銘柄）。構成変更時のみ再構築してキャッシュ。
let _majorsListCache = null, _majorsListVer = '';
const _majorsMemo = new Map();   // 見出しテキスト→一致エントリ（保有除外済み）。大量マスタ対策の見出し単位キャッシュ
let _majorsMemoVer = '';
// マーケット（時価総額/売買代金/値上がり/値下がり）ランキングのキャッシュから {market,code,name} を集める。
// key = `${market}:${sub}:${kind}`。時価総額・売買代金上位の保有外銘柄もニュースで自動タグしたいため。
function _rankingEntries() {
  const cache = store.data.mktRanking || {};
  const out = [];
  for (const key of Object.keys(cache)) {
    const market = String(key).split(':')[0] === 'US' ? 'US' : 'JP';
    const items = (cache[key] && cache[key].items) || [];
    for (const it of items) {
      const code = String(it.code || '').trim(), name = String(it.name || '').trim();
      if (code && name) out.push({ market, code, name });
    }
  }
  return out;
}
function _rankingSig() {
  const cache = store.data.mktRanking || {};
  const keys = Object.keys(cache); let n = 0;
  for (const k of keys) n += ((cache[k] && cache[k].items) || []).length;
  return keys.length + 'x' + n;
}
function newsMajorsList() {
  const master = listedMasterArr();
  const ver = master.length + '|' + _rankingSig();
  if (_majorsListCache && _majorsListVer === ver) return _majorsListCache;
  const buildAlias = (dict, market) => Object.entries(dict).map(([code, s]) => {
    const names = s.split('|').filter(Boolean);
    const { norms, kn } = _splitNorms(names, true);
    return { market, code, label: names[0], norms, kn, code4: (market === 'JP' && /^\d{4}$/.test(code)) ? code : null };
  }).filter(e => e.norms.length || e.kn.length);
  const list = [...buildAlias(NEWS_JP_ALIAS, 'JP'), ...buildAlias(NEWS_US_ALIAS, 'US')];
  const seen = new Set(list.map(e => e.market + e.code));
  // 取込マスタ（JPX全上場） … JPコード4桁/4英数字
  for (const m of master) {
    const code = String(m.code || '').trim(), name = String(m.name || '').trim();
    if (!/^[0-9A-Za-z]{4}$/.test(code) || !name || seen.has('JP' + code)) continue; // 組込みと重複はスキップ
    const { norms, kn } = _splitNorms(_masterCands(name), false);
    if (!norms.length && !kn.length) continue;
    list.push({ market: 'JP', code, label: name, norms, kn, code4: /^\d{4}$/.test(code) ? code : null });
    seen.add('JP' + code);
  }
  // ランキングタブ銘柄（JP=4桁コード / US=ティッカー。名称は日本語化済み）
  for (const e of _rankingEntries()) {
    if (seen.has(e.market + e.code)) continue; // 組込み辞書・マスタと重複はスキップ
    const { norms, kn } = _splitNorms(_masterCands(e.name), false);
    const code4 = (e.market === 'JP' && /^\d{4}$/.test(e.code)) ? e.code : null;
    if (!norms.length && !kn.length && !code4) continue; // 照合できる手掛かりが無いものは除外
    list.push({ market: e.market, code: e.code, label: e.name, norms, kn, code4 });
    seen.add(e.market + e.code);
  }
  _majorsListCache = list; _majorsListVer = ver; _majorsMemo.clear();
  return list;
}
// 記事に出現する自動タグ銘柄（保有外）。見出し単位でキャッシュ（保有除外まで）。
function newsMatchMajorsRaw(it) {
  const list = newsMajorsList();
  const ver = _majorsListVer + '|' + (store.data.securities || []).length;
  if (_majorsMemoVer !== ver) { _majorsMemo.clear(); _majorsMemoVer = ver; }
  const text = newsText(it);
  const key = text.slice(0, 300);
  if (_majorsMemo.has(key)) return _majorsMemo.get(key);
  const norm = searchNorm(text);
  const textK = searchNormK(text); // カタカナ保持版（カタカナ社名の語境界判定用）
  const held = new Set((store.data.securities || []).filter(s => s.enabled !== false).map(s => s.market + ':' + String(s.ticker || '').toUpperCase()));
  const codeSet = new Set((text.match(/(?<![0-9])[0-9]{4}(?![0-9円万億兆株])/g) || []));
  const out = [], seen = new Set();
  for (const e of list) {
    if (held.has(e.market + ':' + e.code.toUpperCase())) continue;   // 保有は青チップで出す
    // 漢字等=部分一致 / カタカナ社名=語境界つき一致 / 日本株は本文中の4桁コード
    if (!(e.norms.some(n => norm.includes(n)) || e.kn.some(k => _kataHit(textK, k)) || (e.code4 && codeSet.has(e.code4)))) continue;
    const k = e.market + e.code; if (seen.has(k)) continue; seen.add(k);
    out.push(e);
  }
  _majorsMemo.set(key, out);
  return out;
}
// excludeNorms=既に別チップで表示済みの正規化名の集合（重複表示を避ける）
function newsMatchMajors(it, excludeNorms) {
  return newsMatchMajorsRaw(it)
    .filter(e => !(excludeNorms && (e.norms.some(n => excludeNorms.has(n)) || e.kn.some(k => excludeNorms.has(searchNorm(k))))))
    .map(e => ({ market: e.market, code: e.code, label: e.label }));
}
function _newsPat(sec) {
  const metaName = (store.data.meta[priceKey(sec)] || {}).name || '';
  const k = sec.id + '|' + (sec.nameOverride || '') + '|' + (sec.name || '') + '|' + metaName;
  let p = _newsPatCache.get(k);
  if (p) return p;
  p = { jp: [], en: [], code: null };
  for (let n of [sec.nameOverride, sec.name, metaName]) {
    n = String(n || '').trim();
    if (!n) continue;
    if (/[ぁ-んァ-ヶ一-龠]/.test(n)) {
      // 日本語名: 会社種別・空白を除去し、見出しで使われる略記のエイリアスを生成
      //   トヨタ自動車→トヨタ（先頭カタカナ語）/ ソニーグループ→ソニー・ソニーG / 〜ホールディングス→〜HD・〜
      const base = n.replace(/株式会社|\(株\)|（株）/g, '').replace(/\s+/g, '');
      const cands = [base,
        base.replace(/ホールディングス/g, 'HD'),
        base.replace(/(ホールディングス|HD)$/, ''),
        base.replace(/グループ$/, ''),
        base.replace(/グループ$/, 'G')];
      const kat = base.match(/^[ァ-ヶー]{3,}/); // 先頭カタカナ語（3文字以上・後ろに漢字等が続く場合のみ）
      if (kat && kat[0].length < base.length) cands.push(kat[0]);
      for (const x of cands) if (x.length >= 2 && !p.jp.includes(x)) p.jp.push(x);
    } else {
      // 英語名: Inc/Corp等の法人格・Class A等を除去して単語境界マッチ
      const s = n.replace(/,?\s+(Inc|Corp|Corporation|Co|Ltd|PLC|Holdings|Group|Company|Class [A-C]|ADR)\.?(?=\s|$)/gi, '').replace(/[.,]+$/, '').trim();
      if (s.length >= 3) p.en.push(new RegExp(`\\b${_newsEscReg(s)}\\b`, 'i'));
    }
  }
  const t = String(sec.ticker || '').toUpperCase();
  // 通称辞書（見出し頻出の略称）を追加
  if (sec.market === 'JP' && NEWS_JP_ALIAS[t]) for (const a of NEWS_JP_ALIAS[t].split('|')) if (a && !p.jp.includes(a)) p.jp.push(a);
  if (sec.market === 'US' && NEWS_US_ALIAS[t]) for (const a of NEWS_US_ALIAS[t].split('|')) if (a && !p.jp.includes(a)) p.jp.push(a);
  // 正規化版（半角全角・カナ/かな差を吸収した比較用）。日本語名は searchNorm 済みで含有判定する
  p.jpNorm = p.jp.map(searchNorm).filter(x => x.length >= 2);
  if (sec.market === 'JP' && /^\d{4}$/.test(t)) p.code = new RegExp(`(^|[^0-9])${t}($|[^0-9円万億兆])`); // 4桁コード（金額の一部は除外）
  else if (sec.market === 'US' && /^[A-Z]{3,5}$/.test(t)) p.code = new RegExp(`\\b${t}\\b`); // 1〜2文字ティッカー(A/IT等)は誤検知するので対象外
  _newsPatCache.set(k, p);
  return p;
}
// ===== 翻訳（英語ニュースの日本語化。無料エンドポイント経由・1記事1回だけ翻訳して同期キャッシュ） =====
let _newsTransBusy = false;
function _newsPruneTrans() { // 30日より古い翻訳キャッシュを掃除
  const lim = Date.now() - 30 * 86400 * 1000;
  for (const k in store.data.newsTrans) { const d = new Date((store.data.newsTrans[k] || {}).at); if (isNaN(d) || d.getTime() < lim) delete store.data.newsTrans[k]; }
}
// 複数テキストを1リクエストで翻訳（バッチ＝レート制限に強い）。入力順の配列で返す
async function _newsTranslateBatch(texts) {
  if (!texts.length) return [];
  try {
    // POST（JSON）で送る。旧GETは見出し＋要約×15件でURLがCFの上限(16KB)を超え、
    // リクエスト自体が失敗して「大きいバッチほど全滅」になっていた。切り詰めはサーバーと同じ1500字。
    const r = await fetch('/api/translate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sl: 'en', tl: 'ja', texts: texts.map(t => String(t || '').slice(0, 1500)) }),
    });
    const d = await r.json();
    return Array.isArray(d.translated) ? d.translated : [];
  } catch (_) { return []; }
}
// 直近に翻訳を試みたリンク（失敗分の無限リトライ防止・非永続）。5分あけて再試行する
const _newsTransTried = new Map();
// 未翻訳の英語記事の「見出し＋本文」を1リクエストでまとめて翻訳→キャッシュ→再描画。
// 見出しと要約を同じバッチに入れる。失敗して未翻訳のままの記事も、時間をあけて再試行する（取得済み＝翻訳済みではない）。
async function newsTranslatePending() {
  if (_newsTransBusy) return;
  const now = Date.now();
  const pend = (_newsCache ? _newsCache.items : []).filter(it => {
    if (it.lang !== 'en') return false;
    const tr = store.data.newsTrans[it.link];
    const needTitle = !(tr && tr.t);
    const needDesc = it.desc && !(tr && tr.d);
    if (!needTitle && !needDesc) return false;                       // 完全に翻訳済み
    const tried = _newsTransTried.get(it.link);
    if (tried && now - tried < 5 * 60 * 1000) return false;          // 直近5分に試行済みなら待つ
    return true;
  }).slice(0, 15);
  if (!pend.length) return;
  pend.forEach(it => _newsTransTried.set(it.link, now));             // 試行時刻を記録（失敗しても記録）
  _newsTransBusy = true;
  try {
    // [t0,d0,t1,d1,...] の順で1リクエスト（descが無い記事は空文字送らずスキップ管理）
    const reqs = []; const idx = [];
    pend.forEach((it, i) => { reqs.push(it.title); idx.push([i, 't']); if (it.desc) { reqs.push(it.desc); idx.push([i, 'd']); } });
    const tr = await _newsTranslateBatch(reqs);
    let any = false;
    const acc = {};
    idx.forEach(([i, k], j) => { if (tr[j]) { (acc[i] = acc[i] || {})[k] = tr[j]; } });
    pend.forEach((it, i) => {
      const a = acc[i]; if (!a || !a.t) return;
      const cur = store.data.newsTrans[it.link] || {};
      store.data.newsTrans[it.link] = { t: a.t, d: a.d || cur.d || '', at: new Date().toISOString() };
      any = true;
    });
    if (any) { _newsPruneTrans(); store.save(); if (currentView === 'news') renderNews(); }
  } finally { _newsTransBusy = false; }
}
// パネル用: 万一 desc が未翻訳なら単発で翻訳（フォールバック。通常は上のバッチで済む）
async function newsTranslateDesc(link) {
  const it = newsFindItem(link);
  if (!it || it.lang !== 'en' || !it.desc) return;
  const cur = store.data.newsTrans[link] || {};
  if (cur.d) return;
  const [d] = await _newsTranslateBatch([it.desc]);
  if (d) { store.data.newsTrans[link] = { t: cur.t || '', d, at: new Date().toISOString() }; store.save(); }
}
// 表示用の見出し/要約（英語記事は翻訳があれば日本語、なければ原文）
function newsDispTitle(it) { const tr = store.data.newsTrans[it.link]; return (it.lang === 'en' && tr && tr.t) ? tr.t : it.title; }
function newsDispDesc(it) { const tr = store.data.newsTrans[it.link]; return (it.lang === 'en' && tr && tr.d) ? tr.d : (it.desc || ''); }

// マウス左ドラッグでニュース一覧をスクロール（スクロールバーが掴みにくい/中ボタンautoscrollがリンクに奪われる対策）。
// 4pxを超えて動いた時だけスクロール扱いにし、その直後のクリック（リンク遷移）は抑止する。ページ全体に一度だけ設定。
let _newsDragScrollInit = false;
function initNewsDragScroll() {
  if (_newsDragScrollInit) return; _newsDragScrollInit = true;
  const SEL = '.news-wrap, .sec-news-scroll';
  let ds = null;
  document.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const w = e.target.closest(SEL); if (!w) return;
    ds = { w, y: e.pageY, top: w.scrollTop, moved: false };
  });
  document.addEventListener('mousemove', e => {
    if (!ds) return;
    const dy = e.pageY - ds.y;
    if (!ds.moved && Math.abs(dy) > 4) { ds.moved = true; ds.w.classList.add('drag-scrolling'); }
    if (ds.moved) { ds.w.scrollTop = ds.top - dy; e.preventDefault(); }
  });
  document.addEventListener('mouseup', () => {
    if (!ds) return;
    const w = ds.w, moved = ds.moved; ds = null;
    if (!moved) return;
    w.classList.remove('drag-scrolling');
    const sup = ev => { ev.preventDefault(); ev.stopPropagation(); w.removeEventListener('click', sup, true); };
    w.addEventListener('click', sup, true);            // ドラッグ直後のクリック（リンク遷移）を1回だけ抑止
    setTimeout(() => w.removeEventListener('click', sup, true), 60);
  });
}

// 記事の判定対象テキスト＝見出し＋本文(要約)。本文が取れるフィード（NHK/東洋経済/ダイヤ/ブルームバーグ等）
// では本文中の言及も拾える。日経マーケット/Yahoo等は本文なしなので見出しのみ。
function newsText(it) { return typeof it === 'string' ? it : ((it && it.title) || '') + ' ' + ((it && it.desc) || ''); }
function newsSecHit(itOrTitle, sec) {
  const raw = newsText(itOrTitle);
  const norm = searchNorm(raw); // 半角全角・カナ差を吸収（NTT/ＮＴＴ・9432/９４３２ 等）
  const p = _newsPat(sec);
  if (p.jpNorm.some(n => norm.includes(n))) return true;       // 日本語名・通称（正規化して含有）
  if (p.en.some(re => re.test(raw))) return true;               // 英語名（単語境界。小文字化は正規表現側で吸収）
  if (p.code && p.code.test(norm)) return true;                 // 証券コード/ティッカー（正規化後の半角数字で照合）
  return false;
}
function newsMatchSecs(it) {
  // 開示アイテムは it.code（証券コード）で確実に紐付け。通常記事は見出し＋本文マッチ
  const code = (it && typeof it === 'object' && it.code) ? String(it.code).toUpperCase() : null;
  return store.data.securities.filter(s => {
    if (s.enabled === false || (s.market !== 'JP' && s.market !== 'US')) return false;
    if (code && String(s.ticker || '').toUpperCase() === code) return true;
    return code ? false : newsSecHit(it, s); // 開示アイテムはコード一致のみ（本文マッチは使わない）
  });
}
// 注目タグ（保有登録なしの企業/人物/テーマ名）の見出し＋本文一致。名前を searchNorm して含有判定
function newsMatchTags(it) {
  const tags = store.data.newsTags || [];
  if (!tags.length) return [];
  const norm = searchNorm(newsText(it));
  return tags.filter(t => { const n = searchNorm(t.name || ''); return n.length >= 2 && norm.includes(n); });
}
function setNewsHeldOnly(v) { newsHeldOnly = v; renderNews(); }
// ===== 非表示（除外）: 既読とは別。一覧から消し、非表示一覧から復元できる =====
function _newsPruneHidden() { // 45日より古い非表示は掃除（同期データ肥大防止）
  const lim = Date.now() - 45 * 86400 * 1000;
  for (const k in store.data.newsHidden) { const d = new Date(store.data.newsHidden[k]); if (isNaN(d) || d.getTime() < lim) delete store.data.newsHidden[k]; }
}
// ヘッダの件数（未読／非表示）だけを更新（行のDOM削除に伴う軽量更新。全体再描画しないのでスクロール維持）
function _newsUpdateHeaderCounts() {
  const hidden = store.data.newsHidden || {}, read = store.data.newsRead || {};
  const hiddenN = Object.keys(hidden).length;
  const hb = document.getElementById('news-hidden-btn'); if (hb) hb.textContent = '非表示' + (hiddenN ? ` ${hiddenN}` : '');
  const unreadN = _newsCache ? _newsCache.items.filter(it => !read[it.link] && !hidden[it.link]).length : 0;
  const ub = document.getElementById('news-unread-badge'); if (ub) ub.textContent = unreadN ? `未読 ${unreadN}` : '';
}
function newsHideBtn(ev, el) { // 行の✕（非表示化）。再描画せず該当行だけDOMから消す＝スクロール位置を完全維持
  ev.preventDefault(); ev.stopPropagation();
  const link = el.dataset.link; if (!link) return;
  store.data.newsHidden[link] = new Date().toISOString();
  _newsPruneHidden(); store.save();
  const row = el.closest('.news-item'); if (row) row.remove();
  _newsUpdateHeaderCounts();
}
function newsUnhideBtn(ev, el) { // 非表示一覧の「戻す」
  ev.preventDefault(); ev.stopPropagation();
  const link = el.dataset.link; if (!link) return;
  delete store.data.newsHidden[link]; store.save(); renderNews();
}
function newsUnhideAll() {
  if (!confirm('非表示をすべて解除して一覧に戻します。よろしいですか？')) return;
  store.data.newsHidden = {}; store.save(); newsShowHidden = false; renderNews();
}
function toggleNewsHiddenView() { newsShowHidden = !newsShowHidden; renderNews(); }
// 現在の絞り込み（カテゴリ／関連のみ／非表示除外）を適用した表示対象 [item, matchedSecs] の配列
function _newsCurrentEntries() {
  const hidden = store.data.newsHidden || {};
  const since = newsDays ? Date.now() - newsDays * 86400 * 1000 : 0;
  const prefs = store.data.newsPrefs || {};
  const hideCats = newsHideCats(), hideDiscTypes = prefs.hideDiscTypes || []; // カテゴリは同期で画面が動かないようセッション優先
  let entries = (_newsCache ? _newsCache.items : [])
    .filter(it => !hidden[it.link])
    .filter(it => !since || (it.pubDate && new Date(it.pubDate).getTime() >= since))
    // 表示カテゴリ（インラインのトグルで選択・非選択カテゴリは隠す）
    .filter(it => !hideCats.includes(newsCategory(it)))
    // 非表示にした開示グループ（決算/自己株 等）はどのカテゴリでも隠す
    .filter(it => !(isDiscItem(it) && hideDiscTypes.includes(disclosureGroup(it))))
    .map(it => [it, newsMatchSecs(it)]);
  // 銘柄フィルタ（保有銘柄と同じ機構）: 銘柄に紐づく記事のうち、条件に合う銘柄のものだけ残す。
  // 一般ニュース（銘柄一致なし）はここでは落とさない＝一般記事の除外は「保有・注目のみ」トグルの役割（両者はAND）。
  if (fltActiveCount('news')) {
    const base = store.data.securities.filter(s => s.market === 'JP' || s.market === 'US');
    const allow = new Set(applyColFilters(base, 'news').map(s => s.id));
    entries = entries.filter(([, ms]) => ms.length === 0 || ms.some(s => allow.has(s.id)));
  }
  if (newsMkt !== 'all') entries = entries.filter(([it, ms]) => { const mk = newsItemMarkets(it, ms); return mk.size === 0 || mk.has(newsMkt); });
  // 「保有・注目のみ」: 保有銘柄・注目タグに関連しない記事（一般ニュース）を除外
  if (newsHeldOnly) entries = entries.filter(([it, ms]) => ms.length || newsMatchTags(it).length);
  return entries;
}
// 注目タグ管理モーダル（1行1名。改行区切りで一括編集）
function openNewsTagsEditor() {
  const cur = (store.data.newsTags || []).map(t => t.name).join('\n');
  showModal('注目タグ（保有していない企業・人物・テーマ）', `
    <p class="muted" style="margin:0 0 8px;font-size:12px">1行に1つ。ここに書いた名前がニュース見出しに含まれると、保有銘柄とは別色のタグが付きます（クリックしても銘柄画面は開きません）。例: エヌビディア / テスタ / 半導体 / 生成AI</p>
    <textarea id="news-tags-ta" rows="10" style="width:100%;font-size:13px" placeholder="エヌビディア&#10;半導体&#10;生成AI">${esc(cur)}</textarea>
    <div class="form-actions" style="margin-top:12px">
      <button type="button" class="btn btn-primary" onclick="saveNewsTags()">保存</button>
      <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
    </div>`);
}
function saveNewsTags() {
  const ta = document.getElementById('news-tags-ta');
  if (!ta) return;
  const names = ta.value.split('\n').map(s => s.trim()).filter(s => s.length >= 2);
  const uniq = [...new Set(names)];
  const prev = store.data.newsTags || [];
  // 既存の名前はidを維持（同期の一致キー安定のため）、新規はid採番
  store.data.newsTags = uniq.map(name => {
    const ex = prev.find(t => t.name === name);
    return ex || { id: store.nextId(), name };
  });
  store.save();
  closeModal();
  renderNews();
}
// 相対時刻表示（60分未満=分前 / 24時間未満=時間前 / それ以前=月/日）
function newsTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const diff = Date.now() - d.getTime();
  if (diff < 3600 * 1000) return Math.max(1, Math.floor(diff / 60000)) + '分前';
  if (diff < 24 * 3600 * 1000) return Math.floor(diff / 3600000) + '時間前';
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
// 記事1行のHTML。opts.mini=銘柄詳細ドロワー用（カテゴリ・銘柄チップなし）
function newsItemHtml(it, read, matches, opts = {}) {
  const unread = !read[it.link];
  const cat = newsCategory(it);
  // 開示アイテムは細分類ラベル（決算/自己株取得 等）、通常記事はカテゴリ名
  const catLbl = isDiscItem(it) ? disclosureTypeLabel(disclosureType(it)) : ((NEWS_CATS.find(c => c[0] === cat) || [])[1] || '');
  // 一致した登録銘柄のチップ（最大3件）。クリックで銘柄詳細（リンク遷移はさせない）
  const matchSecs = matches || [];
  const secChips = matchSecs.slice(0, 3).map(s =>
    `<span class="news-sec" onclick="event.preventDefault();event.stopPropagation();openSecurityDetail(${s.id})" title="${esc(calc.displayName(s))}">${esc(nameAbbr(calc.displayName(s)))}</span>`).join('');
  let tagChips = '', majorChips = '';
  if (!opts.mini) {
    const tags = newsMatchTags(it);
    tagChips = tags.slice(0, 3).map(t => `<span class="news-tag">${esc(t.name)}</span>`).join('');
    // 既に登録銘柄／注目タグで出した名前は主要銘柄チップから除外
    const exclude = new Set();
    for (const s of matchSecs) exclude.add(searchNorm(calc.displayName(s)));
    for (const t of tags) exclude.add(searchNorm(t.name));
    // 自動タグ（保有外の主要上場銘柄）。クリックで株探（新規タブ）
    majorChips = newsMatchMajors(it, exclude).slice(0, 3).map(mj =>
      `<span class="news-listed" onclick="event.preventDefault();event.stopPropagation();window.open('${mktKabutan(mj.code, mj.market)}','_blank')" title="${esc(mj.label)}（未登録の上場銘柄・クリックで株探）">${esc(mj.label)}</span>`).join('');
  }
  const catChip = opts.mini ? '' : `<span class="news-cat cat-${cat}">${catLbl}</span>`;
  // 行の右上ボタン: 通常=✕（非表示）／非表示一覧=戻す。ドロワー(mini)では出さない
  const hideBtn = opts.mini ? ''
    : opts.restore ? `<button class="news-restore" data-link="${esc(it.link)}" onclick="newsUnhideBtn(event,this)" title="一覧に戻す">戻す</button>`
    : `<button class="news-hide" data-link="${esc(it.link)}" onclick="newsHideBtn(event,this)" title="この記事を非表示にする">✕</button>`;
  // 英語記事は翻訳（あれば）を表示し、翻訳済みなら「訳」バッジ。動画は▶マーク。クリックで要約パネル（元記事へは行かない）
  const dispTitle = (it.cat === 'video' ? '▶ ' : '') + newsDispTitle(it);
  const trBadge = it.lang === 'en' ? `<span class="news-trans-badge">${store.data.newsTrans[it.link] && store.data.newsTrans[it.link].t ? '訳' : 'EN'}</span>` : '';
  // 動画は「見出し＝AI生成のニュース見出し（内容の要約）」を1行目、動画タイトルを2行目に（Yahooニュース風）。
  // 見出しが未生成なら動画タイトルを見出しに使い、2行目は出さない（準備中表示）。
  let titleLine = `${trBadge}${esc(dispTitle)}`, subLine = '';
  if (it.cat === 'video') {
    const cached = store.data.ytSummaries[it.videoId] || {};
    if (cached.headline) { titleLine = `▶ ${esc(cached.headline)}`; subLine = `<span class="news-preview">${esc(it.title)}</span>`; }
    else if (ytAutoForItem(it)) subLine = `<span class="news-preview muted">要約を準備中…</span>`;
  }
  // ○の色: 「更新」で入った新着未読=黄（次にタブを開き直すと通常の未読=青へ戻る）/ 未読=青 / 既読=従来どおり
  const batchCls = (unread && it.batch && _newsCache && it.batch === _newsCache.at && _newsCache.at !== _newsSeenMark) ? ' nu-new' : '';
  return `<a class="news-item ${unread ? 'unread' : ''}${batchCls}" href="${esc(it.link)}" data-link="${esc(it.link)}" target="_blank" rel="noopener" draggable="false" onclick="newsOpenArticle(event,this)">
      ${hideBtn}
      <span class="news-title">${titleLine}</span>
      ${subLine}
      <span class="news-meta">${catChip}<span>${esc(it.source || '')}</span><span>${newsTime(it.pubDate)}</span>${secChips}${tagChips}${majorChips}</span>
    </a>`;
}
// ============ マクロ指標の基準値ライン・警告 ============
// 指標ごとに「基準値」と「どちらへ抜けたら警告か」を登録し、
//   ・グラフに基準値の水平線
//   ・ダッシュボードの「マクロ警告」カード
//   ・定時通知メールの「マクロ警告」欄（サーバー側で最新値を取り直して判定）
// で知らせる。**設定した条件を満たした事実を伝えるだけで、売買の推奨はしない。**
const MA_MODES = [
  ['level', '実値',   'その時点の値そのもの'],
  ['chg',   '前期差', '1つ前の観測との差'],
  ['yoy',   '1年差',  '約1年前の観測との差'],
];
const MA_CMPS = [['gt', '上回ったら'], ['lt', '下回ったら']];
const maModeLabel = (m) => (MA_MODES.find(x => x[0] === m) || MA_MODES[0])[1];
const maCmpLabel = (c) => (MA_CMPS.find(x => x[0] === c) || MA_CMPS[0])[1];

function macroAlerts() { return (store.data.macroAlerts || []).filter(a => a && !a.deleted); }
// 1件の判定。表示と同じ値（前年比などの変換後）で判定するため macroPoints を使う。
// 戻り値: null=データ不足 / {fired, value, date}
function macroAlertState(a) {
  if (!a || !a.seriesId || !isFinite(a.value)) return null;
  const pts = macroPoints(a.seriesId);
  if (!pts.length) return null;
  const last = pts[pts.length - 1];
  let v = null;
  if (a.mode === 'chg') { if (pts.length < 2) return null; v = last[1] - pts[pts.length - 2][1]; }
  else if (a.mode === 'yoy') { const y = macroAtBefore(pts, last[0], 365, 60); if (!y) return null; v = last[1] - y[1]; }
  else v = last[1];
  if (v == null || !isFinite(v)) return null;
  return { fired: a.cmp === 'lt' ? (v < a.value) : (v > a.value), value: v, date: last[0] };
}
function macroFiredAlerts() {
  return macroAlerts().filter(a => a.enabled !== false).map(a => ({ a, st: macroAlertState(a) }))
    .filter(x => x.st && x.st.fired);
}
function macroAlertText(a, st) {
  const def = MACRO_SERIES[a.seriesId] || {};
  const unit = def.unit ? ' ' + def.unit : '';
  return `${def.label || a.seriesId}（${maModeLabel(a.mode)}）が ${macroFmt(a.value, a.seriesId)}${unit} を${maCmpLabel(a.cmp)}`
    + `：現在 ${macroFmt(st.value, a.seriesId)}${unit}（${st.date}）`;
}

// ---- 編集UI ----
function openMacroAlerts() {
  const rows = macroAlerts().map(a => {
    const st = macroAlertState(a);
    const def = MACRO_SERIES[a.seriesId] || {};
    const status = !st ? '<span class="muted">データ不足</span>'
      : st.fired ? '<span class="neg" style="font-weight:700">条件成立</span>'
      : '<span class="muted">条件外</span>';
    return `<tr>
      <td class="l">${esc(def.label || a.seriesId)}</td>
      <td class="c">${esc(maModeLabel(a.mode))}</td>
      <td class="c">${esc(maCmpLabel(a.cmp))}</td>
      <td class="r">${macroFmt(a.value, a.seriesId)}${def.unit ? ' ' + esc(def.unit) : ''}</td>
      <td class="r">${st ? macroFmt(st.value, a.seriesId) : '—'}</td>
      <td class="c">${status}</td>
      <td class="c"><label style="display:inline-flex;align-items:center;gap:4px;font-size:11px">
        <input type="checkbox" ${a.enabled === false ? '' : 'checked'} onchange="maToggle('${jsq(a.id)}', this.checked)">有効</label></td>
      <td class="c"><button class="btn btn-sm" onclick="maDelete('${jsq(a.id)}')">削除</button></td>
    </tr>`;
  }).join('');
  // 選べる指標は「グラフに出せる指標」＝指数・為替を除いた系列
  const opts = Object.keys(MACRO_SERIES).filter(id => MACRO_SERIES[id].src !== 'idx')
    .map(id => `<option value="${esc(id)}">${esc(MACRO_SERIES[id].label)}${MACRO_SERIES[id].unit ? '（' + esc(MACRO_SERIES[id].unit) + '）' : ''}</option>`).join('');
  showModal('基準値と警告', `
    <p class="muted" style="margin:0 0 10px;font-size:12px">指標が設定した基準値を抜けたら、グラフの水平線・ダッシュボード・定時通知メールで知らせます。
      判定は画面と同じ値（前年比などの変換後）で行います。<b>条件を満たした事実をお知らせするもので、売買の判断を示すものではありません。</b></p>
    <div class="table-wrap" style="max-height:260px">
      <table class="list"><thead><tr><th class="l">指標</th><th class="c">判定</th><th class="c">向き</th><th class="r">基準値</th><th class="r">現在</th><th class="c">状態</th><th class="c">有効</th><th class="c"></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="c muted" style="padding:14px">まだ登録がありません。下から追加してください。</td></tr>'}</tbody></table></div>
    <div style="margin-top:12px;display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:8px;align-items:end">
      <label>指標<select id="ma-series">${opts}</select></label>
      <label>判定<select id="ma-mode">${MA_MODES.map(([v, l, t]) => `<option value="${v}" title="${esc(t)}">${l}</option>`).join('')}</select></label>
      <label>向き<select id="ma-cmp">${MA_CMPS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
      <label>基準値<input id="ma-value" type="number" step="any" placeholder="例: 3"></label>
      <button class="btn btn-primary" onclick="maAdd()">追加</button>
    </div>`, { wide: true });
}
function maAdd() {
  const seriesId = (document.getElementById('ma-series') || {}).value;
  const mode = (document.getElementById('ma-mode') || {}).value || 'level';
  const cmp = (document.getElementById('ma-cmp') || {}).value || 'gt';
  const value = parseFloat((document.getElementById('ma-value') || {}).value);
  if (!seriesId || !isFinite(value)) { toast('基準値を数値で入力してください'); return; }
  store.data.macroAlerts ||= [];
  store.data.macroAlerts.push({ id: 'ma' + store.nextId(), seriesId, mode, cmp, value, enabled: true, updatedAt: store._now() });
  store.save();
  openMacroAlerts(); render();
}
// 削除はトンボストン（deleted:true＋新しい updatedAt）。配列から消すと同期で復活する（ルール5-8）
function maDelete(id) {
  const a = (store.data.macroAlerts || []).find(x => x.id === id);
  if (!a) return;
  a.deleted = true; a.updatedAt = store._now(); store.save();
  openMacroAlerts(); render();
}
function maToggle(id, on) {
  const a = (store.data.macroAlerts || []).find(x => x.id === id);
  if (!a) return;
  a.enabled = !!on; a.updatedAt = store._now(); store.save();
  openMacroAlerts(); render();
}

// ---- ダッシュボードのカード ----
function macroAlertCardHtml() {
  const fired = macroFiredAlerts();
  const total = macroAlerts().filter(a => a.enabled !== false).length;
  if (!total) return '';   // 未設定なら何も出さない（空枠で場所を取らない）
  const body = fired.length
    ? `<div class="upd-list ma-list">${fired.map(({ a, st }) => `<button class="upd-item unseen" onclick="maOpenSeries('${jsq(a.seriesId)}')">
        <span class="upd-kind alert">警告</span>
        <span class="upd-body"><span class="upd-title">${esc(macroAlertText(a, st))}</span></span>
      </button>`).join('')}</div>`
    : `<div class="empty empty-sm">設定した ${total} 件の基準値はいずれも条件外です。</div>`;
  return `<div class="section upd-section">
    <div class="upd-head"><b>マクロ警告</b>${fired.length ? `<span class="upd-new">${fired.length}件</span>` : ''}
      <span style="margin-left:auto"></span>
      <button class="btn btn-sm" onclick="openMacroAlerts()">設定</button></div>
    ${body}</div>`;
}
function maOpenSeries(seriesId) {
  const w = macroWhereIs(seriesId);
  macroSaveView({ macroGroup: w.group, macroCard: Object.assign({}, (store.data.macroView || {}).macroCard || {}, { [w.group]: w.card }) });
  go('macro');
}

// ============ 更新情報フィード（NEWバッジ／ダッシュボードのお知らせ） ============
// 「経済指標が更新された」「YouTube動画が上がった」を1本のフィードに貯め、
//   ・サイドナビの該当タブに NEW バッジ
//   ・ダッシュボードの「更新情報」一覧（クリックでその指標・動画へ遷移）
// として見せる。既読は updSeen（キー→既読日時）で持ち、端末をまたいで同期する。
const UPD_MAX = 80;          // 保持する件数（古いものから捨てる）
const UPD_SHOW = 12;         // ダッシュボードに出す件数
const UPD_KIND_LABEL = { macro: '経済指標', video: '動画' };

// フィードに1件積む。key が同じものは「最新の1件」に上書きする（同じ指標の再更新で行が増えないように）。
// 並び替えのキー。★「気づいた時刻(at)」ではなく**出来事の日付(date)**で並べる。
// at で並べると、同じ更新でまとめて取得した指標が全部同じ時刻になって順不同に見えるうえ、
// 「7月分のCPI」と「3月公開の動画」が取得順で混ざる（すみぽん指摘 2026-08-14）。
// date（指標＝観測日 / 動画＝公開日）で降順、同日なら at で降順。
const updSortKey = (r) => [(r && r.date) || '', (r && r.at) || ''];
function updCmp(a, b) {
  const ka = updSortKey(a), kb = updSortKey(b);
  if (ka[0] !== kb[0]) return ka[0] < kb[0] ? 1 : -1;
  if (ka[1] !== kb[1]) return ka[1] < kb[1] ? 1 : -1;
  return 0;
}
function updPush(rec) {
  store.data.updates ||= [];
  const now = store._now();
  const i = store.data.updates.findIndex(r => r.key === rec.key);
  const row = Object.assign({ id: rec.key, at: now, updatedAt: now }, rec);
  if (i >= 0) store.data.updates[i] = row; else store.data.updates.push(row);
  store.data.updates.sort(updCmp);
  if (store.data.updates.length > UPD_MAX) store.data.updates = store.data.updates.slice(0, UPD_MAX);
}
function updList(kind) {
  const all = (store.data.updates || []).filter(r => r && r.key && (!kind || r.kind === kind));
  return all.slice().sort(updCmp);
}
function updIsUnseen(r) { return !((store.data.updSeen || {})[r.key]); }
function updUnseenCount(kind) { return updList(kind).filter(updIsUnseen).length; }
// 既読にする。kind を渡すとその種別を全部、rec を渡すと1件だけ。
function updMarkSeen(kind, key) {
  store.data.updSeen ||= {};
  const now = store._now();
  let changed = false;
  for (const r of updList(kind)) {
    if (key && r.key !== key) continue;
    if (!store.data.updSeen[r.key]) { store.data.updSeen[r.key] = now; changed = true; }
  }
  if (changed) store.save();
  return changed;
}

// ---- 検知: 経済指標の更新 ----
// 取得前の最終観測日と比べ、新しい観測が入った時だけ積む（同じ日のデータ再取得では積まない）。
// 指数・為替(src:'idx')は毎日動くので対象外。「指標が更新された」だけを拾う。
function updNoteMacro(id, prevLastDate, obs, freq) {
  const def = MACRO_SERIES[id];
  if (!def || def.src === 'idx' || !obs || !obs.length) return;
  // ★日次の指標（米国債利回り・FF金利・期待インフレ・VIX等）は毎営業日に値が入るので、
  //   お知らせに出すと毎日大量に流れて他の更新が埋もれる（すみぽん指摘 2026-08-14）。
  //   「指標が更新された」と言えるのは月次・四半期（と週次）なので、日次は積まない。
  if (freq === '日次') return;
  const last = obs[obs.length - 1];
  if (!last || !last[0]) return;
  if (!prevLastDate || !(last[0] > prevLastDate)) return;   // 初回取得・更新なしは積まない
  const where = macroWhereIs(id);
  updPush({
    kind: 'macro', key: 'macro:' + id + ':' + last[0],
    title: def.label,
    sub: `${last[0]} ＝ ${macroFmt(macroTransformLast(id, obs), id)}${def.unit ? ' ' + def.unit : ''}`,
    date: last[0], seriesId: id, group: where.group, card: where.card,
  });
}
// 表示用の変換（前年比など）を通した最新値。カード表示と数字を揃えるため macroPoints と同じ経路を使う。
function macroTransformLast(id, obs) {
  const prev = (store.data.macro || {})[id];
  store.data.macro ||= {};
  store.data.macro[id] = { obs, freq: (prev && prev.freq) || '', at: store._now() };
  const pts = macroPoints(id);
  if (prev) store.data.macro[id] = prev; else delete store.data.macro[id];
  return pts.length ? pts[pts.length - 1][1] : null;
}
// その系列がどのグループ・カードで見られるかを引く（クリックでその指標へ遷移するため）
function macroWhereIs(id) {
  for (const g of MACRO_GROUPS) for (const c of g.cards) if (c.ids.includes(id)) return { group: g.key, card: c.key };
  return { group: 'infl', card: 'cpi' };
}

// ---- 検知: YouTube動画の新着 ----
// ニュース取得で得た動画のうち、まだフィードに無いものを積む。
function updNoteVideos(items) {
  for (const v of items || []) {
    if (!v || !v.videoId) continue;
    const key = 'video:' + v.videoId;
    if ((store.data.updates || []).some(r => r.key === key)) continue;   // 既に積んである
    updPush({
      kind: 'video', key,
      title: v.title || '(無題の動画)',
      sub: [v.source || 'YouTube', (v.pubDate || '').slice(0, 10)].filter(Boolean).join(' ・ '),
      date: (v.pubDate || '').slice(0, 10),
      // ★並び順(at)は「気づいた時刻」で統一する。動画だけ公開日時にすると、経済指標(検知時刻)と
      //   時計が混ざって、新着動画が古い扱いで一覧の下に沈む（実測で先頭12件に出てこなかった）。
      link: v.link, videoId: v.videoId,
    });
  }
}

// ---- 1日1回の裏取得（起動時） ----
// ★これが無いと更新情報は「マクロ指標タブを開いた後」「ニュースで更新を押した後」にしか増えず、
//   ダッシュボードに出す意味が無い（2026-08-14 すみぽん指摘）。起動時に裏で取りに行って、
//   ダッシュボードを開いただけで新着が分かるようにする。
// ニュース一覧（newsPool）には触らない。「開いたら勝手に更新される」のを止めた経緯があるため
//   （2026-07-23 すみぽん要望）。ここで取るのは**購読YouTubeの新着だけ**。
// 起動時と、「価格更新」「ニュース更新」を押した時に走る裏取得。
// manual=true（ボタン起点）のときは、セッション内で一度失敗していても再挑戦する。
// ★マクロと動画は**並列**に走らせること。直列(await)にすると、マクロの取得が遅い時に
//   動画の確認が始まらない（実測: ローカルでFREDに繋がらず90秒以上ブロックされ、動画が取れなかった）。
async function updDailyCheck(manual) {
  const done = () => { if (currentView === 'dashboard') render(); else renderNav(); };  // NEWバッジだけは即反映
  const jobs = [];
  // マクロは日付ガードのまま（月次・四半期・週次の指標が1日に何度も変わることはない）。
  // FRED側も6時間エッジキャッシュなので、押し直しても外部への負荷にはならない。
  if (store.data.lastMacroDate !== todayJst() && !macroBusy && (manual || !_macroTried)) {
    _macroTried = true;
    jobs.push(macroRefresh({ quiet: true }).catch(() => {}));   // 裏取得なのでトーストを出さない
  }
  jobs.push(updVideoCheck().catch(() => {}));
  jobs.forEach(pr => pr.then(done));   // 終わったものから順に画面へ反映（片方が遅くても待たせない）
  await Promise.allSettled(jobs);
}
// 購読チャンネルの新着動画を確認して更新情報に積む（/api/youtube を1回叩くだけ）。
// 起動時のほか「価格更新」「ニュース更新」でも走らせるので、無駄打ち防止に UPD_VIDEO_COOLDOWN 分の
// クールダウンを置く。※取得元は YouTube 公式RSS（APIキー不要・クォータ無し）で、さらに
// /api/youtube 側が Cloudflare で10分キャッシュしているため、頻度を上げても外部への負荷は増えない。
const UPD_VIDEO_COOLDOWN = 10 * 60 * 1000;   // 10分（/api/youtube のエッジキャッシュと同じ）
async function updVideoCheck(force) {
  const last = store.data.lastVideoCheck;
  if (!force && last) {
    // 旧データは 'YYYY-MM-DD'（日付）で入っている。どちらでも Date.parse で扱える
    const t = Date.parse(last);
    if (isFinite(t) && Date.now() - t < UPD_VIDEO_COOLDOWN) return;
  }
  const vids = await _newsVideos();
  store.data.lastVideoCheck = store._now();
  if (vids && vids.length) updNoteVideos(vids);
  store.save();
}

// ---- ダッシュボードの「更新情報」 ----
function updFeedHtml() {
  const rows = updList(null).slice(0, UPD_SHOW);
  const unseen = updList(null).filter(updIsUnseen).length;
  const body = rows.length ? rows.map(r => {
    const isNew = updIsUnseen(r);
    return `<button class="upd-item${isNew ? ' unseen' : ''}" onclick="updOpen('${jsq(r.key)}')" title="クリックで${r.kind === 'video' ? 'ニュースタブの該当動画' : 'この指標'}へ移動">
      <span class="upd-kind ${r.kind}">${UPD_KIND_LABEL[r.kind] || ''}</span>
      <span class="upd-body"><span class="upd-title">${esc(r.title)}</span><span class="upd-sub">${esc(r.sub || '')}</span></span>
      <span class="upd-meta">${isNew ? '<span class="upd-new">NEW</span>' : ''}<span class="muted">${esc(updWhen(r))}</span></span>
    </button>`;
  }).join('') : '<div class="muted" style="padding:10px 2px;font-size:12px">まだ更新情報はありません。マクロ指標の更新やYouTubeの新着があるとここに出ます。</div>';
  // ダッシュボードは元々ちょうど窓いっぱいなので、見出し・余白は最小限にする（section-head を使うと
  // それだけで60px使い、一覧が3行しか出せなくなる）
  return `<div class="section upd-section">
    <div class="upd-head"><b>更新情報</b>${unseen ? `<span class="upd-new">新着 ${unseen}</span>` : ''}
      <span style="margin-left:auto"></span>
      ${unseen ? '<button class="btn btn-sm" onclick="updMarkAllSeen()">すべて既読</button>' : ''}</div>
    <div class="upd-list" id="upd-feed-list">${body}</div>
  </div>`;
}
// 一覧の右に出す日付。並び順と揃えるため**出来事の日付(date)**を優先する
// （at＝気づいた時刻を出すと、7月分のCPIが「13:05」と表示されて時系列に見えない）
function updWhen(r) {
  const t = r.date || r.at; if (!t) return '';
  try {
    const d = new Date(t), now = Date.now(), diff = (now - d.getTime()) / 86400000;
    if (diff < 1) return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    if (diff < 7) return Math.floor(diff) + '日前';
    return d.toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' });
  } catch (_) { return ''; }
}
// クリック: その指標／その動画へ遷移し、その1件を既読にする
function updOpen(key) {
  const r = (store.data.updates || []).find(x => x.key === key);
  if (!r) return;
  updMarkSeen(null, key);
  if (r.kind === 'macro') {
    macroSaveView({ macroGroup: r.group, macroCard: Object.assign({}, (store.data.macroView || {}).macroCard || {}, { [r.group]: r.card }) });
    go('macro');
  } else {
    go('news');
    // 一覧の該当行を選択して、記事（動画は要約パネル）のモーダルまで開く（描画後に探す）
    setTimeout(() => {
      // ★CSS.escape は「識別子」用。引用符付き属性値に使うと URL が https\:\/\/... とエスケープされ
      //   生の値と一致しない（実際に該当行を見つけられなかった）。DOM を走査して素直に比較する。
      const el = r.link ? [...document.querySelectorAll('.news-item')].find(a => a.dataset.link === r.link) : null;
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('upd-flash'); setTimeout(() => el.classList.remove('upd-flash'), 2000);
        el.click();   // 一覧の行を押したのと同じ＝既読にしてパネルを開く
        return;
      }
      // 一覧に出ていない（期間やカテゴリの絞り込み外・保持期間外）場合でも、プールに記事があれば
      // 直接パネルを開く。勝手に外部タブは開かない（ポップアップ扱いで塞がれるうえ不意に別サイトが開く）。
      // プールに無くても、更新情報の記録だけで動画パネルは開ける（起動時の裏取得はプールに入れないため）
      const it = ((typeof newsFindItem === 'function' && r.link) ? newsFindItem(r.link) : null)
        || (r.videoId ? { title: r.title, link: r.link, videoId: r.videoId, source: (r.sub || '').split(' ・ ')[0] || 'YouTube', pubDate: r.date, cat: 'video' } : null);
      if (it) {
        store.data.newsRead ||= {}; store.data.newsRead[r.link] = new Date().toISOString(); store.save();
        if (it.cat === 'video' && typeof openVideoPanel === 'function') openVideoPanel(it);
        else if (typeof newsOpenArticle === 'function') {
          const fake = { preventDefault() {} };
          newsOpenArticle(fake, { dataset: { link: r.link }, classList: { remove() {} } });
        }
        return;
      }
      toast('この動画はニュース一覧にまだありません。「更新」で取得できます', 3500);
    }, 250);
  }
}
function updMarkAllSeen() { updMarkSeen(null); render(); }

// ============ マクロ指標（FRED）タブ ============
// インフレ・金利・SLOOS（FRBが銀行の融資担当者に行う調査）・景気・信用の指標を、カード＋グラフ＋表で表示する。
// 取得は /api/macro（Cloudflare Function → FRED）。結果は store.data.macro にキャッシュし Google同期の
// 対象にする（ルール7: localStorage 単独に置かない。sync-merge の SCHEMA に map+byAt で登録済み）。
// 表示は「値・変化・過去比」の事実のみ。売買の推奨は出さない。

// 系列定義。tf=表示変換（raw / yoy=前年比% / diff=前期差）、good=その方向に動くと景気に追い風（色付け用）。
// 系列IDは fredgraph で実在と直近値を確認済み（2026-08-13）。
const MACRO_SERIES = {
  // インフレ
  CPIAUCSL:        { label: 'CPI 総合',                 tf: 'yoy',  unit: '%',   dec: 1, good: 'down' },
  CPILFESL:        { label: 'コアCPI',                  tf: 'yoy',  unit: '%',   dec: 1, good: 'down' },
  PCEPILFE:        { label: 'コアPCE',                  tf: 'yoy',  unit: '%',   dec: 1, good: 'down' },
  T10YIE:          { label: '期待インフレ(10年BEI)',    tf: 'raw',  unit: '%',   dec: 2, good: 'down' },
  // 金利
  DFF:             { label: 'FF金利(実効)',             tf: 'raw',  unit: '%',   dec: 2, good: 'down' },
  DGS2:            { label: '米2年債',                  tf: 'raw',  unit: '%',   dec: 2, good: 'down' },
  DGS10:           { label: '米10年債',                 tf: 'raw',  unit: '%',   dec: 2, good: 'down' },
  T10Y2Y:          { label: '10年−2年',                 tf: 'raw',  unit: '%pt', dec: 2, good: 'up' },
  MORTGAGE30US:    { label: '住宅ローン30年',           tf: 'raw',  unit: '%',   dec: 2, good: 'down' },
  // SLOOS（融資担当者調査・四半期）。プラス＝「厳格化した」と答えた銀行が多い（純％）
  DRTSCILM:        { label: 'C&I 基準厳格化(大企業)',   tf: 'raw',  unit: '%pt', dec: 1, good: 'down' },
  DRTSCIS:         { label: 'C&I 基準厳格化(中小)',     tf: 'raw',  unit: '%pt', dec: 1, good: 'down' },
  DRSDCILM:        { label: 'C&I 需要(大企業)',         tf: 'raw',  unit: '%pt', dec: 1, good: 'up' },
  DRSDCIS:         { label: 'C&I 需要(中小)',           tf: 'raw',  unit: '%pt', dec: 1, good: 'up' },
  DRTSCLCC:        { label: 'カードローン 基準厳格化',  tf: 'raw',  unit: '%pt', dec: 1, good: 'down' },
  SUBLPDHMSGNQ:    { label: '住宅ローン 基準厳格化',    tf: 'raw',  unit: '%pt', dec: 1, good: 'down' },
  // 景気・雇用
  UNRATE:          { label: '失業率',                   tf: 'raw',  unit: '%',   dec: 1, good: 'down' },
  PAYEMS:          { label: '非農業雇用(前月差)',       tf: 'diff', unit: '千人', dec: 0, good: 'up' },
  ICSA:            { label: '新規失業保険申請',         tf: 'raw',  unit: '件',  dec: 0, good: 'down' },
  A191RL1Q225SBEA: { label: '実質GDP成長率(年率)',      tf: 'raw',  unit: '%',   dec: 1, good: 'up' },
  INDPRO:          { label: '鉱工業生産(前年比)',       tf: 'yoy',  unit: '%',   dec: 1, good: 'up' },
  RSAFS:           { label: '小売売上(前年比)',         tf: 'yoy',  unit: '%',   dec: 1, good: 'up' },
  UMCSENT:         { label: '消費者信頼感(ミシガン大)', tf: 'raw',  unit: '',    dec: 1, good: 'up' },
  // 信用・リスク
  BAMLH0A0HYM2:    { label: 'ハイイールド・スプレッド', tf: 'raw',  unit: '%pt', dec: 2, good: 'down' },
  NFCI:            { label: '金融環境指数(シカゴ連銀)', tf: 'raw',  unit: '',    dec: 2, good: 'down' },
  VIXCLS:          { label: 'VIX',                      tf: 'raw',  unit: '',    dec: 1, good: 'down' },
  // 日本CPI（src:'estat'）。FRED（OECD配信）の日本CPIは全系列が2021-06で更新停止しているため、
  // e-Stat の「消費者物価指数（2025年基準）」statsDataId=0004052037 から直接取る。
  // cdTab=3 が「前年同月比(%)」なので、こちらで前年比を計算する必要はない（tf:'raw'）。
  // cdCat01 は品目コード（本番の getMetaInfo で実物を確認済み）: 0001総合 / 0161生鮮食品を除く総合 /
  // 0178生鮮食品及びエネルギーを除く総合。cdArea=00000 が全国。
  JP_CPI:      { label: '日本CPI 総合',     tf: 'raw', unit: '%', dec: 1, good: 'down', src: 'estat',
                 estat: { id: '0004052037', cdTab: '3', cdCat01: '0001', cdArea: '00000' } },
  JP_CPI_CORE: { label: '日本CPI コア',     tf: 'raw', unit: '%', dec: 1, good: 'down', src: 'estat',
                 estat: { id: '0004052037', cdTab: '3', cdCat01: '0161', cdArea: '00000' } },
  JP_CPI_CC:   { label: '日本CPI コアコア', tf: 'raw', unit: '%', dec: 1, good: 'down', src: 'estat',
                 estat: { id: '0004052037', cdTab: '3', cdCat01: '0178', cdArea: '00000' } },
  // 日本（FRED経由）。★鉱工業生産はFRED（OECD配信）が2024-03で更新停止。e-Statの現行基準の表も
  // 検索で出てこなかったため未搭載（22.10 参照）。以下は現行で更新が続いている系列のみ。
  IRLTLT01JPM156N: { label: '日本10年国債',           tf: 'raw', unit: '%', dec: 2, good: 'down' },
  IRSTCI01JPM156N: { label: '日本 短期金利(コール)',  tf: 'raw', unit: '%', dec: 2, good: 'down' },
  LRHUTTTTJPM156S: { label: '日本 失業率',            tf: 'raw', unit: '%', dec: 1, good: 'down' },
  JPNRGDPEXP:      { label: '日本 実質GDP(前年比)',   tf: 'yoy', unit: '%', dec: 1, good: 'up' },
  XTEXVA01JPM667S: { label: '日本 輸出額(前年比)',    tf: 'yoy', unit: '%', dec: 1, good: 'up' },
  // 実質実効為替レート: 下落＝円安。輸出企業には追い風・輸入コストには逆風で良し悪しが一概に言えないため good なし＝色付けしない
  RBJPBIS:         { label: '円 実質実効為替レート',  tf: 'raw', unit: '', dec: 1 },
  // 指数・為替（src:'idx'）。FREDではなく Yahoo（/api/history）から取得し store.data.macroIdx に入れる。
  // 桁が指標とまったく違う（S&P500約6,000 / 日経約67,500 / ドル円約157）ため、重ねる時は起点=100で指数化する。
  '^GSPC':         { label: 'S&P500',      tf: 'raw', unit: '', dec: 0, good: 'up', src: 'idx' },
  '^NDX':          { label: 'NASDAQ100',   tf: 'raw', unit: '', dec: 0, good: 'up', src: 'idx' },
  '^N225':         { label: '日経平均',    tf: 'raw', unit: '', dec: 0, good: 'up', src: 'idx' },
  '1306.T':        { label: 'TOPIX(連動ETF)', tf: 'raw', unit: '', dec: 0, good: 'up', src: 'idx' },
  'USDJPY=X':      { label: 'ドル円',      tf: 'raw', unit: '円', dec: 2, src: 'idx' },  // 円安/円高の良し悪しは一概に言えないので good なし＝色付けしない
};
// グループ（画面のセグメント）とカード。1カード＝1グラフで、ids が複数なら同じグラフに重ねる
// （重ねるのは単位が揃う組み合わせだけ）。カードの見出し数値は ids[0]。
const MACRO_GROUPS = [
  { key: 'infl', label: 'インフレ', cards: [
    { key: 'cpi',  label: 'CPI（総合・コア）',   ids: ['CPIAUCSL', 'CPILFESL'], note: '前年比。FRBの目標は2%' },
    { key: 'pce',  label: 'コアPCE',             ids: ['PCEPILFE'],             note: '前年比。FRBが最重視する物価指標' },
    { key: 'bei',  label: '期待インフレ(10年)',  ids: ['T10YIE'],               note: '債券市場が織り込む先々のインフレ率' },
  ] },
  { key: 'rate', label: '金利', cards: [
    { key: 'curve',  label: '米金利（FF・2年・10年）', ids: ['DFF', 'DGS2', 'DGS10'], note: '政策金利と国債利回り' },
    { key: 'spread', label: '10年−2年',                ids: ['T10Y2Y'],               note: 'マイナス＝逆イールド（景気後退の先行指標とされる）' },
    { key: 'mort',   label: '住宅ローン30年',          ids: ['MORTGAGE30US'],         note: '家計の借入コスト' },
  ] },
  { key: 'sloos', label: '融資動向(SLOOS)', cards: [
    { key: 'ci',   label: 'C&I融資 基準厳格化',   ids: ['DRTSCILM', 'DRTSCIS'],  note: 'プラス＝貸出基準を厳しくした銀行が多い（企業の資金繰りに逆風）' },
    { key: 'cid',  label: 'C&I融資 需要',         ids: ['DRSDCILM', 'DRSDCIS'],  note: 'プラス＝借入需要が強いと答えた銀行が多い' },
    { key: 'cons', label: '家計向け 基準厳格化',  ids: ['DRTSCLCC', 'SUBLPDHMSGNQ'], note: 'カードローン・住宅ローンの貸出基準' },
  ] },
  { key: 'econ', label: '景気・雇用', cards: [
    { key: 'unrate', label: '失業率',             ids: ['UNRATE'],            note: '' },
    { key: 'payems', label: '非農業雇用(前月差)', ids: ['PAYEMS'],            note: '毎月の雇用の増減（千人）' },
    { key: 'claims', label: '新規失業保険申請',   ids: ['ICSA'],              note: '週次。雇用の悪化がいちばん早く出る' },
    { key: 'gdp',    label: '実質GDP成長率',      ids: ['A191RL1Q225SBEA'],   note: '四半期・年率換算' },
    { key: 'prod',   label: '生産・小売（前年比）', ids: ['INDPRO', 'RSAFS'], note: '' },
    { key: 'senti',  label: '消費者信頼感',       ids: ['UMCSENT'],           note: '' },
  ] },
  { key: 'credit', label: '信用・リスク', cards: [
    { key: 'hy',   label: 'ハイイールド・スプレッド', ids: ['BAMLH0A0HYM2'], note: '低格付け社債の上乗せ金利。拡大＝リスク回避' },
    { key: 'nfci', label: '金融環境指数',            ids: ['NFCI'],          note: 'プラス＝金融環境が引き締まっている' },
    { key: 'vix',  label: 'VIX',                     ids: ['VIXCLS'],        note: '株式市場の変動率の織り込み' },
  ] },
  { key: 'jp', label: '日本', cards: [
    { key: 'jpcpi',  label: '日本CPI（総合・コア）',   ids: ['JP_CPI', 'JP_CPI_CORE'], note: '前年同月比。日銀の物価目標は2%' },
    { key: 'jpcpicc', label: '日本CPI コアコア',       ids: ['JP_CPI_CC'], note: '生鮮食品及びエネルギーを除く総合・前年同月比。基調的な物価' },
    { key: 'jprate', label: '日本の金利（10年・短期）', ids: ['IRLTLT01JPM156N', 'IRSTCI01JPM156N'], note: '長期＝10年国債・短期＝無担保コールレート（日銀の政策金利の実勢）' },
    { key: 'jpjob',  label: '日本 失業率',             ids: ['LRHUTTTTJPM156S'], note: '' },
    { key: 'jpgdp',  label: '日本 実質GDP（前年比）',  ids: ['JPNRGDPEXP'],      note: '四半期' },
    { key: 'jpexp',  label: '日本 輸出額（前年比）',   ids: ['XTEXVA01JPM667S'], note: '外需の強さ。円安局面では円建て額が膨らむ点に注意' },
    { key: 'jpfx',   label: '円 実質実効為替レート',   ids: ['RBJPBIS'],         note: '物価差を調整した円の総合的な強さ。下がるほど円安' },
  ] },
  // norm:true＝重ね合わせを選んでいなくても常に起点=100で指数化するカード。
  // 桁の違う系列を同じ軸に並べると小さい方が潰れて読めないため（日経66,970とドル円159を実数で重ねると
  // ドル円が横一線になる）。単独系列（ドル円）は実数のままで良い。
  // right: その系列を右軸に置く（桁が違う組み合わせを実値のまま両方読めるようにする）。
  // 例: 日経平均 66,970 と TOPIX連動ETF 431 を同じ軸に置くと ETF が横一線になる。
  { key: 'idx', label: '指数・為替', cards: [
    { key: 'us',    label: '米国株指数',        ids: ['^GSPC', '^NDX'],    right: ['^NDX'],      note: 'S&P500（左）と NASDAQ100（右）' },
    { key: 'jp',    label: '日本株指数',        ids: ['^N225', '1306.T'],  right: ['1306.T'],    note: '日経平均（左）と TOPIX連動ETF（右）' },
    { key: 'fx',    label: 'ドル円',            ids: ['USDJPY=X'],         note: '' },
    { key: 'nkfx',  label: '日経平均 × ドル円', ids: ['^N225', 'USDJPY=X'], right: ['USDJPY=X'], note: '日経平均（左）とドル円（右）' },
  ] },
];
// 「比較」で重ねられる指数・為替（Yahoo）。MACRO_SERIES に src:'idx' として登録済みのものだけ。
const MACRO_COMPARE = ['^GSPC', '^NDX', '^N225', '1306.T', 'USDJPY=X'];
const MACRO_PERIODS = [['1y', '1年'], ['3y', '3年'], ['5y', '5年'], ['10y', '10年'], ['all', '全期間']];
const MACRO_COLORS = ['#2563eb', '#dc2626', '#0d9488', '#7c3aed', '#ca8a04'];
// 出典表記は取得元ごとに必要（FREDもe-Statも出典明示が利用条件）。画面に出ている系列の取得元だけ並べる。
const MACRO_SRC_LABEL = { fred: 'FRED®（セントルイス連邦準備銀行）', estat: 'e-Stat（政府統計の総合窓口）', idx: 'Yahoo Finance' };
function macroSrcNote(ids) {
  const srcs = [...new Set((ids || []).map(id => (MACRO_SERIES[id] || {}).src || 'fred'))];
  const labels = srcs.map(s => MACRO_SRC_LABEL[s]).filter(Boolean);
  return '出典: ' + (labels.length ? labels.join(' / ') : MACRO_SRC_LABEL.fred);
}
let macroBusy = false;
let _macroTried = false;  // このセッションで自動取得を試したか（失敗時の無限リトライ防止）
let _macroNorm = null;    // 直近の描画の状態 {dual:2軸か, cmp:比較の選択数}

// 表示状態（グループ/カード/期間）は端末をまたいで揃えたいので settings に置く（ルール7）
function macroGroupKey() { const k = (store.data.macroView || {}).macroGroup; return MACRO_GROUPS.some(g => g.key === k) ? k : 'infl'; }
function macroGroupDef() { return MACRO_GROUPS.find(g => g.key === macroGroupKey()) || MACRO_GROUPS[0]; }
function macroCardKey() { const g = macroGroupDef(); const k = ((store.data.macroView || {}).macroCard || {})[g.key]; return g.cards.some(c => c.key === k) ? k : g.cards[0].key; }
function macroCardDef() { const g = macroGroupDef(); return g.cards.find(c => c.key === macroCardKey()) || g.cards[0]; }
function macroPeriod() { const p = (store.data.macroView || {}).macroPeriod; return MACRO_PERIODS.some(x => x[0] === p) ? p : '5y'; }
// 比較で重ねる指数（複数可）。★指標（カード）ごとに別々に保持する。
// 「CPIには日経を重ねたいが、VIXには重ねたくない」のように、見たい組み合わせは指標ごとに違うため
// （2026-08-13 すみぽん指示）。キーは グループ/カード。
function macroCompareKey() { return macroGroupKey() + '/' + macroCardKey(); }
function macroCompare() {
  const m = (store.data.macroView || {}).macroCompare;
  const a = (m && typeof m === 'object') ? m[macroCompareKey()] : null;
  return Array.isArray(a) ? a.filter(s => MACRO_COMPARE.includes(s)) : [];
}
// マクロ表示状態の保存。★settings ではなく macroView に書く（settings に同居させると他機能の
// 書き込みが巻き込んで巻き戻る。ルール7-2）。_updatedAt はマクロ表示状態専用の編集時刻になる。
function macroSaveView(patch) {
  store.data.macroView ||= {};
  Object.assign(store.data.macroView, patch);
  store.data.macroView._updatedAt = store._now();
  store.save();
}
function setMacroGroup(k) { macroSaveView({ macroGroup: k }); renderMacro(); }
function setMacroCard(k) {
  const card = Object.assign({}, (store.data.macroView || {}).macroCard || {});
  card[macroGroupKey()] = k;
  macroSaveView({ macroCard: card });
  renderMacro();
}
function setMacroPeriod(p) { macroSaveView({ macroPeriod: p }); renderMacro(); }
function toggleMacroCompare(sym) {
  const cur = macroCompare();
  const next = cur.includes(sym) ? cur.filter(s => s !== sym) : cur.concat(sym);
  const m = Object.assign({}, (store.data.macroView || {}).macroCompare || {});
  if (next.length) m[macroCompareKey()] = next; else delete m[macroCompareKey()];
  macroSaveView({ macroCompare: m });
  renderMacro();
}

// ---- 取得 ----
// FRED系列は /api/macro（12件ずつ）、指数・為替は /api/history（1銘柄1回）から取得する。
// 「更新」ボタン＋タブ初回＋1日1回の自動取得で走る。
async function macroRefresh(opts) {
  const quiet = !!(opts && opts.quiet);   // 起動時の裏取得はトーストを出さない
  if (macroBusy) return;
  macroBusy = true;
  if (currentView === 'macro') renderMacro();
  const srcOf = (id) => MACRO_SERIES[id].src || 'fred';
  const fredIds = Object.keys(MACRO_SERIES).filter(id => srcOf(id) === 'fred');
  const idxIds = Object.keys(MACRO_SERIES).filter(id => srcOf(id) === 'idx');
  const estatIds = Object.keys(MACRO_SERIES).filter(id => srcOf(id) === 'estat');
  const batches = [];
  for (let i = 0; i < fredIds.length; i += 12) batches.push(fredIds.slice(i, i + 12));
  let ok = 0, ng = 0, err = null;
  try {
    for (const b of batches) {
      const res = await fetch('/api/macro?ids=' + encodeURIComponent(b.join(',')));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      const at = (d && d.at) || new Date().toISOString();
      store.data.macro ||= {};
      for (const id of b) {
        const s = d && d.series && d.series[id];
        if (s && Array.isArray(s.obs) && s.obs.length) {
          // 取得「前」の最終観測日と比べて、新しい観測が入った時だけ更新情報に積む
          const prev = store.data.macro[id];
          const prevLast = (prev && prev.obs && prev.obs.length) ? prev.obs[prev.obs.length - 1][0] : null;
          updNoteMacro(id, prevLast, s.obs, s.freq);
          store.data.macro[id] = { obs: s.obs, freq: s.freq || '', at }; ok++;
        } else ng++;
      }
    }
  } catch (e) { err = e; ng += fredIds.length - ok; }
  // 指数・為替(Yahoo)と日本CPI(e-Stat)は別APIなので、FREDが失敗しても互いを巻き込まない
  const others = await Promise.all([
    ...idxIds.map(sym => macroFetchIndex(sym).then(() => true).catch(() => false)),
    ...estatIds.map(id => macroFetchEstat(id).then(() => true).catch(() => false)),
  ]);
  ok += others.filter(Boolean).length;
  ng += others.filter(v => !v).length;
  // 1件でも取れたらその日の自動取得は済み扱い（全滅した日は翌回のタブ表示でまた試す）。
  // ★これは自動書き込みなので settings には入れない（settings._updatedAt を押し上げると
  //   他端末の設定変更を巻き戻す。ルール7-2）。独立キー＋max マージにしてある。
  if (ok) store.data.lastMacroDate = todayJst();
  store.save();
  macroBusy = false;
  if (!quiet) {
    if (err && !ok) toast('マクロ指標の取得に失敗: ' + ((err && err.message) || err), 4000);
    else toast(ng ? `マクロ指標を更新（${ok}件成功・${ng}件失敗）` : `マクロ指標を更新しました（${ok}件）`);
  }
  if (currentView === 'macro') renderMacro();
}
// 指数・為替1銘柄を Yahoo（/api/history）から取得し、FRED系列と同じ形 [[YYYY-MM-DD, 値], ...] にして保存する。
// 10年ぶんの日足はそのままだと約2,500点あるので、サーバー側と同じ方式で320点に間引く（同期対象の肥大防止）。
async function macroFetchIndex(sym) {
  const res = await fetch(`/api/history?symbol=${encodeURIComponent(sym)}&range=10y&interval=1d`);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const d = await res.json();
  const pts = (d && d.points) || [];
  const obs = [];
  for (const [t, v] of pts) {
    if (typeof v !== 'number' || !isFinite(v)) continue;
    obs.push([new Date(t * 1000).toISOString().slice(0, 10), v]);
  }
  if (!obs.length) throw new Error('データなし (' + sym + ')');
  store.data.macroIdx ||= {};
  store.data.macroIdx[sym] = { obs: macroThin(obs), freq: '日次', at: new Date().toISOString() };
}
// 日本CPI1系列を e-Stat（/api/estat）から取得。返る形は /api/macro と同じなのでそのまま store.data.macro へ。
async function macroFetchEstat(id) {
  const q = (MACRO_SERIES[id] || {}).estat;
  if (!q) throw new Error('e-Stat の取得条件が未定義 (' + id + ')');
  const p = new URLSearchParams({ op: 'data', id: q.id });
  for (const [k, v] of Object.entries(q)) if (k !== 'id') p.set(k, v);
  const res = await fetch('/api/estat?' + p.toString());
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.error) throw new Error(d.error || ('HTTP ' + res.status));
  if (!Array.isArray(d.obs) || !d.obs.length) throw new Error('データなし (' + id + ')');
  store.data.macro ||= {};
  const prev = store.data.macro[id];
  const prevLast = (prev && prev.obs && prev.obs.length) ? prev.obs[prev.obs.length - 1][0] : null;
  updNoteMacro(id, prevLast, d.obs, d.freq);
  store.data.macro[id] = { obs: d.obs, freq: d.freq || '', at: new Date().toISOString() };
}
// 直近200点はそのまま残し、それ以前を等間隔に間引いて全体を320点以内にする（functions/api/macro.js と同じ規則）
function macroThin(obs) {
  const MAX = 320, RECENT = 200;
  if (obs.length <= MAX) return obs;
  const recent = obs.slice(obs.length - RECENT);
  const older = obs.slice(0, obs.length - RECENT);
  const want = MAX - RECENT, step = older.length / want;
  const out = [];
  for (let i = 0; i < want; i++) out.push(older[Math.floor(i * step)]);
  out[0] = older[0];
  return out.concat(recent);
}

// ---- 値の変換・取り出し ----
// 生の観測列 [[date,value],...] を系列定義の tf に従って表示用の点列に変換する。
// yoy: 約1年前の観測に対する変化率%（日付でいちばん近い過去の点を探す）/ diff: 直前の点との差
function macroPoints(id) {
  const def = MACRO_SERIES[id]; if (!def) return [];
  const store_ = def.src === 'idx' ? (store.data.macroIdx || {}) : (store.data.macro || {});
  const raw = (store_[id] || {}).obs || [];
  if (!raw.length) return [];
  if (def.tf === 'diff') {
    const out = [];
    for (let i = 1; i < raw.length; i++) out.push([raw[i][0], raw[i][1] - raw[i - 1][1]]);
    return out;
  }
  if (def.tf === 'yoy') {
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const prev = macroAtBefore(raw, raw[i][0], 365, 60);
      if (prev && prev[1]) out.push([raw[i][0], (raw[i][1] / prev[1] - 1) * 100]);
    }
    return out;
  }
  return raw.slice();
}
// pts の中から「date より days 日前」に最も近い点を返す（許容 tol 日）。見つからなければ null。
function macroAtBefore(pts, date, days, tol) {
  const target = Date.parse(date) - days * 86400000;
  let best = null, bestDiff = Infinity;
  for (let i = pts.length - 1; i >= 0; i--) {
    const diff = Math.abs(Date.parse(pts[i][0]) - target);
    if (diff < bestDiff) { bestDiff = diff; best = pts[i]; }
    if (Date.parse(pts[i][0]) < target - tol * 86400000) break;
  }
  return (best && bestDiff <= tol * 86400000) ? best : null;
}
// 2系列の相関係数（ピアソン）。頻度が違う（CPI=月次 / 日経=日次）ので、点の少ない方の各日付に対して
// 「その日以前で最も新しい相手の値」を当てて対にする。共通期間に10点以上ある時だけ返す。
function macroCorr(a, b) {
  const base = a.length <= b.length ? a : b, other = a.length <= b.length ? b : a;
  const xs = [], ys = [];
  let j = 0;
  for (const [d, v] of base) {
    while (j + 1 < other.length && other[j + 1][0] <= d) j++;
    if (other[j][0] > d) continue;   // 相手のデータが始まる前
    xs.push(v); ys.push(other[j][1]);
  }
  const n = xs.length;
  if (n < 10) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}
function macroCut(pts, period) {
  if (period === 'all' || !pts.length) return pts;
  const yrs = { '1y': 1, '3y': 3, '5y': 5, '10y': 10 }[period] || 5;
  const cut = new Date(); cut.setFullYear(cut.getFullYear() - yrs);
  const cs = cut.toISOString().slice(0, 10);
  const out = pts.filter(p => p[0] >= cs);
  return out.length >= 2 ? out : pts.slice(-2);
}
function macroFmt(v, id) {
  if (v == null || !isFinite(v)) return '—';
  const def = MACRO_SERIES[id] || {};
  const dec = def.dec == null ? 2 : def.dec;
  return Number(v).toLocaleString('ja-JP', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function macroUnit(id) { const u = (MACRO_SERIES[id] || {}).unit || ''; return u ? `<span class="muted" style="font-size:12px;font-weight:500"> ${esc(u)}</span>` : ''; }
// 変化の色: 系列ごとの good（望ましい方向）に沿って動いていれば pos、逆なら neg。
// 「良い/悪い」の断定ではなく、景気・金融環境にとっての向きを色で見分けるための補助。
function macroDeltaCls(d, id) {
  if (d == null || !isFinite(d) || d === 0) return '';
  const good = (MACRO_SERIES[id] || {}).good;
  if (!good) return '';
  return ((d > 0) === (good === 'up')) ? 'pos' : 'neg';
}
// 「同じマイナスなのに指標によって緑だったり赤だったりする」のが分かりにくい、というすみぽん指摘
// （2026-08-13）への対応。色のルール（緑＝望ましい向き）は変えず、その向きを指標名の横に明示して
// 色が反転する理由を読み取れるようにする。↓良＝下がるほど追い風 / ↑良＝上がるほど追い風。
function macroGoodMark(id) {
  const good = (MACRO_SERIES[id] || {}).good;
  if (!good) return '';
  const down = good === 'down';
  return `<span class="macro-good" title="${down ? '下がる' : '上がる'}ほど景気・相場にとって追い風とされる指標。緑＝この向きに動いた、赤＝逆向き">${down ? '↓' : '↑'}良</span>`;
}
// 変化の数値に付けるツールチップ（なぜこの色なのかを言葉でも出す）
function macroDeltaTitle(d, id) {
  const def = MACRO_SERIES[id] || {};
  if (d == null || !isFinite(d) || !def.good || d === 0) return '';
  const tail = ((d > 0) === (def.good === 'up')) ? '追い風' : '向かい風';
  return `${def.label}は${def.good === 'down' ? '下がる' : '上がる'}ほど追い風とされる指標。この変化は${tail}の向き`;
}

// ---- 描画 ----
function renderMacro() {
  if (currentView !== 'macro') return;
  const cache = store.data.macro || {};
  const gotAny = Object.keys(cache).length > 0;
  const g = macroGroupDef();
  const cardKey = macroCardKey();
  const period = macroPeriod();
  const ats = Object.values(cache).concat(Object.values(store.data.macroIdx || {}))
    .map(c => c && c.at).filter(Boolean).sort();
  const fetchedAt = ats.length ? ats[ats.length - 1] : '';

  // 未取得ならセッション中1回だけ自動で取りに行く（以後は「更新」ボタンのみ。FREDの更新は日次〜四半期）。
  // ★_macroTried が無いと「取得失敗→再描画→また自動取得」で無限リトライになる（取得失敗時に実際に発生）。
  // 未取得なら初回、取得済みでも日付が変わっていれば1日1回だけ自動で取り直す（手動「更新」は常に可）。
  // ★_macroTried が無いと「取得失敗→再描画→また自動取得」で無限リトライになる（取得失敗時に実際に発生）。
  const stale = gotAny && store.data.lastMacroDate !== todayJst();
  if ((!gotAny || stale) && !macroBusy && !_macroTried) { _macroTried = true; macroRefresh(); }

  const groupSeg = `<div class="seg">${MACRO_GROUPS.map(x => `<button class="${x.key === g.key ? 'active' : ''}" onclick="setMacroGroup('${x.key}')">${esc(x.label)}</button>`).join('')}</div>`;
  const periodSeg = `<div class="seg">${MACRO_PERIODS.map(([v, l]) => `<button class="${period === v ? 'active' : ''}" onclick="setMacroPeriod('${v}')">${l}</button>`).join('')}</div>`;
  // 比較（ニュースの開示トグルと同じ見た目）。選択は指標（カード）ごとに保持される
  const cmp = macroCompare();
  const cmpSeg = `<div class="seg seg-toggle" style="flex-basis:100%;flex-wrap:wrap">
    <span class="muted" style="align-self:center;font-size:11px;margin-right:2px" title="選んだ指数を今のグラフに重ねます。選択は指標ごとに保存されます。比較中は各系列を自分の値域で0〜100に正規化し、動きの形とタイミングを比べます">比較:</span>
    ${MACRO_COMPARE.map(s => `<button class="${cmp.includes(s) ? 'active' : ''}" onclick="toggleMacroCompare('${jsq(s)}')">${esc((MACRO_SERIES[s] || {}).label || s)}</button>`).join('')}</div>`;

  // カード（クリックでグラフの対象を切替）。見出し数値＝ids[0] の最新値、下段に前回比と観測日
  const cardsHtml = g.cards.map(c => {
    const id = c.ids[0];
    const pts = macroPoints(id);
    const last = pts.length ? pts[pts.length - 1] : null;
    const prev = pts.length >= 2 ? pts[pts.length - 2] : null;
    const d = (last && prev) ? last[1] - prev[1] : null;
    const dec = (MACRO_SERIES[id] || {}).dec ?? 2;
    return `<div class="card macro-card ${c.key === cardKey ? 'sel' : ''}" onclick="setMacroCard('${c.key}')" title="${esc(c.note || '')}">
      <div class="label">${esc(c.label)}${macroGoodMark(id)}</div>
      <div class="value">${last ? macroFmt(last[1], id) : '—'}${macroUnit(id)}</div>
      <div class="sub"><span class="${macroDeltaCls(d, id)}" title="${esc(macroDeltaTitle(d, id))}">${d == null ? '—' : (d > 0 ? '+' : '') + Number(d).toFixed(dec)}</span>
        <span class="muted">前回比 ・ ${last ? esc(last[0]) : '—'}</span></div>
    </div>`;
  }).join('');

  // 表: グループ内の全系列 × 直近の推移（頻度が違う系列が混ざるので「n期前」で揃える）
  const ids = [...new Set(g.cards.flatMap(c => c.ids))];
  const rows = ids.map(id => {
    const def = MACRO_SERIES[id];
    const pts = macroPoints(id);
    const last = pts.length ? pts[pts.length - 1] : null;
    const at = (n) => (pts.length > n ? pts[pts.length - 1 - n][1] : null);
    const y1 = last ? macroAtBefore(pts, last[0], 365, 60) : null;
    const dy = (last && y1) ? last[1] - y1[1] : null;
    const freq = ((store.data.macro || {})[id] || {}).freq || '';
    return `<tr>
      <td class="l">${esc(def.label)}<span class="muted" style="font-size:11px"> ${esc(def.unit || '')}</span>${macroGoodMark(id)}</td>
      <td class="c muted" style="font-size:11px">${esc(freq)}</td>
      <td class="r"><b>${macroFmt(last && last[1], id)}</b></td>
      <td class="c muted" style="font-size:11px">${last ? esc(last[0]) : '—'}</td>
      <td class="r">${macroFmt(at(1), id)}</td>
      <td class="r">${macroFmt(at(2), id)}</td>
      <td class="r">${macroFmt(at(3), id)}</td>
      <td class="r">${macroFmt(y1 && y1[1], id)}</td>
      <td class="r ${macroDeltaCls(dy, id)}" title="${esc(macroDeltaTitle(dy, id))}">${dy == null ? '—' : (dy > 0 ? '+' : '') + Number(dy).toFixed(def.dec ?? 2)}</td>
    </tr>`;
  }).join('');

  const card = macroCardDef();
  app.innerHTML = `
    <div class="section">
      <div class="section-head"><h2>マクロ指標</h2>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="muted" style="font-size:11px">${fetchedAt ? '取得：' + mktFetchedAt(fetchedAt) : ''}</span>
          <button class="btn btn-sm" onclick="openMacroAlerts()" title="指標が基準値を抜けたら知らせる設定">基準値・警告${macroFiredAlerts().length ? `（${macroFiredAlerts().length}）` : ''}</button>
          <button class="btn btn-sm btn-primary" onclick="macroRefresh()" ${macroBusy ? 'disabled' : ''}>${macroBusy ? '取得中…' : '更新'}</button>
        </div></div>
      <div class="toolbar" style="border:none;padding:10px 16px 0;gap:8px;flex-wrap:wrap">${groupSeg}${periodSeg}${cmpSeg}</div>
      <div class="section-body" style="padding:12px 16px 16px">
        <div class="cards macro-cards">${cardsHtml}</div>
        <div id="macro-chart"></div>
        <div class="muted" style="font-size:11px;margin:6px 2px 0" id="macro-chart-note">${cmp.length
          ? `<b>比較中</b>: 指標は<b>左軸（実線）</b>、比較の指数は<b>右軸（破線）</b>で実際の値のまま重ねています。凡例の <b>r</b> は基準系列との相関係数。${cmp.length >= 2 ? '<span class="neg">指数を2つ以上選ぶと右軸は「起点=100」の指数表示に切り替わります（実値のままだと片方が潰れて読めないため。実値は凡例とカーソルで確認できます）。</span>' : ''}`
          : esc(card.note || '')}</div>
        <div class="table-wrap macro-managed" style="margin-top:12px"><table class="list">
          <thead><tr><th class="l">指標</th><th class="c">頻度</th><th class="r">最新</th><th class="c">観測日</th>
            <th class="r">1期前</th><th class="r">2期前</th><th class="r">3期前</th><th class="r">1年前</th><th class="r">1年差</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <div class="muted" style="font-size:11px;margin-top:6px" title="変化の色は符号ではなく指標ごとの向きで付けています。例: CPI −0.2 はインフレ鈍化なので緑、失業率 −0.2 も雇用改善なので緑。逆に 非農業雇用 −87 は雇用の減速なので赤。数字の符号は増減そのものです。">
          色: <span class="pos">緑</span>＝望ましい向きに動いた／<span class="neg">赤</span>＝逆向き（<span class="macro-good">↓良</span>下がるほど追い風・<span class="macro-good">↑良</span>上がるほど追い風）。符号は増減そのもの。　${macroSrcNote(ids)}
        </div>
      </div>
    </div>`;
  renderMacroChart();
  scheduleFit();
}

// グラフ本体。カードの ids ＋「比較」で選んだ指数を折れ線で描く。
//
// ★2軸（左=指標の実値 / 右=指数の実値）にした理由（2026-08-13 すみぽん指示）:
//   最初は「起点=100の指数化」、次に「各系列を0〜100に正規化」を試したが、
//   前者は日経が+138%動く隣でCPI（1〜3%）が横一線になって見えず、
//   後者は形は比べられても**元の指標の実値がグラフから読めなくなる**。
//   比較で見たいのは「指数が暴落・回復したタイミングで指標がどう動いたか／相関があるか」なので、
//   実値を保ったまま両方の振れが見える2軸にする。
//   右軸に回すのは「比較で追加した指数」＋カードが right で指定した系列
//   （日経66,970とTOPIX連動ETF431のように、同じ軸に置くと片方が潰れる組み合わせ）。
function renderMacroChart() {
  const el = document.getElementById('macro-chart'); if (!el) return;
  // ★データなしで抜ける経路でも収まり調整（macroFitTable）を通すこと。
  //   通さないと表が縮まず、未取得の指標グループを開いた時にページがスクロールする（実測185px）。
  const bail = (msg) => { el.style.height = ''; el.innerHTML = `<div class="notice" style="margin:0">${msg}</div>`; macroFitTable(el); };
  const card = macroCardDef(), period = macroPeriod();
  const cmp = macroCompare();
  const ids = card.ids.concat(cmp.filter(s => !card.ids.includes(s)));
  const rightSet = new Set((card.right || []).concat(cmp));
  let series = ids.map((id, i) => ({
    id, label: (MACRO_SERIES[id] || {}).label || id, color: MACRO_COLORS[i % MACRO_COLORS.length],
    axis: rightSet.has(id) ? 'r' : 'l',
    pts: macroCut(macroPoints(id), period),
  })).filter(s => s.pts.length >= 2);
  // 比較指数は「指標（カード側）のデータがある期間」に切り詰める。指標が主役なので、
  // ハイイールドスプレッド等で指標の履歴が選択期間より短い時に、指数側の長い履歴へ
  // x軸を合わせると肝心の指標が右端の一部にしか描かれない（2026-08-25 すみぽん指摘）。
  const mains = series.filter(s => card.ids.includes(s.id));
  if (mains.length && series.length > mains.length) {
    const lo = mains.map(s => s.pts[0][0]).sort()[0];
    const hi = mains.map(s => s.pts[s.pts.length - 1][0]).sort().pop();
    for (const s of series) if (!card.ids.includes(s.id)) s.pts = s.pts.filter(p => p[0] >= lo && p[0] <= hi);
    series = series.filter(s => s.pts.length >= 2);
  }
  if (!series.length) { bail('この指標のデータがまだありません。「更新」で取得してください。'); return; }
  // 左軸の系列が全部未取得だった時は、右軸の系列を左へ寄せて1軸で描く（右軸だけのグラフにしない）
  if (!series.some(s => s.axis === 'l')) series.forEach(s => { s.axis = 'l'; });
  // 比較中は主系列（カードの1本目）との相関係数を出す。「相関があるか見たい」への直接の答え
  if (cmp.length && series.length >= 2) {
    const base = series[0];
    series.forEach((s, i) => { if (i > 0) s.corr = macroCorr(base.pts, s.pts); }); // 指数化は線形変換なので相関係数は変わらない
  }
  _macroNorm = { dual: series.some(s => s.axis === 'r') && series.some(s => s.axis === 'l'), cmp: cmp.length };
  // 高さは「暫定で描く→実レイアウトを測って描き直す」で決める。初回は表(.table-wrap)がまだ
  // 高さ0で測れることがあり、一発計算だと必ず大きすぎる値になるため（実測で 338px vs 正解 182px）。
  // 2〜3回で収束する。
  const w = Math.max(240, Math.round((el.clientWidth || 600) - 150)); // 凡例140＋gap10
  let h = 260;
  el.style.height = h + 'px';
  el.innerHTML = macroLineChart(series, w, h);
  for (let i = 0; i < 3; i++) {
    const t = macroChartFitH(el);
    if (Math.abs(t - h) <= 2) break;
    h = t;
    el.style.height = h + 'px';
    el.innerHTML = macroLineChart(series, w, h);
  }
  attachMacroHover(el, series);
  // 2軸は実値のまま重ねるだけなので、系列を除外することは無い（正規化方式のときに必要だった注記は廃止）
  macroFitTable(el);
}
// グラフを最小高さまで縮めてもまだ収まらない時は、**表を枠内スクロール**にして残りを吸収する（ルール6）。
// カード6枚＋7行の表＋ツールバー3段（グループ/期間/重ねる）が重なる「景気・雇用」で必要になる。
// 汎用の fitListTables は「縮めた結果160px未満になるなら何もしない」ため、ここで専用に詰める
// （この枠は .macro-managed を付けて fitListTables の対象から外してある＝二重管理を防ぐ）。
function macroFitTable(el) {
  const wrap = document.querySelector('#app .table-wrap.macro-managed');
  if (!wrap) return;
  wrap.style.maxHeight = '';
  const cont = el.closest('.content');
  if (!cont) return;
  const overflow = cont.scrollHeight - cont.clientHeight;
  if (overflow <= 1) return;
  const h = wrap.getBoundingClientRect().height;
  wrap.style.maxHeight = Math.max(88, Math.round(h - overflow)) + 'px';
}
// 今のレイアウトから「グラフに使ってよい高さ」を実測で求める。
// 収まり判定は main.content 基準（ルール6。document 基準は body:overflow:hidden で常に0になり誤判定する）。
// ★ main.content 自身の下パディング（実測53px）を引く。これを忘れると毎回その分だけページがスクロールする。
function macroChartFitH(el) {
  const cont = el.closest('.content');
  if (!cont) return 260;
  const limit = cont.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(cont).paddingBottom) || 0);
  const r = el.getBoundingClientRect();
  const sec = el.closest('.section');
  // グラフより下にあるもの（注記・表・出典・section下padding）の実高さ。中身が変わっても効くよう毎回測る。
  // section の margin-bottom は getBoundingClientRect に含まれないが scrollHeight には効くので足す
  // （これを落とすと毎回その分＝約16px はみ出したままになる）。
  let below = 0;
  if (sec) {
    below = Math.max(0, sec.getBoundingClientRect().bottom - (r.top + r.height))
      + (parseFloat(getComputedStyle(sec).marginBottom) || 0);
  }
  // 下限150px: ツールバー3段（グループ/期間/重ねる）＋カード2段＋7行の表が重なる「景気・雇用」では
  // 180pxだと収まらない。ここで足りない分は macroFitTable が表を枠内スクロールにして吸収する。
  return Math.max(140, Math.min(560, Math.round(limit - r.top - below - 4)));
}
function macroLineChart(series, W, H) {
  W = W || 800; H = H || 280;
  const L = series.filter(s => s.axis === 'l'), R = series.filter(s => s.axis === 'r');
  const dual = L.length > 0 && R.length > 0;
  const pad = { l: 54, r: dual ? 54 : 12, t: 10, b: 20 };
  const xs = series.flatMap(s => s.pts).map(p => Date.parse(p[0]) / 1000);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);

  // 軸ごとに独立したスケールを作る。左右で目盛り本数を揃えると横線が1組で済む。
  // ★目盛り幅は「データの範囲に収まる最小の切りのいい値」を探すこと。単純に niceStep 一発だと
  //   刻みが粗くなりすぎ、日経(1.4万〜6.7万)が 0〜100,000 の軸に描かれて振れが半分に潰れた（実測span44%）。
  const TICKS = 6;
  // 目盛り幅の候補（小さい順）。1/2/2.5/5 × 10^n。共有の niceStep より刻みが細かく、軸をデータに詰められる。
  const stepCands = (range) => {
    const out = [], m0 = Math.floor(Math.log10(Math.max(range, 1e-9))) - 3;
    for (let m = m0; m <= m0 + 6; m++) for (const f of [1, 2, 2.5, 5]) out.push(f * Math.pow(10, m));
    return out.sort((a, b) => a - b);
  };
  // extra = 軸に必ず収めたい値（基準値ライン）。データの範囲外に基準値があると線が引けず、
  // 期間を変えただけで設定した線が消えて見える（実測: コアPCEの基準2.0が5年表示の軸2.5〜6.0から外れて消えた）。
  const boundsOf = (list, extra) => {
    const vs = list.flatMap(s => s.pts).map(p => p[1]).concat(extra || []);
    let lo = Math.min(...vs), hi = Math.max(...vs);
    if (lo === hi) { lo -= 1; hi += 1; }
    return [lo, hi];
  };
  // 目盛り本数を targetN ちょうどにしつつ、軸をデータへ最も詰める（＝最小の刻みを選ぶ）。
  // ★左右で本数を揃える必要があるが、粗い方の軸を上に伸ばして合わせると軸が大きく余る
  //   （実測: ドル円100〜162に対し軸100〜240、振れが画面の35%まで潰れた）。
  //   伸ばすのではなく「本数が targetN に収まる最小の刻み」を選び直すこと。
  const scaleTo = (list, targetN, extra) => {
    const [lo0, hi0] = boundsOf(list, extra);
    for (const step of stepCands(hi0 - lo0)) {
      const lo = Math.floor(lo0 / step) * step;
      const n = Math.round((Math.ceil(hi0 / step) * step - lo) / step);
      if (n >= 1 && n <= targetN) return { lo, hi: lo + step * targetN, step, n: targetN };
    }
    const step = (hi0 - lo0) / targetN || 1;
    return { lo: lo0, hi: lo0 + step * targetN, step, n: targetN };
  };
  // 自然な本数を先に求め、左右の多い方に合わせる
  const naturalN = (list, extra) => {
    const [lo0, hi0] = boundsOf(list, extra);
    const step = niceStep(hi0 - lo0, TICKS);
    return Math.max(1, Math.round((Math.ceil(hi0 / step) * step - Math.floor(lo0 / step) * step) / step));
  };

  // 右軸に2系列以上ある時（例: 日経 66,970 と S&P500 7,752）は、実値のままだと片方が潰れて
  // 読めない（実測span4%）。指数どうしは「起点=100」で比べるのが標準的なので、右軸だけ指数化する。
  // 左軸＝指標は実値のままなので、「元の指標の値が読めない」問題は起きない。
  // ★この関数は収まり調整で同じ series を使って最大4回呼ばれる。s.raw が既にあるなら変換済みなので
  //   絶対に再変換しないこと（2回目以降で指数値をさらに指数化し、凡例の「実値」が壊れる。実測で
  //   日経の実値が 66,970 ではなく 396 と表示された）。
  const rIndexed = R.length >= 2;
  if (rIndexed) R.forEach(s => {
    if (s.raw) return;
    const base = s.pts.find(p => p[1] > 0);
    if (!base) return;
    s.raw = s.pts;
    s.pts = s.pts.map(p => [p[0], p[1] / base[1] * 100]);
  });

  const Lp = L.length ? L : series;
  // 左軸の系列に付いている基準値（実値の警告）は軸に必ず収める＝設定した線が期間によって消えないように
  const thrVals = macroAlerts()
    .filter(a => a.enabled !== false && a.mode === 'level' && isFinite(a.value) && Lp.some(x => x.id === a.seriesId))
    .map(a => a.value);
  const targetN = R.length ? Math.max(naturalN(Lp, thrVals), naturalN(R)) : naturalN(Lp, thrVals);
  const sl = scaleTo(Lp, targetN, thrVals);
  const sr = R.length ? scaleTo(R, targetN) : null;

  const px = t => pad.l + (xmax === xmin ? 0 : (t - xmin) / (xmax - xmin)) * (W - pad.l - pad.r);
  const pyOn = (sc) => (v) => pad.t + (1 - (v - sc.lo) / (sc.hi - sc.lo)) * (H - pad.t - pad.b);
  const pyl = pyOn(sl), pyr = sr ? pyOn(sr) : pyl;
  const py = (v, axis) => (axis === 'r' && sr) ? pyr(v) : pyl(v);

  const fmtTick = (v, list) => {
    const d = (MACRO_SERIES[(list[0] || {}).id] || {}).dec ?? 2;
    return Math.abs(v) >= 10000 ? Math.round(v).toLocaleString('ja-JP') : Number(v).toFixed(d);
  };
  // 横線は左軸の目盛り位置に引く（左右で本数を揃えてあるので右軸の目盛りとも一致する）
  let grid = '', ylab = '', yrlab = '';
  const lColor = (L[0] || series[0]).color, rColor = (R[0] || {}).color;
  for (let i = 0; i <= sl.n; i++) {
    const v = sl.lo + sl.step * i, y = pyl(v).toFixed(1);
    grid += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="rgba(100,116,139,.25)"/>`;
    ylab += `<text x="${pad.l - 6}" y="${(+y + 3).toFixed(1)}" fill="${dual ? lColor : 'var(--muted)'}" font-size="10" text-anchor="end">${fmtTick(v, L.length ? L : series)}</text>`;
    if (sr) {
      const rv = sr.lo + sr.step * i;
      yrlab += `<text x="${W - pad.r + 6}" y="${(+y + 3).toFixed(1)}" fill="${rIndexed ? 'var(--muted)' : rColor}" font-size="10" text-anchor="start">${rIndexed ? Math.round(rv) : fmtTick(rv, R)}</text>`;
    }
  }
  // ゼロ線（SLOOS・イールドカーブ差・前年比などは「0をまたぐか」が意味を持つので濃く引く）
  const zero = (sl.lo < 0 && sl.hi > 0)
    ? `<line x1="${pad.l}" y1="${pyl(0).toFixed(1)}" x2="${W - pad.r}" y2="${pyl(0).toFixed(1)}" stroke="var(--muted)" stroke-width="1.4"/>` : '';
  // 基準値の水平線。**実値(level)の警告だけ**描く（前期差・1年差は「差」なので値の軸には乗らない）。
  // 左軸に出ている系列のものだけ。軸の外なら描かない（枠外に線が出るため）。
  let thresholds = '';
  for (const a of macroAlerts()) {
    if (a.enabled === false || a.mode !== 'level') continue;
    if (!L.some(x => x.id === a.seriesId)) continue;
    if (a.value < sl.lo || a.value > sl.hi) continue;   // 保険（上で軸に含めているので通常は通る）
    const y = pyl(a.value).toFixed(1);
    const st = macroAlertState(a);
    const col = (st && st.fired) ? 'var(--red)' : 'var(--amber)';
    thresholds += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="${col}" stroke-width="1.2" stroke-dasharray="6 4"/>`
      + `<text x="${W - pad.r - 4}" y="${(+y - 4).toFixed(1)}" fill="${col}" font-size="9" text-anchor="end">基準 ${macroFmt(a.value, a.seriesId)}</text>`;
  }
  // X軸: 年初を等間隔に間引いて表示（データ位置ではなく時間軸で等間隔）
  let xlab = '';
  { const y0 = new Date(xmin * 1000).getUTCFullYear(), y1 = new Date(xmax * 1000).getUTCFullYear();
    const years = []; for (let y = y0; y <= y1; y++) years.push(Date.UTC(y, 0, 1) / 1000);
    const st = Math.max(1, Math.ceil(years.length / 8));
    years.forEach((t, i) => {
      if (i % st || t < xmin || t > xmax) return;
      const x = px(t).toFixed(1);
      xlab += `<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${H - pad.b}" stroke="rgba(100,116,139,.18)" stroke-dasharray="2 3"/>`
        + `<text x="${x}" y="${H - pad.b + 14}" fill="var(--muted)" font-size="9" text-anchor="middle">${new Date(t * 1000).getUTCFullYear()}</text>`;
    });
  }
  // 右軸の系列は破線にして、線だけでもどちらの軸か分かるようにする（色覚に依存させない）
  const lines = series.map(s => {
    const d = s.pts.map((p, i) => (i ? 'L' : 'M') + px(Date.parse(p[0]) / 1000).toFixed(1) + ' ' + py(p[1], s.axis).toFixed(1)).join(' ');
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.6" stroke-linejoin="round"${(dual && s.axis === 'r') ? ' stroke-dasharray="5 3"' : ''}/>`;
  }).join('');
  const legend = series.map((s, i) => {
    const src = s.raw || s.pts;                       // 右軸を指数化していても凡例は実値
    const last = src[src.length - 1];
    const chg = s.raw ? s.pts[s.pts.length - 1][1] - 100 : null;
    const axisTag = dual ? `<span class="macro-axis" title="${s.axis === 'r' ? '右軸（破線）' : '左軸（実線）'}の目盛りで描いています">${s.axis === 'r' ? '右' : '左'}</span>` : '';
    let extra = '';
    if (s.corr != null) extra = ` <span title="この期間の水準どうしの相関係数。+1に近いほど同じ向き、−1に近いほど逆向きに動いた。どちらも上昇トレンドというだけで高く出ることがあるので、因果関係の証拠にはなりません">r=${s.corr.toFixed(2)}</span>`;
    else if (i === 0 && series.some(x => x.corr != null)) extra = ` <span class="muted" title="この系列を基準に相関係数を計算しています">基準</span>`;
    const chgTag = chg == null ? '' : ` <span class="${chg > 0 ? 'pos' : chg < 0 ? 'neg' : ''}" title="期間の起点からの変化率">${(chg > 0 ? '+' : '') + chg.toFixed(0)}%</span>`;
    return `<div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:6px;font-size:11px">
      <span style="width:11px;height:11px;flex:0 0 11px;background:${s.color};border-radius:2px;margin-top:2px"></span>
      <span style="min-width:0"><span style="word-break:break-all">${esc(s.label)}</span>${axisTag}<br><b class="num">${macroFmt(last[1], s.id)}</b>${chgTag}${extra}</span></div>`;
  }).join('');
  const guide = `<line id="macro-guide" x1="0" y1="${pad.t}" x2="0" y2="${H - pad.b}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>`;
  _macroHover = { series, px, W, H, pad, xmin, xmax };
  return `<div style="display:flex;gap:10px;align-items:flex-start">
    <div style="flex:1;min-width:0;position:relative">
      <svg id="macro-svg" viewBox="0 0 ${W} ${H}" width="100%" style="display:block;background:var(--panel);border:1px solid var(--border);border-radius:8px;cursor:crosshair">${grid}${xlab}${zero}${thresholds}${lines}${ylab}${yrlab}${guide}</svg>
      <div id="macro-tip" style="position:absolute;display:none;pointer-events:none;z-index:5;top:8px;background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:7px 9px;font-size:11px;line-height:1.5;box-shadow:0 2px 10px rgba(0,0,0,.18);white-space:nowrap"></div>
    </div>
    <div style="flex:0 0 140px;width:140px">${legend}</div>
  </div>`;
}
let _macroHover = null;
// カーソル位置の日付と各系列の値をツールチップ表示（その日以前で最新の観測値を拾う）
function attachMacroHover(host, series) {
  const svg = host.querySelector('#macro-svg'), tip = host.querySelector('#macro-tip'), guide = host.querySelector('#macro-guide');
  if (!svg || !tip || !guide) return;
  const move = (ev) => {
    const st = _macroHover; if (!st) return;
    const r = svg.getBoundingClientRect();
    const cx = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) / r.width * st.W;
    if (cx < st.pad.l || cx > st.W - st.pad.r) { tip.style.display = 'none'; guide.style.display = 'none'; return; }
    const t = st.xmin + (cx - st.pad.l) / (st.W - st.pad.l - st.pad.r) * (st.xmax - st.xmin);
    const date = new Date(t * 1000).toISOString().slice(0, 10);
    const rows = series.map(s => {
      const src = s.raw || s.pts;                     // 右軸を指数化していてもツールチップは実値
      let hit = null;
      for (let i = src.length - 1; i >= 0; i--) { if (src[i][0] <= date) { hit = src[i]; break; } }
      if (!hit) hit = src[0];
      return `<div><span style="display:inline-block;width:9px;height:9px;background:${s.color};border-radius:2px;margin-right:5px"></span>${esc(s.label)} <b>${macroFmt(hit[1], s.id)}</b> <span class="muted">${esc(hit[0])}</span></div>`;
    }).join('');
    guide.setAttribute('x1', cx.toFixed(1)); guide.setAttribute('x2', cx.toFixed(1)); guide.style.display = '';
    tip.innerHTML = rows;
    tip.style.display = 'block';
    // カーソルが右寄りならツールチップを左に出す（枠外へはみ出さないように）
    const leftPx = (cx / st.W) * r.width;
    tip.style.left = (leftPx > r.width * 0.6 ? Math.max(4, leftPx - tip.offsetWidth - 12) : leftPx + 12) + 'px';
  };
  const leave = () => { tip.style.display = 'none'; guide.style.display = 'none'; };
  svg.addEventListener('mousemove', move);
  svg.addEventListener('mouseleave', leave);
  svg.addEventListener('touchmove', move, { passive: true });
  svg.addEventListener('touchend', leave);
}

function renderNews() {
  if (currentView !== 'news') return;
  newsPinCatSession(); // 開いた時点のカテゴリ選択を固定（裏の同期で勝手に切り替わらないように）
  const cache = newsPoolCache(); // 同期済みプールから表示（タブを開いてもニュースサイトへは取りに行かない）
  if (_newsSeenMark === null) _newsSeenMark = (cache && cache.at) || ''; // セッション初回表示＝「開き直し」（それ以前の黄は青へ）
  const read = store.data.newsRead || {};
  const hidden = store.data.newsHidden || {};
  const hiddenN = Object.keys(hidden).length;
  let body, seg;
  if (newsShowHidden) {
    // 非表示一覧（復元用）。非表示にした記事だけを新しい順で表示、各行「戻す」
    seg = `<button class="btn btn-sm" onclick="toggleNewsHiddenView()">${svgIcon('external', '')} 一覧に戻る</button>
      ${hiddenN ? `<button class="btn btn-sm" style="margin-left:auto" onclick="newsUnhideAll()">すべて解除</button>` : ''}`;
    const hitems = (cache ? cache.items : []).filter(it => hidden[it.link])
      .sort((a, b) => (b.pubDate || '') < (a.pubDate || '') ? -1 : 1);
    body = hitems.length
      ? `<div class="table-wrap news-wrap"><div class="news-list">${hitems.map(it => newsItemHtml(it, read, newsMatchSecs(it), { restore: true })).join('')}</div></div>`
      : '<div class="empty">非表示にした記事はありません。<br><span class="muted">（このセッションの取得分のうち非表示中のものを表示します）</span></div>';
  } else {
    // カテゴリは複数選択トグル（クリックで即切替＝設定モーダル不要）。「すべて」で全表示
    const catSeg = `<div class="seg seg-toggle"><button class="${newsAllCatsShown() ? 'active' : ''}" onclick="newsToggleCat('all')">すべて</button>${NEWS_REAL_CATS.map(v => { const l = (NEWS_CATS.find(c => c[0] === v) || [])[1]; return `<button class="${newsCatShown(v) ? 'active' : ''}" onclick="newsToggleCat('${v}')">${l}</button>`; }).join('')}</div>`;
    // 開示の細分類も複数選択トグル（プールに存在する種類だけ・別行）
    const dts = newsPresentDiscTypes();
    const discSeg = dts.length ? `<div class="seg seg-toggle" style="flex-basis:100%;flex-wrap:wrap">
      <span class="muted" style="align-self:center;font-size:11px;margin-right:2px">開示:</span>
      <button class="${dts.every(newsDiscTypeShown) ? 'active' : ''}" onclick="newsToggleDiscType('all')">すべて</button>
      ${dts.map(id => `<button class="${newsDiscTypeShown(id) ? 'active' : ''}" onclick="newsToggleDiscType('${jsq(id)}')">${esc(disclosureGroupLabel(id))}</button>`).join('')}</div>` : '';
    seg = `${catSeg}
      <div class="seg">${NEWS_MKTS.map(([v, l]) => `<button class="${newsMkt === v ? 'active' : ''}" onclick="setNewsMkt('${v}')" title="関連銘柄の市場で絞り込み">${l}</button>`).join('')}</div>
      <div class="seg">${NEWS_DAYS.map(([v, l]) => `<button class="${newsDays === v ? 'active' : ''}" onclick="setNewsDays(${v})" title="この期間に配信された記事のみ">${l}</button>`).join('')}</div>
      <div class="seg"><button class="${newsHeldOnly ? 'active' : ''}" onclick="setNewsHeldOnly(${newsHeldOnly ? 'false' : 'true'})" title="保有銘柄・注目タグに関連しない一般ニュースを除外。銘柄フィルタとAND">一般ニュース除外</button></div>
      <span title="保有銘柄と同じ条件で銘柄を絞り込む。一般ニュースは残る（一般ニュースの除外は「保有・注目のみ」と併用）">${filterBtnHtml('news')}</span>
      <button class="btn btn-sm" onclick="openNewsTagsEditor()" title="保有していない企業・人物・テーマ名で色付けする">${svgIcon('filter', '')} 注目タグ</button>
      ${discSeg}
      <div id="flt-host-news" style="flex-basis:100%">${fltState.news.open ? filterPanelHtml('news') : ''}</div>`;
    if (!cache) {
      body = newsBusy ? '<div class="empty">読み込み中…</div>' : '<div class="empty">まだ取得していません。右上の「更新」ボタンで取得します。</div>';
    } else {
      const entries = _newsCurrentEntries();
      body = entries.length
        ? `<div class="table-wrap news-wrap"><div class="news-list">${entries.map(([it, ms]) => newsItemHtml(it, read, ms)).join('')}</div></div>`
        : '<div class="empty">記事がありません。「更新」で再取得できます。</div>';
    }
  }
  const unreadN = cache ? cache.items.filter(it => !read[it.link] && !hidden[it.link]).length : 0;
  // ヘッダ右のアクション。非表示ボタン・一括非表示
  const headActions = newsShowHidden ? '' : `
    <button class="btn btn-sm" id="news-hidden-btn" onclick="toggleNewsHiddenView()" title="非表示にした記事を確認・復元">非表示${hiddenN ? ` ${hiddenN}` : ''}</button>`;
  app.innerHTML = `
    <div class="section">
      <div class="section-head"><h2>${newsShowHidden ? '非表示の記事' : 'マーケットニュース'}<span class="news-unread-n" id="news-unread-badge">${!newsShowHidden && unreadN ? `未読 ${unreadN}` : ''}</span></h2>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ${headActions}
          <span class="muted" style="font-size:11px">${cache && cache.at ? '取得：' + mktFetchedAt(cache.at) : ''}</span>
          <button class="btn btn-sm btn-primary" onclick="newsRefresh()" ${newsBusy ? 'disabled' : ''}>${newsBusy ? '取得中…' : '更新'}</button></div></div>
      <div class="toolbar" style="border:none;padding:10px 16px 0;gap:8px;flex-wrap:wrap">${seg}</div>
      <div class="section-body" style="padding:12px 16px 16px">${body}</div>
    </div>`;
  scheduleFit(); // 一覧を枠内スクロールに（ページ全体をスクロールさせない）
  initNewsDragScroll(); // ドラッグでスクロール（初回のみ設定）
  // 記事の取得は「更新」ボタン押下時のみ（2026-07-23 すみぽん要望）。
  // 旧: タブを開くと自動取得＋キャッシュ5分超で裏更新→「開いたら勝手に更新される」ため廃止。
  // 手持ちキャッシュの翻訳・要約の裏処理（下2行）は通信済みデータの加工なので従来どおり動かす。
  if (cache) newsTranslatePending(); // 英語記事の未翻訳分を裏で翻訳→完了後に再描画（非同期・多重起動はガード済み）
  if (cache) newsAutoSummarizeVideos(); // 新着動画の要約を裏で先に生成（設定ONのとき・多重起動ガード済み）
}

// 購読YouTubeチャンネルの新着動画をニュース一覧アイテム化（カテゴリ=動画）。要約があればdescに載せる（後でGemini）。
async function _newsVideos() {
  const chs = ytChannelList().map(c => String(c.id || '').trim()).filter(id => /^UC[\w-]{20,}$/.test(id));
  if (!chs.length) return [];
  let vids = [];
  try {
    const res = await fetch('/api/youtube?max=6&channels=' + encodeURIComponent(chs.join(',')));
    const d = await res.json();
    if (d && Array.isArray(d.items)) vids = d.items;
  } catch (_) { return []; }
  const sums = store.data.ytSummaries || {};
  return vids.map(v => {
    const hasSum = !!(sums[v.videoId] && sums[v.videoId].summary);
    return {
      title: v.title, link: v.link, pubDate: v.published, source: v.channel || 'YouTube',
      cat: 'video', videoId: v.videoId, channelId: v.channelId, thumb: v.thumb,
      desc: hasSum ? sums[v.videoId].summary : undefined, // 要約があれば本文に（パネル表示・翻訳不要）
      // 要約前の英語動画は見出しを翻訳対象に（要約と翻訳の併用）。要約後は日本語の見出し/要約を使うため対象外。
      lang: (!hasSum && v.title && !/[぀-ヿ㐀-鿿]/.test(v.title)) ? 'en' : undefined,
    };
  });
}
// 登録JP銘柄の適時開示（TDnet）をまとめて取得し、ニュース一覧アイテム化して返す。
// 保有銘柄ごとに直近開示を引くので「直近全社120件に入っていない銘柄」も漏れなく出る。
async function _newsDiscForHoldings() {
  const secs = store.data.securities.filter(s => s.enabled !== false);
  const jpCodes = [...new Set(secs.filter(s => s.market === 'JP').map(s => String(s.ticker || '').trim()).filter(c => /^[0-9A-Za-z]{4}$/.test(c)))].slice(0, 40);
  const usTickers = [...new Set(secs.filter(s => s.market === 'US').map(s => String(s.ticker || '').trim().toUpperCase()).filter(t => /^[A-Z.\-]{1,8}$/.test(t)))].slice(0, 12);
  const jobs = [];
  // 日本株: TDnetをまとめて1リクエスト（銘柄別に直近5件）
  if (jpCodes.length) jobs.push(fetch('/api/disclosure?per=5&codes=' + encodeURIComponent(jpCodes.join(','))).then(r => r.json()).then(d => (d.items || []).map(x => ({ ...x, market: 'JP' }))).catch(() => []));
  // 米国株: EDGARは銘柄ごとに取得（並行・件数上限）
  for (const t of usTickers) jobs.push(fetch('/api/disclosure?market=US&ticker=' + encodeURIComponent(t)).then(r => r.json()).then(d => (d.items || []).slice(0, 4)).catch(() => []));
  const arrs = await Promise.all(jobs);
  return [].concat(...arrs).map(d => ({
    title: d.title, link: discLink(d), pubDate: d.pubDate, source: d.market === 'US' ? 'SEC EDGAR' : '適時開示',
    code: d.code, company: d.company, // 銘柄チップ表示用（コードで登録銘柄に紐付く）
    cat: d.kind === 'earnings' ? 'earnings' : 'disclosure',
  }));
}
// ニュースプールを確保（10分以内のキャッシュがあればそれ・なければ取得）。描画はしない（ドロワー用）
async function newsEnsure() {
  // 取得は「更新」ボタンのみ（黄色○が勝手に増えないように）。ドロワーは同期済みプールを参照するだけ。
  return newsPoolCache();
}
// 開示・決算1行（TDnet/EDGAR）。細分類ラベルで色分け、クリックで原本(PDF/EDGAR)を開く
// 開示のリンク先。TDnet(日本株)のPDFは公開期間が約1か月で、それを過ぎると404になる。
// 30日より古い日本株の開示は、恒久的なYahoo!ファイナンスの適時開示ページへ切替える（リンク切れ回避）。
function discIsJp(d) { return d.market === 'JP' || d.source === '適時開示'; }
function discExpired(d) { return d.pubDate && (Date.now() - new Date(d.pubDate).getTime()) > 30 * 86400 * 1000; }
function discLink(d) {
  if (discIsJp(d) && d.code && discExpired(d)) return `https://finance.yahoo.co.jp/quote/${encodeURIComponent(d.code)}.T/disclosure`;
  return d.link;
}
function discItemHtml(d) {
  const typeLbl = disclosureTypeLabel(disclosureType(d));
  const expired = discIsJp(d) && d.code && discExpired(d);
  const src = d.market === 'US' ? 'SEC EDGAR' : (expired ? 'Yahoo開示' : 'TDnet');
  return `<a class="news-item disc-item" href="${esc(discLink(d))}" target="_blank" rel="noopener" draggable="false" title="${expired ? 'PDFは公開終了。Yahoo!ファイナンスの開示一覧を開きます' : ''}">
      <span class="news-title">${esc(d.title)}</span>
      <span class="news-meta"><span class="news-cat ${d.kind === 'earnings' ? 'cat-earnings' : ''}">${typeLbl}</span><span>${src}</span><span>${newsTime(d.pubDate)}</span></span>
    </a>`;
}

// ===== 銘柄別ニュース・開示 専用画面（詳細ドロワー/カルテの「ニュース・開示」ボタンから開く） =====
// 詳細ページを圧迫しないよう、モーダルの専用画面に集約。開示は細分類ボタンで複数選択フィルタ（初期=全部）。
let _secNewsCtx = null; // { sec, news:[], disc:[], typeSel:Set|null }
async function openSecNews(secId) {
  const sec = store.data.securities.find(s => s.id === secId); if (!sec) return;
  _secNewsCtx = { sec, news: null, disc: null, typeSel: null };
  showModal(`ニュース・開示 — ${calc.displayName(sec)}`, `<div id="sec-news-screen" class="muted" style="padding:8px 0">読み込み中…</div>`, { wide: true, fixHeight: true });
  initNewsDragScroll();
  // ニュースと開示を並行取得
  const [news, disc] = await Promise.all([_secNewsFetch(sec), _secDiscFetch(sec)]);
  if (!_secNewsCtx || _secNewsCtx.sec.id !== secId) return; // 別銘柄に切替/閉じたら中断
  _secNewsCtx.news = news; _secNewsCtx.disc = disc;
  _secNewsCtx.typeSel = new Set(disc.map(disclosureGroup)); // 初期＝存在する全グループを選択
  // 英語ニュース（Bloomberg/Finnhub）は先に翻訳してから描画（英語がちらつかない）
  await _secNewsTranslate(news);
  if (!_secNewsCtx || _secNewsCtx.sec.id !== secId) return;
  renderSecNewsScreen();
}
async function _secNewsFetch(sec) {
  const pool = await newsEnsure();
  let items = pool ? pool.items.filter(it => newsSecHit(it, sec)) : [];
  if (sec.market === 'US') {
    // Finnhubの銘柄別ニュースは英語なので lang:'en' を付与（翻訳対象にする）
    try { const d = await (await fetch('/api/news?symbol=' + encodeURIComponent(sec.ticker))).json(); if (d && Array.isArray(d.items)) items = items.concat(d.items.map(it => ({ ...it, lang: 'en' }))); } catch (_) {}
  }
  const seen = new Set();
  return items.filter(it => it.link && !seen.has(it.link) && seen.add(it.link)).sort((a, b) => (b.pubDate || '') < (a.pubDate || '') ? -1 : 1).slice(0, 20);
}
// 専用画面の英語ニュースを翻訳してキャッシュ（見出し。1リクエストでまとめて）
async function _secNewsTranslate(items) {
  const pend = (items || []).filter(it => it.lang === 'en' && !(store.data.newsTrans[it.link] && store.data.newsTrans[it.link].t));
  if (!pend.length) return false;
  const tr = await _newsTranslateBatch(pend.map(it => it.title));
  let any = false;
  pend.forEach((it, i) => { if (tr[i]) { const cur = store.data.newsTrans[it.link] || {}; store.data.newsTrans[it.link] = { t: tr[i], d: cur.d || '', at: new Date().toISOString() }; any = true; } });
  if (any) store.save();
  return any;
}
async function _secDiscFetch(sec) {
  try {
    const q = sec.market === 'US' ? 'market=US&ticker=' + encodeURIComponent(sec.ticker) : 'market=JP&code=' + encodeURIComponent(sec.ticker);
    const d = await (await fetch('/api/disclosure?' + q)).json();
    return (d && Array.isArray(d.items)) ? d.items : [];
  } catch (_) { return []; }
}
function secNewsToggleType(id) {
  if (!_secNewsCtx || !_secNewsCtx.typeSel) return;
  const s = _secNewsCtx.typeSel;
  s.has(id) ? s.delete(id) : s.add(id);
  renderSecNewsScreen();
}
function secNewsAllTypes(on) {
  if (!_secNewsCtx) return;
  _secNewsCtx.typeSel = on ? new Set((_secNewsCtx.disc || []).map(disclosureGroup)) : new Set();
  renderSecNewsScreen();
}
function renderSecNewsScreen() {
  const el = document.getElementById('sec-news-screen'); if (!el || !_secNewsCtx) return;
  const { news, disc, typeSel } = _secNewsCtx;
  const read = store.data.newsRead || {};
  el.classList.remove('muted');
  // ニュース欄
  const newsHtml = news && news.length
    ? `<div class="news-list news-mini">${news.map(it => newsItemHtml(it, read, null, { mini: true })).join('')}</div>`
    : '<div class="muted">なし</div>';
  // 開示欄: 存在する「まとめ種別（グループ）」だけボタン表示（複数選択・初期全部）。チップは細分類のまま。ボタンはスクロール領域の外（固定）
  const presentTypes = [...new Set((disc || []).map(disclosureGroup))];
  const orderedTypes = discGroupsOrdered().filter(id => presentTypes.includes(id));
  const filterBtns = orderedTypes.length ? `<div class="seg seg-toggle sec-disc-filter" style="flex-wrap:wrap;margin-bottom:8px">
      <button class="${typeSel && orderedTypes.every(id => typeSel.has(id)) ? 'active' : ''}" onclick="secNewsAllTypes(${!(typeSel && orderedTypes.every(id => typeSel.has(id)))})">すべて</button>
      ${orderedTypes.map(id => `<button class="${typeSel && typeSel.has(id) ? 'active' : ''}" onclick="secNewsToggleType('${jsq(id)}')">${esc(disclosureGroupLabel(id))}</button>`).join('')}
    </div>` : '';
  const discFiltered = (disc || []).filter(d => !typeSel || typeSel.has(disclosureGroup(d)));
  const discListHtml = disc && disc.length
    ? (discFiltered.length ? `<div class="news-list news-mini">${discFiltered.map(discItemHtml).join('')}</div>` : '<div class="muted">選択した種類の開示はありません</div>')
    : '<div class="muted">なし</div>';
  el.innerHTML = `
    <div class="sec-news-cols">
      <div class="sec-news-col">
        <h4 class="sec-news-h">📰 ニュース</h4>
        <div class="sec-news-scroll">${newsHtml}</div>
      </div>
      <div class="sec-news-col">
        <h4 class="sec-news-h">📄 開示・決算</h4>
        ${filterBtns}
        <div class="sec-news-scroll">${discListHtml}</div>
      </div>
    </div>`;
}

function renderReport() {
  const byMarket = {}, byBroker = {}, matrix = {}, byTypeMarket = {}, byBrokerSeg = {};
  let fxMissing = false;
  const ensure = (o, k) => (o[k] || (o[k] = { valJpy: 0, costJpy: 0, secs: new Set() }));
  for (const h of store.data.holdings) {
    if (!(h.quantity > 0)) continue;
    const sec = store.data.securities.find(s => s.id === h.securityId); if (!sec) continue;
    if (sec.market !== 'JP' && sec.market !== 'US') continue; // 上部サマリも日本株・米国株のみ（下の集計と整合）
    const m = sec.market, price = calc.price(sec);
    const valN = price != null ? h.quantity * price : h.quantity * h.avgCost;
    const costN = h.quantity * h.avgCost;
    const valJ = calc.toJpy(m, valN), costJ = calc.toJpy(m, costN);
    if (valJ == null || costJ == null) { fxMissing = true; continue; } // 米株で為替未取得
    const b = h.broker || '(不明)';
    const mm = ensure(byMarket, m); mm.valJpy += valJ; mm.costJpy += costJ; mm.secs.add(sec.id);
    const bb = ensure(byBroker, b); bb.valJpy += valJ; bb.costJpy += costJ; bb.secs.add(sec.id);
    (matrix[b] || (matrix[b] = {}))[m] = (matrix[b][m] || 0) + valJ;
    // 種別（個別株/ETF/投資信託）×市場
    const dt = detailTypeOf(sec);
    const tm = ensure(byTypeMarket, dt + '|' + m); tm.valJpy += valJ; tm.costJpy += costJ; tm.secs.add(sec.id);
    // 証券会社 × (市場・種別) セグメント（スタックバー用）
    const bs = byBrokerSeg[b] || (byBrokerSeg[b] = {});
    const segK = m + '|' + (dt === 'ETF' ? 'ETF' : '個別株');
    bs[segK] = (bs[segK] || 0) + valJ;
  }
  // 種別×市場の集計行（種別を親、日本株/米国株を子。各種別に小計）
  const TYPE_ORDER = ['個別株', 'ETF'];
  const presentTypes = TYPE_ORDER.filter(dt => ['US', 'JP'].some(m => byTypeMarket[dt + '|' + m]));
  const tmRows = presentTypes.map(dt => {
    let sv = 0, sc = 0; const sset = new Set();
    const subs = ['JP', 'US'].filter(m => byTypeMarket[dt + '|' + m]).map(m => {
      const d = byTypeMarket[dt + '|' + m]; sv += d.valJpy; sc += d.costJpy; d.secs.forEach(x => sset.add(x));
      const p = d.valJpy - d.costJpy, pp = d.costJpy > 0 ? p / d.costJpy * 100 : 0;
      return `<tr><td class="l" style="padding-left:28px"><span class="tag ${m.toLowerCase()}">${MARKET_LABEL[m]}</span></td><td>${yen(d.valJpy)}</td><td>${yen(d.costJpy)}</td><td class="${cls(p)}">${yen(p)}</td><td class="${cls(pp)}">${signed(pp)}%</td><td>${d.secs.size}</td></tr>`;
    }).join('');
    const sp = sv - sc, spp = sc > 0 ? sp / sc * 100 : 0;
    const head = `<tr><td class="l"><strong><span class="tag detail-${dt === 'ETF' ? 'etf' : dt === '投資信託' ? 'fund' : 'stock'}">${dt}</span></strong></td><td><strong>${yen(sv)}</strong></td><td><strong>${yen(sc)}</strong></td><td class="${cls(sp)}"><strong>${yen(sp)}</strong></td><td class="${cls(spp)}"><strong>${signed(spp)}%</strong></td><td><strong>${sset.size}</strong></td></tr>`;
    return head + subs;
  }).join('');
  let totalVal = 0, totalCost = 0;
  Object.values(byMarket).forEach(d => { totalVal += d.valJpy; totalCost += d.costJpy; });
  const pnl = totalVal - totalCost, pnlPct = totalCost > 0 ? pnl / totalCost * 100 : 0;
  const pnlCls = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '';

  const mkRows = ['US', 'JP'].filter(m => byMarket[m]).map(m => { const d = byMarket[m], p = d.valJpy - d.costJpy, pp = d.costJpy > 0 ? p / d.costJpy * 100 : 0; return `<tr><td class="l"><span class="tag ${m.toLowerCase()}">${MARKET_LABEL[m]}</span></td><td>${yen(d.valJpy)}</td><td>${yen(d.costJpy)}</td><td class="${cls(p)}">${yen(p)}</td><td class="${cls(pp)}">${signed(pp)}%</td><td>${d.secs.size}</td></tr>`; }).join('');
  const brokers = Object.keys(byBroker).sort((a, b) => byBroker[b].valJpy - byBroker[a].valJpy);
  const bkRows = brokers.map(b => { const d = byBroker[b], p = d.valJpy - d.costJpy, pp = d.costJpy > 0 ? p / d.costJpy * 100 : 0; return `<tr><td class="l">${esc(b)}</td><td>${yen(d.valJpy)}</td><td>${yen(d.costJpy)}</td><td class="${cls(p)}">${yen(p)}</td><td class="${cls(pp)}">${signed(pp)}%</td><td>${d.secs.size}</td></tr>`; }).join('');
  // 視覚化: 構成比バー（評価額の総資産に対する割合）
  const shareBase = totalVal || 1;
  const BK_COLORS = ['#2a5599', '#b23a36', '#a8854a', '#3a7d44', '#7c5cbf', '#0891b2', '#b97d18'];
  const mkBreak = ['US', 'JP'].filter(m => byMarket[m]).map(m => {
    const d = byMarket[m], p = d.valJpy - d.costJpy, pp = d.costJpy > 0 ? p / d.costJpy * 100 : null, share = d.valJpy / shareBase * 100;
    return `<div class="bd-row"><div style="display:flex;align-items:center;gap:8px;min-width:96px"><span class="tag ${m.toLowerCase()}">${MARKET_LABEL[m]}</span><span class="muted" style="font-size:11px">${d.secs.size}銘柄</span></div><div class="bd-bar" title="${num(share)}%"><i style="width:${Math.max(0, Math.min(100, share))}%;background:${m === 'JP' ? '#b23a36' : '#2a5599'}"></i></div><div style="text-align:right;min-width:128px"><div class="num" style="font-weight:700">${yen(d.valJpy)}</div><div class="num ${cls(pp)}" style="font-size:12px">${pp != null ? signed(pp) + '%' : '—'} ・ ${num(share)}%</div></div></div>`;
  }).join('');
  // 証券会社別バーを 米国株/日本株 × ETF/個別株 のセグメントでスタック表示
  const SEGS = [
    { k: 'US|個別株', label: '米国株 個別株', color: '#2a5599' },
    { k: 'US|ETF', label: '米国株 ETF', color: '#7aa6e0' },
    { k: 'JP|個別株', label: '日本株 個別株', color: '#b23a36' },
    { k: 'JP|ETF', label: '日本株 ETF', color: '#e0928d' },
  ];
  const segLegend = `<div style="display:flex;gap:14px;flex-wrap:wrap;padding:10px 16px 0">${SEGS.map(s => `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)"><i style="width:11px;height:11px;border-radius:2px;background:${s.color};display:inline-block"></i>${s.label}</span>`).join('')}</div>`;
  const bkBreak = brokers.map((b) => {
    const d = byBroker[b], p = d.valJpy - d.costJpy, pp = d.costJpy > 0 ? p / d.costJpy * 100 : null, share = d.valJpy / shareBase * 100;
    const segs = byBrokerSeg[b] || {};
    const bars = SEGS.filter(s => segs[s.k]).map(s => `<i style="width:${Math.max(0, Math.min(100, segs[s.k] / shareBase * 100))}%;background:${s.color}" title="${s.label} ${yen(segs[s.k])}"></i>`).join('');
    return `<div class="bd-row"><div style="min-width:96px;font-weight:600">${esc(b)}<span class="muted" style="font-size:11px;font-weight:400"> ${d.secs.size}</span></div><div class="bd-bar" style="display:flex" title="${num(share)}%">${bars}</div><div style="text-align:right;min-width:128px"><div class="num" style="font-weight:700">${yen(d.valJpy)}</div><div class="num ${cls(pp)}" style="font-size:12px">${pp != null ? signed(pp) + '%' : '—'} ・ ${num(share)}%</div></div></div>`;
  }).join('');
  // 証券会社 × 市場×種別（米国株個別/米国株ETF/日本株個別/日本株ETF）
  const mxRows = brokers.map(b => {
    const s = byBrokerSeg[b] || {};
    const v = (k) => s[k] || 0;
    const tot = v('US|個別株') + v('US|ETF') + v('JP|個別株') + v('JP|ETF');
    const cell = (x) => x ? yen(x) : muted;
    return `<tr><td class="l">${esc(b)}</td><td>${cell(v('US|個別株'))}</td><td>${cell(v('US|ETF'))}</td><td>${cell(v('JP|個別株'))}</td><td>${cell(v('JP|ETF'))}</td><td><strong>${yen(tot)}</strong></td></tr>`;
  }).join('');

  app.innerHTML = `
    <div class="report-summary" style="display:flex;gap:18px;flex-wrap:wrap;align-items:baseline;padding:6px 2px 12px">
      <div><span class="muted" style="font-size:11px">総資産（円換算）</span> <span style="font-size:20px;font-weight:700">¥${num(Math.round(totalVal))}</span></div>
      <div><span class="muted" style="font-size:11px">取得原価</span> <span style="font-size:15px;font-weight:600" class="num">${yen(totalCost)}</span></div>
      <div><span class="muted" style="font-size:11px">評価損益</span> <span style="font-size:17px;font-weight:700" class="num ${pnlCls}">${yen(pnl)}</span> <span class="${cls(pnlPct)}" style="font-weight:700">${signed(pnlPct)}%</span></div>
      <span class="muted" style="font-size:10px">※日本株・米国株のみ（投資信託は除外）</span>
    </div>
    ${fxMissing ? '<div class="notice">USD/JPY 為替が未取得のため、円換算に米国株を含めていません。「価格更新」で取得できます。</div>' : ''}
    <div class="seg report-tabs" role="tablist">${[['assets', '資産集計'], ['txn', '取引サマリー'], ['matrix', '格付×カテゴリ']].map(([k, l]) => `<button class="${reportTab === k ? 'active' : ''}" onclick="setReportTab('${k}')">${l}</button>`).join('')}</div>
    ${reportTab === 'txn' ? `<div class="section" id="txn-section">${txnSummaryHtml()}</div>`
      : reportTab === 'matrix' ? matrixSectionHtml()
      : `<div class="section"><div class="section-head" style="flex-wrap:wrap;gap:8px"><h2>資産推移・現在の集計</h2>
        <div style="display:flex;gap:8px;align-items:center;margin-left:auto;flex-wrap:wrap">
          <div class="seg" id="asset-axis-seg">${[['market', '市場別'], ['markettype', '市場+種別'], ['category', 'カテゴリ別']].map(([k, l]) => `<button class="${assetAxis === k ? 'active' : ''}" onclick="setAssetAxis('${k}')">${l}</button>`).join('')}</div>
          <button class="btn btn-sm ${assetTableBroker ? 'btn-primary' : ''}" onclick="toggleAssetBroker()" title="証券会社別に展開">証券会社別</button>
        </div></div>
      <div class="section-body" style="padding:12px 16px 16px">
        <div class="seg" id="asset-period-seg" style="margin-bottom:8px;width:fit-content">${[['1m', '1ヶ月'], ['3m', '3ヶ月'], ['6m', '6ヶ月'], ['1y', '1年'], ['all', '全期間']].map(([k, l]) => `<button class="${assetPeriod === k ? 'active' : ''}" onclick="setAssetPeriod('${k}')">${l}</button>`).join('')}</div>
        <div id="portfolio-chart" class="muted" style="min-height:160px;display:flex;align-items:center;justify-content:center">読み込み中…</div>
        <div id="asset-table" style="margin-top:12px"></div>
        <details style="margin-top:14px"><summary class="lnk">過去データの取込（明細を貼り付け）</summary>
          <p class="muted" style="margin:8px 0">資産明細（1銘柄×日付の行）をそのまま貼り付けると、日付ごとに集計して履歴に統合します。必要な列＝<b>日付・種別・詳細種別・評価額・取得額</b>（他の列は無視）。日本株・米国株のみ集計。カテゴリ別の内訳は今日以降のみ。</p>
          <textarea id="asset-import-text" rows="5" style="width:100%;font-family:monospace;font-size:12px" placeholder="日付  …  種別  詳細種別 … 評価額 … 取得額 …（ヘッダ行ごと貼り付け）"></textarea>
          <div class="form-actions" style="justify-content:flex-start;margin-top:8px"><button class="btn btn-primary" onclick="importAssetHistory()">取込んで統合</button><span id="asset-import-msg" class="muted" style="align-self:center"></span></div>
        </details>
      </div></div>`}`;
  if (reportTab === 'assets') {
    renderAssetTable();  // 先に表を確定（min-height）＝グラフの利用可能高さが安定し、表が後から動かない
    loadPortfolioChart(); // 履歴(サーバー日次＋取込済み過去)を取得して描画（領域の高さは先に確保）
  } else if (reportTab === 'matrix') {
    sizeMatrixChips();  // チップ文字を枠にぴったり収まる最大サイズに（先に文字を確定）
    fitMatrix();        // 表枠を画面下端まで伸ばす（高さいっぱい・下余白なし）
  } else {
    scheduleFit();      // 取引サマリー等の表を枠内スクロール
  }
}
// 銘柄が取引サマリーの絞り込み条件（市場・銘柄ラベル）に合致するか。null（削除済み銘柄）はフィルタ無効時のみ通す。
function txnSecMatchesFilter(sec) {
  if (txnFilter.market !== 'ALL') { if (!sec || sec.market !== txnFilter.market) return false; }
  if (txnFilter.labels.length) {
    const ls = sec ? secLabels(sec) : [];
    const hit = txnFilter.labels.some(l => ls.includes(l));
    if (txnFilter.labelMode === 'exclude' ? hit : !hit) return false;
  }
  return true;
}
function txnFilterActive() { return txnFilter.market !== 'ALL' || txnFilter.labels.length > 0; }
// 現在の期間トグル（all/year/month）＋絞り込みに合致する取引を返す。サマリー集計と明細一覧で共通利用。
function txnInPeriod() {
  const yPrefix = String(reportYear);
  const mPrefix = `${reportYear}-${String(reportMonthNum).padStart(2, '0')}`;
  return store.data.transactions.filter(t => {
    if (reportPeriod === 'year' && !(t.tradedAt && t.tradedAt.slice(0, 4) === yPrefix)) return false;
    if (reportPeriod === 'month' && !(t.tradedAt && t.tradedAt.slice(0, 7) === mPrefix)) return false;
    return txnSecMatchesFilter(store.data.securities.find(s => s.id === t.securityId));
  });
}
// 現在の期間トグルの表示ラベル（見出し・明細一覧のタイトル用）。
function periodLabelText() {
  return reportPeriod === 'year' ? `${reportYear}年` : reportPeriod === 'month' ? `${reportYear}年${reportMonthNum}月` : '全期間';
}
// 期間セレクタ（年・月プルダウン）。トグルの左に置き、月別でもトグルの位置が動かないようにする。
function periodSelectorHtml() {
  if (reportPeriod === 'all') return '';
  const years = txnYears();
  const yearSel = `<select class="txn-sel" onchange="setReportYear(this.value)">${years.map(y => `<option value="${y}" ${y === reportYear ? 'selected' : ''}>${y}年</option>`).join('')}</select>`;
  if (reportPeriod === 'year') return yearSel;
  const monthSel = `<select class="txn-sel" onchange="setReportMonthNum(this.value)">${Array.from({ length: 12 }, (_, i) => i + 1).map(m => `<option value="${m}" ${m === reportMonthNum ? 'selected' : ''}>${m}月</option>`).join('')}</select>`;
  return yearSel + monthSel;
}
// 現在の絞り込み内容を表す短いテキスト（フィルタチップ用）。
function txnFilterSummaryText() {
  const parts = [];
  if (txnFilter.market !== 'ALL') parts.push(MARKET_LABEL[txnFilter.market] || txnFilter.market);
  if (txnFilter.labels.length) parts.push(`ラベル${txnFilter.labelMode === 'exclude' ? '除外' : 'のみ'}: ${txnFilter.labels.map(esc).join('・')}`);
  return parts.join(' / ');
}
// 取引サマリー（期間: 全期間/年別/月別 ＋ 汎用フィルタ）。期間トグルは資産推移の表に影響させないため別関数化し、#txn-section だけ更新する。
function txnSummaryHtml() {
  let buyTot = 0, sellTot = 0, buyN = 0, sellN = 0;
  for (const t of txnInPeriod()) {
    const sec = store.data.securities.find(s => s.id === t.securityId); if (!sec) continue;
    const amt = calc.toJpy(sec.market, (t.price || 0) * (t.quantity || 0)); if (amt == null) continue;
    if (t.type === 'buy') { buyTot += amt; buyN++; } else if (t.type === 'sell') { sellTot += amt; sellN++; }
  }
  const net = buyTot - sellTot;
  const seg = (p, l) => `<button class="${reportPeriod === p ? 'active' : ''}" onclick="setReportPeriod('${p}')">${l}</button>`;
  // 買い/売りの行はクリックで明細一覧を表示。件数0の区分はクリック不可。
  const row = (type, label, n, tot) => n > 0
    ? `<tr class="txn-clickable" onclick="openTxnList('${type}')" title="クリックで明細を表示"><td class="l">${label} <span class="txn-more">明細 ›</span></td><td>${n}</td><td>${yen(tot)}</td></tr>`
    : `<tr><td class="l">${label}</td><td>${n}</td><td>${yen(tot)}</td></tr>`;
  // フィルタチップ（適用中のみ）。クリックで再編集、×でクリア。
  const filterChip = txnFilterActive()
    ? `<div class="txn-filter-chip"><span class="tag" onclick="openTxnFilter()" title="絞り込みを編集" style="cursor:pointer">🔎 ${esc(txnFilterSummaryText())}</span><button class="txn-filter-clear" onclick="clearTxnFilter()" title="絞り込み解除">×</button></div>`
    : '';
  return `<div class="section-head"><h2>取引サマリー（${periodLabelText()}・円換算）</h2>
      <div class="txn-head-ctrls">
        ${periodSelectorHtml()}
        <div class="seg" role="tablist">${seg('all', '全期間')}${seg('year', '年別')}${seg('month', '月別')}</div>
        <button class="btn btn-sm ${txnFilterActive() ? 'btn-primary' : ''}" onclick="openTxnFilter()" title="市場・銘柄ラベルで絞り込み">🔎 絞り込み</button>
      </div></div>
    ${filterChip}
    <div style="overflow-x:auto;max-width:100%"><table><thead><tr><th class="l">区分</th><th>件数</th><th>金額（円換算）</th></tr></thead>
      <tbody>
        ${row('buy', '買い', buyN, buyTot)}
        ${row('sell', '売り', sellN, sellTot)}
        <tr><td class="l"><strong>ネット投資額（買い−売り）</strong></td><td>—</td><td class="${cls(net)}"><strong>${yen(net)}</strong></td></tr>
      </tbody></table></div>
    <p class="muted" style="padding:0 16px 12px">※取引のある銘柄のみ。買い/売りの行をクリックすると明細一覧を表示。ロット単位の実現損益はロット管理が必要なため今後対応。</p>`;
}
// 取引サマリーの絞り込み設定モーダル（市場・銘柄ラベル）。汎用フィルタ。
function openTxnFilter() {
  const defs = [...(store.data.labelDefs || [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const mkBtn = (m, l) => `<button type="button" class="btn btn-sm ${txnFilter.market === m ? 'btn-primary' : ''}" onclick="txnFilterSetMarket('${m}')">${l}</button>`;
  const modeBtn = (v, l) => `<button type="button" class="btn btn-sm ${txnFilter.labelMode === v ? 'btn-primary' : ''}" onclick="txnFilterSetMode('${v}')">${l}</button>`;
  const labelChecks = defs.length
    ? defs.map(d => `<label class="lbl-chk"><input type="checkbox" value="${esc(d.name)}" ${txnFilter.labels.includes(d.name) ? 'checked' : ''} onchange="txnFilterToggleLabel(this.value, this.checked)"> ${labelsTagOne(d.name)}</label>`).join('')
    : '<span class="muted">ラベル未登録。銘柄編集の「銘柄ラベル」で追加できます。</span>';
  showModal('取引サマリーの絞り込み', `
    <div class="field"><label>市場</label><div class="seg-btns">${mkBtn('ALL', '全部')}${mkBtn('US', '米国株')}${mkBtn('JP', '日本株')}</div></div>
    <div class="field"><label>銘柄ラベルで絞り込み</label>
      <div class="seg-btns" style="margin-bottom:6px">${modeBtn('exclude', '選択を除外')}${modeBtn('include', '選択のみ')}</div>
      <div class="lbl-chk-list">${labelChecks}</div>
      <p class="muted" style="margin:6px 0 0">短期投資などのラベルを「選択を除外」にすると、そのラベルの付いた銘柄の売買を集計・一覧から外せます。取引サマリーの金額・件数・明細一覧のみに効き、保有・資産集計・判定など他の扱いは変わりません。</p></div>
    <div class="form-actions">
      <button type="button" class="btn btn-danger" onclick="clearTxnFilter();closeModal()">絞り込み解除</button>
      <button type="button" class="btn btn-primary" onclick="closeModal()">閉じる</button>
    </div>`, { wide: true });
}
function txnFilterSetMarket(m) { txnFilter.market = m; refreshTxnSection(); openTxnFilter(); }
function txnFilterSetMode(v) { txnFilter.labelMode = v; refreshTxnSection(); if (txnFilter.labels.length) openTxnFilter(); }
function txnFilterToggleLabel(name, on) { txnFilter.labels = on ? [...new Set([...txnFilter.labels, name])] : txnFilter.labels.filter(l => l !== name); refreshTxnSection(); }
function clearTxnFilter() { txnFilter = { market: 'ALL', labels: [], labelMode: 'exclude' }; refreshTxnSection(); }
// 取引サマリーの買い/売り行クリック → その期間の該当取引の明細一覧をモーダル表示。
function openTxnList(type) {
  const label = type === 'buy' ? '買い' : '売り';
  const list = txnInPeriod().filter(t => t.type === type).sort((a, b) => (a.tradedAt < b.tradedAt ? 1 : -1));
  const title = `${periodLabelText()}の${label}取引（${list.length}件）`;
  if (!list.length) { showModal(title, '<div class="muted" style="padding:8px">該当する取引はありません。</div>'); return; }
  let tot = 0;
  const rows = list.map(t => {
    const sec = store.data.securities.find(s => s.id === t.securityId);
    const name = sec ? esc(calc.displayName(sec)) : `<span class="muted">#${esc(String(t.securityId))}（削除済み）</span>`;
    const ccy = sec ? MARKET_CCY[sec.market] : '';
    const amtNative = (t.price || 0) * (t.quantity || 0);
    const jpy = sec ? calc.toJpy(sec.market, amtNative) : null;
    if (jpy != null) tot += jpy;
    const qty = sec ? fmtQty(t.quantity, sec.market) : num(t.quantity);
    const nameCell = sec ? `<a href="#" onclick="closeModal();openSecurityDetail(${sec.id});return false">${name}</a>` : name;
    return `<tr>
      <td class="l">${esc(t.tradedAt || '—')}</td>
      <td class="l">${nameCell}${t.broker ? ` <span class="muted" style="font-size:11px">${esc(t.broker)}</span>` : ''}${t.ledgerOnly ? ' <span class="tag" title="保有数量・平均取得単価には未反映">記録のみ</span>' : ''}${t.skipPrevBuy ? ' <span class="tag" title="前回購入単価・前回購入日として使わない">前回購入外</span>' : ''}</td>
      <td>${qty}</td>
      <td>${ccy}${num(t.price)}</td>
      <td>${jpy != null ? yen(jpy) : '—'}</td>
    </tr>`;
  }).join('');
  const body = `<div style="overflow:auto;max-height:60vh"><table class="txn-list-table"><thead>
      <tr><th class="l">日付</th><th class="l">銘柄</th><th>数量</th><th>単価</th><th>金額（円換算）</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td class="l" colspan="4"><strong>合計（円換算）</strong></td><td><strong>${yen(tot)}</strong></td></tr></tfoot>
    </table></div>`;
  showModal(title, body, { wide: true });
}
// 取得価額（円換算）→ レンジ(band) のインデックス。マスタ store.data.matrixBands を参照（max未満で区分・最後はmax=null）。
function mxBandOf(cost) {
  const bands = store.data.matrixBands || [];
  for (let i = 0; i < bands.length; i++) { const m = bands[i].max; if (m == null || cost < m) return i; }
  return Math.max(0, bands.length - 1);
}
// 軸（区分）ごとの値・並び順・表示ラベル。軸は MATRIX_AXES から選択（縦横とも）。
function matrixAxisVal(sec, field) {
  switch (field) {
    case 'category': return sec.category || '未分類';
    case 'rating': case 'overallGrade': case 'buyGrade': { const v = sec[field]; return ['S', 'A', 'B', 'C', 'D'].includes(v) ? v : '未設定'; }
    case 'market': return sec.market;
    case 'detailType': return detailTypeOf(sec);
    case 'broker': return calc.lastBroker(sec) || '(不明)';
    case 'ruleName': { const r = store.rule(sec.ruleId); return r ? r.name : '(未割当)'; }
    case 'sector': return calc.field(sec, 'sector') || '(不明)';
    case 'priority': return sec.priority != null ? String(sec.priority) : '未設定';
    default: return '(不明)';
  }
}
function matrixAxisSort(field, keys) {
  const GR = ['S', 'A', 'B', 'C', 'D', '未設定'];
  const ai = (arr, k) => { const i = arr.indexOf(k); return i < 0 ? 9999 : i; };
  if (field === 'category') { const ord = [...store.data.categories].sort((a, b) => a.sortOrder - b.sortOrder).map(c => c.category); return keys.slice().sort((a, b) => (ai(ord, a) - ai(ord, b)) || (a < b ? -1 : 1)); }
  if (['rating', 'overallGrade', 'buyGrade'].includes(field)) return keys.slice().sort((a, b) => ai(GR, a) - ai(GR, b));
  if (field === 'market') return keys.slice().sort((a, b) => ai(['US', 'JP'], a) - ai(['US', 'JP'], b));
  if (field === 'priority') return keys.slice().sort((a, b) => (a === '未設定' ? Infinity : +a) - (b === '未設定' ? Infinity : +b));
  return keys.slice().sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}
function matrixAxisLabel(field, key) {
  if (field === 'category') {
    if (key === '未分類') return '<span class="muted">未分類</span>';
    const c = (store.data.categories || []).find(x => x.category === key);
    // カテゴリ軸は見出しに1回購入額（投資額）を併記。米国株表示は$、それ以外は円。
    const amt = c ? `<div class="mx-axsub">${matrixMarket === 'US' ? '$' + num(c.amountUsd) : '¥' + num(c.amountJpy)}</div>` : '';
    return categoryTag(key) + amt;
  }
  if (['rating', 'overallGrade', 'buyGrade'].includes(field)) return key === '未設定' ? '<span class="muted">未設定</span>' : gradeBadge({ rating: key });
  if (field === 'market') return `<span class="tag ${String(key).toLowerCase()}">${MARKET_LABEL[key] || esc(key)}</span>`;
  if (field === 'ruleName') {
    // ルール軸は見出しに初回/買い増しの下落率を併記。
    const r = (store.data.rules || []).find(x => x.name === key);
    const sub = r ? `<div class="mx-axsub">初-${r.initialDropPct}% / 増-${r.addonDropPct}%</div>` : '';
    return esc(key) + sub;
  }
  return esc(key);
}
// 区分×区分 の分布マトリックス。縦横の軸・市場・取得額レンジ（マスタ）を切替可能。各セルは該当銘柄を取得価額レンジ色のチップで表示（合計は出さない）。
function matrixSectionHtml() {
  const rowF = reportMatrixRow, colF = reportMatrixCol;
  const rate = masterUsdJpy(); // 共通ドル円換算レート（マスタ・設定で編集）
  const bands = store.data.matrixBands || [];
  const cell = {};                 // 'rowKey|colKey' -> [{sec, cost}]
  const rowSet = new Set(), colSet = new Set();
  let n = 0;
  for (const sec of store.data.securities) {
    if (sec.market !== 'JP' && sec.market !== 'US') continue;
    if (matrixMarket !== 'ALL' && sec.market !== matrixMarket) continue;
    const th = calc.totalHolding(sec.id); if (!(th.qty > 0)) continue;
    const costNative = th.acquiredCost;                                          // 原通貨の取得額（米株=$ / 日本株=円）
    const cost = sec.market === 'US' ? costNative * rate : costNative;            // レンジ判定用の円換算（米株は設定レート）
    const rk = matrixAxisVal(sec, rowF), ck = matrixAxisVal(sec, colF);
    (cell[rk + '|' + ck] ||= []).push({ sec, cost, costNative });
    rowSet.add(rk); colSet.add(ck); n++;
  }
  const mseg = `<div class="seg">${[['ALL', '全部'], ['US', '米国株'], ['JP', '日本株']].map(([m, l]) => `<button class="${matrixMarket === m ? 'active' : ''}" onclick="setMatrixMarket('${m}')">${l}</button>`).join('')}</div>`;
  const axisSel = (val, on) => `<select class="mx-axis-sel" onchange="${on}(this.value)">${MATRIX_AXES.map(([k, l]) => `<option value="${k}" ${val === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const toolbar = `<div class="mx-toolbar">
    <span class="mx-tb-lab">縦軸</span>${axisSel(rowF, 'setReportMatrixRow')}
    <span class="mx-tb-lab">横軸</span>${axisSel(colF, 'setReportMatrixCol')}
    ${mseg}
    <button class="btn btn-sm" style="margin-left:auto" onclick="openMatrixBandMaster()">⚙ レンジ設定</button>
  </div>`;
  const title = `${esc(matrixAxisName(rowF))} × ${esc(matrixAxisName(colF))} マトリックス`;
  const legend = `<div class="mx-legend">取得価額レンジ：${bands.map(b => `<span class="mx-chip" style="${mxChipStyle(b.color)};cursor:default">${esc(b.label)}</span>`).join('')}</div>`;
  const note = `<p class="muted" style="margin:6px 0 10px;font-size:11.5px">各セルは該当銘柄を取得価額レンジ色のチップで表示（クリックで詳細）。${matrixMarket !== 'JP' ? `米国株は1ドル＝${num(rate)}円で円換算。` : ''}</p>`;
  if (n === 0) return `<div class="section"><div class="section-head"><h2>${title}</h2></div>
    <div class="section-body" style="padding:12px 16px 16px">${toolbar}<div class="empty">該当する保有銘柄がありません。</div></div></div>`;
  const rows = matrixAxisSort(rowF, [...rowSet]);
  const cols = matrixAxisSort(colF, [...colSet]);
  // チップ表示: 日本株＝銘柄名（略記して6文字）／米国株＝ティッカー（4文字）。★文字数を変えるならここの slice(0, N)。
  const chipLabel = (s) => s.market === 'JP' ? esc(displayNameAbbr(s).slice(0, 6)) : esc((s.ticker || '').slice(0, 4));
  // ツールチップの取得額: 米国株はドル建て、日本株は円建て（レンジ表記は出さない）
  const costTip = (it) => it.sec.market === 'US' ? '$' + num(it.costNative) : yen(it.costNative);
  const chip = (item) => {
    const i = mxBandOf(item.cost); const b = bands[i] || {};
    return `<span class="mx-chip" style="${mxChipStyle(b.color)}" title="${esc(calc.displayName(item.sec))}　取得 ${costTip(item)}" onclick="openSecurityDetail(${item.sec.id})">${chipLabel(item.sec)}</span>`;
  };
  // ★1行あたりのチップ数（均一幅）: 米国株=6 / それ以外(日本株・全部)=4。ここを変えると1行の個数が変わる。
  // 全部(ALL)は日本株が見えるよう4個。フォントは sizeMatrixChips() がラベルが切れない最大サイズに自動調整。
  const chipCols = matrixMarket === 'US' ? 6 : 4;
  // 列幅は均等固定（table-layout:fixed）。先頭の行見出し列だけ専用幅、残りを cols 等分。
  const colgroup = `<colgroup><col class="mx-rowh-col">${cols.map(() => '<col>').join('')}</colgroup>`;
  const head = `<tr><th class="mx-corner">${esc(matrixAxisName(rowF))} ＼ ${esc(matrixAxisName(colF))}</th>${cols.map(c => `<th class="mx-colh">${matrixAxisLabel(colF, c)}</th>`).join('')}</tr>`;
  const bodyRows = rows.map(r => {
    const tds = cols.map(c => {
      const list = (cell[r + '|' + c] || []).slice().sort((a, b) => b.cost - a.cost);
      if (!list.length) return '<td class="mx-cell mx-empty">—</td>';
      return `<td class="mx-cell"><div class="mx-chips" style="grid-template-columns:repeat(${chipCols},minmax(0,1fr))">${list.map(chip).join('')}</div></td>`;
    }).join('');
    return `<tr><th class="mx-rowh">${matrixAxisLabel(rowF, r)}</th>${tds}</tr>`;
  }).join('');
  return `<div class="section" style="margin-bottom:0">
    <div class="section-head"><h2>${title}</h2></div>
    <div class="section-body" style="padding:12px 16px 8px">
      ${toolbar}
      ${legend}
      ${note}
      <div class="table-wrap mx-wrap"><table class="mx-table">
        ${colgroup}
        <thead>${head}</thead>
        <tbody>${bodyRows}</tbody>
      </table></div>
    </div></div>`;
}
// マトリックスのチップ文字サイズを、実測で「チップ枠にぴったり収まる最大サイズ」に合わせる。
// 列数(カテゴリ数)や画面幅でチップ幅が変わるので、実際のラベル幅を測って文字が切れない範囲で最大化する
// （固定/推定フォントだと余白が出たり切れたりするため、実測スケールで詰める）。
function sizeMatrixChips() {
  const table = document.querySelector('#app .mx-table'); if (!table) return;
  const chips = [...table.querySelectorAll('.mx-chips .mx-chip')]; if (!chips.length) return;
  const REF = 12; // 基準フォントで一度測ってから線形スケール
  table.querySelectorAll('.mx-chips').forEach(c => { c.style.fontSize = REF + 'px'; });
  const chip0 = chips[0], ccs = getComputedStyle(chip0);
  const innerW = chip0.clientWidth - parseFloat(ccs.paddingLeft) - parseFloat(ccs.paddingRight); // チップ内の文字領域幅（全チップ均一）
  // 同じフォント設定の隠しspanで各ラベルの実描画幅を測り、最大を取る
  const meas = document.createElement('span');
  meas.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font-weight:${ccs.fontWeight};font-family:${ccs.fontFamily};font-size:${REF}px;`;
  document.body.appendChild(meas);
  let maxText = 1;
  for (const c of chips) { meas.textContent = c.textContent; if (meas.offsetWidth > maxText) maxText = meas.offsetWidth; }
  meas.remove();
  // ★最も長いラベルがチップ幅にちょうど収まる最大フォント。0.99=安全率（小さくすると詰める/大きくすると切れやすい）、Math.min(18,…)=上限。
  let font = REF * (innerW / maxText) * 0.99;
  font = Math.max(6, Math.min(18, font));               // 6〜18px
  table.querySelectorAll('.mx-chips').forEach(c => { c.style.fontSize = font.toFixed(1) + 'px'; });
}
// マトリックスの表枠を画面下端まで伸ばして高さいっぱいに表示（下に余白を作らない）。あふれる時は枠内スクロール。
// 自己補正方式: いったん main いっぱいに広げて、はみ出した分だけ縮める＝paddingやmarginを実測せずぴったり収める。
// （fitListTables が付けた max-height が残っていると縮むので必ず解除）
function fitMatrix() {
  const wrap = document.querySelector('#app .mx-wrap'); if (!wrap) return;
  const main = wrap.closest('.content'); if (!main) return;
  wrap.style.maxHeight = '';
  wrap.style.height = main.clientHeight + 'px';          // いったん十分大きく（main があふれる）
  const overflow = main.scrollHeight - main.clientHeight; // そのはみ出し量
  const cur = wrap.offsetHeight;
  wrap.style.height = Math.max(200, cur - overflow) + 'px'; // はみ出した分だけ縮める＝main がちょうど収まる
}
// マトリックス取得額レンジのマスタ（色・しきい値・米株換算レート）。
function openMatrixBandMaster() {
  const bands = store.data.matrixBands || [];
  const rows = bands.map((b, i) => `<tr data-idx="${i}">
    <td class="l"><input class="mxb-label" value="${esc(b.label || '')}" style="width:120px"></td>
    <td><input class="mxb-max" type="number" step="any" value="${b.max == null ? '' : b.max}" placeholder="上限なし" style="width:130px"></td>
    <td class="l">${solidSwatchPicker('mxband-' + i, b.color || '#6b7280')}</td>
    <td class="l"><button type="button" class="btn btn-sm btn-danger" onclick="mxbDeleteBand(${i})">削除</button></td>
  </tr>`).join('');
  showModal('マトリックス 取得額レンジ設定', `
    <p class="muted" style="margin:0 0 8px">米国株の円換算レートは<strong>共通レート（1ドル＝${num(masterUsdJpy())}円）</strong>を使用します。変更は「マスタ・設定 → ドル円換算レート」から。</p>
    <div style="display:flex;justify-content:flex-end;margin:10px 0 8px"><button type="button" class="btn btn-sm btn-primary" onclick="mxbAddBand()">＋ レンジを追加</button></div>
    <div class="table-wrap"><table class="holdings dense">
      <thead><tr><th class="l">ラベル</th><th>上限（円・未満）</th><th class="l">色</th><th class="l"></th></tr></thead>
      <tbody id="mxb-rows">${rows}</tbody>
    </table></div>
    <p class="muted" style="margin:8px 0 0">取得額（円換算）が小さい順に「上限（円）未満」で区分します。最後の行は上限を空欄にすると「それ以上」になります。色は各銘柄チップに反映。保存で取得額の小さい順に並べ替えます。</p>
    <div class="form-actions"><button type="button" class="btn" onclick="closeModal()">キャンセル</button><button type="button" class="btn btn-primary" onclick="mxbSave()">保存</button></div>`, { wide: true });
}
// 現在のモーダル入力を読み取る（追加・削除・保存で共通）
function mxbReadForm() {
  const rows = [...document.querySelectorAll('#mxb-rows tr')];
  const bands = rows.map(tr => {
    const label = tr.querySelector('.mxb-label').value.trim();
    const maxRaw = tr.querySelector('.mxb-max').value;
    const max = maxRaw === '' ? null : parseFloat(maxRaw);
    const color = (tr.querySelector('.color-pick input[type=hidden]') || {}).value || '#6b7280';
    return { label, max: (max != null && isNaN(max)) ? null : max, color };
  });
  return { bands };
}
// matrixBands(順序つき配列)と rate は常に一括編集される。配列自身は _updatedAt を持てない（JSON化で消える）
// ため、相方 matrixSettings._updatedAt に編集時刻を入れ、同期はこの時刻で両方のタイブレークを行う（pairTs）。
function mxbApply(bands) { store.data.matrixBands = bands; store.data.matrixSettings = { ...(store.data.matrixSettings || {}), _updatedAt: store._now() }; store.save(); }
function mxbAddBand() { const { bands } = mxbReadForm(); bands.push({ max: null, label: '新レンジ', color: '#6b7280' }); mxbApply(bands); openMatrixBandMaster(); }
function mxbDeleteBand(i) { const { bands } = mxbReadForm(); bands.splice(i, 1); mxbApply(bands); openMatrixBandMaster(); }
function mxbSave() {
  let { bands } = mxbReadForm();
  if (!bands.length) bands = structuredClone(DEFAULT_MATRIX_BANDS);
  bands.sort((a, b) => (a.max == null ? Infinity : a.max) - (b.max == null ? Infinity : b.max)); // 取得額の小さい順
  mxbApply(bands); closeModal(); if (currentView === 'report') renderReport(); else toast('レンジ設定を保存しました');
}
// ---------- 共通ドル円換算レート（マスタ評価用） ----------
function openFxRateMaster() {
  showModal('ドル円換算レート（マスタ評価用）', `
    <div class="field"><label>1ドル＝？円（初期値 ${DEFAULT_MATRIX_USDJPY}）</label>
      <input id="fx-rate" type="number" step="any" min="0" value="${num(masterUsdJpy())}" style="width:140px"></div>
    <p class="muted" style="margin:8px 0 0">米国株($)の金額を円換算して評価する<strong>共通レート</strong>です。次の2か所で共用します。<br>
      ・<strong>背景色ルール</strong>: 取得価額・評価額・現在値など単位が異なる金額列で、US は「ドル×レート＝円相当」で背景色を判定（表示は$のまま）。<br>
      ・<strong>マトリックス レンジ設定</strong>: 「全部」/米国株表示の取得額の円換算。<br>
      実勢レートではなく「評価のものさし」です（基本は1ドル＝100円で見る想定）。</p>
    <div class="form-actions"><button type="button" class="btn" onclick="closeModal()">キャンセル</button><button type="button" class="btn btn-primary" onclick="saveFxRate()">保存</button></div>`);
}
function saveFxRate() {
  const v = parseFloat(document.getElementById('fx-rate').value);
  if (!isFinite(v) || v <= 0) { toast('正の数を入力してください'); return; }
  store.data.settings = store.data.settings || {};
  store.data.settings.masterUsdJpy = v;
  store.data.settings._updatedAt = store._now(); // 同期マージで両端末変更時に新しい方を採るため
  store.save(); closeModal(); render(); toast(`ドル円換算レートを 1ドル＝${num(v)}円 に設定しました`);
}
// ---------- 取引の既定 証券会社（未保有の銘柄用） ----------
// 取引記録フォームの証券会社は「実際の保有 → 直近の買い」の順で決めるが、**未保有・取引履歴なし**の
// 銘柄はどこで買うかの情報が無く、従来は BROKERS[0]（SBI）固定だった。市場ごとの既定をマスタで持つ。
// 保存先は store.data.settings（＝Googleドライブ同期の対象。localStorage 単独では持たない／CLAUDE.md ルール7）。
const DEFAULT_NEW_BROKER = { JP: '楽天', US: 'Webull', FUND: 'SBI' };
function defaultBrokerFor(market) {
  const s = (store.data.settings && store.data.settings.defaultBroker) || {};
  const v = s[market];
  if (v && BROKERS.includes(v)) return v;
  return DEFAULT_NEW_BROKER[market] || BROKERS[0];
}
function openDefaultBrokerMaster() {
  const sel = (mkt) => `<select id="dfb-${mkt}">${BROKERS.map(b => `<option ${b === defaultBrokerFor(mkt) ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>`;
  showModal('取引の既定 証券会社（未保有の銘柄）', `
    <div class="row">
      <div class="field"><label>日本株</label>${sel('JP')}</div>
      <div class="field"><label>米国株</label>${sel('US')}</div>
    </div>
    <p class="muted" style="margin:8px 0 0">取引を記録するときの証券会社の初期値です。<strong>すでに保有している銘柄・過去に買った銘柄は、その保有／直近の買いの証券会社が優先</strong>されます。ここで設定した値が使われるのは<strong>未保有かつ取引履歴が無い銘柄</strong>（新規に買う銘柄）のときだけです。</p>
    <div class="form-actions"><button type="button" class="btn" onclick="closeModal()">キャンセル</button><button type="button" class="btn btn-primary" onclick="saveDefaultBroker()">保存</button></div>`);
}
function saveDefaultBroker() {
  const jp = (document.getElementById('dfb-JP') || {}).value;
  const us = (document.getElementById('dfb-US') || {}).value;
  store.data.settings = store.data.settings || {};
  store.data.settings.defaultBroker = { ...(store.data.settings.defaultBroker || {}), JP: jp, US: us };
  store.data.settings._updatedAt = store._now(); // 同期マージで両端末変更時に新しい方を採るため
  store.save(); closeModal(); toast(`未保有時の既定を 日本株=${jp} / 米国株=${us} にしました`);
}
// トグル連動の「現在の集計」表。assetTableBroker=false: 分類ごとの集計のみ／true: 証券会社×分類のクロス表。
let assetTableBroker = false;
function toggleAssetBroker() {
  assetTableBroker = !assetTableBroker;
  const btn = document.querySelector('#app [onclick="toggleAssetBroker()"]'); if (btn) btn.classList.toggle('btn-primary', assetTableBroker);
  renderAssetTable();
}
function computeBrokerBreakdowns() {
  const brokers = {};
  const ens = (b) => brokers[b] || (brokers[b] = { market: {}, markettype: {}, category: {} });
  const addk = (o, k, v, c) => { const e = o[k] || (o[k] = { v: 0, c: 0 }); e.v += v; e.c += c; };
  for (const h of store.data.holdings) {
    if (!(h.quantity > 0)) continue;
    const sec = store.data.securities.find(s => s.id === h.securityId); if (!sec) continue;
    if (sec.market !== 'JP' && sec.market !== 'US') continue;
    const price = calc.price(sec);
    const vj = calc.toJpy(sec.market, price != null ? h.quantity * price : h.quantity * h.avgCost);
    const cj = calc.toJpy(sec.market, h.quantity * h.avgCost);
    if (vj == null || cj == null) continue;
    const v = Math.round(vj), c = Math.round(cj), b = h.broker || '(不明)';
    const mk = sec.market === 'JP' ? '日本株' : '米国株', isETF = detailTypeOf(sec) === 'ETF';
    const o = ens(b);
    addk(o.market, mk, v, c);
    addk(o.markettype, `${mk}・${isETF ? 'ETF' : '個別株'}`, v, c);
    addk(o.category, isETF ? 'ETF' : (sec.category || '未分類'), v, c);
  }
  return brokers;
}
// 表示期間に対応する過去スナップショットの分類別評価額（期間損益の比較用）。{label, past:{key:val}, total} or null。
function periodComparison(ax) {
  const snaps = _assetSnaps || []; if (snaps.length < 2) return null;
  let chosen = null;
  if (assetPeriod === 'all') { chosen = snaps[0]; }
  else {
    const months = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 }[assetPeriod];
    const cut = new Date(); cut.setMonth(cut.getMonth() - months); const cs = cut.toISOString().slice(0, 10);
    for (const s of snaps) { if (s.date <= cs) chosen = s; else break; } // cut以前で最新
    if (!chosen) chosen = snaps[0]; // 履歴が期間より短ければ最古
  }
  if (!chosen) return null;
  const keyOf = { market: 'byMarket', markettype: 'byMarketType', category: 'byCategory' }[ax];
  let b = chosen[keyOf];
  if (ax === 'category' && (!b || !Object.keys(b).length) && chosen.byMarketType) { b = {}; for (const k in chosen.byMarketType) { const e = /ETF$/.test(k) ? 'ETF' : 'その他'; b[e] = (b[e] || 0) + chosen.byMarketType[k]; } }
  const nb = {}; for (const k in (b || {})) { const nk = k.replace(/・個別$/, '・個別株'); nb[nk] = (nb[nk] || 0) + b[k]; }
  const dt = new Date(Date.parse(chosen.date));
  return { label: `${dt.getFullYear()}/${dt.getMonth() + 1}比`, past: nb, total: chosen.totalJpy || 0 };
}
function renderAssetTable() {
  const el = document.getElementById('asset-table'); if (!el) return;
  const brokers = computeBrokerBreakdowns();
  const ax = assetAxis, names = Object.keys(brokers);
  if (!names.length) { el.innerHTML = '<div class="empty">保有銘柄がありません（日本株・米国株）。</div>'; return; }
  // トグルで表サイズが変わらないよう、全軸の最大行数で min-height を固定（情報量最大に合わせる）
  const keyCount = (axis) => { const s = new Set(); for (const b of names) for (const k in brokers[b][axis]) s.add(k); return s.size; };
  el.style.minHeight = ((Math.max(keyCount('market'), keyCount('markettype') + 2, keyCount('category')) + 3) * 31 + 4) + 'px';
  const colTotals = {};
  for (const b of names) { const m = brokers[b][ax]; for (const k in m) { const e = colTotals[k] || (colTotals[k] = { v: 0, c: 0 }); e.v += m[k].v; e.c += m[k].c; } }
  const keys = assetOrderKeys(Object.keys(colTotals), ax, Object.fromEntries(Object.entries(colTotals).map(([k, e]) => [k, e.v])));
  const grandV = Object.values(colTotals).reduce((a, e) => a + e.v, 0) || 1;
  const grandC = Object.values(colTotals).reduce((a, e) => a + e.c, 0) || 1;
  const colorOf = (k) => assetKeyColor(k, keys.indexOf(k));
  const cmp = periodComparison(ax);
  const bar = (val, color, base) => `<td class="num" style="position:relative">${val ? `<span style="position:absolute;left:0;top:1px;bottom:1px;width:${Math.max(1.5, Math.min(100, val / base * 100)).toFixed(1)}%;background:${color};opacity:.16;border-radius:2px"></span>` : ''}<span style="position:relative">${val ? yen(val) : '—'}</span></td>`;
  const chip = (k) => `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${colorOf(k)};margin-right:5px;vertical-align:-1px"></span>`;
  const pct = (x, base) => `<td class="num" style="color:var(--muted)">${num(x / base * 100)}%</td>`;
  const pnlTd = (v, c) => { const p = v - c, pp = c > 0 ? p / c * 100 : 0; return `<td class="num ${cls(p)} nowrap">${yen(p)} <span style="font-size:11px">${signed(pp)}%</span></td>`; };
  const perTd = (cur, past) => { if (!cmp) return '<td class="num" style="color:var(--muted)">—</td>'; if (!past) return '<td class="num" style="color:var(--muted)">—</td>'; const ch = cur - past, cp = past > 0 ? ch / past * 100 : 0; return `<td class="num ${cls(ch)} nowrap">${yen(ch)} <span style="font-size:11px">${signed(cp)}%</span></td>`; };
  if (!assetTableBroker) {
    const perHead = cmp ? cmp.label : '期間比';
    const row = (k, label, color, v, c, sub) => `<tr${sub ? ' style="background:var(--panel-2)"' : ''}><td class="l nowrap">${color ? `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};margin-right:5px;vertical-align:-1px"></span>` : ''}${sub ? '<strong>' : ''}${esc(label)}${sub ? '</strong>' : ''}</td>${bar(c, color || '#64748b', grandC)}${pct(c, grandC)}${bar(v, color || '#64748b', grandV)}${pct(v, grandV)}${perTd(v, (cmp ? (sub ? sub.past : (cmp.past[k] || 0)) : 0))}${pnlTd(v, c)}</tr>`;
    let rows = '';
    if (ax === 'markettype') {
      for (const [g, re] of [['個別株', /個別株$/], ['ETF', /ETF$/]]) {
        const gk = keys.filter(k => re.test(k)); if (!gk.length) continue;
        let sv = 0, sc = 0, sp = 0; gk.forEach(k => { sv += colTotals[k].v; sc += colTotals[k].c; sp += (cmp ? (cmp.past[k] || 0) : 0); });
        rows += row('__' + g, g + ' 小計', '#64748b', sv, sc, { past: sp });
        gk.forEach(k => { rows += row(k, '　' + k, colorOf(k), colTotals[k].v, colTotals[k].c); });
      }
    } else {
      keys.forEach(k => { rows += row(k, k, colorOf(k), colTotals[k].v, colTotals[k].c); });
    }
    const total = `<tr style="font-weight:700"><td class="l">合計</td>${bar(grandC, '#64748b', grandC)}<td class="num">100%</td>${bar(grandV, '#64748b', grandV)}<td class="num">100%</td>${perTd(grandV, cmp ? cmp.total : 0)}${pnlTd(grandV, grandC)}</tr>`;
    // table-layout:fixed＋列幅固定で、期間トグル（期間比ラベルの文字数）が変わっても列がずれないようにする
    const cg = `<colgroup><col style="width:22%"><col style="width:14%"><col style="width:9%"><col style="width:14%"><col style="width:9%"><col style="width:16%"><col style="width:16%"></colgroup>`;
    el.innerHTML = `<div style="overflow-x:auto;max-width:100%"><table class="dense" style="table-layout:fixed;width:100%">${cg}<thead><tr><th class="l">分類</th><th>取得額</th><th>割合</th><th>評価額</th><th>割合</th><th class="nowrap">${esc(perHead)}</th><th>損益</th></tr></thead><tbody>${rows}${total}</tbody></table></div>`;
    return;
  }
  // 証券会社別クロス: 行=分類, 列=証券会社+合計（評価額・全体100%基準のバー）。
  const bnames = names.sort((a, b) => keys.reduce((t, k) => t + (brokers[b][ax][k] ? brokers[b][ax][k].v : 0), 0) - keys.reduce((t, k) => t + (brokers[a][ax][k] ? brokers[a][ax][k].v : 0), 0));
  const head = `<tr><th class="l">分類 ＼ 証券会社</th>${bnames.map(b => `<th class="nowrap">${esc(b)}</th>`).join('')}<th>合計</th></tr>`;
  const rows = keys.map(k => { const col = colorOf(k); return `<tr><td class="l nowrap">${chip(k)}${esc(k)}</td>${bnames.map(b => { const e = brokers[b][ax][k]; return bar(e ? e.v : 0, col, grandV); }).join('')}${bar(colTotals[k].v, col, grandV)}</tr>`; }).join('');
  const totRow = `<tr style="font-weight:700"><td class="l">合計</td>${bnames.map(b => { const bt = keys.reduce((t, k) => t + (brokers[b][ax][k] ? brokers[b][ax][k].v : 0), 0); return bar(bt, '#64748b', grandV); }).join('')}${bar(grandV, '#64748b', grandV)}</tr>`;
  el.innerHTML = `<div style="overflow-x:auto;max-width:100%"><table class="dense"><thead>${head}</thead><tbody>${rows}${totRow}</tbody></table></div>`;
}

// ---------- 銘柄マスタ（SEC-27） ----------
// 全銘柄の固有データ（名前・セクター・業種・格付け・分析メタ・ルール）を一覧表示。編集は銘柄編集フォームへ。
function smSelectAll(on) { document.querySelectorAll('.sm-check').forEach(c => c.checked = on); }
function bulkDeleteSecurities() {
  const ids = [...document.querySelectorAll('.sm-check:checked')].map(c => parseInt(c.value, 10));
  if (!ids.length) { toast('銘柄を選択してください'); return; }
  if (!confirm(`${ids.length}件の銘柄を削除します（関連する保有・取引も削除）。元に戻せません。よろしいですか？`)) return;
  ids.forEach(id => store.removeSecurity(id));
  store.save(); renderSecMaster();
  toast(`${ids.length}件の銘柄を削除しました`, 5000);
}
function bulkSetField(field, value) {
  const ids = [...document.querySelectorAll('.sm-check:checked')].map(c => parseInt(c.value, 10));
  if (!ids.length) { toast('銘柄を選択してください'); return; }
  for (const id of ids) store.updateSecurity(id, { [field]: value });
  store.save(); renderSecMaster();
  const label = field === 'enabled' ? (value ? '判定対象' : '判定対象外') : (value ? '注意' : '通常');
  toast(`${ids.length}件を「${label}」に変更しました`, 4000);
}
function bulkSetDetailType() {
  const ids = [...document.querySelectorAll('.sm-check:checked')].map(c => parseInt(c.value, 10));
  if (!ids.length) { toast('銘柄を選択してください'); return; }
  const sel = document.getElementById('sm-bulk-detail').value;
  const val = sel === '（自動判定に戻す）' ? null : sel;
  for (const id of ids) store.updateSecurity(id, { detailType: val });
  store.save();
  renderSecMaster();
  toast(`${ids.length}件の詳細種別を「${val || '自動判定'}」に変更しました`);
}
// 銘柄マスタの起動時ソート: 追加日の新しい順 → 更新日の新しい順 → コード昇順（2026-08-06 すみぽん指示）。
// ヘッダをクリックすると従来どおりその列の単一キーソートへ切り替わる（キー '_default' は列に無いので矢印も出ない）。
const SM_DEFAULT_SORT = '_default';
let secMasterSort = { key: SM_DEFAULT_SORT, dir: 1 };
function smDefaultCmp(a, b) {
  const s = (v) => v == null ? '' : String(v);
  if (s(a.createdAt) !== s(b.createdAt)) return s(a.createdAt) > s(b.createdAt) ? -1 : 1;   // 追加日 降順（未設定は末尾）
  if (s(a.updatedAt) !== s(b.updatedAt)) return s(a.updatedAt) > s(b.updatedAt) ? -1 : 1;   // 更新日 降順
  const ta = s(a.ticker).toUpperCase(), tb = s(b.ticker).toUpperCase();
  return ta === tb ? 0 : (ta < tb ? -1 : 1);                                                // コード 昇順
}
let secMasterFilter = 'all'; // all | noprice | noholding | holding
let secMasterMarket = 'ALL'; // ALL(=全株式 US+JP) | US | JP | FUND
function setSecMasterMarket(m) { secMasterMarket = m; renderSecMaster(); }
let secMasterSearch = '';
function setSecMasterSearch(v) {
  const el0 = document.getElementById('sm-search');
  const caret = el0 ? el0.selectionStart : v.length;
  secMasterSearch = v;
  if (window._imeComposing) return; // IME変換中は再描画しない（SEC-112）
  renderSecMaster();
  const el = document.getElementById('sm-search');
  if (el) { el.focus(); const p = Math.min(caret, el.value.length); el.setSelectionRange(p, p); }
}
// 銘柄マスタ 一括変更: 項目＋値の汎用UI。コード/銘柄名など銘柄固有の項目は対象外
const SM_BULK_FIELDS = [
  { key: 'detailType', label: '詳細種別' },
  { key: 'enabled', label: '判定対象' },
  { key: 'watch', label: '注意銘柄' },
  { key: 'category', label: 'カテゴリ' },
  { key: 'investCategory', label: '投資カテゴリ' },
  { key: 'labelAdd', label: 'ラベルを付与' },
  { key: 'labelRemove', label: 'ラベルを外す' },
  { key: 'ruleId', label: '買い増しルール' },
  { key: 'addonFromHigh', label: '買い増しを初回基準' },
  { key: 'rating', label: '銘柄格付' },
  { key: 'overallGrade', label: '総合評価' },
  { key: 'buyGrade', label: '買い時評価' },
  { key: 'targetPer', label: '目標PER' },
  { key: 'targetPbr', label: '目標PBR' },
  { key: 'targetYield', label: '目標配当利回り(%)' },
  { key: 'clearOverrides', label: '手動上書きを削除' },
];
let smBulkField = 'detailType';
// 一括変更の値コントロール（id指定で銘柄マスタ/保有の両方から使う）
function bulkValueHtml(field, id) {
  const gradeOpts = ['', 'S', 'A', 'B', 'C', 'D'].map(g => `<option value="${g}">${g || '（クリア）'}</option>`).join('');
  const catOpts = [...store.data.categories].sort((a, b) => a.sortOrder - b.sortOrder).map(c => `<option>${esc(c.category)}</option>`).join('');
  const invCatOpts = [...store.data.investCategories].sort((a, b) => a.sortOrder - b.sortOrder).map(c => `<option>${esc(c.name)}</option>`).join('');
  const labelOpts = [...(store.data.labelDefs || [])].sort((a, b) => a.sortOrder - b.sortOrder).map(c => `<option>${esc(c.name)}</option>`).join('');
  switch (field) {
    case 'detailType': return `<select id="${id}"><option value="個別株">個別株</option><option value="ETF">ETF</option><option value="__null">（自動判定に戻す）</option></select>`;
    case 'enabled': return `<select id="${id}"><option value="true">対象にする</option><option value="false">対象外にする</option></select>`;
    case 'watch': return `<select id="${id}"><option value="true">付ける</option><option value="false">外す</option></select>`;
    case 'addonFromHigh': return `<select id="${id}"><option value="true">初回基準にする</option><option value="false">通常（前回購入単価基準）に戻す</option></select>`;
    case 'category': return `<select id="${id}">${catOpts}</select>`;
    case 'investCategory': return `<select id="${id}">${invCatOpts}</select>`;
    case 'labelAdd': case 'labelRemove': return `<select id="${id}">${labelOpts || '<option value="">（ラベル未登録）</option>'}</select>`;
    case 'ruleId': return `<select id="${id}">${store.data.rules.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select>`;
    case 'rating': case 'overallGrade': case 'buyGrade': return `<select id="${id}">${gradeOpts}</select>`;
    // 目標指標: 空欄で送ると null（クリア）
    case 'targetPer': case 'targetPbr': case 'targetYield': return `<input id="${id}" type="number" step="any" min="0" placeholder="空欄でクリア">`;
    case 'clearOverrides': return `<select id="${id}"><option value="all">名前・セクター・業種すべて</option><option value="nameOverride">銘柄名のみ</option><option value="sectorOverride">セクターのみ</option><option value="industryOverride">業種のみ</option></select>`;
    default: return `<input id="${id}" type="text">`;
  }
}
function bulkConvert(field, raw) {
  if (field === 'enabled' || field === 'watch' || field === 'addonFromHigh') return raw === 'true';
  if (field === 'detailType') return raw === '__null' ? null : raw;
  if (field === 'ruleId') return parseInt(raw, 10);
  if (['rating', 'overallGrade', 'buyGrade'].includes(field)) return raw || null;
  if (['targetPer', 'targetPbr', 'targetYield'].includes(field)) { const t = String(raw ?? '').trim(); if (t === '') return null; const n = parseFloat(t); return isNaN(n) ? null : n; }
  return raw;
}
// 一括変更で銘柄に適用する patch を作る。clearOverrides は手動上書き(name/sector/industry)を null クリアする特別処理。
// labelAdd/labelRemove は銘柄ごとの現状ラベル配列に対して付与/削除するため sec が必要。
function bulkPatch(field, val, sec) {
  if (field === 'clearOverrides') {
    return val === 'all' ? { nameOverride: null, sectorOverride: null, industryOverride: null } : { [val]: null };
  }
  if (field === 'labelAdd') { if (!val) return {}; return { labels: [...new Set([...secLabels(sec), val])] }; }
  if (field === 'labelRemove') { if (!val) return {}; return { labels: secLabels(sec).filter(l => l !== val) }; }
  return { [field]: val };
}
function smBulkFieldChange(f) { smBulkField = f; const c = document.getElementById('sm-bulk-value-wrap'); if (c) c.innerHTML = bulkValueHtml(f, 'sm-bulk-value'); }
function smBulkApply() {
  const ids = [...document.querySelectorAll('.sm-check:checked')].map(c => parseInt(c.value, 10));
  if (!ids.length) { toast('銘柄を選択してください'); return; }
  const val = bulkConvert(smBulkField, (document.getElementById('sm-bulk-value') || {}).value);
  for (const id of ids) store.updateSecurity(id, bulkPatch(smBulkField, val, store.data.securities.find(s => s.id === id)));
  store.save(); preserveTableScroll(renderSecMaster); // 一括変更後もスクロール位置を維持
  const fl = SM_BULK_FIELDS.find(f => f.key === smBulkField);
  toast(`${ids.length}件の「${fl ? fl.label : smBulkField}」を${smBulkField === 'clearOverrides' ? '削除' : '変更'}しました`, 4000);
}
// 保有銘柄一覧の一括変更（選択した .row-select に対して）
let holdBulkField = 'detailType';
function holdBulkFieldChange(f) { holdBulkField = f; const c = document.getElementById('hold-bulk-value-wrap'); if (c) c.innerHTML = bulkValueHtml(f, 'hold-bulk-value'); }
function holdBulkApply() {
  const ids = [...document.querySelectorAll('.row-select:checked')].map(b => parseInt(b.dataset.id, 10));
  if (!ids.length) { toast('銘柄を選択してください'); return; }
  const val = bulkConvert(holdBulkField, (document.getElementById('hold-bulk-value') || {}).value);
  for (const id of ids) store.updateSecurity(id, bulkPatch(holdBulkField, val, store.data.securities.find(s => s.id === id)));
  store.save(); preserveTableScroll(render); // 一括変更後もスクロール位置を維持
  const fl = SM_BULK_FIELDS.find(f => f.key === holdBulkField);
  toast(`${ids.length}件の「${fl ? fl.label : holdBulkField}」を${holdBulkField === 'clearOverrides' ? '削除' : '変更'}しました`, 4000);
}
function setSecMasterSort(key) {
  if (secMasterSort.key === key) secMasterSort.dir *= -1; else { secMasterSort.key = key; secMasterSort.dir = 1; }
  preserveTableScroll(renderSecMaster);
}
function setSecMasterFilter(v) { secMasterFilter = v; renderSecMaster(); }
function renderSecMaster() {
  const sk = secMasterSort.key, dir = secMasterSort.dir;
  const smHasPrice = (s) => { const p = store.data.prices[priceKey(s)]; return !!(p && p.price != null); };
  const smHasHolding = (s) => store.data.holdings.some(h => h.securityId === s.id && h.quantity > 0);
  const allSecs = [...store.data.securities].sort(sk === SM_DEFAULT_SORT ? smDefaultCmp
    : (a, b) => { const va = sortValue(a, sk), vb = sortValue(b, sk); if (va < vb) return -1 * dir; if (va > vb) return 1 * dir; return 0; });
  let secs = allSecs.filter(s => {
    if (secMasterFilter === 'noprice') return !smHasPrice(s);
    if (secMasterFilter === 'noholding') return !smHasHolding(s);
    if (secMasterFilter === 'holding') return smHasHolding(s);
    return true;
  });
  // 市場フィルター（全株式=US+JP / 米国株 / 日本株 / 投資信託）
  secs = secs.filter(s => secMasterMarket === 'ALL' ? (s.market === 'US' || s.market === 'JP') : s.market === secMasterMarket);
  if (secMasterSearch.trim()) {
    const k = searchNorm(secMasterSearch).trim();
    secs = secs.filter(s => searchNorm(s.ticker || '').includes(k) || searchNorm(calc.displayName(s)).includes(k) || searchNorm(calc.field(s, 'sector') || '').includes(k));
  }
  // 列フィルタ（分析・個別銘柄と共通パネル）
  secs = applyColFilters(secs, 'secmaster');
  // 編集モード(SEC-94): ナビゲーション用に編集可能列キー順（画面の列順）・行順を記録
  _ieCols = inlineEditOn ? ['detailType', 'ruleName', 'category', 'investCategory'] : [];
  _ieRowIds = inlineEditOn ? secs.map(s => s.id) : [];
  const cell = (v, l) => `<td class="${l ? 'l ' : ''}">${v != null && v !== '' ? esc(String(v)) : muted}</td>`;
  // ソート可能なヘッダ（sortValue が各キーに対応）
  const SM_COLS = [
    { k: 'ticker', l: 'コード', c: 'l col-code' }, { k: 'name', l: '銘柄名', c: 'l' }, { k: 'market', l: '市場', c: 'l' },
    { k: 'detailType', l: '詳細種別', c: 'l' },
    { k: 'sector', l: 'セクター', c: 'l' }, { k: 'industry', l: '業種', c: 'l' },
    { k: 'capToTop', l: '時価1位まで', c: '' },   // 市場の時価総額1位までの倍率（保有銘柄の同名列と同じ値）
    { k: 'rating', l: '格付', c: 'l' },
    { k: 'overallGrade', l: '総合評価', c: 'l' }, { k: 'buyGrade', l: '買い時評価', c: 'l' },
    { k: 'priority', l: '優先順位', c: '' }, { k: 'ruleName', l: '買い増しルール', c: 'l' }, { k: 'category', l: 'カテゴリ', c: 'l' }, { k: 'investCategory', l: '投資カテゴリ', c: 'l' },
    { k: 'createdAt', l: '追加日', c: 'l' }, { k: 'updatedAt', l: '更新日', c: 'l' },
  ];
  const smHead = '<th class="l"><input type="checkbox" onclick="smSelectAll(this.checked)" title="全選択"></th>'
    + SM_COLS.map(col => { const active = sk === col.k; const arrow = `<span class="sort-arrow">${active ? (dir > 0 ? '▲' : '▼') : ''}</span>`; return `<th class="${col.c} sortable${active ? ' active' : ''}" title="${esc(col.l)}" onclick="setSecMasterSort('${col.k}')">${col.l}${arrow}</th>`; }).join('') + '<th class="l"></th>';
  const rows = secs.map(s => {
    const rule = store.rule(s.ruleId);
    const ov = (k) => s[k + 'Override'] ? ' <span class="tag" title="手動上書き中">手</span>' : '';
    const dt = detailTypeOf(s);
    const dtTag = `<span class="tag detail-${dt === 'ETF' ? 'etf' : dt === '投資信託' ? 'fund' : 'stock'}">${esc(dt)}</span>${s.detailType ? '' : ' <span class="muted" style="font-size:10px" title="自動判定（未設定）">auto</span>'}`;
    return `<tr>
      <td class="l"><input type="checkbox" class="sm-check" value="${s.id}"></td>
      <td class="l col-code"><span class="tk ${s.market.toLowerCase()}" style="cursor:pointer" onclick="openSecurityDetail(${s.id})">${esc(s.ticker)}</span></td>
      <td class="l"><strong class="lnk-ext nm-strong" onclick="openSecurityDetail(${s.id})">${esc(calc.displayName(s))}</strong>${ov('name')}${s.enabled === false ? ' <span class="tag" title="無効">無効</span>' : ''}</td>
      <td class="l"><span class="tag ${s.market.toLowerCase()}">${MARKET_LABEL[s.market]}</span></td>
      ${inlineEditOn ? ieCellHtml(s, 'detailType', null) : `<td class="l">${dtTag}</td>`}
      <td class="l">${calc.field(s, 'sector') ? esc(jpInd(calc.field(s, 'sector'))) + ov('sector') : muted}</td>
      <td class="l">${calc.field(s, 'industry') ? esc(jpInd(calc.field(s, 'industry'))) + ov('industry') : muted}</td>
      ${cfInject(capToTopTd(s.market, calc.capToTop(s)), 'capToTop', calc.capToTop(s), 'master')}
      <td class="l">${gradeBadge(s)}</td>
      ${cell(s.overallGrade, true)}
      ${cell(s.buyGrade, true)}
      <td${cfStyle('priority', s.priority, 'master')}>${s.priority != null ? num(s.priority) : muted}</td>
      ${inlineEditOn ? ieCellHtml(s, 'ruleName', null) : `<td class="l">${rule ? esc(rule.name) : muted}</td>`}
      ${inlineEditOn ? ieCellHtml(s, 'category', null) : `<td class="l">${categoryTag(s.category)}</td>`}
      ${inlineEditOn ? ieCellHtml(s, 'investCategory', null) : `<td class="l">${investCategoryTag(s.investCategory)}</td>`}
      <td class="l">${s.createdAt ? fmtDate(s.createdAt) : muted}</td>
      <td class="l">${s.updatedAt ? fmtDate(s.updatedAt) : muted}</td>
      <td class="l nowrap"><button class="btn btn-sm" onclick="openSecurityForm(${s.id})">編集</button></td>
    </tr>`;
  }).join('');
  app.innerHTML = `
    <div class="section">
      <div class="section-head"><h2>銘柄マスタ（${allSecs.length} 件）</h2>
        <button class="btn btn-sm btn-primary" onclick="openSecurityForm()">＋ 銘柄を追加</button></div>
      <div class="section-body">
        <p class="muted" style="padding:10px 16px 0">名前・セクター・業種は「編集」から手動で上書きできます。「手」=手動上書き中。詳細種別の「auto」=自動判定（未設定）。<strong>「価格未取得」は実在しないティッカー/コードの可能性</strong>（価格更新後に抽出→全選択→一括削除で整理できます）。</p>
        <div class="toolbar" style="border:none;padding:10px 16px 0">
          <div class="seg">
            <button class="${secMasterMarket === 'ALL' ? 'active' : ''}" onclick="setSecMasterMarket('ALL')">全株式</button>
            <button class="${secMasterMarket === 'US' ? 'active' : ''}" onclick="setSecMasterMarket('US')">米国株</button>
            <button class="${secMasterMarket === 'JP' ? 'active' : ''}" onclick="setSecMasterMarket('JP')">日本株</button>
          </div>
          <div class="seg" style="margin-left:6px"><button class="${secMasterMarket === 'FUND' ? 'active' : ''}" onclick="setSecMasterMarket('FUND')">投資信託</button></div>
          <div class="search" style="max-width:260px">${svgIcon('search', '')}<input id="sm-search" placeholder="コード・銘柄名・セクターで検索" value="${esc(secMasterSearch)}" oninput="setSecMasterSearch(this.value)" autocomplete="off">${secMasterSearch ? `<button class="clr" onclick="setSecMasterSearch('')">×</button>` : ''}</div>
          <span class="muted">抽出</span>
          <div class="seg">${['all', '全て', 'noprice', '価格未取得', 'noholding', '保有なし', 'holding', '保有あり'].reduce((acc, _, i, arr) => { if (i % 2) acc.push(`<button class="${secMasterFilter === arr[i - 1] ? 'active' : ''}" onclick="setSecMasterFilter('${arr[i - 1]}')">${arr[i]}</button>`); return acc; }, []).join('')}</div>
          ${filterBtnHtml('secmaster')}
          <span class="muted">${secs.length}/${allSecs.length}件</span>
        </div>
        <div id="flt-host-secmaster">${fltState.secmaster.open ? `<div style="padding:0 16px">${filterPanelHtml('secmaster')}</div>` : ''}</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 16px 0">
          <span class="muted">選択した銘柄の</span>
          <select onchange="smBulkFieldChange(this.value)">${SM_BULK_FIELDS.map(f => `<option value="${f.key}" ${smBulkField === f.key ? 'selected' : ''}>${f.label}</option>`).join('')}</select>
          <span class="muted">を</span>
          <span id="sm-bulk-value-wrap">${bulkValueHtml(smBulkField, 'sm-bulk-value')}</span>
          <span class="muted">に</span>
          <button class="btn btn-sm btn-primary" onclick="smBulkApply()">一括変更</button>
          <span style="flex:1"></span>
          <button class="btn btn-sm btn-danger" onclick="bulkDeleteSecurities()">選択した銘柄を削除</button>
          <button class="btn btn-sm ${inlineEditOn ? 'btn-primary' : ''}" onclick="toggleInlineEdit()" title="一覧上で直接編集（誤操作防止トグル）">${svgIcon('edit', '')} 編集モード${inlineEditOn ? '：ON' : ''}</button>
        </div>
        ${inlineEditOn ? `<div class="ie-hint" style="margin:8px 16px 0">✏️ 編集モード：詳細種別・買い増しルール・カテゴリを直接編集 → <strong>「保存」</strong>で確定。<strong>Tab</strong>=右 / <strong>Enter</strong>=下 / <strong>Esc</strong>=このセルを取消。
          <span class="tb-spacer"></span>
          <span id="ie-pending" class="ie-pending">変更なし</span>
          <button class="btn btn-sm btn-primary" onclick="ieSaveAll()">保存</button>
          <button class="btn btn-sm" onclick="ieDiscardAll()">取消（破棄）</button>
          <button class="btn btn-sm" onclick="toggleInlineEdit()">編集モード終了</button></div>` : ''}
        <div class="table-wrap"><table class="holdings dense no-rowclick ${inlineEditOn ? 'ie-on' : ''}">
          <thead><tr>${smHead}</tr></thead>
          <tbody>${rows || `<tr><td colspan="15" class="empty">銘柄がありません。</td></tr>`}</tbody>
        </table></div>
      </div>
    </div>`;
  applyStickyCols(document.querySelector('#app table.no-rowclick'));
  scheduleFit(); // 市場/抽出/検索/ソート等で renderSecMaster() を直接呼ばれた時も枠内スクロール化（render() を経由しないため自前で）
}

// 投資信託コード（名称↔内部コード）マスタ。投信はコードが無いため自動採番＝ここで協会コード等に編集可
// 投信コードマスタはモーダルで開く（マスタ・設定の画面には常時表示しない）
function openFundCodeMaster() {
  const fundSecs = store.data.securities.filter(s => s.market === 'FUND').sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
  const rows = fundSecs.map(s => {
    const accts = store.data.holdings.filter(h => h.securityId === s.id && h.quantity > 0).length;
    const fetched = (store.data.meta[priceKey(s)] || {}).name;
    const disp = fetched || s.name || s.ticker;
    const importNames = [s.name, ...(s.aliasNames || [])].filter(Boolean);
    const impHtml = importNames.length ? importNames.map(n => esc(n)).join('<br>') : '—';
    return `<tr>
      <td class="l" style="width:150px;white-space:nowrap"><input type="text" value="${esc(s.ticker)}" onchange="setFundCode(${s.id}, this.value)" style="width:130px;font-family:monospace" title="協会コード等に変更可"></td>
      <td class="l" style="white-space:normal"><strong>${esc(disp)}</strong>${fetched ? ' <span class="tag" title="協会コードから取得した正式名称">取得</span>' : ' <span class="muted" style="font-size:11px">未取得</span>'}</td>
      <td class="l muted" style="font-size:11px;white-space:normal">${impHtml}</td>
      <td style="width:70px;white-space:nowrap">${accts}口座</td>
      <td class="l nowrap" style="width:96px"><button class="btn btn-sm" onclick="fetchFundName(${s.id})" title="協会コードから名称を取得">名称取得</button></td>
    </tr>`;
  }).join('');
  showModal('投資信託 コードマスタ（名称↔コード）', `
    <p class="muted" style="margin:0 0 10px">投信はコードが無いため内部コード（FND…）を自動採番しています。<strong>協会コード（8桁）</strong>を入れて「名称取得」すると正式名称を取得し表示名に反映します（取込時は<strong>取込名</strong>でこのコードに紐づきます）。同じコードを付けると同一ファンドとして統合します。</p>
    ${fundSecs.length ? `<div class="table-wrap" style="max-height:66vh"><table class="holdings dense no-rowclick" style="width:100%;table-layout:auto">${'<thead><tr><th class="l">コード</th><th class="l">表示名（取得した正式名称）</th><th class="l">取込名（CSVの名称・証券会社別に複数可）</th><th>保有</th><th></th></tr></thead>'}<tbody>${rows}</tbody></table></div>` : '<div class="empty">取り込んだ投資信託はありません。「取込」タブから取り込めます。</div>'}
    <div class="form-actions">
      ${fundSecs.length ? '<button type="button" class="btn" onclick="fetchFundName()">全件 名称取得</button>' : ''}
      <button type="button" class="btn btn-primary" onclick="closeModal()">閉じる</button>
    </div>`, { wide: true });
  // 横スクロール不要なように画面いっぱいに広げる（名称は折り返し）
  const mw = document.querySelector('#modal-overlay .modal'); if (mw) mw.style.maxWidth = 'min(1500px,95vw)';
}
// 編集後の再描画: コードマスタのモーダルが開いていればそれを、無ければマスタ画面を再描画
function refreshFundCodeMaster() {
  const body = document.getElementById('modal-body');
  const open = body && !document.getElementById('modal-overlay').hidden && body.querySelector('input[onchange^="setFundCode"]');
  if (open) openFundCodeMaster(); else renderMaster();
}
// 投信の協会コードから正式名称を取得（/api/info）。取得名は meta に入り表示名に優先反映
function fetchFundName(secId) {
  const targets = secId != null
    ? store.data.securities.filter(s => s.id === secId && s.market === 'FUND')
    : store.data.securities.filter(s => s.market === 'FUND');
  if (!targets.length) { toast('対象の投資信託がありません'); return; }
  const bad = targets.filter(s => !/^[0-9A-Za-z]{8}$/.test(s.ticker || ''));
  if (secId != null && bad.length) { toast('協会コード（8桁）を入力してから取得してください'); return; }
  withBusy('名称を取得中…', async () => {
    await api.refreshMeta(targets.filter(s => /^[0-9A-Za-z]{8}$/.test(s.ticker || '')));
    refreshFundCodeMaster();
  }, secId != null ? ((store.data.meta[priceKey(targets[0])] || {}).name ? `名称取得: ${(store.data.meta[priceKey(targets[0])] || {}).name}` : '名称を取得できませんでした') : '名称取得を実行しました').catch(() => {});
}
function setFundCode(secId, raw) {
  const sec = store.data.securities.find(s => s.id === secId); if (!sec) return;
  const nc = (raw || '').trim();
  if (!nc) { toast('コードを入力してください'); refreshFundCodeMaster(); return; }
  if (nc === sec.ticker) return;
  // 同じコードが既にある＝同じファンド（証券会社で名称が違うだけ）→ 統合する
  const dup = store.data.securities.find(s => s.market === 'FUND' && s.id !== secId && s.ticker === nc);
  if (dup) {
    if (!confirm(`コード ${nc} は既に「${dup.name}」に使われています。同じファンドとして「${sec.name}」を統合しますか？\n（保有は両方ぶん合算され、「${sec.name}」の登録は削除されます）`)) { refreshFundCodeMaster(); return; }
    mergeFundInto(sec, dup);
    return;
  }
  const old = sec.ticker;
  if (store.data.prices['FUND:' + old]) { store.data.prices['FUND:' + nc] = store.data.prices['FUND:' + old]; delete store.data.prices['FUND:' + old]; }
  // meta も付け替え（名称キャッシュ等）
  if (store.data.meta['FUND:' + old]) { store.data.meta['FUND:' + nc] = store.data.meta['FUND:' + old]; delete store.data.meta['FUND:' + old]; }
  sec.ticker = nc; sec.updatedAt = store._now();
  store.save(); refreshFundCodeMaster();
  toast(`コードを ${nc} に変更しました`, 3000);
}
// 投信銘柄 from を to へ統合（保有を移管。同一証券会社・口座は数量合算＝加重平均取得単価）。from は削除
function mergeFundInto(from, to) {
  for (const h of store.data.holdings.filter(x => x.securityId === from.id)) {
    const same = store.data.holdings.find(x => x.securityId === to.id && x.broker === h.broker && x.accountType === h.accountType);
    if (same) {
      const q = (same.quantity || 0) + (h.quantity || 0);
      same.avgCost = q ? ((same.quantity || 0) * (same.avgCost || 0) + (h.quantity || 0) * (h.avgCost || 0)) / q : 0;
      same.quantity = q; same.updatedAt = store._now();
      h.quantity = 0; h._merged = true;
    } else {
      h.securityId = to.id; h.updatedAt = store._now();
    }
  }
  store.data.holdings = store.data.holdings.filter(h => !h._merged);
  // 消す側の取込名（証券会社ごとの別表記）をエイリアスとして保持→次回取込でも同一ファンドに紐づく
  const toKey = normFundName(to.name);
  const names = [...(to.aliasNames || []), ...(from.aliasNames || []), from.name]
    .filter(Boolean).filter(n => normFundName(n) !== toKey);
  to.aliasNames = [...new Set(names)]; to.updatedAt = store._now();
  delete store.data.prices['FUND:' + from.ticker];
  delete store.data.meta['FUND:' + from.ticker];
  store.data.securities = store.data.securities.filter(s => s.id !== from.id);
  store.save(); refreshFundCodeMaster();
  toast(`「${from.name}」を ${to.ticker}（${to.name}）に統合しました`, 4000);
}

// ---------- マスタ・設定 ----------
// マスタ・設定のランチャー定義（プルダウン選択→「開く」で各マスタをモーダル表示）
const MASTER_LAUNCH = [
  { v: 'category', label: 'カテゴリ別 金額マスタ', open: () => openCategoryMaster(), note: '銘柄カテゴリごとの1回購入額（日本株円・米国株$）と変更履歴。' },
  { v: 'investcat', label: '投資カテゴリ マスタ', open: () => openInvestCategoryMaster(), note: '分析枠のラベル（高配当・テーマ株など）。金額とは無関係の別管理。' },
  { v: 'label',    label: '銘柄ラベル マスタ', open: () => openLabelMaster(), note: '1銘柄に複数付けられる投資テーマ/分類タグ（半導体・宇宙・防衛・高配当）。フィルタ＋一括で前提崩れ時の判断に。' },
  { v: 'rule',     label: '買い増しルールマスタ', open: () => openRuleMaster(),     note: '初回/買い増しの下落率・基準高値のルール。銘柄ごとの割当は各銘柄の編集から。' },
  { v: 'grade',    label: '銘柄格付けマスタ',     open: () => openGradeMaster(),    note: '銘柄格付け（S/A/B/C/D）の一覧・詳細での表示色を設定。' },
  { v: 'matrix',   label: 'マトリックス レンジ設定', open: () => openMatrixBandMaster(), note: 'レポートの分布マトリックスの取得額レンジ（色・しきい値）。米株円換算は共通レートを使用。' },
  { v: 'fxrate',   label: 'ドル円換算レート（マスタ評価用）', open: () => openFxRateMaster(), note: '米国株($)を円換算して評価する共通レート（初期100円）。背景色ルールのUS金額判定とマトリックスの取得額換算で共用。' },
  { v: 'defbroker', label: '取引の既定 証券会社（未保有の銘柄）', open: () => openDefaultBrokerMaster(), note: '取引記録フォームの証券会社の初期値（日本株・米国株それぞれ）。保有・取引履歴がある銘柄はそちらが優先。' },
  { v: 'fund',     label: '投資信託 コードマスタ', open: () => openFundCodeMaster(), note: '取り込んだ投信のコード（協会コード）編集・名称取得・統合。' },
  { v: 'alias',    label: '取込変換マスタ',         open: () => openImportAliasMaster(), note: '取込時の「マスタに無い値」の変換対応（カテゴリ/格付/詳細種別/ルール）。' },
  { v: 'cf',       label: '列の背景色ルール',       open: () => openCfRulesMaster(),  note: '数値列の値の範囲ごとの背景色。適用画面（保有/サイン/マスタ/マーケット）を複数選択可。' },
  { v: 'notify',   label: '通知メール設定',         open: () => openNotifyMaster(),   note: '買い増しサイン通知メールの件名・本文をテンプレート（差し込み記号）で自由に編集。日本株/米国株・到達/接近で別々に設定可。' },
  { v: 'disctype', label: '開示種別マスタ（分類・キーワード）', open: () => openDiscTypeMaster(), note: 'ニュースの開示（TDnet/EDGAR）を見出しキーワードで種別分類。種別名（タグ）・まとめ（フィルタタブ）・キーワードを編集可。' },
  { v: 'ytchannel', label: 'YouTubeチャンネル（動画取得元）', open: () => openYtChannelMaster(), note: 'ニュースの「動画」に出す購読チャンネル。チャンネルID（UCで始まる）と表示名を登録。' },
  { v: 'listed', label: '上場銘柄マスタ（自動タグ用）', open: () => openListedMaster(), note: 'JPXの上場銘柄一覧（コード＋銘柄名）を取り込むと、保有外の全上場銘柄もニュース見出しで自動タグ。' },
  { v: 'navorder', label: '画面（タブ）の並び順', open: () => openNavOrderMaster(), note: '左メニューの画面の並びをグループ内で入れ替え。よく使う画面を上に。' },
  { v: 'storage', label: '保存容量（ブラウザ）', open: () => openStorageMaster(), note: 'localStorage の使用量をキー別に確認。上限に達すると「保存失敗」になるので、再取得できるキャッシュをここで整理できる。' },
];

// ---------- 保存容量（localStorage 診断） ----------
// 銘柄情報の「取得OK・保存失敗（容量不足の可能性）」など、保存が通らない時の原因調査用。
// localStorage は1オリジン約5MB。どのキーが食っているかを可視化し、再取得できるキャッシュだけ整理する。
const STORAGE_NOTES = {
  securities: '銘柄マスタ（消さない）', holdings: '保有（消さない）', transactions: '取引履歴（消さない）',
  acqLedger: '取得円台帳（消さない）', analyses: '銘柄分析の履歴（消さない）',
  meta: '銘柄情報キャッシュ（再取得可）', prices: '価格キャッシュ（再取得可）',
  techAnalysis: 'テクニカル分析結果（IndexedDB保存・再取得可）', newsPool: 'ニュース一覧（再取得可）',
  newsTrans: 'ニュース翻訳（再取得可）', mktRanking: 'マーケットランキング（再取得可）',
  indices: '参考指数（再取得可）', macro: 'マクロ指標（再取得可）', macroIdx: '指数・為替履歴（再取得可）',
  earnings: '決算日（再取得可）', listedMaster: '上場銘柄マスタ（取込データ・再取込可）',
  updates: '更新情報フィード（再取得可）', amountSnapshots: '金額スナップショット',
};
function jsonSize(v) { try { return JSON.stringify(v).length; } catch (_) { return 0; } }
function storageBreakdown() {
  const d = store.data || {};
  // techAnalysis は IndexedDB 保存（§16.7.5）のため localStorage(sm_data_v1) には含まれない。別枠で表示する
  const rows = Object.keys(d).filter(k => !(idb.ok && k === 'techAnalysis'))
    .map(k => ({ k, size: jsonSize(d[k]) })).filter(r => r.size > 2).sort((a, b) => b.size - a.size);
  return { rows, total: rows.reduce((a, r) => a + r.size, 0) };
}
function fmtKB(n) { return (n / 1024).toFixed(1) + ' KB'; }
// localStorage の全キー（sm_data_v1 本体・列設定 等）の実使用量。
// 同期の基準(syncBase)とテクニカル分析(techAnalysis)は IndexedDB 保存（§16.7.5）で、この5MB枠には入らない。
// 旧形式の sm_sync_base（localStorage）が残っていれば次の同期時に IDB へ移して消える。
function rawStorageRows() {
  const rows = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      rows.push({ k, size: k.length + (localStorage.getItem(k) || '').length });
    }
  } catch (_) { }
  return rows.sort((a, b) => b.size - a.size);
}
// techAnalysis のフィールド別内訳（どの項目が容量を食っているかの特定用）
function techFieldBreakdown() {
  const ta = (store.data && store.data.techAnalysis) || {};
  const keys = Object.keys(ta);
  const sum = {};
  for (const k of keys) { const r = ta[k] || {}; for (const f in r) sum[f] = (sum[f] || 0) + jsonSize(r[f]); }
  return { count: keys.length, rows: Object.keys(sum).map(f => ({ f, size: sum[f] })).sort((a, b) => b.size - a.size) };
}
async function openStorageMaster() {
  const { rows, total } = storageBreakdown();
  const raws = rawStorageRows();
  const tech = techFieldBreakdown();
  const all = raws.reduce((a, r) => a + r.size, 0);
  const pct = Math.round(all / (5 * 1024 * 1024) * 100);
  // IndexedDB 側（5MB枠の外・§16.7.5）: techAnalysis と同期の基準(syncBase)
  const techSize = jsonSize(store.data.techAnalysis);
  let baseSize = 0;
  if (idb.ok) { try { const b = await idb.get('syncBase'); baseSize = (typeof b === 'string') ? b.length : 0; } catch (_) {} }
  const idbRows = idb.ok ? [
    { k: 'techAnalysis', size: techSize, note: `テクニカル分析結果 ${tech.count}件（再取得可）` },
    { k: 'syncBase', size: baseSize, note: '同期の基準（アプリデータのコピー・同期のたびに更新）' },
  ] : [];
  const sizeTable = (list, label, nameOf) => `
    <div class="table-wrap" style="max-height:28vh">
      <table class="table"><thead><tr><th class="l">${label}</th><th class="r">サイズ</th><th class="l">内容</th></tr></thead>
        <tbody>${list.map(r => `<tr><td class="l">${esc(r.k || r.f)}</td><td class="r">${fmtKB(r.size)}</td><td class="l muted">${esc(nameOf(r))}</td></tr>`).join('')}</tbody></table>
    </div>`;
  showModal('保存容量（ブラウザ）', `
    <p class="muted">ブラウザの保存領域（localStorage）は1サイト約5MBです。上限に達すると銘柄情報などが
      <b>「取得OK・保存失敗（容量不足の可能性）」</b>になります。</p>
    <p><b>アプリのデータ ${fmtKB(total)}</b> ／ localStorage 全体 ${fmtKB(all)}（上限約5MBの${pct}%）${idb.ok ? `<br>IndexedDB ${fmtKB(techSize + baseSize)}<span class="muted">（別枠・上限はGB級。テクニカル分析と同期の基準はこちら）</span>` : ''}</p>
    <fieldset class="form-group"><legend>アプリのデータ（sm_data_v1）の内訳</legend>
      ${sizeTable(rows, 'キー', r => STORAGE_NOTES[r.k] || '')}
    </fieldset>
    <fieldset class="form-group"><legend>localStorage 全キー（上限約5MBの対象）</legend>
      ${sizeTable(raws, 'キー', r => r.k === 'sm_sync_base' ? '旧形式の同期基準（現在は IndexedDB 保存。次の同期時に自動で消える）' : r.k === STORAGE_KEY ? 'アプリのデータ本体' : '')}
    </fieldset>
    ${idb.ok ? `<fieldset class="form-group"><legend>IndexedDB（5MB制限の対象外）</legend>
      ${sizeTable(idbRows, 'キー', r => r.note || '')}
    </fieldset>` : ''}
    <fieldset class="form-group"><legend>テクニカル分析（${tech.count}件）のフィールド別内訳</legend>
      ${sizeTable(tech.rows, '項目', () => '')}
    </fieldset>
    <div class="form-actions" style="flex-wrap:wrap">
      <button type="button" class="btn" id="stg-copy" title="この内訳をコピー（相談用）">内訳をコピー</button>
      <button type="button" class="btn" id="stg-free" title="市場ランキング・参考指数・翻訳・マクロ・登録外の分析結果を消す（「更新」で取り直せます）">再取得できるキャッシュを整理</button>
      <button type="button" class="btn" id="stg-tech" title="保存済みのテクニカル分析結果を全部消す（分析タブで再実行すれば戻ります）">テクニカル分析の結果を消す</button>
      <button type="button" class="btn" id="stg-news" title="ニュース一覧の保存分を消す（「更新」で取り直せます）">ニュース一覧も消す</button>
      <button type="button" class="btn" id="stg-base" title="同期の基準データ（アプリデータのコピー）を捨てる。次の同期で作り直されます">同期の基準を作り直す</button>
      <button type="button" class="btn btn-primary" onclick="closeModal()">閉じる</button>
    </div>`);
  // 押しても何も起きない（＝整理できるものが無かった/例外）が分からないと詰むので、必ず結果をトーストで返す
  const act = (fn) => () => {
    try {
      const msg = fn();
      if (msg) toast(msg, 5000);
      openStorageMaster();
    } catch (e) { console.warn('[storage]', e); toast('整理できませんでした: ' + (e && e.message || e), 6000); }
  };
  document.getElementById('stg-copy').onclick = () => {
    const txt = `アプリ ${fmtKB(total)} / localStorage全体 ${fmtKB(all)} / IndexedDB ${fmtKB(techSize + baseSize)}\n`
      + rows.map(r => `${r.k}\t${fmtKB(r.size)}`).join('\n')
      + `\n--- localStorage 全体 ---\n` + raws.map(r => `${r.k}\t${fmtKB(r.size)}`).join('\n')
      + `\n--- IndexedDB ---\n` + idbRows.map(r => `${r.k}\t${fmtKB(r.size)}`).join('\n')
      + `\n--- techAnalysis ${tech.count}件 ---\n` + tech.rows.map(r => `${r.f}\t${fmtKB(r.size)}`).join('\n');
    navigator.clipboard.writeText(txt).then(() => toast('内訳をコピーしました'), () => toast('コピーできませんでした'));
  };
  document.getElementById('stg-free').onclick = act(() => {
    const freed = store._freeCacheSpace();
    store.save();
    return freed > 0 ? `約${Math.round(freed / 1024)}KB を整理しました` : '整理できるキャッシュはありませんでした（下の個別ボタンを使ってください）';
  });
  document.getElementById('stg-tech').onclick = act(() => {
    if (!confirm(`保存済みのテクニカル分析結果（${tech.count}件）を全部消します。分析タブで再実行すれば取り直せます。よろしいですか？`)) return '';
    const freed = jsonSize(store.data.techAnalysis);
    store.data.techAnalysis = {}; store.save();
    return `テクニカル分析 約${Math.round(freed / 1024)}KB を消しました`;
  });
  document.getElementById('stg-news').onclick = act(() => {
    if (!confirm('保存済みのニュース一覧を消します（ニュース画面の「更新」で取り直せます）。よろしいですか？')) return '';
    const freed = jsonSize(store.data.newsPool);
    store.data.newsPool = null; store.save();
    return `ニュース一覧 約${Math.round(freed / 1024)}KB を消しました`;
  });
  document.getElementById('stg-base').onclick = act(() => {
    if (!confirm('同期の基準データ（アプリデータのコピー）を捨てます。次回の同期で作り直されますが、それまでに他端末で削除した銘柄などが復活することがあります。よろしいですか？')) return '';
    const freed = baseSize || (localStorage.getItem('sm_sync_base') || '').length;
    dsync._clearBase();
    return `同期の基準 約${Math.round(freed / 1024)}KB を消しました（次の同期で作り直されます）`;
  });
}

// ---------- 画面（タブ）の並び順マスタ ----------
// 保存: store.data.settings.navOrder = { グループ名: [viewId, ...] }（Google同期対象。settings はキー単位マージ
// ＝keyedTs なので、他端末が別の設定を変えても並び順は巻き戻らない。2026-08-06 に singleTs から変更）。
// 未知IDは無視、未登録IDは既定順のまま末尾に残す（画面追加時に設定が壊れない）。
function navOrderedGroups() {
  // 起動時の renderNav() は store.load() より前に走るため store.data がまだ null。必ずガードする
  // （ガード漏れで起動が止まり、画面が真っ白になった。2026-08-05）
  const saved = (store.data && store.data.settings && store.data.settings.navOrder) || {};
  return NAV_GROUPS.map(grp => {
    const order = Array.isArray(saved[grp.group]) ? saved[grp.group] : null;
    if (!order) return grp;
    const byId = new Map(grp.items.map(it => [it.id, it]));
    const sorted = order.map(id => byId.get(id)).filter(Boolean);
    const rest = grp.items.filter(it => !order.includes(it.id));   // 設定後に追加された画面は末尾へ
    return { ...grp, items: [...sorted, ...rest] };
  });
}
function openNavOrderMaster() {
  const groups = navOrderedGroups();
  const listHtml = groups.map(grp => `
    <fieldset class="form-group"><legend>${esc(grp.group)}</legend>
      <div class="nav-order-list" data-group="${esc(grp.group)}">
        ${grp.items.map(it => `<div class="nav-order-row" data-id="${it.id}">
          <span class="nm">${navIcon(it.icon)}<span>${esc(it.label)}</span></span>
          <span class="acts"><button type="button" class="btn btn-sm" data-mv="up" title="上へ">▲</button><button type="button" class="btn btn-sm" data-mv="down" title="下へ">▼</button></span>
        </div>`).join('')}
      </div>
    </fieldset>`).join('');
  showModal('画面（タブ）の並び順', `
    <p class="muted">左メニューの並びを変えます。▲▼で入れ替え（グループをまたぐ移動はできません）。</p>
    ${listHtml}
    <div class="form-actions">
      <button type="button" class="btn" onclick="openNavOrderMaster()" title="既定の並びに戻す（保存はされません）" id="nav-order-reset">既定に戻す</button>
      <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
      <button type="button" class="btn btn-primary" id="nav-order-save">保存</button>
    </div>`);
  document.querySelectorAll('.nav-order-row [data-mv]').forEach(b => {
    b.onclick = () => {
      const row = b.closest('.nav-order-row');
      const sib = b.dataset.mv === 'up' ? row.previousElementSibling : row.nextElementSibling;
      if (!sib) return;
      if (b.dataset.mv === 'up') row.parentNode.insertBefore(row, sib);
      else row.parentNode.insertBefore(sib, row);
    };
  });
  document.getElementById('nav-order-reset').onclick = () => {
    if (!store.data.settings.navOrder) { closeModal(); return; }
    delete store.data.settings.navOrder;
    store.data.settings._updatedAt = store._now(); store.save();
    closeModal(); renderNav(); toast('画面の並びを既定に戻しました');
  };
  document.getElementById('nav-order-save').onclick = () => {
    const navOrder = {};
    document.querySelectorAll('.nav-order-list').forEach(list => {
      navOrder[list.dataset.group] = [...list.querySelectorAll('.nav-order-row')].map(r => r.dataset.id);
    });
    store.data.settings.navOrder = navOrder;
    store.data.settings._updatedAt = store._now(); store.save();
    closeModal(); renderNav(); toast('画面の並びを保存しました');
  };
}
// ---------- 上場銘柄マスタ（自動タグ用・JPX一覧の取込） ----------
// 保存容量対策: store.data.listedMaster は「CODE\tNAME\n…」のコンパクト文字列で保持（配列JSONより約57%小さい）。
// 旧バージョンの配列形式[{code,name}]も後方互換で読める。読み出しは listedMasterArr()（文字列パースをメモ化）。
let _listedArrCache = null, _listedArrRaw = null;
function listedMasterArr() {
  const raw = store.data.listedMaster;
  if (Array.isArray(raw)) return raw;                       // 旧形式（配列）
  if (typeof raw !== 'string' || !raw) return [];
  if (_listedArrRaw === raw && _listedArrCache) return _listedArrCache;
  const arr = [];
  for (const l of raw.split('\n')) { const i = l.indexOf('\t'); if (i > 0) arr.push({ code: l.slice(0, i), name: l.slice(i + 1) }); }
  _listedArrRaw = raw; _listedArrCache = arr;
  return arr;
}
function listedMasterCount() { const r = store.data.listedMaster; return Array.isArray(r) ? r.length : (typeof r === 'string' && r ? r.split('\n').length : 0); }
function setListedMaster(list) { store.data.listedMaster = (list || []).map(x => x.code + '\t' + x.name).join('\n'); _listedArrCache = null; _listedArrRaw = null; }
// JPXの「東証上場銘柄一覧(data_j.xls)」をそのままドラッグ&ドロップ/選択（またはCSV貼付）→取込。コード列/銘柄名列/日付列を自動判定。
// 行配列（[[セル,…],…]）から {code,name} を抽出し、ファイル内の「日付」（いつ時点の一覧か）も拾う。貼付テキスト・Excel(SheetJS)共通。
// 先頭行に「コード/銘柄名」ヘッダがあれば列を特定、無ければ各行から4桁(＋1英数)コード列を探して隣を名称にフォールバック。
// 返り値: { list:[{code,name}], date:'YYYYMMDD'|'' }
function parseListedRows(rows) {
  rows = (rows || []).map(r => (Array.isArray(r) ? r : [r]).map(c => (c == null ? '' : String(c)))).filter(r => r.some(c => c.trim()));
  if (!rows.length) return { list: [], date: '' };
  let codeIdx = -1, nameIdx = -1, dateIdx = -1, start = 0;
  rows[0].forEach((h, i) => {
    const c = h.trim();
    if (codeIdx < 0 && /^(コード|銘柄コード|証券コード|code)$/i.test(c)) codeIdx = i;
    if (nameIdx < 0 && /^(銘柄名|会社名|名称|name)$/i.test(c)) nameIdx = i;
    if (dateIdx < 0 && /^(日付|基準日|date)$/i.test(c)) dateIdx = i;
  });
  if (codeIdx >= 0 && nameIdx >= 0) start = 1;
  const pickDate = (v) => { const s = String(v || '').replace(/[^0-9]/g, ''); return /^\d{8}$/.test(s) ? s : ''; };
  let date = '';
  if (dateIdx >= 0 && rows[start]) date = pickDate(rows[start][dateIdx]);
  if (!date) for (const c of (rows[start] || [])) { const d = pickDate(c); if (d) { date = d; break; } } // ヘッダ無し時は先頭行の8桁日付を探す
  const out = [], seen = new Set();
  for (let r = start; r < rows.length; r++) {
    const row = rows[r]; let code, name;
    if (codeIdx >= 0) { code = (row[codeIdx] || '').trim(); name = (row[nameIdx] || '').trim(); }
    else { const ci = row.findIndex(c => /^[0-9]{3}[0-9A-Za-z][0-9A-Za-z]?$/.test((c || '').trim())); if (ci < 0) continue; code = (row[ci] || '').trim(); name = (row[ci + 1] || '').trim(); }
    // JPXコードは4文字（4桁=7203 / 3桁+英字=130A）。ファイルによっては末尾0埋めの5桁(13010・130A0)なので先頭4文字へ丸める
    code = code.replace(/[^0-9A-Za-z]/g, '');
    const m = code.match(/^([0-9]{3}[0-9A-Za-z])[0-9]?$/); if (m) code = m[1];
    if (!/^[0-9]{3}[0-9A-Za-z]$/.test(code) || !name || seen.has(code)) continue;
    seen.add(code); out.push({ code, name });
  }
  return { list: out, date };
}
function parseListedMaster(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  return parseListedRows(lines.map(l => l.includes('\t') ? l.split('\t') : l.split(',')));
}
// SheetJS(xlsx) を必要時のみ遅延読込（通常のページ表示は軽いまま。.xls/.xlsx 双方に対応）。
// まず同一オリジンの同梱ファイルを読み、失敗時のみCDNへフォールバック（本番でCDNが不通/遮断でも取り込めるように同梱を優先）。
let _xlsxLoading = null;
function _loadScriptOnce(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('load fail: ' + src)); document.head.appendChild(s); });
}
function ensureXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (_xlsxLoading) return _xlsxLoading;
  _xlsxLoading = (async () => {
    try { await _loadScriptOnce('xlsx.full.min.js?v=0.18.5'); }
    catch (_) { await _loadScriptOnce('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'); }
    if (!window.XLSX) throw new Error('Excel読込ライブラリを読み込めませんでした。CSVでお試しください');
    return window.XLSX;
  })();
  return _xlsxLoading;
}
// data_j.xls などをそのまま取り込む（選択/ドロップ共通）。CSVはSheetJS不要で即パース、.xls/.xlsxはSheetJSで先頭シートを行配列化。
async function importListedFromFile(file) {
  if (!file) return;
  try {
    const res = await withBusy('ファイルを読み込み中…', async () => {
      let parsed;
      if (/\.csv$/i.test(file.name || '')) parsed = parseListedMaster(await file.text());
      else {
        const XLSX = await ensureXlsx();
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        parsed = parseListedRows(XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }));
      }
      if (!parsed.list.length) throw new Error('コード・銘柄名を読み取れませんでした（ファイルをご確認ください）');
      setListedMaster(parsed.list);
      // _updatedAt: 同期の bulkTs 規則が「新しい取込」を勝たせるための編集時刻（未取込端末の空に負けない）
      store.data.listedMasterInfo = { date: parsed.date || '', importedAt: store._now ? store._now() : Date.now(), count: parsed.list.length, fileName: file.name || '', _updatedAt: store._now() };
      store.save();
      _majorsListCache = null; _majorsMemo.clear();
      return parsed;
    }, null);
    closeModal();
    if (currentView === 'news') renderNews();
    toast(`${res.list.length.toLocaleString('ja-JP')} 銘柄を取り込みました${res.date ? `（${fmtListedDate(res.date)} 時点）` : ''}`);
  } catch (_) { /* エラーは busyDone が表示 */ }
}
function importListedFile(input) { const f = input.files && input.files[0]; input.value = ''; return importListedFromFile(f); }
// ドラッグ&ドロップ
function listedDragOver(ev) { ev.preventDefault(); const dz = document.getElementById('listed-dz'); if (dz) { dz.style.borderColor = 'var(--accent, #4a90d9)'; dz.style.background = 'rgba(74,144,217,.08)'; } }
function listedDragLeave(ev) { if (ev) ev.preventDefault(); const dz = document.getElementById('listed-dz'); if (dz) { dz.style.borderColor = ''; dz.style.background = ''; } }
function listedDrop(ev) { ev.preventDefault(); listedDragLeave(); const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]; if (f) importListedFromFile(f); }
function fmtListedDate(d) { return /^\d{8}$/.test(d || '') ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : (d || ''); }
function openListedMaster() {
  const curCount = listedMasterCount();
  const info = store.data.listedMasterInfo || {};
  const dateStr = fmtListedDate(info.date);
  const impStr = info.importedAt ? new Date(info.importedAt).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const curLine = curCount
    ? `現在の登録: <b>${curCount.toLocaleString('ja-JP')} 銘柄</b>${dateStr ? ` ・ <b>${dateStr}</b> 時点のデータ` : ''}${impStr ? ` <span class="muted">（${impStr} 取込）</span>` : ''}`
    : '現在の登録: <b>未登録</b>';
  showModal('上場銘柄マスタ（自動タグ用）', `
    <p class="muted" style="margin:0 0 8px;font-size:12px">${curLine}。ここに登録した銘柄は、保有していなくてもニュース見出し・本文に社名/コードが出れば自動でタグ（枠線・クリックで株探）されます。</p>
    <fieldset class="form-group"><legend>取り込み方（JPXの公式一覧）</legend>
      <ol class="muted" style="margin:0;padding-left:18px;font-size:12px;line-height:1.7">
        <li>JPX「東証上場銘柄一覧」ページを開く → <b>data_j.xls</b> をダウンロード（<code>jpx.co.jp/markets/statistics-equities/misc/01.html</code>）</li>
        <li>下の枠に <b>data_j.xls をドラッグ＆ドロップ</b>（またはクリックで選択）するだけ。Excelで開き直す必要はありません。「コード」「銘柄名」「日付」列を自動判定します（ETF/REIT等も含めてOK）</li>
      </ol></fieldset>
    <div id="listed-dz" ondragover="listedDragOver(event)" ondragleave="listedDragLeave(event)" ondrop="listedDrop(event)"
      style="border:2px dashed var(--border,#ccc); border-radius:10px; padding:22px 14px; text-align:center; transition:.15s; margin:10px 0">
      <div style="font-size:26px; line-height:1">📥</div>
      <div style="font-size:13px; margin-top:4px">ここに <b>data_j.xls</b> をドラッグ＆ドロップ</div>
      <div class="muted" style="font-size:12px; margin:6px 0">または</div>
      <label class="btn btn-primary btn-sm" style="cursor:pointer">ファイルを選択（.xls / .xlsx / .csv）
        <input type="file" accept=".xls,.xlsx,.csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onchange="importListedFile(this)" hidden></label>
    </div>
    <details style="margin-top:6px"><summary class="muted" style="font-size:12px;cursor:pointer">またはコピーして貼り付けで取り込む</summary>
      <textarea id="listed-ta" rows="6" style="width:100%;font-size:12px;margin-top:6px" placeholder="コード	銘柄名 … を貼り付け（タブ区切り/カンマ区切り）"></textarea>
      <div style="margin-top:6px"><button type="button" class="btn btn-sm btn-primary" onclick="importListedMaster()">貼り付け内容を取り込む</button></div>
    </details>
    <div class="form-actions" style="margin-top:12px">
      ${curCount ? `<button type="button" class="btn btn-danger" onclick="clearListedMaster()">全消去</button>` : ''}
      <button type="button" class="btn" onclick="closeModal()">閉じる</button>
    </div>`, { wide: true });
}
function importListedMaster() {
  const ta = document.getElementById('listed-ta'); if (!ta) return;
  const parsed = parseListedMaster(ta.value);
  if (!parsed.list.length) { toast('コード・銘柄名を読み取れませんでした（貼り付け内容をご確認ください）'); return; }
  setListedMaster(parsed.list);
  store.data.listedMasterInfo = { date: parsed.date || '', importedAt: store._now ? store._now() : Date.now(), count: parsed.list.length, fileName: '', _updatedAt: store._now() };
  store.save();
  _majorsListCache = null; _majorsMemo.clear(); // 照合リスト再構築
  closeModal(); if (currentView === 'news') renderNews();
  toast(`${parsed.list.length.toLocaleString('ja-JP')} 銘柄を取り込みました${parsed.date ? `（${fmtListedDate(parsed.date)} 時点）` : ''}`);
}
function clearListedMaster() {
  if (!confirm('上場銘柄マスタを全消去します。よろしいですか？')) return;
  // 消去も _updatedAt 付きのメタを残す（null にすると同期で「消去の意思」が伝わらず他端末のデータで復活する）
  setListedMaster([]); store.data.listedMasterInfo = { date: '', importedAt: store._now(), count: 0, fileName: '', cleared: true, _updatedAt: store._now() }; store.save();
  _majorsListCache = null; _majorsMemo.clear();
  closeModal(); if (currentView === 'news') renderNews();
  toast('上場銘柄マスタを消去しました');
}
// ---------- 一括編集マスタの同期セーフな保存（レコード＋更新日時＋トンボストン） ----------
// 配列マスタを sync の ['single'] で同期すると、別端末で「既定値が再シードされた」時に
// その既定値が本物の登録内容を上書きして消える事故が起きる（実際にYouTubeチャンネルが消失した）。
// 行ごとに updatedAt を持たせ、削除は要素の除去ではなく {deleted:true} のトンボストンで表現する。
// これで sync-merge の 'records' が「新しい更新・新しい削除」を後勝ちで正しくマージできる
// （cfRules/grades が既に採用している方式に合わせた）。
function masterRowsSave(prevArr, nextRows, keyOf) {
  const now = new Date().toISOString();
  const norm = (r) => { const o = { ...(r || {}) }; delete o.updatedAt; delete o.deleted; return JSON.stringify(o); };
  const prev = new Map();
  for (const r of prevArr || []) { const k = keyOf(r); if (k) prev.set(k, r); }
  const out = [], seen = new Set();
  nextRows.forEach((row, i) => {
    const k = keyOf(row); if (!k || seen.has(k)) return; seen.add(k);
    const next = { ...row, sortOrder: i };
    const old = prev.get(k);
    // 中身が変わっていなければ updatedAt を据え置き（無意味な上書き合戦を避ける）
    next.updatedAt = (old && !old.deleted && norm(old) === norm(next)) ? (old.updatedAt || now) : now;
    out.push(next);
  });
  for (const [k, old] of prev) { // 画面から消えた行はトンボストン化（削除も同期で伝わる）
    if (seen.has(k)) continue;
    out.push(old.deleted ? old : { ...old, deleted: true, updatedAt: now });
  }
  return out;
}
// トンボストンを除き、並び順で取り出す（表示・判定はすべてこれ経由）
function masterRowsLive(arr) {
  return (Array.isArray(arr) ? arr : []).filter(r => r && !r.deleted)
    .slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}
// ---------- YouTubeチャンネル マスタ ----------
function ytChannelList() { return masterRowsLive(store.data.ytChannels); }
function ytChannelRowHtml(c) {
  return `<tr>
    <td class="l"><input class="yt-name" value="${esc(c.name || '')}" placeholder="テスタ" style="width:130px"></td>
    <td class="l"><input class="yt-id" value="${esc(c.id || '')}" placeholder="UCfJEDCUlzQl4-atLp6Z9DcQ" style="width:100%;min-width:260px"></td>
    <td class="l"><select class="yt-sum" title="このチャンネルの自動要約の扱い">
      <option value="" ${!c.summaryMode ? 'selected' : ''}>マスタ設定に従う</option>
      <option value="all" ${c.summaryMode === 'all' ? 'selected' : ''}>全動画を自動要約</option>
    </select></td>
    <td><button class="btn btn-sm btn-danger" onclick="this.closest('tr').remove()" title="削除">×</button></td></tr>`;
}
// このチャンネルの動画を裏で自動要約するか（チャンネル指定「全動画」ならマスタ設定OFFでも要約する）
function ytAutoForItem(it) {
  if (store.data.settings && store.data.settings.ytAutoSummary) return true;
  if (!it || !it.channelId) return false;
  const ch = ytChannelList().find(c => c.id === it.channelId);
  return !!(ch && ch.summaryMode === 'all');
}
function openYtChannelMaster() {
  const rows = ytChannelList().map(ytChannelRowHtml).join('');
  const cur = ytModelSetting();
  const modelOpts = `<option value="">自動（推奨・混雑/上限時は自動で次のモデルへ）</option>` +
    YT_MODELS.map(([v, l]) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
  showModal('YouTubeチャンネル・要約設定', `
    <p class="muted" style="margin:0 0 8px;font-size:12px">ニュースの「動画」カテゴリに新着動画を表示するチャンネルです。<strong>チャンネルID</strong>（<code>UC</code>で始まる24文字）を登録してください。<br>調べ方: チャンネルページを開き、URLが <code>youtube.com/channel/UC…</code> ならその <code>UC…</code>。<code>@ハンドル</code> 形式の場合は、チャンネルの「概要」→「チャンネルを共有」→「チャンネルIDをコピー」で取得できます。</p>
    <div class="table-wrap"><table class="holdings dense">
      <thead><tr><th class="l">表示名</th><th class="l">チャンネルID（UC…）</th><th class="l">自動要約</th><th></th></tr></thead>
      <tbody id="yt-ch-rows">${rows}</tbody></table></div>
    <div class="btn-row" style="margin-top:8px"><button class="btn btn-sm" onclick="ytChannelAddRow()">＋ チャンネルを追加</button></div>
    <fieldset class="form-group" style="margin-top:14px"><legend>要約に使うAIモデル（Gemini）</legend>
      <select id="yt-model" style="min-width:280px">${modelOpts}</select>
      <p class="muted" style="font-size:11px;margin:6px 0 0">上限（回数超過）に達したら、どのモデルを選んでも自動で他モデルへ降格して要約を続けます。<br>「自動」＝高精度なモデルから順に試行／モデル固定＝そのモデルを優先し、上限時のみ他へ降格。</p>
      <label class="np-check" style="margin-top:10px"><input type="checkbox" id="yt-auto" ${(store.data.settings && store.data.settings.ytAutoSummary) ? 'checked' : ''}> 新着動画の要約を裏で自動生成する（ニュースを開いた時／新しい順に最大3件）</label>
      <p class="muted" style="font-size:11px;margin:4px 0 0">ONにすると、開いた時には要約が出来ている状態になります（待ち時間の解消）。OFFにすると、動画をクリックした時に都度生成します。</p>
    </fieldset>
    <div class="form-actions" style="margin-top:12px">
      <button type="button" class="btn btn-primary" onclick="saveYtChannelMaster()">保存</button>
      <button type="button" class="btn" onclick="closeModal()">閉じる</button>
    </div>`, { wide: true });
}
function ytChannelAddRow() { const tb = document.getElementById('yt-ch-rows'); if (tb) tb.insertAdjacentHTML('beforeend', ytChannelRowHtml({ name: '', id: '' })); }
function saveYtChannelMaster() {
  const defs = [];
  for (const tr of document.querySelectorAll('#yt-ch-rows tr')) {
    const name = tr.querySelector('.yt-name').value.trim();
    let id = tr.querySelector('.yt-id').value.trim();
    const m = id.match(/UC[\w-]{20,}/); if (m) id = m[0]; // URLを貼られてもID部分を抽出
    if (!id) continue;
    if (!/^UC[\w-]{20,}$/.test(id)) { toast(`チャンネルIDの形式が不正です: ${name || id}`); return; }
    const sumEl = tr.querySelector('.yt-sum');
    defs.push({ id, name: name || id, ...(sumEl && sumEl.value ? { summaryMode: sumEl.value } : {}) });
  }
  store.data.ytChannels = masterRowsSave(store.data.ytChannels, defs, c => 'yt:' + String(c.id || ''));
  store.data.settings = store.data.settings || {};
  const msel = document.getElementById('yt-model'); if (msel) store.data.settings.ytModel = msel.value || '';
  const auto = document.getElementById('yt-auto'); if (auto) store.data.settings.ytAutoSummary = !!auto.checked;
  store.data.settings._updatedAt = store._now(); // 同期マージ(singleTs)で両端末変更時に新しい方を採るため（従来ここだけ漏れていた）
  store.save();
  closeModal(); if (currentView === 'news') { _newsCache = null; newsRefresh(); }
  toast('YouTubeチャンネルを保存しました');
}
// ---------- 開示種別マスタ（分類・キーワード編集） ----------
function discTypeRowHtml(d) {
  return `<tr>
    <td class="nowrap"><button class="btn btn-sm" onclick="discTypeMoveRow(this,-1)" title="上へ">▲</button><button class="btn btn-sm" onclick="discTypeMoveRow(this,1)" title="下へ">▼</button></td>
    <td class="l"><input class="dt-name" value="${esc(d.name || '')}" placeholder="決算" style="width:110px"></td>
    <td class="l"><input class="dt-group" value="${esc(d.group || '')}" placeholder="決算" style="width:110px"></td>
    <td class="l"><input class="dt-kw" value="${esc(d.keywords || '')}" placeholder="決算短信|四半期報告書" style="width:100%;min-width:220px"></td>
    <td><button class="btn btn-sm btn-danger" onclick="this.closest('tr').remove()" title="削除">×</button></td></tr>`;
}
// 行を上下に移動（入力値はDOMごと動かすので再入力不要。保存時はDOM順で読む）
function discTypeMoveRow(btn, dir) {
  const tr = btn.closest('tr'); if (!tr) return;
  if (dir < 0) { const p = tr.previousElementSibling; if (p) tr.parentNode.insertBefore(tr, p); }
  else { const n = tr.nextElementSibling; if (n) tr.parentNode.insertBefore(n, tr); }
}
function openDiscTypeMaster() {
  const rows = discDefs().map(discTypeRowHtml).join('');
  showModal('開示種別マスタ（分類・キーワード）', `
    <p class="muted" style="margin:0 0 8px;font-size:12px">開示の見出しに含まれる<strong>キーワード</strong>（正規表現・<code>|</code> 区切り）で種別を判定します。<strong>上から順に最初に一致</strong>した種別のタグが付きます。<br>「まとめ（フィルタタブ）」が同じ種別は、ニュースの絞り込みタブで束ねられます（タグは種別ごとに表示）。どれにも一致しないものは「その他開示」。</p>
    <div class="table-wrap"><table class="holdings dense">
      <thead><tr><th>並び</th><th class="l">種別（タグ名）</th><th class="l">まとめ（フィルタタブ）</th><th class="l">キーワード（| 区切り・正規表現可）</th><th></th></tr></thead>
      <tbody id="disc-type-rows">${rows}</tbody></table></div>
    <div class="btn-row" style="margin-top:8px"><button class="btn btn-sm" onclick="discTypeAddRow()">＋ 種別を追加</button><span style="flex:1"></span><button class="btn btn-sm" onclick="discTypeResetDefault()">既定に戻す</button></div>
    <div class="form-actions" style="margin-top:12px">
      <button type="button" class="btn btn-primary" onclick="saveDiscTypeMaster()">保存</button>
      <button type="button" class="btn" onclick="closeModal()">閉じる</button>
    </div>`, { wide: true });
}
function discTypeAddRow() { const tb = document.getElementById('disc-type-rows'); if (tb) tb.insertAdjacentHTML('beforeend', discTypeRowHtml({ name: '', group: '', keywords: '' })); }
function discTypeResetDefault() {
  if (!confirm('開示種別・キーワードを既定に戻します。編集内容は失われます。よろしいですか？')) return;
  // 既定に戻す場合もトンボストン経由（消した行の削除を同期で伝え、別端末の編集が復活しないように）
  store.data.discTypeDefs = masterRowsSave(store.data.discTypeDefs, structuredClone(DEFAULT_DISC_TYPES), d => 'dt:' + String(d.name || ''));
  store.save(); _discReCache.clear();
  openDiscTypeMaster();
}
function saveDiscTypeMaster() {
  const defs = [];
  for (const tr of document.querySelectorAll('#disc-type-rows tr')) {
    const name = tr.querySelector('.dt-name').value.trim();
    if (!name) continue;
    const group = tr.querySelector('.dt-group').value.trim() || name;
    const keywords = tr.querySelector('.dt-kw').value.trim();
    if (keywords) { try { new RegExp(keywords); } catch (_) { toast(`キーワードの正規表現が不正です: ${name}`); return; } }
    defs.push({ name, group, keywords });
  }
  if (!defs.length) { toast('少なくとも1種別は必要です'); return; }
  store.data.discTypeDefs = masterRowsSave(store.data.discTypeDefs, defs, d => 'dt:' + String(d.name || ''));
  store.save(); _discReCache.clear();
  closeModal(); if (currentView === 'news') renderNews();
  toast('開示種別を保存しました');
}
function openMasterPick() {
  const el = document.getElementById('master-pick'); if (!el) return;
  const m = MASTER_LAUNCH.find(x => x.v === el.value); if (m) m.open();
}
function masterPickNote() {
  const el = document.getElementById('master-pick'); const m = el && MASTER_LAUNCH.find(x => x.v === el.value);
  const n = document.getElementById('master-pick-note'); if (n && m) n.textContent = m.note;
}
// ---------- 通知メール設定（テンプレート編集） ----------
// ★サーバー側 functions/lib/notify.js と同一仕様の二重実装（ビルド無し構成のため）。
//   プレースホルダの意味・既定文面を変える時は notify.js と必ずそろえること。
const NOTIFY_DEFAULT_TPL = {
  subject: '【{market}】{date} 購入基準価格通知',
  reached: { header: '〇到達', line: '[{kind}] {ticker} {name}  現在値 {price}({dayChange}) 前回から{dropFromPrev} → 買増ライン {trigger} ／購入額 {buyAmount}', empty: '（なし）' },
  near:    { header: '〇接近', line: '[{kind}] {ticker} {name}  現在値 {price}({dayChange}) 前回から{dropFromPrev} → 買増ライン {trigger} 残り {remaining} ／購入額 {buyAmount}', empty: '（なし）' },
};
// 明細行で使える差し込み項目（グループ別）。サイン一覧（表）に出せる項目をすべて網羅。
// ★サーバー側 computeSignals の出力＋notify.js signalVars と対応。増やす時は3箇所そろえること。
const NOTIFY_PH_LINE = [
  { g: '基本', items: [['kind', '初回/買増'], ['ticker', 'コード'], ['name', '銘柄名'], ['market', '市場'], ['broker', '証券会社'], ['category', 'カテゴリ'], ['ruleName', '買い増しルール'], ['rating', '銘柄格付']] },
  { g: '価格', items: [['price', '現在値'], ['dayChange', '前日比'], ['dayAmt', '前日比値幅'], ['prevClose', '前日終値']] },
  { g: '判定', items: [['trigger', '次回購入'], ['trigBasis', '適用区分'], ['reachKind', '到達区分(新/続)'], ['base', '基準値'], ['remaining', '残り下落率'], ['fixedBuyPrice', '買増固定値'], ['addonFromHigh', '買増を初回基準']] },
  { g: '前回購入', items: [['prevBuyPrice', '前回購入単価'], ['prevBuyDate', '前回購入日'], ['dropFromPrev', '前回からの下落率']] },
  { g: '高値・安値', items: [['high5y', '5年高値'], ['high52w', '52週高値'], ['dropFrom5y', '5年高値からの下落率'], ['dropFrom52w', '52週高値からの下落率'], ['low1y', '1年安値'], ['low3y', '3年安値'], ['riseFrom1y', '1年安値からの上昇率'], ['riseFrom3y', '3年安値からの上昇率']] },
  { g: '保有・損益', items: [['qty', '数量'], ['avgCost', '取得単価'], ['value', '評価額'], ['cost', '取得価額'], ['pnl', '損益率'], ['buyCount', '購入回数'], ['buyAmount', '購入額']] },
  { g: 'ファンダ', items: [['marketCap', '時価総額'], ['per', 'PER'], ['pbr', 'PBR'], ['eps', 'EPS'], ['dividend', '配当/株'], ['divYield', '配当利回り'], ['yieldOnCost', '取得利回り'], ['marginRatio', '信用倍率']] },
];
const NOTIFY_PH_SUBJECT = [
  ['market', '市場名'], ['date', '日付'], ['reachedCount', '到達件数'], ['nearCount', '接近件数'], ['totalCount', '合計件数'],
];

let _notifyDraft = null;   // 編集中のコピー { JP:{subject,reached,near}, US:{...} }
let _notifyMarket = 'JP';
let _notifyFocusEl = null; // 直近フォーカスした textarea（差し込み挿入先）

// 編集用ドラフト。保存値が無い項目は既定文面を「実値として」埋める（薄いプレースホルダではなく登録値として表示）。
function notifyDraftFromStore() {
  const src = (store.data.settings && store.data.settings.notify && store.data.settings.notify.byMarket) || {};
  const d = NOTIFY_DEFAULT_TPL;
  const mk = (m) => {
    const o = src[m] || {};
    const sec = (k) => ({
      header: (o[k] && o[k].header) || d[k].header,
      line: (o[k] && o[k].line) || d[k].line,
      empty: (o[k] && o[k].empty) || d[k].empty,
    });
    return { subject: o.subject || d.subject, reached: sec('reached'), near: sec('near') };
  };
  return { JP: mk('JP'), US: mk('US') };
}
function notifyResolveDraft(m) {
  const o = _notifyDraft[m], d = NOTIFY_DEFAULT_TPL;
  const sec = (k) => ({ header: o[k].header || d[k].header, line: o[k].line || d[k].line, empty: o[k].empty || d[k].empty });
  return { subject: o.subject || d.subject, reached: sec('reached'), near: sec('near') };
}
function notifyApply(tpl, vars) { return String(tpl).replace(/\{(\w+)\}/g, (mm, k) => (k in vars ? String(vars[k] ?? '') : mm)); }
// ★サーバー側 notify.js signalVars と同一仕様。プレースホルダを足す時は両方そろえること。
function notifyVars(s) {
  const sym = s.market === 'US' ? '$' : '¥';
  const us = s.market === 'US';
  const n = (v) => (v == null ? null : v.toLocaleString('en-US', { maximumFractionDigits: 2 }));
  const cur = (v) => (v == null ? '—' : sym + n(v));
  const curS = (v) => (v == null ? '—' : (v >= 0 ? '+' : '−') + sym + n(Math.abs(v)));
  const spct = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%');
  const dpct = (v) => (v == null ? '—' : v.toFixed(1) + '%');
  const p2 = (v) => (v == null ? '—' : v.toFixed(2) + '%');
  const numv = (v) => (v == null ? '—' : n(v));
  const txt = (v) => (v == null || v === '' ? '—' : String(v));
  const cap = (v) => {
    if (v == null) return '—';
    const a = Math.abs(v) * 1e6, sign = v < 0 ? '-' : '';
    if (us) { if (a >= 1e12) return sign + (a / 1e12).toFixed(2) + 'T'; if (a >= 1e9) return sign + (a / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return sign + (a / 1e6).toFixed(1) + 'M'; return sign + Math.round(a).toLocaleString('en-US'); }
    if (a >= 1e12) { const cho = Math.floor(a / 1e12), oku = Math.round((a % 1e12) / 1e8); return sign + cho + '兆' + (oku ? oku + '億' : ''); }
    if (a >= 1e10) return sign + Math.round(a / 1e8) + '億';
    if (a >= 1e8) { const oku = Math.floor(a / 1e8), man = Math.round((a % 1e8) / 1e4); return sign + oku + '億' + (man ? man + '万' : ''); }
    if (a >= 1e4) return sign + Math.round(a / 1e4) + '万';
    return sign + Math.round(a).toLocaleString('en-US');
  };
  return {
    kind: s.type === 'initial' ? '初回' : '買増',
    ticker: s.ticker ?? '', name: s.name ?? '', market: s.market ?? '',
    broker: txt(s.broker), category: txt(s.category), ruleName: txt(s.ruleName), rating: txt(s.rating),
    price: cur(s.price), priceRaw: n(s.price) ?? '—',
    dayChange: spct(s.dayChangePct), dayAmt: curS(s.dayAmt), prevClose: cur(s.prevClose),
    trigger: cur(s.trigger), trigBasis: txt(s.trigBasis), reachKind: txt(s.reachKind), base: cur(s.base),
    remaining: dpct(s.remainingDropPct), fixedBuyPrice: cur(s.fixedBuyPrice),
    prevBuyPrice: cur(s.prevBuyPrice), prevBuyDate: txt(s.prevBuyDate), dropFromPrev: dpct(s.dropFromPrev),
    high5y: cur(s.high5y), high52w: cur(s.high52w), low1y: cur(s.low1y), low3y: cur(s.low3y),
    dropFrom5y: dpct(s.dropFrom5y), dropFrom52w: dpct(s.dropFrom52w), riseFrom1y: dpct(s.riseFrom1y), riseFrom3y: dpct(s.riseFrom3y),
    qty: numv(s.qty), avgCost: cur(s.avgCost), value: cur(s.value), cost: cur(s.cost), pnl: dpct(s.pnl),
    buyCount: numv(s.buyCount), buyAmount: s.buyAmount == null ? '—' : sym + n(s.buyAmount),
    marketCap: cap(s.marketCap), per: numv(s.per), pbr: numv(s.pbr), eps: cur(s.eps),
    dividend: cur(s.dividend), divYield: p2(s.divYield), yieldOnCost: p2(s.yieldOnCost), marginRatio: numv(s.marginRatio),
  };
}
function notifySample(market) {
  const us = market === 'US';
  const base = (over) => Object.assign({
    market,
    broker: us ? 'マネックス' : 'SBI証券', category: us ? 'コア' : '高配当', ruleName: '標準ルール', rating: 'A',
    prevClose: us ? 190.6 : 2800, base: us ? 200 : 2900, trigBasis: '増',
    high5y: us ? 210 : 3100, high52w: us ? 205 : 3050, low1y: us ? 160 : 2400, low3y: us ? 140 : 2100,
    dropFrom5y: -10.3, dropFrom52w: -8.1, riseFrom1y: 17.8, riseFrom3y: 31.0,
    qty: us ? 12 : 300, avgCost: us ? 175 : 2600, value: us ? 2260 : 825000, cost: us ? 2100 : 780000, pnl: 5.8, buyCount: us ? 4 : 3,
    marketCap: us ? 2950000 : 42000000, per: 18.3, pbr: 1.4, eps: us ? 10.3 : 180, dividend: us ? 1.0 : 90, divYield: 2.4, yieldOnCost: 3.1, marginRatio: us ? null : 1.8,
    prevBuyDate: '2026-04-10',
  }, over);
  return [
    base({ reached: true, type: 'addon', reachKind: '新', ticker: us ? 'AAPL' : '7203', name: us ? 'アップル' : 'トヨタ自動車', price: us ? 188.4 : 2750, dayChangePct: -1.23, dayAmt: us ? -2.2 : -50, dropFromPrev: -5.2, prevBuyPrice: us ? 198 : 2900, trigger: us ? 185 : 2700, remainingDropPct: 0, fixedBuyPrice: null, buyAmount: us ? 500 : 50000 }),
    base({ reached: false, type: 'initial', reachKind: null, ticker: us ? 'MSFT' : '6758', name: us ? 'マイクロソフト' : 'ソニーG', price: us ? 410 : 13200, dayChangePct: 0.45, dayAmt: us ? 1.8 : 60, dropFromPrev: -2.1, prevBuyPrice: us ? 419 : 13480, trigger: us ? 400 : 12800, remainingDropPct: 2.4, fixedBuyPrice: null, buyAmount: us ? 500 : 50000 }),
  ];
}
function notifyRenderPreview() {
  const m = _notifyMarket, tpl = notifyResolveDraft(m), sig = notifySample(m);
  const reached = sig.filter(s => s.reached), near = sig.filter(s => !s.reached);
  const lines = (list, lt, et) => (list.length ? list.map(s => notifyApply(lt, notifyVars(s))).join('\n') : et);
  const body = [tpl.reached.header, lines(reached, tpl.reached.line, tpl.reached.empty), '', tpl.near.header, lines(near, tpl.near.line, tpl.near.empty)].join('\n');
  const ml = m === 'JP' ? '日本株' : '米国株';
  const subject = notifyApply(tpl.subject, { market: ml, date: '6/18', reachedCount: reached.length, nearCount: near.length, totalCount: sig.length });
  return { subject, body };
}
function notifyTa(id, name, val, ph, rows) {
  return `<textarea id="${id}" name="${name}" rows="${rows || 2}" oninput="notifyEdit(this)" onfocus="_notifyFocusEl=this" placeholder="${esc(ph)}" style="width:100%;box-sizing:border-box;font:12px/1.6 ui-monospace,monospace;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--panel);resize:vertical">${esc(val)}</textarea>`;
}
function notifySectionHtml(key, d) {
  return `
    <div style="margin:0 0 6px"><label class="muted" style="font-size:11px">見出し</label>${notifyTa('nf_' + key + '_header', key + '.header', d[key].header, NOTIFY_DEFAULT_TPL[key].header, 1)}</div>
    <div style="margin:0 0 6px"><label class="muted" style="font-size:11px">明細行（銘柄ごとに繰り返し）</label>${notifyTa('nf_' + key + '_line', key + '.line', d[key].line, NOTIFY_DEFAULT_TPL[key].line, 2)}</div>
    <div style="margin:0 0 6px"><label class="muted" style="font-size:11px">該当なしの表示</label>${notifyTa('nf_' + key + '_empty', key + '.empty', d[key].empty, NOTIFY_DEFAULT_TPL[key].empty, 1)}</div>`;
}
function notifyBodyHtml() {
  const m = _notifyMarket, d = _notifyDraft[m];
  // 項目名をクリックすると対応する差し込み記号がカーソル位置に入る（記号名は出さず項目名で表示）
  const chip = ([k, l]) => `<button type="button" class="btn" style="padding:2px 8px;font-size:11px" onclick="notifyInsert('${k}')" title="差し込み: {${k}}">${esc(l)}</button>`;
  const chipsFlat = (arr) => arr.map(chip).join(' ');
  const chipsGrouped = (groups) => groups.map(grp =>
    `<div style="margin:4px 0"><span class="muted" style="font-size:11px;display:inline-block;min-width:70px">${esc(grp.g)}</span> ${grp.items.map(chip).join(' ')}</div>`).join('');
  const prev = notifyRenderPreview();
  return `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
      <button class="btn ${m === 'JP' ? 'btn-primary' : ''}" onclick="notifySwitchMarket('JP')">日本株</button>
      <button class="btn ${m === 'US' ? 'btn-primary' : ''}" onclick="notifySwitchMarket('US')">米国株</button>
      <span style="flex:1"></span>
      <button class="btn" onclick="notifyCopyMarket()">${m === 'JP' ? '日本株→米国株へコピー' : '米国株→日本株へコピー'}</button>
      <button class="btn" onclick="notifyResetMarket()">この市場を既定に戻す</button>
    </div>
    <p class="muted" style="margin:0 0 10px">空欄の項目は既定の文面が使われます。記号ボタンを押すと、直前に選んだ入力欄のカーソル位置に差し込み記号を挿入します。</p>

    <div class="grp-label">件名</div>
    ${notifyTa('nf_subject', 'subject', d.subject, NOTIFY_DEFAULT_TPL.subject, 2)}
    <div style="margin:4px 0 14px;line-height:2"><span class="muted" style="font-size:11px">件名に入れる項目（クリックで挿入）:</span><br>${chipsFlat(NOTIFY_PH_SUBJECT)}</div>

    <div class="grp-label">到達セクション</div>
    ${notifySectionHtml('reached', d)}
    <div class="grp-label" style="margin-top:12px">接近セクション</div>
    ${notifySectionHtml('near', d)}
    <div style="margin:8px 0 4px"><span class="muted" style="font-size:11px">明細行に入れる項目（入力欄を選んでからクリックで挿入）:</span></div>
    ${chipsGrouped(NOTIFY_PH_LINE)}
    <div style="display:flex;gap:8px;margin:6px 0 0;flex-wrap:wrap">
      <button class="btn" onclick="notifyCopySection('reached','near')">到達→接近へコピー</button>
      <button class="btn" onclick="notifyCopySection('near','reached')">接近→到達へコピー</button>
    </div>

    <div class="grp-label" style="margin-top:16px">プレビュー（サンプルデータ）</div>
    <div style="background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:10px">
      <div style="font-weight:600;margin-bottom:6px">件名: <span id="notify-prev-subj">${esc(prev.subject)}</span></div>
      <pre id="notify-prev-body" style="font:12px/1.7 ui-monospace,monospace;white-space:pre-wrap;margin:0">${esc(prev.body)}</pre>
    </div>
    <div class="form-actions" style="margin-top:16px">
      <button class="btn" onclick="closeModal()">閉じる</button>
      <button class="btn btn-primary" onclick="notifySave()">保存</button>
    </div>`;
}
function notifyRender() { const b = document.getElementById('modal-body'); if (b) b.innerHTML = notifyBodyHtml(); }
function notifyUpdatePreview() {
  const prev = notifyRenderPreview();
  const a = document.getElementById('notify-prev-subj'); if (a) a.textContent = prev.subject;
  const c = document.getElementById('notify-prev-body'); if (c) c.textContent = prev.body;
}
function notifyEdit(el) {
  const p = el.name.split('.'), d = _notifyDraft[_notifyMarket];
  if (p.length === 1) d[p[0]] = el.value; else d[p[0]][p[1]] = el.value;
  notifyUpdatePreview();
}
function notifyInsert(k) {
  const el = _notifyFocusEl, tok = '{' + k + '}';
  if (!el) { toast('先に入力欄を選んでください'); return; }
  const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, s) + tok + el.value.slice(e);
  el.focus(); el.selectionStart = el.selectionEnd = s + tok.length;
  notifyEdit(el);
}
function notifySwitchMarket(m) { _notifyMarket = m; _notifyFocusEl = null; notifyRender(); }
function notifyCopyMarket() {
  const from = _notifyMarket, to = from === 'JP' ? 'US' : 'JP';
  _notifyDraft[to] = JSON.parse(JSON.stringify(_notifyDraft[from]));
  toast((from === 'JP' ? '日本株' : '米国株') + 'の設定を' + (to === 'JP' ? '日本株' : '米国株') + 'へコピーしました');
}
function notifyCopySection(from, to) {
  const d = _notifyDraft[_notifyMarket];
  d[to] = JSON.parse(JSON.stringify(d[from]));
  _notifyFocusEl = null; notifyRender();
}
function notifyResetMarket() {
  const d = NOTIFY_DEFAULT_TPL;
  _notifyDraft[_notifyMarket] = {
    subject: d.subject,
    reached: { header: d.reached.header, line: d.reached.line, empty: d.reached.empty },
    near: { header: d.near.header, line: d.near.line, empty: d.near.empty },
  };
  _notifyFocusEl = null; notifyRender();
}
function notifySave() {
  store.data.settings = store.data.settings || {};
  store.data.settings.notify = { byMarket: JSON.parse(JSON.stringify(_notifyDraft)) };
  store.data.settings._updatedAt = store._now(); // 同期マージで両端末変更時に新しい方を採るため
  store.save();
  toast('通知メール設定を保存しました');
  closeModal();
}
function openNotifyMaster() {
  _notifyDraft = notifyDraftFromStore();
  _notifyMarket = 'JP';
  _notifyFocusEl = null;
  showModal('通知メール設定', notifyBodyHtml(), { wide: true });
}

function renderMaster() {
  app.innerHTML = `
    <div class="section">
      <div class="section-head"><h2>マスタ</h2><span class="muted" style="margin-left:auto;font-size:12px" title="アプリのバージョン（更新日時 JST）">${esc(APP_VERSION)}</span></div>
      <div class="section-body" style="padding:16px">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="muted">マスタを選択</span>
          <select id="master-pick" style="min-width:240px" onchange="masterPickNote()">
            ${MASTER_LAUNCH.map(m => `<option value="${m.v}">${esc(m.label)}</option>`).join('')}
          </select>
          <button class="btn btn-primary" onclick="openMasterPick()">開く</button>
        </div>
        <p class="muted grp-note" id="master-pick-note" style="margin:8px 0 0">${esc(MASTER_LAUNCH[0].note)}</p>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>バックアップ・出力</h2></div>
      <div class="section-body" style="padding:16px">
        <div class="grp-label">全データのバックアップ（JSONファイル）</div>
        <div class="btn-row">
          <button class="btn" onclick="exportData()">バックアップ書出し（JSON）</button>
          <button class="btn" onclick="importData()">バックアップ読込（JSON）</button>
        </div>
        <p class="muted grp-note">このブラウザ(localStorage)の全データをファイルに保存／復元します。保存先は現在このブラウザのみ（将来 Google スプレッドシートへ移行予定）。</p>
        <div class="grp-label" style="margin-top:18px">Drive 自動バックアップ（最大5世代）</div>
        <div class="btn-row">
          <button class="btn" onclick="openDriveBackups()">Driveのバックアップから復元…</button>
        </div>
        <p class="muted grp-note">Drive自動同期がONのとき、<strong>1日1回（その日最初の同期）</strong>と<strong>全データ削除／インポートの直前</strong>に、Drive上へ自動で世代バックアップを保存します（古いものから最大5世代を保持）。誤操作や不具合で消えても、ここから過去の状態に戻せます。</p>
        <div class="grp-label" style="margin-top:18px">資産貼付・転記</div>
        <div class="btn-row">
          <button class="btn" onclick="go('transfer')">資産貼付・転記（転記用タブへ）</button>
        </div>
        <p class="muted grp-note">資産管理エクセルへの貼付・現金転記は専用の「転記用」タブで行います。</p>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>データ削除</h2></div>
      <div class="section-body" style="padding:16px">
        <div class="btn-row">
          <button class="btn btn-danger" onclick="resetTxnData()">保有・取引データだけ削除（マスタ・銘柄は残す）</button>
          <button class="btn btn-danger" onclick="resetData()">全データ削除</button>
        </div>
        <p class="muted grp-note">「保有・取引だけ削除」＝カテゴリ金額/ルール/銘柄マスタ（銘柄の定義・属性）を残し、保有・取引・取込履歴・価格キャッシュなど下部データのみ削除。「全データ削除」＝マスタ含め初期化。いずれも削除前にJSONバックアップを自動ダウンロード。</p>
      </div>
    </div>
    ${googleSyncSection()}`;
  // GIS を先に読み込んでおく（タップ→認証ポップアップの間に await を挟まないため。
  // モバイルは「タップ直後の同期的処理」でないとポップアップを塞ぐ）。clientId 未設定なら何もしない。
  if (gsync.cfg().clientId) gsync.ensureGis().catch(() => {});
}

// ---------- 列の背景色ルール（マスタ）の管理UI ----------
// rgba()/hex を {hex,a} に分解（色入力＝hex、濃さ＝不透明度スライダーで編集するため）
function cfParseBg(bg) {
  let m = String(bg).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/);
  if (m) return { hex: cfRgbToHex(+m[1], +m[2], +m[3]), a: m[4] != null ? parseFloat(m[4]) : 1 };
  m = String(bg).match(/^#([0-9a-fA-F]{6})$/);
  if (m) return { hex: '#' + m[1].toLowerCase(), a: 1 };
  return { hex: '#eab308', a: 0.35 };
}
function cfRgbToHex(r, g, b) { return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join(''); }
function cfHexToRgb(hex) { const p = hex.replace('#', '').match(/.{2}/g).map(x => parseInt(x, 16)); return { r: p[0], g: p[1], b: p[2] }; }
// テンプレート色パレット（よく使う色。クリックで色＋濃さに反映。細かく決めたい時は下の色/濃さで調整）
const CF_TEMPLATE_COLORS = [
  { l: '緑(濃)', bg: 'rgba(34,197,94,.45)' }, { l: '緑(淡)', bg: 'rgba(34,197,94,.20)' },
  { l: '赤(濃)', bg: 'rgba(239,68,68,.45)' }, { l: '赤(淡)', bg: 'rgba(239,68,68,.20)' },
  { l: '橙', bg: 'rgba(249,115,22,.42)' }, { l: '黄', bg: 'rgba(234,179,8,.38)' },
  { l: 'スレート', bg: 'rgba(148,163,184,.22)' }, { l: '臙脂', bg: 'rgba(159,18,57,.48)' },
  { l: '青', bg: 'rgba(59,130,246,.30)' }, { l: '紫', bg: 'rgba(168,85,247,.30)' },
];
// 範囲テーブルの1行（範囲＝min/max＋色＋濃さ＋テンプレ選択）。r は {min,max,bg} or null。
function cfRangeRowHtml(r) {
  const p = cfParseBg(r ? r.bg : 'rgba(234,179,8,.35)');
  const aPct = Math.round(p.a * 100);
  const tplOpts = CF_TEMPLATE_COLORS.map(t => `<option value="${t.bg}">${esc(t.l)}</option>`).join('');
  return `<tr class="cf-rrow">
    <td><input class="cf-min" type="number" step="any" value="${r && r.min != null ? r.min : ''}" placeholder="−∞" style="width:78px"></td>
    <td><input class="cf-max" type="number" step="any" value="${r && r.max != null ? r.max : ''}" placeholder="+∞" style="width:78px"></td>
    <td><input class="cf-color" type="color" value="${p.hex}" style="width:42px;height:28px;padding:1px"></td>
    <td><input class="cf-alpha" type="range" min="0" max="100" value="${aPct}" style="width:84px" title="濃さ（不透明度）"></td>
    <td><select class="cf-tplsel" onchange="cfApplyTplSel(this)"><option value="">テンプレ…</option>${tplOpts}</select></td>
    <td><button type="button" class="btn btn-sm btn-danger" onclick="cfDelRangeRow(this)" title="この範囲を削除">×</button></td>
  </tr>`;
}
function cfAddRangeRow() { const tb = document.querySelector('#cf-ranges tbody'); if (tb) tb.insertAdjacentHTML('beforeend', cfRangeRowHtml(null)); }
function cfDelRangeRow(btn) { const tr = btn.closest('tr'); if (tr) tr.remove(); }
function cfApplyTplSel(sel) {
  if (!sel.value) return;
  const tr = sel.closest('tr'); const p = cfParseBg(sel.value);
  tr.querySelector('.cf-color').value = p.hex;
  tr.querySelector('.cf-alpha').value = Math.round(p.a * 100);
  sel.value = '';
}

function openCfRulesMaster() {
  const groups = (store.data.cfRules || []).filter(g => !g.deleted); // トンボストンは一覧に出さない
  const scLabel = id => (CF_SCREENS.find(s => s.id === id) || {}).label || id;
  const colLabel = k => { const c = MASTER_COLS.find(m => m.key === k); return c ? c.label : k; };
  const swatches = g => (g.ranges || []).map(r => `<span title="${r.min != null ? r.min : '−∞'}〜${r.max != null ? r.max : '+∞'}" style="display:inline-block;width:20px;height:14px;border-radius:3px;background:${r.bg};border:1px solid var(--border);vertical-align:middle"></span>`).join(' ');
  const rowsHtml = groups.length ? groups.map(g => `<tr>
      <td class="l">${esc(colLabel(g.col))}</td>
      <td class="l">${(g.screens && g.screens.length ? g.screens.map(scLabel).join('・') : '（全画面）')}</td>
      <td class="l">${(g.ranges || []).length}段 ${swatches(g)}</td>
      <td class="l nowrap"><button class="btn btn-sm" onclick="openCfRuleEdit('${g.id}')">編集</button>
        <button class="btn btn-sm" onclick="openCfRuleEdit(null,'${g.id}')" title="この設定を複製して新規作成">コピー</button>
        <button class="btn btn-sm btn-danger" onclick="deleteCfRule('${g.id}')">削除</button></td>
    </tr>`).join('') : `<tr><td colspan="4" class="empty">ルールがありません。</td></tr>`;
  showModal('列の背景色ルール（マスタ）', `
    <p class="muted" style="margin:0 0 8px">1行＝「列 × 適用画面の組」。その中に値の範囲と背景色を<strong>複数段</strong>登録できます（上の段ほど優先）。「コピー」で組ごと複製→別の列/画面に転用できます。</p>
    <p class="muted" style="margin:0 0 8px">金額系の列（取得価額・評価額・現在値など）は<strong>円基準で範囲を登録</strong>してください。米国株($)は共通レート（1ドル＝${num(masterUsdJpy())}円・「マスタ・設定 → ドル円換算レート」で変更）で円換算してから判定します（表示は$のまま色だけ円相当）。</p>
    <div class="table-wrap"><table class="holdings dense"><thead><tr><th class="l">列</th><th class="l">適用画面</th><th class="l">範囲×色</th><th class="l"></th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
    <div class="form-actions" style="justify-content:space-between">
      <button type="button" class="btn btn-danger" onclick="resetCfRules()">既定に戻す</button>
      <span><button type="button" class="btn" onclick="closeModal()">閉じる</button>
      <button type="button" class="btn btn-primary" onclick="openCfRuleEdit(null)">＋ ルール追加</button></span>
    </div>`, { wide: true });
}

// id 指定=編集 / copyFrom 指定=その組を複製して新規 / どちらも無し=空の新規
function openCfRuleEdit(id, copyFrom) {
  const groups = store.data.cfRules || [];
  const g = id ? groups.find(x => x.id === id) : (copyFrom ? groups.find(x => x.id === copyFrom) : null);
  const colOpts = CF_NUMERIC_KEYS.map(k => { const l = (MASTER_COLS.find(m => m.key === k) || {}).label || k; return `<option value="${k}" ${g && g.col === k ? 'selected' : ''}>${esc(l)}</option>`; }).join('');
  // コピー先の列候補（既定で「現在の列以外の最初の列」を選択＝別項目へのコピーを促す）。
  const copyDefault = CF_NUMERIC_KEYS.find(x => !g || x !== g.col) || CF_NUMERIC_KEYS[0];
  const cfCopyColOpts = CF_NUMERIC_KEYS.map(k => { const l = (MASTER_COLS.find(m => m.key === k) || {}).label || k; return `<option value="${k}" ${k === copyDefault ? 'selected' : ''}>${esc(l)}</option>`; }).join('');
  const scChecks = CF_SCREENS.map(s => `<label class="chip"><input type="checkbox" class="cf-screen" value="${s.id}" ${(!g || !g.screens || g.screens.length === 0 || g.screens.includes(s.id)) ? 'checked' : ''}> ${s.label}</label>`).join(' ');
  const ranges = (g && g.ranges && g.ranges.length) ? g.ranges : [null];
  const title = id ? '背景色ルールを編集' : (copyFrom ? '背景色ルールをコピーして追加' : '背景色ルールを追加');
  showModal(title, `
    <form id="cf-rule-form" onsubmit="return saveCfRule(event, '${id || ''}')">
      <div class="form-row"><label>対象列（数値）</label><select name="col">${colOpts}</select></div>
      <div class="form-row"><label>適用する画面（複数可）</label><div style="display:flex;gap:10px;flex-wrap:wrap">${scChecks}</div></div>
      <div class="form-row"><label>値の範囲と背景色（上の行ほど優先・複数段OK）</label>
        <div class="table-wrap"><table class="holdings dense" id="cf-ranges"><thead><tr><th>最小(以上)</th><th>最大(以下)</th><th>色</th><th>濃さ</th><th>テンプレ</th><th></th></tr></thead><tbody>${ranges.map(cfRangeRowHtml).join('')}</tbody></table></div>
        <button type="button" class="btn btn-sm" style="margin-top:6px" onclick="cfAddRangeRow()">＋ 範囲を追加</button></div>
      <div class="form-row" style="display:flex;gap:8px;align-items:flex-end;border-top:1px dashed var(--border);padding-top:10px">
        <div><label>この設定を別の列にコピー</label>
          <select id="cf-copy-col">${cfCopyColOpts}</select></div>
        <button type="button" class="btn btn-sm" onclick="cfCopyToCol()" title="現在の適用画面・範囲を、選んだ列へ新規ルールとしてコピー">コピー作成</button>
      </div>
      <div class="form-actions"><button type="button" class="btn" onclick="openCfRulesMaster()">戻る</button><button type="submit" class="btn btn-primary">保存</button></div>
    </form>`, { wide: true });
}

// フォームの範囲行を {min,max,bg}[] に収集。数値不正は toast して null を返す。
function cfCollectRanges(f) {
  const ranges = [];
  for (const tr of f.querySelectorAll('#cf-ranges tbody tr.cf-rrow')) {
    const minS = tr.querySelector('.cf-min').value.trim(), maxS = tr.querySelector('.cf-max').value.trim();
    const min = minS === '' ? null : parseFloat(minS), max = maxS === '' ? null : parseFloat(maxS);
    if ((min != null && isNaN(min)) || (max != null && isNaN(max))) { toast('数値が不正です'); return null; }
    if (min == null && max == null) continue; // 範囲未指定の空行はスキップ
    const { r, g, b } = cfHexToRgb(tr.querySelector('.cf-color').value);
    const a = (parseInt(tr.querySelector('.cf-alpha').value, 10) || 0) / 100;
    ranges.push({ min, max, bg: `rgba(${r},${g},${b},${a})` });
  }
  return ranges;
}
function saveCfRule(e, id) {
  e.preventDefault();
  const f = e.target;
  const col = f.col.value;
  const screens = [...f.querySelectorAll('.cf-screen:checked')].map(x => x.value);
  const ranges = cfCollectRanges(f);
  if (ranges == null) return false;
  if (!ranges.length) { toast('範囲を1行以上入力してください'); return false; }
  store.data.cfRules = store.data.cfRules || [];
  // updatedAt を打って同期マージで新しい方が勝つようにする。編集時は deleted を解除（復活）。
  if (id) { const gr = store.data.cfRules.find(x => x.id === id); if (gr) Object.assign(gr, { col, screens, ranges, deleted: false, updatedAt: store._now() }); }
  else { store.data.cfRules.push({ id: cfNewId(), col, screens, ranges, updatedAt: store._now() }); }
  store.save(); render(); openCfRulesMaster();
  return false;
}
// 編集中の設定（適用画面＋範囲）を、選んだ別の列に新規グループとしてコピー作成する。
function cfCopyToCol() {
  const f = document.getElementById('cf-rule-form'); if (!f) return;
  const sel = document.getElementById('cf-copy-col'); const targetCol = sel ? sel.value : '';
  if (!targetCol) { toast('コピー先の列を選んでください'); return; }
  const screens = [...f.querySelectorAll('.cf-screen:checked')].map(x => x.value);
  const ranges = cfCollectRanges(f);
  if (ranges == null) return;
  if (!ranges.length) { toast('範囲を1行以上入力してください'); return; }
  store.data.cfRules = store.data.cfRules || [];
  store.data.cfRules.push({ id: cfNewId(), col: targetCol, screens, ranges, updatedAt: store._now() });
  store.save(); render();
  const lbl = (MASTER_COLS.find(m => m.key === targetCol) || {}).label || targetCol;
  toast(`「${lbl}」に設定をコピーしました`);
  openCfRulesMaster();
}
// 削除はトンボストン化（配列から消さず deleted:true＋updatedAt）。これで「削除」が同期で他端末に
// 伝播し、別端末が既定を再シードしても updatedAt の新しい削除が勝つ（＝勝手に復活しない）。
function deleteCfRule(id) {
  const g = (store.data.cfRules || []).find(x => x.id === id);
  if (g) { g.deleted = true; g.updatedAt = store._now(); }
  store.save(); render(); openCfRulesMaster();
}
function resetCfRules() {
  if (!confirm('背景色ルールを既定（初期状態）に戻します。よろしいですか？')) return;
  const now = store._now();
  const defs = defaultCfRules();
  const defIds = new Set(defs.map(d => d.id));
  // 既存グループは全てトンボストン化（同期で削除を伝播）。既定idと被るものは下で復活させる。
  for (const g of (store.data.cfRules || [])) { g.deleted = true; g.updatedAt = now; }
  const byId = new Map((store.data.cfRules || []).map(g => [g.id, g]));
  for (const d of defs) {
    const ex = byId.get(d.id);
    if (ex) Object.assign(ex, d, { deleted: false, updatedAt: now }); // 既定idを復活＆既定内容で上書き
    else (store.data.cfRules = store.data.cfRules || []).push({ ...d, updatedAt: now });
  }
  store.save(); render(); openCfRulesMaster();
}

// ---------- 取込タブ（銘柄・保有データの取込を集約） ----------
// ソースカード定義（各社のロゴ色・入力方式）。key は IMPORT_PROFILES に対応
const IMPORT_SOURCES = [
  { key: 'sbi-jp',     name: 'SBI証券（日本株・投信）', logo: 'SBI', color: '#0a8f3c' },
  { key: 'sbi-us',     name: 'SBI証券 米国株',   logo: 'SBI', color: '#0a8f3c' },
  { key: 'rakuten',    name: '楽天証券',         logo: '楽',  color: '#bf0000' },
  { key: 'moomoo',     name: 'moomoo証券',       logo: 'mo',  color: '#ff7a00' },
  { key: 'monex-fund', name: 'マネックス 投資信託', logo: 'MO', color: '#005bac' },
  { key: 'monex-jp',   name: 'マネックス 日本株', logo: 'MO', color: '#005bac' },
  { key: 'smbc',       name: 'SMBC日興証券',     logo: '日',  color: '#00529b' },
];
function importSourceCard(s) {
  const p = IMPORT_PROFILES[s.key]; if (!p) return '';
  const method = p.input === 'file' ? 'CSVファイル' : '画面コピーを貼付';
  const tags = (p.scope.markets || []).map(m => `<span class="tag ${m.toLowerCase()}">${MARKET_LABEL[m]}</span>`).join('')
    + `<span class="mini">${p.input === 'file' ? 'CSV' : '貼付'}</span>`;
  return `<button class="source-card" onclick="openBrokerImport('${s.key}')">
    <div class="sc-top"><div class="sc-logo" style="background:${s.color}">${esc(s.logo)}</div>
      <div><div class="sc-name">${esc(s.name)}</div><div class="sc-meta">${method}</div></div></div>
    <div class="sc-tags">${tags}</div>
  </button>`;
}
function renderImport() {
  app.innerHTML = `
    <div class="page-intro">
      <h2>取込</h2>
      <p>各証券会社の保有データ（CSV・画面コピー）を取り込み、保有・銘柄マスタへ反映します。取込元を選んでください。</p>
    </div>
    <div class="section">
      <div class="section-head"><h2>① 保有を取り込む — 取込元を選択</h2>
        <button class="btn btn-sm" style="margin-left:auto" onclick="openImportMapping()">取込フィールド設定</button></div>
      <div style="padding:18px">
        <div class="source-grid">${IMPORT_SOURCES.map(importSourceCard).join('')}</div>
        <p class="muted grp-note" style="margin:14px 0 0">カードを選ぶと貼付/CSVの取込画面が開きます。ティッカー・コードで銘柄に紐づけ（未登録は新規作成可）。各社形式は「洗い替え（その証券会社の保有を入れ替え）」。<strong>同じCSV内の投資信託は自動で仕分けして保存</strong>（コードが無いため名称で内部コードを補完）し、保有銘柄の「投資信託」で確認できます。</p>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>取込状況（最終取込日時）</h2></div>
      <div class="section-body" style="padding:16px">
        ${importStatusHtml()}
        ${importHistorySection()}
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>② 汎用データ（取込 ⇄ 出力）</h2></div>
      <div class="section-body" style="padding:16px">
        <div class="btn-row">
          <button class="btn btn-primary" onclick="openGenericImport()">汎用取込（列を選んで取込）</button>
          <button class="btn" onclick="openGenericExport()">汎用出力（CSV）</button>
        </div>
        <p class="muted grp-note">CSV/Excelを貼り付け→列ごとに取込先を選んで上書き（コード・市場は必須）。分析・詳細種別・取得円・保有・メモ・売却前購入額まで自由に取込でき、フォーマット保存も可能。汎用出力した内容はそのまま汎用取込で戻せます（管理項目をすべて往復）。</p>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>③ 銘柄情報・分析を取り込む</h2></div>
      <div class="section-body" style="padding:16px">
        <div class="btn-row">
          <button class="btn" onclick="refreshAllMeta()">銘柄情報を更新（名前・セクター・PER等）</button>
          <button class="btn" onclick="openPasteImport('analysis')">銘柄分析結果を取込</button>
        </div>
        <p class="muted grp-note">「銘柄情報を更新」＝名前・セクター・ファンダを自動取得。「銘柄分析結果を取込」＝分析Excelを貼り付け。</p>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>④ 取引履歴を取り込む</h2></div>
      <div class="section-body" style="padding:16px">
        <div class="btn-row">
          <button class="btn btn-primary" onclick="openTxnImport()">取引履歴を一括取込（貼付け）</button>
          <button class="btn" onclick="openTxnSettleImport()">受渡金額(円)を一括上書き</button>
        </div>
        <p class="muted grp-note">1銘柄分の過去の売買明細（日付・種別・数量・単価…）を貼り付けて一括登録。<strong>「保有に反映しない（履歴のみ）」を既定ON</strong>にしてあるので、現在の保有数量・平均取得単価を崩さず過去履歴を入れられます（前回購入日・購入回数・判定には反映）。</p>
        <p class="muted grp-note">「受渡金額(円)を一括上書き」＝記録時に空欄にした受渡金額(円)を、取引報告書を貼り付けて<strong>既存の取引にまとめて反映</strong>。<strong>銘柄×日付×種別×数量×証券会社×口座</strong>が一致した取引にだけ書き込みます（一致なし・複数一致はスキップ）。</p>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>⑤ 取得円台帳（米国株・外国株式等取引報告書）</h2></div>
      <div class="section-body" style="padding:16px">
        <div class="btn-row">
          <button class="btn btn-primary" onclick="openAcqLedger()">台帳を開く（取込・反映・編集）</button>
        </div>
        <p class="muted grp-note">外国株式等取引報告書（ChatGPT等で表に整形）を貼り付けて<strong>取得円台帳</strong>に蓄積し、「保有へ反映」で保有の「取得円」を更新します（<strong>差分を確認してから上書き・自動では変えません</strong>）。取引履歴・購入回数・前回購入日には影響しません。買い=受渡金額(円)を加算 / 売り=取得円を売却割合で按分減算。証券会社ごとの取込済み最新日付・株数の整合性チェックつき。</p>
        ${(() => { const s = acqLedgerBrokerSummary(); const ks = Object.keys(s); return ks.length ? `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">${ks.map(b => `<span class="tag">${esc(b)}: ${esc(s[b].latest || '—')}（${s[b].count}件）</span>`).join('')}</div>` : ''; })()}
      </div>
    </div>`;
}

// ---------- 取引履歴の一括取込（1銘柄分の売買明細を貼付けで一括登録） ----------
let _txnImportRows = [];
let _txnImportMarket = 'JP';
function openTxnImport() {
  _txnImportRows = [];
  const mktOpts = [['JP', '日本株'], ['US', '米国株']].map(([v, l]) => `<option value="${v}" ${_txnImportMarket === v ? 'selected' : ''}>${l}</option>`).join('');
  showModal('取引履歴を一括取込', `
    <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
      <div class="field" style="max-width:140px"><label>市場</label><select id="ti-market" onchange="_txnImportMarket=this.value">${mktOpts}</select></div>
      <div class="field" style="max-width:180px"><label>証券コード/ティッカー</label><input id="ti-code" type="text" placeholder="例: 7203 / AAPL" autocomplete="off"></div>
      <div class="field" style="max-width:160px"><label>既定の証券会社</label><select id="ti-broker">${BROKERS.map(b => `<option>${b}</option>`).join('')}</select></div>
      <div class="field" style="max-width:140px"><label>既定の口座種別</label><select id="ti-account">${ACCOUNTS.map(a => `<option>${a}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>明細を貼り付け（1行=1取引／タブ・カンマ・マークダウン表対応）</label>
      <textarea id="ti-text" rows="8" placeholder="日付&#9;種別&#9;数量&#9;単価&#9;[証券会社]&#9;[口座]&#9;[受渡金額]&#10;2024-01-15&#9;買い&#9;100&#9;2500&#9;SBI&#9;特定&#10;2024/03/02&#9;売り&#9;50&#9;2700"></textarea></div>
    <p class="muted" style="font-size:12px;margin:2px 0 8px">列の順番: <strong>日付 / 種別(買い・売り) / 数量 / 単価 / 証券会社(任意) / 口座種別(任意) / 受渡金額(任意・米株の取得円用)</strong>。先頭の見出し行は自動スキップ。証券会社・口座が空の行は上の「既定」を使います。</p>
    <label class="chk-row" style="display:flex;gap:8px;align-items:center;margin:2px 0 4px;cursor:pointer" title="現在の保有を崩さず過去履歴を登録。前回購入日・購入回数・判定には反映。OFFにすると保有数量・平均取得単価も再計算">
      <input id="ti-ledger" type="checkbox" checked>
      <span>保有に反映しない（履歴のみ＝推奨）</span>
    </label>
    <label class="chk-row" style="display:flex;gap:8px;align-items:center;margin:2px 0 8px;cursor:pointer" title="取り込む買いの単価・日付を前回購入単価／前回購入日に使わない（次回購入トリガー・高値更新判定が動かない）">
      <input id="ti-skipprev" type="checkbox">
      <span>前回購入額を更新しない</span>
    </label>
    <div class="form-actions" style="justify-content:flex-start">
      <button type="button" class="btn" onclick="txnImportPreview()">プレビュー</button>
      <button type="button" class="btn btn-primary" id="ti-commit" onclick="txnImportCommit()" disabled>取込実行</button>
      <button type="button" class="btn" onclick="closeModal()">閉じる</button>
    </div>
    <div id="ti-preview" style="margin-top:10px"></div>`, { wide: true });
}
function _txnImportParse() {
  const market = document.getElementById('ti-market').value;
  const code = document.getElementById('ti-code').value.trim();
  const text = document.getElementById('ti-text').value;
  const result = { market, code, sec: code ? mktFindSec(code, market) : null, rows: [], errors: [] };
  const toNum = s => { const v = parseFloat(String(s).replace(/[,¥$\s]/g, '')); return isFinite(v) ? v : NaN; };
  let lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const md = isMdTable(lines);
  if (md) lines = lines.filter(l => !isMdSepRow(l)); // マークダウン表の区切り行を除去
  lines.forEach((line, i) => {
    const cols = md ? splitMdRow(line) : (line.includes('\t') ? line.split('\t') : line.split(',')).map(c => c.trim());
    // 見出し行スキップ（先頭行かつ単価列が数値でない場合）
    if (i === 0 && /日付|種別|単価|数量|date|type|price|qty/i.test(line) && isNaN(toNum(cols[2]))) return;
    if (cols.length < 4) { result.errors.push(`${i + 1}行目: 列が足りません（日付/種別/数量/単価が必要）`); return; }
    const [d, ty, q, p, br, ac, st] = cols;
    const dm = d.replace(/\//g, '-').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!dm) { result.errors.push(`${i + 1}行目: 日付の形式が不正（${d}）`); return; }
    const tradedAt = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;
    const type = /買|buy/i.test(ty) ? 'buy' : /売|sell/i.test(ty) ? 'sell' : null;
    if (!type) { result.errors.push(`${i + 1}行目: 種別が不明（${ty}）`); return; }
    const quantity = toNum(q), price = toNum(p);
    if (isNaN(quantity) || isNaN(price)) { result.errors.push(`${i + 1}行目: 数量・単価が数値ではありません`); return; }
    const settleJpy = (st != null && st !== '') ? toNum(st) : NaN;
    result.rows.push({ tradedAt, type, quantity, price, broker: (br || '').trim() || null, accountType: (ac || '').trim() || null, settleJpy: isNaN(settleJpy) ? null : settleJpy });
  });
  return result;
}
function txnImportPreview() {
  const r = _txnImportParse();
  _txnImportRows = [];
  const el = document.getElementById('ti-preview');
  const commitBtn = document.getElementById('ti-commit');
  if (!r.code) { el.innerHTML = '<div class="notice">証券コード/ティッカーを入力してください。</div>'; commitBtn.disabled = true; return; }
  if (!r.sec) { el.innerHTML = `<div class="notice">「${esc(MARKET_LABEL[r.market] || r.market)} / ${esc(r.code)}」は未登録です。先に銘柄マスタで登録してください。</div>`; commitBtn.disabled = true; return; }
  const defBroker = document.getElementById('ti-broker').value;
  const defAccount = document.getElementById('ti-account').value;
  r.rows.forEach(row => { row.broker = row.broker || defBroker; row.accountType = row.accountType || defAccount; });
  _txnImportRows = r.rows;
  const ccy = MARKET_CCY[r.sec.market];
  const rowsHtml = r.rows.map(t => `<tr><td class="l">${esc(t.tradedAt)}</td><td class="l">${t.type === 'buy' ? '買い' : '売り'}</td><td>${fmtQty(t.quantity, r.sec.market)}</td><td>${ccy}${num(t.price)}</td><td class="l">${esc(t.broker)}</td><td class="l">${esc(t.accountType)}</td></tr>`).join('');
  const errHtml = r.errors.length ? `<div class="notice" style="margin-top:8px">${r.errors.map(esc).join('<br>')}</div>` : '';
  el.innerHTML = `<div class="muted" style="margin:4px 0">対象: <strong>${esc(calc.displayName(r.sec))}</strong> ／ 取込可能 ${r.rows.length}件${r.errors.length ? ` ／ エラー ${r.errors.length}件` : ''}</div>
    ${r.rows.length ? `<div class="table-wrap"><table class="holdings dense"><thead><tr><th class="l">日付</th><th class="l">種別</th><th>数量</th><th>単価</th><th class="l">証券会社</th><th class="l">口座</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>` : ''}
    ${errHtml}`;
  commitBtn.disabled = r.rows.length === 0;
}
function txnImportCommit() {
  if (!_txnImportRows.length) return;
  const market = document.getElementById('ti-market').value;
  const code = document.getElementById('ti-code').value.trim();
  const sec = mktFindSec(code, market);
  if (!sec) { toast('銘柄が見つかりません'); return; }
  const ledgerOnly = document.getElementById('ti-ledger').checked;
  const skipPrevBuy = document.getElementById('ti-skipprev').checked;
  let n = 0;
  for (const t of _txnImportRows) {
    store.addTransaction({
      securityId: sec.id, type: t.type, price: t.price, quantity: t.quantity,
      broker: t.broker, accountType: t.accountType, tradedAt: t.tradedAt,
      ...(ledgerOnly ? { ledgerOnly: true } : {}),
      ...((skipPrevBuy && t.type === 'buy') ? { skipPrevBuy: true } : {}),
      ...(t.settleJpy != null ? { settleJpy: t.settleJpy } : {}),
    });
    n++;
  }
  _txnImportRows = [];
  closeModal();
  toast(`${n}件の取引を取り込みました`);
  render();
}

// ---------- 受渡金額(円)を既存取引に一括上書き ----------
// 記録時に空欄にした受渡金額(円)=settleJpy を、取引報告書を貼り付けて既存取引にまとめて反映する。
// 同一判定キー: 銘柄(securityId) × 日付 × 種別 × 数量 × 証券会社 × 口座。一致なし・複数一致はスキップ。
const TS_FIELDS = [
  { key: 'ticker', label: 'コード/ティッカー', req: true },
  { key: 'market', label: '市場', req: true },
  { key: 'tradedAt', label: '日付', req: true },
  { key: 'type', label: '種別(買/売)', req: true },
  { key: 'quantity', label: '数量', req: true },
  { key: 'broker', label: '証券会社', req: true },
  { key: 'account', label: '口座', req: true },
  { key: 'settleJpy', label: '受渡金額(円)', req: true },
];
const TS_FIXED_KEYS = ['market', 'type', 'broker', 'account'];
const TS_AUTOMAP = {
  'ティッカー': 'ticker', 'コード': 'ticker', '銘柄コード': 'ticker', '証券コード': 'ticker', '銘柄': 'ticker', '市場': 'market',
  '日付': 'tradedAt', '約定日': 'tradedAt', '取引日': 'tradedAt', '受渡日': 'tradedAt',
  '種別': 'type', '売買': 'type', '売買区分': 'type', '取引区分': 'type',
  '数量': 'quantity', '株数': 'quantity', '約定数量': 'quantity', '約定株数': 'quantity',
  '証券会社': 'broker', '口座': 'account', '口座種別': 'account',
  '受渡金額(円)': 'settleJpy', '受渡金額（円）': 'settleJpy', '受渡金額': 'settleJpy', '国内受渡金額': 'settleJpy',
  '受取金額(円)': 'settleJpy', '受取金額（円）': 'settleJpy', '受取金額': 'settleJpy',
};
let _tsHeaders = [], _tsRows = [], _tsMapping = [];

function openTxnSettleImport() {
  _tsHeaders = []; _tsRows = []; _tsMapping = [];
  showModal('受渡金額(円)を一括上書き', `
    <p class="muted" style="margin:0 0 8px">取引報告書などをヘッダ行ごと貼り付け→列ごとに取込先を選択。<strong>銘柄×日付×種別×数量×証券会社×口座</strong>が一致した既存取引の<strong>受渡金額(円)だけ</strong>を更新します（保有数量・平均取得単価は変えません）。一致なし・複数一致の行はスキップします。</p>
    <textarea id="ts-text" rows="6" style="width:100%;font-family:monospace;font-size:12px" placeholder="ヘッダ行を含めて貼り付け（タブ/カンマ/マークダウン表対応）" oninput="tsParse(this.value)"></textarea>
    <div id="ts-map"></div>
    <div class="grp-label" style="margin-top:8px">列に無い項目を固定値で指定（全行に適用・任意）</div>
    <div class="btn-row" style="align-items:flex-end" id="ts-fixed">
      <div class="field" style="width:auto"><label style="font-size:11px">市場</label>
        <select id="ts-fix-market" onchange="tsRenderPreview()"><option value="">―</option><option>US</option><option>JP</option></select></div>
      <div class="field" style="width:auto"><label style="font-size:11px">種別</label>
        <select id="ts-fix-type" onchange="tsRenderPreview()"><option value="">―</option><option value="buy">買い</option><option value="sell">売り</option></select></div>
      <div class="field" style="width:auto"><label style="font-size:11px">証券会社</label>
        <select id="ts-fix-broker" onchange="tsRenderPreview()"><option value="">―</option>${BROKERS.map(b => `<option>${b}</option>`).join('')}</select></div>
      <div class="field" style="width:auto"><label style="font-size:11px">口座</label>
        <select id="ts-fix-account" onchange="tsRenderPreview()"><option value="">―</option>${ACCOUNTS.map(a => `<option>${a}</option>`).join('')}</select></div>
    </div>
    <div id="ts-preview"></div>
    <div class="btn-row" style="margin-top:10px;align-items:center">
      <span style="flex:1"></span>
      <button class="btn" onclick="closeModal()">閉じる</button>
      <button class="btn btn-primary" onclick="runTxnSettleImport()">取込実行</button>
    </div>`, { wide: true });
}
function tsFixedValues() {
  const f = {};
  for (const k of TS_FIXED_KEYS) { const e = document.getElementById('ts-fix-' + k); if (e && e.value) f[k] = e.value; }
  return f;
}
function tsParse(text) {
  const mdLines = text.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  const raw = isMdTable(mdLines)
    ? mdLines.filter(l => !isMdSepRow(l)).map(splitMdRow)
    : (text.includes('\t') ? text.split(/\r?\n/).map(l => l.split('\t')) : parseCsvText(text));
  const rows = raw.filter(r => r.some(c => String(c).trim() !== ''));
  const mapDiv = document.getElementById('ts-map'), pvDiv = document.getElementById('ts-preview');
  if (!rows.length) { _tsHeaders = []; _tsRows = []; _tsMapping = []; if (mapDiv) mapDiv.innerHTML = ''; if (pvDiv) pvDiv.innerHTML = ''; return; }
  _tsHeaders = rows[0].map(h => String(h).trim());
  _tsRows = rows.slice(1);
  _tsMapping = _tsHeaders.map(h => TS_AUTOMAP[h] || '');
  tsRenderMap();
}
function tsRenderMap() {
  const opts = (sel) => `<option value="">（取込まない）</option>` + TS_FIELDS.map(f => `<option value="${f.key}" ${sel === f.key ? 'selected' : ''}>${esc(f.label)}${f.req ? ' *' : ''}</option>`).join('');
  const items = _tsHeaders.map((h, i) => `<div class="field" style="min-width:150px;flex:0 0 auto">
    <label style="font-size:11px">${esc(h || '(空欄)')}</label>
    <select onchange="tsSetMap(${i}, this.value)">${opts(_tsMapping[i])}</select></div>`).join('');
  document.getElementById('ts-map').innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0">${items}</div>`;
  tsRenderPreview();
}
function tsSetMap(i, v) { _tsMapping[i] = v; tsRenderPreview(); }
function tsNormTradedAt(s) {
  const m = String(s || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/\//g, '-').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}
function tsNormType(s) { const v = String(s || ''); return /買|buy/i.test(v) ? 'buy' : /売|sell/i.test(v) ? 'sell' : null; }
// 1行を解析し、一致候補を探す。status: ok(1件一致) / nomatch(0件) / multi(複数) / bad(必須欠落・銘柄未登録・形式NG)
function tsResolveRow(row, fixed) {
  const rec = {};
  _tsMapping.forEach((f, i) => { if (f) rec[f] = row[i] != null ? String(row[i]).trim() : ''; });
  for (const k of TS_FIXED_KEYS) { if (fixed[k] && (rec[k] == null || rec[k] === '')) rec[k] = fixed[k]; }
  const ticker = (rec.ticker || '').trim();
  let market = (rec.market || '').toUpperCase(); if (market !== 'US' && market !== 'JP') market = /米/.test(rec.market || '') ? 'US' : /^\d/.test(ticker) ? 'JP' : '';
  const tradedAt = tsNormTradedAt(rec.tradedAt);
  const type = tsNormType(rec.type);
  const quantity = numClean(rec.quantity);
  const broker = (rec.broker || '').trim() || null;
  const account = normAccount(rec.account);
  const settleJpy = numClean(rec.settleJpy);
  const info = { ticker, market, tradedAt, type, quantity, broker, account, settleJpy, status: 'bad', reason: '', matches: [] };
  if (!ticker || !market || !tradedAt || !type || quantity == null || !broker || !account || settleJpy == null) { info.reason = '必須項目が不足'; return info; }
  const tk = market === 'US' ? ticker.toUpperCase() : ticker;
  info.tk = tk;
  const sec = store.findSecurity(market, tk);
  if (!sec) { info.reason = '銘柄が未登録'; return info; }
  info.sec = sec;
  const matches = store.data.transactions.filter(t =>
    t.securityId === sec.id && t.tradedAt === tradedAt && t.type === type &&
    Math.abs((t.quantity || 0) - quantity) < 1e-9 && t.broker === broker && t.accountType === account);
  info.matches = matches;
  if (matches.length === 0) { info.status = 'nomatch'; info.reason = '一致する取引なし'; }
  else if (matches.length > 1) { info.status = 'multi'; info.reason = `${matches.length}件一致（特定不可）`; }
  else { info.status = 'ok'; info.already = matches[0].settleJpy != null; }
  return info;
}
function tsRenderPreview() {
  const pv = document.getElementById('ts-preview'); if (!pv) return;
  const fixed = tsFixedValues();
  if (!_tsRows.length) { pv.innerHTML = ''; return; }
  const missing = TS_FIELDS.filter(f => f.req && !_tsMapping.includes(f.key) && !(TS_FIXED_KEYS.includes(f.key) && fixed[f.key]));
  if (missing.length) { pv.innerHTML = `<div class="notice">未割当の必須項目: ${missing.map(f => esc(f.label)).join('・')}（市場・種別・証券会社・口座は固定値でも可）</div>`; return; }
  const infos = _tsRows.map(r => tsResolveRow(r, fixed));
  const ok = infos.filter(x => x.status === 'ok').length;
  const over = infos.filter(x => x.status === 'ok' && x.already).length;
  const skip = infos.length - ok;
  const badge = s => s === 'ok' ? '<span class="pos">○ 一致</span>' : s === 'nomatch' ? '<span class="muted">― 未一致</span>' : s === 'multi' ? '<span class="neg">△ 複数</span>' : '<span class="neg">× 不可</span>';
  const ccyOf = i => i.sec ? MARKET_CCY[i.sec.market] : '';
  const rowsHtml = infos.slice(0, 30).map(i => `<tr>
    <td class="l">${badge(i.status)}</td>
    <td class="l">${esc(i.sec ? calc.displayName(i.sec) : (i.ticker || '?'))}</td>
    <td class="l">${esc(i.tradedAt || '?')}</td>
    <td class="l">${i.type === 'buy' ? '買い' : i.type === 'sell' ? '売り' : '?'}</td>
    <td>${i.quantity != null ? esc(String(i.quantity)) : '?'}</td>
    <td class="l">${esc(i.broker || '?')}/${esc(i.account || '?')}</td>
    <td>${i.settleJpy != null ? '¥' + num(i.settleJpy) : '?'}</td>
    <td class="l muted" style="font-size:11px">${esc(i.status === 'ok' ? (i.already ? '上書き' : '新規記入') : i.reason)}</td></tr>`).join('');
  pv.innerHTML = `<div class="muted" style="margin:6px 0 4px">反映予定 <strong>${ok}件</strong>${over ? `（うち既存値の上書き ${over}件）` : ''} ／ スキップ ${skip}件 ／ 全${infos.length}行${infos.length > 30 ? '（先頭30行表示）' : ''}</div>
    <div class="table-wrap" style="max-height:260px"><table class="dense"><thead><tr><th class="l">判定</th><th class="l">銘柄</th><th class="l">日付</th><th class="l">種別</th><th>数量</th><th class="l">会社/口座</th><th>受渡金額(円)</th><th class="l">備考</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
}
function runTxnSettleImport() {
  if (!_tsRows.length) { toast('データがありません'); return; }
  const fixed = tsFixedValues();
  const missing = TS_FIELDS.filter(f => f.req && !_tsMapping.includes(f.key) && !(TS_FIXED_KEYS.includes(f.key) && fixed[f.key]));
  if (missing.length) { toast(`未割当の必須項目: ${missing.map(f => f.label).join('・')}`); return; }
  const infos = _tsRows.map(r => tsResolveRow(r, fixed));
  const ok = infos.filter(x => x.status === 'ok');
  if (!ok.length) { toast('一致する取引がありませんでした'); return; }
  let updated = 0;
  const touched = new Set();
  for (const i of ok) { if (store.setTransactionSettle(i.matches[0].id, i.settleJpy)) { updated++; if (i.sec) touched.add(i.sec); } }
  store.save();
  const nomatch = infos.filter(x => x.status === 'nomatch').length;
  const multi = infos.filter(x => x.status === 'multi').length;
  const bad = infos.filter(x => x.status === 'bad').length;
  closeModal();
  reportImport([...touched], `受渡金額(円)一括上書き: 更新 ${updated}件${nomatch ? ` / 未一致 ${nomatch}` : ''}${multi ? ` / 複数一致 ${multi}` : ''}${bad ? ` / 不備 ${bad}` : ''}（一致なし・複数一致はスキップ）`);
}

// ---------- 取得円台帳（米国株・外国株式等取引報告書） ----------
// 取得円(acqJpy)の正本となる台帳。[ティッカー×証券会社×口座] キーで報告書の明細を蓄積し、
// 「反映」で保有の取得円へ書き込む（差分を一覧表示して確認・自動では上書きしない）。
// 取引履歴(transactions)とは完全に独立（前回購入日・購入回数・買い増し判定に影響しない）。
// 重複対策: 約定番号が無いため、署名（ティッカー|会社|口座|日付|種別|数量|金額）の件数比較
// （台帳 vs 貼付データ）で既取込ぶんをスキップ予定にし、プレビューのチェックで強制取込/除外できる。
// 整合性: 台帳を再生した株数と保有の株数を比較（取込プレビュー・反映画面・台帳画面の3か所）。

function acqLedgerSig(r) {
  return [String(r.ticker || '').toUpperCase(), r.broker || '', r.accountType || '', r.date || '', r.type || '', r.quantity ?? '', r.amountJpy ?? ''].join('|');
}
// 台帳をキーごとに日付順で再生し、取得円・株数を算出。買い=受渡金額(円)加算 / 売り=按分減算（全売却で0）
function acqLedgerCompute(ledger) {
  const rows = (ledger || []).slice().sort((a, b) => ((a.date || '') < (b.date || '')) ? -1 : ((a.date || '') > (b.date || '')) ? 1 : ((a.id || 0) - (b.id || 0)));
  const byKey = new Map();
  for (const r of rows) {
    const key = `${String(r.ticker || '').toUpperCase()}|${r.broker}|${r.accountType}`;
    let st = byKey.get(key);
    if (!st) { st = { acqJpy: 0, qty: 0, lastDate: null, count: 0 }; byKey.set(key, st); }
    const q = r.quantity || 0;
    if (r.type === 'buy') { st.acqJpy += (r.amountJpy || 0); st.qty += q; }
    else if (st.qty > 1e-12) {
      const removed = Math.min(q, st.qty);
      st.acqJpy -= st.acqJpy * (removed / st.qty);
      st.qty -= removed;
      if (Math.abs(st.acqJpy) < 1e-6) st.acqJpy = 0;
      if (st.qty < 1e-12) st.qty = 0;
    }
    st.count++;
    if (r.date && (!st.lastDate || r.date > st.lastDate)) st.lastDate = r.date;
  }
  return byKey;
}
// 貼付データの各行に dup(取込済み判定) を付ける。署名ごとに「台帳内の件数」までをスキップ予定にする
// （＝同じ報告書の再貼付は増えない・本当に同一の取引が複数ある場合は超過分だけ新規になる）。
function acqLedgerDedupe(parsed, ledger) {
  const existing = {};
  for (const r of ledger || []) { const s = acqLedgerSig(r); existing[s] = (existing[s] || 0) + 1; }
  const seen = {};
  return parsed.map(r => { const s = acqLedgerSig(r); seen[s] = (seen[s] || 0) + 1; return { ...r, dup: seen[s] <= (existing[s] || 0) }; });
}
// 証券会社ごとの台帳サマリー（取込済みデータの最新日付＝データ内の日付・件数）
function acqLedgerBrokerSummary() {
  const map = {};
  for (const r of store.data.acqLedger || []) {
    const b = r.broker || '—';
    const m = (map[b] = map[b] || { latest: null, count: 0 });
    m.count++;
    if (r.date && (!m.latest || r.date > m.latest)) m.latest = r.date;
  }
  return map;
}
// 株数の整合性チェック: 台帳を全再生した株数 vs 現在の保有の株数（キーごと）。
// 不一致＝取込データの欠落/誤り か 保有側の誤り（どちらかをすみぽんが判断して直す）。
function acqLedgerQtyCheck(comp) {
  const out = [];
  for (const [key, st] of comp) {
    const [tk, broker, account] = key.split('|');
    const sec = store.findSecurity('US', tk);
    const h = sec ? store.data.holdings.find(x => x.securityId === sec.id && x.broker === broker && x.accountType === account) : null;
    const holdQty = h ? (h.quantity || 0) : 0;
    out.push({ key, tk, broker, account, sec, h, ledgerQty: st.qty, holdQty, ok: Math.abs(st.qty - holdQty) < 1e-6, secMissing: !sec, holdMissing: !h });
  }
  return out;
}
function alFmtQty(q) { return String(Math.round((q || 0) * 1e6) / 1e6); }
// 整合性チェックの共通テーブル（取込プレビュー・台帳画面で共用）
function alQtyCheckTable(checks) {
  if (!checks.length) return '<p class="muted">チェック対象がありません。</p>';
  const bad = checks.filter(c => !c.ok);
  const rows = checks.map(c => `<tr>
    <td class="l">${c.ok ? '<span class="pos">○ 一致</span>' : '<span class="neg">× 不一致</span>'}</td>
    <td class="l">${esc(c.tk)}</td><td class="l">${esc(c.broker)}/${esc(c.account)}</td>
    <td>${alFmtQty(c.ledgerQty)}</td>
    <td>${c.holdMissing ? '<span class="muted">保有なし</span>' : alFmtQty(c.holdQty)}</td>
    <td class="l muted" style="font-size:11px">${c.secMissing ? '銘柄未登録' : c.ok ? '' : '取込データの欠落/誤り か 保有側の誤り。要確認'}</td></tr>`).join('');
  return `<div class="table-wrap" style="max-height:22vh"><table class="dense"><thead><tr><th class="l">判定</th><th class="l">ティッカー</th><th class="l">会社/口座</th><th>台帳の株数</th><th>保有の株数</th><th class="l">備考</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${bad.length ? `<p class="muted" style="font-size:12px;margin:4px 0 0">不一致 ${bad.length}件。<strong>取込データが誤っているなら取込しない</strong>（過去分の欠落なら過去分も取込）。保有側が誤っているなら保有を修正してください。</p>` : ''}`;
}

// 洗い替えで消える保有の手入力系フィールド（取得円・投信評価額・売却前購入額）を退避し、
// 取込後に再作成された同一キーの保有へ復元する（取込データ自身が同項目を持つ場合は上書きしない）。
// これで「取得円列が無い証券会社のCSVで洗い替え→取得円が毎回消える」を防ぐ。
function snapshotHoldingExtras(holdings) {
  const map = {};
  for (const h of holdings) {
    const s = store.data.securities.find(x => x.id === h.securityId);
    if (!s) continue;
    const ex = {};
    if (h.acqJpy != null) ex.acqJpy = h.acqJpy;
    if (h.evalJpy != null) ex.evalJpy = h.evalJpy;
    if (h.origBuyAmount != null) ex.origBuyAmount = h.origBuyAmount;
    if (Object.keys(ex).length) map[`${s.market}:${String(s.ticker || '').toUpperCase()}|${h.broker}|${h.accountType}`] = ex;
  }
  return map;
}
function restoreHoldingExtras(map) {
  let n = 0;
  for (const key of Object.keys(map || {})) {
    const [mkTk, broker, account] = key.split('|');
    const ci = mkTk.indexOf(':');
    const sec = store.findSecurity(mkTk.slice(0, ci), mkTk.slice(ci + 1)); if (!sec) continue;
    const h = store.data.holdings.find(x => x.securityId === sec.id && x.broker === broker && x.accountType === account);
    if (!h) continue;
    let changed = false;
    for (const f of ['acqJpy', 'evalJpy', 'origBuyAmount']) {
      if (map[key][f] != null && h[f] == null) { h[f] = map[key][f]; changed = true; }
    }
    if (changed) { store.touch(h); n++; }
  }
  return n;
}

// ----- 台帳画面（一覧・編集・整合性チェック） -----
let _alFilterBroker = '';
function openAcqLedger() {
  _alFilterBroker = ''; _alFilterBad = false;
  showModal('取得円台帳（米国株）', `
    <p class="muted" style="margin:0 0 8px">報告書の明細をここに貯める → ［保有へ反映］で保有の「取得円」を上書き（差分を確認してから）。取引履歴・購入回数・前回購入日は変わりません。</p>
    <div id="al-summary"></div>
    <div class="btn-row" style="margin:10px 0">
      <button class="btn btn-primary" onclick="openAcqLedgerImport()">報告書を取込…</button>
      <button class="btn btn-primary" onclick="openAcqLedgerApply()">保有へ反映…</button>
      <button class="btn" onclick="openAcqLedgerEdit()">行を追加</button>
      <button class="btn" onclick="alToggleManageCheck()">株数チェック</button>
      <span style="flex:1"></span>
      <button class="btn" onclick="closeModal()">閉じる</button>
    </div>
    <div id="al-check"></div>
    <div id="al-table"></div>`, { wide: true });
  alRenderSummary(); alRenderTable();
}
function alRenderSummary() {
  const el = document.getElementById('al-summary'); if (!el) return;
  const sum = acqLedgerBrokerSummary();
  const keys = Object.keys(sum);
  el.innerHTML = keys.length
    ? `<div class="grp-label">取込済みデータの最新日付（証券会社ごと・データ内の日付）</div>
       <div style="display:flex;gap:12px;flex-wrap:wrap;margin:4px 0 2px">${keys.map(b => `<span class="tag" title="件数 ${sum[b].count}件">${esc(b)}: <strong>${esc(sum[b].latest || '—')}</strong>（${sum[b].count}件）</span>`).join('')}</div>
       <p class="muted" style="font-size:12px;margin:4px 0 0">この日付より後の報告書から取込すればOK（期間が重複しても件数比較でスキップ予定になります）。</p>`
    : `<p class="muted">台帳はまだ空です。「報告書を取込…」から始めてください。</p>`;
}
let _alFilterBad = false;   // 台帳一覧を「不整合（株数チェックNG）のキーの行だけ」に絞る
function alRenderTable() {
  const el = document.getElementById('al-table'); if (!el) return;
  const brokers = [...new Set((store.data.acqLedger || []).map(r => r.broker || '—'))];
  // 不整合キー集合（台帳再生の株数 ≠ 保有の株数）。行の色付けと「不整合のみ」絞り込みに使う
  const badKeys = new Set(acqLedgerQtyCheck(acqLedgerCompute(store.data.acqLedger || [])).filter(c => !c.ok).map(c => c.key));
  const keyOf = (r) => `${String(r.ticker || '').toUpperCase()}|${r.broker}|${r.accountType}`;
  let rows = (store.data.acqLedger || []).slice().sort((a, b) => ((a.date || '') < (b.date || '')) ? 1 : ((a.date || '') > (b.date || '')) ? -1 : ((b.id || 0) - (a.id || 0)));
  if (_alFilterBroker) rows = rows.filter(r => (r.broker || '—') === _alFilterBroker);
  if (_alFilterBad) rows = rows.filter(r => badKeys.has(keyOf(r)));
  const filterSel = brokers.length > 1 ? `<select onchange="alSetFilter(this.value)"><option value="">全証券会社</option>${brokers.map(b => `<option ${b === _alFilterBroker ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>` : '';
  const badBtn = `<button class="btn btn-sm ${_alFilterBad ? 'btn-primary' : ''}" onclick="alToggleBadFilter()" title="株数チェックが不一致のキーに属する行だけ表示">不整合のみ${badKeys.size ? ` (${badKeys.size}キー)` : ''}</button>`;
  const body = rows.map(r => `<tr class="${badKeys.has(keyOf(r)) ? 'al-row-bad' : ''}">
    <td class="l"><input type="checkbox" class="al-del-chk" data-id="${r.id}"></td>
    <td class="l">${esc(r.date || '—')}</td>
    <td class="l">${r.type === 'buy' ? '買' : '売'}</td>
    <td class="l">${esc(r.ticker || '')}</td>
    <td>${r.quantity != null ? esc(alFmtQty(r.quantity)) : '—'}</td>
    <td>${r.amountJpy != null ? '¥' + num(Math.round(r.amountJpy)) : '—'}</td>
    <td class="l">${esc(r.broker || '—')}/${esc(r.accountType || '—')}</td>
    <td class="l nowrap"><button class="btn btn-sm" onclick="openAcqLedgerEdit(${r.id})">編集</button>
      <button class="btn btn-sm btn-danger" onclick="alRemoveRow(${r.id})">削除</button></td>
  </tr>`).join('');
  el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;margin:4px 0">${badBtn}<span style="flex:1"></span>
      <button class="btn btn-sm btn-danger" onclick="alDeleteSelected()">選択を削除</button>${filterSel}</div>
    <div class="table-wrap" style="max-height:44vh"><table class="dense no-rowclick" style="width:100%"><thead><tr>
      <th class="l"><input type="checkbox" onchange="document.querySelectorAll('#al-table .al-del-chk').forEach(c=>c.checked=this.checked)" title="全選択"></th>
      <th class="l">日付</th><th class="l">種別</th><th class="l">ティッカー</th><th>数量</th><th>受渡金額(円)</th><th class="l">会社/口座</th><th class="l">操作</th></tr></thead><tbody>${body || `<tr><td colspan="8" class="muted l">該当なし</td></tr>`}</tbody></table></div>`;
}
function alSetFilter(v) { _alFilterBroker = v; alRenderTable(); }
function alToggleBadFilter() { _alFilterBad = !_alFilterBad; alRenderTable(); }
// 複数選択削除（チェックした台帳行をまとめて削除）
function alDeleteSelected() {
  const ids = [...document.querySelectorAll('#al-table .al-del-chk:checked')].map(c => parseInt(c.dataset.id, 10));
  if (!ids.length) { toast('削除する行にチェックを付けてください'); return; }
  if (!confirm(`選択した ${ids.length} 行を台帳から削除します。よろしいですか？\n（保有の取得円は次回の「保有へ反映」で再計算されます）`)) return;
  store.removeAcqLedgerRows(ids);
  alRenderSummary(); alRenderTable();
  const chk = document.getElementById('al-check'); if (chk && chk.innerHTML) { chk.innerHTML = ''; alToggleManageCheck(); }
  toast(`${ids.length} 行を削除しました`);
}
function alRemoveRow(id) {
  if (!confirm('この台帳行を削除します。よろしいですか？\n（反映済みの保有の取得円はすぐには変わりません。次回の「保有へ反映」で再計算されます）')) return;
  store.removeAcqLedgerRow(id);
  alRenderSummary(); alRenderTable();
  const chk = document.getElementById('al-check'); if (chk && chk.innerHTML) { chk.innerHTML = ''; alToggleManageCheck(); }
}
function alToggleManageCheck() {
  const el = document.getElementById('al-check'); if (!el) return;
  if (el.innerHTML) { el.innerHTML = ''; return; }
  const checks = acqLedgerQtyCheck(acqLedgerCompute(store.data.acqLedger || []));
  el.innerHTML = `<div class="grp-label">株数の整合性チェック（台帳の再生結果 vs 現在の保有）</div>${alQtyCheckTable(checks)}`;
}
// 台帳行の追加・編集フォーム
function openAcqLedgerEdit(id) {
  const r = id != null ? (store.data.acqLedger || []).find(x => x.id === id) : null;
  showModal(r ? '台帳行を編集' : '台帳行を追加', `
    <form id="al-edit-form">
      <div class="row">
        <div class="field"><label>日付（約定日）</label><input name="date" type="date" value="${r ? (r.date || '') : today()}" required></div>
        <div class="field"><label>種別</label><select name="type"><option value="buy" ${!r || r.type === 'buy' ? 'selected' : ''}>買い</option><option value="sell" ${r && r.type === 'sell' ? 'selected' : ''}>売り</option></select></div>
      </div>
      <div class="row">
        <div class="field"><label>ティッカー（米国株）</label><input name="ticker" value="${r ? esc(r.ticker || '') : ''}" style="text-transform:uppercase" required></div>
        <div class="field"><label>数量（端株可）</label><input name="quantity" type="number" step="any" value="${r ? (r.quantity ?? '') : ''}" required></div>
      </div>
      <div class="row">
        <div class="field"><label>受渡金額(円)（買いは必須・売りは任意）</label><input name="amountJpy" type="number" step="any" value="${r ? (r.amountJpy ?? '') : ''}"></div>
      </div>
      <div class="row">
        <div class="field"><label>証券会社</label><select name="broker">${BROKERS.map(b => `<option ${r && r.broker === b ? 'selected' : ''}>${b}</option>`).join('')}</select></div>
        <div class="field"><label>口座種別</label><select name="accountType">${ACCOUNTS.map(a => `<option ${r && r.accountType === a ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn" onclick="openAcqLedger()">キャンセル</button>
        <button type="submit" class="btn btn-primary">${r ? '更新' : '追加'}</button>
      </div>
    </form>`);
  document.getElementById('al-edit-form').onsubmit = (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const amt = f.amountJpy.value.trim() === '' ? null : (parseFloat(f.amountJpy.value) || 0);
    const patch = {
      date: f.date.value, type: f.type.value, ticker: f.ticker.value.trim().toUpperCase(),
      quantity: parseFloat(f.quantity.value) || 0, amountJpy: amt,
      broker: f.broker.value, accountType: f.accountType.value,
    };
    if (!patch.ticker || !patch.date || !patch.quantity) { toast('日付・ティッカー・数量は必須です'); return; }
    if (patch.type === 'buy' && patch.amountJpy == null) { toast('買いは受渡金額(円)が必須です'); return; }
    if (r) store.updateAcqLedgerRow(r.id, patch); else store.addAcqLedgerRows([patch]);
    openAcqLedger();
    toast(r ? '台帳行を更新しました' : '台帳行を追加しました');
  };
}

// ----- 報告書の取込（貼付＋列マッピング＋重複プレビュー＋株数チェック） -----
const AL_FIELDS = [
  { key: 'date', label: '日付（約定日）', req: true },
  { key: 'type', label: '種別(買/売)', req: true },
  { key: 'ticker', label: 'ティッカー', req: true },
  { key: 'quantity', label: '数量', req: true },
  { key: 'amountJpy', label: '受渡金額(円)', req: true },
  { key: 'broker', label: '証券会社', req: true },
  { key: 'accountType', label: '口座', req: true },
];
const AL_FIXED_KEYS = ['type', 'broker', 'accountType'];
const AL_AUTOMAP = {
  '日付': 'date', '約定日': 'date', '取引日': 'date', '受渡日': 'date',
  '種別': 'type', '売買': 'type', '売買区分': 'type', '取引区分': 'type', '取引': 'type',
  'ティッカー': 'ticker', 'コード': 'ticker', '銘柄コード': 'ticker', 'シンボル': 'ticker', '銘柄': 'ticker',
  '数量': 'quantity', '株数': 'quantity', '約定数量': 'quantity', '約定株数': 'quantity',
  '受渡金額(円)': 'amountJpy', '受渡金額（円）': 'amountJpy', '受渡金額': 'amountJpy', '国内受渡金額': 'amountJpy', '受取金額(円)': 'amountJpy', '受取金額': 'amountJpy',
  '証券会社': 'broker', '口座': 'accountType', '口座種別': 'accountType',
};
const AL_GPT_PROMPT = '添付した外国株式等取引報告書PDF（複数可）の全取引を、1取引=1行のマークダウン表にしてください。\n列の順: 約定日 | 種別 | ティッカー | 数量 | 受渡金額(円) | 証券会社 | 口座\n・約定日は YYYY-MM-DD 形式\n・種別は「買」または「売」\n・数量は株数（小数はそのまま）\n・受渡金額(円)は円貨の受渡金額（カンマなしの数値）\n・証券会社は ' + BROKERS.join(' / ') + ' のいずれかの表記（例: ウィブル証券→Webull）\n・口座は 特定/一般/NISA のいずれか\n・1行目はヘッダ行。表以外の文章は出力しない';
let _alHeaders = [], _alRows = [], _alMapping = [], _alParsed = [];
function openAcqLedgerImport() {
  _alHeaders = []; _alRows = []; _alMapping = []; _alParsed = [];
  showModal('取得円台帳へ取込（外国株式等取引報告書）', `
    <p class="muted" style="margin:0 0 8px">貼り付け → 列を割当 → プレビューで確認して取込。<strong>取込済みの行は自動でチェックが外れます</strong>（重複防止。手動で付け外し可）。ここは台帳に貯めるだけで、保有の取得円は変わりません。</p>
    <details style="margin:0 0 8px"><summary class="muted" style="cursor:pointer">ChatGPTでPDFを整形する場合の指示文（コピーして使用）</summary>
      <textarea id="al-gpt" rows="8" readonly style="width:100%;font-family:monospace;font-size:11px">${esc(AL_GPT_PROMPT)}</textarea>
      <button class="btn btn-sm" style="margin-top:4px" onclick="alCopyPrompt()">指示文をコピー</button></details>
    <textarea id="al-text" rows="6" style="width:100%;font-family:monospace;font-size:12px" placeholder="ヘッダ行を含めて貼り付け（タブ/カンマ/マークダウン表対応）" oninput="alParse(this.value)"></textarea>
    <div id="al-map"></div>
    <div class="grp-label" style="margin-top:8px">列に無い項目を固定値で指定（全行に適用・任意）</div>
    <div class="btn-row" style="align-items:flex-end">
      <div class="field" style="width:auto"><label style="font-size:11px">種別</label>
        <select id="al-fix-type" onchange="alRenderPreview()"><option value="">―</option><option value="buy">買い</option><option value="sell">売り</option></select></div>
      <div class="field" style="width:auto"><label style="font-size:11px">証券会社</label>
        <select id="al-fix-broker" onchange="alRenderPreview()"><option value="">―</option>${BROKERS.map(b => `<option>${b}</option>`).join('')}</select></div>
      <div class="field" style="width:auto"><label style="font-size:11px">口座</label>
        <select id="al-fix-accountType" onchange="alRenderPreview()"><option value="">―</option>${ACCOUNTS.map(a => `<option>${a}</option>`).join('')}</select></div>
    </div>
    <div id="al-preview"></div>
    <div id="al-qty-check"></div>
    <div class="btn-row" style="margin-top:10px">
      <span style="flex:1"></span>
      <button class="btn" onclick="openAcqLedger()">戻る</button>
      <button class="btn btn-primary" onclick="runAcqLedgerImport()">チェックした行を台帳へ取込</button>
    </div>`, { wide: true });
}
function alCopyPrompt() {
  const t = document.getElementById('al-gpt'); if (!t) return;
  t.select(); t.setSelectionRange(0, 99999);
  try { navigator.clipboard.writeText(t.value); } catch (_) { try { document.execCommand('copy'); } catch (_) {} }
  toast('指示文をコピーしました');
}
function alFixedValues() {
  const f = {};
  for (const k of AL_FIXED_KEYS) { const e = document.getElementById('al-fix-' + k); if (e && e.value) f[k] = e.value; }
  return f;
}
function alParse(text) {
  const mdLines = text.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  const raw = isMdTable(mdLines)
    ? mdLines.filter(l => !isMdSepRow(l)).map(splitMdRow)
    : (text.includes('\t') ? text.split(/\r?\n/).map(l => l.split('\t')) : parseCsvText(text));
  const rows = raw.filter(r => r.some(c => String(c).trim() !== ''));
  const mapDiv = document.getElementById('al-map'), pvDiv = document.getElementById('al-preview');
  if (!rows.length) { _alHeaders = []; _alRows = []; _alMapping = []; _alParsed = []; if (mapDiv) mapDiv.innerHTML = ''; if (pvDiv) pvDiv.innerHTML = ''; const qc = document.getElementById('al-qty-check'); if (qc) qc.innerHTML = ''; return; }
  _alHeaders = rows[0].map(h => String(h).trim());
  _alRows = rows.slice(1);
  _alMapping = _alHeaders.map(h => AL_AUTOMAP[h] || '');
  alRenderMap();
}
function alRenderMap() {
  const opts = (sel) => `<option value="">（取込まない）</option>` + AL_FIELDS.map(f => `<option value="${f.key}" ${sel === f.key ? 'selected' : ''}>${esc(f.label)}${f.req ? ' *' : ''}</option>`).join('');
  const items = _alHeaders.map((h, i) => `<div class="field" style="min-width:150px;flex:0 0 auto">
    <label style="font-size:11px">${esc(h || '(空欄)')}</label>
    <select onchange="alSetMap(${i}, this.value)">${opts(_alMapping[i])}</select></div>`).join('');
  document.getElementById('al-map').innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0">${items}</div>`;
  alRenderPreview();
}
function alSetMap(i, v) { _alMapping[i] = v; alRenderPreview(); }
// 1行を解析。status: ok / bad（必須欠落・形式NG）。ok でも銘柄未登録は note を付ける（取込は可・反映時に必要）
function alResolveRow(row, fixed) {
  const rec = {};
  _alMapping.forEach((f, i) => { if (f) rec[f] = row[i] != null ? String(row[i]).trim() : ''; });
  for (const k of AL_FIXED_KEYS) { if (fixed[k] && (rec[k] == null || rec[k] === '')) rec[k] = fixed[k]; }
  const date = tsNormTradedAt(rec.date);
  const type = tsNormType(rec.type);
  const ticker = (rec.ticker || '').trim().toUpperCase();
  const quantity = numClean(rec.quantity);
  const amountJpy = numClean(rec.amountJpy);
  const broker = (rec.broker || '').trim() || null;
  const accountType = normAccount(rec.accountType);
  const info = { date, type, ticker, quantity, amountJpy: amountJpy != null ? amountJpy : null, broker, accountType, status: 'bad', reason: '' };
  if (!date || !type || !ticker || quantity == null || !broker || !accountType) { info.reason = '必須項目が不足'; return info; }
  if (!validTicker(ticker, 'US')) { info.reason = 'ティッカー形式NG'; return info; }
  if (type === 'buy' && info.amountJpy == null) { info.reason = '買いの受渡金額(円)なし'; return info; }
  info.status = 'ok';
  if (!store.findSecurity('US', ticker)) info.note = '銘柄未登録（取込は可・反映には登録が必要）';
  return info;
}
function alRenderPreview() {
  const pv = document.getElementById('al-preview'); if (!pv) return;
  const qc = document.getElementById('al-qty-check');
  if (!_alRows.length) { pv.innerHTML = ''; if (qc) qc.innerHTML = ''; _alParsed = []; return; }
  const fixed = alFixedValues();
  const missing = AL_FIELDS.filter(f => f.req && !_alMapping.includes(f.key) && !(AL_FIXED_KEYS.includes(f.key) && fixed[f.key]));
  if (missing.length) { pv.innerHTML = `<div class="notice">未割当の必須項目: ${missing.map(f => esc(f.label)).join('・')}（種別・証券会社・口座は固定値でも可）</div>`; if (qc) qc.innerHTML = ''; _alParsed = []; return; }
  const infos = _alRows.map(r => alResolveRow(r, fixed));
  const oks = infos.filter(i => i.status === 'ok');
  const dedup = acqLedgerDedupe(oks, store.data.acqLedger || []);
  let di = 0;
  _alParsed = infos.map(i => i.status === 'ok' ? dedup[di++] : i);
  const newN = _alParsed.filter(i => i.status === 'ok' && !i.dup).length;
  const dupN = _alParsed.filter(i => i.status === 'ok' && i.dup).length;
  const badN = _alParsed.filter(i => i.status !== 'ok').length;
  const rows = _alParsed.map((i, idx) => `<tr${i.status === 'ok' ? ` data-alkey="${esc(`${i.ticker}|${i.broker}|${i.accountType}`)}"` : ' style="opacity:.55"'}>
    <td class="l">${i.status === 'ok' ? `<input type="checkbox" class="al-chk" data-idx="${idx}" ${i.dup ? '' : 'checked'} onchange="alRenderImportCheck()">` : ''}</td>
    <td class="l">${esc(i.date || '?')}</td>
    <td class="l">${i.type === 'buy' ? '買' : i.type === 'sell' ? '売' : '?'}</td>
    <td class="l">${esc(i.ticker || '?')}</td>
    <td>${i.quantity != null ? esc(alFmtQty(i.quantity)) : '?'}</td>
    <td>${i.amountJpy != null ? '¥' + num(Math.round(i.amountJpy)) : '—'}</td>
    <td class="l">${esc(i.broker || '?')}/${esc(i.accountType || '?')}</td>
    <td class="l muted" style="font-size:11px">${i.status === 'ok' ? (i.dup ? '取込済み（スキップ予定）' : (i.note || '新規')) : esc(i.reason)}</td>
  </tr>`).join('');
  pv.innerHTML = `<div class="muted" style="margin:6px 0 4px">新規 <strong>${newN}件</strong> ／ 取込済みスキップ予定 ${dupN}件 ／ 不備 ${badN}件（チェックで変更可）</div>
    <div class="table-wrap" style="max-height:34vh"><table class="dense no-rowclick" style="width:100%"><thead><tr><th class="l">取込</th><th class="l">日付</th><th class="l">種別</th><th class="l">ティッカー</th><th>数量</th><th>受渡金額(円)</th><th class="l">会社/口座</th><th class="l">判定</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  alRenderImportCheck();
}
// プレビューのチェック済み行（取込予定の行）を返す
function alCheckedRows() {
  const rows = [];
  document.querySelectorAll('#al-preview .al-chk').forEach(c => {
    if (!c.checked) return;
    const i = _alParsed[+c.dataset.idx];
    if (i && i.status === 'ok') rows.push({ date: i.date, type: i.type, ticker: i.ticker, quantity: i.quantity, amountJpy: i.amountJpy, broker: i.broker, accountType: i.accountType });
  });
  return rows;
}
// 取込プレビューの株数チェック: 既存台帳＋チェック済み行 を再生した株数 vs 保有の株数（対象キーのみ）
function alImportQtyCheck() {
  const rows = alCheckedRows();
  if (!rows.length) return [];
  const merged = (store.data.acqLedger || []).concat(rows.map((r, i) => ({ ...r, id: 1e9 + i })));
  const keys = new Set(rows.map(r => `${r.ticker}|${r.broker}|${r.accountType}`));
  return acqLedgerQtyCheck(acqLedgerCompute(merged)).filter(c => keys.has(c.key));
}
function alRenderImportCheck() {
  const el = document.getElementById('al-qty-check'); if (!el) return;
  const checks = alImportQtyCheck();
  el.innerHTML = checks.length ? `<div class="grp-label" style="margin-top:8px">株数の整合性チェック（取込後の台帳 vs 現在の保有・対象キーのみ）</div>${alQtyCheckTable(checks)}` : '';
  // 不整合キーに属するプレビュー行を色付け（チェック変更のたびにクラスだけ付け外し＝チェック状態は保持）
  const badKeys = new Set(checks.filter(c => !c.ok).map(c => c.key));
  document.querySelectorAll('#al-preview tr[data-alkey]').forEach(tr => tr.classList.toggle('al-row-bad', badKeys.has(tr.dataset.alkey)));
}
function runAcqLedgerImport() {
  const rows = alCheckedRows();
  if (!rows.length) { toast('取込対象の行がありません（チェックを確認してください）'); return; }
  const bad = alImportQtyCheck().filter(c => !c.ok);
  if (bad.length && !confirm(`株数が保有と一致しないキーが ${bad.length} 件あります。\n取込データの誤り・過去分の欠落の可能性があります。それでも台帳へ取込しますか？\n（保有側の誤りなら、取込後に保有を修正してください）`)) return;
  store.addAcqLedgerRows(rows);
  toast(`台帳に ${rows.length} 件追加しました`);
  openAcqLedger();
}

// ----- 保有へ反映（差分の確認・選択上書き） -----
let _alApplyItems = [];
function openAcqLedgerApply() {
  const comp = acqLedgerCompute(store.data.acqLedger || []);
  if (!comp.size) { toast('台帳が空です。先に「報告書を取込」してください'); return; }
  const qtyChecks = new Map(acqLedgerQtyCheck(comp).map(c => [c.key, c]));
  const changed = [], same = [], noTarget = [];
  for (const [key, st] of comp) {
    const [tk, broker, account] = key.split('|');
    const sec = store.findSecurity('US', tk);
    const h = sec ? store.data.holdings.find(x => x.securityId === sec.id && x.broker === broker && x.accountType === account) : null;
    const it = { key, tk, broker, account, sec, h, newVal: st.acqJpy, lastDate: st.lastDate, qc: qtyChecks.get(key) };
    if (!sec) { it.reason = '銘柄未登録'; noTarget.push(it); }
    else if (!h) { it.reason = '保有レコードなし'; noTarget.push(it); }
    else if (h.acqJpy != null && Math.abs(h.acqJpy - st.acqJpy) < 0.5) same.push(it);
    else changed.push(it);
  }
  _alApplyItems = changed;
  const rows = changed.map((it, i) => `<tr>
    <td class="l"><input type="checkbox" class="al-ap-chk" data-i="${i}" ${it.qc && it.qc.ok ? 'checked' : ''}></td>
    <td class="l">${esc(it.sec ? calc.displayName(it.sec) : it.tk)}</td>
    <td class="l">${esc(it.broker)}/${esc(it.account)}</td>
    <td>${it.h.acqJpy != null ? '¥' + num(Math.round(it.h.acqJpy)) : '<span class="muted">未設定</span>'}</td>
    <td><strong>¥${num(Math.round(it.newVal))}</strong></td>
    <td class="l">${it.qc ? (it.qc.ok ? '<span class="pos">○</span>' : `<span class="neg">× 台帳${alFmtQty(it.qc.ledgerQty)} / 保有${alFmtQty(it.qc.holdQty)}</span>`) : '—'}</td>
    <td class="l muted" style="font-size:11px">台帳 〜${esc(it.lastDate || '—')}${it.qc && !it.qc.ok ? '・株数不一致のため既定OFF' : ''}</td>
  </tr>`).join('');
  const ntRows = noTarget.map(it => `<tr><td class="l muted">対象外</td><td class="l">${esc(it.tk)}</td><td class="l">${esc(it.broker)}/${esc(it.account)}</td><td>¥${num(Math.round(it.newVal))}</td><td class="l muted" style="font-size:11px">${esc(it.reason)}</td></tr>`).join('');
  showModal('保有へ反映（差分の確認）', `
    <p class="muted" style="margin:0 0 8px"><strong>チェックした行だけ</strong>保有の取得円を上書きします。株数が合わない行は既定でOFF。差分のある行のみ表示（変更なし ${same.length}件は非表示）。</p>
    ${changed.length ? `<div class="table-wrap" style="max-height:46vh"><table class="dense no-rowclick" style="width:100%"><thead><tr>
      <th class="l"><input type="checkbox" onchange="document.querySelectorAll('.al-ap-chk').forEach(c=>c.checked=this.checked)"></th>
      <th class="l">銘柄</th><th class="l">会社/口座</th><th>現在の取得円</th><th>反映後</th><th class="l">株数チェック</th><th class="l">備考</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">上書きが必要な差分はありません（すべて一致しています）。</p>`}
    ${ntRows ? `<div class="grp-label" style="margin-top:8px">反映できないキー（銘柄未登録・保有なし）</div><div class="table-wrap" style="max-height:16vh"><table class="dense"><tbody>${ntRows}</tbody></table></div>` : ''}
    <div class="btn-row" style="margin-top:10px">
      <span style="flex:1"></span>
      <button class="btn" onclick="openAcqLedger()">戻る</button>
      ${changed.length ? `<button class="btn btn-primary" onclick="runAcqLedgerApply()">チェックした行を上書き</button>` : ''}
    </div>`, { wide: true });
}
function runAcqLedgerApply() {
  let n = 0;
  document.querySelectorAll('.al-ap-chk').forEach(c => {
    if (!c.checked) return;
    const it = _alApplyItems[+c.dataset.i];
    if (it && it.h) { it.h.acqJpy = it.newVal; store.touch(it.h); n++; }
  });
  if (!n) { toast('チェックされた行がありません'); return; }
  store.save();
  closeModal(); render();
  toast(`取得円を ${n} 件反映しました`);
}

// Google連携（実験的・任意）。クライアントID未設定なら休眠＝現行アプリに影響しない。
function googleSyncSection() {
  const g = (store.data.settings && store.data.settings.google) || {};
  const eff = gsync.cfg();              // サーバー(CF env)由来の clientId も反映
  const configured = !!eff.clientId;
  return `<div class="section">
    <div class="section-head"><h2>Google連携（Drive自動同期）</h2>
      <span class="tag ${configured ? 'jp' : ''}">${configured ? '設定済み' : '未設定'}</span></div>
    <div class="section-body" style="padding:16px">
      <p class="muted" style="margin:0 0 10px">ブラウザ完結方式(GIS)。データは Google Drive の <code>${DSYNC_FOLDER}/${DSYNC_FILE}</code> に<strong>自動マージ同期</strong>（複数端末で両方の変更が残る）。権限は Drive（このアプリが作成したファイルのみ）で、シート権限は使いません。クライアントID未設定なら何も起きません。</p>
      <div id="gsync-status" style="margin:0 0 12px;font-size:13px;padding:8px 12px;background:var(--panel-2);border:1px solid var(--border);border-radius:8px">${gsync._token ? `<span class="pos">✓ ログイン中：${esc(gsync._email || '')}</span>` : '<span class="muted">未ログイン（「Googleでログイン」を押してください）</span>'}</div>
      <div class="form-actions" style="justify-content:flex-start;margin:0 0 8px">
        <button type="button" class="btn btn-primary" onclick="gsyncSignIn()" ${configured ? '' : 'disabled'}>Googleでログイン</button>
      </div>
      <details ${eff.clientId ? '' : 'open'}>
        <summary class="muted" style="cursor:pointer;font-size:12px">詳細設定（OAuthクライアントID・許可メール）</summary>
        <form id="gsync-form" onsubmit="return false" style="margin-top:10px">
          <div class="field"><label>OAuthクライアントID（…apps.googleusercontent.com）</label>
            <input name="gClientId" value="${esc(g.clientId || '')}" placeholder="${eff.clientId && !g.clientId ? 'サーバー設定済み（上書きする場合のみ入力）' : 'Google Cloudで作成したウェブ用クライアントID'}"></div>
          <div class="field"><label>許可メール（カンマ区切り・任意）</label>
            <input name="gAllowed" value="${esc(g.allowedEmails || '')}" placeholder="you@gmail.com"></div>
          <div class="form-actions" style="justify-content:flex-start">
            <button type="button" class="btn" onclick="gsaveSettings(this.form)">設定を保存</button>
          </div>
        </form>
      </details>

      <hr style="margin:16px 0;border:none;border-top:1px solid var(--border)">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:0 0 4px">
        <input type="checkbox" style="width:auto" ${dsync.enabled() ? 'checked' : ''} onchange="dsyncToggle(this.checked)">
        <strong>Drive自動同期</strong>
      </label>
      <p class="muted" style="margin:0 0 8px">ONにすると、ログイン中は約25秒ごと＋タブ離脱時に自動マージ同期します。トークンが切れてもセッションが有効なら<strong>自動でログインを延長</strong>（ポップアップ無し）。初回はログイン直後に同期します。手動でのバックアップは「バックアップ・出力」のJSON書出し/読込をご利用ください。</p>
      <div class="form-actions" style="justify-content:flex-start">
        <button type="button" class="btn" onclick="dsyncNow()" ${configured ? '' : 'disabled'}>今すぐDrive同期</button>
        <span id="dsync-status" class="muted" style="font-size:12px;align-self:center">${dsync.syncedAt() ? '最終同期: ' + new Date(dsync.syncedAt()).toLocaleString('ja-JP') : '未同期'}</span>
      </div>
    </div>
  </div>`;
}

// ---------- モーダル/フォーム ----------
function showModal(title, bodyHtml, opts = {}) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  const m = document.querySelector('#modal-overlay .modal');
  if (m) { m.classList.toggle('wide', !!opts.wide); m.classList.toggle('modal-fixh', !!opts.fixHeight); } // fixHeight=件数によらず高さ固定
  document.getElementById('modal-overlay').hidden = false;
}
function closeModal() { document.getElementById('modal-overlay').hidden = true; }

// 右からスライドするドロワー（銘柄詳細用）。body と foot を分けて表示。
function showDrawer(title, bodyHtml, footHtml, subHtml) {
  document.getElementById('drawer-title').textContent = title;
  const sub = document.getElementById('drawer-subtitle');
  if (sub) { sub.innerHTML = subHtml || ''; sub.style.display = subHtml ? 'flex' : 'none'; }
  document.getElementById('drawer-body').innerHTML = bodyHtml;
  const foot = document.getElementById('drawer-foot');
  foot.innerHTML = footHtml || '';
  foot.style.display = footHtml ? 'flex' : 'none';
  const ov = document.getElementById('drawer-overlay');
  const dr = document.getElementById('detail-drawer');
  ov.hidden = false;
  document.getElementById('drawer-body').scrollTop = 0;
  // setTimeout で次フレーム以降にクラス付与（バックグラウンドでも発火＝rAFより堅牢）
  setTimeout(() => { ov.classList.add('show'); dr.classList.add('show'); }, 20);
}
function closeDrawer() {
  const ov = document.getElementById('drawer-overlay'); const dr = document.getElementById('detail-drawer');
  if (!ov) return;
  ov.classList.remove('show'); if (dr) dr.classList.remove('show');
  setTimeout(() => { ov.hidden = true; }, 200);
}

// 1銘柄の各画面（詳細/取引/保有/編集）を横断するナビ。current=今いる画面を除いたボタンを並べる。
// 詳細はドロワー、他はモーダル。遷移時は対象でない器だけ閉じる（詳細へ行く時はドロワーを閉じない＝再表示の競合回避）。
function secNavBar(secId, current) {
  const btn = (key, label, onclick) => current === key ? '' :
    `<button type="button" class="btn btn-sm" onclick="${onclick}">${label}</button>`;
  const items = [
    btn('detail', '詳細', `closeModal();openSecurityDetail(${secId})`),
    btn('txn',    '取引', `closeDrawer();openTxnForm(${secId})`),
    btn('hold',   '保有', `closeDrawer();openHoldingsForm(${secId})`),
    btn('edit',   '編集', `closeDrawer();openSecurityForm(${secId})`),
  ].join('');
  return `<div class="sec-nav" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:0 0 12px">
    <span class="muted" style="font-size:11px">表示切替</span>${items}</div>`;
}

function openSecurityForm(id, presetMarket, presetTicker) {
  const sec = id ? store.data.securities.find(s => s.id === id) : null;
  const m = sec ? sec.market : (presetMarket || 'US');
  // 新規登録時の初期コード（銘柄カルテの「未登録→登録」ボタン等から。英字は大文字に補正）
  const initTicker = !sec && presetTicker ? String(presetTicker).trim().toUpperCase() : '';
  const catOpts = [...store.data.categories].sort((a, b) => a.sortOrder - b.sortOrder)
    .map(c => `<option value="${esc(c.category)}" ${sec && sec.category === c.category ? 'selected' : ''}>${esc(c.category)}</option>`).join('');
  const invCatOpts = [...store.data.investCategories].sort((a, b) => a.sortOrder - b.sortOrder)
    .map(c => `<option value="${esc(c.name)}" ${sec && sec.investCategory === c.name ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  // 銘柄ラベル（複数タグ）: マスタのチェックボックス＋新規追加テキスト
  const curLabels = secLabels(sec);
  const labelChecks = [...(store.data.labelDefs || [])].sort((a, b) => a.sortOrder - b.sortOrder)
    .map(d => `<label class="lbl-chk"><input type="checkbox" name="lbl" value="${esc(d.name)}" ${curLabels.includes(d.name) ? 'checked' : ''}> ${labelsTagOne(d.name)}</label>`).join('');
  const curRuleId = sec ? (sec.ruleId || store.defaultRule().id) : store.defaultRule().id;
  const ruleOpts = store.data.rules
    .map(r => `<option value="${r.id}" ${r.id === curRuleId ? 'selected' : ''}>${esc(r.name)}${r.isDefault ? '（既定）' : ''}</option>`).join('');
  const grade = (v, sel) => `<option value="" ${!sel ? 'selected' : ''}>—</option>` + ['S', 'A', 'B', 'C', 'D'].map(g => `<option ${sel === g ? 'selected' : ''}>${g}</option>`).join('');
  const starInput = (name, val) => `<input name="${name}" type="number" min="0" max="5" step="1" value="${val ?? ''}" placeholder="0〜5">`;
  const ccy = MARKET_CCY[m];
  const buyAmtVal = sec && sec.buyAmount != null ? sec.buyAmount : '';
  const buyCntVal = sec && sec.buyCount != null ? sec.buyCount : '';

  showModal(id ? '銘柄を編集' : '銘柄を追加', `
    <form id="sec-form">
      <input type="hidden" name="editId" value="${id || ''}">
      ${id ? secNavBar(id, 'edit') : ''}
      <div class="row">
        <div class="field"><label>市場</label>
          <select name="market" ${m === 'FUND' ? 'disabled' : ''}>${(m === 'FUND' ? ['FUND'] : ['US', 'JP']).map(x => `<option value="${x}" ${x === m ? 'selected' : ''}>${MARKET_LABEL[x]}</option>`).join('')}</select></div>
        <div class="field"><label>ティッカー / コード</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input name="ticker" value="${sec ? esc(sec.ticker) : esc(initTicker)}" placeholder="例: AAPL / 7203" required style="flex:1;text-transform:uppercase" oninput="this.value=this.value.toUpperCase()" onblur="autoFetchInfo(this)">
            <span id="info-status" class="muted" style="font-size:11px;white-space:nowrap"></span>
          </div></div>
      </div>
      <div class="row">
        <div class="field"><label>適用ルール</label><select name="ruleId">${ruleOpts}</select></div>
        <div class="field"><label>判定対象</label>
          <select name="enabled"><option value="1" ${!sec || sec.enabled !== false ? 'selected' : ''}>有効</option><option value="0" ${sec && sec.enabled === false ? 'selected' : ''}>無効</option></select></div>
      </div>
      <div class="row">
        <div class="field"><label>注意銘柄(ウォッチ)</label>
          <select name="watch"><option value="0" ${!sec || !sec.watch ? 'selected' : ''}>通常</option><option value="1" ${sec && sec.watch ? 'selected' : ''}>注意</option></select></div>
        <div class="field"><label title="買い取引が無い場合の基準（任意）。取引履歴があればそちらを優先">前回購入価格 / 前回購入日</label>
          <div style="display:flex;gap:6px">
            <input name="prevBuyPrice" type="number" step="any" value="${sec && sec.prevBuyPrice != null ? sec.prevBuyPrice : ''}" placeholder="価格(原通貨)" style="flex:1">
            <input name="prevBuyDate" type="date" value="${sec && sec.prevBuyDate ? esc(sec.prevBuyDate) : ''}" title="前回購入日。高値更新判定（最高値が購入後か）の比較に使用。取引履歴があればそちらを優先" style="flex:1">
          </div></div>
      </div>
      <div class="row">
        <div class="field"><label title="この銘柄だけルールの基準高値を上書きする（任意）">基準高値</label>
          <select name="baseHighMode" onchange="toggleBaseHighManual(this)">
            <option value="" ${!sec || !sec.baseHighMode ? 'selected' : ''}>ルールに従う（${BASE_HIGH_LABEL[store.rule(sec ? sec.ruleId : null).baseHighMode] || '5年高値'}）</option>
            ${Object.entries(BASE_HIGH_LABEL).map(([v, lbl]) => `<option value="${v}" ${sec && sec.baseHighMode === v ? 'selected' : ''}>${lbl}</option>`).join('')}
          </select></div>
        <div class="field"><label title="基準高値＝手動指定の時のみ有効">手動の基準高値</label>
          <input name="baseHighManual" type="number" step="any" value="${sec && sec.baseHighManual != null ? sec.baseHighManual : ''}" placeholder="原通貨" ${sec && sec.baseHighMode === 'manual' ? '' : 'disabled'}></div>
      </div>
      <div class="row">
        <div class="field"><label title="次回購入をこの価格に固定（任意）。入力するとルール計算より優先">買増固定値</label>
          <input name="fixedBuyPrice" type="number" step="any" value="${sec && sec.fixedBuyPrice != null ? sec.fixedBuyPrice : ''}" placeholder="原通貨"></div>
        <div class="field"><label title="貼付出力用">詳細種別</label>
          <select name="detailType">
            <option value="" ${!sec || !sec.detailType ? 'selected' : ''}>自動判定（${sec ? esc(autoDetailType(sec)) : '個別株'}）</option>
            ${['個別株', 'ETF'].map(t => `<option ${sec && sec.detailType === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select></div>
      </div>
      <div class="field"><label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" name="addonFromHigh" ${sec && sec.addonFromHigh ? 'checked' : ''} style="width:auto">
          買い増しも初回基準で判定</label></div>

      <div class="row">
        <div class="field"><label title="EPS × 目標PER で株価を逆算。参考表示のみで買い増し判定には使いません">目標PER</label>
          <input name="targetPer" type="number" step="any" min="0" value="${sec && sec.targetPer != null ? sec.targetPer : ''}"></div>
        <div class="field"><label title="現在値 ÷ 現在PBR × 目標PBR で株価を逆算。参考表示のみ">目標PBR</label>
          <input name="targetPbr" type="number" step="any" min="0" value="${sec && sec.targetPbr != null ? sec.targetPbr : ''}"></div>
        <div class="field"><label title="1株配当 ÷ 目標利回り で株価を逆算。参考表示のみ。日本株は1株配当が未取得のため配当利回りからの推定値になります">目標配当利回り (%)</label>
          <input name="targetYield" type="number" step="any" min="0" value="${sec && sec.targetYield != null ? sec.targetYield : ''}"></div>
      </div>

      <div class="row">
        <div class="field"><label title="情報管理のみ。判定には影響しない">元本売却済み</label>
          <select name="principalSold"><option value="0" ${!sec || !sec.principalSold ? 'selected' : ''}>いいえ</option><option value="1" ${sec && sec.principalSold ? 'selected' : ''}>売却済み</option></select></div>
        <div class="field"><label>売却済みの元本額 (${ccy})</label>
          <input name="principalSoldAmount" type="number" step="any" value="${sec && sec.principalSoldAmount != null ? sec.principalSoldAmount : ''}" placeholder="任意・原通貨"></div>
      </div>

      <div class="field"><label>メモ</label>
        <textarea name="memo" rows="2">${sec ? esc(sec.memo || '') : ''}</textarea></div>

      <div class="field"><label title="投資テーマ/分類。マスタ・設定の「銘柄ラベル」で色・並び順を編集">銘柄ラベル</label>
        <div class="label-picker" style="display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center">${labelChecks || '<span class="muted">ラベル未登録（下に入力するか、マスタで追加）</span>'}</div>
        <input name="labelsNew" placeholder="新規追加（; か , 区切り）" style="margin-top:6px" autocomplete="off"></div>

      <fieldset class="form-group"><legend title="自動取得では上書きされません。空欄にすると自動取得値に戻ります">表示の手動上書き</legend>
        <div class="field"><label>銘柄名</label>
          <input name="nameOverride" value="${sec && sec.nameOverride ? esc(sec.nameOverride) : ''}" placeholder="${sec ? esc((store.data.meta[priceKey(sec)] || {}).name || sec.ticker) : '空欄で自動取得名を使用'}"></div>
        <div class="row">
          <div class="field"><label>セクター</label>
            <input name="sectorOverride" value="${sec && sec.sectorOverride ? esc(sec.sectorOverride) : ''}" placeholder="${sec ? esc(jpInd((store.data.meta[priceKey(sec)] || {}).sector) || '空欄で自動取得') : '空欄で自動取得'}"></div>
          <div class="field"><label>業種</label>
            <input name="industryOverride" value="${sec && sec.industryOverride ? esc(sec.industryOverride) : ''}" placeholder="${sec ? esc(jpInd((store.data.meta[priceKey(sec)] || {}).industry) || '空欄で自動取得') : '空欄で自動取得'}"></div>
        </div>
      </fieldset>

      <fieldset class="form-group"><legend>銘柄情報（自動取得）</legend>
        <div id="auto-info" class="auto-info">${autoInfoPanelHtml(m, sec ? sec.ticker : '')}</div>
        <button type="button" class="btn btn-sm" style="margin-top:8px" onclick="refetchInfo()">今すぐ取得</button>
      </fieldset>
      ${sec && sec.splitHistory && sec.splitHistory.length ? `
      <fieldset class="form-group"><legend>株式分割・併合の履歴</legend>
        <div class="auto-info">${[...sec.splitHistory].sort((a,b)=>(a.date<b.date?1:-1)).map(h => `<div class="ai-row"><span>${esc(h.date)}　${esc(h.label || ('×' + h.ratio))}</span><span class="muted">${h.status === 'applied' ? '調整済' : h.status === 'recorded' ? '記録のみ' : h.status === 'skipped' ? 'スキップ' : '承認待ち'}</span></div>`).join('')}</div>
      </fieldset>` : ''}

      <details class="form-group">
        <summary>銘柄分析メタ（カテゴリ・購入額・評価・備考）</summary>
        <div class="row">
          <div class="field"><label>カテゴリ</label>
            <select name="category" onchange="fillBuyAmount(this)"><option value="">未設定</option>${catOpts}</select></div>
          <div class="field"><label title="カテゴリを選ぶと自動転記（${m === 'US' ? '米株は÷100ドル' : '円'}）。手入力で上書き可">1回の購入額 (${ccy})</label>
            <input name="buyAmount" type="number" step="any" value="${buyAmtVal}"></div>
          <div class="field"><label>購入回数</label>
            <input name="buyCount" type="number" step="1" min="0" value="${buyCntVal}"></div>
        </div>
        <div class="row">
          <div class="field"><label title="分析枠のラベル（高配当/テーマ株 等）">投資カテゴリ</label>
            <select name="investCategory"><option value="">未設定</option>${invCatOpts}</select></div>
        </div>
        <div class="row">
          <div class="field"><label>総合評価</label><select name="overallGrade">${grade('overallGrade', sec && sec.overallGrade)}</select></div>
          <div class="field"><label>銘柄格付</label><select name="rating">${grade('rating', sec && sec.rating)}</select></div>
          <div class="field"><label>買い時評価</label><select name="buyGrade">${grade('buyGrade', sec && sec.buyGrade)}</select></div>
        </div>
        <div class="row">
          <div class="field"><label>★バリュエーション</label>${starInput('starValuation', sec && sec.starValuation)}</div>
          <div class="field"><label>★独自の強み</label>${starInput('starStrength', sec && sec.starStrength)}</div>
          <div class="field"><label>★リスク</label>${starInput('starRisk', sec && sec.starRisk)}</div>
        </div>
        <div class="row">
          <div class="field"><label>購入優先順位</label><input name="priority" type="number" step="1" value="${sec && sec.priority != null ? sec.priority : ''}"></div>
          <div class="field"><label>評価日</label>
            <input name="analysisDate" inputmode="numeric" maxlength="10" placeholder="YYYY-MM-DD" oninput="maskDate(this)" value="${sec && sec.analysisDate ? esc(sec.analysisDate) : ''}"></div>
        </div>
        <div class="field"><label>備考 / 分析メモ</label><textarea name="analysisNote" rows="2">${sec ? esc(sec.analysisNote || '') : ''}</textarea></div>
      </details>

      <details class="form-group">
        <summary>株価シナリオ（短期・中期の予想レンジ）</summary>
        <div class="row">
          <div class="field"><label title="株価シナリオ分析を行った日。履歴のキーになる（同じ日=上書き / 別の日=新エントリ）">シナリオ分析日</label>
            <input name="scenarioDate" inputmode="numeric" maxlength="10" placeholder="YYYY-MM-DD" oninput="maskDate(this)" value="${sec && sec.scenarioDate ? esc(sec.scenarioDate) : ''}"></div>
          <div class="field"><label>分析時株価 (${ccy})</label>
            <input name="scenarioPrice" type="number" step="any" value="${sec && sec.scenarioPrice != null ? sec.scenarioPrice : ''}"></div>
        </div>
        <div class="row">
          <div class="field"><label>短期・弱気</label><input name="stBear" placeholder="例: 1000～1500" value="${sec && sec.stBear != null ? esc(String(sec.stBear)) : ''}"></div>
          <div class="field"><label>短期・ベース</label><input name="stBase" placeholder="例: 1000～1500" value="${sec && sec.stBase != null ? esc(String(sec.stBase)) : ''}"></div>
          <div class="field"><label>短期・強気</label><input name="stBull" placeholder="例: 1000～1500" value="${sec && sec.stBull != null ? esc(String(sec.stBull)) : ''}"></div>
        </div>
        <div class="row">
          <div class="field"><label>中期・弱気</label><input name="mtBear" placeholder="例: 1000～1500" value="${sec && sec.mtBear != null ? esc(String(sec.mtBear)) : ''}"></div>
          <div class="field"><label>中期・ベース</label><input name="mtBase" placeholder="例: 1000～1500" value="${sec && sec.mtBase != null ? esc(String(sec.mtBase)) : ''}"></div>
          <div class="field"><label>中期・強気</label><input name="mtBull" placeholder="例: 1000～1500" value="${sec && sec.mtBull != null ? esc(String(sec.mtBull)) : ''}"></div>
        </div>
      </details>

      ${id ? '' : `
      <fieldset class="form-group"><legend title="任意。後から「保有」で編集できます">初期保有</legend>
        <div class="row">
          <div class="field"><label>証券会社</label><select name="broker">${BROKERS.map(b => `<option>${b}</option>`).join('')}</select></div>
          <div class="field"><label>口座種別</label><select name="accountType">${ACCOUNTS.map(a => `<option>${a}</option>`).join('')}</select></div>
        </div>
        <div class="row">
          <div class="field"><label>数量（端株可）</label><input name="initQty" type="number" step="any" placeholder="0"></div>
          <div class="field"><label>平均取得単価 (${ccy})</label><input name="initCost" type="number" step="any" placeholder="0"></div>
        </div>
      </fieldset>`}

      <div class="form-actions">
        ${id ? `<button type="button" class="btn btn-danger" onclick="deleteSecurity(${id})">削除</button>
        <button type="button" class="btn" onclick="openAmountHistory(${id})">適用金額</button>
        <button type="button" class="btn" onclick="openAnalysisHistory(${id})">分析</button>` : ''}
        <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>`);
  // コードが初期セットされた時（カルテの未登録→登録ボタン等）は、blurを待たず銘柄情報を自動取得する
  if (initTicker) { const t = document.getElementById('sec-form').elements.ticker; if (t) autoFetchInfo(t); }
  document.getElementById('sec-form').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const market = f.market.value;
    const numOrNull = (v) => v === '' || v == null ? null : parseFloat(v);
    const intOrNull = (v) => v === '' || v == null ? null : parseInt(v, 10);
    // 銘柄名・セクター・業種・時価総額・PER・EPS・配当はマスタ（meta）で自動管理。レコードには持たせない
    const patch = {
      market, ticker: f.ticker.value.trim().toUpperCase(), // コードは常に大文字で保存（表記ゆれ・重複判定ミス防止）
      category: f.category.value || null, ruleId: parseInt(f.ruleId.value, 10),
      investCategory: (f.investCategory && f.investCategory.value) || null,
      enabled: f.enabled.value === '1', watch: f.watch.value === '1',
      currency: market === 'US' ? 'USD' : 'JPY',
      assetClass: market === 'FUND' ? 'fund' : 'stock',
      prevBuyPrice: numOrNull(f.prevBuyPrice.value),
      prevBuyDate: (f.prevBuyDate && f.prevBuyDate.value) || null, // 前回購入日（手動・高値更新判定の比較用。取引履歴があればそちら優先）
      fixedBuyPrice: numOrNull(f.fixedBuyPrice.value),
      addonFromHigh: !!(f.addonFromHigh && f.addonFromHigh.checked), // 買い増しも初回基準（基準高値×初回下落率）でトリガー固定
      baseHighMode: f.baseHighMode.value || null,
      baseHighManual: f.baseHighMode.value === 'manual' ? numOrNull(f.baseHighManual.value) : null,
      detailType: (f.detailType && f.detailType.value) || null, // 詳細種別マスタ（空=自動判定）
      // 目標指標（参考株価の逆算用。判定には使わない）。分割で不変なので applySplit の対象外
      targetPer: numOrNull(f.targetPer && f.targetPer.value),
      targetPbr: numOrNull(f.targetPbr && f.targetPbr.value),
      targetYield: numOrNull(f.targetYield && f.targetYield.value),
      principalSold: f.principalSold && f.principalSold.value === '1', // 元本売却済みフラグ（情報管理のみ）
      principalSoldAmount: numOrNull(f.principalSoldAmount && f.principalSoldAmount.value), // 売却済み元本額（原通貨・情報管理のみ）
      memo: (f.memo && f.memo.value.trim()) || null, // 銘柄メモ（自由記述・判定には影響しない）
      labels: (() => { // 銘柄ラベル（複数タグ）: チェック済み＋新規入力をまとめる。新規はマスタへ追加
        const chosen = [...f.querySelectorAll('input[name="lbl"]:checked')].map(x => x.value);
        const added = parseLabels(f.labelsNew ? f.labelsNew.value : '');
        ensureLabelDefs(added);
        return [...new Set([...chosen, ...added])];
      })(),

      buyAmount: numOrNull(f.buyAmount.value), buyCount: intOrNull(f.buyCount.value),
      overallGrade: f.overallGrade.value || null, rating: f.rating.value || null, buyGrade: f.buyGrade.value || null,
      starValuation: intOrNull(f.starValuation.value), starStrength: intOrNull(f.starStrength.value), starRisk: intOrNull(f.starRisk.value),
      priority: intOrNull(f.priority.value), analysisDate: f.analysisDate.value || null,
      analysisNote: f.analysisNote.value.trim() || null,
      // 株価シナリオ（レンジは「1000~1500」に正規化して保存。数値化できない入力はそのまま保持）
      scenarioDate: f.scenarioDate.value || null, scenarioPrice: numOrNull(f.scenarioPrice.value),
      stBear: scNormRange(f.stBear.value), stBase: scNormRange(f.stBase.value), stBull: scNormRange(f.stBull.value),
      mtBear: scNormRange(f.mtBear.value), mtBase: scNormRange(f.mtBase.value), mtBull: scNormRange(f.mtBull.value),
      // 名前・セクター・業種の手動上書き（空＝自動取得を使用。自動取得では潰れない）
      nameOverride: f.nameOverride && f.nameOverride.value.trim() || null,
      sectorOverride: f.sectorOverride && f.sectorOverride.value.trim() || null,
      industryOverride: f.industryOverride && f.industryOverride.value.trim() || null,
    };
    // 手入力更新日(manualUpdatedAt)は分割調整の判断材料。分割で調整が要る手入力項目
    // （前回購入単価・手動基準高値）が実際に変わった時だけ更新する。
    // 格付け・カテゴリ・メモ等の分割に無関係な編集では更新しない（SEC-34）。
    const splitRelevantChanged = (old) =>
      ((old?.prevBuyPrice ?? null) !== (patch.prevBuyPrice ?? null)) ||
      ((old?.baseHighManual ?? null) !== (patch.baseHighManual ?? null)) ||
      ((old?.fixedBuyPrice ?? null) !== (patch.fixedBuyPrice ?? null));
    let target;
    if (id) {
      const before = store.data.securities.find(s => s.id === id);
      if (splitRelevantChanged(before)) patch.manualUpdatedAt = store._now();
      target = store.updateSecurity(id, patch);
    } else {
      // 追加時の重複ガード（ティッカーをキーに未blur/Enter送信でもここで検知）。登録済みなら追加せず既存を呼び出す。
      const dup = store.findSecurity(market, patch.ticker);
      if (dup) { toast(`「${calc.displayName(dup)}」は登録済みです。編集画面を開きました。`); closeModal(); openSecurityForm(dup.id); return; }
      if (patch.prevBuyPrice != null || patch.baseHighManual != null) patch.manualUpdatedAt = store._now();
      target = store.addSecurity({ ...patch });
      const qty = parseFloat(f.initQty.value), cost = parseFloat(f.initCost.value);
      if (!isNaN(qty) && qty !== 0) store.setHolding(target.id, f.broker.value, f.accountType.value, qty, isNaN(cost) ? 0 : cost);
    }
    // 分析メタを履歴(analyses)へ記録（評価日がある時のみ）。同じ評価日＝その日の更新／別の評価日＝新エントリ。
    // updateSecurity でいったん平置きに書いた後、syncLatestAnalysis で「真の最新評価日」を平置きへミラーし直す
    // （古い評価日を後から入れても表示は最新のまま保つ）。フォーム値は空＝null をそのまま渡し、クリアも反映する。
    if (target && patch.analysisDate) {
      store.upsertAnalysis(target.id, patch.analysisDate, {
        overallGrade: patch.overallGrade ?? null, rating: patch.rating ?? null, buyGrade: patch.buyGrade ?? null,
        starValuation: patch.starValuation ?? null, starStrength: patch.starStrength ?? null, starRisk: patch.starRisk ?? null,
        priority: patch.priority ?? null, analysisNote: patch.analysisNote ?? null,
        category: target.category ?? null, // 推奨額(recoAmount)はフォーム入力欄が無いため触らない（取込値を消さない）
      });
      store.syncLatestAnalysis(target.id);
    }
    // 株価シナリオも履歴(priceScenarios)へ記録（分析日がある時のみ）。分析メタと同じ「upsert→最新をミラー」方式。
    // フォーム値は空＝null をそのまま渡し、クリアも反映する
    if (target && patch.scenarioDate) {
      store.upsertScenario(target.id, patch.scenarioDate, {
        scenarioPrice: patch.scenarioPrice ?? null,
        stBear: patch.stBear ?? null, stBase: patch.stBase ?? null, stBull: patch.stBull ?? null,
        mtBear: patch.mtBear ?? null, mtBase: patch.mtBase ?? null, mtBull: patch.mtBull ?? null,
      });
      store.syncLatestScenario(target.id);
    }
    // 編集時は一覧のスクロール位置を維持（保存後に先頭へ戻らないように）。新規追加は先頭から見せる
    closeModal(); if (id) preserveTableScroll(render); else render();
    // 新規追加かつティッカーありなら、価格＋マスタ情報を裏で取得して再描画
    // （保有・ウォッチ問わず、日次更新済みでも即座に価格が出るように。task B）
    if (target && target.ticker) {
      const tasks = [];
      if (!id && store.data.prices[priceKey(target)]?.price == null) tasks.push(api.refreshPrice([target]));
      if (!store.data.meta[priceKey(target)]?.name) tasks.push(api.refreshMeta([target]));
      if (tasks.length) Promise.all(tasks).then(render);
    }
  };
}

// フォーム内「銘柄情報（自動取得）」パネルのHTML（マスタ=meta から読み取り専用表示）
function autoInfoPanelHtml(market, ticker) {
  const key = `${market}:${(ticker || '').trim()}`;
  const meta = store.data.meta[key] || {};
  const ccy = MARKET_CCY[market];
  const r = (label, val) => `<div class="ai-row"><span class="muted">${label}</span><span>${val}</span></div>`;
  const sectorInd = [meta.sector, meta.industry].filter(Boolean).map(jpInd).join(' / ');
  const marginTxt = meta.marginRatio != null
    ? `${num(meta.marginRatio)}${meta.marginRatioPrev != null ? `（前週 ${num(meta.marginRatioPrev)}）` : ''}`
    : '—';
  return r('銘柄名', esc(meta.name || '—'))
    + r('セクター / 業種', sectorInd ? esc(sectorInd) : '—')
    + r('時価総額', meta.marketCap != null ? Number(meta.marketCap).toLocaleString('ja-JP') + ' 百万' : '—')
    + r('PER', meta.per != null ? num(meta.per) : '—')
    + r('PBR', meta.pbr != null ? num(meta.pbr) : '—')
    + (market === 'US' ? r('PSR', meta.psr != null ? num(meta.psr) : '—') : '')
    + r('配当/株', meta.dividend != null ? money(meta.dividend, ccy) : '—')
    + (market === 'JP' ? r('信用倍率', marginTxt) : '');
}

// ティッカーをキーに /api/info から銘柄情報を取得し、マスタ(meta)に保存。パネルを更新（フォームには手入力させない）
async function autoFetchInfo(tickerEl) {
  const f = tickerEl.form;
  if (!f) return;
  const ticker = tickerEl.value.trim();
  if (!ticker) return;
  // モーダルが閉じている状態での遅延blur（保存/キャンセル後にフォーカスが外れて発火）では何もしない。
  // これを怠ると、新規追加の保存直後に「今登録したコード」を登録済みと誤検知して編集画面を開いてしまう。
  const overlay = document.getElementById('modal-overlay');
  if (overlay && overlay.hidden) return;
  const status = document.getElementById('info-status');
  const panel = document.getElementById('auto-info');
  const market = f.market.value;
  // 追加モードで入力したコードが登録済みなら『追加』せず既存データを呼び出す（編集画面へ切替）。
  // 編集モード（editId あり）では切り替えない。
  const editId = f.editId ? f.editId.value : '';
  if (!editId) {
    const existing = store.findSecurity(market, ticker);
    if (existing) { toast(`「${calc.displayName(existing)}」は登録済みです。編集画面を開きました。`); openSecurityForm(existing.id); return; }
  }
  const symbol = (market === 'JP' || market === 'FUND') ? `${ticker}.T` : ticker;
  const key = `${market}:${ticker}`;
  if (status) { status.textContent = '取得中…'; status.style.color = 'var(--muted)'; status.title = ''; }
  const fail = (label, e) => {
    console.warn('[autoFetchInfo]', symbol, label, e);
    if (status) { status.textContent = label; status.style.color = 'var(--muted)'; status.title = String(e?.message || e || ''); }
  };
  // ★取得(通信)と保存(localStorage)を分けて扱う。以前は両方まとめて「取得失敗」と出していたため、
  //   実際は取得できていて localStorage 容量オーバーで保存に失敗しただけのケースまで「取得失敗」に見えていた。
  let d = null;
  for (let attempt = 0; attempt < 2; attempt++) { // 一時的な通信エラー/エッジのゆらぎ向けに1回だけ再試行
    try {
      const res = await fetch(`/api/info?symbol=${encodeURIComponent(symbol)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      d = j; break;
    } catch (e) {
      if (attempt === 0) { await new Promise(r => setTimeout(r, 600)); continue; }
      fail('取得失敗（通信・再試行可）', e);
      return;
    }
  }
  try {
    store.setMeta(key, clean(d)); // マスタへ保存（null/空は上書きしない）
  } catch (e) {
    // 保存だけ失敗（localStorage 容量オーバー等）。取得値は画面に出す（保存されていない旨だけ明示）。
    if (panel) panel.innerHTML = autoInfoPanelHtml(market, ticker);
    fail('取得OK・保存失敗（容量不足の可能性）', e);
    return;
  }
  if (panel) panel.innerHTML = autoInfoPanelHtml(market, ticker);
  if (status) { status.textContent = d.name ? '✓ 取得済み' : '✓ 取得（一部のみ）'; status.style.color = 'var(--green)'; }
}

// 「今すぐ取得」ボタン: フォームのティッカーで autoFetchInfo を実行
function refetchInfo() {
  const f = document.getElementById('sec-form');
  if (f && f.ticker) autoFetchInfo(f.ticker);
}

// 基準高値モード=手動指定 のときだけ手動値入力を有効化
function toggleBaseHighManual(sel) {
  const el = sel.form.baseHighManual;
  if (el) { el.disabled = sel.value !== 'manual'; if (el.disabled) el.value = ''; }
}

// カテゴリ選択時に購入額を転記（市場別の登録金額）。手入力で上書き可
function fillBuyAmount(sel) {
  const f = sel.form;
  const amt = store.categoryAmountFor(sel.value, f.market.value);
  f.buyAmount.value = amt || '';
}

// 評価日の入力マスク（数字を YYYY-MM-DD へ自動整形＝年4桁で自動的に月へ）
function maskDate(el) {
  const v = el.value.replace(/[^\d]/g, '').slice(0, 8);
  let out = v.slice(0, 4);
  if (v.length > 4) out += '-' + v.slice(4, 6);
  if (v.length > 6) out += '-' + v.slice(6, 8);
  el.value = out;
}

function deleteSecurity(id) {
  if (confirm('この銘柄と関連する保有・取引を削除します。よろしいですか？')) {
    store.removeSecurity(id); closeModal(); render();
  }
}

// 保有を直接編集（取引を介さず数量・平均取得単価を上書き）＋全売却
function openHoldingsForm(secId) {
  const sec = store.data.securities.find(s => s.id === secId);
  const ccy = MARKET_CCY[sec.market];
  const hs = store.data.holdings.filter(h => h.securityId === secId);
  const us = sec.market === 'US';
  const isFund = sec.market === 'FUND';
  // 投信は価格を自動取得しないため評価額は保有（証券会社×口座）ごとに手入力（h.evalJpy）。
  // 既に h.evalJpy が無い（取込済み）保有は、共有単価×口数の概算を初期表示する。
  const fundUnitPrice = (store.data.prices['FUND:' + sec.ticker] || {}).price;
  const fundEvalOf = (h) => h.evalJpy != null ? h.evalJpy : (fundUnitPrice != null ? Math.round(fundUnitPrice * (h.quantity || 0)) : '');
  const rowsHtml = hs.map(h => `
    <tr data-hid="${h.id}">
      <td class="l">${esc(h.broker)}</td><td class="l">${esc(h.accountType)}</td>
      <td><input type="number" step="any" class="h-qty" style="width:100%" value="${h.quantity}"></td>
      <td><input type="number" step="any" class="h-cost" style="width:100%" value="${h.avgCost}"></td>
      ${us ? `<td><input type="number" step="any" class="h-acq" style="width:100%" value="${h.acqJpy ?? ''}" placeholder="取得円"></td>` : ''}
      ${isFund ? `<td><input type="number" step="any" class="h-eval" style="width:100%" value="${fundEvalOf(h)}" placeholder="評価額(円)"></td>` : ''}
      <td><input type="number" step="any" class="h-orig" style="width:100%" value="${h.origBuyAmount ?? ''}" placeholder="任意"></td>
      <td class="l" style="white-space:nowrap">${h.quantity > 1e-9 ? `<button type="button" class="btn btn-sm btn-danger" title="この証券会社・口座だけを全売却" onclick="sellAll(${secId},[${h.id}])">全売却</button> ` : ''}<button type="button" class="btn btn-sm btn-danger" onclick="removeHolding(${h.id},${secId})">削除</button></td>
    </tr>`).join('');

  showModal(`保有を直接編集 — ${esc(sec.name || sec.ticker)}`, `
    <form id="holdings-form">
      ${secNavBar(secId, 'hold')}
      <p class="muted">取引履歴を介さず数量・平均取得単価を直接修正します（単価 ${ccy}）。<br>「売却前購入額」＝損出しで売って買い直した時の<strong>最初の購入額</strong>。空欄なら 単価×数量 を使い、「購入額（本来）」列に出ます。</p>

      <fieldset class="form-group"><legend>元本売却（銘柄単位・情報管理のみ）</legend>
        <div class="row">
          <div class="field"><label>元本売却済み</label>
            <select name="principalSold"><option value="0" ${!sec.principalSold ? 'selected' : ''}>いいえ</option><option value="1" ${sec.principalSold ? 'selected' : ''}>売却済み</option></select></div>
          <div class="field"><label>売却済みの元本額 (${ccy})</label>
            <input name="principalSoldAmount" type="number" step="any" value="${sec.principalSoldAmount != null ? sec.principalSoldAmount : ''}" placeholder="任意・原通貨"></div>
        </div>
      </fieldset>
      <div class="table-wrap"><table>
        <thead><tr><th class="l">証券会社</th><th class="l">口座</th><th>数量</th><th>平均取得単価(${ccy})</th>${us ? '<th>取得円(円)</th>' : ''}${isFund ? '<th>評価額(円)</th>' : ''}<th title="一旦売却→他社で買い直し（損出し）等で、最初の購入額を残したい時に入力。空欄なら取得価額(単価×数量)を使用">売却前購入額(${ccy})</th><th></th></tr></thead>
        <tbody id="holdings-rows">${rowsHtml || ''}</tbody>
      </table></div>
      ${hs.length === 0 ? '<div class="empty">保有がありません。下のフォームから追加してください。</div>' : ''}
      ${isFund ? '<p class="muted" style="margin:6px 0 0">投信は評価額を自動取得しないため、<strong>証券会社×口座ごとに評価額(円)を手入力</strong>します（マネフォ等の値）。一覧・転記（マネフォ用）の評価額に反映。空欄は据え置き。</p>' : ''}

      <fieldset class="form-group"><legend>保有を追加</legend>
        <div class="row">
          <div class="field"><label>証券会社</label><select name="broker">${BROKERS.map(b => `<option>${b}</option>`).join('')}</select></div>
          <div class="field"><label>口座種別</label><select name="accountType">${ACCOUNTS.map(a => `<option>${a}</option>`).join('')}</select></div>
        </div>
        <div class="row">
          <div class="field"><label>数量</label><input name="newQty" type="number" step="any" placeholder="0"></div>
          <div class="field"><label>平均取得単価(${ccy})</label><input name="newCost" type="number" step="any" placeholder="0"></div>
        </div>
        ${us ? `<div class="row"><div class="field"><label>取得円(円)（任意・取得円用）</label><input name="newAcq" type="number" step="any" placeholder="空欄可"></div></div>` : ''}
        ${isFund ? `<div class="row"><div class="field"><label>評価額(円)（任意・投信の現在評価額）</label><input name="newEval" type="number" step="any" placeholder="空欄可"></div></div>` : ''}
        <div class="row"><div class="field"><label>売却前購入額(${ccy})（任意・損出し時の最初の購入額）</label><input name="newOrig" type="number" step="any" placeholder="空欄可"></div></div>
      </fieldset>

      <div class="form-actions">
        ${hs.some(h => h.quantity > 0) ? `<button type="button" class="btn btn-danger" onclick="sellAll(${secId})">全売却（口座を選択）</button>` : ''}
        <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>`, { wide: true });
  document.getElementById('holdings-form').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    // 既存行を更新
    document.querySelectorAll('#holdings-rows tr').forEach(tr => {
      const hid = parseInt(tr.dataset.hid, 10);
      const h = store.data.holdings.find(x => x.id === hid);
      if (h) {
        const newQty = parseFloat(tr.querySelector('.h-qty').value) || 0;
        const newCost = parseFloat(tr.querySelector('.h-cost').value) || 0;
        let changed = false;
        // 数量・単価を実際に変更した時だけ「手入力」として記録（未変更の再保存では更新しない）
        if (newQty !== h.quantity || newCost !== h.avgCost) {
          h.quantity = newQty; h.avgCost = newCost; h.source = 'manual'; changed = true;
        }
        // 取得円(円)の直接編集（米国株）。空欄なら未設定に戻す
        const acqEl = tr.querySelector('.h-acq');
        if (acqEl) { const v = acqEl.value.trim(); const nv = v === '' ? undefined : (parseFloat(v) || 0); if (nv !== h.acqJpy) { h.acqJpy = nv; changed = true; } }
        // 評価額(円)の直接編集（投信・保有＝証券会社×口座ごと）。空欄なら未設定に戻す
        const evalEl = tr.querySelector('.h-eval');
        if (evalEl) { const v = evalEl.value.trim(); const nv = v === '' ? undefined : (parseFloat(v) || 0); if (nv !== h.evalJpy) { h.evalJpy = nv; changed = true; } }
        // 売却前購入額（損出し用・原通貨）。空欄なら未設定（取得価額を採用）に戻す
        const origEl = tr.querySelector('.h-orig');
        if (origEl) { const v = origEl.value.trim(); const nv = v === '' ? undefined : (parseFloat(v) || 0); if (nv !== h.origBuyAmount) { h.origBuyAmount = nv; changed = true; } }
        // 取得円/評価額/売却前購入額だけ編集した時も updatedAt を打つ（同期漏れ防止）
        if (changed) store.touch(h);
      }
    });
    // 新規追加
    if (f.newQty.value || f.newCost.value) {
      store.setHolding(secId, f.broker.value, f.accountType.value,
        parseFloat(f.newQty.value) || 0, parseFloat(f.newCost.value) || 0);
      const nh = store.data.holdings.find(x => x.securityId === secId && x.broker === f.broker.value && x.accountType === f.accountType.value);
      if (nh && f.newAcq && f.newAcq.value.trim() !== '') nh.acqJpy = parseFloat(f.newAcq.value) || 0;
      if (nh && f.newEval && f.newEval.value.trim() !== '') nh.evalJpy = parseFloat(f.newEval.value) || 0;
      if (nh && f.newOrig && f.newOrig.value.trim() !== '') nh.origBuyAmount = parseFloat(f.newOrig.value) || 0;
    }
    // 銘柄単位の元本売却情報（情報管理のみ）
    store.updateSecurity(secId, {
      principalSold: f.principalSold && f.principalSold.value === '1',
      principalSoldAmount: (f.principalSoldAmount && f.principalSoldAmount.value !== '') ? (parseFloat(f.principalSoldAmount.value) || 0) : null,
    });
    store.save(); closeModal(); render();
  };
}
function removeHolding(hid, secId) {
  store.removeHolding(hid); openHoldingsForm(secId);
}
// 全売却を取引履歴に残す: 保有ロットごとに現在値（無ければ平均取得単価）で売り取引を記録し、数量を0にする。
// 取引履歴・取引サマリーに「売り」として残るのが store.sellAll（履歴を残さず0にするだけ）との違い。
// hids（保有ID配列）を渡すと、その証券口座（証券会社×口座）だけを売却する。省略時は全口座。
function recordSellAll(secId, hids) {
  const sec = store.data.securities.find(s => s.id === secId); if (!sec) return 0;
  const price = calc.price(sec);
  const td = today();
  let lots = store.data.holdings.filter(h => h.securityId === secId && h.quantity > 1e-9);
  if (Array.isArray(hids)) lots = lots.filter(h => hids.includes(h.id));
  lots.forEach(h => store.addTransaction({
    securityId: secId, type: 'sell', quantity: h.quantity,
    price: price != null ? price : (h.avgCost || 0),
    broker: h.broker, accountType: h.accountType, tradedAt: td,
  }));
  return lots.length;
}
// 全売却の確認モーダル。売却内容（証券会社×口座ごとの数量・売値・概算売却額）を表示し、
// 証券口座単位で選んで売却できる。hids 省略時は全口座を選択済みで表示。
function openSellAllModal(secId, hids) {
  const sec = store.data.securities.find(s => s.id === secId); if (!sec) return;
  const ccy = MARKET_CCY[sec.market];
  const price = calc.price(sec);
  const lots = store.data.holdings.filter(h => h.securityId === secId && h.quantity > 1e-9);
  if (!lots.length) { toast('売却できる保有がありません'); return; }
  const pre = (Array.isArray(hids) && hids.length) ? hids : lots.map(h => h.id);
  const sellPriceOf = h => price != null ? price : (h.avgCost || 0);
  const rows = lots.map(h => `
    <tr>
      <td class="l"><label style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="checkbox" class="sa-chk" value="${h.id}" data-amt="${h.quantity * sellPriceOf(h)}" ${pre.includes(h.id) ? 'checked' : ''}>
        ${esc(h.broker || '—')} / ${esc(h.accountType || '—')}</label></td>
      <td>${fmtQty(h.quantity, sec.market)}</td>
      <td>${ccy}${num(sellPriceOf(h))}</td>
      <td>${ccy}${num(h.quantity * sellPriceOf(h))}</td>
    </tr>`).join('');
  showModal(`全売却 — ${esc(calc.displayName(sec))}`, `
    <p class="muted">選んだ証券口座を全売却します。取引履歴に「売り」を記録し（売値は${price != null ? '現在値' : '平均取得単価（現在値が未取得のため）'}）、数量を0にします。</p>
    <div class="table-wrap"><table>
      <thead><tr><th class="l">証券会社 / 口座</th><th>数量</th><th>売値(${ccy})</th><th>概算売却額(${ccy})</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th class="l">合計（選択中）</th><th></th><th></th><th id="sa-total"></th></tr></tfoot>
    </table></div>
    <div class="form-actions">
      <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
      <button type="button" class="btn btn-danger" id="sa-exec">全売却する</button>
    </div>`, { wide: true });
  const chks = () => [...document.querySelectorAll('.sa-chk')];
  const updTotal = () => {
    const sel = chks().filter(c => c.checked);
    document.getElementById('sa-total').textContent = ccy + num(sel.reduce((a, c) => a + (parseFloat(c.dataset.amt) || 0), 0));
    document.getElementById('sa-exec').disabled = sel.length === 0;
  };
  chks().forEach(c => { c.onchange = updTotal; });
  updTotal();
  document.getElementById('sa-exec').onclick = () => {
    const ids = chks().filter(c => c.checked).map(c => parseInt(c.value, 10));
    if (!ids.length) return;
    const n = recordSellAll(secId, ids);
    closeModal(); closeDrawer(); render();
    toast(`${n} 口座を全売却しました`);
  };
}
// 保有編集フォーム等からの呼び出し口（確認モーダルを開く）
function sellAll(secId, hids) { openSellAllModal(secId, hids); }

// ---------- 銘柄詳細（SEC-15） ----------
// 価格チャート（トリガーライン重畳）＋判定・保有・購入履歴・分析メタ・ファンダを1画面に。
function openSecurityDetail(secId) {
  const sec = store.data.securities.find(s => s.id === secId); if (!sec) return;
  const ccy = MARKET_CCY[sec.market];
  const m = v => v == null ? '<span class="muted">—</span>' : ccy + num(v);
  const ev = calc.evaluate(sec);
  const th = calc.totalHolding(sec.id);
  const price = calc.price(sec);
  const rule = store.rule(sec.ruleId);
  const lb = calc.lastBuyInfo(sec);
  const kv = (l, v) => `<div class="ai-row"><span class="muted">${l}</span><span>${v}</span></div>`;
  // 適用ルールの内容（初回/買い増しの下落率・基準高値）。判定対象外でも表示。
  const bhMode = (sec.baseHighMode || (rule && rule.baseHighMode) || '5y');
  const ruleInfo = rule ? kv('適用ルール', `${esc(rule.name)}<br><span class="muted">初回 −${rule.initialDropPct}% ／ 買い増し −${rule.addonDropPct}% ／ 基準高値 ${esc(BASE_HIGH_LABEL[bhMode] || bhMode)}</span>`) : '';
  // 種別（高値更新・固定値も区別）
  const typeLabel = ev ? (ev.baseSource === '固定' ? '買い増し（買増固定値）'
    : ev.baseSource === '高値更新' ? '買い増し（高値更新→初回ルールで判定）'
    : ev.baseSource === '初回固定' ? '買い増し（初回基準に固定＝基準高値×初回下落率）'
    : ev.type === 'initial' ? '初回購入' : '買い増し') : '';
  // 高値更新オプションがONなのに高値更新が適用されていない時、その理由を表示（サイレント失敗の可視化）
  let highResetNote = '';
  if (ev && rule && rule.highResetMode && ev.type === 'addon' && ev.baseSource !== '高値更新' && ev.baseSource !== '固定' && ev.baseSource !== '初回固定') {
    const bhDate = calc.baseHighDate(sec);
    let reason;
    if (!lb.date) reason = '前回購入日が未設定です。取引履歴の買い、または銘柄編集の「前回購入日」を入力してください。';
    else if (!bhDate) reason = '高値の日付が未取得です。上部の「価格更新」を実行すると取得され、判定に反映されます（以後は日次で自動更新）。';
    else reason = `最高値の日付（${esc(bhDate)}）が前回購入日（${esc(lb.date)}）より前のため、高値更新ではありません。`;
    highResetNote = `<div class="ai-row" style="background:var(--warn-soft,#fff7e6);border-radius:6px"><span class="muted">高値更新が未適用</span><span style="font-size:12px;text-align:right">${reason}</span></div>`;
  }
  // 判定
  const judge = ruleInfo + (ev ? [
    kv('種別', typeLabel),
    kv('基準値', (ev.baseSource === 'みなし' ? MINASHI : ev.baseSource === '固定' ? FIXED_MARK : '') + m(ev.base)),
    kv('次回購入(トリガー)', (ev.baseSource === '固定' ? FIXED_MARK : '') + m(ev.trigger)),
    kv('現在値', m(price)),
    kv('残り下落率', ev.remainingDropPct != null ? `<span class="${ev.reached ? 'neg' : ''}">${ev.remainingDropPct.toFixed(1)}%</span>` + (ev.reached ? '（到達）' : '') : '—'),
    highResetNote,
    // 目標指標からの逆算株価（参考値・判定には未使用）。目標値が未入力の行は出さない
    [['目標PER', sec.targetPer, num(sec.targetPer) + '倍', calc.targetPerPrice(sec)],
     ['目標PBR', sec.targetPbr, num(sec.targetPbr) + '倍', calc.targetPbrPrice(sec)],
     ['目標利回り', sec.targetYield, num(sec.targetYield) + '%', calc.targetYieldPrice(sec)]]
      .filter(([, t]) => t > 0)
      .map(([lbl, , txt, p]) => kv(lbl, `${txt} / ${p != null ? m(p) : '—'}`)).join(''),
  ].join('') : '<div class="muted">判定対象外（無効/価格未取得/投信）</div>');
  // 保有（口座別）。表示は保有株数がある口座だけ（0株のロットは出さない）
  const hs = store.data.holdings.filter(h => h.securityId === sec.id && h.quantity > 1e-9);
  const holdRows = hs.length ? hs.map(h => `<div class="ai-row"><span class="muted">${esc(h.broker || '—')} / ${esc(h.accountType || '—')}</span><span>${fmtQty(h.quantity, sec.market)} @ ${m(h.avgCost)}${h.origBuyAmount != null ? ` <span class="muted" title="売却前購入額（本来）">(本来 ${m(h.origBuyAmount)})</span>` : ''}</span></div>`).join('') : '<div class="muted">保有なし</div>';
  const holdSummary = th.qty ? kv('合計 / 評価額 / 損益率',
    `${fmtQty(th.qty, sec.market)}　/　${m(calc.valueOrCostNative(sec))}　/　<span class="${cls(calc.pnlPctNative(sec))}">${calc.pnlPctNative(sec) != null ? signed(calc.pnlPctNative(sec)) + '%' : '—'}</span>`) : '';
  // 購入額（本来）: 売却前購入額があればそれ・無ければ取得価額を保有ごとに合算（損出し時の最初の購入額）
  const origCostN = calc.originalCostNative(sec);
  const origCostRow = origCostN ? kv('購入額（本来）', m(origCostN)) : '';
  // 元本売却（情報管理のみ）。フラグまたは金額があれば表示
  const principalSoldRow = (sec.principalSold || sec.principalSoldAmount != null)
    ? kv('元本売却', `${sec.principalSold ? '売却済み' : '—'}${sec.principalSoldAmount != null ? '　/　' + m(sec.principalSoldAmount) : ''}`) : '';
  // 購入・取引履歴は txnHistoryHtml（編集・削除つき）で描画する
  // 分析メタ
  const meta = [
    kv('銘柄格付 / 総合 / 買い時', `${esc(sec.rating || '—')} / ${esc(sec.overallGrade || '—')} / ${esc(sec.buyGrade || '—')}`),
    kv('★(ﾊﾞﾘｭ/強/ﾘｽｸ)', [sec.starValuation, sec.starStrength, sec.starRisk].some(x => x != null) ? [sec.starValuation, sec.starStrength, sec.starRisk].map(x => x ?? '—').join('/') : '—'),
    kv('カテゴリ', sec.category ? categoryTag(sec.category) : '—'),
    kv('投資カテゴリ', sec.investCategory ? investCategoryTag(sec.investCategory) : '—'),
    kv('銘柄ラベル', secLabels(sec).length ? labelsTag(sec) : '—'),
    kv('優先順位 / 評価日', `${sec.priority != null ? sec.priority : '—'} / ${esc(sec.analysisDate || '—')}`),
    sec.analysisNote ? kv('分析メモ', esc(sec.analysisNote)) : '',
  ].join('');
  // ファンダ
  const fund = [
    kv('セクター / 業種', `${esc(calc.field(sec, 'sector') || '—')} / ${esc(calc.field(sec, 'industry') || '—')}`),
    kv('PER / EPS', `${calc.per(sec) != null ? num(calc.per(sec)) : '—'} / ${calc.field(sec, 'eps') != null ? m(calc.field(sec, 'eps')) : '—'}`),
    kv('配当/株 / 利回り', `${calc.field(sec, 'dividend') != null ? m(calc.field(sec, 'dividend')) : '—'} / ${calc.divYield(sec) != null ? calc.divYield(sec).toFixed(2) + '%' : '—'}`),
    kv('時価総額 / 5年高値 / 52週高値', `${calc.marketCap(sec) != null ? fmtTurnover(calc.marketCap(sec) * 1e6, sec.market) : '—'} / ${m(calc.high5y(sec))} / ${m(calc.high52w(sec))}`),
    // 市場の時価総額1位まで何倍か（1位が未取得なら行ごと出さない）
    ...(topMarketCap(sec.market) && calc.capToTop(sec) != null ? [(() => {
      const t = topMarketCap(sec.market), f = capToTopFmt(sec.market, calc.capToTop(sec));
      return kv('時価総額1位まで', calc.capToTop(sec) > 1 ? `${esc(f.label)}（${f.pct}） <span class="muted">1位 ${esc(t.name || t.code)} ${fmtTurnover(t.cap, sec.market)}</span>` : '到達済み（1位）');
    })()] : []),
    kv('1年安値 / 3年安値', `${m(calc.low1y(sec))} / ${m(calc.low3y(sec))}`),
    kv('売買代金（現在値×当日出来高）', `${calc.turnover(sec) != null ? fmtTurnover(calc.turnover(sec), sec.market) : '—'}`),
    kv('前回決算 / 次回決算', `${esc(earnPrevText(sec))} / ${esc(earnNextText(sec))}`),
    companySummary(sec) ? kv('概要', `<span style="font-weight:400">${esc(companySummary(sec))}</span>`) : '',
  ].join('');
  // 基本情報の派生値
  const held = th.qty > 0;
  const valJpy = calc.toJpy(sec.market, calc.valueOrCostNative(sec));
  const costJpyV = calc.toJpy(sec.market, calc.costNative(sec));
  const pnlJpyV = (valJpy != null && costJpyV != null) ? valJpy - costJpyV : null;
  const pnlPctN = calc.pnlPctNative(sec);
  const pr = store.data.prices[priceKey(sec)] || {};
  const dayPct = (pr.price != null && pr.prevClose) ? (pr.price - pr.prevClose) / pr.prevClose * 100 : null;
  // 保有数量は小数点以下を「あるところまで」表示（表とは別表記）
  const qtyDisp = th.qty != null ? Number(th.qty).toLocaleString('ja-JP', { maximumFractionDigits: 8 }) : '—';
  const gradeTag = g => { if (!g) return '<span class="muted">—</span>'; const gm = (store.data.grades || []).find(x => x.grade === String(g).toUpperCase()); const st = gm && gm.color ? labelColorStyle(gm.color) : ''; return `<span class="grade grade-${esc(String(g).toLowerCase())}"${st ? ` style="${st}"` : ''}>${esc(g)}</span>`; };
  const starsFmt = n => n == null ? '<span class="muted">—</span>' : `<span style="color:var(--brass);letter-spacing:1px">${'★'.repeat(n)}<span style="color:var(--border-strong)">${'☆'.repeat(Math.max(0, 5 - n))}</span></span>`;
  const earnHdr = earnTopHtml(sec); // 格付けの右に右寄せで決算日（株探風の日付テキスト。ラベルにはしない）
  const subHtml = `<span class="tag ${sec.market.toLowerCase()}">${MARKET_LABEL[sec.market]}</span><span class="muted" style="font-size:13px">${esc(sec.ticker)}</span>${detailTypeOf(sec) === 'ETF' ? '<span class="tag detail-etf">ETF</span>' : ''}${gradeTag(sec.rating)}${sec.watch ? '<span class="tag watch">注意</span>' : ''}${earnHdr ? `<span style="margin-left:auto">${earnHdr}</span>` : ''}`;
  // 評価（格付＝銘柄格付のみ。総合/買い時は出さない）＋☆＋分析メモ
  const evalBox = [
    kv('銘柄格付', gradeTag(sec.rating)),
    sec.starValuation != null ? kv('バリュエーション', starsFmt(sec.starValuation)) : '',
    sec.starStrength != null ? kv('事業の強さ', starsFmt(sec.starStrength)) : '',
    sec.starRisk != null ? kv('リスク', starsFmt(sec.starRisk)) : '',
    sec.analysisNote ? kv('分析メモ' + (sec.analysisDate ? `（${esc(sec.analysisDate)}）` : ''), esc(sec.analysisNote)) : '',
  ].join('');
  // 推奨額＝カテゴリ別の推奨購入額（市場通貨。US=ドル/JP=円）。store.categoryAmountFor から都度算出する。
  // 旧実装は取込専用フィールド sec.recoAmount を参照しており、未取込でも古い値が残って桁違い表示になっていた。
  const recoBuy = sec.category ? store.categoryAmountFor(sec.category, sec.market) : null;
  const metaBox = [
    kv('カテゴリ', sec.category ? categoryTag(sec.category) : '—'),
    kv('投資カテゴリ', sec.investCategory ? investCategoryTag(sec.investCategory) : '—'),
    kv('銘柄ラベル', secLabels(sec).length ? labelsTag(sec) : '—'),
    kv('推奨額', recoBuy ? m(recoBuy) : '—'),
    kv('優先順位 / 評価日', `${sec.priority != null ? sec.priority : '—'} / ${esc(sec.analysisDate || '—')}`),
  ].join('');
  const sectionBox = (title, inner) => `<fieldset class="form-group"><legend>${title}</legend><div class="auto-info">${inner}</div></fieldset>`;
  // 株価シナリオ（短期・中期の予想レンジ＋現在値がどのレンジにいるか）。データがある時だけボックスを出す
  const scRow = (term, label) => {
    const parts = [['Bear', '弱気'], ['Base', 'ベース'], ['Bull', '強気']]
      .map(([k, lb]) => { const f = scFmtRange(sec[term + k], sec.market); return f ? `<span class="muted">${lb}</span> ${f}` : null; }).filter(Boolean);
    if (!parts.length) return '';
    const pos = scPosition(sec, term);
    return kv(`${label}シナリオ`, `${parts.join('　')}${pos ? `　<span class="tag" style="${labelColorStyle(pos.color)}" title="現在値がどのレンジにいるか">現在: ${esc(pos.label)}</span>` : ''}`);
  };
  const scenarioBox = [
    scRow('st', '短期'), scRow('mt', '中期'),
    (sec.scenarioDate || sec.scenarioPrice != null) ? kv('分析日 / 分析時株価', `${esc(sec.scenarioDate || '—')} / ${sec.scenarioPrice != null ? m(sec.scenarioPrice) : '—'}`) : '',
  ].join('');

  showDrawer(`${calc.displayName(sec)}`, `
    ${held ? `<div style="display:flex;gap:24px;align-items:flex-end;flex-wrap:wrap;margin-bottom:2px">
      <div><div class="muted" style="font-size:12px">評価額（円換算）</div><div class="num" style="font-family:var(--serif);font-size:28px;font-weight:600;line-height:1.15">${yen(valJpy)}</div></div>
      <div style="padding-bottom:3px"><div class="muted" style="font-size:12px">評価損益</div><div class="num ${cls(pnlJpyV)}" style="font-size:17px;font-weight:700;white-space:nowrap">${yen(pnlJpyV)}${pnlPctN != null ? ` <span style="font-size:13px">（${signed(pnlPctN)}%）</span>` : ''}</div></div>
    </div>` : `<div class="notice" style="margin-top:0">この銘柄は現在保有していません（ウォッチ対象）。</div>`}

    <div class="kv" style="grid-template-columns:1fr 1fr 1fr">
      <div class="cell"><div class="k">現在値</div><div class="v">${m(price)}</div></div>
      <div class="cell"><div class="k">前日比</div><div class="v ${cls(dayPct)}">${dayPct != null ? signed(dayPct) + '%' : '—'}</div></div>
      <div class="cell"><div class="k">5年高値 / 52週高値</div><div class="v">${m(calc.high5y(sec))} / ${m(calc.high52w(sec))}</div></div>
      <div class="cell"><div class="k">1年安値 / 3年安値</div><div class="v">${m(calc.low1y(sec))} / ${m(calc.low3y(sec))}</div></div>
      <div class="cell"><div class="k">平均取得単価</div><div class="v">${held ? m(th.avgCost) : '—'}</div></div>
      <div class="cell"><div class="k">保有数量</div><div class="v">${qtyDisp}</div></div>
      <div class="cell"><div class="k">取得原価${sec.market === 'US' ? '（$ / 円）' : '（円）'}</div><div class="v">${held ? (sec.market === 'US' ? `${m(calc.costNative(sec))}<span class="muted" style="font-weight:400;font-size:11px"> / ${yen(costJpyV)}</span>` : yen(costJpyV)) : '—'}</div></div>
      <div class="cell"><div class="k">資産に占める割合</div><div class="v">${held ? ratioSummaryHtml(sec) : '—'}</div></div>
    </div>

    <fieldset class="form-group"><legend>価格チャート（週足終値）</legend>
      <div class="seg" id="chart-range-seg" style="margin:0 0 8px;width:fit-content">
        <button data-r="1y" class="${detailChartRange === '1y' ? 'active' : ''}" onclick="setDetailChartRange('1y')">1年</button>
        <button data-r="3y" class="${detailChartRange === '3y' ? 'active' : ''}" onclick="setDetailChartRange('3y')">3年</button>
        <button data-r="5y" class="${detailChartRange === '5y' ? 'active' : ''}" onclick="setDetailChartRange('5y')">5年</button>
      </div>
      <div id="detail-chart" class="muted" style="min-height:160px;display:flex;align-items:center;justify-content:center;cursor:zoom-in" title="クリックで拡大" onclick="enlargeDetailChart()">読み込み中…</div>
      <p class="muted" style="margin:6px 0 0;font-size:11px">青=終値 / 赤破線=次回購入(トリガー) / 緑破線=現在値${typeof sec.prevBuyPrice === 'number' || lb.price != null ? ' / 橙破線=前回購入' : ''} / ◆高値・安値（クリックで拡大）</p>
    </fieldset>
    ${sectionBox('ファンダ', fund)}
    ${sectionBox('評価', evalBox)}
    ${scenarioBox ? sectionBox('株価シナリオ', scenarioBox) : ''}
    ${sectionBox('判定', judge)}
    ${sectionBox('保有', holdRows + (holdSummary || '') + (origCostRow || '') + (principalSoldRow || ''))}
    ${sec.memo ? sectionBox('メモ', `<div style="white-space:pre-wrap;word-break:break-word">${esc(sec.memo)}</div>`) : ''}
    ${txnHistoryHtml(sec.id, { title: '購入・取引履歴' })}
    ${sectionBox('分析メタ', metaBox)}`, `
    <button type="button" class="btn" onclick="openSecNews(${sec.id})" title="この銘柄のニュース・開示を表示">${svgIcon('news', '')} ニュース</button>
    ${held ? `<button type="button" class="btn btn-danger" onclick="sellAll(${sec.id})" title="証券口座を選んで全売却">全売却</button>` : ''}
    <button type="button" class="btn btn-brass" onclick="closeDrawer();openTxnForm(${sec.id})">${svgIcon('trade', '')} 取引</button>
    <button type="button" class="btn" onclick="closeDrawer();openHoldingsForm(${sec.id})">保有</button>
    <button type="button" class="btn" onclick="closeDrawer();openSecurityForm(${sec.id})">${svgIcon('edit', '')} 編集</button>`, subHtml);
  // ドロワー上部の銘柄名はクリックで銘柄カルテへ（showDrawer は textContent で入れるので後から差し替え）
  const dtEl = document.getElementById('drawer-title');
  if (dtEl) dtEl.innerHTML = `<span class="dr-title-link" title="銘柄カルテを開く" onclick="karteOpenSec(${sec.id})">${esc(calc.displayName(sec))}</span>`;
  _detailChartCtx = { sec, ev, price, lb };
  loadDetailChart(sec, ev, price, lb, detailChartRange);
}
// 詳細チャートをクリックで拡大表示（画面いっぱいの専用オーバーレイ。viewBoxで自動スケール）
// elId 省略時は保有/カルテの '#detail-chart'。分析タブは 'ana-detail-chart' を渡す。
function enlargeDetailChart(elId = 'detail-chart', title = '価格チャート') {
  const el = document.getElementById(elId); if (!el) return;
  const svg = el.querySelector('svg'); if (!svg) return; // 読み込み中・取得失敗時は無視
  let ov = document.getElementById('chart-zoom-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'chart-zoom-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,24,40,.55);z-index:300;display:flex;align-items:center;justify-content:center;padding:24px;cursor:zoom-out';
    ov.onclick = () => ov.remove();
    document.body.appendChild(ov);
  }
  // SVG群（candle/RSI/MACD）はすべて width:100%。大きな器に入れると viewBox がスケールして拡大表示。
  ov.innerHTML = `<div style="background:var(--panel);border-radius:14px;padding:20px;width:min(1400px,94vw);max-height:92vh;overflow:auto;box-shadow:var(--shadow-lg);cursor:default" onclick="event.stopPropagation()">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><strong style="font-size:15px">${esc(title)}</strong><button class="x-btn" onclick="document.getElementById('chart-zoom-overlay').remove()">&times;</button></div>
      <div style="width:100%">${el.innerHTML}</div>
    </div>`;
}
// 詳細チャートの期間（1y/3y/5y）。デフォルト5年
let detailChartRange = '5y';
let _detailChartCtx = null;
function setDetailChartRange(r) {
  detailChartRange = r;
  document.querySelectorAll('#chart-range-seg button').forEach(b => b.classList.toggle('active', b.dataset.r === r));
  const c = _detailChartCtx;
  if (c) loadDetailChart(c.sec, c.ev, c.price, c.lb, r);
}
// 終値時系列を取得してSVGチャートを描画（トリガー/現在値/前回購入の水平線つき）
async function loadDetailChart(sec, ev, price, lb, range = '5y') {
  const el = document.getElementById('detail-chart'); if (!el) return;
  el.classList.add('muted'); el.textContent = '読み込み中…';
  // 1年は日足ローソク、3年/5年は週足ローソク（潰れ防止）
  const interval = range === '1y' ? '1d' : '1wk';
  try {
    const res = await fetch(`/api/history?symbol=${encodeURIComponent(yahooSymbol(sec))}&range=${encodeURIComponent(range)}&interval=${interval}&format=ohlcv`);
    const d = await res.json();
    if (d.error || !d.bars || !d.bars.length) { el.textContent = '価格履歴を取得できませんでした（ローカルは wrangler 起動時のみ取得可）。'; return; }
    const hlines = [];
    if (ev && ev.trigger != null) hlines.push({ price: ev.trigger, color: 'var(--red)', label: '次回購入' });
    if (price != null) hlines.push({ price, color: 'var(--green)', label: '現在値' });
    if (lb && lb.price != null) hlines.push({ price: lb.price, color: 'var(--amber)', label: '前回購入' });
    // 保有銘柄/カルテのチャートは移動平均なし（高値・安値マーカーは既定で表示）。MAは分析タブのチャートのみ。
    el.classList.remove('muted');
    el.innerHTML = TA.candleSVG(d.bars, { hlines });
  } catch (e) { el.textContent = '価格履歴の取得に失敗しました: ' + (e && e.message || e); }
}
// 「切りのいい」目盛刻み幅を返す（1/2/5×10^n）。range=値域, target=目安の本数。
function niceStep(range, target) {
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag; // 1〜10
  const f = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return f * mag;
}
// バニラSVGの折れ線チャート（外部ライブラリ不要）。Y補助目盛・X年ラベル・高値/安値マーカー付き。
function detailSvgChart(points, overlays, costPts) {
  const W = 760, H = 300, pad = { l: 56, r: 86, t: 14, b: 26 };
  const ys = points.map(p => p[1]); const xs = points.map(p => p[0]);
  let dmin = Math.min(...ys), dmax = Math.max(...ys);
  overlays.forEach(o => { if (o.y != null) { dmin = Math.min(dmin, o.y); dmax = Math.max(dmax, o.y); } });
  if (costPts && costPts.length) costPts.forEach(p => { if (p[1] != null) { dmin = Math.min(dmin, p[1]); dmax = Math.max(dmax, p[1]); } });
  if (dmin === dmax) { dmin -= 1; dmax += 1; }
  // 切りのいい刻み幅（…/10/20/50/100/200/500/1000/…）を範囲から自動決定し、Y軸の上下端もその倍数に丸める
  const step = niceStep((dmax - dmin) || 1, 5);
  const ymin = Math.floor(dmin / step) * step, ymax = Math.ceil(dmax / step) * step;
  const xmin = xs[0], xmax = xs[xs.length - 1];
  const px = t => pad.l + (xmax === xmin ? 0 : (t - xmin) / (xmax - xmin)) * (W - pad.l - pad.r);
  const py = v => pad.t + (1 - (v - ymin) / (ymax - ymin)) * (H - pad.t - pad.b);
  // Y補助線＋目盛（刻み幅 step の倍数）
  let grid = '';
  for (let v = ymin; v <= ymax + step * 1e-6; v += step) {
    const y = py(v).toFixed(1);
    grid += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
    grid += `<text x="${pad.l - 6}" y="${(+y + 3).toFixed(1)}" fill="var(--muted)" font-size="10" text-anchor="end">${num(v)}</text>`;
  }
  // X年の区切り＋ラベル
  let xlab = '', lastYear = null;
  points.forEach(p => { const yr = new Date(p[0] * 1000).getFullYear(); if (yr !== lastYear) { lastYear = yr; const x = px(p[0]).toFixed(1); xlab += `<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${H - pad.b}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2 4"/><text x="${x}" y="${H - pad.b + 14}" fill="var(--muted)" font-size="10" text-anchor="middle">${yr}</text>`; } });
  // 高値・安値マーカー
  let hi = -Infinity, lo = Infinity, hiI = 0, loI = 0;
  ys.forEach((v, i) => { if (v > hi) { hi = v; hiI = i; } if (v < lo) { lo = v; loI = i; } });
  const mark = (i, v, label, color, up) => { const x = px(xs[i]).toFixed(1), y = py(v); return `<circle cx="${x}" cy="${y.toFixed(1)}" r="3.5" fill="${color}"/><text x="${x}" y="${(y + (up ? -6 : 14)).toFixed(1)}" fill="${color}" font-size="10" text-anchor="middle">${label} ${num(v)}</text>`; };
  const hl = mark(hiI, hi, '高値', '#c026d3', true) + mark(loI, lo, '安値', '#0d9488', false);
  // データ線
  const dpath = points.map((p, i) => (i ? 'L' : 'M') + px(p[0]).toFixed(1) + ' ' + py(p[1]).toFixed(1)).join(' ');
  // 副系列（取得原価など）の破線。資産推移で総資産＝実線/取得原価＝破線を重ねる用途。
  const cpath = (costPts && costPts.length) ? `<path d="${costPts.map((p, i) => (i ? 'L' : 'M') + px(p[0]).toFixed(1) + ' ' + py(p[1]).toFixed(1)).join(' ')}" fill="none" stroke="var(--muted)" stroke-width="1.2" stroke-dasharray="4 3"/>` : '';
  // overlays（右ラベル）
  const ov = overlays.filter(o => o.y != null).map(o => { const y = py(o.y).toFixed(1); return `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="${o.color}" stroke-width="1" stroke-dasharray="4 3"/><text x="${W - pad.r + 4}" y="${(+y + 3).toFixed(1)}" fill="${o.color}" font-size="10">${esc(o.label)} ${num(o.y)}</text>`; }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;background:var(--panel);border:1px solid var(--border);border-radius:8px">
    ${grid}${xlab}${cpath}<path d="${dpath}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>${ov}${hl}
  </svg>`;
}

// ========================= 分析タブ（チャートパターン判定） =========================
// 設計: ANALYSIS_PLAN.md。エンジンは analysis.js（globalThis.TA）。
// 計測(metrics)を techAnalysis に保存し、しきい値変更時は採点のみ再実行（API再取得なし・§3.5）。
let anaMarket = 'all';        // 'all' | 'US' | 'JP'
let anaSide = 'contra';       // 分析タブの表ビュー: 'contra'(逆張り) | 'trend'(順張り)。列レイアウト/ソートを別プロファイルで保持
function anaColKey() { return anaSide === 'trend' ? 'ANALYSIS_T' : 'ANALYSIS'; }
let anaHoldingOnly = false;   // 保有銘柄のみ
let anaTop50 = false;         // 売買代金トップ50を分析対象にする（保有のみと排他）
let anaTop50Secs = [];        // トップ50の対象銘柄（登録済みは実体、未登録はランキング由来の仮想銘柄 _virtual）
let anaTop50Busy = false;     // トップ50ランキング取得中
let anaTop50Rank = {};        // priceKey→ランキング順位(1始まり)。トップ50の初期ソート(rankキー)用
let _anaTop50SortBackup = null; // トップ50ON前のソートを退避し、OFFで復元（非top50のソートは変えない）
let anaSearch = '';           // 検索（コード/名称）
let anaSort = { key: 'score', dir: -1 };
let anaPanelOpen = false;     // しきい値パネルの開閉
// 列フィルターは共通モジュール（fltState.analysis / filterPanelHtml('analysis')）に統合
const _anaBars = {};          // priceKey→OHLCV日足（セッション中キャッシュ。再描画・再計測でAPI不要）
// 分析エンジンの版を2層に分離（「今日データ取得済みなら再取得せず再採点」を実現するため）。
//  MEASURE_VER: 計測・パターン集合の版。変えたら metrics が足りないのでバー再取得が必要。
//  SCORE_VER:   採点・集計の版。保存済み metrics から再採点でOK（API再取得不要）。
const MEASURE_VER = 8; // 8: 確認文脈(above5/dev52w)を列表示するため再取得で再計測が必要
const SCORE_VER = 1;
const TECH_VER = MEASURE_VER; // 後方互換（保存結果の ver = MEASURE_VER）

function anaToday() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function anaThresholds() { return TA.mergeThresholds(store.data.settings && store.data.settings.techThresholds); }

// 分析対象（フィルタ適用後の銘柄）
function analysisTargets() {
  let secs;
  if (anaTop50) {
    // 売買代金トップ50（ランキング由来）。登録済みは実体、未登録は仮想銘柄。市場フィルタのみ適用（保有のみは無視）。
    secs = anaTop50Secs.slice();
    if (anaMarket !== 'all') secs = secs.filter(s => s.market === anaMarket);
  } else {
    secs = store.data.securities.filter(s => s.market === 'US' || s.market === 'JP');
    if (anaMarket !== 'all') secs = secs.filter(s => s.market === anaMarket);
    if (anaHoldingOnly) {
      const held = new Set(store.data.holdings.filter(h => (h.quantity || 0) > 0).map(h => h.securityId));
      secs = secs.filter(s => held.has(s.id));
    }
  }
  if (anaSearch) secs = secs.filter(s => secMatchesQuery(s, anaSearch));
  // 列フィルタ（共通モジュール。数値＝範囲 / 選択肢＝いずれかに一致）
  secs = applyColFilters(secs, 'analysis');
  return secs;
}

// 保有銘柄と同じ列システム（列選択・固定列・スクロール・カラールール）を 'ANALYSIS' 画面として再利用する。
function renderAnalysis() {
  const AKEY = anaColKey();
  const st = listState[AKEY];
  let secs = analysisTargets();
  ratioCtx = buildRatioCtx(secs); // 比率列の分母（'表示中' はこの絞り込み後の集合）
  secs = sortSecurities(secs, AKEY);
  const mkBtn = (id, label) => `<button class="${anaMarket === id ? 'active' : ''}" onclick="anaSetMarket('${id}')">${label}</button>`;
  const sideBtn = (id, label) => `<button class="${anaSide === id ? 'active' : ''}" onclick="anaSetSide('${id}')">${label}</button>`;
  // 列（保有銘柄と同じ getColOrder/colTag/colHeadHtml/marketRow を使用）
  const visOrder = getColOrder(AKEY).filter(c => c.visible);
  const visibleCols = visOrder.map(c => MASTER_COLS.find(m => m.key === c.key)).filter(Boolean);
  const headHtml = colHeadHtml(visibleCols, st, AKEY, '');
  const ACTION_W = 96;
  const colgroupHtml = `<colgroup>${visOrder.map(c => colTag(c)).join('')}<col style="width:${ACTION_W}px"></colgroup>`;
  const tableW = ACTION_W + visOrder.reduce((a, c) => a + colWidthPx(c), 0);
  const done = secs.filter(s => techOf(s)).length;
  app.innerHTML = `
    <div class="section">
      <div class="toolbar">
        <div class="seg seg-side" role="tablist" title="表示する戦略の切替（列レイアウトは戦略ごとに保存）">${sideBtn('contra', '逆張り')}${sideBtn('trend', '順張り')}</div>
        <div class="seg" role="tablist">${mkBtn('all', '全て')}${mkBtn('US', '米国株')}${mkBtn('JP', '日本株')}</div>
        <label class="chip">保有のみ<input type="checkbox" ${anaHoldingOnly ? 'checked' : ''} ${anaTop50 ? 'disabled' : ''} onchange="anaToggleHolding(this.checked)" style="margin-left:4px"></label>
        ${anaMarket !== 'all' ? `<label class="chip" title="表示時に最新の売買代金ランキングを取得し、トップ50銘柄を分析対象にします（通常と同じ仕組み）">売買代金トップ50<input type="checkbox" ${anaTop50 ? 'checked' : ''} onchange="anaToggleTop50(this.checked)" style="margin-left:4px"></label>` : ''}
        <div class="search">${svgIcon('search', '')}<input id="ana-search" placeholder="コード・銘柄名で検索" value="${esc(anaSearch)}" oninput="anaSetSearch(this.value)" autocomplete="off">${anaSearch ? `<button class="clr" onclick="anaSetSearch('')">×</button>` : ''}</div>
        <div class="tb-spacer"></div>
        ${filterBtnHtml('analysis')}
        <button class="btn btn-sm" onclick="anaTogglePanel()" title="しきい値設定">しきい値 ${anaPanelOpen ? '▲' : '▼'}</button>
        <button class="btn btn-sm col-picker-btn" onclick="openColPicker('${AKEY}')" title="列の表示設定（${anaSide === 'trend' ? '順張り' : '逆張り'}ビュー）">${svgIcon('columns', '')} 列</button>
        <button class="btn btn-sm" onclick="copyDisplayedTable()" title="表示中の表をコピー">${svgIcon('copy', '')} 表コピー</button>
        <button class="btn btn-sm btn-primary" onclick="runAnalysis()">分析</button>
      </div>
      <div class="summary-strip">
        <div class="ss"><span class="ss-k">対象</span><span class="ss-v num">${secs.length} 銘柄</span></div>
        <div class="ss"><span class="ss-k">分析済み</span><span class="ss-v num">${done} 銘柄</span></div>
        <div class="tb-spacer"></div>
        <div class="ss"><span class="ss-k muted" style="font-weight:400">順張り/逆張り総合＝確認ゲート方式(0-100)：単独は最大55、確認が増えるほど高得点。各パターン列＝形の近さ(0-100)。<b style="color:var(--muted)">灰字=未確認(部分一致)</b>・<b style="color:var(--red)">赤✕=失敗(崩れ)</b>・色付き=成立。「—」は未分析。行クリックで内訳＋チャート。</span></div>
      </div>
      <div id="flt-host-analysis">${fltState.analysis.open ? filterPanelHtml('analysis') : ''}</div>
      ${anaPanelOpen ? anaThresholdPanelHtml() : ''}
      <div class="section-body">
        ${secs.length === 0 ? `<div class="empty">${anaTop50Busy ? '売買代金ランキングを取得中…' : anaTop50 ? '売買代金ランキングを取得できませんでした（休場/時間外、または取得元の仕様変更の可能性）。トグルを切り替えると再取得します。' : '対象銘柄がありません。フィルタを変えるか、銘柄を登録してください。'}</div>` : `
        <div class="table-wrap"><table class="fixed-cols holdings dense" style="width:${tableW}px">${colgroupHtml}
          <thead><tr>${headHtml}<th class="l"></th></tr></thead>
          <tbody>${secs.map(sec => marketRow(sec, visibleCols, { actions: 'analysis' })).join('')}</tbody>
        </table></div>`}
      </div>
    </div>`;
  autoFitColumns(document.querySelector('#app table.fixed-cols'));
  applyStickyCols(document.querySelector('#app table.fixed-cols'), AKEY);
  // 直接再描画（検索/フィルタ/分析/しきい値）でも main.content 基準で表を枠内に収める（[[scroll-container-main-content]]）
  scheduleFit();
}

function anaSetMarket(m) {
  anaMarket = m;
  // トップ50は日本株/米国株でのみ有効。全てに切り替えたら解除（トグル自体も非表示になる）。
  if (m === 'all' && anaTop50) { anaTop50 = false; anaTop50Secs = []; }
  renderAnalysis();
  if (anaTop50) loadAnaTop50(); // 市場を跨いだら最新ランキングを取り直す
}
function anaSetSide(s) { anaSide = (s === 'trend') ? 'trend' : 'contra'; renderAnalysis(); }
function anaToggleHolding(v) { anaHoldingOnly = !!v; renderAnalysis(); }
function anaToggleTop50(v) {
  anaTop50 = !!v;
  if (anaTop50) {
    anaHoldingOnly = false; // 排他: トップ50を選ぶと保有のみは解除
    // 非top50のソートを退避（OFFで戻す）。初期ソート=ランキング順は loadAnaTop50 で設定する。
    _anaTop50SortBackup = {
      ANALYSIS:   { sortKey: listState.ANALYSIS.sortKey,   sortDir: listState.ANALYSIS.sortDir },
      ANALYSIS_T: { sortKey: listState.ANALYSIS_T.sortKey, sortDir: listState.ANALYSIS_T.sortDir },
    };
    loadAnaTop50();
  } else {
    anaTop50Secs = []; anaTop50Rank = {};
    // 退避していた非top50のソートを復元（トップ50以外のソートは変えない）
    if (_anaTop50SortBackup) {
      Object.assign(listState.ANALYSIS, _anaTop50SortBackup.ANALYSIS);
      Object.assign(listState.ANALYSIS_T, _anaTop50SortBackup.ANALYSIS_T);
      _anaTop50SortBackup = null;
    }
    renderAnalysis();
  }
}
// 売買代金トップ50を取得して分析対象に組み立てる。登録済み銘柄は実体を使い（取得済みのメタ/分析を表示）、
// 未登録はランキングのコード・名称のみを持つ仮想銘柄(_virtual)にする。表示時に毎回最新ランキングを取得する。
async function loadAnaTop50() {
  if (anaTop50Busy) return;
  anaTop50Busy = true; renderAnalysis();
  const markets = anaMarket === 'all' ? ['JP', 'US'] : [anaMarket];
  const secs = [], seen = new Set(), rank = {};
  let n = 0;
  try {
    for (const market of markets) {
      const r = await fetch(`/api/ranking?market=${market}&kind=turnover&sub=all&count=50`).then(x => x.ok ? x.json() : { items: [] }).catch(() => ({ items: [] }));
      for (const it of ((r && r.items) || []).slice(0, 50)) {
        if (it.code == null) continue;
        const code = String(it.code).toUpperCase();
        const k = market + ':' + code;
        if (seen.has(k)) continue; seen.add(k);
        rank[k] = ++n; // ランキング順位(1始まり)。初期ソート用。k は priceKey と一致
        const existing = store.data.securities.find(s => s.market === market && String(s.ticker || '').toUpperCase() === code);
        if (existing) { secs.push(existing); continue; }
        // 未登録＝仮想銘柄。priceKey/yahooSymbol が成立するよう market+ticker を持たせる。名称はランキング由来。
        secs.push({ id: 'v_' + k, market, ticker: it.code, name: it.name || code, currency: market === 'US' ? 'USD' : 'JPY', assetClass: 'stock', enabled: true, _virtual: true });
      }
    }
    anaTop50Secs = secs; anaTop50Rank = rank;
    // 初期ソート＝ランキング順（rankキー昇順）。以後ユーザーが列をクリックすれば通常どおり変わる。
    listState.ANALYSIS.sortKey = 'rank';   listState.ANALYSIS.sortDir = 1;
    listState.ANALYSIS_T.sortKey = 'rank'; listState.ANALYSIS_T.sortDir = 1;
  } finally {
    anaTop50Busy = false;
    if (anaTop50) renderAnalysis(); // 取得完了で再描画（トグルがまだONのときのみ）
  }
}
// 分析タブの銘柄検索（登録済み→トップ50の仮想銘柄の順）。openAnalysisDetail/anaRowClick から共用。
function anaFindSec(market, ticker) {
  return store.data.securities.find(s => s.market === market && String(s.ticker) === String(ticker))
    || anaTop50Secs.find(s => s.market === market && String(s.ticker) === String(ticker))
    || null;
}
function anaSetSearch(v) {
  const el0 = document.getElementById('ana-search');
  const caret = el0 ? el0.selectionStart : v.length;
  anaSearch = v;
  if (window._imeComposing) return;
  renderAnalysis();
  const el = document.getElementById('ana-search');
  if (el) { el.focus(); const p = Math.min(caret, el.value.length); el.setSelectionRange(p, p); }
}
function anaTogglePanel() { anaPanelOpen = !anaPanelOpen; renderAnalysis(); }

// 「分析」: 今日データ取得済み（dataDate=今日・計測版一致）なら再取得せず再採点。未取得/計測版違いだけ取得する（§6）
async function runAnalysis() {
  const targets = analysisTargets();
  const today = anaToday();
  const th = anaThresholds();
  // 基本情報（銘柄名・株価）が未取得の対象は分析と一緒に取得する（トップ50の未登録＝仮想銘柄も含む）。
  // meta/price は priceKey でキャッシュされるので仮想銘柄でも表示に反映される。仮想銘柄は銘柄マスタ（=登録済み
  // securities）には出ないため一覧は汚さない。名称の同期上書き（コード化）は sync-merge の名称優先で防止済み。
  const needMeta = targets.filter(s => !((store.data.meta[priceKey(s)] || {}).name));
  const needPrice = targets.filter(s => (store.data.prices[priceKey(s)] || {}).price == null);
  const toFetch = [], toRescore = [];
  for (const s of targets) {
    const r = store.data.techAnalysis[priceKey(s)];
    const measVer = r && (r.measureVer != null ? r.measureVer : r.ver);   // 後方互換（旧データは ver）
    const dataDate = r && (r.dataDate || r.lastAnalyzed);                  // データ取得日（旧データは分析日で代用）
    if (r && measVer === MEASURE_VER && r.scoreVer === SCORE_VER && r.lastAnalyzed === today) continue; // 既に最新
    if (r && r.metrics && measVer === MEASURE_VER && dataDate === today) toRescore.push(s);             // 今日取得済み→採点のみ
    else toFetch.push(s);                                                                               // 取得が必要
  }
  const total = toFetch.length + toRescore.length;
  if (!total && !needMeta.length && !needPrice.length) { toast('対象はすべて最新版で当日分析済みです'); return; }
  let ok = 0, fail = 0, done = 0;
  busyShow(`分析中… 0/${total}`);
  // 0) 基本情報（銘柄名・株価）の取得。未取得分のみ。refreshMeta は内部で8件ずつ、価格は上限回避に15件ずつ。
  if (needMeta.length) { busyShow(`銘柄情報を取得中… 0/${needMeta.length}`); try { await api.refreshMeta(needMeta); } catch (_) {} }
  if (needPrice.length) {
    for (let i = 0; i < needPrice.length; i += 15) {
      busyShow(`株価を取得中… ${Math.min(i + 15, needPrice.length)}/${needPrice.length}`);
      try { await api.refreshPrice(needPrice.slice(i, i + 15)); } catch (_) {}
    }
  }
  // 1) 採点のみ（API不要・今日のデータを再利用）
  for (const s of toRescore) {
    const r = store.data.techAnalysis[priceKey(s)];
    if (rescoreFromMetrics(r, th)) { r.lastAnalyzed = today; r.measureVer = MEASURE_VER; r.scoreVer = SCORE_VER; r.ver = MEASURE_VER; ok++; } else fail++;
    busyShow(`再採点中（再取得なし）… ${++done}/${total}`);
  }
  // 2) データ取得＋計測＋採点
  for (const s of toFetch) {
    busyShow(`データ取得中… ${++done}/${total}`);
    try {
      const res = await fetch(`/api/history?symbol=${encodeURIComponent(yahooSymbol(s))}&range=3y&interval=1d&format=ohlcv`);
      const d = await res.json();
      if (d.error || !d.bars || d.bars.length < 60) { fail++; continue; }
      _anaBars[priceKey(s)] = d.bars;
      saveTechResult(s, TA.analyze(d.bars, th), today);
      ok++;
    } catch (_) { fail++; }
  }
  store.save();
  techSizeWatch();   // 保存量が上限に近づいていたら知らせる（消すかはユーザーが決める）
  busyHide();
  const infoNote = (needMeta.length || needPrice.length) ? ` / 基本情報 ${needMeta.length ? `名称${needMeta.length}` : ''}${needMeta.length && needPrice.length ? '・' : ''}${needPrice.length ? `株価${needPrice.length}` : ''}` : '';
  toast(`分析完了：成功 ${ok}（取得 ${toFetch.length} / 採点のみ ${toRescore.length}）${fail ? ` / 失敗 ${fail}` : ''}${infoNote}`);
  renderAnalysis();
}

// 保存済み metrics から採点のみ再実行（API不要）。総合は文脈込みで再計算。runAnalysis/rescoreAll で共用。
function rescoreFromMetrics(r, th) {
  if (!r || !r.metrics) return false;
  const shim = { byPattern: {} };
  for (const p of Object.keys(r.metrics)) shim.byPattern[p] = { metrics: r.metrics[p] };
  const sc = TA.score(shim, th);
  r.patterns = techRound(sc.patterns); r.best = sc.best; r.bestTrend = sc.bestTrend; r.bestContra = sc.bestContra; r.warn = sc.warn;
  const tt = (TA.recomputeTotals && TA.recomputeTotals(r)) || sc;   // ma200Pos/rsiState等の文脈込みの正しい総合
  r.trendTotal = techRound(tt.trendTotal); r.contraTotal = techRound(tt.contraTotal); r.totalScore = techRound(tt.totalScore); r.contraScore = techRound(tt.contraTotal);
  r._updatedAt = new Date().toISOString();
  if (r.history && r.history.length) { const last = r.history[r.history.length - 1]; if (last && last.date === r.lastAnalyzed) { last.best = sc.best; for (const p of Object.keys(sc.patterns)) last.scores[p] = techRound(sc.patterns[p].score); } }
  return true;
}

// 保存前に浮動小数を丸める（容量対策）。0.05860000000000032 のような値が1つ19文字を食い、
// metrics×patterns×history の全体では techAnalysis の容量を数割押し上げる（実測 2.3MB まで肥大した主因の一つ）。
// 小数4桁は表示・採点に影響しない精度（しきい値判定は %/倍率なので十分）。
function techRound(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : Math.round(v * 1e4) / 1e4;
  if (Array.isArray(v)) return v.map(techRound);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = techRound(v[k]); return o; }
  return v;
}
function saveTechResult(sec, result, today) {
  const key = priceKey(sec);
  const prev = store.data.techAnalysis[key] || {};
  const history = Array.isArray(prev.history) ? prev.history.filter(h => h.date !== today) : [];
  const scores = {}; for (const p of Object.keys(result.patterns)) scores[p] = result.patterns[p].score;
  history.push({ date: today, best: result.best, scores }); // 1日1点
  while (history.length > TECH_HISTORY_MAX) history.shift(); // 上限TECH_HISTORY_MAX点で剪定（§5・容量対策で104→52）
  store.data.techAnalysis[key] = techRound({
    ver: MEASURE_VER, measureVer: MEASURE_VER, scoreVer: SCORE_VER, dataDate: today,
    lastAnalyzed: today, best: result.best, bestTrend: result.bestTrend, bestContra: result.bestContra, trendTotal: result.trendTotal, contraTotal: result.contraTotal, totalScore: result.totalScore, contraScore: result.contraScore, warn: result.warn, patterns: result.patterns,
    metrics: result.metrics, levels: result.levels, marks: result.marks,
    evidence: result.evidence, lastClose: result.lastClose,
    ma200Pos: result.ma200Pos, ma200Slope: result.ma200Slope,
    rsi: result.rsi, rsiState: result.rsiState, macd: result.macd, macdCross: result.macdCross,
    dev52w: result.dev52w, above5: result.above5,
    history, _updatedAt: new Date().toISOString(),
  });
}
// テクニカル分析の合計サイズが大きくなりすぎたら知らせる（localStorage 約5MB・同期の基準で実質2倍使うため）。
// 1回の分析実行につき最大1度だけ。閾値超えでも勝手には消さない（消すかはマスタ→保存容量でユーザーが決める）。
const TECH_WARN_BYTES = 1200 * 1024;
let _techWarned = false;
function techSizeWatch() {
  if (_techWarned) return;
  const size = jsonSize(store.data.techAnalysis);
  if (size < TECH_WARN_BYTES) return;
  _techWarned = true;
  toast(`テクニカル分析の保存量が約${Math.round(size / 1024)}KBです。ブラウザの保存上限に近づくと保存できなくなります（マスタ→「保存容量（ブラウザ）」で整理できます）`, 8000);
}

// しきい値変更時: 保存済み metrics から採点のみ再実行（API再取得なし・§3.5）
function rescoreAll() {
  const th = anaThresholds();
  for (const key of Object.keys(store.data.techAnalysis)) {
    const r = store.data.techAnalysis[key];
    if (rescoreFromMetrics(r, th)) r.scoreVer = SCORE_VER;
  }
  store.save();
  renderAnalysis();
}

// しきい値パネル（値比較系。変更は即・再取得なし再採点）
function anaThresholdPanelHtml() {
  const th = anaThresholds();
  const fld = (grp, key, label, step) => `<label style="display:flex;flex-direction:column;font-size:11px;color:var(--muted);gap:2px">${esc(label)}<input type="number" step="${step || 1}" value="${th[grp][key]}" onchange="anaSetTh('${grp}','${key}',this.value)" style="width:84px"></label>`;
  return `<div class="panel" style="margin-top:8px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--panel)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <strong style="font-size:13px">しきい値（変更すると再取得なしで即再採点）</strong>
      <button class="btn" onclick="anaResetTh()">既定に戻す</button>
    </div>
    <div style="font-size:12px;font-weight:600;margin:4px 0">共通</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">${fld('common', 'breakPct', 'ブレイク%', 0.5)}${fld('common', 'volMult', '出来高倍率', 0.1)}</div>
    <div style="font-size:12px;font-weight:600;margin:8px 0 4px">カップウィズハンドル</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">${fld('cup', 'priorRisePct', '事前上昇%', 5)}${fld('cup', 'cupDepthMin', 'カップ深さ下限%', 1)}${fld('cup', 'cupDepthMax', 'カップ深さ上限%', 1)}${fld('cup', 'rightLeftRatio', '右/左高値', 0.01)}${fld('cup', 'handleDepthMin', 'ハンドル下限%', 1)}${fld('cup', 'handleDepthMax', 'ハンドル上限%', 1)}</div>
    <div style="font-size:12px;font-weight:600;margin:8px 0 4px">レンジブレイク</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">${fld('range', 'widthMin', '幅下限%', 1)}${fld('range', 'widthMax', '幅上限%', 1)}${fld('range', 'touchHigh', '上限接触回数', 1)}${fld('range', 'touchLow', '下限反発回数', 1)}${fld('range', 'inRangeRatio', '滞在率%', 1)}</div>
    <div style="font-size:12px;font-weight:600;margin:8px 0 4px">ダブルボトム</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">${fld('doubleBottom', 'priorDropPct', '事前下落%', 1)}${fld('doubleBottom', 'lowGapPct', '2安値の近さ%', 1)}${fld('doubleBottom', 'reboundPct', '中間反発%', 1)}</div>
    <div style="font-size:12px;font-weight:600;margin:8px 0 4px">アセンディングトライアングル</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">${fld('ascTriangle', 'flatTopPct', '上値水平%', 1)}${fld('ascTriangle', 'narrowing', '値幅縮小比', 0.05)}</div>
  </div>`;
}
function anaSetTh(grp, key, val) {
  const v = parseFloat(val); if (!isFinite(v)) return;
  store.data.settings ||= {}; store.data.settings.techThresholds ||= {};
  store.data.settings.techThresholds[grp] ||= {};
  store.data.settings.techThresholds[grp][key] = v;
  rescoreAll();
}
function anaResetTh() { if (store.data.settings) delete store.data.settings.techThresholds; rescoreAll(); }

// 銘柄詳細: ローソク足＋パターン基準（買いトリガー/失敗/ネックライン/抵抗・支持/MA/ピボット/高値・安値）を描画
let anaDetailKey = null;       // 現在ドロワーで開いている priceKey
let anaDetailRange = '1y';     // 表示レンジ（ズーム）: '6m'|'1y'|'3y'
async function openAnalysisDetail(market, ticker) {
  const sec = anaFindSec(market, ticker);
  if (!sec) return;
  const key = priceKey(sec);
  anaDetailKey = key; anaDetailRange = '1y'; anaDetailSide = 'contra'; // 逆張りを初期表示
  const r = store.data.techAnalysis[key];
  const rangeBtns = ['6m', '1y', '3y'].map(rg => `<button class="btn btn-sm" id="anaz-${rg}" onclick="anaSetDetailRange('${rg}')">${rg === '6m' ? '6ヶ月' : rg === '1y' ? '1年' : '3年'}</button>`).join('');
  showDrawer(calc.displayName(sec),
    `<div style="display:flex;gap:6px;margin-bottom:6px;align-items:center;flex-wrap:wrap"><span class="muted" style="font-size:12px">期間:</span>${rangeBtns}<span class="muted" style="font-size:11px;margin-left:auto">クリックで拡大</span></div>
     <div id="ana-detail-chart" class="muted" style="min-height:240px;cursor:zoom-in" title="クリックで拡大" onclick="enlargeDetailChart('ana-detail-chart', 'テクニカルチャート')">読み込み中…</div>
     <div id="ana-detail-evi" style="margin-top:10px"></div>`,
    '', `<span class="tag">${MARKET_LABEL[sec.market] || sec.market}</span><span class="muted">${esc(String(sec.ticker))}</span>`);
  const eviEl = document.getElementById('ana-detail-evi'); if (eviEl) eviEl.innerHTML = anaEvidenceHtml(r);
  let bars = _anaBars[key];
  if (!bars) {
    try { const res = await fetch(`/api/history?symbol=${encodeURIComponent(yahooSymbol(sec))}&range=3y&interval=1d&format=ohlcv`); const d = await res.json(); if (d.bars && d.bars.length) { bars = d.bars; _anaBars[key] = bars; } } catch (_) {}
  }
  anaDrawDetailChart();
}
function anaSetDetailRange(rg) { anaDetailRange = rg; anaDrawDetailChart(); }
function anaDrawDetailChart() {
  const el = document.getElementById('ana-detail-chart'); if (!el || !anaDetailKey) return;
  ['6m', '1y', '3y'].forEach(rg => { const b = document.getElementById('anaz-' + rg); if (b) b.classList.toggle('btn-primary', rg === anaDetailRange); });
  const key = anaDetailKey;
  const bars = _anaBars[key];
  if (!bars) { el.textContent = '価格履歴を取得できませんでした（ローカルは wrangler 起動時のみ取得可）。'; return; }
  const r = store.data.techAnalysis[key];
  // ズーム: 6m/1y は日足を末尾スライス、3y は週足（潰れ防止）。再取得なし。
  let disp, mas;
  if (anaDetailRange === '3y') {
    disp = TA.toWeekly(bars); const cl = disp.map(b => b.c);
    mas = [{ values: TA.sma(cl, 13), color: '#0ea5e9', label: '13週' }, { values: TA.sma(cl, 26), color: '#a855f7', label: '26週' }, { values: TA.sma(cl, 52), color: '#f59e0b', label: '52週' }];
  } else {
    const nDays = anaDetailRange === '6m' ? 126 : 252;
    disp = bars.slice(-nDays); const cl = disp.map(b => b.c);
    mas = [{ values: TA.sma(cl, 25), color: '#0ea5e9', label: '25日' }, { values: TA.sma(cl, 75), color: '#a855f7', label: '75日' }, { values: TA.sma(cl, 200), color: '#f59e0b', label: '200日' }];
  }
  const t0 = disp.length ? disp[0].t : 0, t1 = disp.length ? disp[disp.length - 1].t : 0;
  // チャートのパターン重ね描きは、ドロワーで選択中のサイド（順張り/逆張り）の最強シグナルに合わせる。
  // 該当サイドにパターンが無くても反対サイド(r.best)へはフォールバックしない＝順張りの買いシグナルを逆張りに出さない。
  const sb = r && (anaDetailSide === 'contra' ? r.bestContra : r.bestTrend);
  const best = sb ? sb.pattern : null;
  const lv = (r && r.levels && best) ? r.levels[best] : null;
  const mk = ((r && r.marks && best) ? r.marks[best] : []).filter(m => m.t >= t0 && m.t <= t1); // 範囲内のピボットのみ
  const hlines = [];
  if (lv) {
    if (lv.breakLevel != null) hlines.push({ price: lv.breakLevel, color: 'var(--green)', label: '買いトリガー' });
    if (lv.failLevel != null) hlines.push({ price: lv.failLevel, color: 'var(--red)', label: '失敗ライン' });
    if (lv.neckline != null) hlines.push({ price: lv.neckline, color: '#a855f7', label: 'ネックライン' });
    if (lv.resistance != null && lv.breakLevel == null) hlines.push({ price: lv.resistance, color: '#f59e0b', label: '抵抗' });
    if (lv.support != null) hlines.push({ price: lv.support, color: '#0ea5e9', label: '支持' });
  }
  const cur = (store.data.prices[key] || {}).price;
  if (cur != null) hlines.push({ price: cur, color: 'var(--muted)', label: '現在値', dash: '2 2' });
  // RSI / MACD サブチャート（表示中バーに整合した系列を計算）
  const dispCloses = disp.map(b => b.c);
  const rsiSeries = TA.rsi(dispCloses, 14);
  const macdSeries = TA.macd(dispCloses, 12, 26, 9);
  el.classList.remove('muted');
  el.innerHTML = TA.candleSVG(disp, { hlines, marks: mk, mas, title: best ? TA.PATTERN_LABEL[best] : (anaDetailSide === 'contra' ? '（逆張りパターン未検出）' : '（順張りパターン未検出）'), height: 340 })
    + TA.rsiSVG(rsiSeries)
    + TA.macdSVG(macdSeries);
}

// 詳細ドロワーの評価表示の切替: 'trend'=順張り / 'contra'=逆張り（既定）。トグルで切替。
let anaDetailSide = 'contra';
function anaSetDetailSide(s) {
  anaDetailSide = s;
  const evi = document.getElementById('ana-detail-evi');
  if (evi && anaDetailKey) evi.innerHTML = anaEvidenceHtml(store.data.techAnalysis[anaDetailKey]);
  anaDrawDetailChart(); // チャートの重ね描きも選択サイドの最強シグナルに合わせる
}
function anaEvidenceHtml(r) {
  const seg = `<div class="seg" style="margin-bottom:8px"><button class="${anaDetailSide !== 'contra' ? 'active' : ''}" onclick="anaSetDetailSide('trend')">順張り</button><button class="${anaDetailSide === 'contra' ? 'active' : ''}" onclick="anaSetDetailSide('contra')">逆張り</button></div>`;
  if (!r) return seg + '<div class="notice" style="margin:0">未分析です。一覧の「分析」ボタンで計算します。</div>';
  const scColor = (v) => v >= 80 ? 'var(--green)' : v >= 60 ? '#0ea5e9' : v >= 40 ? 'var(--amber)' : 'var(--muted)';
  const isContra = anaDetailSide === 'contra';
  const pats = isContra ? (TA.CONTRA_PATTERNS || []) : (TA.TREND_PATTERNS || []);
  const stLabel = isContra ? (TA.CONTRA_STATUS_LABEL || TA.STATUS_LABEL) : TA.STATUS_LABEL;
  // 各シグナル行: ホバーで説明（吞き出し）／クリックでそのシグナルだけのチャート拡大
  const mkRow = (p, lab, col) => { const x = r.patterns && r.patterns[p]; if (!x || x.status === 0) return ''; return `<tr class="ana-sig" data-pat="${p}" onmouseenter="anaTip(this)" onmouseleave="anaTipHide()" onclick="anaShowSignalChart('${p}')" style="cursor:pointer"><td class="l">${esc(TA.PATTERN_LABEL[p])} <span class="ana-sig-i">ⓘ</span></td><td style="text-align:right;color:${col || scColor(x.score)};font-weight:700">${x.score}</td><td>${esc((lab || stLabel)[x.status] || '')}</td></tr>`; };
  const sigRows = pats.map(p => mkRow(p)).filter(Boolean).join('') || `<tr><td colspan="3" class="muted">該当する${isContra ? '逆張り' : '順張り'}シグナルなし</td></tr>`;
  // 警戒: 逆張り側は「底抜け継続/底打ち失敗」系を主に、天井系(三尊/ダブルトップ)は副次で表示
  const warnList = isContra ? [...(TA.CONTRA_WARN_PATTERNS || []), ...(TA.WARN_PATTERNS || [])] : (TA.WARN_PATTERNS || []);
  const warnRows = warnList.map(p => mkRow(p, TA.STATUS_LABEL, 'var(--red)')).filter(Boolean).join('');
  const b = isContra ? r.bestContra : r.bestTrend;                 // 最強の単独パターン（名前表示用）
  const total = isContra ? (r.contraTotal != null ? r.contraTotal : (b ? b.score : null)) : (r.trendTotal != null ? r.trendTotal : (b ? b.score : null)); // 確認ゲート総合
  const strongTxt = b ? `最強シグナル: <b>${esc(TA.PATTERN_LABEL[b.pattern] || '')}</b> ${b.score}` : '最強シグナル: —';
  const ma = `200日線との位置: <b>${r.ma200Pos === 'above' ? '上' : r.ma200Pos === 'below' ? '下' : '—'}</b> / 傾き: <b>${r.ma200Slope === 'up' ? '上向き' : r.ma200Slope === 'down' ? '下向き' : '—'}</b>`;
  const rsiTxt = r.rsi != null ? `RSI <b style="color:${r.rsi <= 30 ? 'var(--green)' : r.rsi >= 70 ? 'var(--red)' : 'inherit'}">${Math.round(r.rsi)}</b>${r.rsiState === 'oversold' ? '（売られすぎ）' : r.rsiState === 'overbought' ? '（買われすぎ）' : ''}` : 'RSI —';
  const macdTxt = r.macdCross === 'golden' ? 'MACD <b style="color:var(--green)">ゴールデンクロス</b>' : r.macdCross === 'dead' ? 'MACD <b style="color:var(--red)">デッドクロス</b>' : 'MACD —';
  return `<div style="font-size:13px">
    ${seg}
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:6px;align-items:baseline">
      <span>${isContra ? '逆張り総合' : '順張り総合'}: <b style="color:${total == null ? 'var(--muted)' : scColor(total)};font-size:17px" title="確認ゲート方式。単独シグナルは最大55、独立した確認が増えるほど高得点（上限95）">${total == null ? '—' : total}</b></span>
      <span class="muted" style="font-size:12px">${strongTxt}</span>
    </div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:6px"><span>${rsiTxt}</span><span>${macdTxt}</span></div>
    <div style="margin-bottom:6px">${ma}</div>
    <table class="holdings dense" style="width:100%"><thead><tr><th class="l">${isContra ? '逆張りシグナル' : '順張りシグナル'}</th><th style="text-align:right">強さ</th><th>ステータス</th></tr></thead><tbody>${sigRows}</tbody></table>
    ${warnRows ? `<div style="margin-top:8px;color:var(--red);font-weight:600;font-size:12px">⚠ 警戒シグナル</div><table class="holdings dense" style="width:100%"><tbody>${warnRows}</tbody></table>` : ''}
    <div class="muted" style="font-size:11px;margin-top:6px">分析日: ${esc(r.lastAnalyzed || '—')}｜${isContra ? '逆張り＝下げ止まり/反転を拾う。緑線=回復/反転の目安／赤線=割れたら危険。' : '順張り＝上抜けで買い。緑線=買いトリガー／赤線=失敗ライン。'}各シグナルにカーソルで説明・クリックで拡大。</div>
  </div>`;
}

// 各シグナル（チャートパターン）の説明と「どう見るか」。ホバーの吞き出しに表示。
const PATTERN_INFO = {
  cup:        { d: 'U字の底（カップ）の後に小さな押し目（取っ手）を作る上昇前の形。', h: '取っ手の上限＝買いトリガーを出来高増で上抜けたら買い。カップが深すぎる/取っ手が浅すぎると失敗しやすい。' },
  range:      { d: '一定の値幅で横ばい（ボックス/レンジ）が続く保ち合い。', h: '上限（抵抗）を明確に上抜けたら買い。下限割れは失敗（撤退）。' },
  doubleBottom:{ d: 'ほぼ同じ水準の安値を2度つけるW字型の底。', h: '中間の戻り高値（ネックライン）を上抜けたら買い。2つ目の底が1つ目を大きく割ると失敗。' },
  ascTriangle:{ d: '高値は水平（抵抗）、安値が切り上がる三角保ち合い。買い圧力が強い形。', h: '水平の抵抗を上抜けたら買い。安値の切り上げが崩れると失敗。' },
  roundBottom:{ d: 'なだらかなお椀型の底。下落→横ばい→上昇へ緩やかに転換。', h: '徐々に上向き、直近の高値（抵抗）を抜けたら買い。完成に時間がかかる。' },
  invHS:      { d: '逆三尊（逆ヘッド&ショルダー）。安値が「肩・頭（最安）・肩」の底転換型。', h: 'ネックライン（2つの戻り高値を結ぶ線）を上抜けたら買い。' },
  flag:       { d: 'フラッグ/ペナント。急騰の後の短い小休止（旗）で再上昇の中継ぎ。', h: '小休止の上限を上抜けたら再上昇を狙う。調整が深い/長いと失敗。' },
  baseOnBase: { d: 'ベース・オン・ベース。上昇後の保ち合い（ベース）を階段状に重ねる強い形。', h: '新しいベースの上限を上抜けたら買い。' },
  undercutRally:{ d: 'アンダーカット&ラリー（逆張り）。前回安値を一時的に割った後、すぐ終値で回復し売り方の失敗になる形。', h: '安値割れ→終値回復＋出来高急増＋下ヒゲが揃うほど強い。割ったまま戻らない/出来高の伴う安値割れは危険。' },
  sellingClimax:{ d: 'セリングクライマックス（逆張り）。急落の最終局面で出来高急増・大陰線/長い下ヒゲが出て売りが一巡する形。', h: '当日買いは危険。出来高急増＋下ヒゲ＋以後その安値を割らない（安値維持）を確認してから。基本は監視強化。' },
  rsiDivergence:{ d: 'RSIダイバージェンス（逆張り）。株価は安値を更新しているのにRSIは安値を切り上げる＝下落の勢いが弱まっている形。', h: '単独では弱い。二番底・下ヒゲ・出来高減少と組み合わせて。RSIが30割れから改善しているほど良い。' },
  bollingerRecover:{ d: 'ボリンジャーバンド -2σ回復（逆張り）。-2σを下回った後、下に走らずバンド内へ戻る形。', h: '-2σ接触だけでは買わない（強い下落は-2σに沿って下げ続ける）。バンド内回復＋5日線回復＋RSI改善を確認。' },
  maDeviation:{ d: 'MA大幅下方乖離（逆張り候補抽出）。移動平均線から大きく下に離れた売られすぎ状態。', h: '単独では危険。下ヒゲ・出来高急増・5日線回復などの確認と組み合わせる。乖離が深いほど反発余地は大きいが落ちるナイフ注意。' },
  gapFill:{ d: '窓開け急落後の下げ止まり（逆張り）。悪材料で窓を開けて急落した後、売りが続かず安値を割らない/窓を埋める形。', h: '窓開け日の安値を割らない＋窓開け高値を回復で強い。ただし業績が構造的に悪化した場合はチャートだけで判断しない。' },
  volDryUp:{ d: '出来高減少を伴う下落（逆張りの補助）。株価は下がっているが出来高が細る＝売り圧力の鈍化。', h: '単独の買いシグナルではない。二番底・ラウンドボトムの補助条件として使う。' },
  hsTop:      { d: '三尊天井（ヘッド&ショルダー）。高値が「肩・頭・肩」の天井転換型。', h: 'ネックライン割れで下落警戒（利益確定/撤退）。買いではなく警戒シグナル。逆張りでは高値圏から下げ始めた銘柄を“早すぎる逆張り”で買わないための注意。' },
  doubleTop:  { d: 'ダブルトップ。ほぼ同じ水準の高値を2度つけるM字型の天井。', h: '中間の安値（ネックライン）割れで下落警戒。買いではなく警戒シグナル。' },
  newLowHighVol:{ d: '安値更新＋出来高増加（逆張り警戒）。直近安値を終値で割り、出来高が増えている＝売りが枯れず新規売りが出ている。', h: '逆張りで最も避けたい形。これが出たら買いは一旦見送り。特に決算/下方修正/悪材料後は危険。' },
  bearFlag:   { d: 'ベアフラッグ（逆張り警戒）。急落→小さな反発→再下落。小反発を底打ちと勘違いしやすい。', h: '反発の出来高が細く、反発レンジ下限を割ると二段下げになりやすい。買いを急がない。' },
  descTriangle:{ d: '下降三角持ち合いの下抜け（逆張り警戒）。支持線は水平だが高値が切り下がり、最後に支持線を割る形。', h: '支持で買いが入って見えても戻りが弱い＝底抜け。出来高を伴う支持割れは特に危険。買ってはいけない形。' },
};
// シグナル説明の吞き出し（body直下のfixed要素＝表の overflow に切られない）
function anaTip(el) {
  const info = PATTERN_INFO[el.dataset.pat]; if (!info) return;
  let tip = document.getElementById('ana-tip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'ana-tip'; document.body.appendChild(tip); }
  const label = TA.PATTERN_LABEL[el.dataset.pat] || '';
  tip.innerHTML = `<div class="ana-tip-h">${esc(label)}</div><div class="ana-tip-d">${esc(info.d)}</div><div class="ana-tip-r"><b>見方:</b> ${esc(info.h)}</div><div class="ana-tip-c">クリックでこのシグナルだけのチャートを拡大</div>`;
  tip.style.display = 'block';
  const r = el.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = Math.min(window.innerWidth - tw - 8, Math.max(8, r.left));
  let top = r.bottom + 8; if (top + th > window.innerHeight - 8) top = Math.max(8, r.top - th - 8); // 下に入らなければ上
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
}
function anaTipHide() { const t = document.getElementById('ana-tip'); if (t) t.style.display = 'none'; }
// クリックしたシグナルだけを描いた大きなチャートをオーバーレイ表示（ローソク足＋そのパターンのライン/印のみ。MA/RSI/MACDなし）
function anaShowSignalChart(pattern) {
  anaTipHide();
  const key = anaDetailKey; if (!key) return;
  const bars = _anaBars[key]; if (!bars || !bars.length) { toast('価格履歴がありません'); return; }
  const r = store.data.techAnalysis[key];
  const disp = anaDetailRange === '3y' ? TA.toWeekly(bars) : bars.slice(-(anaDetailRange === '6m' ? 126 : 252));
  const t0 = disp.length ? disp[0].t : 0, t1 = disp.length ? disp[disp.length - 1].t : 0;
  const lv = (r && r.levels) ? r.levels[pattern] : null;
  const mk = ((r && r.marks) ? (r.marks[pattern] || []) : []).filter(m => m.t >= t0 && m.t <= t1);
  const hlines = [];
  if (lv) {
    if (lv.breakLevel != null) hlines.push({ price: lv.breakLevel, color: 'var(--green)', label: '買いトリガー' });
    if (lv.failLevel != null) hlines.push({ price: lv.failLevel, color: 'var(--red)', label: '失敗ライン' });
    if (lv.neckline != null) hlines.push({ price: lv.neckline, color: '#a855f7', label: 'ネックライン' });
    if (lv.resistance != null && lv.breakLevel == null) hlines.push({ price: lv.resistance, color: '#f59e0b', label: '抵抗' });
    if (lv.support != null) hlines.push({ price: lv.support, color: '#0ea5e9', label: '支持' });
  }
  const cur = (store.data.prices[key] || {}).price;
  if (cur != null) hlines.push({ price: cur, color: 'var(--muted)', label: '現在値', dash: '2 2' });
  const x = r && r.patterns && r.patterns[pattern];
  const info = PATTERN_INFO[pattern] || { d: '', h: '' };
  // シグナルの根拠となる指標を描き分ける: ボリンジャー/MA乖離→帯やMAを重ね描き、RSIダイバージェンス→RSIサブチャート、
  // ラウンドボトム→MA、それ以外（パターン系）はローソク＋そのパターンのライン/印のみ。
  const dc = disp.map(b => b.c);
  let mas = [], sub = '';
  if (pattern === 'bollingerRecover') {
    const bb = TA.bollinger(dc, 20, 2);
    mas = [{ values: bb.upper, color: '#94a3b8', label: '+2σ' }, { values: bb.mid, color: '#a855f7', label: '20MA' }, { values: bb.lower, color: '#0ea5e9', label: '-2σ' }];
  } else if (pattern === 'maDeviation') {
    mas = [{ values: TA.sma(dc, 25), color: '#0ea5e9', label: '25日' }, { values: TA.sma(dc, 75), color: '#a855f7', label: '75日' }, { values: TA.sma(dc, 200), color: '#f59e0b', label: '200日' }];
  } else if (pattern === 'roundBottom') {
    mas = [{ values: TA.sma(dc, 25), color: '#0ea5e9', label: '25日' }, { values: TA.sma(dc, 75), color: '#a855f7', label: '75日' }];
  } else if (pattern === 'rsiDivergence') {
    sub = TA.rsiSVG(TA.rsi(dc, 14));   // 株価とRSIの安値を見比べる＝RSIサブチャートを併記
  }
  const chart = TA.candleSVG(disp, { hlines, marks: mk, mas, title: TA.PATTERN_LABEL[pattern] + (x ? `（強さ ${x.score} / ${TA.STATUS_LABEL[x.status]}）` : ''), height: 440 });
  const desc = `<div class="ana-sig-desc"><div>${esc(info.d)}</div><div style="margin-top:4px"><b>見方:</b> ${esc(info.h)}</div></div>`;
  anaShowOverlay(TA.PATTERN_LABEL[pattern], chart + sub + desc);
}
// 汎用: 拡大オーバーレイに任意HTMLを表示（enlargeDetailChart と同じ器）
function anaShowOverlay(title, innerHtml) {
  let ov = document.getElementById('chart-zoom-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'chart-zoom-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,24,40,.55);z-index:300;display:flex;align-items:center;justify-content:center;padding:24px;cursor:zoom-out';
    ov.onclick = () => ov.remove();
    document.body.appendChild(ov);
  }
  ov.innerHTML = `<div style="background:var(--panel);border-radius:14px;padding:20px;width:min(1400px,94vw);max-height:92vh;overflow:auto;box-shadow:var(--shadow-lg);cursor:default" onclick="event.stopPropagation()">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><strong style="font-size:15px">${esc(title)}</strong><button class="x-btn" onclick="document.getElementById('chart-zoom-overlay').remove()">&times;</button></div>
      <div style="width:100%">${innerHtml}</div>
    </div>`;
}

// ---------- 銘柄カルテ（市場+コードで1銘柄の全情報を集約＋取引/編集を1画面で） ----------
let karteCode = '';
let karteSelId = null;   // リストから明示選択した銘柄ID（同コードが日米にある場合の確定用）
try { const _k = JSON.parse(sessionStorage.getItem('sm_karte') || '{}'); if (typeof _k.code === 'string') karteCode = _k.code; if (_k.selId != null) karteSelId = _k.selId; } catch (_) {}
function saveKarteState() { try { sessionStorage.setItem('sm_karte', JSON.stringify({ code: karteCode, selId: karteSelId })); } catch (_) {} }
// コード/ティッカー/銘柄名（正規化込み）でカルテ対象候補を返す。完全一致→前方一致→部分一致の順。
function karteMatches(query) {
  const q = (query || '').trim(); if (!q) return [];
  const nq = searchNorm(q);
  const out = [];
  for (const s of store.data.securities) {
    if (s.market !== 'US' && s.market !== 'JP') continue;
    const tk = searchNorm(s.ticker || ''), nm = searchNorm(calc.displayName(s));
    let rank = -1;
    if (tk === nq) rank = 0;
    else if (nm === nq) rank = 1;
    else if (tk.startsWith(nq)) rank = 2;
    else if (nm.startsWith(nq)) rank = 3;
    else if (tk.includes(nq) || nm.includes(nq)) rank = 4;
    if (rank >= 0) out.push({ s, rank });
  }
  out.sort((a, b) => a.rank - b.rank || searchNorm(calc.displayName(a.s)).localeCompare(searchNorm(calc.displayName(b.s)), 'ja'));
  return out.map(x => x.s);
}
function karteLookup() {
  const inp = document.getElementById('karte-code'); if (inp) karteCode = inp.value.trim();
  karteSelId = null; saveKarteState(); renderTradeEntry();
}
function karteSelect(id) { karteSelId = id; const s = store.data.securities.find(x => x.id === id); if (s) karteCode = s.ticker || karteCode; saveKarteState(); renderTradeEntry(); }
// 銘柄IDから銘柄カルテを開く（詳細ドロワーの銘柄名クリック等）
function karteOpenSec(secId) {
  const s = store.data.securities.find(x => x.id === secId); if (!s) return;
  karteSelId = s.id; karteCode = s.ticker || calc.displayName(s); saveKarteState();
  closeModal(); closeDrawer(); go('trade');
}
function karteOpen(market, code) { const s = mktFindSec(code, market); karteCode = code; karteSelId = s ? s.id : null; saveKarteState(); go('trade'); }
function renderTradeEntry() {
  const q = karteCode.trim();
  const matches = q ? karteMatches(q) : [];
  let sec = null;
  if (karteSelId != null) sec = store.data.securities.find(s => s.id === karteSelId) || null;
  if (!sec && q) {
    const nq = searchNorm(q);
    const exact = matches.find(s => searchNorm(s.ticker || '') === nq || searchNorm(calc.displayName(s)) === nq);
    if (exact) sec = exact;
    else if (matches.length === 1) sec = matches[0];
  }
  const searchBar = `
    <div class="kt-search">
      <div class="field">
        <input id="karte-code" class="kt-code" type="text" value="${esc(karteCode)}" placeholder="コード・ティッカー・銘柄名（例: AAPL）" autocomplete="off"></div>
      <div class="field"><button class="btn btn-primary btn-sm" onclick="karteLookup()">${svgIcon('search', '')} 表示</button></div>
    </div>`;

  let body;
  if (!q) {
    body = '<div class="empty">証券コード・ティッカー・銘柄名のいずれかを入力して「表示」を押してください。</div>';
  } else if (sec) {
    body = karteCardHtml(sec);
  } else if (matches.length > 1) {
    const items = matches.slice(0, 30).map(s => `<button class="kt-cand" onclick="karteSelect(${s.id})"><span class="tk ${s.market.toLowerCase()}">${esc(s.ticker)}</span><span class="kt-cand-nm">${esc(calc.displayName(s))}</span><span class="tag ${s.market.toLowerCase()}">${MARKET_LABEL[s.market]}</span></button>`).join('');
    body = `<div class="kt-cands"><div class="muted" style="margin-bottom:6px">「${esc(q)}」に一致する銘柄が ${matches.length} 件あります。選択してください。</div>${items}</div>`;
  } else {
    body = `<div class="notice">「${esc(q)}」に一致する登録銘柄がありません。
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="openSecurityForm(null, 'JP', karteCode)">＋ 日本株として登録</button>
        <button class="btn btn-primary" onclick="openSecurityForm(null, 'US', karteCode)">＋ 米国株として登録</button>
      </div></div>`;
  }
  app.innerHTML = `<div class="kt">${searchBar}${body}</div>`;

  // Enter キーで表示
  const inp = document.getElementById('karte-code');
  if (inp) inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); karteLookup(); } };

  if (sec) {
    // チャート描画（詳細ドロワーと同じ仕組みを流用）。取引記録は上部ボタン→openTxnForm（onDoneで再描画）
    const ev = calc.evaluate(sec), price = calc.price(sec), lb = calc.lastBuyInfo(sec);
    _detailChartCtx = { sec, ev, price, lb };
    loadDetailChart(sec, ev, price, lb, detailChartRange);
  }
  scheduleFit();
}
// カルテ本体のHTML（1銘柄の集約表示＋取引入力フォーム）
function karteCardHtml(sec) {
  const ccy = MARKET_CCY[sec.market];
  const m = v => v == null ? '<span class="muted">—</span>' : ccy + num(v);
  const ev = calc.evaluate(sec);
  const th = calc.totalHolding(sec.id);
  const price = calc.price(sec);
  const rule = store.rule(sec.ruleId);
  const lb = calc.lastBuyInfo(sec);
  const held = th.qty > 0;
  const valJpy = calc.toJpy(sec.market, calc.valueOrCostNative(sec));
  const costJpyV = calc.toJpy(sec.market, calc.costNative(sec));
  const pnlJpyV = (valJpy != null && costJpyV != null) ? valJpy - costJpyV : null;
  const pnlPctN = calc.pnlPctNative(sec);
  const pr = store.data.prices[priceKey(sec)] || {};
  const dayPct = (pr.price != null && pr.prevClose) ? (pr.price - pr.prevClose) / pr.prevClose * 100 : null;
  const gradeTag = g => { if (!g) return '<span class="muted">—</span>'; const gm = (store.data.grades || []).find(x => x.grade === String(g).toUpperCase()); const st = gm && gm.color ? labelColorStyle(gm.color) : ''; return `<span class="grade grade-${esc(String(g).toLowerCase())}"${st ? ` style="${st}"` : ''}>${esc(g)}</span>`; };
  const starsFmt = n => n == null ? '<span class="muted">—</span>' : `<span style="color:var(--brass);letter-spacing:1px">${'★'.repeat(n)}<span style="color:var(--border-strong)">${'☆'.repeat(Math.max(0, 5 - n))}</span></span>`;
  // 判定
  const bhMode = (sec.baseHighMode || (rule && rule.baseHighMode) || '5y');
  const typeLabel = ev ? (ev.baseSource === '固定' ? '買い増し（買増固定値）'
    : ev.baseSource === '高値更新' ? '買い増し（高値更新→初回ルールで判定）'
    : ev.baseSource === '初回固定' ? '買い増し（初回基準に固定＝基準高値×初回下落率）'
    : ev.type === 'initial' ? '初回購入' : '買い増し') : '';
  const buyStatus = ev && ev.reached
    ? '<span class="tag" style="background:var(--green);color:#fff">買い増しOK</span>'
    : ev ? '<span class="tag">様子見</span>' : '';
  const row = (k, v, cls2) => `<div class="kt-row${cls2 ? ' ' + cls2 : ''}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const mcell = (k, v) => `<div class="cell"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  // ヘッダー右（株価・前日比の右）に出す保有サマリ。原通貨のみ（米国株=ドル / 日本株=円）
  const posCell = (k, v) => `<div class="kt-pos-cell"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  // 目標指標からの逆算株価（参考値・判定には未使用）。「目標値 / 株価」の形式で各1行。目標値が未入力の行は出さない
  // 株価は買い増しラインと同じ書式・同じ端数処理（floorBuyPrice は calc 側で適用済み）
  const targetRow = (label, tgt, tgtTxt, price) => tgt > 0
    ? row(label, `${tgtTxt} <span class="muted">/</span> ${price != null ? m(price) : '<span class="muted">—</span>'}`)
    : '';
  const targetRows = [
    targetRow('目標PER', sec.targetPer, num(sec.targetPer) + '倍', calc.targetPerPrice(sec)),
    targetRow('目標PBR', sec.targetPbr, num(sec.targetPbr) + '倍', calc.targetPbrPrice(sec)),
    targetRow('目標利回り', sec.targetYield, num(sec.targetYield) + '%', calc.targetYieldPrice(sec)),
  ].join('');
  // 買い増し判定ボックス
  const judgeBox = (ev ? [
    row('種別', typeLabel),
    row('基準値', (ev.baseSource === 'みなし' ? MINASHI : ev.baseSource === '固定' ? FIXED_MARK : '') + m(ev.base)),
    // 前回購入は「保有」ではなく判定の基準として読むもの。基準値の直下に置く
    row('前回購入', lb.price != null ? m(lb.price) + (lb.date ? ` <span class="muted">(${esc(lb.date)})</span>` : '') : '—'),
    row('買い増しライン', (ev.baseSource === '固定' ? FIXED_MARK : '') + m(ev.trigger), 'kt-hl'),
    row('現在値', m(price)),
    row('残り下落率', ev.remainingDropPct != null ? `<span class="${ev.reached ? 'neg' : ''}">${ev.remainingDropPct.toFixed(1)}%${ev.reached ? ' 到達' : ''}</span>` : '—'),
    rule ? row('適用ルール', `${esc(rule.name)} <span class="muted">(−${rule.initialDropPct}/−${rule.addonDropPct}%・${esc(BASE_HIGH_LABEL[bhMode] || bhMode)})</span>`) : '',
  ].join('') : '<div class="muted" style="font-size:12.5px">判定対象外（無効/価格未取得）</div>')
  // 目標指標の行は判定の成否と切り離す（判定対象外でもEPS等があれば逆算できるため）
  + targetRows;
  // 保有ボックス
  // 表示は保有株数がある口座だけ（全売却して0株になったロットは出さない）
  const hs = store.data.holdings.filter(h => h.securityId === sec.id && h.quantity > 1e-9);
  const holdAccRows = hs.length ? hs.map(h => row(`${esc(h.broker || '—')}/${esc(h.accountType || '—')}`, `${fmtQty(h.quantity, sec.market)} @ ${m(h.avgCost)}`)).join('') : '';
  const us = sec.market === 'US';
  // 原通貨（ドル）建ての評価額・取得額・評価損益（米国株のみ。円建ては両市場で表示）
  const valNative = calc.valueOrCostNative(sec);
  const costNativeV = calc.costNative(sec);
  const pnlNativeV = (valNative != null && costNativeV != null) ? valNative - costNativeV : null;
  const pctTxt = pnlPctN != null ? `（${signed(pnlPctN)}%）` : '';
  // 米国株は「ドル / 円」を列で横並び表示
  const row2 = (k, a, b) => `<div class="kt-row kt-2"><span class="k">${k}</span><span class="v">${a}</span><span class="v">${b}</span></div>`;
  const pnlCell = (v, fmt) => v != null ? `<span class="${cls(v)}">${fmt(v)}</span>` : '—';
  const usValueRows = [
    `<div class="kt-row kt-2 kt-2head"><span class="k"></span><span class="v">ドル</span><span class="v">円</span></div>`,
    row2('評価額', held ? m(valNative) : '—', held ? yen(valJpy) : '—'),
    row2('取得額', held ? m(costNativeV) : '—', held ? yen(costJpyV) : '—'),
    row2('評価損益', held ? pnlCell(pnlNativeV, m) : '—', held ? pnlCell(pnlJpyV, yen) : '—'),
    row('損益率', pnlPctN != null ? `<span class="${cls(pnlPctN)}">${signed(pnlPctN)}%</span>` : '—'),
  ];
  const jpValueRows = [
    row('評価額(円)', held ? yen(valJpy) : '—'),
    row('取得原価(円)', held ? yen(costJpyV) : '—'),
    row('評価損益(円)', held && pnlJpyV != null ? `<span class="${cls(pnlJpyV)}">${yen(pnlJpyV)}${pctTxt}</span>` : '—'),
  ];
  const holdBox = [
    // 合計の数量・平均取得単価は口座別の行と同じ「数量 @ 単価」書式で1行にまとめる。
    // 口座が1つだけなら口座別行と同じ内容になるので合計は出さない
    hs.length > 1 ? row('合計', held ? `${fmtQty(th.qty, sec.market)} @ ${m(th.avgCost)}` : '—') : '',
    holdAccRows || row('合計', '—'),
    ...(us ? usValueRows : jpValueRows),
    row('資産に占める割合', held ? karteRatioHtml(sec) : '—'),
    row('購入回数', `${calc.buyCount(sec)}回`),
  ].join('');
  // 評価・分析ボックス
  const analysisBox = [
    row('銘柄格付', gradeTag(sec.rating)),
    sec.starValuation != null ? row('バリュエーション', starsFmt(sec.starValuation)) : '',
    sec.starStrength != null ? row('事業の強さ', starsFmt(sec.starStrength)) : '',
    sec.starRisk != null ? row('リスク', starsFmt(sec.starRisk)) : '',
    row('カテゴリ', sec.category ? categoryTag(sec.category) : '—'),
    row('投資カテゴリ', sec.investCategory ? investCategoryTag(sec.investCategory) : '—'),
    row('銘柄ラベル', secLabels(sec).length ? labelsTag(sec) : '—'),
    // 推奨額＝カテゴリ別の推奨購入額（市場通貨）。都度 categoryAmountFor から算出（取込専用 recoAmount は参照しない）。
    row('推奨額', sec.category && store.categoryAmountFor(sec.category, sec.market) ? m(store.categoryAmountFor(sec.category, sec.market)) : '—'),
    row('優先順位/評価日', `${sec.priority != null ? sec.priority : '—'} / ${esc(sec.analysisDate || '—')}`),
    sec.analysisNote ? row('分析メモ', esc(sec.analysisNote)) : '',
    // 株価シナリオ（データがある行だけ）。現在値がどのレンジにいるかをタグで併記
    ...(['st', 'mt'].map(term => {
      const parts = [['Bear', '弱気'], ['Base', 'ベース'], ['Bull', '強気']]
        .map(([k, lb]) => { const f = scFmtRange(sec[term + k], sec.market); return f ? `<span class="muted">${lb}</span> ${f}` : null; }).filter(Boolean);
      if (!parts.length) return '';
      const pos = scPosition(sec, term);
      return row(`${term === 'st' ? '短期' : '中期'}シナリオ`, `${parts.join('　')}${pos ? `　<span class="tag" style="${labelColorStyle(pos.color)}">現在: ${esc(pos.label)}</span>` : ''}`);
    })),
    (sec.scenarioDate || sec.scenarioPrice != null) ? row('シナリオ分析日/株価', `${esc(sec.scenarioDate || '—')} / ${sec.scenarioPrice != null ? m(sec.scenarioPrice) : '—'}`) : '',
  ].join('');
  // ファンダボックス
  const fundBox = [
    row('セクター/業種', `${esc(calc.field(sec, 'sector') || '—')} / ${esc(calc.field(sec, 'industry') || '—')}`),
    row('PER / EPS', `${calc.per(sec) != null ? num(calc.per(sec)) : '—'} / ${calc.field(sec, 'eps') != null ? m(calc.field(sec, 'eps')) : '—'}`),
    // PBR / PSR（PSRは米国株のみ取得元がある。日本株は「—」）
    row('PBR / PSR', `${calc.pbr(sec) != null ? num(calc.pbr(sec)) : '—'} / ${calc.psr(sec) != null ? num(calc.psr(sec)) : '—'}`),
    row('配当/株 / 利回り', `${calc.field(sec, 'dividend') != null ? m(calc.field(sec, 'dividend')) : '—'} / ${calc.divYield(sec) != null ? calc.divYield(sec).toFixed(2) + '%' : '—'}`),
    row('時価総額', `${calc.marketCap(sec) != null ? fmtTurnover(calc.marketCap(sec) * 1e6, sec.market) : '—'}`),
    // 市場の時価総額1位まで何倍か（1位＝その市場のトップ銘柄。未取得なら「—」）
    (() => {
      const r = calc.capToTop(sec), t = topMarketCap(sec.market), f = capToTopFmt(sec.market, r);
      if (r == null) return row('時価総額1位まで', '—');
      return row('時価総額1位まで', r > 1
        ? `${esc(f.label)}（${f.pct}） <span class="muted">1位 ${esc(t.name || t.code)} ${fmtTurnover(t.cap, sec.market)}</span>`
        : '到達済み（1位）');
    })(),
    row('前回決算 / 次回決算', `${esc(earnPrevText(sec))} / ${esc(earnNextText(sec))}`),
    // 会社概要（株探の「会社情報→概要」。銘柄マスタ meta.summary にキャッシュ済みのものを表示）
    companySummary(sec) ? `<div class="kt-summary" title="${esc(companySummary(sec))}">${esc(companySummary(sec))}</div>` : '',
  ].join('');
  // 取引履歴ボックス
  const txns = store.data.transactions.filter(t => t.securityId === sec.id).sort((a, b) => (a.tradedAt < b.tradedAt ? 1 : -1));
  const txnBox = txns.length ? txns.map(t => `<div class="kt-txn-row">
      <span class="d">${esc(t.tradedAt || '—')} ${t.type === 'buy' ? '買' : t.type === 'sell' ? '売' : esc(t.type || '')}${t.ledgerOnly ? ' <span class="tag" title="保有に未反映">記録のみ</span>' : ''}${t.skipPrevBuy ? ' <span class="tag" title="前回購入として使わない">前回購入外</span>' : ''}</span>
      <span class="q">${fmtQty(t.quantity, sec.market)} @ ${m(t.price)}</span>
      <span class="acts"><button class="kt-ico" title="編集" onclick="editTxn(${t.id})">${svgIcon('edit', '')}</button><button class="kt-ico" title="削除" onclick="delTxn(${t.id})">&times;</button></span>
    </div>`).join('') : '<div class="muted" style="font-size:12.5px">取引履歴なし</div>';

  return `
    <div class="kt-head">
      <div class="kt-id">
        <div class="kt-name">${esc(calc.displayName(sec))}</div>
        <div class="kt-sub"><span class="tag ${sec.market.toLowerCase()}">${MARKET_LABEL[sec.market]}</span><span class="muted">${esc(sec.ticker)}</span>${gradeTag(sec.rating)}${sec.watch ? '<span class="tag watch">注意</span>' : ''}${buyStatus}</div>
      </div>
      <div class="kt-price-block">
        <div class="kt-price kt-kabu" onclick="window.open('${kabutanUrl(sec)}','_blank','noopener')" title="株探のチャートを開く">${m(price)}</div>
        <div class="kt-chg kt-kabu ${cls(dayPct)}" onclick="window.open('${kabutanUrl(sec)}','_blank','noopener')" title="株探のチャートを開く">${dayPct != null ? signed(dayPct) + '%' : '—'}<span class="muted"> 前日比</span></div>
      </div>
      <div class="kt-pos">
        ${posCell('取得額', held ? m(costNativeV) : '<span class="muted">—</span>')}
        ${posCell('評価額', held ? m(valNative) : '<span class="muted">—</span>')}
        ${posCell('損益率', held && pnlPctN != null ? `<span class="${cls(pnlPctN)}">${signed(pnlPctN)}%</span>` : '<span class="muted">—</span>')}
      </div>
      <div class="kt-actions">
        ${(function(){ const h = earnTopHtml(sec); return h ? `<span class="kt-earn">${h}</span>` : ''; })()}
        <button class="btn btn-sm btn-primary" onclick="openTxnForm(${sec.id}, undefined, { onDone: renderTradeEntry })">${svgIcon('trade', '')} 取引を記録</button>
        <button class="btn btn-sm" onclick="openSecNews(${sec.id})">${svgIcon('news', '')} ニュース・開示</button>
        <button class="btn btn-sm" onclick="openSecurityDetail(${sec.id})">${svgIcon('external', '')} 詳細</button>
        <button class="btn btn-sm" onclick="openSecurityForm(${sec.id})">${svgIcon('edit', '')} 編集</button>
        <button class="btn btn-sm" onclick="openHoldingsForm(${sec.id})">保有</button>
      </div>
    </div>
    <div class="kt-metrics">
      ${mcell('5年高値', m(calc.high5y(sec)))}
      ${mcell('52週高値', m(calc.high52w(sec)))}
      ${mcell('1年安値', m(calc.low1y(sec)))}
      ${mcell('3年安値', m(calc.low3y(sec)))}
      ${mcell('PER', calc.per(sec) != null ? num(calc.per(sec)) : '—')}
      ${mcell('配当利回り', calc.divYield(sec) != null ? calc.divYield(sec).toFixed(2) + '%' : '—')}
      ${mcell('時価総額', calc.marketCap(sec) != null ? fmtTurnover(calc.marketCap(sec) * 1e6, sec.market) : '—')}
    </div>
    <div class="kt-main">
      <div class="kt-box">
        <div class="kt-box-head"><h3>価格チャート（週足終値）</h3>
          <div class="seg" id="chart-range-seg">
            <button data-r="1y" class="${detailChartRange === '1y' ? 'active' : ''}" onclick="setDetailChartRange('1y')">1年</button>
            <button data-r="3y" class="${detailChartRange === '3y' ? 'active' : ''}" onclick="setDetailChartRange('3y')">3年</button>
            <button data-r="5y" class="${detailChartRange === '5y' ? 'active' : ''}" onclick="setDetailChartRange('5y')">5年</button>
          </div>
        </div>
        <div id="detail-chart" class="kt-chart muted" title="クリックで拡大" onclick="enlargeDetailChart()">読み込み中…</div>
        <p class="muted kt-chart-legend">青=終値 / 赤破線=買い増しライン / 緑破線=現在値 / 橙破線=前回購入（クリックで拡大）</p>
      </div>
      <div class="kt-col">
        <div class="kt-box"><h3>評価・分析</h3>${analysisBox}</div>
        <div class="kt-box"><h3>ファンダ</h3>${fundBox}</div>
        ${sec.memo ? `<div class="kt-box"><h3>メモ</h3><div class="kt-memo">${esc(sec.memo)}</div></div>` : ''}
      </div>
    </div>
    <div class="kt-tables">
      <div class="kt-box"><h3>買い増し判定</h3>${judgeBox}</div>
      <div class="kt-box"><h3>保有</h3>${holdBox}</div>
      <div class="kt-box kt-scroll"><h3>取引履歴</h3>${txnBox}</div>
    </div>`;
}

function openTxnForm(secId, presetType, opts = {}) {
  const { ledgerOnly: presetLedgerOnly = false, onDone = null, editTxn = null } = opts;
  const sec = store.data.securities.find(s => s.id === secId);
  const ccy = MARKET_CCY[sec.market];
  const e = editTxn || {};
  // 証券会社／口座の既定値: 編集時はその取引／新規時は実際の保有（数量が多いロット優先）に合わせる。
  // ＝売りの既定が保有と食い違って「数量が減らない」のを防ぐ。
  const hs = store.data.holdings.filter(h => h.securityId === secId);
  const held = hs.filter(h => h.quantity > 0).sort((a, b) => b.quantity - a.quantity)[0] || null; // 現時点で株数がある口座
  const primary = held || hs[0] || null;
  // 証券会社の既定: **現時点の保有株数が0なら**マスタの既定（市場ごと。初期値 JP=楽天 / US=Webull）。
  // 過去の取引履歴や数量0の保有レコードは見ない（全部売った銘柄を買い直すときは新しく買う先が既定になる）。
  const defBroker = editTxn ? e.broker : (held ? held.broker : defaultBrokerFor(sec.market));
  const defAcct = editTxn ? e.accountType : (primary ? primary.accountType : ACCOUNTS[0]);
  const typeSel = editTxn ? e.type : (presetType === 'sell' ? 'sell' : 'buy');
  const ledgerChecked = editTxn ? !!e.ledgerOnly : presetLedgerOnly;
  const skipPrevChecked = editTxn ? !!e.skipPrevBuy : false;
  const brokerOpts = BROKERS.map(b => `<option ${b === defBroker ? 'selected' : ''}>${b}</option>`).join('');
  const acctOpts = ACCOUNTS.map(a => `<option ${a === defAcct ? 'selected' : ''}>${a}</option>`).join('');
  showModal(`${editTxn ? '取引を編集' : '取引を記録'} — ${esc(sec.name || sec.ticker)}`, `
    <form id="txn-form">
      ${editTxn ? '' : secNavBar(secId, 'txn')}
      <div class="row">
        <div class="field"><label>種別</label>
          <select name="type" onchange="txnToggleBuyOnly(this)"><option value="buy" ${typeSel !== 'sell' ? 'selected' : ''}>買い</option><option value="sell" ${typeSel === 'sell' ? 'selected' : ''}>売り</option></select></div>
        <div class="field"><label>日付</label><input name="tradedAt" type="date" value="${e.tradedAt || today()}"></div>
      </div>
      <div class="row">
        <div class="field"><label>約定単価 (${ccy})</label><input name="price" type="number" step="any" value="${e.price ?? ''}" required></div>
        <div class="field"><label>数量（端株可）</label><input name="quantity" type="number" step="any" value="${e.quantity ?? ''}" required></div>
      </div>
      <div class="row">
        <div class="field"><label>証券会社</label><select name="broker">${brokerOpts}</select></div>
        <div class="field"><label>口座種別</label><select name="accountType">${acctOpts}</select></div>
      </div>
      ${sec.market === 'US' ? `
      <div class="row buy-only" style="display:${typeSel === 'sell' ? 'none' : ''}">
        <div class="field"><label title="手数料・税込。取得円に加算（買いのみ）。買い増し判定には未使用">受渡金額(円)（任意）</label>
          <input name="settleJpy" type="number" step="any" value="${e.settleJpy ?? ''}"></div>
      </div>` : ''}
      <div class="row buy-only" style="display:${typeSel === 'sell' ? 'none' : ''}">
        <div class="field"><label title="損出し買い直し用。前回売却した分の当初の購入額を入れると、今回の取得価額に上乗せして「購入額（本来）」に反映">前回売却分の元購入額 (${ccy})（任意）</label>
          <input name="prevSoldOrig" type="number" step="any"></div>
      </div>
      <label class="chk-row" title="保有数量・平均取得単価・取得円は変えない。前回購入日・購入回数・判定・取引サマリーには反映">
        <input name="ledgerOnly" type="checkbox" ${ledgerChecked ? 'checked' : ''}>
        <span>保有に反映しない（履歴のみ）</span>
      </label>
      <label class="chk-row buy-only" style="display:${typeSel === 'sell' ? 'none' : ''}" title="この取引の単価・日付を前回購入単価／前回購入日に使わない（次回購入トリガー・高値更新判定が動かない）。保有・購入回数には反映">
        <input name="skipPrevBuy" type="checkbox" ${skipPrevChecked ? 'checked' : ''}>
        <span>前回購入額を更新しない</span>
      </label>
      <div class="form-actions">
        ${editTxn ? `<button type="button" class="btn btn-danger" id="txn-del" style="margin-right:auto">削除</button>` : ''}
        <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
        <button type="submit" class="btn btn-primary">${editTxn ? '更新' : '記録'}</button>
      </div>
    </form>
    ${editTxn ? '' : txnHistoryHtml(secId)}`);
  const done = () => { closeModal(); if (typeof onDone === 'function') onDone(); else render(); };
  document.getElementById('txn-form').onsubmit = (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const settleJpy = f.settleJpy ? parseFloat(f.settleJpy.value) : NaN;
    const data = {
      securityId: secId, type: f.type.value,
      price: parseFloat(f.price.value), quantity: parseFloat(f.quantity.value),
      broker: f.broker.value, accountType: f.accountType.value, tradedAt: f.tradedAt.value,
      ...(f.ledgerOnly && f.ledgerOnly.checked ? { ledgerOnly: true } : {}),
      // 前回購入に使わない指定は買いのみ（売りは元々 lastBuyInfo の対象外）
      ...((f.type.value === 'buy' && f.skipPrevBuy && f.skipPrevBuy.checked) ? { skipPrevBuy: true } : {}),
      // 受渡金額(円)は買いのみ取得円に効く（売りは代金＝原価でないため取得円に使わない）
      ...((f.type.value === 'buy' && !isNaN(settleJpy)) ? { settleJpy } : {}),
    };
    if (editTxn) { store.updateTransaction(editTxn.id, data); toast('取引を更新しました'); }
    else {
      store.addTransaction(data);
      // 損出し買い直し: 前回売却分の元購入額を入れたら、その保有ロットの売却前購入額(origBuyAmount)へ
      // 「今回の取得価額(単価×数量) ＋ 入力額」を反映（購入額（本来）列に出る）。ledgerOnly買いは保有を作らないため対象外。
      const prevSold = f.prevSoldOrig ? parseFloat(f.prevSoldOrig.value) : NaN;
      if (data.type === 'buy' && !data.ledgerOnly && !isNaN(prevSold)) {
        const lot = store.data.holdings.find(h => h.securityId === secId && h.broker === data.broker && h.accountType === data.accountType);
        if (lot) { lot.origBuyAmount = lot.avgCost * lot.quantity + prevSold; store.save(); }
      }
    }
    done();
  };
  if (editTxn) {
    const del = document.getElementById('txn-del');
    if (del) del.onclick = () => { if (confirm('この取引を削除します。保有数量・平均取得単価も取り消されます。よろしいですか？')) { store.removeTransaction(editTxn.id); toast('取引を削除しました'); done(); } };
  }
}
// 取引フォーム: 種別=買いの時だけ「前回売却分の元購入額」欄を表示
function txnToggleBuyOnly(sel) {
  const show = sel.value === 'buy';
  document.querySelectorAll('#txn-form .buy-only').forEach(el => { el.style.display = show ? '' : 'none'; });
}
// 取引履歴の編集・削除（銘柄カルテの履歴行から）
// 取引履歴の一覧（編集・削除つき）。取引記録フォーム・銘柄詳細ドロワーで共用（カルテと同じ行UI）。
function txnHistoryHtml(secId, opts = {}) {
  const sec = store.data.securities.find(s => s.id === secId); if (!sec) return '';
  const ccy = MARKET_CCY[sec.market];
  const m = v => v == null ? '<span class="muted">—</span>' : ccy + num(v);
  const txns = store.data.transactions.filter(t => t.securityId === secId)
    .sort((a, b) => (a.tradedAt < b.tradedAt ? 1 : -1));
  const rows = txns.length ? txns.map(t => `<div class="kt-txn-row">
      <span class="d">${esc(t.tradedAt || '—')} ${t.type === 'buy' ? '買' : t.type === 'sell' ? '売' : esc(t.type || '')}${t.broker ? ' <span class="muted">' + esc(t.broker) + (t.accountType ? '/' + esc(t.accountType) : '') + '</span>' : ''}${t.ledgerOnly ? ' <span class="tag" title="保有に未反映">記録のみ</span>' : ''}${t.skipPrevBuy ? ' <span class="tag" title="前回購入として使わない">前回購入外</span>' : ''}</span>
      <span class="q">${fmtQty(t.quantity, sec.market)} @ ${m(t.price)}</span>
      <span class="acts"><button type="button" class="kt-ico" title="編集" onclick="editTxn(${t.id})">${svgIcon('edit', '')}</button><button type="button" class="kt-ico" title="削除" onclick="delTxn(${t.id})">&times;</button></span>
    </div>`).join('') : '<div class="muted" style="font-size:12.5px">取引履歴なし</div>';
  return `<fieldset class="form-group txn-hist"><legend>${opts.title || '取引履歴'}</legend><div class="txn-hist-list">${rows}</div></fieldset>`;
}
// 取引の編集・削除後の再描画。取引記録フォーム（モーダル）が開いていればその履歴も更新する。
function txnAfterChange(secId) {
  if (currentView === 'trade') renderTradeEntry(); else render();
  const box = document.querySelector('#modal-body .txn-hist');
  if (box && secId != null) box.outerHTML = txnHistoryHtml(secId);
}
function editTxn(id) {
  const t = store.data.transactions.find(x => x.id === id); if (!t) return;
  const fromTxnForm = !!document.querySelector('#modal-body #txn-form');
  openTxnForm(t.securityId, t.type, {
    editTxn: t,
    // 取引記録フォームから編集した時は、更新後にその銘柄のフォーム（履歴つき）へ戻す
    onDone: fromTxnForm
      ? () => { if (currentView === 'trade') renderTradeEntry(); else render(); openTxnForm(t.securityId); }
      : () => { if (currentView === 'trade') renderTradeEntry(); else render(); },
  });
}
function delTxn(id) {
  const t = store.data.transactions.find(x => x.id === id); if (!t) return;
  if (!confirm('この取引を削除します。保有数量・平均取得単価も取り消されます。よろしいですか？')) return;
  const secId = t.securityId;
  store.removeTransaction(id); toast('取引を削除しました');
  txnAfterChange(secId);
}

function openPriceInput(secId) {
  const sec = store.data.securities.find(s => s.id === secId);
  const p = store.data.prices[priceKey(sec)] || {};
  const ccy = MARKET_CCY[sec.market];
  showModal(`価格を入力 — ${esc(sec.name || sec.ticker)}`, `
    <form id="price-form">
      <div class="field"><label>現在値 (${ccy})</label><input name="price" type="number" step="any" value="${p.price ?? ''}" required></div>
      <div class="field"><label>前日終値 (${ccy})</label><input name="prevClose" type="number" step="any" value="${p.prevClose ?? ''}"></div>
      <div class="field"><label>5年高値（買い増し判定の基準・任意）</label><input name="high5y" type="number" step="any" value="${p.high5y ?? ''}"></div>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>`);
  document.getElementById('price-form').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    store.data.prices[priceKey(sec)] = {
      price: parseFloat(f.price.value),
      prevClose: f.prevClose.value ? parseFloat(f.prevClose.value) : null,
      prevCloseDate: f.prevClose.value ? prevBizDate() : null, // 手入力時の前日終値の引け日（近似）
      high5y: f.high5y.value ? parseFloat(f.high5y.value) : (p.high5y ?? null),
      high52w: p.high52w ?? null,
      low1y: p.low1y ?? null, low3y: p.low3y ?? null,
      low1yDate: p.low1yDate ?? null, low3yDate: p.low3yDate ?? null,
      fetchedAt: new Date().toISOString(),
    };
    store.save(); closeModal(); render();
  };
}

// カテゴリ: 追加 or 編集（全項目）
// カテゴリ別金額マスタ（モーダル表示。ランチャーから開く）
function openCategoryMaster() {
  const cats = [...store.data.categories].sort((a, b) => a.sortOrder - b.sortOrder);
  showModal('カテゴリ別 金額マスタ', `
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="btn btn-sm btn-primary" onclick="openCategoryEdit(null)">＋ カテゴリを追加</button></div>
    <div class="table-wrap"><table class="holdings dense">
      <thead><tr><th class="l">カテゴリ</th><th class="l">位置づけ</th><th>日本株(円)</th><th>米国株($)</th><th>並び順</th><th class="l"></th></tr></thead>
      <tbody>${cats.map(c => `<tr>
        <td class="l">${categoryTag(c.category)}</td><td class="l muted">${esc(c.label || '')}</td>
        <td>${yen(c.amountJpy)}</td><td>$${num(c.amountUsd)}</td><td>${c.sortOrder}</td>
        <td class="l nowrap"><button class="btn btn-sm" onclick="openCategoryEdit('${esc(c.category)}')">編集</button>
          <button class="btn btn-sm btn-danger" onclick="deleteCategory('${esc(c.category)}')">削除</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="muted" style="margin:8px 0 0">金額は価格に左右されない固定値（ビジネスモデル・財務で決定）。日本株(円)・米国株($)を個別に登録できます。</p>
    ${amountHistorySection()}
    <div class="form-actions"><button type="button" class="btn" onclick="closeModal()">閉じる</button></div>`, { wide: true });
}
// 銘柄格付けマスタ（S/A/B/C/D の表示色を管理。値・順位は固定なので色のみ編集）
function openGradeMaster() {
  const grades = store.data.grades || [];
  showModal('銘柄格付けマスタ', `
    <div class="table-wrap"><table class="holdings dense">
      <thead><tr><th class="l">格付け</th><th class="l">位置づけ</th><th class="l">表示色</th></tr></thead>
      <tbody>${grades.map(g => `<tr>
        <td class="l">${gradeBadge({ rating: g.grade })}</td>
        <td class="l muted">${esc(g.desc || '')}</td>
        <td class="l">${colorSwatchPicker('grade-' + g.grade, g.color)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="muted" style="margin:8px 0 0">格付け（S/A/B/C/D）の一覧・詳細での表示色です。色をタップすると即時に反映されます。値の追加・削除はできません。</p>
    <div class="form-actions"><button type="button" class="btn" onclick="closeModal()">閉じる</button></div>`, { wide: true });
  // 各行の色スウォッチ選択で即保存
  document.querySelectorAll('#modal-body .color-pick').forEach(wrap => {
    const grade = wrap.dataset.name.replace(/^grade-/, '');
    wrap.querySelectorAll('.cswatch').forEach(btn => btn.addEventListener('click', () => {
      const g = store.data.grades.find(x => x.grade === grade);
      if (g) { g.color = btn.dataset.key; g.updatedAt = store._now(); store.save(); render(); openGradeMaster(); }
    }));
  });
}
// 買い増しルールマスタ（モーダル表示。ランチャーから開く）
function openRuleMaster() {
  const rules = store.data.rules;
  showModal('買い増しルールマスタ', `
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="btn btn-sm btn-primary" onclick="openRuleEdit(null)">＋ ルールを追加</button></div>
    <div class="table-wrap"><table class="holdings dense">
      <thead><tr><th class="l">ルール名</th><th>初回 下落率</th><th>買い増し 下落率</th><th>基準高値</th><th>既定</th><th class="l"></th></tr></thead>
      <tbody>${rules.map(r => `<tr>
        <td class="l">${esc(r.name)}</td><td>−${r.initialDropPct}%</td><td>−${r.addonDropPct}%</td>
        <td>${BASE_HIGH_LABEL[r.baseHighMode] || r.baseHighMode}</td>
        <td>${r.isDefault ? '<span class="tag">既定</span>' : `<button class="btn btn-sm" onclick="setDefaultRule(${r.id})">既定に</button>`}</td>
        <td class="l nowrap"><button class="btn btn-sm" onclick="openRuleEdit(${r.id})">編集</button>
          ${rules.length > 1 ? `<button class="btn btn-sm btn-danger" onclick="deleteRule(${r.id})">削除</button>` : ''}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="muted" style="margin:8px 0 0">銘柄ごとの割当は各銘柄の「編集」から。未割当の銘柄は既定ルールを使用します。</p>
    <div class="form-actions"><button type="button" class="btn" onclick="closeModal()">閉じる</button></div>`, { wide: true });
}

function openCategoryEdit(category) {
  const c = category ? store.data.categories.find(x => x.category === category) : null;
  showModal(category ? `カテゴリを編集 — ${esc(category)}` : 'カテゴリを追加', `
    <form id="cat-form">
      <div class="field"><label>カテゴリ名</label><input name="category" value="${c ? esc(c.category) : ''}" required></div>
      <div class="field"><label>位置づけ（ラベル）</label><input name="label" value="${c ? esc(c.label || '') : ''}" placeholder="例: 文明のインフラ"></div>
      <div class="row">
        <div class="field"><label>日本株の金額（円）</label>
          <input name="amountJpy" type="number" step="1000" value="${c ? c.amountJpy : 0}" oninput="syncUsdAmount(this)" required></div>
        <div class="field"><label>米国株の金額（$）</label>
          <input name="amountUsd" type="number" step="any" value="${c ? c.amountUsd : 0}" required></div>
      </div>
      <div class="field"><label>並び順</label><input name="sortOrder" type="number" step="1" value="${c ? c.sortOrder : ''}" placeholder="自動"></div>
      <div class="field"><label>表示色（一覧のラベル色）</label>${colorSwatchPicker('color', c ? c.color : 'gray')}</div>
      <p class="muted">日本株の金額を入力すると、米国株は ÷100 を初期値として自動入力します（必要なら上書き可）。</p>
      <div class="form-actions">
        ${c ? `<button type="button" class="btn btn-danger" onclick="deleteCategory('${esc(c.category)}')">削除</button>` : ''}
        <button type="button" class="btn" onclick="openCategoryMaster()">キャンセル</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>`);
  // 米株欄は「JP÷100連動」を初期値とし、JP入力で自動更新。ユーザーが米株を直接編集したら連動停止
  const usdEl = document.querySelector('#cat-form [name=amountUsd]');
  if (usdEl) { usdEl.dataset.auto = '1'; usdEl.addEventListener('input', () => { usdEl.dataset.auto = '0'; }); }
  document.getElementById('cat-form').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const patch = {
      category: f.category.value.trim(), label: f.label.value.trim(),
      amountJpy: parseFloat(f.amountJpy.value) || 0,
      amountUsd: parseFloat(f.amountUsd.value) || 0,
      sortOrder: f.sortOrder.value ? parseInt(f.sortOrder.value, 10) : undefined,
      color: f.color.value || undefined,
    };
    if (c) store.updateCategory(category, patch);
    else store.addCategory(patch);
    render(); openCategoryMaster();
  };
}
// 金額マスタ編集: 日本株入力時に米国株を÷100で連動（米株を直接編集後は連動停止）
function syncUsdAmount(jpyEl) {
  const f = jpyEl.form;
  const usdEl = f.amountUsd;
  if (usdEl && usdEl.dataset.auto === '1') {
    const jpy = parseFloat(jpyEl.value);
    usdEl.value = isNaN(jpy) ? '' : jpy / 100;
  }
}
function deleteCategory(name) {
  if (confirm(`カテゴリ「${name}」を削除します。割当済みの銘柄は未設定になります。よろしいですか？`)) {
    store.removeCategory(name); render(); openCategoryMaster();
  }
}

// 投資カテゴリ（分析枠ラベル）マスタ。名前・表示色・並び順のみ（金額は持たない）。
function openInvestCategoryMaster() {
  const cats = [...store.data.investCategories].sort((a, b) => a.sortOrder - b.sortOrder);
  showModal('投資カテゴリ マスタ（分析枠ラベル）', `
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="btn btn-sm btn-primary" onclick="openInvestCategoryEdit(null)">＋ 投資カテゴリを追加</button></div>
    <div class="table-wrap"><table class="holdings dense">
      <thead><tr><th class="l">投資カテゴリ</th><th>並び順</th><th class="l"></th></tr></thead>
      <tbody>${cats.map(c => `<tr>
        <td class="l">${investCategoryTag(c.name)}</td><td>${c.sortOrder}</td>
        <td class="l nowrap"><button class="btn btn-sm" onclick="openInvestCategoryEdit('${esc(c.name)}')">編集</button>
          <button class="btn btn-sm btn-danger" onclick="deleteInvestCategory('${esc(c.name)}')">削除</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="muted" style="margin:8px 0 0">銘柄をどういう枠でとらえるか（高配当狙い・テーマ株など）のラベルです。金額とは無関係で、既存の「カテゴリ（投資額）」とは別管理です。</p>
    <div class="form-actions"><button type="button" class="btn" onclick="closeModal()">閉じる</button></div>`, { wide: true });
}
function openInvestCategoryEdit(name) {
  const c = name ? store.data.investCategories.find(x => x.name === name) : null;
  showModal(name ? `投資カテゴリを編集 — ${esc(name)}` : '投資カテゴリを追加', `
    <form id="invcat-form">
      <div class="field"><label>投資カテゴリ名</label><input name="name" value="${c ? esc(c.name) : ''}" placeholder="例: テーマ / 高配当" required></div>
      <div class="field"><label>並び順</label><input name="sortOrder" type="number" step="1" value="${c ? c.sortOrder : ''}" placeholder="自動"></div>
      <div class="field"><label>表示色（一覧のラベル色）</label>${colorSwatchPicker('color', c ? c.color : 'gray')}</div>
      <div class="form-actions">
        ${c ? `<button type="button" class="btn btn-danger" onclick="deleteInvestCategory('${esc(c.name)}')">削除</button>` : ''}
        <button type="button" class="btn" onclick="openInvestCategoryMaster()">キャンセル</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>`);
  document.getElementById('invcat-form').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const patch = {
      name: f.name.value.trim(),
      sortOrder: f.sortOrder.value ? parseInt(f.sortOrder.value, 10) : undefined,
      color: f.color.value || undefined,
    };
    if (!patch.name) { toast('投資カテゴリ名を入力してください'); return; }
    if (c) store.updateInvestCategory(name, patch);
    else store.addInvestCategory(patch);
    render(); openInvestCategoryMaster();
  };
}
function deleteInvestCategory(name) {
  if (confirm(`投資カテゴリ「${name}」を削除します。割当済みの銘柄は未設定になります。よろしいですか？`)) {
    store.removeInvestCategory(name); render(); openInvestCategoryMaster();
  }
}

// 銘柄ラベル（複数タグ）マスタ
function openLabelMaster() {
  const defs = [...(store.data.labelDefs || [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const cnt = (name) => store.data.securities.filter(s => secLabels(s).includes(name)).length;
  showModal('銘柄ラベル マスタ（投資テーマ・分類タグ）', `
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="btn btn-sm btn-primary" onclick="openLabelEdit(null)">＋ ラベルを追加</button></div>
    <div class="table-wrap"><table class="holdings dense">
      <thead><tr><th class="l">ラベル</th><th>並び順</th><th>付与銘柄</th><th class="l"></th></tr></thead>
      <tbody>${defs.length ? defs.map(c => `<tr>
        <td class="l">${labelsTagOne(c.name)}</td><td>${c.sortOrder}</td><td>${cnt(c.name)}件</td>
        <td class="l nowrap"><button class="btn btn-sm" onclick="openLabelEdit('${esc(c.name)}')">編集</button>
          <button class="btn btn-sm btn-danger" onclick="deleteLabelDef('${esc(c.name)}')">削除</button></td>
      </tr>`).join('') : '<tr><td class="l muted" colspan="4">ラベル未登録。「＋ ラベルを追加」か、銘柄編集の「銘柄ラベル」欄で新規追加できます。</td></tr>'}</tbody>
    </table></div>
    <p class="muted" style="margin:8px 0 0">1銘柄に複数付けられる投資テーマ/分類タグ（半導体・宇宙・防衛・高配当 など）。前提が崩れた時に、一覧の<strong>フィルタ「銘柄ラベル」</strong>で絞り込み→<strong>一括変更（ラベルを外す／付与）</strong>や選択→全売却で一括判断できます。</p>
    <div class="form-actions"><button type="button" class="btn" onclick="closeModal()">閉じる</button></div>`, { wide: true });
}
function openLabelEdit(name) {
  const c = name ? (store.data.labelDefs || []).find(x => x.name === name) : null;
  showModal(name ? `ラベルを編集 — ${esc(name)}` : 'ラベルを追加', `
    <form id="label-form">
      <div class="field"><label>ラベル名</label><input name="name" value="${c ? esc(c.name) : ''}" placeholder="例: 半導体 / 高配当" required></div>
      <div class="field"><label>並び順</label><input name="sortOrder" type="number" step="1" value="${c ? c.sortOrder : ''}" placeholder="自動"></div>
      <div class="field"><label>表示色（一覧のタグ色）</label>${colorSwatchPicker('color', c ? c.color : 'gray')}</div>
      <p class="muted" style="margin:0 0 4px">※取引サマリーからの除外は、レポートの取引サマリーの「🔎 絞り込み」でこのラベルを指定してください（登録は不要）。</p>
      <div class="form-actions">
        ${c ? `<button type="button" class="btn btn-danger" onclick="deleteLabelDef('${esc(c.name)}')">削除</button>` : ''}
        <button type="button" class="btn" onclick="openLabelMaster()">キャンセル</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>`);
  document.getElementById('label-form').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const patch = { name: f.name.value.trim(), sortOrder: f.sortOrder.value ? parseInt(f.sortOrder.value, 10) : undefined, color: f.color.value || undefined };
    if (!patch.name) { toast('ラベル名を入力してください'); return; }
    if (c) store.updateLabelDef(name, patch);
    else if ((store.data.labelDefs || []).some(x => x.name === patch.name)) { toast('同名のラベルが既にあります'); return; }
    else store.addLabelDef(patch);
    render(); openLabelMaster();
  };
}
function deleteLabelDef(name) {
  if (confirm(`ラベル「${name}」を削除します。付与済みの銘柄からも外れます。よろしいですか？`)) {
    store.removeLabelDef(name); render(); openLabelMaster();
  }
}

// ルール: 追加 or 編集
function openRuleEdit(id) {
  const r = id ? store.data.rules.find(x => x.id === id) : null;
  showModal(r ? `ルールを編集 — ${esc(r.name)}` : 'ルールを追加', `
    <form id="rule-form">
      <div class="field"><label>ルール名</label><input name="name" value="${r ? esc(r.name) : ''}" placeholder="例: 標準ルール" required></div>
      <div class="row">
        <div class="field"><label>初回 下落率(%)</label><input name="initial" type="number" step="any" value="${r ? r.initialDropPct : 40}" required></div>
        <div class="field"><label>買い増し 下落率(%)</label><input name="addon" type="number" step="any" value="${r ? r.addonDropPct : 20}" required></div>
      </div>
      <div class="field"><label>基準高値</label>
        <select name="mode">
          ${Object.entries(BASE_HIGH_LABEL).map(([v, lbl]) => `<option value="${v}" ${(r ? r.baseHighMode : '5y') === v ? 'selected' : ''}>${lbl}</option>`).join('')}
        </select></div>
      <label class="check" style="display:flex;align-items:center;gap:8px;margin:4px 0 8px">
        <input type="checkbox" name="highReset" ${r && r.highResetMode ? 'checked' : ''} style="width:auto">
        高値更新時は初回ルールで判定（前回購入単価ではなく「高値から初回下落率」で判定。最高値更新中の銘柄向け）
      </label>
      <div class="form-actions">
        <button type="button" class="btn" onclick="openRuleMaster()">キャンセル</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>`);
  document.getElementById('rule-form').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const patch = {
      name: f.name.value.trim(),
      initialDropPct: parseFloat(f.initial.value), addonDropPct: parseFloat(f.addon.value),
      baseHighMode: f.mode.value,
      highResetMode: !!(f.highReset && f.highReset.checked),
    };
    if (r) store.updateRule(id, patch);
    else store.addRule({ ...patch, isDefault: false });
    render(); openRuleMaster();
  };
}
function deleteRule(id) {
  const r = store.data.rules.find(x => x.id === id);
  if (confirm(`ルール「${r.name}」を削除します。割当済みの銘柄は既定ルールに戻ります。よろしいですか？`)) {
    store.removeRule(id); render(); openRuleMaster();
  }
}
function setDefaultRule(id) { store.setDefaultRule(id); render(); openRuleMaster(); }

// ---------- 一括取込（Excel/CSV 貼り付け） ----------
function openPasteImport(kind) {
  const isAnalysis = kind === 'analysis';
  const title = isAnalysis ? '銘柄分析結果を取込' : '保有株を取込';
  const sample = isAnalysis
    ? '評価日 / 銘柄名 / 総合評価 / 銘柄格付 / 買い時評価 / 推奨投資額 / カテゴリ / バリュエーション / 独自の強み / リスク / 備考 / 評価時点_購入優先順位'
    : 'ティッカー / 証券会社 / 口座種別 / 取得単価 / 数量 / 取得価額';
  showModal(title, `
    <form id="import-form">
      <p class="muted">Excelの該当シートを<strong>ヘッダ行ごと</strong>選択してコピーし、下に貼り付けてください（タブ/カンマ/マークダウン表対応）。</p>
      <div class="field"><label>対象市場（ティッカーで既存銘柄に紐づけ／新規作成時に使用）</label>
        <select name="market">${['US', 'JP'].map(x => `<option value="${x}">${MARKET_LABEL[x]}</option>`).join('')}</select></div>
      <label class="check"><input type="checkbox" name="create" checked> 未登録のティッカーは新規銘柄として作成する</label>
      <div class="field"><label>貼り付け（想定列: ${esc(sample)}）</label>
        <textarea name="data" rows="10" placeholder="ここに貼り付け" style="font-family:monospace;font-size:12px"></textarea></div>
      <div id="import-preview" class="muted"></div>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
        <button type="submit" class="btn btn-primary">取込を実行</button>
      </div>
    </form>`);
  const form = document.getElementById('import-form');
  const preview = document.getElementById('import-preview');
  const colmap = isAnalysis ? ANALYSIS_COLMAP : HOLDING_COLMAP;
  const renderPv = () => {
    const rows = parsePasted(form.data.value);
    if (!rows.length) { preview.innerHTML = ''; return; }
    if (rows.length < 2) { preview.innerHTML = '<span class="neg">ヘッダ行＋データ行が必要です（1行目に列名）。</span>'; return; }
    const idx = mapHeader(rows[0], colmap);
    const tIdx = idx.indexOf('ticker');
    if (tIdx < 0) { preview.innerHTML = '<span class="neg">「銘柄名/ティッカー（コード）」の列が見つかりません。1行目の列名を確認してください。</span>'; return; }
    const market = form.market.value;
    let bad = 0;
    for (let i = 1; i < rows.length; i++) { if (!validTicker((rows[i][tIdx] || '').trim(), market)) bad++; }
    // 取込対象の列（マッピングできた列）と、未対応の見出し（取込まれない列）を明示する。
    const mappedCols = idx.map((key, j) => ({ key, j, header: (rows[0][j] || '').trim() })).filter(c => c.key);
    const unmapped = rows[0].map((h, j) => ({ h: (h || '').trim(), j })).filter(c => !idx[c.j] && c.h !== '');
    // 取込まれる全列を表示（コード→形式は先頭固定、以降はマッピング順）
    const cols = [{ key: 'ticker', j: tIdx, header: IMPORT_FIELD_LABELS.ticker }, ...mappedCols.filter(c => c.key !== 'ticker')];
    const head = '<th class="l">形式</th>' + cols.map(c => `<th class="l">${esc(IMPORT_FIELD_LABELS[c.key] || c.key)}</th>`).join('');
    const body = rows.slice(1, 11).map(r => {
      const tk = (r[tIdx] || '').trim(); const ok = validTicker(tk, market);
      const cells = cols.map(c => `<td class="l ${c.key === 'ticker' ? '' : 'muted'}">${esc((r[c.j] || '').trim())}</td>`).join('');
      return `<tr><td class="l">${ok ? '<span class="pos">✓</span>' : '<span class="neg" title="形式NG（取込まれません）">⚠</span>'}</td>${cells}</tr>`;
    }).join('');
    const unmappedNote = unmapped.length
      ? `<div class="neg" style="margin:4px 0">未対応の列（取込まれません）: ${unmapped.map(c => esc(c.h)).join(' / ')}</div>`
      : '';
    preview.innerHTML = `<div style="margin:4px 0">取込予定 ${rows.length - 1}件${bad ? ` ／ <span class="neg">形式NG ${bad}件（取込まれません）</span>` : ''}（先頭${Math.min(10, rows.length - 1)}行プレビュー）</div>
      ${unmappedNote}
      <div class="table-wrap" style="max-height:240px;overflow:auto"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  };
  form.data.addEventListener('input', renderPv);
  form.market.addEventListener('change', renderPv);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const market = form.market.value;
    const create = form.create.checked;
    const result = isAnalysis
      ? await importAnalysis(form.data.value, market, create)
      : importHoldings(form.data.value, market, create);
    if (result.cancelled) { toast('取込を中止しました'); return; }
    closeModal();
    reportImport(result.touched, `取込完了: 更新 ${result.updated}件 / 新規 ${result.created}件${result.skipped ? ` / スキップ ${result.skipped}件` : ''}${result.badFmt ? ` / 形式NG ${result.badFmt}件は取込まず` : ''}${result.stale ? ` / 古い分析 ${result.stale}件は取込まず` : ''}`);
  };
}

// マークダウン表の区切り行か（|---|:--:| など）。セルがすべてダッシュ（任意で:）のみ
function isMdSepRow(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = t.split('|');
  return cells.length > 0 && cells.every(c => /^\s*:?-+:?\s*$/.test(c));
}
// マークダウンのセル装飾を除去（**太字** `コード` のアスタリスク/バッククォート、\| エスケープ）
function stripMdCell(c) {
  return c.replace(/\\\|/g, '|').replace(/[*`]/g, '').trim();
}
// マークダウン表の1行をセル配列へ（先頭・末尾の | を除去して | 区切り）
function splitMdRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(stripMdCell);
}
// 貼り付けテキストがマークダウン表か（区切り行がある、または全行が | を含みタブ無し）
function isMdTable(lines) {
  if (!lines.length) return false;
  return lines.some(isMdSepRow) || lines.every(l => l.includes('|') && !l.includes('\t'));
}
function parsePasted(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  if (isMdTable(lines)) return lines.filter(l => !isMdSepRow(l)).map(splitMdRow);
  return lines.map(l => l.includes('\t') ? l.split('\t') : l.split(','));
}
function parseStars(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  // 「★4」「4」など数字があればそれを採用
  const d = s.match(/\d+/);
  if (d) return parseInt(d[0], 10);
  // 「★★★★」のように★の数で表す場合
  const m = (s.match(/★/g) || []).length;
  return m || null;
}
function mapHeader(headerCells, colmap) {
  return headerCells.map(h => colmap[(h || '').trim()] || null);
}

// ティッカー/コードの形式チェック。日本株=半角英数4桁（7203/278A等）、米国株=大文字英字（.含む）最大6
function validTicker(ticker, market) {
  const t = (ticker || '').trim();
  if (!t) return false;
  if (market === 'JP') return /^[0-9A-Za-z]{4}$/.test(t);
  return /^[A-Z][A-Z.]{0,5}$/.test(t.toUpperCase());
}

async function importAnalysis(text, market, create) {
  const rows = parsePasted(text);
  if (rows.length < 2) return { updated: 0, created: 0, skipped: 0 };
  const idx = mapHeader(rows[0], ANALYSIS_COLMAP);
  // マスタ管理項目（格付3種・カテゴリ）の未登録値を確認・変換（中止で全取込キャンセル）
  const aPairs = [];
  for (let i = 1; i < rows.length; i++) {
    const r = {}; rows[i].forEach((cell, j) => { if (idx[j]) r[idx[j]] = (cell || '').trim(); });
    ['overallGrade', 'rating', 'buyGrade', 'category', 'investCategory'].forEach(fld => { if (r[fld]) aPairs.push({ field: fld, raw: r[fld] }); });
  }
  if (!(await ensureMasterConversions(aPairs))) return { cancelled: true };
  // マスタ項目の変換ヘルパ: 取込値があれば変換、スキップ/空は既存値を維持
  const cg = (rec, field, fb) => { const raw = (rec[field] || '').trim(); if (!raw) return fb || null; const cv = convMaster(field, raw); return cv === SKIP ? (fb || null) : cv; };
  let updated = 0, created = 0, skipped = 0, stale = 0, badFmt = 0; const touched = [];
  for (let i = 1; i < rows.length; i++) {
    const rec = {};
    rows[i].forEach((cell, j) => { if (idx[j]) rec[idx[j]] = (cell || '').trim(); });
    const ticker = (rec.ticker || '').trim();
    if (!ticker) { skipped++; continue; }
    if (!validTicker(ticker, market)) { badFmt++; continue; }   // 形式NG（日本株4桁/米国株大文字英字）は取込まない
    let sec = store.findSecurity(market, ticker);
    const isNew = !sec;
    if (!sec) {
      if (!create) { skipped++; continue; }
      sec = store.addSecurity({
        market, ticker: ticker.toUpperCase(), name: '', currency: market === 'US' ? 'USD' : 'JPY',
        assetClass: market === 'FUND' ? 'fund' : 'stock', enabled: market !== 'FUND', ruleId: store.defaultRule().id,
      });
    }
    const incDate = normDate(rec.analysisDate);
    if (isNew) created++; else updated++;
    const nf = (v) => (v && v.trim()) ? parseFloat(v) : null;
    const sf = (v, fb) => (v && v.trim()) || fb || null;
    // 評価項目（履歴 analyses へ積む対象）。空セルは含めない＝同一評価日の再取込でも既存値を消さない。
    const aFields = clean({
      overallGrade: cg(rec, 'overallGrade'),
      rating: cg(rec, 'rating'),
      buyGrade: cg(rec, 'buyGrade'),
      starValuation: parseStars(rec.starValuation),
      starStrength: parseStars(rec.starStrength),
      starRisk: parseStars(rec.starRisk),
      analysisNote: sf(rec.analysisNote),
      recoAmount: numClean(rec.recoAmount), // カンマ/通貨記号を除去してから数値化（parseFloatは"80,000"を80に切り落とすため）
      priority: (rec.priority && !isNaN(parseInt(rec.priority, 10))) ? parseInt(rec.priority, 10) : null,
    });
    const cat = cg(rec, 'category'); // シートの「カテゴリ」列→割り当てカテゴリ（取込値があれば更新・変換マスタ適用）
    // セクター/業種/時価総額/PER/EPS/配当はマスタ(meta)へ（自動取得項目と同じ置き場所）
    const metaPatch = clean({
      sector: sf(rec.sector), industry: sf(rec.industry),
      marketCap: nf(rec.marketCap), per: nf(rec.per), eps: nf(rec.eps), dividend: nf(rec.dividend),
    });
    if (Object.keys(metaPatch).length) store.setMeta(priceKey(sec), metaPatch);
    if (cat) store.updateSecurity(sec.id, { category: cat });
    const invCat = cg(rec, 'investCategory'); // シートの「投資カテゴリ」列→分析枠ラベル（取込値があれば更新・変換マスタ適用）
    if (invCat) store.updateSecurity(sec.id, { investCategory: invCat });
    if (rec.labels) { const ls = parseLabels(rec.labels); if (ls.length) { ensureLabelDefs(ls); store.updateSecurity(sec.id, { labels: ls }); } } // 銘柄ラベル（; 区切り）
    // 評価日があれば履歴へ upsert→最新を平置きへミラー。古い評価日も履歴として残す（旧実装の stale 破棄は廃止）。
    // 評価日が無い行は履歴化できないので平置きへ直接反映（最新ミラー相当）。
    // 買い増し予定額・推奨購入額はカテゴリ別金額マスタから算出するため、recoAmount からの自動設定は行わない。
    if (incDate) { store.upsertAnalysis(sec.id, incDate, cat ? { ...aFields, category: cat } : aFields); store.syncLatestAnalysis(sec.id); }
    else if (Object.keys(aFields).length) store.updateSecurity(sec.id, aFields);
    touched.push(sec);
  }
  _convSession = {};
  return { updated, created, skipped, stale, badFmt, touched };
}

function importHoldings(text, market, create) {
  const rows = parsePasted(text);
  if (rows.length < 2) return { updated: 0, created: 0, skipped: 0, touched: [] };
  const idx = mapHeader(rows[0], HOLDING_COLMAP);
  let updated = 0, created = 0, skipped = 0, badFmt = 0; const touched = [];
  for (let i = 1; i < rows.length; i++) {
    const rec = {};
    rows[i].forEach((cell, j) => { if (idx[j]) rec[idx[j]] = (cell || '').trim(); });
    const ticker = (rec.ticker || '').trim();
    if (!ticker) { skipped++; continue; }
    if (!validTicker(ticker, market)) { badFmt++; continue; }
    let sec = store.findSecurity(market, ticker);
    if (!sec) {
      if (!create) { skipped++; continue; }
      sec = store.addSecurity({
        market, ticker: ticker.toUpperCase(), name: '', currency: market === 'US' ? 'USD' : 'JPY',
        assetClass: market === 'FUND' ? 'fund' : 'stock', enabled: market !== 'FUND', ruleId: store.defaultRule().id,
      });
      created++;
    } else updated++;
    const qty = parseFloat(rec.quantity) || 0;
    let avgCost = parseFloat(rec.avgCost);
    if (isNaN(avgCost)) {
      const ac = parseFloat(rec.acquiredCost);
      avgCost = (!isNaN(ac) && qty > 0) ? ac / qty : 0;
    }
    store.setHolding(sec.id, (rec.broker || 'SBI').trim(), (rec.accountType || '特定').trim(), qty, avgCost, 'import');
    // セクター・業種はマスタ(meta)へ反映（自動取得項目と同じ置き場所）
    const metaPatch = {};
    if (rec.sector && rec.sector.trim()) metaPatch.sector = rec.sector.trim();
    if (rec.industry && rec.industry.trim()) metaPatch.industry = rec.industry.trim();
    if (Object.keys(metaPatch).length) store.setMeta(priceKey(sec), metaPatch);
    touched.push(sec);
  }
  return { updated, created, skipped, badFmt, touched };
}

// 取込後の共通レポート: 価格/情報を取得し、件数＋取得できなかったティッカー（一部だけ取れない時）を表示
function importedUnpriced(touched) {
  const hp = (s) => { const p = store.data.prices[priceKey(s)]; return p && p.price != null; };
  const priced = touched.filter(hp), unpriced = touched.filter(s => !hp(s));
  return (priced.length > 0 && unpriced.length > 0) ? unpriced.map(s => s.ticker) : [];
}
async function reportImport(touched, baseMsg) {
  touched = touched || [];
  if (touched.length) {
    busyShow('取込・価格取得中…しばらくお待ちください'); // 全画面の処理中表示（完了モーダルで上書き）
    const needPrice = touched.some(s => !(store.data.prices[priceKey(s)] && store.data.prices[priceKey(s)].price != null));
    try { await (needPrice ? api.refreshAll({ withHighs: store.data.lastHighsDate !== today() }) : api.refreshMeta(touched)); } catch (_) { /* 取得失敗は無視 */ }
    busyHide();
  }
  render();
  const bad = importedUnpriced(touched);
  // 完了をはっきり画面に出す（件数つきの結果モーダル）。トーストは見逃しやすいため。
  const warnHtml = bad.length
    ? `<div class="notice" style="margin-top:10px">⚠ 価格を取得できなかった銘柄が ${bad.length}件あります: <strong>${esc(bad.join(', '))}</strong><br>ティッカー/コードが正しいかご確認ください（米株は大文字英字・日本株は4桁）。</div>`
    : '';
  showModal('✓ 取込が完了しました', `
    <div class="ai-row" style="font-size:15px"><span class="muted">結果</span><span><strong>${esc(baseMsg)}</strong></span></div>
    ${warnHtml}
    <div class="form-actions"><button type="button" class="btn btn-primary" onclick="closeModal()">OK</button></div>`);
  toast(bad.length ? `取込完了（価格取得できず ${bad.length}件）` : '取込が完了しました', bad.length ? 9000 : 4000);
}

function normDate(v) {
  if (!v) return null;
  // "2026-01-27 00:00:00" → "2026-01-27"、"2026/1/27" → "2026-01-27"
  const m = String(v).match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

// ---------- 証券会社別 保有取込 ----------
// CSV1行をフィールド配列に（引用符・セル内カンマ対応）
function parseCsvText(text) {
  const rows = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch === '\r') { /* skip */ }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function numClean(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[,\s¥円$＄"']/g, ''));
  return isNaN(n) ? null : n;
}
function normAccount(s) {
  s = String(s || '');
  if (/NISA|ﾆｰｻ|ニーサ|つみたて/i.test(s)) return 'NISA';
  if (/一般/.test(s)) return '一般';
  return '特定';
}

// 取込フィールド設定（マスタ化）。CSVはヘッダ名、画面コピーはブロック内の数値の「何番目」(1始まり)
const DEFAULT_IMPORT_MAPPINGS = {
  'sbi-us':  { qtyPos: 1, avgCostPos: 2, evalJpyPos: 5, pnlJpyPos: 7 },      // 数量,取得単価,現在値,外貨評価額,円評価額,外貨損益,円損益
  'sbi-jp':  { ticker: '銘柄コード', quantity: '保有株数', avgCost: '取得単価' },
  'moomoo':  { ticker: 'コード', quantity: '数量', avgCost: '平均取得価額', account: '口座区分', currency: '通貨' },
  'rakuten': { kind: '種別', ticker: '銘柄コード・ティッカー', quantity: '保有数量', avgCost: '平均取得価額', account: '口座' },
  'monex-jp': { ticker: '銘柄コード', quantity: '保有数', avgCost: '平均取得単価', account: '口座区分' },
  'smbc':    { qtyPos: 1, avgCostPos: 3 },                                   // 数量, 時価, 平均取得単価, 評価額, 損益
};

// 各社パーサ: (text, map) → [{market, ticker, broker, account, quantity, avgCost}]
function parseSbiJpCsv(text, map) {
  const m = map || DEFAULT_IMPORT_MAPPINGS['sbi-jp'];
  const rows = parseCsvText(text); const out = []; let account = '特定', hi = null;
  for (const r of rows) {
    const joined = r.join('');
    if (/特定預り/.test(joined)) account = '特定';
    else if (/NISA/.test(joined)) account = 'NISA';
    if (r.includes(m.ticker)) { hi = r; continue; }
    if (!hi) continue;
    const code = (r[hi.indexOf(m.ticker)] || '').trim();
    if (!/^[0-9A-Za-z]{3,5}$/.test(code)) continue;
    const qty = numClean(r[hi.indexOf(m.quantity)]);
    const ac = numClean(r[hi.indexOf(m.avgCost)]);
    if (qty != null) out.push({ market: 'JP', ticker: code, broker: 'SBI', account, quantity: qty, avgCost: ac ?? 0 });
  }
  return out;
}
function parseMoomooCsv(text, map) {
  const m = map || DEFAULT_IMPORT_MAPPINGS['moomoo'];
  const rows = parseCsvText(text); if (rows.length < 2) return [];
  const h = rows[0], idx = (n) => h.indexOf(n); const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const code = (r[idx(m.ticker)] || '').trim(); if (!code) continue;
    const market = (r[idx(m.currency)] || '').trim() === 'USD' ? 'US' : 'JP';
    const qty = numClean(r[idx(m.quantity)]); const ac = numClean(r[idx(m.avgCost)]);
    if (qty != null) out.push({ market, ticker: code, broker: 'moomoo', account: normAccount(r[idx(m.account)]), quantity: qty, avgCost: ac ?? 0 });
  }
  return out;
}
// マネックス 日本株（端株含む）CSV: 銘柄コード/平均取得単価/保有数/口座区分
function parseMonexJpCsv(text, map) {
  const m = map || DEFAULT_IMPORT_MAPPINGS['monex-jp'];
  const rows = parseCsvText(text); if (rows.length < 2) return [];
  const h = rows[0], idx = (n) => h.indexOf(n); const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const code = (r[idx(m.ticker)] || '').trim(); if (!code) continue;
    const qty = numClean(r[idx(m.quantity)]); const ac = numClean(r[idx(m.avgCost)]);
    if (qty != null) out.push({ market: 'JP', ticker: code, broker: 'マネックス', account: normAccount(r[idx(m.account)]), quantity: qty, avgCost: ac ?? 0 });
  }
  return out;
}
function parseRakutenCsv(text, map) {
  const m = map || DEFAULT_IMPORT_MAPPINGS['rakuten'];
  const rows = parseCsvText(text); const out = []; let h = null;
  for (const r of rows) {
    if (r.includes(m.ticker)) { h = r; continue; }
    if (!h) continue;
    const idx = (n) => h.indexOf(n);
    const kind = (r[idx(m.kind)] || '').trim();
    const code = (r[idx(m.ticker)] || '').trim(); if (!code) continue;
    let market; if (/国内株式/.test(kind)) market = 'JP'; else if (/米国株式/.test(kind)) market = 'US'; else continue; // 投信等skip
    const qty = numClean(r[idx(m.quantity)]); const ac = numClean(r[idx(m.avgCost)]);
    if (qty != null) out.push({ market, ticker: code, broker: '楽天', account: normAccount(r[idx(m.account)]), quantity: qty, avgCost: ac ?? 0 });
  }
  return out;
}
// SBI 米国株「保有証券一覧」画面のコピーを解析。
// 1銘柄ブロック = 銘柄名 → 「ティッカー 取引所」 → 数値7つ → 買付/売却/積立。
// 数値の並び: [0]保有数量 [1]取得単価 [2]現在値 [3]外貨建評価額 [4]円換算評価額 [5]外貨建評価損益 [6]円換算評価損益
// 取得円(acqJpy) = 円換算評価額 − 円換算評価損益（SEC-59。xlsm と同じ算出）。
function parseSbiUsScreen(text, map) {
  const m = map || DEFAULT_IMPORT_MAPPINGS['sbi-us'];
  const qp = (m.qtyPos || 1) - 1, ap = (m.avgCostPos || 2) - 1;
  const ej = (m.evalJpyPos || 5) - 1, pj = (m.pnlJpyPos || 7) - 1;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // ティッカー行: 「AAPL NASDAQ」「V NYSE」「QLD NYSEArca」「VNM CBOE」等（英字ティッカー＋取引所）
  const tickerRe = /^([A-Z][A-Z.]{0,5})\s+[A-Za-z]{2,10}$/;
  const isStop = (s) => /^(買付|売却|積立|現買|現売)$/.test(s);
  const out = []; let account = '特定', i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/特定預り/.test(ln)) { account = '特定'; i++; continue; }
    if (/NISA預り/.test(ln)) { account = 'NISA'; i++; continue; }
    const tm = ln.match(tickerRe);
    if (tm) {
      const ticker = tm[1]; const nums = []; let j = i + 1;
      while (j < lines.length && !tickerRe.test(lines[j]) && !/預り/.test(lines[j])) {
        if (isStop(lines[j])) break;            // 買付/売却/積立でブロック終端
        const n = numClean(lines[j]); if (n != null) nums.push(n);
        j++;
      }
      if (nums.length > qp && nums.length > ap) {
        const row = { market: 'US', ticker, broker: 'SBI', account, quantity: nums[qp], avgCost: nums[ap] };
        if (nums.length > ej && nums.length > pj) {
          const acq = nums[ej] - nums[pj];      // 円換算評価額 − 円換算評価損益 = 取得円
          if (!isNaN(acq)) row.acqJpy = acq;
        }
        out.push(row);
      }
      i = j; continue;
    }
    i++;
  }
  return out;
}
function parseSmbcScreen(text, map) {
  const m = map || DEFAULT_IMPORT_MAPPINGS['smbc'];
  const qp = (m.qtyPos || 1) - 1, ap = (m.avgCostPos || 3) - 1;
  const codeRe = /[（(]([0-9A-Za-z]+)[）)]/;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = []; let i = 0;
  while (i < lines.length) {
    const cm = lines[i].match(codeRe);
    if (!cm) { i++; continue; }
    const code = cm[1];
    const nums = []; let account = '特定', j = i + 1;
    while (j < lines.length && !codeRe.test(lines[j])) {
      for (const cell of lines[j].split('\t')) {
        const t = cell.trim();
        if (/特定|NISA|一般/.test(t)) account = normAccount(t);
        if (/買付|売却|単元株化/.test(t)) continue;
        const n = numClean(t); if (n != null) nums.push(n);
      }
      j++;
    }
    if (nums.length > qp && nums.length > ap) out.push({ market: 'JP', ticker: code, broker: 'SMBC日興', account, quantity: nums[qp], avgCost: nums[ap] });
    i = j;
  }
  return out;
}
// 汎用入出力の列（日本語ラベル↔内部キー）。分析結果（評価/格付/★/備考/優先順位/評価日）は対象外
// ===== 取込：マスタ管理項目の変換（未登録値はモーダルで確認・変換マスタで次回自動）=====
// ドメイン定義。fields=このドメインに属する銘柄フィールド。values=マスタの正規値一覧。canAdd=新規追加可。
const IMPORT_DOMAINS = {
  category:   { label: 'カテゴリ',     fields: ['category'], canAdd: true,  values: () => store.data.categories.map(c => c.category) },
  investCategory: { label: '投資カテゴリ', fields: ['investCategory'], canAdd: true, values: () => store.data.investCategories.map(c => c.name) },
  grade:      { label: '格付(S〜D)',   fields: ['overallGrade', 'rating', 'buyGrade'], canAdd: false, values: () => ['S', 'A', 'B', 'C', 'D'] },
  detailType: { label: '詳細種別',     fields: ['detailType'], canAdd: false, values: () => ['個別株', 'ETF'] },
  rule:       { label: '買い増しルール', fields: ['ruleName'], canAdd: false, values: () => store.data.rules.map(r => r.name) },
};
const FIELD_DOMAIN = {};
Object.entries(IMPORT_DOMAINS).forEach(([d, def]) => def.fields.forEach(f => { FIELD_DOMAIN[f] = d; }));
const SKIP = '__skip__';
function normKey(s) { return String(s == null ? '' : s).normalize('NFKC').trim(); }
let _convSession = {}; // 今回の取込限定の変換（覚えない選択）。{domain: {normRaw: value}}
// 取込値を解決: {status:'ok',value} / {status:'skip'} / {status:'unmatched'}
function resolveMaster(domain, raw) {
  const r = normKey(raw);
  if (!r) return { status: 'ok', value: raw };
  const def = IMPORT_DOMAINS[domain]; if (!def) return { status: 'ok', value: raw };
  const hit = def.values().find(v => normKey(v) === r); // 表記ゆれ吸収（NFKC・trim）
  if (hit) return { status: 'ok', value: hit };
  const sess = (_convSession[domain] || {})[r];
  if (sess === SKIP) return { status: 'skip' };
  if (sess != null) return { status: 'ok', value: sess };
  const al = (store.data.importAliases[domain] || {})[r];
  if (al === SKIP) return { status: 'skip' };
  if (al != null) return { status: 'ok', value: al };
  return { status: 'unmatched' };
}
// フィールド値を変換。マスタ対象外/空はそのまま。skip は SKIP を返す。
function convMaster(field, raw) {
  const domain = FIELD_DOMAIN[field]; if (!domain) return raw;
  const res = resolveMaster(domain, raw);
  return res.status === 'skip' ? SKIP : res.value;
}
// pairs=[{field, raw}]。未登録値を集めモーダルで確認 → _convSession/aliases に反映。中止で false。
function ensureMasterConversions(pairs) {
  const unmatched = new Map(); // domain normRaw -> {domain, raw, count}
  for (const { field, raw } of pairs) {
    if (raw == null || raw === '') continue;
    const domain = FIELD_DOMAIN[field]; if (!domain) continue;
    if (resolveMaster(domain, raw).status !== 'unmatched') continue;
    const k = domain + ' ' + normKey(raw);
    if (!unmatched.has(k)) unmatched.set(k, { domain, raw, count: 0 });
    unmatched.get(k).count++;
  }
  if (!unmatched.size) return Promise.resolve(true);
  return new Promise(resolve => openImportConvertModal([...unmatched.values()], (decisions) => {
    if (!decisions) { resolve(false); return; }
    for (const it of [...unmatched.values()]) {
      const d = decisions[it.domain + ' ' + normKey(it.raw)];
      if (!d) continue;
      (_convSession[it.domain] ||= {})[normKey(it.raw)] = d.value;
      if (d.remember) store.setAlias(it.domain, normKey(it.raw), d.value);
    }
    resolve(true);
  }));
}
function openImportConvertModal(list, cb) {
  const rows = list.map((it, i) => {
    const def = IMPORT_DOMAINS[it.domain];
    const opts = def.values().map(v => `<option value="m:${esc(v)}">${esc(v)} に変換</option>`).join('')
      + (def.canAdd ? `<option value="__add__">＋「${esc(it.raw)}」を新規マスタに追加</option>` : '')
      + `<option value="__skip__">取り込まない（スキップ）</option>`;
    return `<div class="ai-row" style="gap:10px"><span class="muted">${esc(def.label)}「<strong>${esc(it.raw)}</strong>」<span style="font-size:11px">(${it.count}件)</span></span>
      <select id="icv-${i}" style="min-width:180px">${opts}</select></div>`;
  }).join('');
  showModal('取込：未登録の値の変換', `
    <p class="muted" style="margin:0 0 10px">マスタに無い値が見つかりました。各値の変換先を選んでください。「中止」を押すと1件も取り込まず、修正して取り込み直せます。</p>
    ${rows}
    <label style="display:flex;align-items:center;gap:6px;margin-top:12px"><input type="checkbox" id="icv-remember" checked> この対応を覚えて次回から自動変換する（取込変換マスタに保存）</label>
    <div class="form-actions">
      <button type="button" class="btn btn-danger" onclick="__icvResolve(false)">取り込まない（中止）</button>
      <button type="button" class="btn btn-primary" onclick="__icvResolve(true)">この内容で取り込む</button>
    </div>`);
  window.__icvResolve = (ok) => {
    if (!ok) { closeModal(); cb(null); return; }
    const remember = document.getElementById('icv-remember').checked;
    const decisions = {};
    list.forEach((it, i) => {
      const sel = document.getElementById('icv-' + i).value;
      let value;
      if (sel === '__skip__') value = SKIP;
      else if (sel === '__add__') { addMasterValue(it.domain, it.raw); value = it.raw; }
      else value = sel.slice(2); // strip 'm:'
      decisions[it.domain + ' ' + normKey(it.raw)] = { value, remember };
    });
    closeModal(); cb(decisions);
  };
}
function addMasterValue(domain, raw) {
  if (domain === 'category' && !store.data.categories.find(c => c.category === raw)) {
    store.addCategory({ category: raw, label: '', amountJpy: 0, amountUsd: 0 });
  }
  if (domain === 'investCategory' && !store.data.investCategories.find(c => c.name === raw)) {
    store.addInvestCategory({ name: raw, color: 'gray' });
  }
}
// 取込変換マスタの閲覧・削除
function openImportAliasMaster() {
  const al = store.data.importAliases || {};
  const sections = Object.entries(IMPORT_DOMAINS).map(([domain, def]) => {
    const entries = Object.entries(al[domain] || {});
    const rows = entries.length ? entries.map(([raw, val]) =>
      `<div class="ai-row"><span>「${esc(raw)}」 → ${val === SKIP ? '<span class="muted">取り込まない（スキップ）</span>' : '<strong>' + esc(val) + '</strong>'}</span>
        <button class="btn btn-sm btn-danger" onclick="deleteImportAlias('${esc(domain)}', '${esc(raw)}')">削除</button></div>`).join('')
      : '<div class="muted">対応なし</div>';
    return `<div style="margin-bottom:14px"><div class="grp-label">${esc(def.label)}</div>${rows}</div>`;
  }).join('');
  showModal('取込変換マスタ', `
    <p class="muted" style="margin:0 0 10px">取込時にマスタへ変換した対応の一覧です。削除すると次回取込時に再度確認されます。</p>
    ${sections}
    <div class="form-actions"><button type="button" class="btn btn-primary" onclick="closeModal()">閉じる</button></div>`);
}
function deleteImportAlias(domain, raw) {
  const m = store.data.importAliases[domain]; if (!m) return;
  delete m[raw]; store.save();
  openImportAliasMaster();
}

const GENERIC_MAP = {
  'ティッカー': 'ticker', 'コード': 'ticker', '市場': 'market', '証券会社': 'broker', '口座': 'account', '口座種別': 'account',
  '数量': 'quantity', '取得単価': 'avgCost', '平均取得単価': 'avgCost',
  '前回購入価格': 'prevBuyPrice', '前回購入日': 'prevBuyDate', '基準高値モード': 'baseHighMode', '手動基準高値': 'baseHighManual',
  '買増固定値': 'fixedBuyPrice', '次回購入固定値': 'fixedBuyPrice',
  '買増を初回基準': 'addonFromHigh', '買い増し初回基準': 'addonFromHigh',
  'ルール': 'ruleName', '買い増しルール': 'ruleName', 'カテゴリ': 'category', '詳細種別': 'detailType',
  '投資カテゴリ': 'investCategory', '銘柄ラベル': 'labels', 'ラベル': 'labels',
  '1回購入額': 'buyAmount', '買い増し予定額': 'buyAmount', '購入回数': 'buyCount', '判定対象': 'enabled', 'ウォッチ': 'watch',
  '元本売却済み': 'principalSold', '売却済み元本額': 'principalSoldAmount',
  '売却前購入額': 'origBuyAmount', 'メモ': 'memo',
  '目標PER': 'targetPer', '目標PBR': 'targetPbr', '目標配当利回り': 'targetYield', '目標利回り': 'targetYield',
  // 株価シナリオ分析（短期・中期×弱気/ベース/強気の予想レンジ）
  'シナリオ分析日': 'scenarioDate', '分析時株価': 'scenarioPrice',
  '短期弱気': 'stBear', '短期ベース': 'stBase', '短期強気': 'stBull',
  '中期弱気': 'mtBear', '中期ベース': 'mtBase', '中期強気': 'mtBull',
};
// 標準レイアウトの列。exportGeneric はこの列名→GENERIC_MAP でフィールドキーを引き、genericFieldValue で値を出す（位置合わせ不要）。列を足すなら GENERIC_MAP にも登録。
const GENERIC_HEADER =['ティッカー', '市場', '証券会社', '口座', '数量', '取得単価', '前回購入価格', '前回購入日', '基準高値モード', '手動基準高値', '買増固定値', '買増を初回基準', 'ルール', 'カテゴリ', '1回購入額', '購入回数', '判定対象', 'ウォッチ', '詳細種別', '元本売却済み', '売却済み元本額', '売却前購入額', 'メモ', '投資カテゴリ', '銘柄ラベル', '目標PER', '目標PBR', '目標配当利回り', 'シナリオ分析日', '分析時株価', '短期弱気', '短期ベース', '短期強気', '中期弱気', '中期ベース', '中期強気'];
function normBaseHighMode(s) {
  s = String(s || '').trim();
  if (!s) return null;
  if (/5y|5年/.test(s)) return '5y';
  if (/52w|52週/.test(s)) return '52w';
  if (/all|上場来/.test(s)) return 'all';
  if (/manual|手動/.test(s)) return 'manual';
  return null;
}
function parseGeneric(text) {
  const raw = text.includes('\t') ? text.split(/\r?\n/).map(l => l.split('\t')) : parseCsvText(text);
  const rows = raw.filter(r => r.some(c => String(c).trim() !== ''));
  if (!rows.length) return [];
  let header = rows[0].map(h => GENERIC_MAP[String(h).trim()] || null), start = 1;
  const hasHeader = header.some(Boolean);
  if (!hasHeader) { header = ['ticker', 'market', 'quantity', 'avgCost']; start = 0; }
  const out = [];
  for (let i = start; i < rows.length; i++) {
    const rec = {}; rows[i].forEach((c, j) => { if (header[j]) rec[header[j]] = String(c).trim(); });
    const ticker = (rec.ticker || '').trim(); if (!ticker) continue;
    let market = (rec.market || '').toUpperCase(); if (market !== 'US' && market !== 'JP') market = /^\d/.test(ticker) ? 'JP' : 'US';
    const qty = numClean(rec.quantity);
    const row = { market, ticker, broker: rec.broker || null, account: normAccount(rec.account), quantity: qty, avgCost: numClean(rec.avgCost) ?? 0 };
    // 銘柄属性（ヘッダにある列のみ）。分析結果は含めない
    const sec = {};
    if ('prevBuyPrice' in rec) sec.prevBuyPrice = numClean(rec.prevBuyPrice);
    if ('prevBuyDate' in rec) sec.prevBuyDate = rec.prevBuyDate || null;
    if ('detailType' in rec) sec.detailType = /ETF|ＥＴＦ/i.test(rec.detailType) ? 'ETF' : (rec.detailType || null);
    if ('fixedBuyPrice' in rec) sec.fixedBuyPrice = numClean(rec.fixedBuyPrice);
    if ('addonFromHigh' in rec) sec.addonFromHigh = /初回|^1$|true|yes|○|有/i.test(rec.addonFromHigh);
    if ('baseHighMode' in rec) sec.baseHighMode = normBaseHighMode(rec.baseHighMode);
    if ('baseHighManual' in rec) sec.baseHighManual = numClean(rec.baseHighManual);
    if ('ruleName' in rec) sec.ruleName = rec.ruleName || '';
    if ('category' in rec) sec.category = rec.category || null;
    if ('investCategory' in rec) sec.investCategory = rec.investCategory || null;
    if ('buyAmount' in rec) sec.buyAmount = numClean(rec.buyAmount);
    if ('buyCount' in rec) { const n = parseInt(rec.buyCount, 10); sec.buyCount = isNaN(n) ? null : n; }
    if ('enabled' in rec) sec.enabled = /有効|^1$|true|yes/i.test(rec.enabled);
    if ('watch' in rec) sec.watch = /注意|^1$|true|yes/i.test(rec.watch);
    if ('principalSold' in rec) sec.principalSold = /売却|済|^1$|true|yes|○/i.test(rec.principalSold);
    if ('principalSoldAmount' in rec) sec.principalSoldAmount = numClean(rec.principalSoldAmount);
    if ('targetPer' in rec) sec.targetPer = numClean(rec.targetPer);
    if ('targetPbr' in rec) sec.targetPbr = numClean(rec.targetPbr);
    if ('targetYield' in rec) sec.targetYield = numClean(rec.targetYield);
    // 株価シナリオ（レンジは正規化・分析日は日付正規化。履歴 upsert は取込実行側で行う）
    if ('scenarioDate' in rec) sec.scenarioDate = normDate(rec.scenarioDate);
    if ('scenarioPrice' in rec) sec.scenarioPrice = numClean(rec.scenarioPrice);
    for (const k of ['stBear', 'stBase', 'stBull', 'mtBear', 'mtBase', 'mtBull']) if (k in rec) sec[k] = scNormRange(rec[k]);
    if ('memo' in rec) sec.memo = rec.memo || null;
    if ('labels' in rec) sec.labels = parseLabels(rec.labels); // 銘柄ラベル（; 区切り→配列）
    // 売却前購入額は保有(holding)単位。row 直下に持たせる（_sec＝銘柄属性ではない）
    if ('origBuyAmount' in rec) row.origBuyAmount = numClean(rec.origBuyAmount);
    if (Object.keys(sec).length) row._sec = sec;
    if (qty == null && !row._sec && row.origBuyAmount == null) continue; // 数量も属性も無い行はスキップ
    out.push(row);
  }
  return out;
}

const IMPORT_PROFILES = {
  // scope: 洗い替え（replace）の対象範囲。fixed=固定証券会社（モード固定replace）
  'sbi-us':  { label: 'SBI 米国株（画面コピーを貼り付け）', input: 'paste', parse: parseSbiUsScreen, fixed: true, scope: { broker: 'SBI', markets: ['US'] } },
  'sbi-jp':  { label: 'SBI 日本株（CSVファイル）', input: 'file', parse: parseSbiJpCsv, fixed: true, scope: { broker: 'SBI', markets: ['JP'] } },
  'smbc':    { label: 'SMBC日興証券 日本株（画面コピーを貼り付け）', input: 'paste', parse: parseSmbcScreen, fixed: true, scope: { broker: 'SMBC日興', markets: ['JP'] } },
  'moomoo':  { label: 'moomoo（CSVファイル）', input: 'file', parse: parseMoomooCsv, fixed: true, scope: { broker: 'moomoo', markets: ['JP', 'US'] } },
  'rakuten': { label: '楽天証券（保有商品一覧CSV）', input: 'file', parse: parseRakutenCsv, fixed: true, scope: { broker: '楽天', markets: ['JP', 'US'] } },
  'monex-jp': { label: 'マネックス 日本株（CSVファイル）', input: 'file', parse: parseMonexJpCsv, fixed: true, scope: { broker: 'マネックス', markets: ['JP'] } },
  'monex-fund': { label: 'マネックス 投資信託（CSVファイル・別ファイル）', input: 'file', parse: () => [], fixed: true, scope: { broker: 'マネックス', markets: ['FUND'] } },
  // 汎用取込は「汎用データ（取込⇄出力）」セクションの専用UI(openGenericImport)へ分離（証券会社取込とは別枠）
};

// データ内の基準日（基準日/作成日/出力日/評価日 等のラベル付き日付）を抽出。無ければnull
function extractBaseDate(text) {
  const m = String(text || '').match(/(基準日|作成日|出力日|評価日|データ日付|日付)[^\d]{0,8}(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (!m) return null;
  return `${m[2]}-${String(m[3]).padStart(2, '0')}-${String(m[4]).padStart(2, '0')}`;
}

let _importRows = [], _importProfile = 'sbi-us', _importText = '';

function openBrokerImport(preKey) {
  const startKey = (preKey && IMPORT_PROFILES[preKey]) ? preKey : 'sbi-us';
  const profOpts = Object.entries(IMPORT_PROFILES).map(([k, p]) => `<option value="${k}" ${k === startKey ? 'selected' : ''}>${esc(p.label)}</option>`).join('');
  _importRows = []; _importProfile = startKey; _importText = '';
  showModal('保有を取込（証券会社別）', `
    <form id="bimport-form" onsubmit="return false">
      <div class="field"><label>形式（証券会社）</label>
        <select name="profile" onchange="onImportProfileChange(this.value)">${profOpts}</select></div>
      <div class="field" id="bimport-broker-wrap" style="display:none"><label>証券会社（汎用・列に無い場合）</label>
        <select name="broker">${BROKERS.map(b => `<option>${b}</option>`).join('')}</select></div>
      <div class="field" id="bimport-mode-wrap" style="display:none"><label>取込モード（汎用）</label>
        <select name="mode">
          <option value="append">追加（既存はそのまま）</option>
          <option value="replace">証券会社ごとに入れ替え（洗い替え）</option>
          <option value="upsert">追加＋上書き</option>
        </select></div>
      <div class="field" id="bimport-file-wrap"><label>CSVファイル（Shift-JIS/UTF-8 自動判定）</label>
        <input type="file" name="file" accept=".csv,.txt,text/csv,text/plain,text/comma-separated-values,application/csv,application/vnd.ms-excel,application/octet-stream" onchange="onImportFile(this)"></div>
      <div class="field" id="bimport-paste-wrap" style="display:none"><label>貼り付け</label>
        <textarea name="paste" rows="8" oninput="onImportPaste(this.value)" style="font-family:monospace;font-size:12px" placeholder="ここに貼り付け"></textarea></div>
      <label class="check"><input type="checkbox" name="create" checked> 未登録のティッカーは新規作成する</label>
      <div id="bimport-preview" class="muted" style="margin:8px 0"></div>
      <p class="muted" id="bimport-note" style="margin:0 0 8px"></p>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
        <button type="button" class="btn btn-primary" onclick="runBrokerImport()">取込を実行</button>
      </div>
    </form>`);
  onImportProfileChange(startKey);
}
function onImportProfileChange(key) {
  _importProfile = key; _importRows = []; _importText = '';
  const p = IMPORT_PROFILES[key];
  document.getElementById('bimport-file-wrap').style.display = p.input === 'file' ? '' : 'none';
  document.getElementById('bimport-paste-wrap').style.display = p.input === 'paste' ? '' : 'none';
  document.getElementById('bimport-broker-wrap').style.display = key === 'generic' ? '' : 'none';
  document.getElementById('bimport-mode-wrap').style.display = key === 'generic' ? '' : 'none';
  const note = document.getElementById('bimport-note');
  if (note) note.textContent = p.fixed
    ? `この形式は「洗い替え」です（${p.scope.broker} の ${p.scope.markets.map(m => MARKET_LABEL[m]).join('・')} の保有を全削除してから取り込みます）。`
    : '汎用は取込モードを選べます。';
  setImportPreview();
}
function onImportFile(input) {
  const file = input.files[0]; if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    const buf = r.result;
    try { _importText = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (_) { _importText = new TextDecoder('shift_jis').decode(buf); }
    try { _importRows = IMPORT_PROFILES[_importProfile].parse(_importText, store.data.importMappings[_importProfile]); }
    catch (e) { _importRows = []; }
    setImportPreview();
  };
  r.readAsArrayBuffer(file);
}
function onImportPaste(text) {
  _importText = text;
  try { _importRows = IMPORT_PROFILES[_importProfile].parse(text, store.data.importMappings[_importProfile]); }
  catch (e) { _importRows = []; }
  setImportPreview();
}
function setImportPreview() {
  const el = document.getElementById('bimport-preview'); if (!el) return;
  if (!_importRows.length) { el.textContent = '（データ未検出）'; return; }
  const bd = extractBaseDate(_importText);
  const sample = _importRows.slice(0, 4).map(r => `${MARKET_LABEL[r.market]} ${r.ticker} ×${r.quantity} @${r.avgCost}（${r.broker || '—'}/${r.account}）`).join('<br>');
  el.innerHTML = `<strong>${_importRows.length} 件</strong>を検出${bd ? `（基準日: ${bd}）` : ''}:<br>${sample}${_importRows.length > 4 ? '<br>…' : ''}`;
}
async function runBrokerImport() {
  if (!_importRows.length && !parseFundRows(_importText).length) { toast('取込データがありません'); return; }
  const f = document.getElementById('bimport-form');
  const create = f.create.checked;
  const prof = IMPORT_PROFILES[_importProfile];
  const defBroker = f.broker ? f.broker.value : 'SBI';
  // モード決定: 固定プロファイルは replace（洗い替え）、汎用は選択
  const mode = prof.fixed ? 'replace' : (f.mode ? f.mode.value : 'append');
  // 汎用形式の銘柄属性（row._sec）にマスタ管理項目があれば未登録値を確認・変換（中止で全取込キャンセル）
  const bPairs = [];
  for (const row of _importRows) if (row._sec) for (const k in row._sec) if (FIELD_DOMAIN[k]) bPairs.push({ field: k, raw: row._sec[k] });
  if (!(await ensureMasterConversions(bPairs))) { toast('取込を中止しました'); return; }
  // 洗い替えスコープ
  let scope = prof.fixed ? prof.scope : { broker: defBroker, markets: ['JP', 'US'] };

  // 同じCSV/貼付に含まれる投資信託（先に解析してスコープ判定に使う。下の投信取込でも再利用）
  // strict は「株ファイルに投信が混ざる」moomoo/楽天等の誤検知対策。投信専用プロファイル
  // （scope が FUND。例: マネックス投信）はファイル全体が投信なので非strict（見出し/種別列が無くても拾う）
  const fundStrict = !(scope.markets && scope.markets.includes('FUND'));
  const fundItems = parseFundRows(_importText, { strict: fundStrict });
  const fundsInScope = fundItems.length > 0;
  // この保有が洗い替えスコープ（この証券会社×対象市場、CSVに投信があれば投信も）に入るか
  const inReplaceScope = (h) => {
    const s = store.data.securities.find(x => x.id === h.securityId);
    if (!s) return false;
    if (h.broker === scope.broker && scope.markets.includes(s.market)) return true;
    return fundsInScope && s.market === 'FUND' && h.broker === scope.broker;
  };
  const holdKey = (h) => `${h.securityId}|${h.broker}|${h.accountType}`;
  // 洗い替えの内訳（追加/更新/据置/削除）を出すため、削除前にスコープ内保有を退避
  const beforeHoldings = {};
  if (mode === 'replace') for (const h of store.data.holdings) if (inReplaceScope(h)) beforeHoldings[holdKey(h)] = { quantity: h.quantity, avgCost: h.avgCost };

  // replace: スコープ内の既存保有を削除
  // 洗い替えで消える取得円・投信評価額・売却前購入額は退避し、取込後に同一キーへ復元（削除前に退避）
  const extras = mode === 'replace' ? snapshotHoldingExtras(store.data.holdings) : null;
  let removed = 0;
  if (mode === 'replace') {
    const keep = [];
    for (const h of store.data.holdings) {
      const s = store.data.securities.find(x => x.id === h.securityId);
      if (s && h.broker === scope.broker && scope.markets.includes(s.market)) { removed++; continue; }
      keep.push(h);
    }
    store.data.holdings = keep;
  }

  let updated = 0, created = 0, skipped = 0, badFmt = 0;
  const touched = [];
  for (const row of _importRows) {
    const tk = row.market === 'US' ? row.ticker.trim().toUpperCase() : row.ticker.trim();
    if (!validTicker(tk, row.market)) { badFmt++; continue; }   // 形式NG（日本株4桁/米国株大文字英字）は取込まない
    let sec = store.findSecurity(row.market, tk);
    if (!sec) {
      if (!create) { skipped++; continue; }
      sec = store.addSecurity({ market: row.market, ticker: tk, currency: row.market === 'US' ? 'USD' : 'JPY', assetClass: 'stock', enabled: true, ruleId: store.defaultRule().id });
      created++;
    } else updated++;
    // 汎用: 銘柄属性（前回購入価格・基準高値・ルール・カテゴリ 等）を反映（分析結果は対象外）
    if (row._sec) {
      const p = { ...row._sec };
      // マスタ管理項目は変換マスタで正規化／スキップ
      for (const k of Object.keys(p)) { if (k !== 'ruleName' && FIELD_DOMAIN[k]) { const cv = convMaster(k, p[k]); if (cv === SKIP) delete p[k]; else p[k] = cv; } }
      if ('ruleName' in p) { const rn = convMaster('ruleName', p.ruleName); delete p.ruleName; if (rn !== SKIP) { const r = store.data.rules.find(x => x.name === rn); if (r) p.ruleId = r.id; } }
      if (Array.isArray(p.labels)) ensureLabelDefs(p.labels); // 未登録ラベルはマスタへ自動追加
      store.updateSecurity(sec.id, p);
      // 株価シナリオはシナリオ分析日があれば履歴(priceScenarios)へ upsert→最新をミラー
      if (p.scenarioDate) {
        const scFields = {};
        for (const k of SCENARIO_FIELDS) if (k in p) scFields[k] = p[k];
        store.upsertScenario(sec.id, p.scenarioDate, scFields);
        store.syncLatestScenario(sec.id);
      }
    }
    // 数量がある行のみ保有を作成/更新
    if (row.quantity != null) {
      const broker = row.broker || defBroker, account = row.account || '特定';
      const exists = store.data.holdings.some(h => h.securityId === sec.id && h.broker === broker && h.accountType === account);
      if (mode === 'append' && exists) { /* 既存はそのまま（上書きしない） */ }
      else {
        store.setHolding(sec.id, broker, account, row.quantity, row.avgCost ?? 0, 'import');
        // 取込データに円取得額があれば保有へ反映（SBI米株=円換算評価額−円換算評価損益）。SEC-59
        if (row.acqJpy != null) {
          const h = store.data.holdings.find(x => x.securityId === sec.id && x.broker === broker && x.accountType === account);
          if (h) h.acqJpy = row.acqJpy;
        }
      }
    }
    touched.push(sec);
  }
  // 同じCSV/貼付に含まれる投資信託を自動仕分け（FUND保有として内部保存）
  // 既存ファンド（名称/エイリアス一致）は即取込。未登録（新規）は登録せず保留し、後でコード入力させてから登録する
  let fundCount = 0, pendingTotal = 0;
  const pending = {}; // normName -> { name, items:[{broker,account,qty,acqJpy,evalJpy}] }
  if (fundItems.length) {
    if (mode === 'replace') {
      store.data.holdings = store.data.holdings.filter(h => { const s = store.data.securities.find(x => x.id === h.securityId); return !(s && s.market === 'FUND' && h.broker === scope.broker); });
    }
    for (const it of fundItems) {
      const key = normFundName(it.name);
      const existing = store.data.securities.find(s => s.market === 'FUND' && fundNameKeys(s).includes(key));
      if (existing) {
        if (normFundName(existing.name) !== key && !(existing.aliasNames || []).some(a => normFundName(a) === key)) existing.aliasNames = [...(existing.aliasNames || []), it.name];
        const q = (it.qty && it.qty > 0) ? it.qty : 1;
        store.setHolding(existing.id, scope.broker, it.account || '特定', q, it.acqJpy != null ? it.acqJpy / q : 0, 'import');
        if (it.evalJpy != null) {
          store.data.prices['FUND:' + existing.ticker] = { price: it.evalJpy / q, prevClose: null, updatedAt: store._now() };
          const fh = store.data.holdings.find(x => x.securityId === existing.id && x.broker === scope.broker && x.accountType === (it.account || '特定'));
          if (fh) fh.evalJpy = it.evalJpy; // 保有（証券会社×口座）ごとの評価額
        }
        fundCount++;
      } else {
        (pending[key] = pending[key] || { name: it.name, items: [] }).items.push({ broker: scope.broker, account: it.account || '特定', qty: it.qty, acqJpy: it.acqJpy, evalJpy: it.evalJpy });
        pendingTotal++;
      }
    }
  }
  if (extras) restoreHoldingExtras(extras);  // 洗い替えで消えた取得円等を同一キーの保有へ復元
  store.save();
  // 取込履歴
  const baseDate = extractBaseDate(_importText);
  store.data.importHistory.unshift({
    id: store.nextId(), profile: _importProfile, label: prof.label,
    broker: scope.broker, markets: scope.markets, mode, count: _importRows.length + fundCount + pendingTotal,
    importedAt: new Date().toISOString(), baseDate: baseDate || null,
  });
  _convSession = {};
  store.save();
  closeModal();
  // 結果メッセージ。洗い替え（証券会社別の固定形式）は「全件・追加・更新・据置・削除」の内訳を出す
  // （旧: 削除＝スコープ全件が出て中身の変化が分からなかった）。汎用の追加/上書きは従来どおり。
  let importMsg;
  if (mode === 'replace') {
    const afterHoldings = {};
    for (const h of store.data.holdings) if (inReplaceScope(h)) afterHoldings[holdKey(h)] = { quantity: h.quantity, avgCost: h.avgCost };
    const sameHold = (a, b) => a.quantity === b.quantity && Math.abs((a.avgCost || 0) - (b.avgCost || 0)) < 1e-6;
    let addedH = 0, updatedH = 0, keptH = 0, deletedH = 0;
    for (const k of Object.keys(afterHoldings)) {
      if (!(k in beforeHoldings)) addedH++;
      else if (sameHold(beforeHoldings[k], afterHoldings[k])) keptH++;
      else updatedH++;
    }
    for (const k of Object.keys(beforeHoldings)) if (!(k in afterHoldings)) deletedH++;
    const totalH = Object.keys(afterHoldings).length;
    importMsg = `取込完了（洗い替え）: 全 ${totalH}件 ／ 追加 ${addedH} ・ 更新 ${updatedH} ・ 据置 ${keptH} ・ 削除 ${deletedH}`
      + `${pendingTotal ? ` ／ 新規投信 ${Object.keys(pending).length}件はコード入力待ち` : ''}`
      + `${badFmt ? ` ／ 形式NG ${badFmt}件は取込まず` : ''}`
      + `${skipped ? ` ／ スキップ ${skipped}件` : ''}`;
  } else {
    importMsg = `取込完了: 更新 ${updated} / 新規 ${created}${fundCount ? ` / 投信 ${fundCount}件` : ''}${pendingTotal ? ` / 新規投信 ${Object.keys(pending).length}件はコード入力待ち` : ''}${removed ? ` / 洗い替え削除 ${removed}` : ''}${badFmt ? ` / 形式NG ${badFmt}件は取込まず` : ''}${skipped ? ` / スキップ ${skipped}` : ''}`;
  }
  // 新規投信があれば「コード入力→登録」を先に出し、登録が終わってから取込完了レポートを出す
  // （同じ #modal-overlay を使うため、レポートと同時に出すと後勝ちで入力画面が消える／裏に回る）
  if (Object.keys(pending).length) {
    _pendingFundReg = pending;
    _pendingImportReport = { touched, msg: importMsg };
    openNewFundCodeModal();
  } else {
    reportImport(touched, importMsg);
  }
}
// 新規投信のコード入力モーダル。協会コードを入れて登録（空欄なら内部コードFND）
let _pendingFundReg = null;
let _pendingImportReport = null; // 投信コード登録の後に出す取込完了レポート {touched, msg}
function openNewFundCodeModal() {
  const entries = Object.entries(_pendingFundReg || {});
  if (!entries.length) return;
  const rows = entries.map(([key, v], i) => {
    const accts = v.items.length;
    return `<tr>
      <td class="l" style="white-space:normal">${esc(v.name)}</td>
      <td class="l" style="white-space:nowrap"><input type="text" id="nf-code-${i}" placeholder="協会コード(8桁)/空欄でFND" style="width:170px;font-family:monospace"></td>
      <td style="white-space:nowrap">${accts}件</td>
    </tr>`;
  }).join('');
  showModal('新規投資信託のコード登録', `
    <p class="muted" style="margin:0 0 10px">取込んだCSVに<strong>未登録の投資信託</strong>がありました。投信はCSVにコードが無いため、<strong>協会コード（8桁）</strong>を入力して登録してください（空欄なら内部コードFND…を自動採番。後でコードマスタで変更・統合できます）。</p>
    <div class="table-wrap" style="max-height:60vh"><table class="holdings dense no-rowclick" style="width:100%"><thead><tr><th class="l">取込名（CSVの名称）</th><th class="l">協会コード</th><th>明細</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="form-actions">
      <button type="button" class="btn" onclick="registerPendingFunds(true)">コード無しで登録（FND）</button>
      <button type="button" class="btn btn-primary" onclick="registerPendingFunds(false)">登録して取込</button>
    </div>`, { wide: true });
  const mw = document.querySelector('#modal-overlay .modal'); if (mw) mw.style.maxWidth = 'min(1100px,92vw)';
}
function registerPendingFunds(skipCode) {
  const entries = Object.entries(_pendingFundReg || {});
  let n = 0;
  for (let i = 0; i < entries.length; i++) {
    const [, v] = entries[i];
    let code = skipCode ? '' : ((document.getElementById('nf-code-' + i) || {}).value || '').trim();
    let sec;
    if (code) {
      sec = store.data.securities.find(s => s.market === 'FUND' && s.ticker === code);
      if (sec) { // 同コード既存＝同一ファンド。別表記をエイリアスに
        if (!fundNameKeys(sec).includes(normFundName(v.name))) sec.aliasNames = [...(sec.aliasNames || []), v.name];
      } else sec = store.addSecurity({ market: 'FUND', ticker: code, name: v.name, aliasNames: [], currency: 'JPY', assetClass: 'fund', enabled: false });
    } else {
      sec = store.addSecurity({ market: 'FUND', ticker: nextFundCode(), name: v.name, aliasNames: [], currency: 'JPY', assetClass: 'fund', enabled: false });
    }
    for (const it of v.items) {
      const q = (it.qty && it.qty > 0) ? it.qty : 1;
      store.setHolding(sec.id, it.broker, it.account || '特定', q, it.acqJpy != null ? it.acqJpy / q : 0, 'import');
      if (it.evalJpy != null) {
        store.data.prices['FUND:' + sec.ticker] = { price: it.evalJpy / q, prevClose: null, updatedAt: store._now() };
        const fh = store.data.holdings.find(x => x.securityId === sec.id && x.broker === it.broker && x.accountType === (it.account || '特定'));
        if (fh) fh.evalJpy = it.evalJpy; // 保有ごとの評価額
      }
    }
    n++;
  }
  _pendingFundReg = null;
  store.save(); closeModal(); render();
  toast(`新規投信 ${n} 件を登録しました`, 4000);
  // 登録が完了してから取込完了レポートを出す（入力画面が裏に回る／消える問題の解消）
  const rep = _pendingImportReport; _pendingImportReport = null;
  if (rep) reportImport(rep.touched, rep.msg);
}

// 取込フィールド設定（マッピング）の編集UI。列名/位置が変わってもコード変更なしで調整可
const MAPPING_FIELDS = {
  'sbi-jp':  [['ticker', '銘柄コードの列名'], ['quantity', '保有株数の列名'], ['avgCost', '取得単価の列名']],
  'moomoo':  [['ticker', 'コード列名'], ['quantity', '数量列名'], ['avgCost', '平均取得価額列名'], ['account', '口座区分列名'], ['currency', '通貨列名']],
  'rakuten': [['kind', '種別列名'], ['ticker', '銘柄コード列名'], ['quantity', '保有数量列名'], ['avgCost', '平均取得価額列名'], ['account', '口座列名']],
  'monex-jp': [['ticker', '銘柄コード列名'], ['quantity', '保有数列名'], ['avgCost', '平均取得単価列名'], ['account', '口座区分列名']],
  'sbi-us':  [['qtyPos', '数量は数値の何番目か'], ['avgCostPos', '取得単価は数値の何番目か'], ['evalJpyPos', '円換算評価額は数値の何番目か'], ['pnlJpyPos', '円換算評価損益は数値の何番目か']],
  'smbc':    [['qtyPos', '数量は数値の何番目か'], ['avgCostPos', '平均取得単価は数値の何番目か']],
};
function openImportMapping() {
  const blocks = Object.entries(MAPPING_FIELDS).map(([key, fields]) => {
    const label = IMPORT_PROFILES[key].label;
    const cur = store.data.importMappings[key] || {};
    const inputs = fields.map(([f, lbl]) => {
      const isPos = f.endsWith('Pos');
      return `<div class="field"><label>${esc(lbl)}</label>
        <input data-prof="${key}" data-field="${f}" ${isPos ? 'type="number" min="1" step="1"' : 'type="text"'} value="${esc(cur[f] != null ? cur[f] : '')}"></div>`;
    }).join('');
    return `<details class="form-group"><summary>${esc(label)}</summary>${inputs}</details>`;
  }).join('');
  showModal('取込フィールド設定（マッピング）', `
    <p class="muted">各証券会社の取込で、どの列名／何番目の数値を使うかを設定します（列が変わってもここで調整できます）。</p>
    <div id="mapping-body">${blocks}</div>
    <div class="form-actions">
      <button type="button" class="btn btn-sm" onclick="resetImportMapping()">既定に戻す</button>
      <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
      <button type="button" class="btn btn-primary" onclick="saveImportMapping()">保存</button>
    </div>`);
}
function saveImportMapping() {
  document.querySelectorAll('#mapping-body input').forEach(inp => {
    const prof = inp.dataset.prof, field = inp.dataset.field;
    store.data.importMappings[prof] ||= {};
    if (inp.type === 'number') store.data.importMappings[prof][field] = parseInt(inp.value, 10) || DEFAULT_IMPORT_MAPPINGS[prof][field];
    else store.data.importMappings[prof][field] = inp.value.trim() || DEFAULT_IMPORT_MAPPINGS[prof][field];
  });
  store.save(); closeModal(); toast('取込フィールド設定を保存しました');
}
function resetImportMapping() {
  for (const k in DEFAULT_IMPORT_MAPPINGS) store.data.importMappings[k] = { ...DEFAULT_IMPORT_MAPPINGS[k] };
  store.save(); openImportMapping(); toast('既定に戻しました');
}

// 汎用出力: 全銘柄・保有を汎用取込フォーマットのCSVで出力（分析結果は除く）
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// フィールドキー→出力値（銘柄s・保有h。hは無い場合null）。汎用取込のフィールドキーと1対1で対応させる
function genericFieldValue(key, s, h) {
  switch (key) {
    case 'ticker': return s.ticker;
    case 'market': return s.market;
    case 'broker': return h ? h.broker : '';
    case 'account': return h ? h.accountType : '';
    case 'quantity': return h ? h.quantity : '';
    case 'avgCost': return h ? h.avgCost : '';
    case 'acqJpy': return h && h.acqJpy != null ? h.acqJpy : '';
    case 'origBuyAmount': return h && h.origBuyAmount != null ? h.origBuyAmount : '';
    case 'prevBuyPrice': return s.prevBuyPrice ?? '';
    case 'prevBuyDate': return s.prevBuyDate || '';
    case 'baseHighMode': return s.baseHighMode || '';
    case 'baseHighManual': return s.baseHighManual ?? '';
    case 'fixedBuyPrice': return s.fixedBuyPrice ?? '';
    case 'addonFromHigh': return s.addonFromHigh ? '初回基準' : '';
    case 'ruleName': return (store.rule(s.ruleId) || {}).name || '';
    case 'category': return s.category || '';
    case 'investCategory': return s.investCategory || '';
    case 'labels': return serializeLabels(secLabels(s));
    case 'buyAmount': return s.buyAmount ?? '';
    case 'buyCount': return s.buyCount ?? '';
    case 'enabled': return s.enabled === false ? '無効' : '有効';
    case 'watch': return s.watch ? '注意' : '通常';
    case 'detailType': return detailTypeOf(s);
    case 'principalSold': return s.principalSold ? '売却済' : '';
    case 'principalSoldAmount': return s.principalSoldAmount ?? '';
    case 'targetPer': return s.targetPer ?? '';
    case 'targetPbr': return s.targetPbr ?? '';
    case 'targetYield': return s.targetYield ?? '';
    // 株価シナリオ（レンジは保存形式「1000~1500」のまま出力＝取込で往復可能）
    case 'scenarioDate': return s.scenarioDate || '';
    case 'scenarioPrice': return s.scenarioPrice ?? '';
    case 'stBear': return s.stBear ?? '';
    case 'stBase': return s.stBase ?? '';
    case 'stBull': return s.stBull ?? '';
    case 'mtBear': return s.mtBear ?? '';
    case 'mtBase': return s.mtBase ?? '';
    case 'mtBull': return s.mtBull ?? '';
    case 'memo': return s.memo || '';
    default: return ''; // 分析結果・未対応フィールドは空欄
  }
}
// 出力レイアウト選択（標準 or 汎用取込で保存したフォーマット）
function openGenericExport() {
  const fmts = store.data.importFormats || [];
  showModal('汎用出力（レイアウトを選んで出力）', `
    <p class="muted" style="margin:0 0 8px"><strong>標準</strong>は全項目を既定の並びで出力します。汎用取込で保存したフォーマットを選ぶと、その<strong>列名・並び</strong>で出力します（取込⇄出力を同じレイアウトで往復）。</p>
    <div class="field" style="max-width:340px"><label style="font-size:11px">出力レイアウト</label>
      <select id="ge-format">
        <option value="">標準（全項目・既定の並び）</option>
        ${fmts.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}
      </select></div>
    ${fmts.length ? '' : '<div class="muted" style="margin:6px 0 0">※ 保存フォーマットはまだありません。「汎用取込」で各列に取込先を割り当て→「フォーマット保存」すると、その並びで出力できます。</div>'}
    <div class="form-actions">
      <button type="button" class="btn" onclick="closeModal()">閉じる</button>
      <button type="button" class="btn btn-primary" onclick="const v=document.getElementById('ge-format').value; closeModal(); exportGeneric(v?parseInt(v,10):null);">出力</button>
    </div>`);
}
function exportGeneric(fmtId) {
  const fmt = fmtId ? (store.data.importFormats || []).find(f => f.id === fmtId) : null;
  // cols: [{header, key}]。標準=GENERIC_HEADER（列名→キーはGENERIC_MAP）／保存フォーマット=その列名・並び
  const cols = fmt
    ? Object.entries(fmt.mapping).map(([header, key]) => ({ header, key }))
    : GENERIC_HEADER.map(h => ({ header: h, key: GENERIC_MAP[h] || '' }));
  const lines = [cols.map(c => csvCell(c.header)).join(',')];
  for (const s of store.data.securities) {
    const hs = store.data.holdings.filter(h => h.securityId === s.id);
    const emit = (h) => lines.push(cols.map(c => csvCell(genericFieldValue(c.key, s, h))).join(','));
    if (hs.length) hs.forEach(emit); else emit(null);
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `securities-generic${fmt ? '-' + fmt.name : ''}-${today()}.csv`;
  a.click();
  toast(`汎用CSVをダウンロードしました${fmt ? `（${fmt.name}）` : ''}`);
}

// ---------- 汎用取込（列選択式・フォーマット保存）----------
// 貼り付けたヘッダを見て列ごとに取込先フィールドを選択。コード・市場は必須、選んだ列だけ ticker×market で上書き。
const GI_FIELDS = [
  { key: 'ticker',        label: 'コード/ティッカー', req: true },
  { key: 'market',        label: '市場(US/JP)',       req: true },
  { key: 'broker',        label: '証券会社' },
  { key: 'account',       label: '口座種別' },
  { key: 'quantity',      label: '数量' },
  { key: 'avgCost',       label: '取得単価（※約定価額と択一）' },
  { key: 'acqValue',      label: '約定価額（※単価と択一・株数から単価を算出）' },
  { key: 'acqJpy',        label: '取得円(米株)' },
  { key: 'prevBuyPrice',  label: '前回購入価格' },
  { key: 'prevBuyDate',   label: '前回購入日' },
  { key: 'fixedBuyPrice', label: '買増固定値' },
  { key: 'addonFromHigh', label: '買い増しを初回基準' },
  { key: 'baseHighMode',  label: '基準高値モード' },
  { key: 'baseHighManual', label: '手動基準高値' },
  { key: 'ruleName',      label: '買い増しルール' },
  { key: 'category',      label: 'カテゴリ' },
  { key: 'investCategory', label: '投資カテゴリ' },
  { key: 'labels',        label: '銘柄ラベル（複数; 区切り）' },
  { key: 'detailType',    label: '詳細種別' },
  { key: 'buyAmount',     label: '買い増し予定額' },
  { key: 'buyCount',      label: '購入回数' },
  { key: 'enabled',       label: '判定対象' },
  { key: 'watch',         label: 'ウォッチ' },
  { key: 'nameOverride',  label: '銘柄名(上書き)' },
  { key: 'sectorOverride', label: 'セクター(上書き)' },
  { key: 'industryOverride', label: '業種(上書き)' },
  { key: 'overallGrade',  label: '総合評価' },
  { key: 'rating',        label: '銘柄格付' },
  { key: 'buyGrade',      label: '買い時評価' },
  { key: 'priority',      label: '購入優先順位' },
  { key: 'analysisDate',  label: '評価日' },
  { key: 'analysisNote',  label: '分析メモ' },
  { key: 'starValuation', label: '★バリュエーション' },
  { key: 'starStrength',  label: '★独自の強み' },
  { key: 'starRisk',      label: '★リスク' },
  { key: 'scenarioDate',  label: 'シナリオ分析日' },
  { key: 'scenarioPrice', label: 'シナリオ分析時株価' },
  { key: 'stBear',        label: '短期シナリオ・弱気' },
  { key: 'stBase',        label: '短期シナリオ・ベース' },
  { key: 'stBull',        label: '短期シナリオ・強気' },
  { key: 'mtBear',        label: '中期シナリオ・弱気' },
  { key: 'mtBase',        label: '中期シナリオ・ベース' },
  { key: 'mtBull',        label: '中期シナリオ・強気' },
  { key: 'targetPer',     label: '目標PER' },
  { key: 'targetPbr',     label: '目標PBR' },
  { key: 'targetYield',   label: '目標配当利回り(%)' },
  { key: 'principalSold',       label: '元本売却済み' },
  { key: 'principalSoldAmount', label: '売却済み元本額' },
  { key: 'origBuyAmount', label: '売却前購入額' },
  { key: 'memo',          label: 'メモ' },
];
const GI_SEC_FIELDS = new Set(['prevBuyPrice', 'prevBuyDate', 'fixedBuyPrice', 'addonFromHigh', 'baseHighMode', 'baseHighManual', 'category', 'investCategory', 'detailType', 'buyAmount', 'buyCount', 'enabled', 'watch', 'nameOverride', 'sectorOverride', 'industryOverride', 'overallGrade', 'rating', 'buyGrade', 'priority', 'analysisDate', 'analysisNote', 'starValuation', 'starStrength', 'starRisk', 'principalSold', 'principalSoldAmount', 'memo', 'targetPer', 'targetPbr', 'targetYield', 'scenarioDate', 'scenarioPrice', 'stBear', 'stBase', 'stBull', 'mtBear', 'mtBase', 'mtBull']);
// 選択肢のグループ分け（必須/保有/属性/上書き/分析）。自動取得・派生（評価額/損益/価格/PER等）は候補に出さない。
const GI_GROUPS = [
  { g: '★必須', keys: ['ticker', 'market'] },
  { g: '保有・金額', keys: ['broker', 'account', 'quantity', 'avgCost', 'acqValue', 'acqJpy', 'origBuyAmount'] },
  { g: '判定・属性', keys: ['category', 'investCategory', 'labels', 'ruleName', 'detailType', 'prevBuyPrice', 'prevBuyDate', 'fixedBuyPrice', 'addonFromHigh', 'baseHighMode', 'baseHighManual', 'targetPer', 'targetPbr', 'targetYield', 'buyAmount', 'buyCount', 'enabled', 'watch', 'principalSold', 'principalSoldAmount'] },
  { g: '表示の上書き', keys: ['nameOverride', 'sectorOverride', 'industryOverride', 'memo'] },
  { g: '分析', keys: ['overallGrade', 'rating', 'buyGrade', 'priority', 'analysisDate', 'analysisNote', 'starValuation', 'starStrength', 'starRisk'] },
  { g: '株価シナリオ', keys: ['scenarioDate', 'scenarioPrice', 'stBear', 'stBase', 'stBull', 'mtBear', 'mtBase', 'mtBull'] },
];
const GI_FIXED_KEYS = ['market', 'broker', 'account', 'detailType', 'category', 'investCategory', 'ruleName', 'enabled'];
// ヘッダ名→フィールドの自動対応（汎用出力の列もそのまま読める）
const GI_AUTOMAP = { ...GENERIC_MAP,
  '取得円': 'acqJpy', '取得額(円)': 'acqJpy', '取得額（円）': 'acqJpy', '受渡金額(円)': 'acqJpy',
  '約定価額': 'acqValue', '取得価額': 'acqValue', '約定代金': 'acqValue',
  '前回購入日': 'prevBuyDate',
  '詳細種別': 'detailType', '総合評価': 'overallGrade', '銘柄格付': 'rating', '格付': 'rating', '買い時評価': 'buyGrade',
  '推奨カテゴリ': 'category', 'カテゴリ': 'category', '投資カテゴリ': 'investCategory', '購入優先順位': 'priority', '優先順位': 'priority',
  '銘柄ラベル': 'labels', 'ラベル': 'labels', 'タグ': 'labels',
  '評価日': 'analysisDate', '備考': 'analysisNote', '分析メモ': 'analysisNote',
  'バリュエーション': 'starValuation', '独自の強み': 'starStrength', 'リスク': 'starRisk',
  'セクター': 'sectorOverride', '業種': 'industryOverride',
  // 銘柄名は自動取得名を優先するため、取込列の自動割当からは外す（既定=取込まない。必要なら手動で割当可）
  '元本売却済み': 'principalSold', '売却済み元本額': 'principalSoldAmount', '売却元本': 'principalSoldAmount',
  // 株価シナリオ分析（短期・中期×弱気/ベース/強気の予想レンジ）。「分析日」は銘柄分析の「評価日」とは別
  '分析日': 'scenarioDate', 'シナリオ分析日': 'scenarioDate', '分析時株価': 'scenarioPrice', 'シナリオ分析時株価': 'scenarioPrice',
  '短期弱気': 'stBear', '短期ベース': 'stBase', '短期強気': 'stBull',
  '中期弱気': 'mtBear', '中期ベース': 'mtBase', '中期強気': 'mtBull',
  '短期シナリオ弱気': 'stBear', '短期シナリオベース': 'stBase', '短期シナリオ強気': 'stBull',
  '中期シナリオ弱気': 'mtBear', '中期シナリオベース': 'mtBase', '中期シナリオ強気': 'mtBull',
};
let _giHeaders = [], _giRows = [], _giMapping = []; // _giMapping[colIdx] = fieldKey | ''
// 列見出しの正規化キー。全角/半角(NFKC)・空白・★☆・英字大小を無視して一致させる。
// 例: '★リスク' / 'リスク ' / 'ﾘｽｸ' → 同一キー。
// ※カッコ内は残す（'取得額(円)'=取得円 と '取得額' を同一視すると別項目に誤割当するため）。
function giHeaderKey(h) {
  return normKey(h).replace(/[★☆\s]/g, '').toLowerCase();
}
// 見出し→フィールドの自動対応（正規化キーでも引く）。GI_AUTOMAP は初出優先。
let _giAutoN = null;
function giAutoField(h) {
  if (GI_AUTOMAP[h]) return GI_AUTOMAP[h];
  if (!_giAutoN) { _giAutoN = {}; for (const [k, v] of Object.entries(GI_AUTOMAP)) { const nk = giHeaderKey(k); if (!(nk in _giAutoN)) _giAutoN[nk] = v; } }
  return _giAutoN[giHeaderKey(h)] || '';
}

function openGenericImport() {
  showModal('汎用取込（列を選んで取込）', `
    <p class="muted" style="margin:0 0 8px">Excel等をヘッダ行ごと貼り付け→列ごとに取込先を選択。<strong>コード・市場は必須</strong>。選んだ列だけ既存銘柄に上書き（ticker×market、未登録は新規作成可）。</p>
    <div class="btn-row" style="align-items:center">
      <label class="check" style="margin:0"><input type="checkbox" id="gi-create" checked> 未登録は新規作成</label>
      <label style="margin:0;font-size:12px">取込モード
        <select id="gi-mode">
          <option value="upsert">上書き（一致を更新・無ければ追加）</option>
          <option value="update">上書きのみ（一致を更新・追加しない）</option>
          <option value="append">追加（既存はそのまま）</option>
          <option value="replace">洗い替え（固定の証券会社×市場を入替）</option>
        </select></label>
      <span style="flex:1"></span>
      <select id="gi-format"></select>
      <button class="btn btn-sm" onclick="giLoadFormat()">読込</button>
      <button class="btn btn-sm btn-danger" onclick="giDeleteFormat()">削除</button>
    </div>
    <textarea id="gi-text" rows="6" style="width:100%;font-family:monospace;font-size:12px" placeholder="ヘッダ行を含めて貼り付け（タブ/カンマ/マークダウン表対応）" oninput="giParse(this.value)"></textarea>
    <div id="gi-map"></div>
    <div class="grp-label" style="margin-top:8px">列に無い項目を固定値で指定（全行に適用・任意）</div>
    <div class="btn-row" style="align-items:flex-end" id="gi-fixed">
      <div class="field" style="width:auto"><label style="font-size:11px">市場</label>
        <select id="gi-fix-market" onchange="giRenderPreview()"><option value="">―</option><option>US</option><option>JP</option></select></div>
      <div class="field" style="width:auto"><label style="font-size:11px">証券会社</label>
        <select id="gi-fix-broker" onchange="giRenderPreview()"><option value="">―</option>${BROKERS.map(b => `<option>${b}</option>`).join('')}</select></div>
      <div class="field" style="width:auto"><label style="font-size:11px">口座</label>
        <select id="gi-fix-account" onchange="giRenderPreview()"><option value="">―</option>${ACCOUNTS.map(a => `<option>${a}</option>`).join('')}</select></div>
      <div class="field" style="width:auto"><label style="font-size:11px">詳細種別</label>
        <select id="gi-fix-detailType" onchange="giRenderPreview()"><option value="">―</option><option>個別株</option><option>ETF</option></select></div>
      <div class="field" style="width:auto"><label style="font-size:11px">カテゴリ</label>
        <select id="gi-fix-category" onchange="giRenderPreview()"><option value="">―</option>${[...store.data.categories].sort((a, b) => a.sortOrder - b.sortOrder).map(c => `<option>${esc(c.category)}</option>`).join('')}</select></div>
      <div class="field" style="width:auto"><label style="font-size:11px">投資カテゴリ</label>
        <select id="gi-fix-investCategory" onchange="giRenderPreview()"><option value="">―</option>${[...store.data.investCategories].sort((a, b) => a.sortOrder - b.sortOrder).map(c => `<option>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field" style="width:auto"><label style="font-size:11px">買い増しルール</label>
        <select id="gi-fix-ruleName" onchange="giRenderPreview()"><option value="">―</option>${store.data.rules.map(r => `<option>${esc(r.name)}</option>`).join('')}</select></div>
      <div class="field" style="width:auto"><label style="font-size:11px">判定対象</label>
        <select id="gi-fix-enabled" onchange="giRenderPreview()"><option value="">―</option><option>有効</option><option>無効</option></select></div>
    </div>
    <div id="gi-preview"></div>
    <div class="btn-row" style="margin-top:10px;align-items:center">
      <input id="gi-format-name" placeholder="フォーマット名（保存用）" style="width:200px">
      <button class="btn btn-sm" onclick="giSaveFormat()">フォーマット保存</button>
      <span style="flex:1"></span>
      <button class="btn" onclick="closeModal()">閉じる</button>
      <button class="btn btn-primary" onclick="runGenericImport()">取込実行</button>
    </div>`, { wide: true });
  _giHeaders = []; _giRows = []; _giMapping = [];
  giRefreshFormats();
}
function giRefreshFormats() {
  const sel = document.getElementById('gi-format'); if (!sel) return;
  sel.innerHTML = `<option value="">― 保存フォーマット ―</option>` + (store.data.importFormats || []).map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
}
// 列に無い項目の固定値（全行に適用）
function giFixedValues() {
  const f = {};
  for (const k of GI_FIXED_KEYS) { const e = document.getElementById('gi-fix-' + k); if (e && e.value) f[k] = e.value; }
  return f;
}
function giParse(text) {
  const mdLines = text.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  const raw = isMdTable(mdLines)
    ? mdLines.filter(l => !isMdSepRow(l)).map(splitMdRow)
    : (text.includes('\t') ? text.split(/\r?\n/).map(l => l.split('\t')) : parseCsvText(text));
  const rows = raw.filter(r => r.some(c => String(c).trim() !== ''));
  const mapDiv = document.getElementById('gi-map'), pvDiv = document.getElementById('gi-preview');
  if (!rows.length) { _giHeaders = []; _giRows = []; _giMapping = []; if (mapDiv) mapDiv.innerHTML = ''; if (pvDiv) pvDiv.innerHTML = ''; return; }
  _giHeaders = rows[0].map(h => String(h).trim());
  _giRows = rows.slice(1);
  _giMapping = _giHeaders.map(h => giAutoField(h));
  giRenderMap();
}
function giRenderMap() {
  const fieldOpt = (k, sel) => { const f = GI_FIELDS.find(x => x.key === k); return `<option value="${k}" ${sel === k ? 'selected' : ''}>${esc(f.label)}${f.req ? ' *' : ''}</option>`; };
  const opts = (sel) => `<option value="">（取込まない）</option>` + GI_GROUPS.map(g => `<optgroup label="${esc(g.g)}">${g.keys.map(k => fieldOpt(k, sel)).join('')}</optgroup>`).join('');
  const items = _giHeaders.map((h, i) => `<div class="field" style="min-width:170px;flex:0 0 auto">
    <label style="font-size:11px">${esc(h || '(空欄)')}</label>
    <select onchange="giSetMap(${i}, this.value)">${opts(_giMapping[i])}</select></div>`).join('');
  document.getElementById('gi-map').innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0">${items}</div>`;
  giRenderPreview();
}
function giSetMap(i, v) { _giMapping[i] = v; giRenderPreview(); }
function giRenderPreview() {
  const used = _giMapping.map((f, i) => ({ f, i })).filter(x => x.f);
  const fixed = giFixedValues();
  const needTicker = !_giMapping.includes('ticker');
  const needMarket = !_giMapping.includes('market') && !fixed.market;
  const warn = (needTicker || needMarket) ? `<div class="notice">${needTicker ? 'コード' : ''}${needTicker && needMarket ? '・' : ''}${needMarket ? '市場' : ''}の割当（市場は固定値でも可）が必要です。</div>` : '';
  const head = used.map(x => `<th class="l">${esc(GI_FIELDS.find(f => f.key === x.f).label)}</th>`).join('');
  const body = _giRows.slice(0, 5).map(r => `<tr>${used.map(x => `<td class="l">${esc(r[x.i] != null ? String(r[x.i]).trim() : '')}</td>`).join('')}</tr>`).join('');
  document.getElementById('gi-preview').innerHTML = warn + (used.length ? `<div class="muted" style="margin:0 0 4px">プレビュー（先頭5行 / 全${_giRows.length}行）</div><div class="table-wrap" style="max-height:200px"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` : '');
}
function giParseValue(field, raw) {
  const v = raw == null ? '' : String(raw).trim();
  switch (field) {
    case 'quantity': case 'avgCost': case 'acqValue': case 'acqJpy': case 'prevBuyPrice': case 'fixedBuyPrice': case 'baseHighManual': case 'buyAmount': case 'principalSoldAmount': case 'origBuyAmount':
    case 'targetPer': case 'targetPbr': case 'targetYield': case 'scenarioPrice':
      return numClean(v);
    // 株価シナリオ: レンジは「1000~1500」へ正規化。分析日は日付正規化（履歴の自然キーになるため表記を揃える）
    case 'stBear': case 'stBase': case 'stBull': case 'mtBear': case 'mtBase': case 'mtBull': return scNormRange(v);
    case 'scenarioDate': return normDate(v);
    case 'principalSold': return /売却|済|^1$|true|yes|○|有/i.test(v);
    case 'buyCount': case 'priority': { const n = parseInt(v, 10); return isNaN(n) ? null : n; }
    // ★評価は分析取込と同じ parseStars で「5」「★5」「★★★★★」いずれも数値化
    case 'starValuation': case 'starStrength': case 'starRisk': return parseStars(v);
    case 'enabled': return /有効|^1$|true|yes|○|有/i.test(v);
    case 'watch': return /注意|^1$|true|yes|○/i.test(v);
    case 'addonFromHigh': return /初回|^1$|true|yes|○|有/i.test(v);
    case 'baseHighMode': return normBaseHighMode(v);
    case 'account': return normAccount(v);
    case 'market': { const u = v.toUpperCase(); return (u === 'US' || u === 'JP') ? u : (/米/.test(v) ? 'US' : /日|国内/.test(v) ? 'JP' : /^\d/.test(v) ? 'JP' : 'US'); }
    case 'detailType': return /ETF|ＥＴＦ/i.test(v) ? 'ETF' : (v || null);
    case 'labels': return parseLabels(v); // 銘柄ラベル（; 区切り→配列）
    default: return v || null;
  }
}
// 新規追加される銘柄の確認モーダル。戻り: Set(取込しない 'market:ticker') / null=中止
function confirmNewSecurities(list) {
  return new Promise(resolve => {
    const rows = list.map(it => `<label class="check" style="display:flex;gap:8px;align-items:center;margin:4px 0">
      <input type="checkbox" class="cns-chk" data-key="${esc(it.market + ':' + it.ticker)}" checked style="width:auto">
      <span class="tag ${it.market.toLowerCase()}">${MARKET_LABEL[it.market]}</span><strong>${esc(it.ticker)}</strong>${it.name ? `<span class="muted">${esc(it.name)}</span>` : ''}
    </label>`).join('');
    showModal('新規追加される銘柄の確認', `
      <p class="muted" style="margin:0 0 8px">未登録の銘柄が ${list.length} 件あります。チェックを外した銘柄は取込しません（既存銘柄の更新はそのまま行われます）。</p>
      <div class="btn-row" style="margin:0 0 6px">
        <button type="button" class="btn btn-sm" onclick="document.querySelectorAll('.cns-chk').forEach(c=>c.checked=true)">全選択</button>
        <button type="button" class="btn btn-sm" onclick="document.querySelectorAll('.cns-chk').forEach(c=>c.checked=false)">全解除</button>
      </div>
      <div style="max-height:300px;overflow:auto">${rows}</div>
      <div class="form-actions">
        <button type="button" class="btn" onclick="__cnsResolve(false)">中止</button>
        <button type="button" class="btn btn-primary" onclick="__cnsResolve(true)">この内容で取込</button>
      </div>`);
    window.__cnsResolve = (ok) => {
      if (!ok) { closeModal(); resolve(null); return; }
      const skip = new Set();
      document.querySelectorAll('.cns-chk').forEach(c => { if (!c.checked) skip.add(c.dataset.key); });
      closeModal(); resolve(skip);
    };
  });
}
async function runGenericImport() {
  if (!_giRows.length) { toast('データがありません'); return; }
  const fixed = giFixedValues();
  if (!_giMapping.includes('ticker')) { toast('コードの割当が必要です'); return; }
  if (!_giMapping.includes('market') && !fixed.market) { toast('市場の割当（または固定値）が必要です'); return; }
  const create = document.getElementById('gi-create').checked;
  const mode = (document.getElementById('gi-mode') || {}).value || 'upsert';
  // マスタ管理項目（カテゴリ/格付/詳細種別/ルール）の未登録値を確認・変換（中止で全取込キャンセル）
  const giPairs = [];
  for (const row of _giRows) _giMapping.forEach((f, i) => { if (f && FIELD_DOMAIN[f]) giPairs.push({ field: f, raw: giParseValue(f, row[i]) }); });
  GI_FIXED_KEYS.forEach(k => { if (FIELD_DOMAIN[k] && fixed[k] != null && fixed[k] !== '') giPairs.push({ field: k, raw: fixed[k] }); });
  if (!(await ensureMasterConversions(giPairs))) { toast('取込を中止しました'); return; }
  // 追加と更新が混在する時は、新規作成される銘柄を一覧で確認（チェックを外した銘柄は取込しない・2026-08-25 すみぽん依頼）。
  // 全行が新規（初回取込）の時は確認を出さない＝従来どおり
  let skipNew = null; // Set('market:ticker')
  if (create && mode !== 'update') {
    const newList = []; const seen = new Set(); let hasExisting = false;
    for (const row of _giRows) {
      const rec = {};
      _giMapping.forEach((f, i) => { if (f === 'ticker' || f === 'market' || f === 'nameOverride') rec[f] = giParseValue(f, row[i]); });
      if ((rec.market == null || rec.market === '') && fixed.market) rec.market = giParseValue('market', fixed.market);
      const market = rec.market, ticker = (rec.ticker || '').toString().trim();
      if (!ticker || !market) continue;
      const tk = market === 'US' ? ticker.toUpperCase() : ticker;
      if (!validTicker(tk, market)) continue;
      if (store.findSecurity(market, tk)) { hasExisting = true; continue; }
      const key = market + ':' + tk;
      if (!seen.has(key)) { seen.add(key); newList.push({ market, ticker: tk, name: rec.nameOverride || '' }); }
    }
    if (newList.length && hasExisting) {
      skipNew = await confirmNewSecurities(newList);
      if (skipNew === null) { toast('取込を中止しました'); return; }
    }
  }
  // 洗い替え: 固定の証券会社×市場が必須。そのスコープの保有を先に削除
  // 洗い替えで消える取得円・投信評価額・売却前購入額は退避し、取込後に同一キーへ復元（削除前に退避）
  let removed = 0;
  let extras = null;
  if (mode === 'replace') {
    if (!fixed.broker || !fixed.market) { toast('洗い替えは「固定値」で証券会社と市場の指定が必要です'); return; }
    extras = snapshotHoldingExtras(store.data.holdings);
    const keep = [];
    for (const h of store.data.holdings) {
      const s = store.data.securities.find(x => x.id === h.securityId);
      if (s && h.broker === fixed.broker && s.market === fixed.market) { removed++; continue; }
      keep.push(h);
    }
    store.data.holdings = keep;
  }
  let updated = 0, created = 0, skipped = 0, holdingSet = 0, badFmt = 0;
  const touched = [];
  for (const row of _giRows) {
    const rec = {};
    _giMapping.forEach((f, i) => { if (f) rec[f] = giParseValue(f, row[i]); });
    // 列に無い項目は固定値で補完（列値が空の時のみ）
    for (const k of GI_FIXED_KEYS) { if (fixed[k] != null && (rec[k] == null || rec[k] === '')) rec[k] = giParseValue(k, fixed[k]); }
    // 約定価額→取得単価（単価未指定かつ株数あり）
    if (rec.avgCost == null && rec.acqValue != null && rec.quantity) rec.avgCost = rec.acqValue / rec.quantity;
    const market = rec.market, ticker = (rec.ticker || '').toString().trim();
    if (!ticker || !market) { skipped++; continue; }
    const tk = market === 'US' ? ticker.toUpperCase() : ticker;
    if (!validTicker(tk, market)) { badFmt++; continue; }   // 形式NG（日本株4桁/米国株大文字英字）は取込まない
    let sec = store.findSecurity(market, tk);
    if (!sec) {
      // 上書きのみモードは未登録を作らない（「新規作成」チェックより優先）
      if (!create || mode === 'update') { skipped++; continue; }
      // 新規追加の確認でチェックを外した銘柄は取込しない
      if (skipNew && skipNew.has(market + ':' + tk)) { skipped++; continue; }
      sec = store.addSecurity({ market, ticker: tk, currency: market === 'US' ? 'USD' : 'JPY', assetClass: 'stock', enabled: true, ruleId: store.defaultRule().id });
      created++;
    } else updated++;
    // 銘柄属性（割り当てた列だけ上書き）。マスタ管理項目は変換マスタで正規化／スキップ
    const patch = {};
    for (const k of Object.keys(rec)) {
      if (k === 'ruleName') { const rn = convMaster('ruleName', rec.ruleName); if (rn === SKIP) continue; const r = store.data.rules.find(x => x.name === rn); if (r) patch.ruleId = r.id; continue; }
      if (GI_SEC_FIELDS.has(k)) { const cv = convMaster(k, rec[k]); if (cv !== SKIP) patch[k] = cv; }
    }
    if (Array.isArray(rec.labels)) { ensureLabelDefs(rec.labels); patch.labels = rec.labels; } // 銘柄ラベル（配列・未登録はマスタ追加）
    if (Object.keys(patch).length) store.updateSecurity(sec.id, patch);
    // 株価シナリオはシナリオ分析日があれば履歴(priceScenarios)へ upsert→最新をミラー（割り当てた列だけ。
    // 分析日が無い行は平置きのみ＝上の patch で反映済み）
    if (patch.scenarioDate) {
      const scFields = {};
      for (const k of SCENARIO_FIELDS) if (k in patch) scFields[k] = patch[k];
      store.upsertScenario(sec.id, patch.scenarioDate, scFields);
      store.syncLatestScenario(sec.id);
    }
    // 保有・取得円・売却前購入額
    const hasQty = ('quantity' in rec) && rec.quantity != null;
    const hasAcq = ('acqJpy' in rec) && rec.acqJpy != null;
    const hasOrig = ('origBuyAmount' in rec) && rec.origBuyAmount != null;
    if (hasQty || hasAcq || hasOrig) {
      const broker = rec.broker || null, account = rec.account || '特定';
      if (broker) {
        const ex = store.data.holdings.find(x => x.securityId === sec.id && x.broker === broker && x.accountType === account);
        if (mode === 'append' && ex) { /* 追加モード: 既存はそのまま（上書きしない） */ }
        else if (mode === 'update' && !ex) { /* 上書きのみモード: 無い保有行（証券会社×口座）は作らない */ }
        else {
          if (hasQty) {
            const ac = rec.avgCost != null ? rec.avgCost : (ex ? ex.avgCost : 0);
            store.setHolding(sec.id, broker, account, rec.quantity, ac, 'import'); holdingSet++;
          }
          const h = store.data.holdings.find(x => x.securityId === sec.id && x.broker === broker && x.accountType === account);
          if (hasAcq && h) { h.acqJpy = rec.acqJpy; store.touch(h); }
          // 売却前購入額（保有単位）。数量が無くても保有レコードがあれば付与（損出しの本来額の記録）
          if (hasOrig && h) { h.origBuyAmount = rec.origBuyAmount; store.touch(h); }
        }
      } else if (hasAcq) {
        const hs = store.data.holdings.filter(x => x.securityId === sec.id && x.quantity > 0);
        if (hs.length === 1) { hs[0].acqJpy = rec.acqJpy; store.touch(hs[0]); holdingSet++; }
      }
    }
    touched.push(sec);
  }
  if (extras) restoreHoldingExtras(extras);  // 洗い替えで消えた取得円等を同一キーの保有へ復元
  // 洗い替え時のみ取込日時を記録（取込状況に反映。Webull等フォーマット無しの証券会社向け）
  if (mode === 'replace' && fixed.broker && fixed.market) {
    store.data.importHistory.unshift({
      id: store.nextId(), profile: 'generic', label: `汎用(${fixed.broker} ${MARKET_LABEL[fixed.market] || fixed.market})`,
      broker: fixed.broker, markets: [fixed.market], mode: 'replace', count: holdingSet,
      importedAt: new Date().toISOString(), baseDate: null,
    });
  }
  _convSession = {};
  store.save(); closeModal();
  reportImport(touched, `汎用取込: 更新 ${updated} / 新規 ${created}${holdingSet ? ` / 保有 ${holdingSet}` : ''}${removed ? ` / 洗い替え削除 ${removed}` : ''}${badFmt ? ` / 形式NG ${badFmt}件は取込まず` : ''}${skipped ? ` / スキップ ${skipped}` : ''}`);
}
function giSaveFormat() {
  const name = (document.getElementById('gi-format-name').value || '').trim();
  if (!name) { toast('フォーマット名を入力してください'); return; }
  if (!_giHeaders.length) { toast('先にデータを貼り付けてください'); return; }
  // 全列を保存する（取込まない列は '' で明示）。以前は割当のある列だけ保存していたため、
  // 「取込まないと決めた列」と「そもそも保存時に無かった列」を読込時に区別できなかった。
  const mapping = {};
  _giHeaders.forEach((h, i) => { mapping[h] = _giMapping[i] || ''; });
  const fixed = giFixedValues();
  const ex = store.data.importFormats.find(f => f.name === name);
  if (ex) { ex.mapping = mapping; ex.fixed = fixed; } else store.data.importFormats.push({ id: store.nextId(), name, mapping, fixed });
  store.save(); giRefreshFormats(); toast(`フォーマット「${name}」を保存しました`);
}
function giLoadFormat() {
  const id = parseInt(document.getElementById('gi-format').value, 10);
  const fmt = (store.data.importFormats || []).find(f => f.id === id);
  if (!fmt) { toast('フォーマットを選択してください'); return; }
  if (!_giHeaders.length) { toast('先にデータを貼り付けてください'); return; }
  // 列見出しは表記ゆれ（全角/半角・空白・★の有無）で一致しないことがある。正規化キーでも引き、
  // 保存フォーマットに無い見出し（列を足した・名前が変わった）は自動対応を残す。
  // ※以前は `fmt.mapping[h] || ''` だったため、見出しが少しでも違う列は自動対応ごと消えて
  //   「保存したのに読み込むと一部の列がリセットされる」ように見えていた。
  const mapN = {};
  for (const [k, v] of Object.entries(fmt.mapping || {})) { const nk = giHeaderKey(k); if (!(nk in mapN)) mapN[nk] = v; }
  let saved = 0, auto = 0;
  _giMapping = _giHeaders.map(h => {
    const hit = Object.prototype.hasOwnProperty.call(fmt.mapping || {}, h) ? fmt.mapping[h]
      : (giHeaderKey(h) in mapN ? mapN[giHeaderKey(h)] : undefined);
    if (hit !== undefined) { if (hit) saved++; return hit || ''; }
    const a = giAutoField(h);
    if (a) auto++;
    return a || '';
  });
  const fx = fmt.fixed || {};
  for (const k of GI_FIXED_KEYS) { const e = document.getElementById('gi-fix-' + k); if (e) e.value = fx[k] || ''; }
  giRenderMap();
  toast(`フォーマット「${fmt.name}」を適用（保存 ${saved}列${auto ? ` / 自動 ${auto}列` : ''}）`);
}
function giDeleteFormat() {
  const id = parseInt(document.getElementById('gi-format').value, 10);
  const fmt = (store.data.importFormats || []).find(f => f.id === id);
  if (!fmt) { toast('削除するフォーマットを選択'); return; }
  store.data.importFormats = store.data.importFormats.filter(f => f.id !== id);
  store.save(); giRefreshFormats(); toast(`「${fmt.name}」を削除しました`);
}

// 銘柄情報マスタ（名前・セクター・ファンダ）を全銘柄ぶん再取得（任意タイミング）
function refreshAllMeta() {
  const secs = store.data.securities.filter(s => s.ticker);
  if (!secs.length) { toast('銘柄がありません'); return; }
  withBusy('銘柄情報を更新中…（名前・セクター・時価総額・売買代金）', async () => {
    await api.refreshMeta(secs); await api.refreshCompany(secs, { force: true }); await api.checkSplits(); render();
  }, '銘柄情報を更新しました').catch(() => {});
}
// 分割タブ専用: 名前・株価・ファンダ等は取得せず、株式分割・併合の情報だけを再取得する軽量リフレッシュ
function refreshSplitsOnly() {
  const secs = store.data.securities.filter(s => s.ticker && s.market !== 'FUND');
  if (!secs.length) { toast('銘柄がありません'); return; }
  withBusy('分割情報を取得中…', async () => {
    await api.checkSplits(); render();
  }, '分割情報を更新しました').catch(() => {});
}

// ---------- 株式分割・併合タブ ----------
function fmtDate(iso) { return iso ? fmtDateTime(iso).slice(0, 10) : '—'; }
// 承認待ち（status=pending）件数
function pendingSplits() {
  const out = [];
  for (const s of store.data.securities) for (const h of (s.splitHistory || [])) {
    if (h.status === 'pending') out.push({ secId: s.id, date: h.date });
  }
  return out;
}
function splitStatusLabel(st) {
  return st === 'applied' ? '調整済' : st === 'recorded' ? '記録のみ' : st === 'skipped' ? 'スキップ' : '承認待ち';
}
// 調整対象（pending/recorded/skipped）を全銘柄から収集
function adjustableSplits() {
  const out = [];
  for (const s of store.data.securities) for (const h of (s.splitHistory || [])) {
    if (h.status === 'applied') continue;
    out.push({ sec: s, ...h });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  return out;
}
// 妥当性警告: 分割(r>1)は「単価が現在値の r 倍超」＝未分割の疑い。併合(r<1)は逆（単価が現在値の r 倍未満）
function splitOverRatio(val, price, r) {
  if (!val || !price || !r) return false;
  const ratio = val / price;
  return r >= 1 ? ratio > r + 1e-9 : ratio < r - 1e-9;
}
// 手入力項目が「未調整（分割日より前に入力＝分割前の値のまま）」か。手入力日で判定。
// 手入力日が無い旧データは判定不能なので安全側で「未調整(true)」扱い。
function manualUnadjusted(sec, date) {
  return sec.manualUpdatedAt ? fmtDate(sec.manualUpdatedAt) < date : true;
}
// 「手入力のみ」調整が要るか: 手入力項目（前回購入・手動高値）が未調整、または分割前の手動取引がある
// ※存在するだけでなく、手入力日が分割前（未調整）の時だけ対象（調整後に入力した値は二重調整しない）
function hasManualToAdjust(sec, date) {
  const hasManualField = (typeof sec.prevBuyPrice === 'number') || (typeof sec.baseHighManual === 'number') || (typeof sec.fixedBuyPrice === 'number');
  if (hasManualField && manualUnadjusted(sec, date)) return true;
  return store.data.transactions.some(t => t.securityId === sec.id && t.tradedAt && t.tradedAt < date);
}
// 既定モード推奨: 保有(取得単価)が分割前に入っていれば「全部」、保有は分割後でも手入力項目が未調整なら「手入力のみ」、何も無ければ「スキップ」
function recommendSplitMode(sec, date) {
  const hs = store.data.holdings.filter(h => h.securityId === sec.id);
  const holdingsPre = hs.some(h => h.quantity > 0 && (!h.updatedAt || fmtDate(h.updatedAt) < date)); // 分割前に入った保有がある
  if (holdingsPre) return 'full';
  if (hasManualToAdjust(sec, date)) return 'manual';
  return 'skip';
}
// 妥当性警告の理由（取得単価／前回購入単価 が現在値の r 倍を超過）
function splitWarnInfo(sec, r) {
  const price = calc.price(sec), th = calc.totalHolding(sec.id), reasons = [];
  if (splitOverRatio(th.avgCost, price, r)) reasons.push(`取得単価が現在値の${(th.avgCost / price).toFixed(1)}倍（分割${r}倍超・未分割の疑い）`);
  if (splitOverRatio(sec.prevBuyPrice, price, r)) reasons.push(`前回購入が現在値の${(sec.prevBuyPrice / price).toFixed(1)}倍（分割${r}倍超）`);
  return { warn: reasons.length > 0, reason: reasons.join(' / ') };
}
// 当該銘柄の代表的な保有（最新更新）
function latestHolding(secId) {
  return store.data.holdings.filter(h => h.securityId === secId)
    .sort((a, b) => ((a.updatedAt || '') < (b.updatedAt || '') ? 1 : -1))[0];
}
// 分割タブ: ①承認待ち（要対応）②履歴（過去の見直し用）
function splitTable(list, scope) {
  return `<div class="table-wrap"><table${scope ? ` id="sptbl-${scope}"` : ''}>
    <thead><tr><th class="l"><input type="checkbox" onchange="splitHistAll(this)"></th>
      <th class="l">分割日</th><th class="l">銘柄</th><th class="l">比率</th><th>取得単価</th><th>現在値</th>
      <th class="l">取込日</th><th class="l">手入力日</th><th class="l">警告</th><th class="l">状態</th><th class="l"></th></tr></thead>
    <tbody>${list.map(splitHistRow).join('')}</tbody>
  </table></div>`;
}
function renderSplitsTab() {
  const allHist = [];
  for (const s of store.data.securities) for (const h of (s.splitHistory || [])) allHist.push({ sec: s, ...h });
  allHist.sort((a, b) => (a.date < b.date ? 1 : -1));
  const pending = allHist.filter(h => h.status === 'pending');
  app.innerHTML = `
    <div class="section">
      <div class="section-head"><h2>株式分割・併合の承認待ち（${pending.length} 件）</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-sm" onclick="refreshSplitsOnly()" title="名前・株価等は取得せず、株式分割・併合の情報だけを再取得します">分割情報を再取得</button>
          ${pending.length ? `<button class="btn btn-primary btn-sm" onclick="openSplitAdjustChecked('sptbl-pending')">選択を調整</button>` : ''}
        </div></div>
      <div class="section-body">${pending.length === 0 ? '<div class="empty">承認待ちの分割はありません。</div>' : `
        <p class="muted" style="padding:10px 16px 0">警告(⚠)・取込日(分割日より<strong>前</strong>＝未調整の疑いは<span class="after-split">この色</span>)を確認し、調整するものにチェック→「選択を調整」。行の「調整」で個別も可。</p>
        ${splitTable(pending, 'pending')}`}
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>分割・併合の履歴（全銘柄）</h2>
        ${allHist.some(h => h.status !== 'applied') ? `<button class="btn btn-primary btn-sm" onclick="openSplitAdjustChecked('sptbl-hist')">選択を調整</button>` : ''}</div>
      <div class="section-body">${allHist.length === 0 ? '<div class="empty">履歴はありません。「価格更新」または「銘柄情報を更新」で検知します。</div>'
        : splitTable(allHist, 'hist')}
      </div>
    </div>`;
}
function splitHistRow(h) {
  const sec = h.sec, r = h.ratio, ccy = MARKET_CCY[sec.market];
  const th = calc.totalHolding(sec.id), price = calc.price(sec);
  const lh = latestHolding(sec.id);
  const w = splitWarnInfo(sec, r);
  const done = h.status === 'applied';
  // 取込日/手入力日が分割日より「前」なら黄色（＝分割前に入れたデータ＝未調整の疑い・要確認）
  const impCls = (lh && lh.updatedAt && fmtDate(lh.updatedAt) < h.date) ? 'after-split' : '';
  const manCls = (sec.manualUpdatedAt && fmtDate(sec.manualUpdatedAt) < h.date) ? 'after-split' : '';
  return `<tr>
    <td class="l">${done ? '' : `<input type="checkbox" class="split-hist-chk" data-sec="${sec.id}" data-date="${esc(h.date)}">`}</td>
    <td class="l">${esc(h.date)}</td>
    <td class="l">${esc(calc.displayName(sec))} <span class="muted">${esc(sec.ticker)}</span></td>
    <td class="l">${esc(h.label || ('×' + r))}</td>
    <td>${th.qty ? ccy + num(th.avgCost) : muted}</td>
    <td>${price != null ? ccy + num(price) : muted}</td>
    <td class="l ${impCls}">${lh ? `${fmtDate(lh.updatedAt)} ${lh.source === 'import' ? '取込' : '手入力'}` : muted}</td>
    <td class="l ${manCls}">${sec.manualUpdatedAt ? fmtDate(sec.manualUpdatedAt) : muted}</td>
    <td class="l">${w.warn ? `<span class="neg" title="${esc(w.reason)}">⚠ ${esc(w.reason)}</span>` : '—'}</td>
    <td class="l">${splitStatusLabel(h.status)}</td>
    <td class="l">${done ? '' : `<button class="btn btn-sm" onclick="openSplitAdjustOne(${sec.id},'${esc(h.date)}')">調整</button>`}</td>
  </tr>`;
}
// 全選択は同じテーブル内のチェックボックスのみ対象（承認待ち/履歴を取り違えない）
function splitHistAll(cb) { cb.closest('table').querySelectorAll('.split-hist-chk').forEach(c => { c.checked = cb.checked; }); }
function openSplitAdjustChecked(scope) {
  const root = (scope && document.getElementById(scope)) || document;
  const items = [...root.querySelectorAll('.split-hist-chk:checked')].map(c => ({ secId: parseInt(c.dataset.sec, 10), date: c.dataset.date }));
  openSplitAdjust(items);
}
function openSplitAdjustOne(secId, date) { openSplitAdjust([{ secId, date }]); }

// 一括調整モーダル（表形式・列分割・初期スキップ・左チェックは種別一括変更用）
function openSplitAdjust(items) {
  if (!items.length) { toast('調整する銘柄をチェックしてください'); return; }
  const MODE_LABEL = { full: '全部', manual: '手入力のみ', skip: 'スキップ' };
  const rows = items.map(it => {
    const sec = store.data.securities.find(s => s.id === it.secId); if (!sec) return '';
    const h = (sec.splitHistory || []).find(x => x.date === it.date); if (!h) return '';
    const r = h.ratio, ccy = MARKET_CCY[sec.market], price = calc.price(sec), th = calc.totalHolding(sec.id);
    const w = splitWarnInfo(sec, r);
    const hold = th.qty ? `${num(th.qty)} @${ccy}${num(th.avgCost)}<br><strong>→ ${num(th.qty * r)} @${ccy}${num(th.avgCost / r)}</strong>` : muted;
    const pbp = (typeof sec.prevBuyPrice === 'number') ? `${ccy}${num(sec.prevBuyPrice)}<br><strong>→ ${ccy}${num(sec.prevBuyPrice / r)}</strong>` : muted;
    const fbp = (typeof sec.fixedBuyPrice === 'number') ? `${ccy}${num(sec.fixedBuyPrice)}<br><strong>→ ${ccy}${num(sec.fixedBuyPrice / r)}</strong>` : muted;
    // 取込日/手入力日（分割日より前＝未調整の疑いは色付き。一覧と同じルール）
    const lh = latestHolding(sec.id);
    const impCls = (lh && lh.updatedAt && fmtDate(lh.updatedAt) < it.date) ? 'after-split' : '';
    const manCls = (sec.manualUpdatedAt && fmtDate(sec.manualUpdatedAt) < it.date) ? 'after-split' : '';
    const impCell = lh ? `${fmtDate(lh.updatedAt)} ${lh.source === 'import' ? '取込' : '手入力'}` : muted;
    const manCell = sec.manualUpdatedAt ? fmtDate(sec.manualUpdatedAt) : muted;
    const rec = recommendSplitMode(sec, it.date); // 推奨処理（専用列に表示。種別の初期値はスキップ固定）
    const o = (v, l) => `<option value="${v}">${l}</option>`;
    const recCell = rec === 'skip' ? `<span class="muted">${MODE_LABEL[rec]}</span>` : `<strong>${MODE_LABEL[rec]}</strong>`;
    return `<tr data-sec="${sec.id}" data-date="${esc(it.date)}" data-rec="${rec}">
      <td class="l"><input type="checkbox" class="sa-chk"></td>
      <td class="l"><strong>${esc(calc.displayName(sec))}</strong><br><span class="muted">${esc(sec.ticker)}</span></td>
      <td class="l">${esc(it.date)}<br><span class="muted">${esc(h.label || ('×' + r))}</span></td>
      <td>${price != null ? ccy + num(price) : muted}</td>
      <td class="l">${hold}</td>
      <td class="l">${pbp}</td>
      <td class="l">${fbp}</td>
      <td class="l ${impCls}">${impCell}</td>
      <td class="l ${manCls}">${manCell}</td>
      <td class="l">${w.warn ? `<span class="neg" title="${esc(w.reason)}">⚠ ${esc(w.reason)}</span>` : '—'}</td>
      <td class="l">${recCell}</td>
      <td class="l"><select class="sa-mode"><option value="skip" selected>スキップ</option>${o('full', '全部')}${o('manual', '手入力のみ')}</select></td>
    </tr>`;
  }).join('');
  showModal('株式分割・併合の一括調整', `
    <p class="muted">行ごとに「種別」を選んで「調整実行」（初期はスキップ＝何もしない）。<strong>全部</strong>＝保有も調整／<strong>手入力のみ</strong>＝前回購入価格などだけ調整。<br><span class="after-split">この色</span>＝取込日・手入力日が分割日より前（未調整の疑い）。⚠＝既に調整済みの可能性。迷ったら「推奨」列に従い、チェックして「選択行を→推奨→に一括変更」。</p>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0">
      <label class="check" style="margin:0"><input type="checkbox" id="sa-all" onchange="saSelectAll(this)"> 全選択</label>
      選択行を <select id="sa-bulk"><option value="reco">推奨</option><option value="full">全部</option><option value="manual">手入力のみ</option><option value="skip">スキップ</option></select>
      <button type="button" class="btn btn-sm" onclick="saApplyBulk()">に一括変更</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th class="l">☑</th><th class="l">銘柄</th><th class="l">分割日/比率</th><th>現在値</th><th class="l">保有(現→後)</th><th class="l">前回購入(現→後)</th><th class="l">買増固定値(現→後)</th><th class="l">取込日</th><th class="l">手入力日</th><th class="l">警告</th><th class="l">推奨</th><th class="l">種別</th></tr></thead>
      <tbody id="sa-rows">${rows}</tbody>
    </table></div>
    <div class="form-actions">
      <button type="button" class="btn" onclick="closeModal()">閉じる</button>
      <button type="button" class="btn btn-primary" onclick="runSplitAdjust()">調整実行</button>
    </div>`, { wide: true });
}
function saSelectAll(cb) { document.querySelectorAll('#sa-rows .sa-chk').forEach(c => { c.checked = cb.checked; }); }
function saApplyBulk() {
  const mode = document.getElementById('sa-bulk').value;
  document.querySelectorAll('#sa-rows tr').forEach(tr => {
    if (!tr.querySelector('.sa-chk').checked) return;
    // 「推奨」は行ごとに異なるため、その行の推奨処理(data-rec)を適用
    tr.querySelector('.sa-mode').value = (mode === 'reco') ? (tr.dataset.rec || 'skip') : mode;
  });
}
function runSplitAdjust() {
  let adj = 0, skip = 0;
  document.querySelectorAll('#sa-rows tr').forEach(tr => {
    const secId = parseInt(tr.dataset.sec, 10), date = tr.dataset.date, mode = tr.querySelector('.sa-mode').value;
    const sec = store.data.securities.find(s => s.id === secId);
    const h = sec && (sec.splitHistory || []).find(x => x.date === date); if (!h) return;
    if (mode === 'skip') { if (h.status === 'pending') { h.status = 'skipped'; store.save(); skip++; } }
    else { store.applySplit(secId, date, h.ratio, mode); adj++; }
  });
  closeModal(); render();
  toast(`調整 ${adj} 件${skip ? ` / スキップ ${skip} 件` : ''}`);
}

// ---------- データ管理 ----------
function exportData() {
  const blob = new Blob([JSON.stringify(dataBundle(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `securities-${today()}.json`;
  a.click();
  toast('データをJSONでダウンロードしました');
}
function importData() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json';
  inp.onchange = () => {
    const file = inp.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = async () => {
      try {
        const parsed = JSON.parse(r.result); // 先に検証（壊れたJSONなら復元前に弾く）
        // 置き換え前の現データをDriveへ1世代バックアップ（ログイン時のみ・best-effort）
        try { await dsync.makeBackup(JSON.stringify(dataBundle())); } catch (_) {}
        restoreBundle(parsed);
        // インポート＝この端末のデータを正本に戻す操作。同期基準点を消し、次回同期で
        // 取り込んだ全データを Drive へ反映（push）させる。base を残すと一部が削除扱いで消えうる。
        dsync._clearBase();
        render(); toast('インポートしました（列設定も復元）');
      }
      catch (_) { toast('JSONの読み込みに失敗しました'); }
    };
    r.readAsText(file);
  };
  inp.click();
}
async function resetData() {
  if (confirm('すべてのデータを削除して初期状態に戻します。よろしいですか？\n（誤削除対策として、削除前に現在のデータをJSONで自動ダウンロードします）')) {
    try { exportData(); } catch (_) { /* バックアップ失敗でも削除は続行 */ }
    // 破壊前にDriveへ1世代バックアップ（ログイン時のみ・best-effort。未ログインはローカルJSONで代替済み）
    try { await dsync.makeBackup(JSON.stringify(dataBundle())); } catch (_) {}
    localStorage.removeItem(STORAGE_KEY);
    // 同期の基準点(base)も消す。残すとローカルの「空」が3-wayマージで「全削除」と解釈され、
    // 次の自動同期で Drive と他端末まで空に上書きされてしまう（＝端末のローカル削除のつもりが全消失）。
    // base を消せば次回同期は base={} の新規扱いとなり Drive 側を保持（pull）する。
    dsync._clearBase();
    // IndexedDB 側の分析結果も消す（残すと次回起動時に読み戻されて「全削除」が不完全になる）
    if (idb.ok) { try { await idb.del('techAnalysis'); } catch (_) {} }
    store.data = null; store.load(); render();
    toast('全データを削除しました（バックアップJSONをダウンロード済み）');
  }
}
// マスタ（カテゴリ金額/ルール/銘柄マスタ＝securities・meta/各種設定）は残し、保有・取引など下部データだけ削除。
function resetTxnData() {
  if (!confirm('保有・取引データを削除します。\nカテゴリ金額マスタ・ルール・銘柄マスタ（銘柄の定義/属性）は残ります。\n（削除前に現在のデータをJSONで自動ダウンロードします）よろしいですか？')) return;
  try { exportData(); } catch (_) { /* バックアップ失敗でも続行 */ }
  store.data.holdings = [];
  store.data.transactions = [];
  store.data.importHistory = [];
  store.data.amountSnapshots = [];
  store.data.prices = {};
  store.data.indices = {};
  store.data.lastPriceUpdate = null;
  // 保持: securities(銘柄マスタ) / meta(名前・セクター等) / categories / rules / amountHistory /
  //       importMappings / importFormats / settings / fx(為替レートはキャッシュとして残す)
  store.save(); render();
  toast('保有・取引データを削除しました（マスタ・銘柄は保持）');
}

// ---------- 資産貼付用エクスポート（SEC-59）----------
// 『証券会社データ変換用.xlsm』の日本株/米国株 出力シート（12列）を本ツールから出力。
// 対象＝取込んだ証券会社データ（手入力は既定除外）。証券会社チェック＝取込バッチ選択。
const EXCEL_EXPORT_COLS = ['銘柄', 'コード', '種別', '詳細種別', '証券会社', '証券区分等', '通貨', '評価円', '評価ドル', '取得円', '取得ドル', '積立'];

// エクスポート対象になりうる保有（JP/US・数量>0）。
function excelExportHoldings() {
  return store.data.holdings.filter(h => {
    if (!(h.quantity > 0)) return false;
    const sec = store.data.securities.find(s => s.id === h.securityId);
    return sec && (sec.market === 'JP' || sec.market === 'US');
  });
}

// 取込単位＝取込プロファイル。SBIは米国株/日本株が別取込なので別単位、moomoo/楽天は一括なので1単位。
function holdingImportUnit(h, sec) {
  for (const [k, p] of Object.entries(IMPORT_PROFILES)) {
    if (p.fixed && p.scope && p.scope.broker === h.broker && p.scope.markets.includes(sec.market)) return k;
  }
  return 'broker:' + (h.broker || '—'); // 固定プロファイル無し（汎用取込/手入力）
}
function exportUnitLabel(key) {
  const p = IMPORT_PROFILES[key];
  return p ? p.label.replace(/（.*$/, '').trim() : key.replace(/^broker:/, '');
}
// プロファイル単位の最終取込日時
function lastImportByProfile() {
  const last = {};
  for (const e of (store.data.importHistory || [])) {
    const k = e.profile; if (!k) continue;
    if (!last[k] || (e.importedAt || '') > (last[k] || '')) last[k] = e.importedAt;
    // 汎用取込は取込単位キー(broker:〜)でも引けるようにする（エクスポートの取込単位表示用）
    if (e.broker) { const bk = 'broker:' + e.broker; if (!last[bk] || (e.importedAt || '') > (last[bk] || '')) last[bk] = e.importedAt; }
  }
  return last;
}

// 資産貼付用エクスポートの操作UI（転記タブ内にインライン表示）。
function excelExportControlsHtml() {
  const hs = excelExportHoldings();
  const units = [...new Set(hs.map(h => {
    const sec = store.data.securities.find(s => s.id === h.securityId);
    return sec ? holdingImportUnit(h, sec) : null;
  }).filter(Boolean))].sort();
  if (!units.length) return `<p class="muted">出力できる保有がありません。「マスタ・設定」で証券会社データを取り込むと表示されます。</p>`;
  const last = lastImportByProfile();
  const boxes = units.map(u => {
    const when = last[u]
      ? `<span class="muted" style="font-size:11px">（最終取込 ${fmtDateTime(last[u])}）</span>`
      : `<span class="neg" style="font-size:11px">（取込履歴なし）</span>`;
    return `<label style="display:inline-flex;align-items:center;gap:6px;margin:0 16px 8px 0">
      <input type="checkbox" class="xe-unit" value="${esc(u)}" checked> ${esc(exportUnitLabel(u))} ${when}</label>`;
  }).join('');
  return `
    <p class="muted" style="margin:0 0 10px">取込んだ証券会社データを、資産管理エクセルの日本株/米国株シート（12列）形式で出力します。
      貼り付けたい<strong>取込単位</strong>にチェックして「生成」。最終取込日時を見て、古い取込は外せます。</p>
    <div class="field"><label>取込単位（取込のまとまり）</label><div>${boxes}</div></div>
    <div class="row" style="align-items:center;gap:18px">
      <label style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" id="xe-manual"> 手入力の保有も含める</label>
      <label style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" id="xe-header"> ヘッダ行を含める</label>
    </div>
    <div class="form-actions" style="justify-content:flex-start">
      <button type="button" class="btn btn-primary" onclick="excelExportGenerate()">生成</button>
    </div>
    <div id="xe-out" style="margin-top:12px"></div>`;
}

// 詳細種別の自動判定（初期値用）: Yahoo種別(quoteType) > 名前のETF表記 > 個別株。
// 投信はツール対象外のため詳細種別は 個別株/ETF の2種のみ。
function autoDetailType(sec) {
  const qt = (calc.metaOf(sec).quoteType || '').toUpperCase();
  if (qt === 'ETF') return 'ETF';
  const name = calc.displayName(sec) || '';
  if (/ETF|ＥＴＦ/i.test(name)) return 'ETF';
  return '個別株';
}
// 出力に使う詳細種別: 銘柄ごとの保存値(detailType=マスタ)を優先。空なら自動判定を初期値として使用。
// → 誤判定は銘柄編集で詳細種別を選べば直せる（コード直書きに依存しない）。SEC-59
function detailTypeOf(sec) {
  return sec.detailType || autoDetailType(sec);
}

// 保有1件→出力1行（市場で評価/取得の入れ方を変える）。
function excelExportRow(h, sec) {
  const us = sec.market === 'US';
  const price = calc.price(sec);
  const valNative = (price != null ? price : h.avgCost) * h.quantity; // 価格未取得は取得原価で代替
  const r1 = (n) => n == null ? '' : Math.round(n);
  const r2 = (n) => n == null ? '' : Math.round(n * 100) / 100;
  return [
    calc.displayName(sec),                 // 銘柄
    sec.ticker,                            // コード
    MARKET_LABEL[sec.market],              // 種別（日本株/米国株）
    detailTypeOf(sec),                     // 詳細種別（ETF/投資信託/個別株を自動判定）
    h.broker || '',                        // 証券会社
    h.accountType || '',                   // 証券区分等
    us ? 'USD' : 'JPY',                    // 通貨
    us ? '' : r1(valNative),               // 評価円（日本株のみ）
    us ? r2(valNative) : '',               // 評価ドル（米国株のみ）
    us ? (h.acqJpy != null ? r1(h.acqJpy) : '') : r1(h.avgCost * h.quantity), // 取得円
    '',                                    // 取得ドル（現状の貼付に合わせ空欄）
    '',                                    // 積立（対象外）
  ];
}

function excelExportGenerate() {
  const checked = [...document.querySelectorAll('.xe-unit:checked')].map(c => c.value);
  const includeManual = document.getElementById('xe-manual').checked;
  const includeHeader = document.getElementById('xe-header').checked;
  const sheets = { JP: [], US: [] };
  for (const h of excelExportHoldings()) {
    const sec = store.data.securities.find(s => s.id === h.securityId);
    if (!sec || !checked.includes(holdingImportUnit(h, sec))) continue;
    if (!includeManual && h.source !== 'import') continue;
    sheets[sec.market].push(excelExportRow(h, sec));
  }
  // 安定ソート: 証券会社→コード
  for (const m of ['JP', 'US']) sheets[m].sort((a, b) => (a[4] + a[1]).localeCompare(b[4] + b[1], 'ja'));
  // 投資信託（保存済みFUND保有から。価格更新なし＝取込時の評価額/取得金額）
  const fundRows = [];
  for (const h of store.data.holdings) {
    if (!(h.quantity > 0)) continue;
    const sec = store.data.securities.find(s => s.id === h.securityId);
    if (!sec || sec.market !== 'FUND') continue;
    if (!includeManual && h.source !== 'import') continue;
    const p = store.data.prices['FUND:' + sec.ticker] || {};
    // 評価額は保有ごとの手入力(h.evalJpy)を優先。無ければ共有単価×口数で概算
    const evalJ = h.evalJpy != null ? Math.round(h.evalJpy) : (p.price != null ? Math.round(p.price * h.quantity) : '');
    const acqJ = Math.round((h.avgCost || 0) * h.quantity);
    fundRows.push([sec.name, sec.ticker || '', '投資信託', '投資信託', h.broker || '', h.accountType || '', 'JPY', evalJ, '', acqJ, '', '']);
  }
  fundRows.sort((a, b) => (a[4] + a[0]).localeCompare(b[4] + b[0], 'ja'));
  const block = (label, rows) => {
    const body = rows.map(r => r.join('\t')).join('\n');
    const text = includeHeader && rows.length ? EXCEL_EXPORT_COLS.join('\t') + '\n' + body : body;
    return `<div class="field" style="margin-top:8px">
      <label>${label}シート（${rows.length}件）　<button type="button" class="btn" style="padding:2px 10px"
        onclick="excelExportCopy('xe-ta-${label}')" ${rows.length ? '' : 'disabled'}>コピー</button></label>
      <textarea id="xe-ta-${label}" rows="${Math.min(12, Math.max(3, rows.length + (includeHeader ? 1 : 0)))}"
        style="width:100%;font-family:monospace;white-space:pre" readonly>${esc(text)}</textarea></div>`;
  };
  document.getElementById('xe-out').innerHTML =
    block('日本株', sheets.JP) + block('米国株', sheets.US) + (fundRows.length ? block('投資信託', fundRows) : '');
}

function excelExportCopy(id) {
  const ta = document.getElementById(id);
  if (!ta || !ta.value) { toast('コピーする内容がありません'); return; }
  ta.select();
  navigator.clipboard.writeText(ta.value).then(() => toast('コピーしました（Excelへ貼付）'),
    () => { try { document.execCommand('copy'); toast('コピーしました'); } catch (_) { toast('コピーに失敗しました'); } });
}

// 現金・銀行 転記（マネーフォワード）。株のエクスポートとは別操作。SEC-59
// 入力: タブ区切り「種類・名称␉残高␉保有金融機関␉…」（先頭ヘッダ行あり）。
// 出力: 12列。種別=現金 / 詳細種別=銀行 / 証券会社=金融機関 / 通貨=JPY / 評価円=残高。
function parseMfCash(text) {
  const out = [];
  for (const line of (text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = line.split('\t').map(s => s.trim());
    const name = f[0] || '';
    if (!name || /種類・名称/.test(name)) continue;        // ヘッダ行・空行はスキップ
    const bal = numClean(f[1]);                            // "2,035,314円" → 2035314
    if (bal == null) continue;                             // 残高が数値でない行はスキップ
    out.push({ name, balance: bal, inst: f[2] || '' });
  }
  return out;
}

// 現金・銀行 転記の操作UI（転記タブ内にインライン表示）。
function mfTransferControlsHtml() {
  return `
    <p class="muted" style="margin:0 0 10px">マネーフォワードの一覧をそのまま貼り付けて「変換」。
      資産管理エクセルへ貼る12列形式（種別=現金／詳細種別=銀行／通貨=JPY／評価円=残高）で出力します。
      ヘッダ行・空行は自動で無視します。</p>
    <div class="field"><label>貼り付け（種類・名称␉残高␉保有金融機関 …）</label>
      <textarea id="mf-text" rows="8" style="width:100%;font-family:monospace;font-size:12px"
        placeholder="種類・名称␉残高␉保有金融機関␉変更␉削除&#10;残高別普通預金残高␉2,035,314円␉三井住友銀行"></textarea></div>
    <div class="row" style="align-items:center;gap:18px">
      <label style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" id="mf-header"> ヘッダ行を含める</label>
    </div>
    <div class="form-actions" style="justify-content:flex-start">
      <button type="button" class="btn btn-primary" onclick="mfTransferGenerate()">変換</button>
    </div>
    <div id="mf-out" style="margin-top:12px"></div>`;
}

function mfTransferGenerate() {
  const items = parseMfCash(document.getElementById('mf-text').value);
  const includeHeader = document.getElementById('mf-header').checked;
  const rows = items.map(c => [
    c.name, '', '現金', '銀行', c.inst, '', 'JPY', Math.round(c.balance), '', '', '', '',
  ]);
  const body = rows.map(r => r.join('\t')).join('\n');
  const text = includeHeader && rows.length ? EXCEL_EXPORT_COLS.join('\t') + '\n' + body : body;
  const total = rows.reduce((s, r) => s + (r[7] || 0), 0);
  document.getElementById('mf-out').innerHTML = `<div class="field">
    <label>現金・銀行（${rows.length}件・合計 ${total.toLocaleString('ja-JP')}円）
      <button type="button" class="btn" style="padding:2px 10px" onclick="excelExportCopy('mf-ta')" ${rows.length ? '' : 'disabled'}>コピー</button></label>
    <textarea id="mf-ta" rows="${Math.min(14, Math.max(3, rows.length + (includeHeader ? 1 : 0)))}"
      style="width:100%;font-family:monospace;white-space:pre" readonly>${esc(text)}</textarea></div>`;
}

// 投資信託 転記（転記専用）。各社の保有一覧（投信部分）→ 12列の投資信託行。ツールには保存しない。SEC-59
// ヘッダから 評価額/取得金額/ファンド名 の列を検出し、セクション見出し(株式/投信・特定/NISA)で口座と対象を切替。
function detectFundHeader(cells) {
  const idx = {};
  cells.forEach((c, i) => {
    const t = String(c).trim();
    if (idx.name == null && /ファンド名|銘柄名称|^銘柄名$|^銘柄$|^ファンド$/.test(t)) idx.name = i;
    if (idx.acq == null && /取得金額|取得額/.test(t)) idx.acq = i;
    if (idx.eval == null && /(時価|概算|当日)?評価額(\[円\])?$/.test(t)) idx.eval = i;     // 概算評価額/当日評価額[円] 等も
    if (idx.pnl == null && /評価損益(\[円\])?$/.test(t)) idx.pnl = i;                    // 取得金額が無い時 評価額−損益 で算出
    if (idx.qty == null && /保有数量|保有口数|保有数|^数量$|口数/.test(t)) idx.qty = i;    // 口数（投信の数量。マネックスは「保有数」）
    if (idx.unitCost == null && /取得単価|平均取得(金額|価額)|取得価額/.test(t)) idx.unitCost = i; // 取得金額が無い時 単価×口数/10000 で算出
    if (idx.kind == null && /^種別$/.test(t)) idx.kind = i;                             // SBI明細: 行ごとの種別（投資信託判定）
    if (idx.code == null && /銘柄コード|ティッカー|^コード$/.test(t)) idx.code = i;
    if (idx.account == null && /口座|預り区分|口座区分/.test(t)) idx.account = i;
  });
  // SBI明細形式: 銘柄名の列見出しが無く コード列の次が名称 → name を補完
  if (idx.name == null && idx.kind != null && idx.code != null) idx.name = idx.code + 1;
  return (idx.eval != null && idx.name != null) ? idx : null;
}
// strict=true: 「明示的に投信と分かる行」だけ拾う（種別=投資信託 or 投信セクション見出しの下）。
//   証券会社CSVの自動仕分け用。種別列も投信見出しも無いCSV（moomoo等）を誤って全部投信扱いしないため。
// strict=false（既定）: 投信部分だけを貼る前提の転記・投信取込用。見出しが無くても投信として扱う。
function parseFundRows(text, opts = {}) {
  const strict = !!opts.strict;
  const rows = parseCsvText(text || '');
  let col = null, section = strict ? null : 'fund', acct = null;
  const out = [];
  for (const cells of rows) {
    const joined = cells.join('').trim();
    if (!joined) continue;
    // セクション/口座/合計の見出し行は「短い行(2セル以下)」のみで判定（データ行の銘柄名に"株式"等が含まれても誤検知しない）
    if (cells.length <= 2) {
      if (/投資信託[（(]/.test(joined)) { section = 'fund'; acct = /NISA/.test(joined) ? 'NISA' : /一般/.test(joined) ? '一般' : '特定'; }
      else if (/株式[（(]|債券[（(]/.test(joined)) { section = 'stock'; acct = /NISA/.test(joined) ? 'NISA' : /一般/.test(joined) ? '一般' : '特定'; }
      continue; // 合計・見出し行はデータにしない
    }
    // ヘッダ行
    const idx = detectFundHeader(cells);
    if (idx) { col = idx; continue; }
    if (!col) continue;
    // SBI明細形式（種別列あり）: 行の種別が「投資信託」の行だけを対象。それ以外はセクション判定（株式/投信）で対象を絞る
    if (col.kind != null) {
      if (!/投資信託|投信/.test(cells[col.kind] || '')) continue;
    } else if (section !== 'fund') continue;
    const name = (cells[col.name] || '').trim();
    const ev = numClean(cells[col.eval]);
    if (!name || ev == null) continue;
    const qty = col.qty != null ? numClean(cells[col.qty]) : null;
    // 取得金額: 取得金額列→（取得単価/平均取得金額×口数/10000）→（評価額−評価損益）の順で算出
    const acq = col.acq != null ? numClean(cells[col.acq])
      : (col.unitCost != null && qty ? (numClean(cells[col.unitCost]) || 0) * qty / 10000
        : (col.pnl != null ? ev - (numClean(cells[col.pnl]) || 0) : null));
    const account = (col.account != null && cells[col.account]) ? normAccount(cells[col.account]) : acct;
    out.push({ name, evalJpy: ev, acqJpy: acq, qty, account });
  }
  return out;
}
function fundTransferControlsHtml() {
  return `
    <p class="muted" style="margin:0 0 10px">各社の保有証券一覧（投信部分）を貼り付け→「変換」。評価額・取得金額をそのまま12列の投資信託行（種別・詳細種別＝投資信託）に変換します。口座は明細/見出し（特定・NISA）から自動判定、無ければ既定を使用。<strong>投信は買い増し判定・資産合計には含めません（転記専用）</strong>。</p>
    <div class="btn-row" style="align-items:flex-end">
      <div class="field" style="width:auto"><label style="font-size:11px">証券会社（必須）</label>
        <select id="fund-broker"><option value="">―</option>${BROKERS.map(b => `<option>${b}</option>`).join('')}</select></div>
      <div class="field" style="width:auto"><label style="font-size:11px">口座（明細に無い時の既定）</label>
        <select id="fund-account">${ACCOUNTS.map(a => `<option>${a}</option>`).join('')}</select></div>
      <label style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" id="fund-header"> ヘッダ行を含める</label>
    </div>
    <textarea id="fund-text" rows="7" style="width:100%;font-family:monospace;font-size:12px" placeholder="保有証券一覧（投信部分）をヘッダごと貼り付け"></textarea>
    <div class="btn-row"><button type="button" class="btn btn-primary" onclick="fundGenerate()">貼付データを変換</button>
      <button type="button" class="btn" onclick="fundTransferSavedGenerate()">保存済み投信を転記（取込済みデータから）</button></div>
    <div id="fund-out"></div>`;
}
function fundGenerate() {
  const broker = document.getElementById('fund-broker').value;
  if (!broker) { toast('証券会社を選択してください'); return; }
  const defAcct = document.getElementById('fund-account').value || '特定';
  const includeHeader = document.getElementById('fund-header').checked;
  const items = parseFundRows(document.getElementById('fund-text').value);
  const r1 = (n) => n == null ? '' : Math.round(n);
  // 取込済みの同名ファンドがあればそのコード（コードマスタの協会コード等）を補完（新規作成はしない）
  const fundCode = (name) => { const key = normFundName(name); const s = store.data.securities.find(x => x.market === 'FUND' && fundNameKeys(x).includes(key)); return s ? (s.ticker || '') : ''; };
  const rows = items.map(c => [c.name, fundCode(c.name), '投資信託', '投資信託', broker, c.account || defAcct, 'JPY', r1(c.evalJpy), '', r1(c.acqJpy), '', '']);
  const body = rows.map(r => r.join('\t')).join('\n');
  const text = includeHeader && rows.length ? EXCEL_EXPORT_COLS.join('\t') + '\n' + body : body;
  const total = rows.reduce((s, r) => s + (Number(r[7]) || 0), 0);
  document.getElementById('fund-out').innerHTML = `<div class="field">
    <label>投資信託（${rows.length}件・評価額合計 ${total.toLocaleString('ja-JP')}円）
      <button type="button" class="btn" style="padding:2px 10px" onclick="excelExportCopy('fund-ta')" ${rows.length ? '' : 'disabled'}>コピー</button></label>
    <textarea id="fund-ta" rows="${Math.min(14, Math.max(3, rows.length + (includeHeader ? 1 : 0)))}"
      style="width:100%;font-family:monospace;white-space:pre" readonly>${esc(text)}</textarea></div>`;
}

// ---------- 投信の取込（内部保持: 市場FUND） ----------
// 投信はコードが無いため、名称↔内部コードのマスタで補完（自動採番・銘柄マスタで編集可）
// ファンド名の正規化キー（全角→半角・空白除去・小文字化）。証券会社ごとの表記差を吸収して同一視
function normFundName(name) {
  return String(name || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}
// 既存FUND銘柄の最大連番＋1（内部コード自動採番）
function nextFundCode() {
  let max = 0;
  store.data.securities.forEach(s => { if (s.market === 'FUND') { const m = /^FND(\d+)$/.exec(s.ticker || ''); if (m) max = Math.max(max, +m[1]); } });
  return 'FND' + String(max + 1).padStart(3, '0');
}
// その投信が持つ全取込名（主名称＋証券会社ごとのエイリアス）の正規化キー一覧
function fundNameKeys(sec) {
  return [sec.name, ...(sec.aliasNames || [])].filter(Boolean).map(normFundName);
}
// 正規化名で既存FUND銘柄を検索し、無ければ新規作成（証券会社ごとの表記差で重複しない）
// 別表記の取込名は aliasNames に保持し、次回以降の取込でも同一ファンドに紐づける
function findOrCreateFund(name) {
  const key = normFundName(name); if (!key) return null;
  let sec = store.data.securities.find(s => s.market === 'FUND' && fundNameKeys(s).includes(key));
  if (sec) {
    if (normFundName(sec.name) !== key && !(sec.aliasNames || []).some(a => normFundName(a) === key)) {
      sec.aliasNames = [...(sec.aliasNames || []), name]; store.save();
    }
    return sec;
  }
  return store.addSecurity({ market: 'FUND', ticker: nextFundCode(), name, aliasNames: [], currency: 'JPY', assetClass: 'fund', enabled: false });
}
function openFundImport() {
  showModal('投資信託の取込', `
    <p class="muted" style="margin:0 0 12px">各社の保有一覧（投信部分）をヘッダごと貼り付け→取込。名称で内部コードを補完（マスタ管理）し、保有として内部保存します。<strong>価格更新なし・総資産には含めません</strong>。保有銘柄の「投資信託」で確認できます。</p>
    <form onsubmit="return false">
      <div class="row">
        <div class="field"><label>証券会社（必須）</label><select id="fi-broker"><option value="">―</option>${BROKERS.map(b => `<option>${b}</option>`).join('')}</select></div>
        <div class="field"><label>口座（明細に無い時の既定）</label><select id="fi-account">${ACCOUNTS.map(a => `<option>${a}</option>`).join('')}</select></div>
        <div class="field"><label>取込モード</label><select id="fi-mode"><option value="replace">この証券会社の投信を入れ替え</option><option value="append">追加・上書き</option></select></div>
      </div>
      <div class="field"><label>貼り付け（投信部分・ヘッダ含む）</label>
        <textarea id="fi-text" rows="8" style="width:100%;font-family:monospace;font-size:12px" placeholder="保有一覧の投信部分をヘッダごと貼り付け"></textarea></div>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
        <button type="button" class="btn btn-primary" onclick="runFundImport()">取込を実行</button>
      </div>
    </form>`, { wide: true });
}
function runFundImport() {
  const broker = (document.getElementById('fi-broker') || {}).value;
  if (!broker) { toast('証券会社を選択してください'); return; }
  const defAcct = (document.getElementById('fi-account') || {}).value || '特定';
  const mode = (document.getElementById('fi-mode') || {}).value || 'replace';
  const items = parseFundRows((document.getElementById('fi-text') || {}).value || '');
  if (!items.length) { toast('投信データを認識できませんでした（投信部分をヘッダごと貼り付けてください）'); return; }
  // 洗い替えで消える評価額(円)等は退避し、取込後に同一キーへ復元（取込データに評価額があればそちら優先）
  const extras = mode === 'replace' ? snapshotHoldingExtras(store.data.holdings) : null;
  if (mode === 'replace') {
    store.data.holdings = store.data.holdings.filter(h => { const s = store.data.securities.find(x => x.id === h.securityId); return !(s && s.market === 'FUND' && h.broker === broker); });
  }
  let n = 0;
  for (const it of items) {
    const sec = findOrCreateFund(it.name); if (!sec) continue;
    const q = (it.qty && it.qty > 0) ? it.qty : 1;
    const avgCost = it.acqJpy != null ? it.acqJpy / q : 0;
    store.setHolding(sec.id, broker, it.account || defAcct, q, avgCost, 'import');
    if (it.evalJpy != null) {
      store.data.prices['FUND:' + sec.ticker] = { price: it.evalJpy / q, prevClose: null, updatedAt: store._now() };
      const fh = store.data.holdings.find(x => x.securityId === sec.id && x.broker === broker && x.accountType === (it.account || defAcct));
      if (fh) fh.evalJpy = it.evalJpy; // 保有ごとの評価額
    }
    n++;
  }
  if (extras) restoreHoldingExtras(extras);
  store.save(); closeModal(); render();
  toast(`投信を ${n} 件取り込みました（${broker}）`, 4000);
}
// 保存済みの投信（FUND保有）を転記用フォーマットで出力
function fundSavedRows() {
  const out = [];
  for (const h of store.data.holdings) {
    if (!(h.quantity > 0)) continue;
    const s = store.data.securities.find(x => x.id === h.securityId);
    if (!s || s.market !== 'FUND') continue;
    const p = store.data.prices['FUND:' + s.ticker] || {};
    // 評価額は保有ごとの手入力(h.evalJpy)を優先。無ければ共有単価×口数で概算
    const evalJ = h.evalJpy != null ? Math.round(h.evalJpy) : (p.price != null ? Math.round(p.price * h.quantity) : null);
    const acqJ = Math.round((h.avgCost || 0) * h.quantity);
    out.push({ name: s.name, code: s.ticker || '', broker: h.broker, account: h.accountType, evalJpy: evalJ, acqJpy: acqJ });
  }
  return out;
}
function fundTransferSavedGenerate() {
  const items = fundSavedRows();
  if (!items.length) { toast('保存済みの投信がありません（「取込」タブの投信取込で取り込んでください）'); return; }
  const r1 = (n) => n == null ? '' : Math.round(n);
  const rows = items.map(c => [c.name, c.code || '', '投資信託', '投資信託', c.broker || '', c.account || '', 'JPY', r1(c.evalJpy), '', r1(c.acqJpy), '', '']);
  const includeHeader = (document.getElementById('fund-header') || {}).checked;
  const body = rows.map(r => r.join('\t')).join('\n');
  const text = includeHeader && rows.length ? EXCEL_EXPORT_COLS.join('\t') + '\n' + body : body;
  const total = rows.reduce((s, r) => s + (Number(r[7]) || 0), 0);
  document.getElementById('fund-out').innerHTML = `<div class="field">
    <label>保存済み投信（${rows.length}件・評価額合計 ${total.toLocaleString('ja-JP')}円）
      <button type="button" class="btn" style="padding:2px 10px" onclick="excelExportCopy('fund-ta')" ${rows.length ? '' : 'disabled'}>コピー</button></label>
    <textarea id="fund-ta" rows="${Math.min(14, Math.max(3, rows.length + (includeHeader ? 1 : 0)))}"
      style="width:100%;font-family:monospace;white-space:pre" readonly>${esc(text)}</textarea></div>`;
}

// 米国株 取得額(円) の一括取込（転記タブにインライン常設）。1行＝ティッカー＋取得額(円)〔＋証券会社〕。
function acqJpyControlsHtml() {
  return `
    <p class="muted" style="margin:0 0 10px">米国株保有の「取得円」を一括で設定します。1行に
      <strong>ティッカー</strong>と<strong>取得額(円)</strong>（任意で証券会社）を、タブ/カンマ/空白区切りで貼り付け。
      既存の米国株保有にティッカー（＋証券会社）で紐づけて上書きします（SBI取込済みなら自動算出されるため通常は不要）。</p>
    <textarea id="aj-text" rows="6" style="width:100%;font-family:monospace"
      placeholder="例）&#10;AAPL\t38060&#10;AMD\t21167\tSBI&#10;MPWR,14934"></textarea>
    <div class="form-actions" style="justify-content:flex-start">
      <button type="button" class="btn btn-primary" onclick="runAcqJpyImport()">設定する</button>
    </div>`;
}

function runAcqJpyImport() {
  const text = (document.getElementById('aj-text').value || '').trim();
  if (!text) { toast('入力がありません'); return; }
  let applied = 0, skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const toks = line.split(/[\t,\s]+/).filter(t => t !== '');
    const ticker = (toks.shift() || '').toUpperCase();
    const brokerTok = toks.find(t => BROKERS.includes(t));
    const amtTok = toks.find(t => t !== brokerTok && !isNaN(parseFloat(t.replace(/,/g, ''))));
    const amt = amtTok != null ? parseFloat(amtTok.replace(/,/g, '')) : NaN;
    if (!ticker || isNaN(amt)) { skipped++; continue; }
    const sec = store.data.securities.find(s => s.market === 'US' && s.ticker.toUpperCase() === ticker);
    if (!sec) { skipped++; continue; }
    let targets = store.data.holdings.filter(h => h.securityId === sec.id && h.quantity > 0);
    if (brokerTok) targets = targets.filter(h => h.broker === brokerTok);
    if (targets.length !== 1) { skipped++; continue; } // 一意に決まらない場合はスキップ
    targets[0].acqJpy = amt; store.touch(targets[0]); applied++;
  }
  store.save();
  toast(`取得額を設定: ${applied}件${skipped ? ` / スキップ ${skipped}` : ''}`);
  if (currentView === 'transfer') renderTransfer();
}

// ---------- 転記タブ（資産貼付用エクスポート ＋ 現金・銀行転記） ----------
function renderTransfer() {
  app.innerHTML = `
    <div class="section">
      <div class="section-head"><h2>取込状況（取込忘れ防止）</h2></div>
      <div class="section-body" style="padding:16px">
        <p class="muted" style="margin:0 0 10px">証券会社ごとの最終取込日時です。エクスポート前に「未取込」や古い日時がないか確認してください。</p>
        ${importStatusHtml()}
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>資産貼付用エクスポート（日本株・米国株・投資信託）</h2></div>
      <div class="section-body" style="padding:16px">${excelExportControlsHtml()}</div>
    </div>
    <div class="section">
      <div class="section-head"><h2>米国株 取得額(円) 一括取込</h2></div>
      <div class="section-body" style="padding:16px">${acqJpyControlsHtml()}</div>
    </div>
    <div class="section">
      <div class="section-head"><h2>現金・銀行 転記（マネーフォワード）</h2></div>
      <div class="section-body" style="padding:16px">${mfTransferControlsHtml()}</div>
    </div>
    <p class="muted" style="padding:0 4px">資産管理エクセルへの貼付専用です（保有データには影響しません）。証券会社データの取込・各種マスタは「マスタ・設定」タブで行います。</p>`;
}

// ---------- ユーティリティ ----------
// 時間帯による初期市場。平日8:00-18:00 JST=日本株(JP)、それ以外(夜間・週末)=米国株(US)。
// 端末のタイムゾーンに依存しないよう UTC+9 で JST を算出する。
function timeBasedMarket() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const day = jst.getUTCDay(), hour = jst.getUTCHours(); // JSTの曜日/時
  return (day >= 1 && day <= 5 && hour >= 8 && hour < 18) ? 'JP' : 'US';
}
function go(view) {
  // そのタブを開いたら NEW を解除する（マクロ＝経済指標 / ニュース＝動画）
  const kind = view === 'macro' ? 'macro' : view === 'news' ? 'video' : null;
  if (kind) updMarkSeen(kind);
  // ニュースの黄○はタブ移動→戻るでは消さない（消えるのはアプリ開き直し/リロード時と「更新」時のみ。
  // _newsSeenMark はセッション開始時の renderNews で一度だけ初期化される。すみぽん仕様 2026-07-23）
  currentView = view;
  try { sessionStorage.setItem('sm_view', view); } catch (_) {} // リロードで復元（開き直しはクリアされ dashboard）
  renderNav();
  render();
}
// 保有銘柄タブ内の US/JP 切替（列設定は市場ごとに保持）
function setHoldingsMarket(m) {
  holdingsMarket = m;
  if (currentView !== 'holdings') currentView = 'holdings';
  try { sessionStorage.setItem('sm_view', currentView); } catch (_) {} // 市場(m)は保存しない＝リロードで時間帯初期化
  renderNav();
  render();
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
// onclick 等のインライン属性内の単一引用符JS文字列に値を埋める用（\と'をJSエスケープ→HTMLエスケープ）
function jsq(s) { return esc(String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")); }
function num(n) { return n == null ? '—' : Number(n).toLocaleString('ja-JP', { maximumFractionDigits: 2 }); }
function yen(n) { return n == null ? '—' : '¥' + Math.round(n).toLocaleString('ja-JP'); }
function money(n, ccy) { return n == null ? '—' : ccy + Number(n).toLocaleString('ja-JP', { maximumFractionDigits: 2 }); }
// 一覧表示用フォーマッタ（通貨記号なし=SEC-44 / 表示桁=SEC-45）。内部値は変えず表示だけ丸める。
// 株価・金額: 米国株=小数2桁固定 / 日本株=整数。
// 整数表示の金額（買い増し予定額・推奨購入額用。小数不要）
function fmtAmtInt(n) { return n == null ? null : Number(n).toLocaleString('ja-JP', { maximumFractionDigits: 0 }); }
// 買い値の端数切捨て: 米株=1ドル単位（10ドル未満は0.1ドル）、日本株=円未満切捨て。
// 次回購入（買い増しライン）と目標指標からの逆算株価で共通に使う（表示がバラつかないよう1箇所に集約）。
function floorBuyPrice(v, market) {
  if (v == null || !isFinite(v)) return v;
  if (market === 'US') return v >= 10 ? Math.floor(v) : Math.floor(v * 10) / 10;
  return Math.floor(v);
}
function fmtAmt(n, market) {
  if (n == null) return null;
  if (market === 'US') return Number(n).toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // 日本株: 基本は整数表示。ただし小数を持つ値（買増固定値・端数のある単価等）は四捨五入で消さず最大2桁まで表示。
  return Number(n).toLocaleString('ja-JP', { maximumFractionDigits: 2 });
}
// 数量: 米国株=小数5桁固定 / 日本株=整数（ただしSMBC日興の端株など非整数は最大5桁表示）。
function fmtQty(n, market) {
  if (n == null) return null;
  if (market === 'US') return Number(n).toLocaleString('ja-JP', { minimumFractionDigits: 5, maximumFractionDigits: 5 });
  return Number.isInteger(n) ? Number(n).toLocaleString('ja-JP')
    : Number(n).toLocaleString('ja-JP', { maximumFractionDigits: 5 });
}
// 基準値に対する変化率(%)。base割れ=負。保有銘柄の各種「〜からの下落率」と共通（calc.dropFromもこれを使用）
function pctFromBase(price, base) { if (price == null || !base) return null; return (price - base) / base * 100; }
function signed(n) { return n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(2); }
function cls(n) { return n == null ? '' : (n > 0 ? 'pos' : (n < 0 ? 'neg' : '')); }
function today() { return new Date().toISOString().slice(0, 10); }
// 前営業日の日付(YYYY-MM-DD)。前日終値が「いつの引けか」の表示用（祝日は考慮しない近似）。
function prevBizDate() { const d = new Date(); do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6); return d.toISOString().slice(0, 10); }
// ===== 資産推移（積み上げ面グラフ） =====
// サーバー日次（byCategory/byMarket/byMarketType付き）＋取込済み過去（byMarket/byMarketType）を /api/portfolio-history
// から取得し、3軸（市場/市場+種別/カテゴリ）でスタック描画。取得原価の線を重ねる。
let assetAxis = 'market';   // 'market' | 'markettype' | 'category'
let assetPeriod = 'all';    // 'all' | '1y' | '6m' | '3m' | '1m'（チャートの表示期間）
let _assetSnaps = null;     // 取得した snapshots のキャッシュ（軸切替で再fetchしない）
let _chartHover = null;      // ホバーツールチップ用データ（assetStackChart が設定）
function setAssetAxis(a) {
  assetAxis = a;
  document.querySelectorAll('#asset-axis-seg button').forEach(b => b.classList.toggle('active', b.getAttribute('onclick') === `setAssetAxis('${a}')`));
  renderAssetTable();  // 先に表を確定（高さ固定）させてからグラフを残り高さに合わせる
  renderAssetChart();
}
function todayJst() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
// 米国東部時刻(ET)の暦日(YYYY-MM-DD)。米株の「営業日」はこれで変わる。
function todayEt() { const off = usDST(Date.now()) ? 4 : 5; return new Date(Date.now() - off * 3600 * 1000).toISOString().slice(0, 10); }
// 前日終値の再取得キー: JSTの暦日＋米国ETの暦日。どちらかの市場の暦日が変わったら取り直す。
// （米株はJST日中にET日付が変わる＝JST/UTC日付だけのガードだと、JST夜の米国市場オープン時に前日終値が1日古いまま固定される）
function prevCloseKey() { return todayJst() + '|' + todayEt(); }
async function loadPortfolioChart() {
  const el = document.getElementById('portfolio-chart'); if (!el) return;
  const note = (html) => { el.innerHTML = `<div class="notice" style="margin:0">${html}</div>`; };
  const token = (typeof gsync !== 'undefined' && gsync._token) ? gsync._token : null;
  if (!token) { _assetSnaps = null; el.style.height = ''; note('資産推移はGoogleログイン時に表示されます（総資産＝本人のみ閲覧可）。マスタ・設定からログインしてください。'); return; }
  // ③対策: グラフ領域の高さを先に確保＝表示の前後で下の表が動かない（プレースホルダもグラフも同じ高さ）。
  try { const rh = assetChartBox(el).h; el.style.height = rh + 'px'; el.style.minHeight = rh + 'px'; } catch (_) {}
  // ②対策: 取得済みスナップショットがあれば即描画＝再render時に「読み込み中…」へ戻る点滅を防ぐ。
  if (Array.isArray(_assetSnaps) && _assetSnaps.length >= 2) { try { renderAssetChart(); } catch (_) {} }
  // 履歴ファイルが無ければ作成（サーバーcronが書けるように）。※アプリはJSONには書かない（表示専用）。
  try { if (typeof dsync !== 'undefined' && gsync.hasDrive && gsync.hasDrive()) await dsync.ensureHistoryFile(); } catch (_) {}
  try {
    const res = await fetch('/api/portfolio-history', { headers: { Authorization: 'Bearer ' + token } });
    const d = await res.json();
    if (!res.ok || !d.ok) { note('資産推移を取得できませんでした：' + esc((d && d.error) || ('HTTP ' + res.status))); return; }
    _assetSnaps = (d.snapshots || []).map(normalizeSnapKeys).sort((a, b) => a.date < b.date ? -1 : 1);
    // 今日の点: アプリ内で価格更新した時刻が、その日の最後のcron取得(at)より新しければ、ライブ値を表示に重ねる
    // （JSONには保存しない＝表示専用）。価格未更新ならJSON＝cron値のまま。
    const tj = todayJst();
    const ti = _assetSnaps.findIndex(s => s.date === tj);
    const todayAt = ti >= 0 ? (Date.parse(_assetSnaps[ti].at || '') || 0) : 0;
    const lpu = store.data.lastPriceUpdate ? (Date.parse(store.data.lastPriceUpdate) || 0) : 0;
    const lpuJstDate = lpu ? new Date(lpu + 9 * 3600 * 1000).toISOString().slice(0, 10) : '';
    if (lpu && lpuJstDate === tj && lpu > todayAt) {
      const live = computeTodayBreakdown();
      if (live.totalJpy || live.costJpy) { if (ti >= 0) _assetSnaps[ti] = live; else { _assetSnaps.push(live); _assetSnaps.sort((a, b) => a.date < b.date ? -1 : 1); } }
    }
    renderAssetChart();
  } catch (e) { note('資産推移の取得に失敗しました: ' + esc(e && e.message || String(e))); }
}
// 旧データのラベル揺れを吸収: byMarketType の「…・個別」を「…・個別株」に正規化して統合（再取込不要で帯を1本に）。
function normalizeSnapKeys(s) {
  if (s && s.byMarketType) {
    const m = {};
    for (const k in s.byMarketType) { const nk = k.replace(/・個別$/, '・個別株'); m[nk] = (m[nk] || 0) + (s.byMarketType[k] || 0); }
    s.byMarketType = m;
  }
  return s;
}
// 今日の内訳つきスナップショットをライブのstore.dataから計算（サーバー computeBreakdowns と同じラベル規則）。
function computeTodayBreakdown() {
  let totalJpy = 0, costJpy = 0;
  const byCategory = {}, byMarket = {}, byMarketType = {};
  const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };
  for (const sec of store.data.securities) {
    if (sec.market !== 'JP' && sec.market !== 'US') continue;
    if (calc.totalHolding(sec.id).qty <= 0) continue;
    const vj = calc.toJpy(sec.market, calc.valueOrCostNative(sec) || 0);
    if (vj == null) continue; // 為替未取得の米株は除外
    const cj = calc.toJpy(sec.market, calc.costNative(sec) || 0) || 0;
    const v = Math.round(vj), c = Math.round(cj);
    totalJpy += v; costJpy += c;
    const mk = sec.market === 'JP' ? '日本株' : '米国株';
    const isETF = detailTypeOf(sec) === 'ETF';
    add(byCategory, isETF ? 'ETF' : (sec.category || '未分類'), v); // ETFはカテゴリを持たないので別バンド
    add(byMarket, mk, v);
    add(byMarketType, `${mk}・${isETF ? 'ETF' : '個別株'}`, v);
  }
  return { date: todayJst(), at: new Date().toISOString(), totalJpy: Math.round(totalJpy), costJpy: Math.round(costJpy), byCategory, byMarket, byMarketType };
}
function setAssetPeriod(p) {
  assetPeriod = p;
  document.querySelectorAll('#asset-period-seg button').forEach(b => b.classList.toggle('active', b.getAttribute('onclick') === `setAssetPeriod('${p}')`));
  renderAssetTable(); // 期間損益の比較対象も連動して更新（先に表を確定させてからグラフを残り高さに合わせる）
  renderAssetChart();
}
function renderAssetChart() {
  const el = document.getElementById('portfolio-chart'); if (!el) return;
  let snaps = _assetSnaps || [];
  // 表示期間でフィルタ（全期間/1年/6ヶ月/3ヶ月/1ヶ月）
  if (assetPeriod !== 'all' && snaps.length) {
    const months = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 }[assetPeriod];
    if (months) { const cut = new Date(); cut.setMonth(cut.getMonth() - months); const cs = cut.toISOString().slice(0, 10); snaps = snaps.filter(s => s.date >= cs); }
  }
  if (snaps.length < 2) { el.innerHTML = `<div class="notice" style="margin:0">資産推移は2日分以上たまると表示されます（現在 ${snaps.length} 日分・この期間）。毎朝サーバーが日次記録。過去は下の「過去データの取込」で一括投入できます。</div>`; return; }
  el.classList.remove('muted');
  // プレースホルダの中央寄せ(display:flex;justify-content:center)が残るとグラフのflexが潰れて極小になるため、block に戻す
  el.style.display = 'block'; el.style.alignItems = ''; el.style.justifyContent = ''; el.style.minHeight = '';
  const { w, h } = assetChartBox(el);
  el.style.height = h + 'px'; // 高さを固定＝期間/軸トグルやグラフ更新でも下の表が動かない
  el.innerHTML = assetStackChart(snaps, assetAxis, w, h);
  attachChartHover(el); // カーソルで日付・分類別評価額・合計を表示
  // 収まり補正: assetChartBox の余白見積りが甘いと main.content がはみ出す（＝下に余白が出てスクロール要に）。
  // 実測のはみ出し量だけグラフを縮めて1回だけ再描画し、ぴったり窓に収める（窓が小さく180pxを切る時はスクロール許容）。
  if (!_assetChartFitting) {
    const main = el.closest('.content');
    if (main) {
      const overflow = main.scrollHeight - main.clientHeight;
      if (overflow > 2 && h - overflow >= 180) {
        _assetChartFitting = true;
        const h2 = h - overflow;
        el.style.height = h2 + 'px';
        el.innerHTML = assetStackChart(snaps, assetAxis, w, h2);
        attachChartHover(el);
        _assetChartFitting = false;
      }
    }
  }
}
let _assetChartFitting = false;
// グラフを「上部サマリ＋トグル＋グラフ＋表」がスクロールせず収まる範囲で最大サイズにする。
// 高さ＝スクロール領域の下端 − グラフ上端 − 表の高さ（最も行数の多いカテゴリ別に固定済み）− 余白。
// 幅は SVG が width:100% で容器幅に追従するので、容器幅(=凡例132+gap10を除く)を W に渡してアスペクト比＝高さを決める。
function assetChartBox(el) {
  const cont = el.closest('.content') || document.documentElement;
  const bottom = cont.getBoundingClientRect().bottom;   // スクロール領域(main.content)の見える下端
  const top = el.getBoundingClientRect().top;            // グラフ上端
  const tableEl = document.getElementById('asset-table');
  const tableH = tableEl ? (parseFloat(tableEl.style.minHeight) || tableEl.getBoundingClientRect().height || 0) : 0;
  // グラフの下にある「過去データの取込」details も差し引く（これを忘れると合計行が窓からはみ出てページがスクロールする）
  const details = el.parentElement ? el.parentElement.querySelector('details') : null;
  const detailsH = details ? details.getBoundingClientRect().height : 0;
  const avail = bottom - top - tableH - detailsH - 26; // 表margin-top(12)＋details上余白＋section下padding(16)
  const h = Math.max(180, Math.min(720, Math.round(avail)));
  const w = Math.max(240, Math.round((el.clientWidth || 600) - 142)); // 凡例132＋gap10
  return { w, h };
}
const ASSET_COLORS = ['#f59e0b', '#0d9488', '#7c3aed', '#0891b2', '#65a30d', '#db2777', '#ca8a04', '#0ea5e9', '#9333ea', '#e11d48'];
const ASSET_NONE = '（内訳なし）';
// 色: 米株=青系/日本株=赤系（種別は濃淡）、ETF=スレート、カテゴリは ASSET_COLORS。
function assetKeyColor(k, ki) {
  const M = {
    '米国株': '#2563eb', '日本株': '#dc2626',
    '米国株・ETF': '#60a5fa', '米国株・個別株': '#1e40af',
    '日本株・ETF': '#f87171', '日本株・個別株': '#991b1b',
    'ETF': '#64748b', '個別株': '#0d9488', 'その他': '#a8a29e', '未分類': '#a8a29e', [ASSET_NONE]: '#94a3b8',
  };
  return M[k] || ASSET_COLORS[ki % ASSET_COLORS.length];
}
// 積み上げ順（配列先頭=最下層）。市場/市場+種別は固定順、カテゴリはETF最下層→額大きい順→内訳なし最上。
function assetOrderKeys(keys, axis, sums) {
  const withPref = (pref) => pref.filter(k => keys.includes(k)).concat(keys.filter(k => !pref.includes(k)).sort((a, b) => (sums[b] || 0) - (sums[a] || 0)));
  if (axis === 'market') return withPref(['米国株', '日本株']);
  if (axis === 'markettype') return withPref(['米国株・ETF', '日本株・ETF', '米国株・個別株', '日本株・個別株']);
  return keys.slice().sort((a, b) => { const r = (k) => k === 'ETF' ? -2 : k === ASSET_NONE ? 2 : 0; return r(a) !== r(b) ? r(a) - r(b) : (sums[b] || 0) - (sums[a] || 0); });
}
function assetStackChart(snaps, axis, W, H) {
  W = W || 800; H = H || 280; const pad = { l: 62, r: 12, t: 8, b: 20 };
  const keyOf = { category: 'byCategory', market: 'byMarket', markettype: 'byMarketType' }[axis] || 'byMarket';
  const NONE = ASSET_NONE;
  // この軸の内訳。無い場合: カテゴリ軸は byMarketType から ETF/個別株 を導出（過去データ用）、それも無ければ総資産1本。
  const breakdownAt = (s) => {
    const b = s[keyOf]; if (b && Object.keys(b).length) return b;
    if (keyOf === 'byCategory' && s.byMarketType && Object.keys(s.byMarketType).length) {
      const o = {}; for (const k in s.byMarketType) { const e = /ETF$/.test(k) ? 'ETF' : 'その他'; o[e] = (o[e] || 0) + s.byMarketType[k]; } return o;
    }
    return { [NONE]: s.totalJpy || 0 };
  };
  const sums = {};
  snaps.forEach(s => { const b = breakdownAt(s); for (const k in b) sums[k] = (sums[k] || 0) + (b[k] || 0); });
  const keys = assetOrderKeys(Object.keys(sums), axis, sums);
  const colorOf = (k, ki) => assetKeyColor(k, ki);
  const xs = snaps.map(s => Date.parse(s.date) / 1000);
  const dmax = Math.max(1, ...snaps.map(s => Math.max(s.totalJpy || 0, s.costJpy || 0)));
  const stepY = niceStep(dmax || 1, 5), ymax = Math.ceil(dmax / stepY) * stepY;
  const xmin = xs[0], xmax = xs[xs.length - 1];
  const px = t => pad.l + (xmax === xmin ? 0 : (t - xmin) / (xmax - xmin)) * (W - pad.l - pad.r);
  const py = v => pad.t + (1 - v / ymax) * (H - pad.t - pad.b);
  // 金額表記: 億/万＋カンマで見やすく
  const yfmt = (v) => v === 0 ? '0' : v >= 1e8 ? (Math.round(v / 1e7) / 10) + '億' : Math.round(v / 1e4).toLocaleString('ja-JP') + '万';
  // 積み上げ面（先に描いて、グリッド/線/ラベルを上に重ねる）
  const cum = snaps.map(() => 0); let bands = '';
  keys.forEach((k, ki) => {
    const top = snaps.map((s, i) => cum[i] + (breakdownAt(s)[k] || 0));
    const up = snaps.map((s, i) => `${px(xs[i]).toFixed(1)},${py(top[i]).toFixed(1)}`).join(' ');
    const dn = snaps.map((s, i) => `${px(xs[i]).toFixed(1)},${py(cum[i]).toFixed(1)}`).reverse().join(' ');
    bands += `<polygon points="${up} ${dn}" fill="${colorOf(k, ki)}" fill-opacity="0.82"/>`;
    snaps.forEach((s, i) => { cum[i] = top[i]; });
  });
  // Yグリッド（バンドの上に薄く）＋左の金額ラベル
  let grid = '', ylab = '';
  for (let v = 0; v <= ymax + 1e-6; v += stepY) { const y = py(v).toFixed(1); grid += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="rgba(100,116,139,.28)"/>`; ylab += `<text x="${pad.l - 6}" y="${(+y + 3).toFixed(1)}" fill="var(--muted)" font-size="10" text-anchor="end">${yfmt(v)}</text>`; }
  // X: 月初を範囲全体に生成し ~8本に間引いて等間隔表示（データ位置でなく時間軸の等間隔）
  const months = []; { const d0 = new Date(xmin * 1000); let cur = new Date(d0.getFullYear(), d0.getMonth(), 1).getTime() / 1000; while (cur <= xmax + 1) { months.push(cur); const dd = new Date(cur * 1000); cur = new Date(dd.getFullYear(), dd.getMonth() + 1, 1).getTime() / 1000; } }
  const stepM = Math.max(1, Math.ceil(months.length / 8));
  let xlab = '';
  months.forEach((t, i) => { if (i % stepM) return; const dt = new Date(t * 1000); const x = px(t).toFixed(1); xlab += `<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${H - pad.b}" stroke="rgba(100,116,139,.2)" stroke-dasharray="2 3"/><text x="${x}" y="${H - pad.b + 14}" fill="var(--muted)" font-size="9" text-anchor="middle">${dt.getMonth() === 0 || i === 0 ? dt.getFullYear() + '/' : ''}${dt.getMonth() + 1}</text>`; });
  const hasCost = snaps.some(s => s.costJpy);
  const costLine = hasCost ? `<path d="${snaps.map((s, i) => (i ? 'L' : 'M') + px(xs[i]).toFixed(1) + ' ' + py(s.costJpy || 0).toFixed(1)).join(' ')}" fill="none" stroke="#111827" stroke-width="1.4" stroke-dasharray="5 3"/>` : '';
  // 凡例＝チャート右に縦並び（軸を切替えても本体グラフの幅・高さは変わらない）。最新サマリは上部カードと重複のため省略。
  const legend = keys.slice().reverse().map((k) => { const ki = keys.indexOf(k); return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:11px"><span style="width:11px;height:11px;flex:0 0 11px;background:${colorOf(k, ki)};border-radius:2px"></span><span style="word-break:break-all">${esc(k)}</span></div>`; }).join('')
    + (hasCost ? `<div style="display:flex;align-items:center;gap:6px;font-size:11px;margin-top:2px"><span style="width:16px;flex:0 0 16px;border-top:2px dashed #111827"></span>取得原価</div>` : '');
  // ホバー時にカーソル位置の日付・分類別評価額・合計を表示するためのデータを保持（attachChartHover が参照）
  _chartHover = { snaps, keys, breakdownAt, colorOf, hasCost, px, W, H, pad, xmin, xmax };
  // ガイド線（縦）とツールチップ枠を初期非表示で重ねる。ガイドは bands の上に描くため最後に置く。
  const guide = `<line id="asset-chart-guide" x1="0" y1="${pad.t}" x2="0" y2="${H - pad.b}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>`;
  return `<div style="display:flex;gap:10px;align-items:flex-start">
    <div style="flex:1;min-width:0;position:relative">
      <svg id="asset-chart-svg" viewBox="0 0 ${W} ${H}" width="100%" style="display:block;background:var(--panel);border:1px solid var(--border);border-radius:8px;cursor:crosshair">${bands}${grid}${xlab}${ylab}${costLine}${guide}</svg>
      <div id="asset-chart-tip" style="position:absolute;display:none;pointer-events:none;z-index:5;top:8px;background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:7px 9px;font-size:11px;line-height:1.5;box-shadow:0 2px 10px rgba(0,0,0,.18);white-space:nowrap"></div>
    </div>
    <div style="flex:0 0 132px;width:132px">${legend}</div>
  </div>`;
}
// グラフ上のマウス/タッチ移動で、カーソル位置の日付・分類別評価額・合計をツールチップ表示する。
// 値はカーソル日（時間軸を日単位に丸めた日付）以前で最新のスナップショットから取る（その日にデータが無ければ前のデータ）。
function attachChartHover(el) {
  const h = _chartHover; if (!h) return;
  const svg = el.querySelector('#asset-chart-svg');
  const tip = el.querySelector('#asset-chart-tip');
  const guide = el.querySelector('#asset-chart-guide');
  if (!svg || !tip || !guide) return;
  const wrap = svg.parentElement;
  const move = (clientX) => {
    const rect = svg.getBoundingClientRect(); if (!(rect.width > 0)) return;
    const sx = (clientX - rect.left) * (h.W / rect.width); // 画面px → SVG座標
    const frac = h.xmax === h.xmin ? 0 : (sx - h.pad.l) / (h.W - h.pad.l - h.pad.r);
    const t = h.xmin + Math.max(0, Math.min(1, frac)) * (h.xmax - h.xmin);
    const dayTs = Math.round(t / 86400) * 86400; // データ範囲内で日単位に丸める
    const cursorDate = new Date(dayTs * 1000).toISOString().slice(0, 10);
    // カーソル日以前で最新のスナップショット（無ければ最古）
    let snap = h.snaps[0];
    for (const s of h.snaps) { if (Date.parse(s.date) / 1000 <= dayTs + 1) snap = s; else break; }
    const b = h.breakdownAt(snap);
    // 数字を等幅(tabular-nums)＋右寄せにして、同じ桁数なら桁位置が縦に揃うようにする
    const numStyle = 'margin-left:12px;text-align:right;font-family:\'SFMono-Regular\',Consolas,\'Roboto Mono\',Menlo,monospace';
    const rows = h.keys.slice().reverse().map((k) => {
      const v = b[k] || 0; if (!v) return '';
      return `<div style="display:flex;align-items:center;gap:6px"><span style="width:9px;height:9px;flex:0 0 9px;border-radius:2px;background:${h.colorOf(k, h.keys.indexOf(k))}"></span><span style="flex:1">${esc(k)}</span><span style="font-weight:600;${numStyle}">${num(Math.round(v))}円</span></div>`;
    }).join('');
    const total = snap.totalJpy || h.keys.reduce((a, k) => a + (b[k] || 0), 0);
    const costRow = (h.hasCost && snap.costJpy) ? `<div style="display:flex;gap:6px;color:var(--muted)"><span style="flex:1">取得原価</span><span style="${numStyle}">${num(Math.round(snap.costJpy))}円</span></div>` : '';
    tip.innerHTML = `<div style="font-weight:700;margin-bottom:3px">${cursorDate}</div>${rows}<div style="display:flex;gap:6px;margin-top:3px;border-top:1px solid var(--border);padding-top:3px;font-weight:700"><span style="flex:1">合計</span><span style="${numStyle}">${num(Math.round(total))}円</span></div>${costRow}`;
    const gx = h.px(dayTs);
    guide.setAttribute('x1', gx.toFixed(1)); guide.setAttribute('x2', gx.toFixed(1));
    guide.style.display = '';
    tip.style.display = 'block';
    const gxPx = (gx / h.W) * rect.width; // SVG座標 → wrap内px
    const tipW = tip.offsetWidth;
    let left = gxPx + 12;
    if (left + tipW > rect.width) left = gxPx - tipW - 12; // 右端で見切れるなら左側へ
    tip.style.left = Math.max(0, left) + 'px';
  };
  const hide = () => { tip.style.display = 'none'; guide.style.display = 'none'; };
  svg.addEventListener('mousemove', (e) => move(e.clientX));
  svg.addEventListener('mouseleave', hide);
  svg.addEventListener('touchmove', (e) => { if (e.touches[0]) { move(e.touches[0].clientX); e.preventDefault(); } }, { passive: false });
  svg.addEventListener('touchend', hide);
}
// 過去の資産明細（1銘柄×日付）を貼り付け→日付別に集計→portfolio-history.json へ統合。
// 必要列: 日付 / 種別(日本株|米国株) / 詳細種別(ETF→ETF・他→個別) / 評価額(or評価円) / 取得額(or取得円)。
// ※米国株は「評価円」が空で円換算は「評価額」(¥付き)に入るため、評価額/取得額を優先して使う。
function aggregateAssetRows(text) {
  const rows = parsePasted(text);
  if (rows.length < 2) return { error: '行が足りません（ヘッダ＋明細を貼り付けてください）' };
  const idx = {}; rows[0].forEach((h, i) => { idx[String(h == null ? '' : h).trim()] = i; });
  const valCol = idx['評価額'] != null ? idx['評価額'] : idx['評価円'];
  const costCol = idx['取得額'] != null ? idx['取得額'] : idx['取得円'];
  if (idx['日付'] == null || valCol == null) return { error: '「日付」と「評価額（または評価円）」の列が見つかりません（ヘッダ行も含めて貼り付けてください）' };
  const byDate = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const d = normDate(String(row[idx['日付']] == null ? '' : row[idx['日付']]).trim());
    if (!d) continue;
    const val = numClean(row[valCol]) || 0;
    if (!val) continue;
    const shu = idx['種別'] != null ? String(row[idx['種別']] || '').trim() : '';
    const market = shu === '日本株' ? 'JP' : shu === '米国株' ? 'US' : null;
    if (!market) continue; // 日本株・米国株以外（投信・現金等）は集計しない
    const cost = costCol != null ? (numClean(row[costCol]) || 0) : 0;
    const dt = idx['詳細種別'] != null ? String(row[idx['詳細種別']] || '').trim() : '';
    const type = /ETF|ＥＴＦ/i.test(dt) ? 'ETF' : '個別株'; // 「個別株」表記に統一（既存集計と一致）
    const s = byDate[d] || (byDate[d] = { date: d, totalJpy: 0, costJpy: 0, byMarket: {}, byMarketType: {} });
    s.totalJpy += val; s.costJpy += cost;
    const mk = market === 'JP' ? '日本株' : '米国株';
    s.byMarket[mk] = (s.byMarket[mk] || 0) + val;
    s.byMarketType[`${mk}・${type}`] = (s.byMarketType[`${mk}・${type}`] || 0) + val;
  }
  const out = Object.values(byDate).map(s => ({ date: s.date, totalJpy: Math.round(s.totalJpy), costJpy: Math.round(s.costJpy), byMarket: s.byMarket, byMarketType: s.byMarketType }));
  out.sort((a, b) => a.date < b.date ? -1 : 1);
  return { snapshots: out };
}
async function importAssetHistory() {
  const ta = document.getElementById('asset-import-text'); const msg = document.getElementById('asset-import-msg');
  const setMsg = (t, neg) => { if (msg) { msg.textContent = t; msg.className = neg ? 'neg' : 'pos'; } };
  if (!ta || !ta.value.trim()) { setMsg('明細を貼り付けてください', true); return; }
  if (typeof gsync === 'undefined' || !gsync.hasDrive || !gsync.hasDrive()) { setMsg('Googleログイン（Drive）が必要です', true); return; }
  const agg = aggregateAssetRows(ta.value);
  if (agg.error) { setMsg(agg.error, true); return; }
  if (!agg.snapshots.length) { setMsg('集計できる行がありませんでした', true); return; }
  setMsg('統合中…');
  try {
    const n = await dsync.historyMerge(agg.snapshots);
    setMsg(`${agg.snapshots.length}日分を統合しました（履歴 計${n}日分）`);
    ta.value = '';
    await loadPortfolioChart();
  } catch (e) { setMsg('統合に失敗: ' + (e && e.message || e), true); }
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return esc(String(iso));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
let toastTimer;
function toast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, ms);
}

// 処理中／完了オーバーレイ。ボタン押下→即「○○中…」を全画面で表示し、完了で「✓ ○○しました」を一瞬出して消す。
// 「押せたのか・何が起きているのか分からない」を防ぐ（操作もブロックして二重押し防止）。
let _busyTimer = null;
function busyShow(msg) {
  const ov = document.getElementById('busy-overlay'); if (!ov) return;
  ov.classList.remove('done', 'error');
  document.getElementById('busy-msg').textContent = msg || '処理中…';
  ov.hidden = false; clearTimeout(_busyTimer);
}
// 処理中オーバーレイが表示中のときだけメッセージを差し替える（段階の進捗表示に使う）
function busyMsg(msg) {
  const ov = document.getElementById('busy-overlay'); const bm = document.getElementById('busy-msg');
  if (ov && bm && !ov.hidden) bm.textContent = msg;
}
function busyDone(msg, state = 'done') {
  const ov = document.getElementById('busy-overlay'); if (!ov || ov.hidden) return;
  ov.classList.remove('done', 'error'); ov.classList.add(state);
  document.getElementById('busy-msg').textContent = msg || (state === 'error' ? '失敗しました' : '完了しました');
  clearTimeout(_busyTimer);
  _busyTimer = setTimeout(() => { ov.hidden = true; ov.classList.remove('done', 'error'); }, state === 'error' ? 3000 : 1100);
}
function busyHide() { const ov = document.getElementById('busy-overlay'); if (!ov) return; ov.hidden = true; ov.classList.remove('done', 'error'); clearTimeout(_busyTimer); }

// 決算日バックグラウンド取得の進捗バー（トップバー直下の細い帯）。busy オーバーレイと違い操作をブロックしない。
// done/total 件数のテキスト＋割合の塗りつぶしで進捗を表示し、完了時に earnProgressHide で消す。
function earnProgress(done, total) {
  const bar = document.getElementById('earn-progress'); if (!bar) return;
  bar.hidden = false;
  const t = document.getElementById('earn-progress-text');
  if (t) t.textContent = `決算日を取得中… ${done}/${total}件`;
  const f = document.getElementById('earn-progress-fill');
  if (f) f.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
}
function earnProgressHide() { const bar = document.getElementById('earn-progress'); if (bar) bar.hidden = true; }
// 非同期処理をオーバーレイで包む: 押下→「msg（…中）」即時表示→成功「doneMsg」/失敗「エラー」。
async function withBusy(msg, fn, doneMsg) {
  busyShow(msg);
  // 押下表示を一度描画させてから本処理へ（rAFはバックグラウンドタブで止まり得るため setTimeout を使用）
  await new Promise(r => setTimeout(r, 0));
  try { const r = await fn(); busyDone(doneMsg, 'done'); return r; }
  catch (e) { busyDone('失敗しました：' + (e && e.message ? e.message : String(e)), 'error'); throw e; }
}

// 公開（onclick用）
window.go = go;
window.setHoldingsMarket = setHoldingsMarket;
window.setDashMoverMarket = setDashMoverMarket;
window.setHoldingsSearch = setHoldingsSearch;
window.openSecurityForm = openSecurityForm;
window.autoFetchInfo = autoFetchInfo;
window.refetchInfo = refetchInfo;
window.toggleBaseHighManual = toggleBaseHighManual;
window.fillBuyAmount = fillBuyAmount;
window.maskDate = maskDate;
window.deleteSecurity = deleteSecurity;
window.openHoldingsForm = openHoldingsForm;
window.removeHolding = removeHolding;
window.sellAll = sellAll;
window.openTxnForm = openTxnForm;
window.setDetailChartRange = setDetailChartRange;
window.closeDrawer = closeDrawer;
window.enlargeDetailChart = enlargeDetailChart;
window.openPriceInput = openPriceInput;
window.openCategoryEdit = openCategoryEdit;
window.openCategoryMaster = openCategoryMaster;
window.openGradeMaster = openGradeMaster;
window.pickColor = pickColor;
window.openRuleMaster = openRuleMaster;
window.openMasterPick = openMasterPick;
window.masterPickNote = masterPickNote;
window.openAmountHistory = openAmountHistory;
window.syncUsdAmount = syncUsdAmount;
window.deleteCategory = deleteCategory;
window.openRuleEdit = openRuleEdit;
window.deleteRule = deleteRule;
window.setDefaultRule = setDefaultRule;
window.openPasteImport = openPasteImport;
window.openBrokerImport = openBrokerImport;
window.openImportMapping = openImportMapping;
window.saveImportMapping = saveImportMapping;
window.resetImportMapping = resetImportMapping;
window.onImportProfileChange = onImportProfileChange;
window.onImportFile = onImportFile;
window.onImportPaste = onImportPaste;
window.runBrokerImport = runBrokerImport;
window.setSort = setSort;
window.busyShow = busyShow;
window.busyDone = busyDone;
window.withBusy = withBusy;
window.toggleInlineEdit = toggleInlineEdit;
window.ieMark = ieMark;
window.ieKey = ieKey;
window.ieSaveAll = ieSaveAll;
window.ieDiscardAll = ieDiscardAll;
window.toggleSelectAll = toggleSelectAll;
window.bulkSellAll = bulkSellAll;
window.openColPicker = openColPicker;
window.cpToggle = cpToggle;
window.cpDragStart = cpDragStart;
window.cpDragOver = cpDragOver;
window.cpDrop = cpDrop;
window.cpDragEnd = cpDragEnd;
window.cpReset = cpReset;
window.closeModal = closeModal;
window.exportData = exportData;
window.exportGeneric = exportGeneric;
window.openGenericExport = openGenericExport;
window.refreshAllMeta = refreshAllMeta;
window.refreshSplitsOnly = refreshSplitsOnly;
window.splitHistAll = splitHistAll;
window.openSplitAdjustChecked = openSplitAdjustChecked;
window.openSplitAdjustOne = openSplitAdjustOne;
window.saSelectAll = saSelectAll;
window.saApplyBulk = saApplyBulk;
window.runSplitAdjust = runSplitAdjust;
window.importData = importData;
window.resetData = resetData;
window.openDriveBackups = openDriveBackups;
window.restoreDriveBackup = restoreDriveBackup;
window.resetTxnData = resetTxnData;
window.excelExportGenerate = excelExportGenerate;
window.excelExportCopy = excelExportCopy;
window.runAcqJpyImport = runAcqJpyImport;
window.mfTransferGenerate = mfTransferGenerate;
window.fundGenerate = fundGenerate;
window.openFundImport = openFundImport;
window.runFundImport = runFundImport;
window.fundTransferSavedGenerate = fundTransferSavedGenerate;
window.smSelectAll = smSelectAll;
window.setSecMasterFilter = setSecMasterFilter;
window.setSecMasterMarket = setSecMasterMarket;
window.setFundCode = setFundCode;
window.fetchFundName = fetchFundName;
window.openFundCodeMaster = openFundCodeMaster;
window.openImportAliasMaster = openImportAliasMaster;
window.deleteImportAlias = deleteImportAlias;
window.openCfRulesMaster = openCfRulesMaster;
window.openCfRuleEdit = openCfRuleEdit;
window.saveCfRule = saveCfRule;
window.deleteCfRule = deleteCfRule;
window.resetCfRules = resetCfRules;
window.cfAddRangeRow = cfAddRangeRow;
window.cfDelRangeRow = cfDelRangeRow;
window.cfApplyTplSel = cfApplyTplSel;
window.cfCopyToCol = cfCopyToCol;
window.newsToggleCat = newsToggleCat;
window.newsToggleDiscType = newsToggleDiscType;
window.setNewsMkt = setNewsMkt;
window.setNewsDays = setNewsDays;
window.newsRefresh = newsRefresh;
window.newsReadLink = newsReadLink;
window.newsOpenArticle = newsOpenArticle;
window.regenVideoSummary = regenVideoSummary;
window.setNewsHeldOnly = setNewsHeldOnly;
window.openNewsTagsEditor = openNewsTagsEditor;
window.saveNewsTags = saveNewsTags;
window.openYtChannelMaster = openYtChannelMaster;
window.ytChannelAddRow = ytChannelAddRow;
window.saveYtChannelMaster = saveYtChannelMaster;
window.openListedMaster = openListedMaster;
window.openNavOrderMaster = openNavOrderMaster;
window.importListedMaster = importListedMaster;
window.importListedFile = importListedFile;
window.listedDragOver = listedDragOver;
window.listedDragLeave = listedDragLeave;
window.listedDrop = listedDrop;
window.clearListedMaster = clearListedMaster;
window.openDiscTypeMaster = openDiscTypeMaster;
window.discTypeAddRow = discTypeAddRow;
window.discTypeMoveRow = discTypeMoveRow;
window.discTypeResetDefault = discTypeResetDefault;
window.saveDiscTypeMaster = saveDiscTypeMaster;
window.openSecNews = openSecNews;
window.secNewsToggleType = secNewsToggleType;
window.secNewsAllTypes = secNewsAllTypes;
window.newsHideBtn = newsHideBtn;
window.newsUnhideBtn = newsUnhideBtn;
window.newsUnhideAll = newsUnhideAll;
window.toggleNewsHiddenView = toggleNewsHiddenView;
window.setMktMarket = setMktMarket;
window.setMktSub = setMktSub;
window.setMktKind = setMktKind;
window.mktRefresh = mktRefresh;
window.mktClickName = mktClickName;
window.addRankingWatch = addRankingWatch;
window.registerPendingFunds = registerPendingFunds;
window.setSecMasterSearch = setSecMasterSearch;
window.smBulkFieldChange = smBulkFieldChange;
window.smBulkApply = smBulkApply;
window.holdBulkFieldChange = holdBulkFieldChange;
window.holdBulkApply = holdBulkApply;
window.bulkSetDetailType = bulkSetDetailType;
window.bulkSetField = bulkSetField;
window.bulkDeleteSecurities = bulkDeleteSecurities;
window.copyDisplayedTable = copyDisplayedTable;
window.copyColLayout = copyColLayout;
window.cpSetWidth = cpSetWidth;
window.cpSetAuto = cpSetAuto;
window.cpSetAllWidths = cpSetAllWidths;
window.cpSetLabel = cpSetLabel;
window.openGenericImport = openGenericImport;
window.giParse = giParse;
window.giSetMap = giSetMap;
window.runGenericImport = runGenericImport;
window.giSaveFormat = giSaveFormat;
window.giLoadFormat = giLoadFormat;
window.giDeleteFormat = giDeleteFormat;
window.setMacroGroup = setMacroGroup;
window.setMacroCard = setMacroCard;
window.setMacroPeriod = setMacroPeriod;
window.toggleMacroCompare = toggleMacroCompare;
window.openMacroAlerts = openMacroAlerts;
window.maAdd = maAdd;
window.maDelete = maDelete;
window.maToggle = maToggle;
window.maOpenSeries = maOpenSeries;
window.updOpen = updOpen;
window.updMarkAllSeen = updMarkAllSeen;
window.macroRefresh = macroRefresh;
window.api = api;
window.render = render;

// ---------- 起動 ----------
renderNav();
document.getElementById('modal-close').onclick = closeModal;
document.getElementById('drawer-close').onclick = closeDrawer;
document.getElementById('drawer-overlay').addEventListener('click', (e) => { if (e.target.id === 'drawer-overlay') closeDrawer(); });
// モーダルの枠外（オーバーレイ地）クリックで閉じる。内側の .modal クリックは伝播で閉じないよう対象を限定。
document.getElementById('modal-overlay').addEventListener('click', (e) => { if (e.target.id === 'modal-overlay') closeModal(); });
// Escキーで開いているモーダル/ドロワーを閉じる
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!document.getElementById('modal-overlay').hidden) closeModal();
  else if (!document.getElementById('drawer-overlay').hidden) closeDrawer();
});
// 「価格更新」: その日まだ高値を取得していなければ高値も取得（LDOS等の古い5年高値を修正）、以降は価格のみで軽量
// マーケットタブ表示中はランキングも更新（保有銘柄と同じ手動更新ルール）
document.getElementById('btn-refresh').onclick = () => withBusy('価格を更新中…', async () => {
  await api.refreshAll({ withHighs: store.data.lastHighsDate !== today() });
  if (currentView === 'market') mktRefresh();
  render();
  // 価格更新のついでに更新情報（経済指標・YouTube新着）も確認する。待たせないよう裏で走らせる
  updDailyCheck(true);
}, '価格を更新しました').catch(() => {});

// IME変換中は検索の再描画を抑止（innerHTML生成の oncomposition* 属性はハンドラ登録されないため、
// document に委譲リスナーを張る。これで全ての入力欄の変換中フラグを確実に拾える・SEC-112）
document.addEventListener('compositionstart', (e) => {
  if (e.target && e.target.matches && e.target.matches('input, textarea')) window._imeComposing = true;
}, true);
document.addEventListener('compositionend', (e) => {
  if (!(e.target && e.target.matches && e.target.matches('input, textarea'))) return;
  window._imeComposing = false;
  // 検索欄は確定後に反映（変換中はスキップしていたため）
  if (e.target.id === 'hold-search') setHoldingsSearch(e.target.value);
  else if (e.target.id === 'sm-search') setSecMasterSearch(e.target.value);
  else if (e.target.id === 'ana-search') anaSetSearch(e.target.value);
}, true);

store.load();
// techAnalysis を IndexedDB から読み込む（§16.7.5）。同期(dsync.syncNow)はこの完了を必ず待つこと。
// 未ロード（=空）のまま同期すると 3-way マージが「ローカルで全削除」と誤解釈し、Drive・他端末の
// 分析結果まで消してしまう（mergeMap3way の削除伝播）。
store.idbReady = (async () => {
  if (!idb.ok) return;
  const cur = store.data.techAnalysis || {};
  if (Object.keys(cur).length > 0) {
    // 移行(初回): 旧版は localStorage の sm_data_v1 内に入っていた。IDB へ書き、save() で localStorage から外す
    await idb.set('techAnalysis', cur);
    store.save();
    return;
  }
  const v = await idb.get('techAnalysis');
  if (v && typeof v === 'object') {
    store.data.techAnalysis = v;
    try { store._pruneTechAnalysis(); } catch (_) {}
    if (currentView === 'analysis') render();   // 分析タブを開いた状態のリロードなら読み込み後に反映
  }
})().catch(() => {});
loadColPrefs();
loadFilterState();    // 分析・個別銘柄の列フィルター（次回起動時の引継ぎ）
loadFilterPresets();  // フィルターのパターン（3タブ共通）
// タブ維持: リロードでは sessionStorage から現在タブを復元。タブ/ブラウザを閉じて開き直すと
// sessionStorage はクリアされるので自動的に dashboard に戻る（＝開き直しはダッシュボード）。
try { const v = sessionStorage.getItem('sm_view'); if (v && PAGE_TITLE[v]) currentView = v; } catch (_) {}
// 市場の初期表示は時間帯で決定（平日8-18時JST=日本株/それ以外=米国株）。リロード毎に再判定し、保存しない
// （＝開き直し・リロードのたびに時間帯で初期化。セッション中の手動切替は in-memory で維持）。
{ const m0 = timeBasedMarket(); holdingsMarket = m0; signalMarketFilter = m0; }
// ログイン復元は localStorage の保存トークンだけで完結し、サーバー設定への通信を必要としない。
// loadServerConfig を待たず render の前に即実行＝最初の描画から「ログイン中」を反映し、
// 「ログイン済みなのに未ログイン表示」を防ぐ（保存トークンがあれば path① が同期的に _token を確定）。
gsync.restoreSession().catch(() => {});
render();
// 1日1回（起動時）だけ銘柄名・セクター・業種・高値を更新
api.dailyStartup();
// 1日1回（起動時）マクロ指標と購読YouTubeの新着を裏で確認し、更新情報（ダッシュボード・NEWバッジ）を作る
updDailyCheck();
// 公開設定(clientId等)を CF env から取得→反映し、その後 Drive自動同期ループを準備
// （未ログイン時は何もしない＝ポップアップ無し。ログイン後に同期開始）
loadServerConfig().then(() => {
  if (currentView === 'master') renderMaster();
  if (typeof dsync !== 'undefined' && dsync.enabled()) dsync.startAuto();
  // 保存トークンが無く clientId がサーバー設定で後から入った場合のフォールバック（無音再取得を再試行）。
  // 既にログイン済みなら restoreSession は即 return するため二重実行は無害。
  gsync.restoreSession().catch(() => {});
});
