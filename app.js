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

'use strict';

// ---------- 定数・初期データ ----------
const STORAGE_KEY = 'sm_data_v1';

const DEFAULT_CATEGORIES = [
  { category: '王道・鉄板', label: '文明のインフラ', amountJpy: 80000, amountUsd: 800, sortOrder: 1 },
  { category: '主力・成長', label: '世界的覇権', amountJpy: 60000, amountUsd: 600, sortOrder: 2 },
  { category: '準主力', label: '地域覇者・ニッチ', amountJpy: 50000, amountUsd: 500, sortOrder: 3 },
  { category: '防御・配当', label: '成熟・安定', amountJpy: 40000, amountUsd: 400, sortOrder: 4 },
  { category: '有望な投機', label: '宝くじのエース', amountJpy: 25000, amountUsd: 250, sortOrder: 5 },
  { category: 'お遊び', label: '記念・優待', amountJpy: 15000, amountUsd: 150, sortOrder: 6 },
  { category: '対象外', label: '投資不適格', amountJpy: 0, amountUsd: 0, sortOrder: 7 },
];

const DEFAULT_RULE = {
  id: 1, name: '標準ルール', initialDropPct: 40, addonDropPct: 20, baseHighMode: '5y', isDefault: true,
};

const MARKET_LABEL = { US: '米国株', JP: '日本株', FUND: '投信' };
const MARKET_CCY = { US: '$', JP: '¥', FUND: '¥' };
const BASE_HIGH_LABEL = { '5y': '5年高値', '52w': '52週高値', 'all': '上場来高値', 'manual': '手動指定' };
const BROKERS = ['SBI', '楽天', 'Webull', 'moomoo', 'SMBC日興', 'マネックス'];
const ACCOUNTS = ['特定', 'NISA', '一般'];
// ---------- カラム定義 ----------
// 全カラムのマスタ定義。配列の順＝表示順のベース（ピッカーで個別に並び替え可）
// markets に含む画面でのみ選択可能。'SIGNAL' はサインタブ。
const ALLM = ['US','JP','FUND','SIGNAL'];
const STKM = ['US','JP','SIGNAL'];
const MASTER_COLS = [
  { key: 'ticker',      label: 'コード',           left: true,  markets: ALLM, noSort: false, narrow: true },
  { key: 'name',        label: '銘柄名',           left: true,  markets: ALLM, noSort: false },
  { key: 'detailType',  label: '詳細種別',         left: true,  markets: STKM, noSort: false },
  { key: 'market',      label: '市場',             left: true,  markets: ['SIGNAL'], noSort: false },
  { key: 'broker',      label: '証券会社',         left: true,  markets: ALLM, noSort: false },
  { key: 'sigType',     label: '種別',             left: true,  markets: ['SIGNAL'], noSort: false },
  { key: 'price',       label: '現在値',           left: false, markets: ALLM, noSort: false },
  { key: 'day',         label: '前日比',           left: false, markets: ALLM, noSort: false },
  { key: 'extPrice',    label: '時間外',           left: false, markets: ['US', 'SIGNAL'], noSort: false },
  { key: 'trigger',     label: '次回購入',         left: false, markets: STKM, noSort: false },
  { key: 'trigBasis',   label: '適用区分',         left: true,  markets: STKM, noSort: true, narrow: true },
  { key: 'base',        label: '基準値',           left: false, markets: ['SIGNAL'], noSort: false },
  { key: 'drop',        label: '残り下落率',       left: false, markets: STKM, noSort: false },
  { key: 'dropPrev',    label: '残り下落率(前日)', left: false, markets: STKM, noSort: false },
  { key: 'high5y',      label: '5年高値',          left: false, markets: STKM, noSort: false },
  { key: 'high52w',     label: '52週高値',         left: false, markets: STKM, noSort: false },
  { key: 'dropFrom5y',  label: '5年高値からの下落率', left: false, markets: STKM, noSort: false },
  { key: 'dropFrom52w', label: '52週高値からの下落率', left: false, markets: STKM, noSort: false },
  { key: 'prevBuyPrice', label: '前回購入単価',     left: false, markets: STKM, noSort: false },
  { key: 'prevBuyDate',  label: '前回購入日',       left: true,  markets: STKM, noSort: false },
  { key: 'dropFromPrev', label: '前回からの下落率', left: false, markets: STKM, noSort: false },
  { key: 'sector',      label: 'セクター',         left: true,  markets: STKM, noSort: false },
  { key: 'industry',    label: '業種',             left: true,  markets: STKM, noSort: false },
  { key: 'marketCap',   label: '時価総額',          left: false, markets: STKM, noSort: false },
  { key: 'turnover',    label: '売買代金',          left: false, markets: STKM, noSort: false },
  { key: 'value',       label: '評価額',           left: false, markets: ALLM, noSort: false },
  { key: 'cost',        label: '取得価額',         left: false, markets: ALLM, noSort: false },
  { key: 'acqJpy',      label: '取得円(円)',       left: false, markets: STKM, noSort: false },
  { key: 'pnl',         label: '損益率',           left: false, markets: ALLM, noSort: false },
  { key: 'avgCost',     label: '取得単価',         left: false, markets: ALLM, noSort: false },
  { key: 'qty',         label: '数量',             left: false, markets: ALLM, noSort: false },
  { key: 'buyCount',    label: '購入回数',         left: false, markets: ALLM, noSort: false },
  { key: 'buyAmount',   label: '買い増し予定額',    left: false, markets: ALLM, noSort: false },
  { key: 'reco',        label: '推奨購入額',       left: false, markets: ALLM, noSort: false },
  { key: 'category',    label: 'カテゴリ',         left: true,  markets: ALLM, noSort: false },
  { key: 'ruleName',    label: '買い増しルール',    left: true,  markets: ALLM, noSort: false },
  { key: 'fixedBuyPrice', label: '買増固定値',       left: false, markets: STKM, noSort: false },
  { key: 'rating',      label: '銘柄格付',         left: true,  markets: STKM, noSort: false },
  { key: 'per',         label: 'PER',              left: false, markets: STKM, noSort: false },
  { key: 'dividend',    label: '配当/株',          left: false, markets: STKM, noSort: false },
  { key: 'divYield',    label: '配当利回り',       left: false, markets: STKM, noSort: false },
  { key: 'eps',         label: 'EPS',              left: false, markets: STKM, noSort: false },
  // 取り込んだ銘柄分析結果（既定非表示・列設定で表示可）
  { key: 'overallGrade', label: '総合評価',        left: true,  markets: STKM, noSort: false },
  { key: 'buyGrade',     label: '買い時評価',      left: true,  markets: STKM, noSort: false },
  { key: 'priority',     label: '購入優先順位',    left: false, markets: STKM, noSort: false },
  { key: 'stars',        label: '★(ﾊﾞﾘｭ/強/ﾘｽｸ)', left: true,  markets: STKM, noSort: true },
  { key: 'analysisDate', label: '評価日',          left: true,  markets: STKM, noSort: false },
  { key: 'analysisNote', label: '分析メモ',        left: true,  markets: STKM, noSort: true },
];
// デフォルト表示列（市場ごと）。表示順は MASTER_COLS の順、ここに含まれるkeyが初期表示
const DEFAULT_VISIBLE = {
  US:   ['ticker','name','price','day','extPrice','trigger','trigBasis','drop','dropPrev','high5y','high52w','prevBuyPrice','prevBuyDate','dropFromPrev','dropFrom5y','sector','industry','marketCap','turnover','value','cost','pnl','avgCost','qty','buyCount','buyAmount','category','ruleName','fixedBuyPrice','rating'],
  JP:   ['ticker','name','price','day','trigger','trigBasis','drop','dropPrev','high5y','high52w','prevBuyPrice','prevBuyDate','dropFromPrev','dropFrom5y','sector','industry','marketCap','turnover','value','cost','pnl','avgCost','qty','buyCount','buyAmount','category','ruleName','fixedBuyPrice','rating'],
  FUND: ['ticker','name','price','value','cost','pnl','avgCost','qty','buyCount','buyAmount','category'],
  SIGNAL: ['ticker','name','market','broker','sigType','price','day','drop','dropPrev','trigger','trigBasis','base','prevBuyPrice','prevBuyDate','dropFromPrev','dropFrom5y','buyAmount','reco','ruleName','fixedBuyPrice','rating'],
};
const COL_PREFS_KEY = 'sm_colprefs_v2';

// 分析メタの取込列マッピング（Excel「銘柄分析結果」のヘッダ名 → 内部キー）
const ANALYSIS_COLMAP = {
  '評価日': 'analysisDate', '銘柄名': 'ticker', 'ティッカー': 'ticker',
  '総合評価': 'overallGrade', '銘柄格付': 'rating', '買い時評価': 'buyGrade',
  '推奨投資額': 'recoAmount', 'カテゴリ': 'category', '推奨カテゴリ': 'category',
  'バリュエーション': 'starValuation', '独自の強み': 'starStrength', 'リスク': 'starRisk',
  '備考': 'analysisNote', '評価時点_購入優先順位': 'priority', '購入優先順位': 'priority',
  'セクター': 'sector', '業種': 'industry', '時価総額(百万)': 'marketCap',
  'PER': 'per', 'EPS': 'eps', '年間配当/株': 'dividend',
};
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
    try {
      this.data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (_) { this.data = null; }
    if (!this.data) this.data = this.seed();
    // 後方互換: 欠損キーを補完
    this.data.securities ||= [];
    this.data.holdings ||= [];
    this.data.transactions ||= [];
    this.data.rules ||= [structuredClone(DEFAULT_RULE)];
    this.data.categories ||= structuredClone(DEFAULT_CATEGORIES);
    this.data.prices ||= {};
    this.data.fx ||= { USDJPY: null };
    this.data.meta ||= {}; // 銘柄情報マスタ（名前・セクター・ファンダ）priceKeyでキャッシュ
    this.data.amountHistory ||= [];   // 金額マスタ変更履歴（版管理）
    this.data.amountSnapshots ||= []; // 銘柄ごとの適用金額スナップショット
    this.data.importHistory ||= [];   // 取込履歴
    this.data.lastPriceUpdate ||= null; // 価格更新日時
    this.data.importMappings ||= {};  // 取込フィールド設定（列名・位置）のマスタ
    this.data.importFormats ||= [];   // 汎用取込のフォーマット（列名→フィールド対応）保存
    this.data.importAliases ||= {};   // 取込変換マスタ: ドメイン→{正規化した取込値→マスタ正規値 or '__skip__'}
    this.data.lastInfoDate ||= null;  // 銘柄情報の日次更新を実行した日（YYYY-MM-DD）
    this.data.lastHighsDate ||= null; // 5年/52週高値を取得した日（YYYY-MM-DD）。その日初回の価格更新で高値も取得
    this.data.indices ||= {};         // 参考指数の price/prevClose キャッシュ
    this.data.settings ||= {};        // 非機密の運用設定（Google連携の clientId 等）
    for (const k in DEFAULT_IMPORT_MAPPINGS) {
      this.data.importMappings[k] = { ...DEFAULT_IMPORT_MAPPINGS[k], ...(this.data.importMappings[k] || {}) };
    }
    this.data.seq ||= 1;
    if (!this.data.rules.some(r => r.isDefault)) this.data.rules[0].isDefault = true;
    // 後方互換: カテゴリに米国株金額が無ければ日本株の÷100で補完
    for (const c of this.data.categories) if (c.amountUsd == null) c.amountUsd = (c.amountJpy || 0) / 100;
    return this.data;
  },
  save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data)); },
  seed() {
    return {
      securities: [], holdings: [], transactions: [],
      rules: [structuredClone(DEFAULT_RULE)],
      categories: structuredClone(DEFAULT_CATEGORIES),
      prices: {}, fx: { USDJPY: null }, meta: {}, amountHistory: [], amountSnapshots: [],
      importHistory: [], lastPriceUpdate: null, seq: 1,
    };
  },
  nextId() { return this.data.seq++; },
  _now() { return new Date().toISOString(); },

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
          amountJpy: c.amountJpy, amountUsd: c.amountUsd, recordedAt: this._now(), trigger: 'category_change',
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
    if (found) { Object.assign(found, h); }
    else { h.id = this.nextId(); this.data.holdings.push(h); }
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
    this.data.transactions.push(t);
    this.applyTransaction(t);
    this.save();
  },
  applyTransaction(t) {
    // 当該 security の同一口座 holding を取得 or 作成
    let h = this.data.holdings.find(x =>
      x.securityId === t.securityId && x.broker === t.broker && x.accountType === t.accountType);
    if (!h) {
      h = { id: this.nextId(), securityId: t.securityId, broker: t.broker, accountType: t.accountType, quantity: 0, avgCost: 0 };
      this.data.holdings.push(h);
    }
    if (t.type === 'buy') {
      const totalCost = h.avgCost * h.quantity + t.price * t.quantity;
      h.quantity += t.quantity;
      h.avgCost = h.quantity > 0 ? totalCost / h.quantity : 0; // 加重平均
      // 取得円(円)累計: 米国株の受渡金額(円)が入力されていれば加算（買=+）。SEC-59
      if (t.settleJpy != null) h.acqJpy = (h.acqJpy || 0) + t.settleJpy;
      // 購入回数を加算
      const sec = this.data.securities.find(s => s.id === t.securityId);
      if (sec) sec.buyCount = (sec.buyCount || 0) + 1;
    } else { // sell: 数量のみ減算（平均取得単価は不変）。ただし数量0なら保有解消につき単価もクリア
      h.quantity = Math.max(0, h.quantity - t.quantity);
      // 取得円(円)累計: 受渡金額(円)が入力されていれば減算（売=−。台帳式に一致）。SEC-59
      if (t.settleJpy != null) h.acqJpy = (h.acqJpy || 0) - t.settleJpy;
      if (h.quantity === 0) h.avgCost = 0;
    }
  },

  // rules
  rule(id) { return this.data.rules.find(r => r.id === id) || this.defaultRule(); },
  defaultRule() { return this.data.rules.find(r => r.isDefault) || this.data.rules[0]; },
  addRule(r) { r.id = this.nextId(); this.data.rules.push(r); this.save(); return r; },
  updateRule(id, patch) {
    const r = this.data.rules.find(x => x.id === id);
    if (r) { Object.assign(r, patch); this.save(); }
    return r;
  },
  removeRule(id) {
    if (this.data.rules.length <= 1) return false;
    const wasDefault = this.data.rules.find(r => r.id === id)?.isDefault;
    this.data.rules = this.data.rules.filter(r => r.id !== id);
    // 当該ルール参照銘柄は既定へ戻す
    for (const s of this.data.securities) if (s.ruleId === id) s.ruleId = null;
    if (wasDefault && !this.data.rules.some(r => r.isDefault)) this.data.rules[0].isDefault = true;
    this.save();
    return true;
  },
  setDefaultRule(id) {
    for (const r of this.data.rules) r.isDefault = (r.id === id);
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
    this.data.categories.push(c); this.save();
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
          amountJpy: c.amountJpy, amountUsd: c.amountUsd, recordedAt: now, trigger: 'master_change',
        });
      }
      // 変更履歴（旧→新）
      this.data.amountHistory.push({
        id: this.nextId(), category: newName || oldName,
        prevJpy: c.amountJpy, prevUsd: c.amountUsd,
        newJpy: patch.amountJpy ?? c.amountJpy, newUsd: patch.amountUsd ?? c.amountUsd,
        changedAt: now,
      });
    }
    Object.assign(c, patch);
    // カテゴリ名を変えたら、参照している銘柄も追従
    if (newName && newName !== oldName) {
      for (const s of this.data.securities) if (s.category === oldName) s.category = newName;
    }
    this.save();
  },
  removeCategory(name) {
    this.data.categories = this.data.categories.filter(c => c.category !== name);
    for (const s of this.data.securities) if (s.category === name) s.category = null;
    this.save();
  },

  // 銘柄情報マスタ（meta）への書き込み。key = `${market}:${ticker}`
  setMeta(key, obj) {
    this.data.meta[key] = { ...(this.data.meta[key] || {}), ...obj };
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
    // 手入力項目・手動取引は両モードで調整
    if (typeof sec.prevBuyPrice === 'number') sec.prevBuyPrice /= r;
    if (typeof sec.baseHighManual === 'number') sec.baseHighManual /= r;
    if (typeof sec.fixedBuyPrice === 'number') sec.fixedBuyPrice /= r;
    for (const t of this.data.transactions.filter(t => t.securityId === secId && t.tradedAt && t.tradedAt < date)) { t.price /= r; t.quantity *= r; }
    // 自動取得の価格キャッシュ（現在値・前日終値・5年/52週高値）は触らない。
    // Yahoo はEx-date以降は分割調整済みの値を返すため、削除せず手入力項目だけ調整する（次の価格更新で最新化）。
    const hrec = (sec.splitHistory || []).find(x => x.date === date);
    if (hrec) { hrec.status = 'applied'; hrec.appliedAt = this._now(); hrec.mode = mode; }
    this.save();
  },
};

// ---------- Google連携（GIS＋Sheets。方式A=ブラウザ完結。clientId 未設定なら休眠） ----------
// 設計は DESIGN.md §14。実機での動作確認はクライアントID入手後に行う（現状はスキャフォールド）。
const gsync = {
  _token: null, _email: null,
  cfg() { return (store.data.settings && store.data.settings.google) || {}; },
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
  async _onToken(token, resolve, reject) {
    try {
      const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
      const email = ((info && info.email) || '').toLowerCase();
      const allow = (this.cfg().allowedEmails || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
      if (allow.length && !allow.includes(email)) { this._token = null; toast(`許可されていないアカウントです: ${email}`); return resolve(false); }
      this._token = token; this._email = email; toast(`ログイン: ${email || 'OK'}`); resolve(true);
    } catch (e) { reject(e); }
  },
  // ★モバイル対応: タップ→ポップアップの間に await を挟まない。GIS が読込済みなら同期で
  //   requestAccessToken を呼ぶ（スマホはタップ直後の同期呼び出しでないとポップアップを塞ぐ）。
  signIn() {
    const cfg = this.cfg();
    return new Promise((resolve, reject) => {
      if (!cfg.clientId) { toast('クライアントIDを設定してください'); return resolve(false); }
      const launch = () => {
        try {
          const tc = google.accounts.oauth2.initTokenClient({
            client_id: cfg.clientId,
            scope: 'https://www.googleapis.com/auth/spreadsheets openid email',
            callback: (r) => (r && r.access_token) ? this._onToken(r.access_token, resolve, reject) : reject(new Error('トークン取得失敗')),
            error_callback: (e) => reject(new Error((e && e.type) || 'OAuthエラー')),
          });
          tc.requestAccessToken({ prompt: '' });   // 同期で呼ぶ＝タップのユーザー操作を維持
        } catch (e) { reject(e); }
      };
      if (window.google && google.accounts && google.accounts.oauth2) launch();   // 既読込→同期で即ポップアップ
      else this.ensureGis().then(launch).catch(reject);                            // 未読込時のみフォールバック
    });
  },
  async _call(method, range, body) {
    const cfg = this.cfg();
    if (!cfg.spreadsheetId) throw new Error('スプレッドシートIDが未設定です');
    if (!this._token) { const ok = await this.signIn(); if (!ok) throw new Error('Googleログインが必要です'); }
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cfg.spreadsheetId)}/values/${encodeURIComponent(range)}`;
    const url = method === 'PUT' ? `${base}?valueInputOption=RAW` : base;
    const res = await fetch(url, { method, headers: { Authorization: 'Bearer ' + this._token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { this._token = null; throw new Error('トークン失効。再ログインしてください'); }
    if (!res.ok) { let d = ''; try { d = (await res.json()).error?.message || ''; } catch (_) {} throw new Error(`Sheets API ${res.status}${d ? '：' + d : '（_appdata シートの有無/編集権限を確認）'}`); }
    return res.json();
  },
  // 列Aの値を全消去（POST values/{range}:clear）。:clear はパスのリテラル接尾辞
  async _clear(range) {
    const cfg = this.cfg();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cfg.spreadsheetId)}/values/${encodeURIComponent(range)}:clear`;
    const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + this._token }, body: '{}' });
    if (res.status === 401) { this._token = null; throw new Error('トークン失効。再ログインしてください'); }
    if (!res.ok) { let m = ''; try { m = (await res.json()).error?.message || ''; } catch (_) {} throw new Error(`Sheets API ${res.status}${m ? '：' + m : ''}`); }
  },
  async save() {
    if (!this._token) { const ok = await this.signIn(); if (!ok) throw new Error('Googleログインが必要です'); }
    // 1セル50,000文字制限を回避: JSONを分割して列A（A1,A2,…）に保存
    const json = JSON.stringify(dataBundle());
    const CHUNK = 45000; const rows = [];
    for (let i = 0; i < json.length; i += CHUNK) rows.push([json.slice(i, i + CHUNK)]);
    if (!rows.length) rows.push(['']);
    await this._clear('_appdata!A:A');                                   // 旧データを消去（縮小時の残骸対策）
    await this._call('PUT', `_appdata!A1:A${rows.length}`, { values: rows });
    toast(`スプレッドシートへ保存しました（${rows.length}分割）`);
  },
  async load() {
    if (!confirm('スプレッドシートの内容で現在のデータを上書きします。よろしいですか？')) return false;
    const d = await this._call('GET', '_appdata!A1:A100000');
    const cells = (d && d.values || []).map(r => (r && r[0]) || '');
    const json = cells.join('');
    if (!json) throw new Error('スプレッドシートにデータがありません（_appdata 列Aが空）');
    restoreBundle(JSON.parse(json)); render(); toast('スプレッドシートから読み込みました（列設定も復元）'); return true;
  },
};
function gsaveSettings(f) {
  store.data.settings = store.data.settings || {};
  store.data.settings.google = { clientId: f.gClientId.value.trim(), allowedEmails: f.gAllowed.value.trim(), spreadsheetId: f.gSheetId.value.trim() };
  store.save(); toast('Google連携設定を保存しました'); renderMaster();
}
function gsyncStatus(html) { const el = document.getElementById('gsync-status'); if (el) el.innerHTML = html; }
async function gsyncSignIn() {
  gsyncStatus('<span class="muted">ログイン中…（ポップアップで承認してください）</span>');
  try { const ok = await gsync.signIn(); gsyncStatus(ok ? `<span class="pos">✓ ログイン中：${esc(gsync._email || 'OK')}</span>` : '<span class="neg">ログインできませんでした（許可アカウント/テストユーザーを確認）</span>'); }
  catch (e) { gsyncStatus('<span class="neg">ログイン失敗：' + esc(e.message || String(e)) + '</span>'); }
}
async function gsyncSave() {
  gsyncStatus('<span class="muted">シートへ保存中…</span>');
  try { await withBusy('Googleシートへ保存中…', () => gsync.save(), 'シートへ保存しました'); gsyncStatus(`<span class="pos">✓ 保存しました ${new Date().toLocaleString('ja-JP')}${gsync._email ? '（' + esc(gsync._email) + '）' : ''}</span>`); }
  catch (e) { gsyncStatus('<span class="neg">保存失敗：' + esc(e.message || String(e)) + '</span>'); }
}
async function gsyncLoad() {
  gsyncStatus('<span class="muted">シートから読込中…</span>');
  try { const ok = await withBusy('Googleシートから読込中…', () => gsync.load(), 'シートから読み込みました'); gsyncStatus(ok ? `<span class="pos">✓ シートから読み込みました ${new Date().toLocaleString('ja-JP')}</span>` : '<span class="muted">読込をキャンセルしました</span>'); }
  catch (e) { gsyncStatus('<span class="neg">読込失敗：' + esc(e.message || String(e)) + '</span>'); }
}

// ---------- 計算 ----------
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
  // 各種「〜からの下落率」（現在値 vs 基準。負=基準より下）
  dropFrom(sec, base) { const price = this.price(sec); if (price == null || !base) return null; return (price - base) / base * 100; },
  dropFromPrev(sec) { return this.dropFrom(sec, this.lastBuyPrice(sec)); },
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

  // 銘柄の合計保有（全口座合算）
  totalHolding(secId) {
    const hs = store.data.holdings.filter(h => h.securityId === secId);
    let qty = 0, cost = 0;
    for (const h of hs) { qty += h.quantity; cost += h.avgCost * h.quantity; }
    return { qty, avgCost: qty > 0 ? cost / qty : 0, acquiredCost: cost };
  },

  // 前回購入単価の情報 {price, source, date}。source: 'txn'(買い取引)|'manual'(登録値)|'みなし'(取得単価)|null
  // date(YYYY-MM-DD): 高値更新判定で「前回購入後に高値更新したか」を見るため。
  //   取引履歴があればその日付。無ければ手動入力の前回購入日(prevBuyDate)を使う（価格は手動値でも取得単価=みなしでもよい）。
  lastBuyInfo(sec) {
    const buys = store.data.transactions
      .filter(t => t.securityId === sec.id && t.type === 'buy')
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
  // 時価総額(百万) = 株価×発行済株式数/1e6（随時算出）。無ければ取得済み時価総額
  marketCap(sec) { const sh = this.field(sec, 'sharesOut'); const p = this.price(sec); if (sh && p != null) return p * sh / 1e6; return this.field(sec, 'marketCap'); },
  // 売買代金（原通貨・実額）= 現在値×当日出来高。出来高は価格キャッシュ優先、無ければ銘柄情報(meta)から。
  // （Finnhub利用の米株は価格更新で出来高が入らないため、銘柄情報更新=Yahoo chart の出来高で補完）
  turnover(sec) { const p = store.data.prices[priceKey(sec)] || {}; const pr = this.price(sec); const vol = p.volume != null ? p.volume : this.field(sec, 'volume'); return (pr != null && vol != null) ? pr * vol : null; },
  // 配当利回り(%) = 1株配当/株価
  divYield(sec) { const d = this.field(sec, 'dividend'); const p = this.price(sec); return (d != null && p) ? d / p * 100 : null; },

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
    if (fixed == null) {
      if (sec.market === 'US') trigger = trigger >= 10 ? Math.floor(trigger) : Math.floor(trigger * 10) / 10;
      else trigger = Math.floor(trigger);
    }
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
    const price = this.price(sec);
    const th = this.totalHolding(sec.id);
    if (price == null) return null;
    return price * th.qty;
  },
  // 取得原価（原通貨）。価格に依存せず常に分かる
  costNative(sec) { return this.totalHolding(sec.id).acquiredCost; },
  // 評価額（原通貨）。価格未取得時は取得原価で代替（合計に含めるため）
  valueOrCostNative(sec) {
    const v = this.valueNative(sec);
    return v != null ? v : this.costNative(sec);
  },
  // 損益率（原通貨ベース。為替に依存しない）
  pnlPctNative(sec) {
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
    const allSecs = store.data.securities.filter(s => s.ticker);
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
    // Cloudflareのサブリクエスト上限(約50)対策で小バッチに分割。withHighsは5年日足取得で応答が大きいため小さめ(10)、通常は1呼出/銘柄(40)。
    const BATCH = withHighs ? 10 : 40;
    const batches = [];
    for (let i = 0; i < holdSymbols.length; i += BATCH) batches.push(holdSymbols.slice(i, i + BATCH));
    let quotes = {}, lightQuotes = {};
    try {
      const reqs = batches.map(b =>
        fetch(`/api/price?symbols=${encodeURIComponent(b.join(','))}${withHighs ? '&highs=1' : ''}`)
          .then(r => r.ok ? r.json() : {}).catch(() => ({})));
      const lightIdx = reqs.length;
      reqs.push(fetch(`/api/price?mode=light&symbols=${encodeURIComponent(lightSymbols.join(','))}`).then(r => r.ok ? r.json() : {}).catch(() => ({})));
      const results = await Promise.all(reqs);
      lightQuotes = results[lightIdx] || {};
      quotes = Object.assign({}, ...results.slice(0, lightIdx));
    } catch (e) {
      toast('価格取得に失敗（手入力で更新できます）');
      return;
    }
    let usSource = null;
    for (const sec of secs) {
      const q = quotes[yahooSymbol(sec)];
      if (q && !q.error && q.price != null) {
        const prev = store.data.prices[priceKey(sec)] || {}; // 高値は通常更新では返らない→既存値を保持
        store.data.prices[priceKey(sec)] = {
          ...prev,
          price: q.price, prevClose: q.prevClose,
          prevDayPct: q.prevDayPct != null ? q.prevDayPct : (prev.prevDayPct ?? null), // 前営業日の値動き%（寄り付き前表示用）
          high5y: q.high5y != null ? q.high5y : (prev.high5y ?? null),
          high52w: q.high52w != null ? q.high52w : (prev.high52w ?? null),
          high5yDate: q.high5yDate != null ? q.high5yDate : (prev.high5yDate ?? null),
          high52wDate: q.high52wDate != null ? q.high52wDate : (prev.high52wDate ?? null),
          volume: q.volume != null ? q.volume : (prev.volume ?? null), // 当日出来高（売買代金算出用・未取得時は前回値を保持）
          fetchedAt: q.fetchedAt,
        };
        if (sec.market === 'US' && q.source && !usSource) usSource = q.source;
      }
    }
    if (usSource) store.data.lastPriceSource = usSource;
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
    // 米株の時間外(プレ/アフター)を別取得＝時間外列に表示。レギュラー/閉場中は時間外をクリア（当日レギュラー取得でNULL）。
    await this.refreshExtended(allSecs);
    // 名前未取得の銘柄だけ銘柄情報を取得
    const need = secs.filter(s => !(store.data.meta[priceKey(s)] && store.data.meta[priceKey(s)].name));
    if (need.length) await this.refreshMeta(need);
    toast('価格を更新しました');
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
          price: q.price, prevClose: q.prevClose,
          high5y: q.high5y, high52w: q.high52w,
          high5yDate: q.high5yDate ?? null, high52wDate: q.high52wDate ?? null, // 高値が付いた日（高値更新判定用）
          volume: q.volume != null ? q.volume : (prev.volume ?? null), // 当日出来高（売買代金算出用）
          fetchedAt: q.fetchedAt,
        };
      }
    }
    store.save();
  },

  // 銘柄情報マスタを取得して store.data.meta にキャッシュ。
  // 1銘柄=最大4サブリクエスト(日本語名/chart/quoteSummary/Finnhub)のため、全銘柄を1リクエストに
  // まとめると Cloudflareのサブリクエスト上限(約50)やFinnhubレート制限を超え、後半（特に時価総額）が
  // 取りこぼされる。→ 小分けバッチ(8銘柄)で順次取得する。
  async refreshMeta(secs) {
    secs = secs || store.data.securities.filter(s => s.ticker);
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
          store.data.meta[key] = { ...ex, ...inc };
        }
      }
      store.save();
    } catch (_) { /* 保存失敗は無視（手入力可） */ }
  },

  // 起動時の日次更新: 1日1回だけ 銘柄名/セクター/業種/高値 をまとめて更新（名称変更や高値の日次反映用）
  async dailyStartup() {
    if (store.data.securities.every(s => !s.ticker)) return;
    if (store.data.lastInfoDate === today()) return; // 本日実行済み
    store.data.lastInfoDate = today(); store.save();
    await this.refreshAll({ withHighs: true }); // 日次は高値（52週/5年）も取得。価格＋名前未取得分
    await this.refreshMeta();             // 全銘柄の名前/セクター/業種/ファンダを日次更新（日本語名は維持）
    await this.checkSplits();             // 分割検知（承認待ちは「分割」タブのバッジで通知）
    render();
  },

  // 株式分割・併合を検知。過去（今日より前）の新規分割は履歴に記録のみ、当日以降は承認待ちで返す
  async checkSplits() {
    const secs = store.data.securities.filter(s => s.ticker && s.market !== 'FUND');
    if (!secs.length) return [];
    const symbols = [...new Set(secs.map(yahooSymbol))];
    let data;
    try { const res = await fetch(`/api/splits?symbols=${encodeURIComponent(symbols.join(','))}`); if (!res.ok) return []; data = await res.json(); }
    catch (_) { return []; }
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
function clearHoldFilters(m) { holdingsSearch = ''; clearFilter(m); }

// ---------- サイドナビ（リデザイン） ----------
const NAV_GROUPS = [
  { group: 'メイン', items: [
    { id: 'dashboard', label: 'ダッシュボード', icon: 'dashboard' },
    { id: 'market',    label: 'マーケット',     icon: 'report' },
    { id: 'holdings',  label: '保有銘柄',       icon: 'holdings' },
    { id: 'signals',   label: '買い増しサイン', icon: 'signal', badge: 'sig' },
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
  report: 'レポート', import: '取込', secmaster: '銘柄マスタ', splits: '株式分割',
  transfer: '転記用', master: 'マスタ・設定', us: '米国株', jp: '日本株',
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
  copy: 'M9 9h11v11H9zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  trade: 'M7 10 3 6l4-4M3 6h12a4 4 0 0 1 4 4M17 14l4 4-4 4M21 18H9a4 4 0 0 1-4-4',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
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
  nav.innerHTML = NAV_GROUPS.map(grp => `
    <div class="nav-group">
      <div class="nav-label">${grp.group}</div>
      ${grp.items.map(it => {
        const bv = it.badge ? badgeVal(it.badge) : 0;
        const badge = (it.badge && bv > 0) ? `<span class="nav-badge ${it.badge === 'split' ? 'amber' : ''}">${bv}</span>` : '';
        return `<button class="nav-item ${active(it.id) ? 'active' : ''}" data-view="${it.id}">${navIcon(it.icon)}<span class="lbl">${it.label}</span>${badge}</button>`;
      }).join('')}
    </div>`).join('');
  nav.querySelectorAll('.nav-item').forEach(b => b.onclick = () => go(b.dataset.view));
}

// 一覧のソート/フィルタ・カラム設定（市場ごと）。デフォルトはティッカー順
const listState = {
  US:     { sortKey: 'ticker', sortDir: 1, broker: '', account: '', category: '', detailType: '' },
  JP:     { sortKey: 'ticker', sortDir: 1, broker: '', account: '', category: '', detailType: '' },
  FUND:   { sortKey: 'ticker', sortDir: 1, broker: '', account: '', category: '', detailType: '' },
  SIGNAL: { sortKey: 'drop',   sortDir: 1, broker: '', account: '', category: '', detailType: '' },
};
// カラム設定: 市場ごとに [{key, visible}] の配列
let colPrefs = {};
function loadColPrefs() {
  try { colPrefs = JSON.parse(localStorage.getItem(COL_PREFS_KEY)) || {}; } catch(_) { colPrefs = {}; }
}
function saveColPrefs() { localStorage.setItem(COL_PREFS_KEY, JSON.stringify(colPrefs)); }
// バックアップ/同期用の“全状態”バンドル。store.data に加え列設定(colPrefs)も同梱（_colPrefs）
function dataBundle() { return Object.assign({}, store.data, { _colPrefs: colPrefs }); }
// バンドルを復元（store.data ＋ 列設定）。_colPrefs が無い旧バックアップとも互換
function restoreBundle(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('データ形式が不正です');
  const cp = obj._colPrefs; delete obj._colPrefs;
  store.data = obj; store.save();
  if (cp && typeof cp === 'object') { colPrefs = cp; saveColPrefs(); }
  store.load(); loadColPrefs();
}
// 列幅(px)。colPrefsのwidth上書き優先、無ければキー/種別ごとの既定。
function colDefaultWidth(key) {
  const mc = MASTER_COLS.find(c => c.key === key) || {};
  if (key === 'ticker') return 64;
  if (key === 'name') return 200;
  if (key === 'market' || key === 'detailType') return 72;
  if (key === 'trigBasis') return 64; // 1文字バッジ（初/増/高/固）
  if (key === 'extPrice') return 92;  // 時間外価格＋種別タグ
  if (key === 'prevBuyDate') return 100; // YYYY-MM-DD
  if (['createdAt', 'updatedAt', 'analysisDate'].includes(key)) return 92;
  if (key === 'stars') return 120;
  if (key === 'analysisNote') return 160;
  return mc.left ? 110 : 84; // 左寄せ(テキスト系)は広め・数値は狭め
}
function colWidthPx(item) { return Math.max(40, item.width || colDefaultWidth(item.key)); }
function getColOrder(market) {
  if (!colPrefs[market]) resetColPrefs(market);
  else reconcileColPrefs(market);
  return colPrefs[market];
}
function resetColPrefs(market) {
  const visible = new Set(DEFAULT_VISIBLE[market]);
  colPrefs[market] = MASTER_COLS.filter(c => c.markets.includes(market)).map(c => ({
    key: c.key, visible: visible.has(c.key),
  }));
  saveColPrefs();
}
// 保存済み設定に、新規追加カラムを補完し、廃止カラムを除去（アプリ更新対応）
function reconcileColPrefs(market) {
  const validKeys = MASTER_COLS.filter(c => c.markets.includes(market)).map(c => c.key);
  const validSet = new Set(validKeys);
  const have = new Set(colPrefs[market].map(c => c.key));
  const visible = new Set(DEFAULT_VISIBLE[market]);
  let arr = colPrefs[market].filter(c => validSet.has(c.key)); // 廃止カラム除去
  // 未保持の新カラムを MASTER_COLS の順序で挿入
  let changed = arr.length !== colPrefs[market].length;
  for (let i = 0; i < MASTER_COLS.length; i++) {
    const mc = MASTER_COLS[i];
    if (!mc.markets.includes(market) || have.has(mc.key)) continue;
    arr.push({ key: mc.key, visible: visible.has(mc.key) });
    changed = true;
  }
  if (changed) { colPrefs[market] = arr; saveColPrefs(); }
}

// ---------- カラムレンダラー ----------
// 各カラムの td を返す関数。引数: (sec, ctx)
const muted = '<span class="muted">—</span>';
// みなし（取得単価を前回購入単価とみなす）の省スペース表示。数値の「前」に付けて桁ズレを防ぐ
const MINASHI = '<span class="muted" title="みなし（前回購入単価が未登録のため取得単価を使用）" style="cursor:help">≒</span>';
// 買増固定値（手入力のトリガー）マーカー。数値の前に付ける。
const FIXED_MARK = '<span class="muted" title="買増固定値（ルール計算でなく手入力のトリガー）" style="cursor:help">固</span>';
const pctTd = (v) => `<td class="${cls(v)}">${v != null ? signed(v) + '%' : '—'}</td>`;
// 条件付き強調（参照元スプレッドシート 米国株管理.xlsx の段階を踏襲）。値は%。
// ダークUI向けに「半透明の色オーバーレイ＋太字」で強調する。文字色は +緑/-赤 のまま維持する。
// 各配列は上から順に評価し最初に一致した色を使う（しきい値の厳しい順）。
const CF_RULES = {
  // 前日比: 上昇=緑系 / 下落=赤系、±5%/±10%で2段階（±5%以内は無強調）。文字色と同系で統一。
  day: [
    { t: v => v >= 10, bg: 'rgba(34,197,94,.45)' }, { t: v => v >= 5, bg: 'rgba(34,197,94,.20)' },
    { t: v => v <= -10, bg: 'rgba(239,68,68,.45)' }, { t: v => v <= -5, bg: 'rgba(239,68,68,.20)' },
  ],
  // 5年高値からの下落率＝初回購入の判断。基準は40%下落。
  // 「超えそう(-35)／超えた(-40)／さらに深い(-60/-80)」の段階で色分け（薄スレート→黄→橙→赤）。
  dropFrom5y: [
    { t: v => v <= -80, bg: 'rgba(239,68,68,.52)' }, { t: v => v <= -60, bg: 'rgba(249,115,22,.46)' },
    { t: v => v <= -40, bg: 'rgba(234,179,8,.40)' }, { t: v => v <= -35, bg: 'rgba(148,163,184,.22)' },
  ],
  // 前回からの下落率＝買い増しの判断。-10/-15/-20/-40/-50 の5段階（薄→濃）。
  dropFromPrev: [
    { t: v => v <= -50, bg: 'rgba(159,18,57,.50)' }, { t: v => v <= -40, bg: 'rgba(239,68,68,.48)' },
    { t: v => v <= -20, bg: 'rgba(249,115,22,.42)' }, { t: v => v <= -15, bg: 'rgba(234,179,8,.32)' },
    { t: v => v <= -10, bg: 'rgba(148,163,184,.22)' },
  ],
};
function condStyle(key, v) {
  if (v == null) return '';
  const rules = CF_RULES[key]; if (!rules) return '';
  // 太字は桁位置がずれるため付けない（背景色のみで強調）
  for (const r of rules) { if (r.t(v)) return ` style="background:${r.bg}"`; }
  return '';
}
// 強調付き％セル。文字色(+緑/-赤=cls)は常に維持し、しきい値超過時のみ半透明オーバーレイ＋太字。
const pctTdBg = (v, key) => {
  const st = condStyle(key, v);
  return `<td class="${cls(v)}"${st}>${v != null ? signed(v) + '%' : '—'}</td>`;
};
const COL_RENDERERS = {
  ticker:    (s,c) => `<td class="l col-code"><span class="tk ${s.market.toLowerCase()}" style="cursor:pointer" onclick="openSecurityDetail(${s.id})">${esc(s.ticker)}</span></td>`,
  name:      (s,c) => `<td class="l"><strong class="lnk-ext nm-strong" onclick="openSecurityDetail(${s.id})">${esc(calc.displayName(s))}</strong>${detailTypeOf(s) === 'ETF' ? ` <span class="tag detail-etf">ETF</span>` : ''}${s.watch ? ` <span class="tag watch">注意</span>` : ''}</td>`,
  market:    (s,c) => `<td class="l"><span class="tag ${s.market.toLowerCase()}">${MARKET_LABEL[s.market]}</span></td>`,
  detailType: (s,c) => { const dt = detailTypeOf(s); return `<td class="l"><span class="tag detail-${dt === 'ETF' ? 'etf' : dt === '投資信託' ? 'fund' : 'stock'}">${esc(dt)}</span></td>`; },
  broker:    (s,c) => { const b = calc.lastBroker(s); return `<td class="l">${b ? esc(b) : muted}</td>`; },
  sigType:   (s,c) => `<td class="l">${c.ev ? (c.ev.type === 'initial' ? '初回購入' : '買い増し') : muted}</td>`,
  // 現在値: 価格があれば株探チャートへの外部リンク。未取得時は手入力ボタンのまま。
  price:     (s,c) => `<td>${c.price != null ? `<a href="${kabutanUrl(s)}" target="_blank" rel="noopener" class="lnk-ext">${fmtAmt(c.price, c.market)}</a>` : c.priceCell}</td>`,
  // 時間外: 米株プレ/アフター価格＋前日比（対前日終値）＋種別タグ。
  extPrice:  (s,c) => { const p = store.data.prices[priceKey(s)] || {}; if (p.extPrice == null) return `<td>${muted}</td>`; const lbl = p.extType === 'pre' ? 'プレ' : p.extType === 'post' ? 'アフター' : ''; const d = (p.prevClose && p.extPrice) ? (p.extPrice - p.prevClose) / p.prevClose * 100 : null; return `<td class="${d != null ? cls(d) : ''}">${fmtAmt(p.extPrice, c.market)}${d != null ? ` <span style="font-size:11px">${signed(d)}%</span>` : ''} <span class="muted" style="font-size:10px">${lbl}</span></td>`; },
  // 前日比: 株探チャートへの外部リンク。条件付き背景・文字色(緑/赤)は維持。
  day:       (s,c) => { const v = c.dayChg, st = condStyle('day', v); const pm = c.dayIsPrev ? '<span class="muted" style="font-size:9px" title="寄り付き前のため前営業日の値動きを表示">前</span>' : ''; return `<td class="${st ? '' : cls(v)}"${st}><a href="${kabutanUrl(s)}" target="_blank" rel="noopener" class="lnk-ext">${v != null ? signed(v) + '%' : '—'}</a>${pm}</td>`; },
  trigger:   (s,c) => `<td>${c.ev ? (c.ev.baseSource === 'みなし' ? MINASHI : c.ev.baseSource === '固定' ? FIXED_MARK : '') + c.m(c.ev.trigger) : muted}</td>`,
  // 適用区分: 次回購入・残り下落率がどのルール分岐で算出されたか（初=初回 / 増=買い増し / 高=高値更新 / 固=買増固定値 / —=判定外）
  trigBasis: (s,c) => {
    const ev = c.ev;
    if (!ev) return `<td class="l">${muted}</td>`;
    let code, title;
    if (ev.baseSource === '固定') { code = '固'; title = '買増固定値（手入力の固定トリガー）'; }
    else if (ev.baseSource === '高値更新') { code = '高'; title = '高値更新（前回購入より後に最高値更新→初回ルールで判定）'; }
    else if (ev.type === 'initial') { code = '初'; title = '初回購入（基準高値から初回下落率）'; }
    else { code = '増'; title = '買い増し（前回購入単価から買い増し下落率）'; }
    return `<td class="l"><span class="tag basis-${code === '初' ? 'init' : code === '増' ? 'addon' : code === '高' ? 'high' : 'fixed'}" title="${title}">${code}</span></td>`;
  },
  base:      (s,c) => `<td>${c.ev ? (c.ev.baseSource === 'みなし' ? MINASHI : '') + c.m(c.ev.base) : muted}</td>`,
  // 残り下落率: 到達後はマイナス値（超過幅）も表示（SEC-38）。到達=赤(reached)、残り5%以内=near。
  drop:      (s,c) => !c.ev ? `<td>${muted}</td>`
                    : `<td class="drop ${c.ev.reached ? 'reached' : (c.ev.remainingDropPct <= 5 ? 'near' : 'far')}" title="${c.ev.reached ? 'トリガー超過（到達）' : 'あとこれだけ下落で到達'}">${c.ev.remainingDropPct.toFixed(1)}%</td>`,
  dropPrev:  (s,c) => { const v = calc.remainingDropPrev(s); return v == null ? `<td>${muted}</td>` : `<td class="drop ${v <= 0 ? 'reached' : (v <= 5 ? 'near' : 'far')}" title="前日終値時点で次回購入(トリガー)まで">${v.toFixed(1)}%</td>`; },
  high5y:    (s,c) => `<td>${c.high5y != null ? fmtAmt(c.high5y, c.market) : muted}</td>`,
  high52w:   (s,c) => `<td>${c.high52w != null ? fmtAmt(c.high52w, c.market) : muted}</td>`,
  dropFrom5y:  (s,c) => pctTdBg(calc.dropFrom5y(s), 'dropFrom5y'),
  dropFrom52w: (s,c) => pctTd(calc.dropFrom52w(s)),
  prevBuyPrice: (s,c) => { const lb = calc.lastBuyInfo(s); return `<td>${lb.price != null ? (lb.source === 'みなし' ? MINASHI : '') + fmtAmt(lb.price, c.market) : muted}</td>`; },
  // 前回購入日: 判定に使う実効値（取引履歴の最新買い日→無ければ手動入力の前回購入日）
  prevBuyDate: (s,c) => { const d = calc.lastBuyInfo(s).date; return `<td class="l">${d ? esc(d) : muted}</td>`; },
  dropFromPrev: (s,c) => pctTdBg(calc.dropFromPrev(s), 'dropFromPrev'),
  sector:    (s,c) => { const v = calc.field(s,'sector'); return `<td class="l">${v ? esc(v) : muted}</td>`; },
  industry:  (s,c) => { const v = calc.field(s,'industry'); return `<td class="l">${v ? esc(v) : muted}</td>`; },
  // 時価総額: 兆/億/万（米株は$T/B）表記に統一（売買代金と同形式）。marketCapは百万単位なので×1e6で実額化
  marketCap: (s,c) => { const v = calc.marketCap(s); return `<td title="時価総額">${v != null ? fmtTurnover(v * 1e6, c.market) : muted}</td>`; },
  turnover:  (s,c) => { const v = calc.turnover(s); return `<td title="現在値×当日出来高">${v != null ? fmtTurnover(v, c.market) : muted}</td>`; },
  value:     (s,c) => `<td>${c.th.qty ? fmtAmt(c.valN, c.market) + c.noPriceMark : muted}</td>`,
  cost:      (s,c) => `<td>${c.th.qty ? c.m(c.th.acquiredCost) : muted}</td>`,
  // 取得円(円): 米株=保有のacqJpy(取得円)合計（取込/手入力したもの）、日本株=取得単価×数量
  acqJpy:    (s,c) => {
    let v = null;
    if (s.market === 'US') { const hs = store.data.holdings.filter(h => h.securityId === s.id); if (hs.some(h => h.acqJpy != null)) v = Math.round(hs.reduce((a, h) => a + (h.acqJpy || 0), 0)); }
    else v = c.th.qty ? Math.round(c.th.avgCost * c.th.qty) : null;
    return `<td>${v != null ? num(v) : muted}</td>`;
  },
  pnl:       (s,c) => pctTd(c.pnlPct),
  avgCost:   (s,c) => `<td>${c.th.qty ? fmtAmt(c.th.avgCost, c.market) : muted}</td>`,
  qty:       (s,c) => `<td>${c.th.qty ? fmtQty(c.th.qty, c.market) : '<span class="muted">0</span>'}</td>`,
  buyCount:  (s,c) => `<td>${c.buyCnt ? num(c.buyCnt) : muted}</td>`,
  buyAmount: (s,c) => `<td>${c.buyAmt != null ? fmtAmtInt(c.buyAmt) : muted}</td>`,
  reco:      (s,c) => `<td>${c.recoAmt ? fmtAmtInt(c.recoAmt) : muted}</td>`,
  category:  (s,c) => `<td class="l">${s.category ? `<span class="tag">${esc(s.category)}</span>` : muted}</td>`,
  ruleName:  (s,c) => { const r = store.rule(s.ruleId); return `<td class="l">${r ? esc(r.name) : muted}</td>`; },
  fixedBuyPrice: (s,c) => `<td>${typeof s.fixedBuyPrice === 'number' ? fmtAmt(s.fixedBuyPrice, c.market) : muted}</td>`,
  rating:    (s,c) => `<td class="l">${gradeBadge(s)}</td>`,
  per:       (s,c) => { const v = calc.per(s); return `<td>${v != null ? num(v) : muted}</td>`; },
  dividend:  (s,c) => { const v = calc.field(s,'dividend'); return `<td>${v != null ? c.m(v) : muted}</td>`; },
  divYield:  (s,c) => { const v = calc.divYield(s); return `<td>${v != null ? v.toFixed(2) + '%' : muted}</td>`; },
  eps:       (s,c) => { const v = calc.field(s,'eps'); return `<td>${v != null ? c.m(v) : muted}</td>`; },
  overallGrade: (s,c) => `<td class="l">${s.overallGrade ? `<span class="grade grade-${esc(String(s.overallGrade).toLowerCase())}">${esc(s.overallGrade)}</span>` : muted}</td>`,
  buyGrade:  (s,c) => `<td class="l">${s.buyGrade ? `<span class="grade grade-${esc(String(s.buyGrade).toLowerCase())}">${esc(s.buyGrade)}</span>` : muted}</td>`,
  priority:  (s,c) => `<td>${s.priority != null ? num(s.priority) : muted}</td>`,
  stars:     (s,c) => { const a = [s.starValuation, s.starStrength, s.starRisk]; return `<td class="l">${a.some(x => x != null) ? a.map(x => x ?? '—').join('/') : muted}</td>`; },
  analysisDate: (s,c) => `<td class="l">${s.analysisDate ? esc(s.analysisDate) : muted}</td>`,
  analysisNote: (s,c) => `<td class="l" title="${esc(s.analysisNote || '')}">${s.analysisNote ? esc(String(s.analysisNote).slice(0, 24)) + (s.analysisNote.length > 24 ? '…' : '') : muted}</td>`,
};

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
  ruleName:      { kind: 'sec', type: 'select', get: s => String(s.ruleId || store.defaultRule().id), patch: v => ({ ruleId: parseInt(v, 10) }),
                   options: () => store.data.rules.map(r => ({ v: String(r.id), l: r.name + (r.isDefault ? '（既定）' : '') })) },
  detailType:    { kind: 'sec', type: 'select', get: s => s.detailType || '', patch: v => ({ detailType: v || null }),
                   options: (s) => [{ v: '', l: '自動（' + autoDetailType(s) + '）' }, { v: '個別株', l: '個別株' }, { v: 'ETF', l: 'ETF' }] },
  prevBuyPrice:  { kind: 'sec', type: 'number', split: true, get: s => s.prevBuyPrice ?? '', patch: v => ({ prevBuyPrice: ieNum(v) }) },
  prevBuyDate:   { kind: 'sec', type: 'date',   get: s => s.prevBuyDate || '', patch: v => ({ prevBuyDate: v || null }) },
  fixedBuyPrice: { kind: 'sec', type: 'number', split: true, get: s => s.fixedBuyPrice ?? '', patch: v => ({ fixedBuyPrice: ieNum(v) }) },
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
// 先頭から連続する「選択列→コード→銘柄名」のみ固定（途中に他列が挟まる並べ替え時は固定しない＝レイアウト破綻防止）。
function applyStickyCols(table) {
  if (!table || !table.tHead || !table.tBodies[0]) return;
  const headRow = table.tHead.rows[0], bodyRow = table.tBodies[0].rows[0];
  if (!headRow || !bodyRow) return;
  [...table.rows].forEach(r => [...r.cells].forEach(c => { c.classList.remove('stick', 'stick-edge'); c.style.left = ''; }));
  const want = new Set([0]); // 先頭=選択(チェックボックス)列
  [...bodyRow.cells].forEach((td, i) => {
    if (i === 0) return;
    if (td.classList.contains('col-code')) want.add(i);                 // コード
    else if (td.querySelector && td.querySelector('.nm-strong')) want.add(i); // 銘柄名
  });
  const contiguous = [];
  for (let i = 0; want.has(i); i++) contiguous.push(i); // 0から連続するものだけ
  let left = 0;
  contiguous.forEach((ci, n) => {
    const w = headRow.cells[ci] ? headRow.cells[ci].getBoundingClientRect().width : 0;
    [...table.rows].forEach(r => {
      const c = r.cells[ci]; if (!c) return;
      c.classList.add('stick'); if (n === contiguous.length - 1) c.classList.add('stick-edge');
      c.style.left = left + 'px';
    });
    left += w;
  });
}

function render() {
  updateHeader();
  updateSignalBadge();
  updateSplitBadge();
  switch (currentView) {
    case 'dashboard': renderDashboard(); break;
    case 'market': renderMarketTab(); break;
    case 'holdings': renderMarket(holdingsMarket); break;
    case 'us': renderMarket('US'); break;
    case 'jp': renderMarket('JP'); break;
    case 'signals': renderSignals(); break;
    case 'splits': renderSplitsTab(); break;
    case 'report': renderReport(); break;
    case 'secmaster': renderSecMaster(); break;
    case 'import': renderImport(); break;
    case 'transfer': renderTransfer(); break;
    case 'master': renderMaster(); break;
  }
  fitListTables();
}

// 一覧テーブルの枠(.table-wrap)の高さを画面に合わせて制限し、枠内スクロール＋見出し固定を成立させる。
// （横スクロールを枠内に保ったまま thead を固定するため。ページ全体は極力スクロールさせない）
function fitListTables() {
  document.querySelectorAll('main .section .table-wrap').forEach(wrap => {
    wrap.style.maxHeight = '';                               // 一旦解除して自然な高さを測る
    const top = wrap.getBoundingClientRect().top;            // ビューポート上端からの位置
    // 画面下端まで（最低200px）。枠下の余白（section margin16 + main padding16 + border ≒ 36px）を引いて
    // ページ自体がスクロールしないようにする
    const avail = Math.max(240, window.innerHeight - top - 14);
    if (wrap.scrollHeight > avail) wrap.style.maxHeight = avail + 'px'; // はみ出す時だけ枠内スクロール化
  });
}
let _fitTimer = null;
window.addEventListener('resize', () => { clearTimeout(_fitTimer); _fitTimer = setTimeout(fitListTables, 120); });

// 再描画をはさんでも一覧テーブルの横/縦スクロール位置を維持する（ソート等で左端に戻らないように）
function preserveTableScroll(fn) {
  const w = document.querySelector('#app .table-wrap');
  const sl = w ? w.scrollLeft : 0, st = w ? w.scrollTop : 0;
  fn();
  if (!(sl || st)) return;
  const apply = () => { const w2 = document.querySelector('#app .table-wrap'); if (w2) { w2.scrollLeft = sl; w2.scrollTop = st; } };
  apply(); requestAnimationFrame(apply); setTimeout(apply, 30);
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
  const meas = document.createElement('span');
  meas.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:nowrap;font:' + font;
  document.body.appendChild(meas);
  // colspan のグループ見出し行などは列数が合わないので除外
  const rows = [...table.querySelectorAll('tbody tr')].filter(tr => tr.children.length === cols.length);
  cols.forEach((col, ci) => {
    if (col.dataset.autocol !== '1') return;
    let max = 0;
    rows.forEach(tr => { const td = tr.children[ci]; if (!td) return; meas.innerHTML = td.innerHTML; const w = meas.offsetWidth; if (w > max) max = w; });
    col.style.width = Math.max(44, Math.ceil(max) + 26) + 'px'; // +26 ≒ セル左右パディング
  });
  meas.remove();
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
    tickers.innerHTML = INDICES.map(tk).join('')
      + `<div class="fx-chip"><span class="t-label">USD/JPY</span><span class="t-val num">${fx ? fx.toFixed(2) : '—'}</span></div>`;
  }
  const um = document.getElementById('update-meta');
  if (um) {
    const t = store.data.lastPriceUpdate ? fmtDateTime(store.data.lastPriceUpdate).replace(/^\S+\s/, '') : '—';
    // 米株の価格ソースを併記（finnhub=ほぼリアルタイム / yahoo=15〜20分遅延）。判別・遅延の診断用
    const src = store.data.lastPriceSource;
    const srcLabel = src ? (/finnhub/.test(src) ? '<span style="color:var(--green,#16a34a)">Finnhub</span>' : `<span class="muted" title="米株は15〜20分遅延。リアルタイムにはFinnhubキー設定が必要">Yahoo(遅延)</span>`) : '';
    um.innerHTML = `更新<br><b>${t}</b>${srcLabel ? ` <span style="font-size:10px">${srcLabel}</span>` : ''}`;
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
    <div class="page-intro">
      <h2>ダッシュボード</h2>
      <p>ポートフォリオ全体のサマリーと本日の動き。${esc(luStr)} 時点・USD/JPY ${fxNow}。</p>
    </div>
    ${notes.map(n => `<div class="notice">${esc(n)}</div>`).join('')}
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

    <div class="section" style="margin-top:20px">
      <div class="section-head"><h2>買い増しサイン（到達済み）</h2>
        <span class="muted" style="margin-left:8px;font-size:12px">${reachedSecs.length} 件</span>
        <button class="btn btn-sm" style="margin-left:auto" onclick="go('signals')">一覧へ</button></div>
      <div class="section-body">${dashSignalsTable()}</div>
    </div>`;
}

// ---------- 市場別 一覧 ----------
// 格付のランク順（S が最上位＝昇順で先頭）。アルファベット順ではなくランク順でソート
const GRADE_RANK = { S: 0, A: 1, B: 2, C: 3, D: 4 };
// ソート用の比較値（一覧・サイン共通）
function sortValue(sec, key) {
  const th = calc.totalHolding(sec.id);
  switch (key) {
    case 'name': return calc.displayName(sec).toLowerCase();
    case 'ticker': return (sec.ticker || '').toLowerCase();
    case 'market': return sec.market;
    case 'detailType': return detailTypeOf(sec);
    case 'createdAt': return sec.createdAt || '';
    case 'updatedAt': return sec.updatedAt || '';
    case 'broker': return (calc.lastBroker(sec) || '').toLowerCase();
    case 'sigType': { const ev = calc.evaluate(sec); return ev ? ev.type : 'z'; }
    case 'category': return sec.category || '';
    case 'ruleName': { const r = store.rule(sec.ruleId); return r ? (r.name || '').toLowerCase() : ''; }
    case 'fixedBuyPrice': return sec.fixedBuyPrice ?? -Infinity;
    case 'qty': return th.qty;
    case 'avgCost': return th.avgCost;
    case 'cost': return th.acquiredCost;
    case 'acqJpy': {
      if (sec.market === 'US') { const hs = store.data.holdings.filter(h => h.securityId === sec.id); return hs.some(h => h.acqJpy != null) ? hs.reduce((a, h) => a + (h.acqJpy || 0), 0) : -Infinity; }
      return th.qty ? th.avgCost * th.qty : -Infinity;
    }
    case 'sector': return calc.field(sec, 'sector') || 'zzz';
    case 'industry': return calc.field(sec, 'industry') || 'zzz';
    case 'marketCap': return calc.marketCap(sec) ?? -Infinity;
    case 'turnover': return calc.turnover(sec) ?? -Infinity;
    case 'per': return calc.per(sec) ?? Infinity;
    case 'divYield': return calc.divYield(sec) ?? -Infinity;
    case 'eps': return calc.field(sec, 'eps') ?? -Infinity;
    case 'overallGrade': return GRADE_RANK[sec.overallGrade] ?? 99;
    case 'buyGrade': return GRADE_RANK[sec.buyGrade] ?? 99;
    case 'analysisDate': return sec.analysisDate || '';
    case 'buyCount': return calc.buyCount(sec) || 0;
    case 'buyAmount': return calc.buyAmount(sec) ?? -Infinity;
    case 'reco': return store.categoryAmountFor(sec.category, sec.market) || -Infinity;
    case 'price': return calc.price(sec) ?? -Infinity;
    case 'high5y': return calc.high5y(sec) ?? -Infinity;
    case 'high52w': return calc.high52w(sec) ?? -Infinity;
    case 'prevBuyPrice': return calc.lastBuyPrice(sec) ?? -Infinity;
    case 'extPrice': { const p = store.data.prices[priceKey(sec)]; return (p && p.extPrice != null) ? p.extPrice : -Infinity; }
    case 'prevBuyDate': return calc.lastBuyInfo(sec).date || '';
    case 'dropFromPrev': return calc.dropFromPrev(sec) ?? Infinity;
    case 'dropFrom5y': return calc.dropFrom5y(sec) ?? Infinity;
    case 'dropFrom52w': return calc.dropFrom52w(sec) ?? Infinity;
    case 'value': return calc.valueOrCostNative(sec) ?? -Infinity;
    case 'pnl': return calc.pnlPctNative(sec) ?? -Infinity;
    case 'day': { const p = store.data.prices[priceKey(sec)] || {}; return (p.price != null && p.prevClose) ? (p.price - p.prevClose) / p.prevClose * 100 : -Infinity; }
    case 'trigger': { const ev = calc.evaluate(sec); return ev ? ev.trigger : -Infinity; }
    case 'base': { const ev = calc.evaluate(sec); return ev ? ev.base : -Infinity; }
    case 'drop': { const ev = calc.evaluate(sec); return ev ? ev.remainingDropPct : Infinity; }
    case 'dropPrev': return calc.remainingDropPrev(sec) ?? Infinity;
    case 'rating': return GRADE_RANK[sec.rating || sec.overallGrade] ?? 99;
    case 'priority': return sec.priority ?? Infinity;
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
  // 一覧に出すのは「保有あり(数量>0) または 注意銘柄」のみ。
  // 保有なし＆非注意（例: 分析後に全売却した銘柄）は一覧から外し、銘柄マスタタブで管理する。
  secs = secs.filter(s => s.watch || store.data.holdings.some(h => h.securityId === s.id && h.quantity > 0));
  if (st.broker)   secs = secs.filter(s => store.data.holdings.some(h => h.securityId === s.id && h.broker === st.broker && h.quantity > 0));
  if (st.account)  secs = secs.filter(s => store.data.holdings.some(h => h.securityId === s.id && h.accountType === st.account && h.quantity > 0));
  if (st.category) secs = secs.filter(s => s.category === st.category);
  if (st.detailType) secs = secs.filter(s => detailTypeOf(s) === st.detailType);
  if (holdingsSearch.trim()) {
    const k = holdingsSearch.trim().toLowerCase();
    secs = secs.filter(s => (s.ticker || '').toLowerCase().includes(k) || calc.displayName(s).toLowerCase().includes(k));
  }
  secs = sortSecurities(secs, colMkt);

  const catOpts = [...store.data.categories].sort((a, b) => a.sortOrder - b.sortOrder)
    .map(c => `<option value="${esc(c.category)}" ${st.category === c.category ? 'selected' : ''}>${esc(c.category)}</option>`).join('');

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

  const hasFilter = st.broker || st.account || st.category || st.detailType || holdingsSearch;
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
        <label class="chip">種別
          <select onchange="setFilter('${colMkt}','detailType',this.value)">
            <option value="">全て</option>
            <option value="個別株" ${st.detailType === '個別株' ? 'selected' : ''}>個別株</option>
            <option value="ETF" ${st.detailType === 'ETF' ? 'selected' : ''}>ETF</option>
          </select></label>
        <label class="chip">会社
          <select onchange="setFilter('${colMkt}','broker',this.value)">
            <option value="">全て</option>${BROKERS.map(b => `<option ${st.broker === b ? 'selected' : ''}>${b}</option>`).join('')}
          </select></label>
        <label class="chip">口座
          <select onchange="setFilter('${colMkt}','account',this.value)">
            <option value="">全て</option>${ACCOUNTS.map(a => `<option ${st.account === a ? 'selected' : ''}>${a}</option>`).join('')}
          </select></label>
        <label class="chip">カテゴリ
          <select onchange="setFilter('${colMkt}','category',this.value)">
            <option value="">全て</option>${catOpts}
          </select></label>
        ${hasFilter ? `<button class="btn btn-ghost btn-sm" onclick="clearHoldFilters('${colMkt}')">絞込解除</button>` : ''}
        <div class="tb-spacer"></div>
        <button class="btn btn-sm col-picker-btn" onclick="openColPicker('${colMkt}')" title="列の表示設定">${svgIcon('columns', '')} 列</button>
        <button class="btn btn-sm" onclick="copyDisplayedTable()" title="表示中の表をコピー">${svgIcon('copy', '')} 表コピー</button>
        <button class="btn btn-sm ${inlineEditOn ? 'btn-primary' : ''}" onclick="toggleInlineEdit()" title="一覧上で直接編集（誤操作防止トグル）">${svgIcon('edit', '')} 編集モード${inlineEditOn ? '：ON' : ''}</button>
      </div>
      ${inlineEditOn ? `<div class="ie-hint">✏️ 編集モード：対象セル（カテゴリ・ルール・前回購入単価/日・買増固定値・詳細種別・数量・取得単価）を直接編集 → <strong>「保存」</strong>で確定。<strong>Tab</strong>=右 / <strong>Enter</strong>=下 / <strong>Esc</strong>=このセルを取消。数量・取得単価は単一保有のみ（複数=⧉で保有フォーム）。
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
  applyStickyCols(document.querySelector('#app table.fixed-cols'));
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
    if (mc.noSort) return `<th class="${cls2}">${label}</th>`;
    const active = st.sortKey === col.key;
    // 矢印スペースを常時予約（ソートで列幅が変わらないように）
    const arrow = `<span class="sort-arrow">${active ? (st.sortDir === 1 ? '▲' : '▼') : ''}</span>`;
    return `<th class="sortable ${cls2} ${active ? 'active' : ''}" onclick="setSort('${market}','${col.key}')">${label}${arrow}</th>`;
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
  if (!confirm(`選択した ${ids.length} 件を全売却（数量を0に）します。\n\n${names.join('、')}\n\nよろしいですか？`)) return;
  ids.forEach(id => store.sellAll(id));
  render();
  toast(`${ids.length} 件を全売却しました`);
}

// opts: { select: true で先頭にチェックボックス列, actions: 'list'|'signal' }
function marketRow(sec, visibleCols, opts = {}) {
  const market = sec.market; // ccy/ev は銘柄の市場で判定（サインタブの混在に対応）
  const th = calc.totalHolding(sec.id);
  const p = store.data.prices[priceKey(sec)] || {};
  const price = p.price ?? null;
  const ccy = MARKET_CCY[market];
  const ctx = {
    ccy, market, th,
    ev: market !== 'FUND' ? calc.evaluate(sec) : null,
    price,
    priceCell: price != null ? fmtAmt(price, market) : priceInputBtn(sec),
    noPriceMark: (price == null && th.qty > 0) ? ' <span class="muted" title="価格未取得・取得原価で表示">*</span>' : '',
    valN: calc.valueOrCostNative(sec),
    pnlPct: calc.pnlPctNative(sec),
    // 前日比: 通常は現在値−前日終値。寄り付き前(現在値==前日終値で0%)は「前営業日の値動き」を表示（dayIsPrev）。
    dayChg: (() => { if (price == null || !p.prevClose) return null; const live = (price - p.prevClose) / p.prevClose * 100; return (live === 0 && p.prevDayPct != null) ? p.prevDayPct : live; })(),
    dayIsPrev: (price != null && p.prevClose && (price - p.prevClose) === 0 && p.prevDayPct != null),
    buyAmt: calc.buyAmount(sec),
    buyCnt: calc.buyCount(sec),
    recoAmt: store.categoryAmountFor(sec.category, market),
    high5y: calc.high5y(sec),
    high52w: calc.high52w(sec),
    prevBuy: calc.lastBuyPrice(sec),
    m: (v) => v != null ? fmtAmt(v, market) : '<span class="muted">—</span>',
  };
  const selectTd = opts.select ? `<td class="l"><input type="checkbox" class="row-select" data-id="${sec.id}"></td>` : '';
  // 編集モード(SEC-94): 一覧(取引/保有/編集アクションを持つ表)でのみ対象列をインライン入力化。サイン/アクション無しの表は対象外
  const editable = inlineEditOn && opts.actions !== 'signal' && opts.actions !== 'none';
  const dataCells = visibleCols.map(col => {
    if (editable && INLINE_FIELDS[col.key]) { const h = ieCellHtml(sec, col.key, ctx); if (h) return h; }
    const renderer = COL_RENDERERS[col.key];
    return renderer ? renderer(sec, ctx) : `<td></td>`;
  }).join('');
  let actionsTd = '';
  if (opts.actions === 'signal') {
    actionsTd = `<td class="l nowrap"><button class="btn btn-sm btn-primary" onclick="openTxnForm(${sec.id},'buy')">購入を記録</button></td>`;
  } else if (opts.actions !== 'none') {
    actionsTd = `<td class="l nowrap">
        <button class="btn btn-sm" onclick="openTxnForm(${sec.id})">取引</button>
        <button class="btn btn-sm" onclick="openHoldingsForm(${sec.id})">保有</button>
        <button class="btn btn-sm" onclick="openSecurityForm(${sec.id})">編集</button>
      </td>`;
  }
  return `<tr>${selectTd}${dataCells}${actionsTd}</tr>`;
}

// 銘柄格付（★評価はツールチップに格納してコンパクトに）
function gradeBadge(sec) {
  const g = sec.rating || sec.overallGrade;
  if (!g) return '<span class="muted">—</span>';
  const stars = [sec.starValuation, sec.starStrength, sec.starRisk].filter(x => x != null);
  const title = stars.length ? ` title="バリュエーション/強み/リスク ★${stars.join('/')}"` : '';
  return `<span class="grade grade-${esc(String(g).toLowerCase())}"${title}>${esc(g)}</span>`;
}

function priceInputBtn(sec) {
  return `<button class="btn btn-sm" onclick="openPriceInput(${sec.id})">価格入力</button>`;
}

function setSort(market, key) {
  const st = listState[market];
  if (st.sortKey === key) st.sortDir *= -1; else { st.sortKey = key; st.sortDir = 1; }
  preserveTableScroll(render);
}
function setFilter(market, field, value) { listState[market][field] = value; render(); }
function clearFilter(market) { Object.assign(listState[market], { broker: '', account: '', category: '', detailType: '' }); render(); }

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

function openColPicker(market) {
  _colPickerMarket = market;
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
      <input type="text" value="${esc(c.labelOverride || '')}" placeholder="${esc(mc.label)}" onchange="cpSetLabel('${c.key}', this.value)" title="列名（空欄＝既定: ${esc(mc.label)}）" style="flex:1;min-width:140px">
      <label class="muted" style="display:flex;align-items:center;gap:3px;font-size:11px;white-space:nowrap" title="データの最大幅に自動調整（列名は無視）"><input type="checkbox" ${c.auto ? 'checked' : ''} onchange="cpSetAuto('${c.key}',this.checked)" style="width:auto">自動</label>
      <input type="number" min="40" step="2" value="${colWidthPx(c)}" ${c.auto ? 'disabled' : ''} onfocus="this.select()" onchange="cpSetWidth('${c.key}', this.value)" title="列幅(px)" style="width:74px;text-align:right${c.auto ? ';opacity:.4' : ''}"><span class="muted" style="font-size:11px">px</span>
    </div>`;
  }).join('');
  const other = market === 'US' ? 'JP' : market === 'JP' ? 'US' : null;
  const copyBtn = other ? `<button type="button" class="btn btn-sm" onclick="copyColLayout('${market}','${other}')">この設定を${MARKET_LABEL[other]}にもコピー</button>` : '';
  showModal('列の表示・並び替え・幅・列名', `
    <p class="muted" style="margin:0 0 8px">チェック=表示/非表示、ハンドル(⠿)ドラッグで並び替え、テキスト=列名（空欄で既定）、数値=列幅(px)。</p>
    <div class="btn-row" style="align-items:center;margin:0 0 8px">
      <span class="muted">全列幅を</span>
      <input type="number" id="cp-all-width" min="40" step="2" value="90" onfocus="this.select()" style="width:74px;text-align:right">
      <span class="muted">px に</span>
      <button type="button" class="btn btn-sm" onclick="cpSetAllWidths()">一括設定</button>
      <span style="flex:1"></span>
      <button type="button" class="btn btn-sm" onclick="cpReset()">既定に戻す</button>
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
// 列レイアウト（表示/非表示・並び順）を他の市場へコピー。米国株↔日本株。
function copyColLayout(fromMarket, toMarket) {
  reconcileColPrefs(fromMarket);
  colPrefs[toMarket] = colPrefs[fromMarket].map(c => ({ key: c.key, visible: c.visible, width: c.width, labelOverride: c.labelOverride, auto: c.auto }));
  reconcileColPrefs(toMarket); // toMarket に無い列を除去・新規列を補完（米国株/日本株は同一列なので実質そのまま）
  saveColPrefs();
  toast(`列設定を${MARKET_LABEL[toMarket]}にコピーしました`, 4000);
  openColPicker(_colPickerMarket);
}
function cpToggle(key, checked) {
  const order = getColOrder(_colPickerMarket);
  const c = order.find(x => x.key === key);
  if (c) { c.visible = checked; saveColPrefs(); }
}
function cpSetWidth(key, px) {
  const order = getColOrder(_colPickerMarket);
  const c = order.find(x => x.key === key);
  if (c) { const n = parseInt(px, 10); c.width = (isNaN(n) || n < 40) ? undefined : n; saveColPrefs(); }
}
// 列幅モード: auto=データ最大幅に自動調整（列名無視）／固定=px指定
function cpSetAuto(key, checked) {
  const order = getColOrder(_colPickerMarket);
  const c = order.find(x => x.key === key);
  if (c) { c.auto = !!checked; saveColPrefs(); openColPicker(_colPickerMarket); }
}
function cpSetAllWidths() {
  const n = parseInt((document.getElementById('cp-all-width') || {}).value, 10);
  if (isNaN(n) || n < 40) { toast('40以上の幅を入力してください'); return; }
  getColOrder(_colPickerMarket).forEach(c => c.width = n);
  saveColPrefs(); openColPicker(_colPickerMarket);
  toast(`全列幅を ${n}px にしました`, 3000);
}
function cpSetLabel(key, val) {
  const order = getColOrder(_colPickerMarket);
  const c = order.find(x => x.key === key);
  if (c) { const v = (val || '').trim(); c.labelOverride = v || undefined; saveColPrefs(); }
}
function cpDragStart(e, idx) { _dragSrcIdx = idx; e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('cp-dragging'); }
function cpDragOver(e, idx) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
function cpDrop(e, idx) {
  e.preventDefault();
  if (_dragSrcIdx === null || _dragSrcIdx === idx) return;
  const order = getColOrder(_colPickerMarket);
  const [moved] = order.splice(_dragSrcIdx, 1);
  order.splice(idx, 0, moved);
  saveColPrefs();
  // DOM内で並び替え反映（モーダル再描画）
  openColPicker(_colPickerMarket);
}
function cpDragEnd() { _dragSrcIdx = null; document.querySelectorAll('.cp-dragging').forEach(el => el.classList.remove('cp-dragging')); }
function cpReset() { resetColPrefs(_colPickerMarket); openColPicker(_colPickerMarket); }

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
  const visOrderS = getColOrder('SIGNAL').filter(c => c.visible);
  const visibleCols = visOrderS.map(c => MASTER_COLS.find(m => m.key === c.key)).filter(Boolean);
  const colCount = visibleCols.length + 1; // +1 = アクション列
  const head = colHeadHtml(visibleCols, st, 'SIGNAL', null);
  // 末尾=操作列（購入を記録ボタン）。狭いと切れるため十分な幅を確保
  const SIG_ACTION_W = 116;
  const sigColgroup = `<colgroup>${visOrderS.map(c => colTag(c)).join('')}<col style="width:${SIG_ACTION_W}px"></colgroup>`;
  const sigTableW = SIG_ACTION_W + visOrderS.reduce((a, c) => a + colWidthPx(c), 0);
  // 到達／もうすぐ を1つの表にまとめ、グループ見出し行で区切る（列幅を揃えるため）
  const groupRow = (label, cls2, n) => `<tr class="sig-group ${cls2}"><td class="l" colspan="${colCount}" style="position:sticky;left:0;text-align:left">${label}　${n} 件</td></tr>`;
  const bodyRows = (secs) => secs.length
    ? secs.map(sec => marketRow(sec, visibleCols, { actions: 'signal' })).join('')
    : `<tr><td class="muted" colspan="${colCount}" style="padding:12px 16px">該当する銘柄はありません。</td></tr>`;
  const seg = (m, label) => `<button class="${signalMarketFilter === m ? 'active' : ''}" onclick="setSignalMarket('${m}')">${label}</button>`;
  app.innerHTML = `
    <div class="section">
      <div class="section-head">
        <div class="seg" role="tablist">${seg('all', '全市場')}${seg('JP', '日本株')}${seg('US', '米国株')}</div>
        <div style="flex:1"></div>
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
}

// ダッシュボード用の簡易サイン表（到達のみ・上位）
function dashSignalsTable() {
  const { reached } = signalRows();
  if (reached.length === 0) return `<div class="empty">現在、買い増しサインに到達している銘柄はありません。</div>`;
  const cols = ['ticker', 'name', 'market', 'price', 'drop', 'trigger', 'buyAmount']
    .map(k => MASTER_COLS.find(m => m.key === k));
  const head = cols.map(c => `<th class="${c.left ? 'l' : ''}">${c.label}</th>`).join('');
  const sorted = sortSecurities(reached, 'SIGNAL');
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
  const curRow = `<tr><td class="l">現在</td><td class="l">${sec.category ? esc(sec.category) : '—'}</td>
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
    <div class="form-actions"><button type="button" class="btn" onclick="closeModal()">閉じる</button></div>`);
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
let reportPeriod = 'all'; // 'all' | 'ytd'
function setReportPeriod(p) { reportPeriod = p; renderReport(); }
// ============ マーケット（ランキング）タブ ============
let mktState = { market: 'US', sub: 'all', kind: 'turnover' };
let mktCache = {};   // key -> { items, at }
let mktBusy = false;
const MKT_KINDS = [['turnover', '売買代金'], ['marketcap', '時価総額'], ['gainers', '値上がり'], ['losers', '値下がり']];
const MKT_JP_SUBS = [['all', '全市場'], ['prime', 'プライム'], ['standard', 'スタンダード'], ['growth', 'グロース']];
function mktKey() { return `${mktState.market}:${mktState.market === 'JP' ? mktState.sub : '-'}:${mktState.kind}`; }
function setMktMarket(m) { mktState.market = m; if (m === 'US') mktState.sub = 'all'; renderMarketTab(); }
function setMktSub(s) { mktState.sub = s; renderMarketTab(); }
function setMktKind(k) { mktState.kind = k; renderMarketTab(); }
function mktRefresh() { loadRanking(true); }
function mktAbbr(n) { if (n == null) return '—'; const a = Math.abs(n); if (a >= 1e12) return (n / 1e12).toFixed(2) + '兆'; if (a >= 1e8) return (n / 1e8).toFixed(1) + '億'; if (a >= 1e6) return (n / 1e6).toFixed(0) + 'M'; return Number(n).toLocaleString('ja-JP'); }
function mktKabutan(code, market) { return market === 'US' ? `https://us.kabutan.jp/stocks/${encodeURIComponent(code)}/chart` : `https://kabutan.jp/stock/chart?code=${encodeURIComponent(code)}`; }
function mktFindSec(code, market) { return store.data.securities.find(s => s.market === market && (s.ticker || '').toUpperCase() === String(code).toUpperCase()); }
function mktClickName(code, market) { const s = mktFindSec(code, market); if (s) openSecurityDetail(s.id); else window.open(mktKabutan(code, market), '_blank'); }
function addRankingWatch(code, market) {
  let s = mktFindSec(code, market);
  if (s) { store.updateSecurity(s.id, { watch: true }); toast(`${code} を注意銘柄にしました`); }
  else {
    s = store.addSecurity({ market, ticker: String(code).toUpperCase(), currency: market === 'US' ? 'USD' : 'JPY', assetClass: 'stock', enabled: true, watch: true, ruleId: store.defaultRule().id });
    toast(`${code} を注意銘柄として追加しました（保有銘柄で監視）`);
    api.refreshPrice([s]).then(() => { if (currentView === 'market') renderMarketTab(); });
  }
  renderMarketTab();
}
async function loadRanking(force) {
  const key = mktKey();
  if (mktBusy) return;
  if (!force && mktCache[key]) { renderMarketTab(); return; }
  mktBusy = true; renderMarketTab();
  try {
    const { market, sub, kind } = mktState;
    const r = await fetch(`/api/ranking?market=${market}&kind=${kind}&sub=${sub}&count=30`).then(x => x.ok ? x.json() : { items: [] }).catch(() => ({ items: [] }));
    let items = (r && r.items) || [];
    // 日本株は価格・前日比が取得元HTMLに無いため /api/price で補完（提供元の確実な値）
    if (market === 'JP' && items.length) {
      const syms = items.map(it => it.code + '.T');
      const pr = await fetch(`/api/price?symbols=${encodeURIComponent(syms.join(','))}`).then(x => x.ok ? x.json() : {}).catch(() => ({}));
      items = items.map(it => { const q = pr[it.code + '.T']; const price = q && !q.error ? q.price : null; const changePct = (price != null && q && q.prevClose) ? (price - q.prevClose) / q.prevClose * 100 : null; return { ...it, price, changePct }; });
    }
    // 米株は名称を日本語化（保有銘柄と同ルール。例 AAPL→アップル）。names=1 は1銘柄1リクエストで軽量
    if (market === 'US' && items.length) {
      const nm = await fetch(`/api/info?names=1&symbols=${encodeURIComponent(items.map(it => it.code).join(','))}`).then(x => x.ok ? x.json() : {}).catch(() => ({}));
      items = items.map(it => { const n = nm[it.code]; return (n && n.name) ? { ...it, name: n.name } : it; });
    }
    mktCache[key] = { items, at: Date.now() };
  } catch (_) { mktCache[key] = { items: [], at: Date.now() }; }
  mktBusy = false; renderMarketTab();
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
function renderMarketTab() {
  const key = mktKey(); const cache = mktCache[key]; const items = cache ? cache.items : null;
  const { market, sub, kind } = mktState;
  const mseg = `<div class="seg"><button class="${market === 'US' ? 'active' : ''}" onclick="setMktMarket('US')">米国株</button><button class="${market === 'JP' ? 'active' : ''}" onclick="setMktMarket('JP')">日本株</button></div>`;
  const subseg = market === 'JP' ? `<div class="seg" style="margin-left:6px;flex-wrap:wrap">${MKT_JP_SUBS.map(([v, l]) => `<button class="${sub === v ? 'active' : ''}" onclick="setMktSub('${v}')">${l}</button>`).join('')}</div>` : '';
  const kseg = `<div class="seg">${MKT_KINDS.map(([v, l]) => `<button class="${kind === v ? 'active' : ''}" onclick="setMktKind('${v}')">${l}</button>`).join('')}</div>`;
  let body;
  if (!items) body = '<div class="empty">読み込み中…</div>';
  else if (!items.length) body = '<div class="empty">データを取得できませんでした（休場/時間外、または取得元の仕様変更の可能性）。「更新」で再取得できます。</div>';
  else {
    // データのある列だけ表示（全行nullの列は隠す）。日本株はランキング種別ごとに片方しか取得元に無いため。
    const showTurnover = items.some(it => it.turnover != null);
    const showMktCap = items.some(it => it.marketCap != null);
    const rows = items.map((it, i) => {
      const owned = !!mktFindSec(it.code, market);
      const dc = it.changePct;
      const priceTxt = it.price != null ? fmtAmt(it.price, market) : '—';
      return `<tr>
        <td>${i + 1}</td>
        <td class="l"><span class="tag ${market.toLowerCase()}">${esc(mktMarketLabel(it, market))}</span></td>
        <td class="l col-code"><span class="tk ${market.toLowerCase()}" style="cursor:pointer" onclick="mktClickName('${esc(it.code)}','${market}')">${esc(it.code)}</span></td>
        <td class="l"><strong class="lnk-ext nm-strong" onclick="mktClickName('${esc(it.code)}','${market}')">${esc(it.name || it.code)}</strong>${owned ? ' <span class="tag" title="登録済み">登</span>' : ''}</td>
        <td><a href="${mktKabutan(it.code, market)}" target="_blank" rel="noopener" class="lnk-ext">${priceTxt}</a></td>
        <td class="${cls(dc)}"><a href="${mktKabutan(it.code, market)}" target="_blank" rel="noopener" class="lnk-ext">${dc != null ? signed(dc) + '%' : '—'}</a></td>
        ${showTurnover ? `<td>${mktAmt(it.turnover, market)}</td>` : ''}
        ${showMktCap ? `<td>${mktAmt(it.marketCap, market)}</td>` : ''}
        <td class="l nowrap"><button class="btn btn-sm" onclick="addRankingWatch('${esc(it.code)}','${market}')" title="保有銘柄の注意(監視)に追加">＋注意</button></td>
      </tr>`;
    }).join('');
    body = `<div class="table-wrap"><table class="holdings dense"><thead><tr><th>順位</th><th class="l">市場</th><th class="l">コード</th><th class="l">名称</th><th>現在値</th><th>前日比</th>${showTurnover ? '<th>売買代金</th>' : ''}${showMktCap ? '<th>時価総額</th>' : ''}<th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  app.innerHTML = `
    <div class="section">
      <div class="section-head"><h2>マーケット ランキング（上位30）</h2>
        <button class="btn btn-sm btn-primary" onclick="mktRefresh()" ${mktBusy ? 'disabled' : ''}>${mktBusy ? '取得中…' : '更新'}</button></div>
      <div class="toolbar" style="border:none;padding:10px 16px 0;gap:8px;flex-wrap:wrap">${mseg}${subseg}</div>
      <div class="toolbar" style="border:none;padding:8px 16px 0;gap:8px;flex-wrap:wrap"><span class="muted">ランキング</span>${kseg}
        ${market === 'JP' ? '<span class="muted" style="font-size:11px">※日本株の現在値・前日比は価格APIから取得</span>' : ''}</div>
      <div class="section-body" style="padding:12px 16px 16px">${body}</div>
    </div>`;
  fitListTables(); // 表を枠内スクロールに（ページ全体でなく表内でスクロール・画面に収める）
  if (!items && !mktBusy) loadRanking(false); // タブを開いた時（起動時相当）に自動取得
}

function renderReport() {
  const byMarket = {}, byBroker = {}, matrix = {}, byTypeMarket = {}, byBrokerSeg = {};
  let fxMissing = false;
  const ensure = (o, k) => (o[k] || (o[k] = { valJpy: 0, costJpy: 0, secs: new Set() }));
  for (const h of store.data.holdings) {
    if (!(h.quantity > 0)) continue;
    const sec = store.data.securities.find(s => s.id === h.securityId); if (!sec) continue;
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

  // 取引サマリー（期間: 全期間 / 今年）
  const yStart = `${new Date().getFullYear()}-01-01`;
  let buyTot = 0, sellTot = 0, buyN = 0, sellN = 0;
  for (const t of store.data.transactions) {
    if (reportPeriod === 'ytd' && !(t.tradedAt && t.tradedAt >= yStart)) continue;
    const sec = store.data.securities.find(s => s.id === t.securityId); if (!sec) continue;
    const amt = calc.toJpy(sec.market, (t.price || 0) * (t.quantity || 0)); if (amt == null) continue;
    if (t.type === 'buy') { buyTot += amt; buyN++; } else if (t.type === 'sell') { sellTot += amt; sellN++; }
  }
  const net = buyTot - sellTot;
  const seg = (p, l) => `<button class="${reportPeriod === p ? 'active' : ''}" onclick="setReportPeriod('${p}')">${l}</button>`;

  app.innerHTML = `
    <div class="page-intro">
      <h2>レポート</h2>
      <p>市場・種別・証券会社ごとの資産集計と取引サマリー（円換算）。</p>
    </div>
    <div class="cards">
      <div class="stat feature"><div class="s-label">総資産（円換算）</div><div class="s-value"><span class="cur">¥</span>${num(Math.round(totalVal))}</div></div>
      <div class="stat"><div class="s-label">取得原価（円換算）</div><div class="s-value num">${yen(totalCost)}</div></div>
      <div class="stat"><div class="s-label">評価損益</div><div class="s-value num ${pnlCls}">${yen(pnl)}</div><div class="s-sub ${cls(pnlPct)}" style="font-weight:700">${signed(pnlPct)}%</div></div>
    </div>
    ${fxMissing ? '<div class="notice">USD/JPY 為替が未取得のため、円換算に米国株を含めていません。「価格更新」で取得できます。</div>' : ''}
    <div class="section"><div class="section-head"><h2>市場別の集計（円換算）</h2><span class="muted" style="margin-left:auto;font-size:11px">バー＝総資産に対する構成比</span></div>
      ${mkBreak ? `<div class="breakdown">${mkBreak}</div>` : '<div class="empty">保有銘柄がありません。</div>'}</div>
    <div class="section"><div class="section-head"><h2>種別 × 市場の集計（円換算）</h2></div>
      <div class="table-wrap"><table><thead><tr><th class="l">種別 / 市場</th><th>評価額</th><th>取得原価</th><th>評価損益</th><th>損益率</th><th>銘柄数</th></tr></thead>
      <tbody>${tmRows || `<tr><td colspan="6" class="empty">保有銘柄がありません。</td></tr>`}</tbody></table></div>
      <p class="muted" style="padding:0 16px 12px">ETF・個別株・投資信託を分け、その下に日本株/米国株の内訳。種別行は小計です。詳細種別は「銘柄マスタ」で変更できます。</p></div>
    <div class="section"><div class="section-head"><h2>証券会社別の集計（円換算）</h2><span class="muted" style="margin-left:auto;font-size:11px">バー＝総資産比・色＝市場×種別</span></div>
      ${bkBreak ? `${segLegend}<div class="breakdown">${bkBreak}</div>` : '<div class="empty">保有銘柄がありません。</div>'}</div>
    <div class="section"><div class="section-head"><h2>証券会社 × 市場×種別（評価額・円換算）</h2></div>
      <div class="table-wrap"><table><thead><tr><th class="l">証券会社</th><th>米国株 個別株</th><th>米国株 ETF</th><th>日本株 個別株</th><th>日本株 ETF</th><th>合計</th></tr></thead>
      <tbody>${mxRows || `<tr><td colspan="6" class="empty">—</td></tr>`}</tbody></table></div></div>
    <div class="section"><div class="section-head"><h2>取引サマリー（${reportPeriod === 'ytd' ? '今年' : '全期間'}・円換算）</h2>
        <div class="seg" role="tablist" style="margin-left:auto">${seg('all', '全期間')}${seg('ytd', '今年')}</div></div>
      <div class="table-wrap"><table><thead><tr><th class="l">区分</th><th>件数</th><th>金額（円換算）</th></tr></thead>
        <tbody>
          <tr><td class="l">買い</td><td>${buyN}</td><td>${yen(buyTot)}</td></tr>
          <tr><td class="l">売り</td><td>${sellN}</td><td>${yen(sellTot)}</td></tr>
          <tr><td class="l"><strong>ネット投資額（買い−売り）</strong></td><td>—</td><td class="${cls(net)}"><strong>${yen(net)}</strong></td></tr>
        </tbody></table></div>
      <p class="muted" style="padding:0 16px 12px">※取引のある銘柄のみ。ロット単位の実現損益はロット管理が必要なため今後対応。</p></div>
    <div class="notice">資産推移（時系列グラフ）とサイン到達の履歴は、日々のスナップショット保存が前提のため、Googleスプレッドシート保存への移行後に対応予定です。</div>`;
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
let secMasterSort = { key: 'ticker', dir: 1 };
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
  { key: 'ruleId', label: '買い増しルール' },
  { key: 'rating', label: '銘柄格付' },
  { key: 'overallGrade', label: '総合評価' },
  { key: 'buyGrade', label: '買い時評価' },
];
let smBulkField = 'detailType';
// 一括変更の値コントロール（id指定で銘柄マスタ/保有の両方から使う）
function bulkValueHtml(field, id) {
  const gradeOpts = ['', 'S', 'A', 'B', 'C', 'D'].map(g => `<option value="${g}">${g || '（クリア）'}</option>`).join('');
  const catOpts = [...store.data.categories].sort((a, b) => a.sortOrder - b.sortOrder).map(c => `<option>${esc(c.category)}</option>`).join('');
  switch (field) {
    case 'detailType': return `<select id="${id}"><option value="個別株">個別株</option><option value="ETF">ETF</option><option value="__null">（自動判定に戻す）</option></select>`;
    case 'enabled': return `<select id="${id}"><option value="true">対象にする</option><option value="false">対象外にする</option></select>`;
    case 'watch': return `<select id="${id}"><option value="true">付ける</option><option value="false">外す</option></select>`;
    case 'category': return `<select id="${id}">${catOpts}</select>`;
    case 'ruleId': return `<select id="${id}">${store.data.rules.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select>`;
    case 'rating': case 'overallGrade': case 'buyGrade': return `<select id="${id}">${gradeOpts}</select>`;
    default: return `<input id="${id}" type="text">`;
  }
}
function bulkConvert(field, raw) {
  if (field === 'enabled' || field === 'watch') return raw === 'true';
  if (field === 'detailType') return raw === '__null' ? null : raw;
  if (field === 'ruleId') return parseInt(raw, 10);
  if (['rating', 'overallGrade', 'buyGrade'].includes(field)) return raw || null;
  return raw;
}
function smBulkFieldChange(f) { smBulkField = f; const c = document.getElementById('sm-bulk-value-wrap'); if (c) c.innerHTML = bulkValueHtml(f, 'sm-bulk-value'); }
function smBulkApply() {
  const ids = [...document.querySelectorAll('.sm-check:checked')].map(c => parseInt(c.value, 10));
  if (!ids.length) { toast('銘柄を選択してください'); return; }
  const val = bulkConvert(smBulkField, (document.getElementById('sm-bulk-value') || {}).value);
  for (const id of ids) store.updateSecurity(id, { [smBulkField]: val });
  store.save(); renderSecMaster();
  const fl = SM_BULK_FIELDS.find(f => f.key === smBulkField);
  toast(`${ids.length}件の「${fl ? fl.label : smBulkField}」を変更しました`, 4000);
}
// 保有銘柄一覧の一括変更（選択した .row-select に対して）
let holdBulkField = 'detailType';
function holdBulkFieldChange(f) { holdBulkField = f; const c = document.getElementById('hold-bulk-value-wrap'); if (c) c.innerHTML = bulkValueHtml(f, 'hold-bulk-value'); }
function holdBulkApply() {
  const ids = [...document.querySelectorAll('.row-select:checked')].map(b => parseInt(b.dataset.id, 10));
  if (!ids.length) { toast('銘柄を選択してください'); return; }
  const val = bulkConvert(holdBulkField, (document.getElementById('hold-bulk-value') || {}).value);
  for (const id of ids) store.updateSecurity(id, { [holdBulkField]: val });
  store.save(); render();
  const fl = SM_BULK_FIELDS.find(f => f.key === holdBulkField);
  toast(`${ids.length}件の「${fl ? fl.label : holdBulkField}」を変更しました`, 4000);
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
  const allSecs = [...store.data.securities].sort((a, b) => { const va = sortValue(a, sk), vb = sortValue(b, sk); if (va < vb) return -1 * dir; if (va > vb) return 1 * dir; return 0; });
  let secs = allSecs.filter(s => {
    if (secMasterFilter === 'noprice') return !smHasPrice(s);
    if (secMasterFilter === 'noholding') return !smHasHolding(s);
    if (secMasterFilter === 'holding') return smHasHolding(s);
    return true;
  });
  // 市場フィルター（全株式=US+JP / 米国株 / 日本株 / 投資信託）
  secs = secs.filter(s => secMasterMarket === 'ALL' ? (s.market === 'US' || s.market === 'JP') : s.market === secMasterMarket);
  if (secMasterSearch.trim()) {
    const k = secMasterSearch.trim().toLowerCase();
    secs = secs.filter(s => (s.ticker || '').toLowerCase().includes(k) || calc.displayName(s).toLowerCase().includes(k) || (calc.field(s, 'sector') || '').toLowerCase().includes(k));
  }
  // 編集モード(SEC-94): ナビゲーション用に編集可能列キー順（画面の列順）・行順を記録
  _ieCols = inlineEditOn ? ['detailType', 'ruleName', 'category'] : [];
  _ieRowIds = inlineEditOn ? secs.map(s => s.id) : [];
  const cell = (v, l) => `<td class="${l ? 'l ' : ''}">${v != null && v !== '' ? esc(String(v)) : muted}</td>`;
  // ソート可能なヘッダ（sortValue が各キーに対応）
  const SM_COLS = [
    { k: 'ticker', l: 'コード', c: 'l col-code' }, { k: 'name', l: '銘柄名', c: 'l' }, { k: 'market', l: '市場', c: 'l' },
    { k: 'detailType', l: '詳細種別', c: 'l' },
    { k: 'sector', l: 'セクター', c: 'l' }, { k: 'industry', l: '業種', c: 'l' }, { k: 'rating', l: '格付', c: 'l' },
    { k: 'overallGrade', l: '総合評価', c: 'l' }, { k: 'buyGrade', l: '買い時評価', c: 'l' },
    { k: 'priority', l: '優先順位', c: '' }, { k: 'ruleName', l: '買い増しルール', c: 'l' }, { k: 'category', l: 'カテゴリ', c: 'l' },
    { k: 'createdAt', l: '追加日', c: 'l' }, { k: 'updatedAt', l: '更新日', c: 'l' },
  ];
  const smHead = '<th class="l"><input type="checkbox" onclick="smSelectAll(this.checked)" title="全選択"></th>'
    + SM_COLS.map(col => { const active = sk === col.k; const arrow = `<span class="sort-arrow">${active ? (dir > 0 ? '▲' : '▼') : ''}</span>`; return `<th class="${col.c} sortable${active ? ' active' : ''}" onclick="setSecMasterSort('${col.k}')">${col.l}${arrow}</th>`; }).join('') + '<th class="l"></th>';
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
      <td class="l">${calc.field(s, 'sector') ? esc(calc.field(s, 'sector')) + ov('sector') : muted}</td>
      <td class="l">${calc.field(s, 'industry') ? esc(calc.field(s, 'industry')) + ov('industry') : muted}</td>
      <td class="l">${gradeBadge(s)}</td>
      ${cell(s.overallGrade, true)}
      ${cell(s.buyGrade, true)}
      <td>${s.priority != null ? num(s.priority) : muted}</td>
      ${inlineEditOn ? ieCellHtml(s, 'ruleName', null) : `<td class="l">${rule ? esc(rule.name) : muted}</td>`}
      ${inlineEditOn ? ieCellHtml(s, 'category', null) : `<td class="l">${s.category ? `<span class="tag">${esc(s.category)}</span>` : muted}</td>`}
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
          <span class="muted">${secs.length}/${allSecs.length}件</span>
        </div>
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
function renderMaster() {
  const cats = [...store.data.categories].sort((a, b) => a.sortOrder - b.sortOrder);
  const rules = store.data.rules;
  app.innerHTML = `
    <div class="section">
      <div class="section-head"><h2>カテゴリ別 金額マスタ</h2>
        <button class="btn btn-primary btn-sm" onclick="openCategoryEdit(null)">＋ カテゴリを追加</button></div>
      <div class="section-body"><div class="table-wrap"><table>
        <thead><tr><th class="l">カテゴリ</th><th class="l">位置づけ</th><th>日本株(円)</th><th>米国株($)</th><th>並び順</th><th></th></tr></thead>
        <tbody>${cats.map(c => `<tr>
          <td class="l">${esc(c.category)}</td><td class="l muted">${esc(c.label || '')}</td>
          <td>${yen(c.amountJpy)}</td><td>$${num(c.amountUsd)}</td><td>${c.sortOrder}</td>
          <td class="l nowrap"><button class="btn btn-sm" onclick="openCategoryEdit('${esc(c.category)}')">編集</button>
            <button class="btn btn-sm btn-danger" onclick="deleteCategory('${esc(c.category)}')">削除</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="muted" style="padding:0 16px 14px">金額は価格に左右されない固定値（ビジネスモデル・財務で決定）。日本株(円)・米国株($)を個別に登録できます。</p>
      ${amountHistorySection()}
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>買い増しルールマスタ</h2>
        <button class="btn btn-primary btn-sm" onclick="openRuleEdit(null)">＋ ルールを追加</button></div>
      <div class="section-body"><div class="table-wrap"><table>
        <thead><tr><th class="l">ルール名</th><th>初回 下落率</th><th>買い増し 下落率</th><th>基準高値</th><th>既定</th><th></th></tr></thead>
        <tbody>${rules.map(r => `<tr>
          <td class="l">${esc(r.name)}</td><td>−${r.initialDropPct}%</td><td>−${r.addonDropPct}%</td>
          <td>${BASE_HIGH_LABEL[r.baseHighMode] || r.baseHighMode}</td>
          <td>${r.isDefault ? '<span class="tag">既定</span>' : `<button class="btn btn-sm" onclick="setDefaultRule(${r.id})">既定に</button>`}</td>
          <td class="l nowrap"><button class="btn btn-sm" onclick="openRuleEdit(${r.id})">編集</button>
            ${rules.length > 1 ? `<button class="btn btn-sm btn-danger" onclick="deleteRule(${r.id})">削除</button>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="muted" style="padding:0 16px 14px">銘柄ごとの割当は各銘柄の「編集」から。未割当の銘柄は既定ルールを使用します。</p>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>投資信託 コードマスタ</h2></div>
      <div class="section-body" style="padding:16px">
        <div class="btn-row"><button class="btn btn-primary" onclick="openFundCodeMaster()">開く（名称↔コード）</button></div>
        <p class="muted grp-note" style="margin:8px 0 0">取り込んだ投信のコード（協会コード）編集・名称取得・統合を行います。ボタンから開きます。</p>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>取込変換マスタ</h2></div>
      <div class="section-body" style="padding:16px">
        <div class="btn-row"><button class="btn btn-primary" onclick="openImportAliasMaster()">開く（取込値→マスタ値の変換）</button></div>
        <p class="muted grp-note" style="margin:8px 0 0">取込時に「マスタに無い値」を変換した対応を記憶しています（カテゴリ/格付/詳細種別/ルール）。次回以降は自動変換されます。不要な対応はここから削除できます。</p>
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
      <div class="section-head"><h2>② 銘柄情報・分析を取り込む</h2></div>
      <div class="section-body" style="padding:16px">
        <div class="btn-row">
          <button class="btn" onclick="refreshAllMeta()">銘柄情報を更新（名前・セクター・PER等）</button>
          <button class="btn" onclick="openPasteImport('analysis')">銘柄分析結果を取込</button>
        </div>
        <p class="muted grp-note">「銘柄情報を更新」＝名前・セクター・ファンダを自動取得。「銘柄分析結果を取込」＝分析Excelを貼り付け。</p>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>汎用データ（取込 ⇄ 出力）</h2></div>
      <div class="section-body" style="padding:16px">
        <div class="btn-row">
          <button class="btn btn-primary" onclick="openGenericImport()">汎用取込（列を選んで取込）</button>
          <button class="btn" onclick="exportGeneric()">汎用出力（CSV）</button>
        </div>
        <p class="muted grp-note">CSV/Excelを貼り付け→列ごとに取込先を選んで上書き（コード・市場は必須）。分析・詳細種別・取得円・保有まで自由に取込でき、フォーマット保存も可能。汎用出力した内容はそのまま汎用取込で戻せます。</p>
      </div>
    </div>`;
}

// Google連携（実験的・任意）。クライアントID未設定なら休眠＝現行アプリに影響しない。
function googleSyncSection() {
  const g = (store.data.settings && store.data.settings.google) || {};
  const configured = !!g.clientId;
  return `<div class="section">
    <div class="section-head"><h2>Google連携（実験的・任意）</h2>
      <span class="tag ${configured ? 'jp' : ''}">${configured ? '設定済み' : '未設定'}</span></div>
    <div class="section-body" style="padding:16px">
      <p class="muted" style="margin:0 0 10px">ブラウザ完結方式(GIS)。Googleスプレッドシートへ手動で保存/読込（v1=JSONブロブ）。クライアントID未設定なら何も起きません。</p>
      <div id="gsync-status" style="margin:0 0 12px;font-size:13px;padding:8px 12px;background:var(--panel-2);border:1px solid var(--border);border-radius:8px">${gsync._token ? `<span class="pos">✓ ログイン中：${esc(gsync._email || '')}</span>` : '<span class="muted">未ログイン（「Googleでログイン」を押してください）</span>'}</div>
      <form id="gsync-form" onsubmit="return false">
        <div class="field"><label>OAuthクライアントID（…apps.googleusercontent.com）</label>
          <input name="gClientId" value="${esc(g.clientId || '')}" placeholder="Google Cloudで作成したウェブ用クライアントID"></div>
        <div class="row">
          <div class="field"><label>許可メール（カンマ区切り・任意）</label>
            <input name="gAllowed" value="${esc(g.allowedEmails || '')}" placeholder="you@gmail.com"></div>
          <div class="field"><label>スプレッドシートID</label>
            <input name="gSheetId" value="${esc(g.spreadsheetId || '')}" placeholder="スプレッドシートURLの /d/ と /edit の間"></div>
        </div>
        <div class="form-actions" style="justify-content:flex-start">
          <button type="button" class="btn btn-primary" onclick="gsaveSettings(this.form)">設定を保存</button>
          <button type="button" class="btn" onclick="gsyncSignIn()" ${configured ? '' : 'disabled'}>Googleでログイン</button>
          <button type="button" class="btn" onclick="gsyncSave()" ${configured ? '' : 'disabled'}>シートへ保存</button>
          <button type="button" class="btn" onclick="gsyncLoad()" ${configured ? '' : 'disabled'}>シートから読込</button>
        </div>
      </form>
      <p class="muted" style="margin:10px 0 0">事前にスプレッドシートへ <code>_appdata</code> という名前のシート(タブ)を1つ作成してください（A1セルにJSONを保存）。</p>
    </div>
  </div>`;
}

// ---------- モーダル/フォーム ----------
function showModal(title, bodyHtml, opts = {}) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  const m = document.querySelector('#modal-overlay .modal');
  if (m) m.classList.toggle('wide', !!opts.wide);
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

function openSecurityForm(id, presetMarket) {
  const sec = id ? store.data.securities.find(s => s.id === id) : null;
  const m = sec ? sec.market : (presetMarket || 'US');
  const catOpts = [...store.data.categories].sort((a, b) => a.sortOrder - b.sortOrder)
    .map(c => `<option value="${esc(c.category)}" ${sec && sec.category === c.category ? 'selected' : ''}>${esc(c.category)}</option>`).join('');
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
      <div class="row">
        <div class="field"><label>市場</label>
          <select name="market">${['US', 'JP'].map(x => `<option value="${x}" ${x === m ? 'selected' : ''}>${MARKET_LABEL[x]}</option>`).join('')}</select></div>
        <div class="field"><label>ティッカー / コード</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input name="ticker" value="${sec ? esc(sec.ticker) : ''}" placeholder="例: AAPL / 7203" required style="flex:1" onblur="autoFetchInfo(this)">
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
        <div class="field"><label>前回購入価格 / 前回購入日（買い取引が無い場合の基準・任意）</label>
          <div style="display:flex;gap:6px">
            <input name="prevBuyPrice" type="number" step="any" value="${sec && sec.prevBuyPrice != null ? sec.prevBuyPrice : ''}" placeholder="価格(原通貨)" style="flex:1">
            <input name="prevBuyDate" type="date" value="${sec && sec.prevBuyDate ? esc(sec.prevBuyDate) : ''}" title="前回購入日。高値更新判定（最高値が購入後か）の比較に使用。取引履歴があればそちらを優先" style="flex:1">
          </div></div>
      </div>
      <div class="row">
        <div class="field"><label>基準高値（個別上書き・任意）</label>
          <select name="baseHighMode" onchange="toggleBaseHighManual(this)">
            <option value="" ${!sec || !sec.baseHighMode ? 'selected' : ''}>ルールに従う（${BASE_HIGH_LABEL[store.rule(sec ? sec.ruleId : null).baseHighMode] || '5年高値'}）</option>
            ${Object.entries(BASE_HIGH_LABEL).map(([v, lbl]) => `<option value="${v}" ${sec && sec.baseHighMode === v ? 'selected' : ''}>${lbl}</option>`).join('')}
          </select></div>
        <div class="field"><label>手動の基準高値（基準高値=手動指定の時のみ）</label>
          <input name="baseHighManual" type="number" step="any" value="${sec && sec.baseHighManual != null ? sec.baseHighManual : ''}" placeholder="原通貨" ${sec && sec.baseHighMode === 'manual' ? '' : 'disabled'}></div>
      </div>
      <div class="row">
        <div class="field"><label>買増固定値（次回購入をこの価格に固定・任意）</label>
          <input name="fixedBuyPrice" type="number" step="any" value="${sec && sec.fixedBuyPrice != null ? sec.fixedBuyPrice : ''}" placeholder="原通貨。入力するとルール計算より優先"></div>
        <div class="field"><label>詳細種別（貼付出力用）</label>
          <select name="detailType">
            <option value="" ${!sec || !sec.detailType ? 'selected' : ''}>自動判定（${sec ? esc(autoDetailType(sec)) : '個別株'}）</option>
            ${['個別株', 'ETF'].map(t => `<option ${sec && sec.detailType === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select></div>
      </div>

      <fieldset class="form-group"><legend>表示の手動上書き（任意・自動取得では上書きされません）</legend>
        <div class="field"><label>銘柄名（上書き）</label>
          <input name="nameOverride" value="${sec && sec.nameOverride ? esc(sec.nameOverride) : ''}" placeholder="${sec ? esc((store.data.meta[priceKey(sec)] || {}).name || sec.ticker) : '空欄で自動取得名を使用'}"></div>
        <div class="row">
          <div class="field"><label>セクター（上書き）</label>
            <input name="sectorOverride" value="${sec && sec.sectorOverride ? esc(sec.sectorOverride) : ''}" placeholder="${sec ? esc((store.data.meta[priceKey(sec)] || {}).sector || '空欄で自動取得') : '空欄で自動取得'}"></div>
          <div class="field"><label>業種（上書き）</label>
            <input name="industryOverride" value="${sec && sec.industryOverride ? esc(sec.industryOverride) : ''}" placeholder="${sec ? esc((store.data.meta[priceKey(sec)] || {}).industry || '空欄で自動取得') : '空欄で自動取得'}"></div>
        </div>
        <p class="muted" style="margin:6px 0 0">空欄にすると自動取得値に戻ります。</p>
      </fieldset>

      <fieldset class="form-group"><legend>銘柄情報（自動取得）</legend>
        <div id="auto-info" class="auto-info">${autoInfoPanelHtml(m, sec ? sec.ticker : '')}</div>
        <button type="button" class="btn btn-sm" style="margin-top:8px" onclick="refetchInfo()">今すぐ取得</button>
        <p class="muted" style="margin:8px 0 0">銘柄名・セクター・業種・時価総額・PER・配当はティッカーをキーに自動取得（マスタ管理）。価格更新時にも定期取得され、手入力はしません。</p>
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
          <div class="field"><label>1回の購入額 (${ccy})</label>
            <input name="buyAmount" type="number" step="any" value="${buyAmtVal}" placeholder="カテゴリから自動／手入力で上書き"></div>
          <div class="field"><label>購入回数</label>
            <input name="buyCount" type="number" step="1" min="0" value="${buyCntVal}" placeholder="任意"></div>
        </div>
        <p class="muted" style="margin:-4px 0 12px">カテゴリを選ぶと購入額を転記します（${m === 'US' ? '米株は÷100ドル' : '円'}）。実際の購入額が異なる場合は手入力で上書きしてください。</p>
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

      ${id ? '' : `
      <fieldset class="form-group"><legend>初期保有（任意・後から「保有」で編集可）</legend>
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
        <button type="button" class="btn" onclick="openAmountHistory(${id})">適用金額履歴</button>` : ''}
        <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>`);
  document.getElementById('sec-form').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const market = f.market.value;
    const numOrNull = (v) => v === '' || v == null ? null : parseFloat(v);
    const intOrNull = (v) => v === '' || v == null ? null : parseInt(v, 10);
    // 銘柄名・セクター・業種・時価総額・PER・EPS・配当はマスタ（meta）で自動管理。レコードには持たせない
    const patch = {
      market, ticker: f.ticker.value.trim(),
      category: f.category.value || null, ruleId: parseInt(f.ruleId.value, 10),
      enabled: f.enabled.value === '1', watch: f.watch.value === '1',
      currency: market === 'US' ? 'USD' : 'JPY',
      assetClass: market === 'FUND' ? 'fund' : 'stock',
      prevBuyPrice: numOrNull(f.prevBuyPrice.value),
      prevBuyDate: (f.prevBuyDate && f.prevBuyDate.value) || null, // 前回購入日（手動・高値更新判定の比較用。取引履歴があればそちら優先）
      fixedBuyPrice: numOrNull(f.fixedBuyPrice.value),
      baseHighMode: f.baseHighMode.value || null,
      baseHighManual: f.baseHighMode.value === 'manual' ? numOrNull(f.baseHighManual.value) : null,
      detailType: (f.detailType && f.detailType.value) || null, // 詳細種別マスタ（空=自動判定）

      buyAmount: numOrNull(f.buyAmount.value), buyCount: intOrNull(f.buyCount.value),
      overallGrade: f.overallGrade.value || null, rating: f.rating.value || null, buyGrade: f.buyGrade.value || null,
      starValuation: intOrNull(f.starValuation.value), starStrength: intOrNull(f.starStrength.value), starRisk: intOrNull(f.starRisk.value),
      priority: intOrNull(f.priority.value), analysisDate: f.analysisDate.value || null,
      analysisNote: f.analysisNote.value.trim() || null,
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
      if (patch.prevBuyPrice != null || patch.baseHighManual != null) patch.manualUpdatedAt = store._now();
      target = store.addSecurity({ ...patch });
      const qty = parseFloat(f.initQty.value), cost = parseFloat(f.initCost.value);
      if (!isNaN(qty) && qty !== 0) store.setHolding(target.id, f.broker.value, f.accountType.value, qty, isNaN(cost) ? 0 : cost);
    }
    closeModal(); render();
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
  const sectorInd = [meta.sector, meta.industry].filter(Boolean).join(' / ');
  return r('銘柄名', esc(meta.name || '—'))
    + r('セクター / 業種', sectorInd ? esc(sectorInd) : '—')
    + r('時価総額', meta.marketCap != null ? Number(meta.marketCap).toLocaleString('ja-JP') + ' 百万' : '—')
    + r('PER', meta.per != null ? num(meta.per) : '—')
    + r('配当/株', meta.dividend != null ? money(meta.dividend, ccy) : '—');
}

// ティッカーをキーに /api/info から銘柄情報を取得し、マスタ(meta)に保存。パネルを更新（フォームには手入力させない）
async function autoFetchInfo(tickerEl) {
  const f = tickerEl.form;
  const ticker = tickerEl.value.trim();
  if (!ticker) return;
  const status = document.getElementById('info-status');
  const panel = document.getElementById('auto-info');
  const market = f.market.value;
  const symbol = (market === 'JP' || market === 'FUND') ? `${ticker}.T` : ticker;
  const key = `${market}:${ticker}`;
  if (status) { status.textContent = '取得中…'; status.style.color = 'var(--muted)'; }
  try {
    const res = await fetch(`/api/info?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    store.setMeta(key, clean(d)); // マスタへ保存（null/空は上書きしない）
    if (panel) panel.innerHTML = autoInfoPanelHtml(market, ticker);
    if (status) { status.textContent = d.name ? '✓ 取得済み' : '✓ 取得（一部のみ）'; status.style.color = 'var(--green)'; }
  } catch (e) {
    if (status) { status.textContent = '取得失敗（再試行可）'; status.style.color = 'var(--muted)'; }
  }
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
  const rowsHtml = hs.map(h => `
    <tr data-hid="${h.id}">
      <td class="l">${esc(h.broker)}</td><td class="l">${esc(h.accountType)}</td>
      <td><input type="number" step="any" class="h-qty" value="${h.quantity}"></td>
      <td><input type="number" step="any" class="h-cost" value="${h.avgCost}"></td>
      ${us ? `<td><input type="number" step="any" class="h-acq" value="${h.acqJpy ?? ''}" placeholder="取得円"></td>` : ''}
      <td class="l"><button type="button" class="btn btn-sm btn-danger" onclick="removeHolding(${h.id},${secId})">削除</button></td>
    </tr>`).join('');

  showModal(`保有を直接編集 — ${esc(sec.name || sec.ticker)}`, `
    <form id="holdings-form">
      <p class="muted">取引履歴を介さず、数量・平均取得単価を直接修正できます（単価 ${ccy}）。${us ? '「取得円(円)」は米国株の取得円（転記・取得円列に使用）。空欄＝未設定。' : ''}</p>
      <div class="table-wrap"><table>
        <thead><tr><th class="l">証券会社</th><th class="l">口座</th><th>数量</th><th>平均取得単価(${ccy})</th>${us ? '<th>取得円(円)</th>' : ''}<th></th></tr></thead>
        <tbody id="holdings-rows">${rowsHtml || ''}</tbody>
      </table></div>
      ${hs.length === 0 ? '<div class="empty">保有がありません。下のフォームから追加してください。</div>' : ''}

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
      </fieldset>

      <div class="form-actions">
        ${hs.some(h => h.quantity > 0) ? `<button type="button" class="btn btn-danger" onclick="sellAll(${secId})">全売却（数量を0に）</button>` : ''}
        <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>`);
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
        // 数量・単価を実際に変更した時だけ「手入力」として記録（未変更の再保存では更新しない）
        if (newQty !== h.quantity || newCost !== h.avgCost) {
          h.quantity = newQty; h.avgCost = newCost;
          h.source = 'manual'; h.updatedAt = store._now();
        }
        // 取得円(円)の直接編集（米国株）。空欄なら未設定に戻す
        const acqEl = tr.querySelector('.h-acq');
        if (acqEl) { const v = acqEl.value.trim(); h.acqJpy = v === '' ? undefined : (parseFloat(v) || 0); }
      }
    });
    // 新規追加
    if (f.newQty.value || f.newCost.value) {
      store.setHolding(secId, f.broker.value, f.accountType.value,
        parseFloat(f.newQty.value) || 0, parseFloat(f.newCost.value) || 0);
      if (f.newAcq && f.newAcq.value.trim() !== '') {
        const nh = store.data.holdings.find(x => x.securityId === secId && x.broker === f.broker.value && x.accountType === f.accountType.value);
        if (nh) nh.acqJpy = parseFloat(f.newAcq.value) || 0;
      }
    }
    store.save(); closeModal(); render();
  };
}
function removeHolding(hid, secId) {
  store.removeHolding(hid); openHoldingsForm(secId);
}
function sellAll(secId) {
  if (confirm('この銘柄の全口座の数量を0にします（全売却）。平均取得単価は保持します。よろしいですか？')) {
    store.sellAll(secId); closeModal(); render();
  }
}

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
    : ev.type === 'initial' ? '初回購入' : '買い増し') : '';
  // 高値更新オプションがONなのに高値更新が適用されていない時、その理由を表示（サイレント失敗の可視化）
  let highResetNote = '';
  if (ev && rule && rule.highResetMode && ev.type === 'addon' && ev.baseSource !== '高値更新' && ev.baseSource !== '固定') {
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
  ].join('') : '<div class="muted">判定対象外（無効/価格未取得/投信）</div>');
  // 保有（口座別）
  const hs = store.data.holdings.filter(h => h.securityId === sec.id);
  const holdRows = hs.length ? hs.map(h => `<div class="ai-row"><span class="muted">${esc(h.broker || '—')} / ${esc(h.accountType || '—')}</span><span>${fmtQty(h.quantity, sec.market)} @ ${m(h.avgCost)}</span></div>`).join('') : '<div class="muted">保有なし</div>';
  const holdSummary = th.qty ? kv('合計 / 評価額 / 損益率',
    `${fmtQty(th.qty, sec.market)}　/　${m(calc.valueOrCostNative(sec))}　/　<span class="${cls(calc.pnlPctNative(sec))}">${calc.pnlPctNative(sec) != null ? signed(calc.pnlPctNative(sec)) + '%' : '—'}</span>`) : '';
  // 購入・取引履歴
  const txns = store.data.transactions.filter(t => t.securityId === sec.id).sort((a, b) => (a.tradedAt < b.tradedAt ? 1 : -1));
  const txnRows = txns.length ? txns.map(t => `<div class="ai-row"><span class="muted">${esc(t.tradedAt || '—')}　${t.type === 'buy' ? '買い' : t.type === 'sell' ? '売り' : esc(t.type || '')}${t.broker ? '　' + esc(t.broker) : ''}</span><span>${fmtQty(t.quantity, sec.market)} @ ${m(t.price)}</span></div>`).join('') : '<div class="muted">取引履歴なし</div>';
  // 分析メタ
  const meta = [
    kv('銘柄格付 / 総合 / 買い時', `${esc(sec.rating || '—')} / ${esc(sec.overallGrade || '—')} / ${esc(sec.buyGrade || '—')}`),
    kv('★(ﾊﾞﾘｭ/強/ﾘｽｸ)', [sec.starValuation, sec.starStrength, sec.starRisk].some(x => x != null) ? [sec.starValuation, sec.starStrength, sec.starRisk].map(x => x ?? '—').join('/') : '—'),
    kv('カテゴリ', `${esc(sec.category || '—')}`),
    kv('優先順位 / 評価日', `${sec.priority != null ? sec.priority : '—'} / ${esc(sec.analysisDate || '—')}`),
    sec.analysisNote ? kv('分析メモ', esc(sec.analysisNote)) : '',
  ].join('');
  // ファンダ
  const fund = [
    kv('セクター / 業種', `${esc(calc.field(sec, 'sector') || '—')} / ${esc(calc.field(sec, 'industry') || '—')}`),
    kv('PER / EPS', `${calc.per(sec) != null ? num(calc.per(sec)) : '—'} / ${calc.field(sec, 'eps') != null ? m(calc.field(sec, 'eps')) : '—'}`),
    kv('配当/株 / 利回り', `${calc.field(sec, 'dividend') != null ? m(calc.field(sec, 'dividend')) : '—'} / ${calc.divYield(sec) != null ? calc.divYield(sec).toFixed(2) + '%' : '—'}`),
    kv('時価総額 / 5年高値 / 52週高値', `${calc.marketCap(sec) != null ? fmtTurnover(calc.marketCap(sec) * 1e6, sec.market) : '—'} / ${m(calc.high5y(sec))} / ${m(calc.high52w(sec))}`),
    kv('売買代金（現在値×当日出来高）', `${calc.turnover(sec) != null ? fmtTurnover(calc.turnover(sec), sec.market) : '—'}`),
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
  const gradeTag = g => g ? `<span class="grade grade-${esc(String(g).toLowerCase())}">${esc(g)}</span>` : '<span class="muted">—</span>';
  const starsFmt = n => n == null ? '<span class="muted">—</span>' : `<span style="color:var(--brass);letter-spacing:1px">${'★'.repeat(n)}<span style="color:var(--border-strong)">${'☆'.repeat(Math.max(0, 5 - n))}</span></span>`;
  const subHtml = `<span class="tag ${sec.market.toLowerCase()}">${MARKET_LABEL[sec.market]}</span><span class="muted" style="font-size:13px">${esc(sec.ticker)}</span>${detailTypeOf(sec) === 'ETF' ? '<span class="tag detail-etf">ETF</span>' : ''}${gradeTag(sec.rating)}${sec.watch ? '<span class="tag watch">注意</span>' : ''}`;
  // 評価（格付＝銘柄格付のみ。総合/買い時は出さない）＋☆＋分析メモ
  const evalBox = [
    kv('銘柄格付', gradeTag(sec.rating)),
    sec.starValuation != null ? kv('バリュエーション', starsFmt(sec.starValuation)) : '',
    sec.starStrength != null ? kv('事業の強さ', starsFmt(sec.starStrength)) : '',
    sec.starRisk != null ? kv('リスク', starsFmt(sec.starRisk)) : '',
    sec.analysisNote ? kv('分析メモ' + (sec.analysisDate ? `（${esc(sec.analysisDate)}）` : ''), esc(sec.analysisNote)) : '',
  ].join('');
  const metaBox = [
    kv('カテゴリ', `${esc(sec.category || '—')}`),
    kv('優先順位 / 評価日', `${sec.priority != null ? sec.priority : '—'} / ${esc(sec.analysisDate || '—')}`),
  ].join('');
  const sectionBox = (title, inner) => `<fieldset class="form-group"><legend>${title}</legend><div class="auto-info">${inner}</div></fieldset>`;

  showDrawer(`${calc.displayName(sec)}`, `
    ${held ? `<div style="display:flex;gap:24px;align-items:flex-end;flex-wrap:wrap;margin-bottom:2px">
      <div><div class="muted" style="font-size:12px">評価額（円換算）</div><div class="num" style="font-family:var(--serif);font-size:28px;font-weight:600;line-height:1.15">${yen(valJpy)}</div></div>
      <div style="padding-bottom:3px"><div class="muted" style="font-size:12px">評価損益</div><div class="num ${cls(pnlJpyV)}" style="font-size:17px;font-weight:700;white-space:nowrap">${yen(pnlJpyV)}${pnlPctN != null ? ` <span style="font-size:13px">（${signed(pnlPctN)}%）</span>` : ''}</div></div>
    </div>` : `<div class="notice" style="margin-top:0">この銘柄は現在保有していません（ウォッチ対象）。</div>`}

    <div class="kv" style="grid-template-columns:1fr 1fr 1fr">
      <div class="cell"><div class="k">現在値</div><div class="v">${m(price)}</div></div>
      <div class="cell"><div class="k">前日比</div><div class="v ${cls(dayPct)}">${dayPct != null ? signed(dayPct) + '%' : '—'}</div></div>
      <div class="cell"><div class="k">5年高値 / 52週高値</div><div class="v">${m(calc.high5y(sec))} / ${m(calc.high52w(sec))}</div></div>
      <div class="cell"><div class="k">平均取得単価</div><div class="v">${held ? m(th.avgCost) : '—'}</div></div>
      <div class="cell"><div class="k">保有数量</div><div class="v">${qtyDisp}</div></div>
      <div class="cell"><div class="k">取得原価（円）</div><div class="v">${held ? yen(costJpyV) : '—'}</div></div>
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
    ${sectionBox('判定', judge)}
    ${sectionBox('保有', holdRows + (holdSummary || ''))}
    ${sectionBox('購入・取引履歴', txnRows)}
    ${sectionBox('分析メタ', metaBox)}`, `
    <button type="button" class="btn btn-brass" style="flex:1" onclick="closeDrawer();openTxnForm(${sec.id})">${svgIcon('trade', '')} 取引を記録</button>
    <button type="button" class="btn" onclick="closeDrawer();openSecurityForm(${sec.id})">${svgIcon('edit', '')} 編集</button>`, subHtml);
  _detailChartCtx = { sec, ev, price, lb };
  loadDetailChart(sec, ev, price, lb, detailChartRange);
}
// 詳細チャートをクリックで拡大表示（画面いっぱいの専用オーバーレイ。viewBoxで自動スケール）
function enlargeDetailChart() {
  const el = document.getElementById('detail-chart'); if (!el) return;
  const svg = el.querySelector('svg'); if (!svg) return; // 読み込み中・取得失敗時は無視
  let ov = document.getElementById('chart-zoom-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'chart-zoom-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,24,40,.55);z-index:300;display:flex;align-items:center;justify-content:center;padding:24px;cursor:zoom-out';
    ov.onclick = () => ov.remove();
    document.body.appendChild(ov);
  }
  // SVG を width:100% にして大きな器いっぱいに拡大（viewBox 760x300 がスケール）
  ov.innerHTML = `<div style="background:var(--panel);border-radius:14px;padding:20px;width:min(1400px,94vw);box-shadow:var(--shadow-lg);cursor:default" onclick="event.stopPropagation()">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><strong style="font-size:15px">価格チャート</strong><button class="x-btn" onclick="document.getElementById('chart-zoom-overlay').remove()">&times;</button></div>
      <div style="width:100%">${el.innerHTML.replace('width="100%"', 'width="100%" style="height:auto;max-height:74vh"')}</div>
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
  // 1年は日足、3年/5年は週足
  const interval = range === '1y' ? '1d' : '1wk';
  try {
    const res = await fetch(`/api/history?symbol=${encodeURIComponent(yahooSymbol(sec))}&range=${encodeURIComponent(range)}&interval=${interval}`);
    const d = await res.json();
    if (d.error || !d.points || !d.points.length) { el.textContent = '価格履歴を取得できませんでした（ローカルは wrangler 起動時のみ取得可）。'; return; }
    const overlays = [];
    if (ev && ev.trigger != null) overlays.push({ y: ev.trigger, color: 'var(--red)', label: '次回購入' });
    if (price != null) overlays.push({ y: price, color: 'var(--green)', label: '現在値' });
    if (lb && lb.price != null) overlays.push({ y: lb.price, color: 'var(--amber)', label: '前回購入' });
    el.classList.remove('muted');
    el.innerHTML = detailSvgChart(d.points, overlays);
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
function detailSvgChart(points, overlays) {
  const W = 760, H = 300, pad = { l: 56, r: 86, t: 14, b: 26 };
  const ys = points.map(p => p[1]); const xs = points.map(p => p[0]);
  let dmin = Math.min(...ys), dmax = Math.max(...ys);
  overlays.forEach(o => { if (o.y != null) { dmin = Math.min(dmin, o.y); dmax = Math.max(dmax, o.y); } });
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
  // overlays（右ラベル）
  const ov = overlays.filter(o => o.y != null).map(o => { const y = py(o.y).toFixed(1); return `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="${o.color}" stroke-width="1" stroke-dasharray="4 3"/><text x="${W - pad.r + 4}" y="${(+y + 3).toFixed(1)}" fill="${o.color}" font-size="10">${esc(o.label)} ${num(o.y)}</text>`; }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;background:var(--panel);border:1px solid var(--border);border-radius:8px">
    ${grid}${xlab}<path d="${dpath}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>${ov}${hl}
  </svg>`;
}

function openTxnForm(secId, presetType) {
  const sec = store.data.securities.find(s => s.id === secId);
  const ccy = MARKET_CCY[sec.market];
  showModal(`取引を記録 — ${esc(sec.name || sec.ticker)}`, `
    <form id="txn-form">
      <div class="row">
        <div class="field"><label>種別</label>
          <select name="type"><option value="buy" ${presetType !== 'sell' ? 'selected' : ''}>買い</option><option value="sell" ${presetType === 'sell' ? 'selected' : ''}>売り</option></select></div>
        <div class="field"><label>日付</label><input name="tradedAt" type="date" value="${today()}"></div>
      </div>
      <div class="row">
        <div class="field"><label>約定単価 (${ccy})</label><input name="price" type="number" step="any" required></div>
        <div class="field"><label>数量（端株可）</label><input name="quantity" type="number" step="any" required></div>
      </div>
      <div class="row">
        <div class="field"><label>証券会社</label><select name="broker">${BROKERS.map(b => `<option>${b}</option>`).join('')}</select></div>
        <div class="field"><label>口座種別</label><select name="accountType">${ACCOUNTS.map(a => `<option>${a}</option>`).join('')}</select></div>
      </div>
      ${sec.market === 'US' ? `
      <div class="row">
        <div class="field"><label>受渡金額(円)（手数料・税込／取得円用・任意）</label>
          <input name="settleJpy" type="number" step="any" placeholder="取引報告書の国内受渡金額"></div>
      </div>
      <p class="muted">受渡金額(円)を入れると「取得円」に反映（買い=加算・売り=減算）。取得円エクスポート用で、買い増し判定には未使用。</p>` : ''}
      <p class="muted">買い=数量加算＆平均取得単価を更新 / 売り=数量のみ減算（単価は不変）</p>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
        <button type="submit" class="btn btn-primary">記録</button>
      </div>
    </form>`);
  document.getElementById('txn-form').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const settleJpy = f.settleJpy ? parseFloat(f.settleJpy.value) : NaN;
    store.addTransaction({
      securityId: secId, type: f.type.value,
      price: parseFloat(f.price.value), quantity: parseFloat(f.quantity.value),
      broker: f.broker.value, accountType: f.accountType.value, tradedAt: f.tradedAt.value,
      ...(isNaN(settleJpy) ? {} : { settleJpy }),
    });
    closeModal(); render();
  };
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
      high5y: f.high5y.value ? parseFloat(f.high5y.value) : (p.high5y ?? null),
      high52w: p.high52w ?? null, fetchedAt: new Date().toISOString(),
    };
    store.save(); closeModal(); render();
  };
}

// カテゴリ: 追加 or 編集（全項目）
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
      <p class="muted">日本株の金額を入力すると、米国株は ÷100 を初期値として自動入力します（必要なら上書き可）。</p>
      <div class="form-actions">
        ${c ? `<button type="button" class="btn btn-danger" onclick="deleteCategory('${esc(c.category)}')">削除</button>` : ''}
        <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
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
    };
    if (c) store.updateCategory(category, patch);
    else store.addCategory(patch);
    closeModal(); render();
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
    store.removeCategory(name); closeModal(); render();
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
        <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
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
    closeModal(); render();
  };
}
function deleteRule(id) {
  const r = store.data.rules.find(x => x.id === id);
  if (confirm(`ルール「${r.name}」を削除します。割当済みの銘柄は既定ルールに戻ります。よろしいですか？`)) {
    store.removeRule(id); closeModal(); render();
  }
}
function setDefaultRule(id) { store.setDefaultRule(id); render(); }

// ---------- 一括取込（Excel/CSV 貼り付け） ----------
function openPasteImport(kind) {
  const isAnalysis = kind === 'analysis';
  const title = isAnalysis ? '銘柄分析結果を取込' : '保有株を取込';
  const sample = isAnalysis
    ? '評価日 / 銘柄名 / 総合評価 / 銘柄格付 / 買い時評価 / 推奨投資額 / カテゴリ / バリュエーション / 独自の強み / リスク / 備考 / 評価時点_購入優先順位'
    : 'ティッカー / 証券会社 / 口座種別 / 取得単価 / 数量 / 取得価額';
  showModal(title, `
    <form id="import-form">
      <p class="muted">Excelの該当シートを<strong>ヘッダ行ごと</strong>選択してコピーし、下に貼り付けてください（タブ/カンマ区切り対応）。</p>
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
    const body = rows.slice(1, 11).map(r => {
      const tk = (r[tIdx] || '').trim(); const ok = validTicker(tk, market);
      const others = r.filter((_, j) => j !== tIdx).slice(0, 4).join(' / ');
      return `<tr><td class="l">${ok ? '<span class="pos">✓</span>' : '<span class="neg" title="形式NG（取込まれません）">⚠</span>'}</td><td class="l">${esc(tk)}</td><td class="l muted">${esc(others)}</td></tr>`;
    }).join('');
    preview.innerHTML = `<div style="margin:4px 0">取込予定 ${rows.length - 1}件${bad ? ` ／ <span class="neg">形式NG ${bad}件（取込まれません）</span>` : ''}（先頭${Math.min(10, rows.length - 1)}行プレビュー）</div>
      <div class="table-wrap" style="max-height:220px"><table><thead><tr><th class="l">形式</th><th class="l">コード</th><th class="l">他の列</th></tr></thead><tbody>${body}</tbody></table></div>`;
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

function parsePasted(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
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
    ['overallGrade', 'rating', 'buyGrade', 'category'].forEach(fld => { if (r[fld]) aPairs.push({ field: fld, raw: r[fld] }); });
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
    // 分析日が既存より古ければ取り込まない（最新の分析を保持）。同一取込内の重複も最新日が勝つ
    const incDate = normDate(rec.analysisDate);
    if (!isNew && sec.analysisDate && incDate && incDate < sec.analysisDate) { stale++; continue; }
    if (isNew) created++; else updated++;
    const nf = (v) => (v && v.trim()) ? parseFloat(v) : null;
    const sf = (v, fb) => (v && v.trim()) || fb || null;
    // 分析の「判断」項目はレコードへ
    const patch = {
      overallGrade: cg(rec, 'overallGrade', sec.overallGrade),
      rating: cg(rec, 'rating', sec.rating),
      buyGrade: cg(rec, 'buyGrade', sec.buyGrade),
      starValuation: parseStars(rec.starValuation) ?? sec.starValuation ?? null,
      starStrength: parseStars(rec.starStrength) ?? sec.starStrength ?? null,
      starRisk: parseStars(rec.starRisk) ?? sec.starRisk ?? null,
      analysisNote: sf(rec.analysisNote, sec.analysisNote),
      analysisDate: normDate(rec.analysisDate) || sec.analysisDate || null,
      category: cg(rec, 'category', sec.category), // シートの「カテゴリ」列→割り当てカテゴリ（取込値があれば更新・変換マスタ適用）
      recoAmount: rec.recoAmount ? parseFloat(rec.recoAmount) : (sec.recoAmount ?? null),
    };
    if (rec.priority) { const p = parseInt(rec.priority, 10); if (!isNaN(p)) patch.priority = p; }
    // セクター/業種/時価総額/PER/EPS/配当はマスタ(meta)へ（自動取得項目と同じ置き場所）
    const metaPatch = clean({
      sector: sf(rec.sector), industry: sf(rec.industry),
      marketCap: nf(rec.marketCap), per: nf(rec.per), eps: nf(rec.eps), dividend: nf(rec.dividend),
    });
    if (Object.keys(metaPatch).length) store.setMeta(priceKey(sec), metaPatch);
    // 買い増し予定額・推奨購入額はカテゴリ別金額マスタから算出するため、推奨投資額(recoAmount)からの自動設定は行わない
    // （旧実装は米株を recoAmount÷100 して 0.6 等の誤値を生んでいた。SEC: 金額はマスタ基準に統一）
    store.updateSecurity(sec.id, patch);
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
  'ルール': 'ruleName', '買い増しルール': 'ruleName', 'カテゴリ': 'category', '詳細種別': 'detailType',
  '1回購入額': 'buyAmount', '買い増し予定額': 'buyAmount', '購入回数': 'buyCount', '判定対象': 'enabled', 'ウォッチ': 'watch',
};
const GENERIC_HEADER = ['ティッカー', '市場', '証券会社', '口座', '数量', '取得単価', '前回購入価格', '前回購入日', '基準高値モード', '手動基準高値', '買増固定値', 'ルール', 'カテゴリ', '1回購入額', '購入回数', '判定対象', 'ウォッチ', '詳細種別'];
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
    if ('baseHighMode' in rec) sec.baseHighMode = normBaseHighMode(rec.baseHighMode);
    if ('baseHighManual' in rec) sec.baseHighManual = numClean(rec.baseHighManual);
    if ('ruleName' in rec) sec.ruleName = rec.ruleName || '';
    if ('category' in rec) sec.category = rec.category || null;
    if ('buyAmount' in rec) sec.buyAmount = numClean(rec.buyAmount);
    if ('buyCount' in rec) { const n = parseInt(rec.buyCount, 10); sec.buyCount = isNaN(n) ? null : n; }
    if ('enabled' in rec) sec.enabled = /有効|^1$|true|yes/i.test(rec.enabled);
    if ('watch' in rec) sec.watch = /注意|^1$|true|yes/i.test(rec.watch);
    if (Object.keys(sec).length) row._sec = sec;
    if (qty == null && !row._sec) continue; // 数量も属性も無い行はスキップ
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
        <input type="file" name="file" accept=".csv,text/csv" onchange="onImportFile(this)"></div>
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

  // replace: スコープ内の既存保有を削除
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
      store.updateSecurity(sec.id, p);
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
  const fundItems = parseFundRows(_importText);
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
        if (it.evalJpy != null) store.data.prices['FUND:' + existing.ticker] = { price: it.evalJpy / q, prevClose: null, updatedAt: store._now() };
        fundCount++;
      } else {
        (pending[key] = pending[key] || { name: it.name, items: [] }).items.push({ broker: scope.broker, account: it.account || '特定', qty: it.qty, acqJpy: it.acqJpy, evalJpy: it.evalJpy });
        pendingTotal++;
      }
    }
  }
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
  reportImport(touched, `取込完了: 更新 ${updated} / 新規 ${created}${fundCount ? ` / 投信 ${fundCount}件` : ''}${pendingTotal ? ` / 新規投信 ${Object.keys(pending).length}件はコード入力待ち` : ''}${removed ? ` / 洗い替え削除 ${removed}` : ''}${badFmt ? ` / 形式NG ${badFmt}件は取込まず` : ''}${skipped ? ` / スキップ ${skipped}` : ''}`);
  // 新規投信は「コード入力→登録」モーダルを出す（自動採番で銘柄マスタに載せない）
  if (Object.keys(pending).length) { _pendingFundReg = pending; setTimeout(openNewFundCodeModal, 450); }
}
// 新規投信のコード入力モーダル。協会コードを入れて登録（空欄なら内部コードFND）
let _pendingFundReg = null;
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
      if (it.evalJpy != null) store.data.prices['FUND:' + sec.ticker] = { price: it.evalJpy / q, prevClose: null, updatedAt: store._now() };
    }
    n++;
  }
  _pendingFundReg = null;
  store.save(); closeModal(); render();
  toast(`新規投信 ${n} 件を登録しました`, 4000);
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
function exportGeneric() {
  const lines = [GENERIC_HEADER.join(',')];
  for (const s of store.data.securities) {
    const ruleName = (store.rule(s.ruleId) || {}).name || '';
    const base = [s.ticker, s.market, '', '', '', '',
      s.prevBuyPrice ?? '', s.prevBuyDate || '', s.baseHighMode || '', s.baseHighManual ?? '', s.fixedBuyPrice ?? '', ruleName, s.category || '',
      s.buyAmount ?? '', s.buyCount ?? '', s.enabled === false ? '無効' : '有効', s.watch ? '注意' : '通常', detailTypeOf(s)];
    const hs = store.data.holdings.filter(h => h.securityId === s.id);
    if (hs.length) {
      for (const h of hs) { const r = base.slice(); r[2] = h.broker; r[3] = h.accountType; r[4] = h.quantity; r[5] = h.avgCost; lines.push(r.map(csvCell).join(',')); }
    } else {
      lines.push(base.map(csvCell).join(','));
    }
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `securities-generic-${today()}.csv`;
  a.click();
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
  { key: 'baseHighMode',  label: '基準高値モード' },
  { key: 'baseHighManual', label: '手動基準高値' },
  { key: 'ruleName',      label: '買い増しルール' },
  { key: 'category',      label: 'カテゴリ' },
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
];
const GI_SEC_FIELDS = new Set(['prevBuyPrice', 'prevBuyDate', 'fixedBuyPrice', 'baseHighMode', 'baseHighManual', 'category', 'detailType', 'buyAmount', 'buyCount', 'enabled', 'watch', 'nameOverride', 'sectorOverride', 'industryOverride', 'overallGrade', 'rating', 'buyGrade', 'priority', 'analysisDate', 'analysisNote', 'starValuation', 'starStrength', 'starRisk']);
// 選択肢のグループ分け（必須/保有/属性/上書き/分析）。自動取得・派生（評価額/損益/価格/PER等）は候補に出さない。
const GI_GROUPS = [
  { g: '★必須', keys: ['ticker', 'market'] },
  { g: '保有・金額', keys: ['broker', 'account', 'quantity', 'avgCost', 'acqValue', 'acqJpy'] },
  { g: '判定・属性', keys: ['category', 'ruleName', 'detailType', 'prevBuyPrice', 'prevBuyDate', 'fixedBuyPrice', 'baseHighMode', 'baseHighManual', 'buyAmount', 'buyCount', 'enabled', 'watch'] },
  { g: '表示の上書き', keys: ['nameOverride', 'sectorOverride', 'industryOverride'] },
  { g: '分析', keys: ['overallGrade', 'rating', 'buyGrade', 'priority', 'analysisDate', 'analysisNote', 'starValuation', 'starStrength', 'starRisk'] },
];
const GI_FIXED_KEYS = ['market', 'broker', 'account', 'detailType', 'category', 'ruleName'];
// ヘッダ名→フィールドの自動対応（汎用出力の列もそのまま読める）
const GI_AUTOMAP = { ...GENERIC_MAP,
  '取得円': 'acqJpy', '取得額(円)': 'acqJpy', '取得額（円）': 'acqJpy', '受渡金額(円)': 'acqJpy',
  '約定価額': 'acqValue', '取得価額': 'acqValue', '約定代金': 'acqValue',
  '前回購入日': 'prevBuyDate',
  '詳細種別': 'detailType', '総合評価': 'overallGrade', '銘柄格付': 'rating', '格付': 'rating', '買い時評価': 'buyGrade',
  '推奨カテゴリ': 'category', 'カテゴリ': 'category', '購入優先順位': 'priority', '優先順位': 'priority',
  '評価日': 'analysisDate', '備考': 'analysisNote', '分析メモ': 'analysisNote',
  'バリュエーション': 'starValuation', '独自の強み': 'starStrength', 'リスク': 'starRisk',
  'セクター': 'sectorOverride', '業種': 'industryOverride', '銘柄名': 'nameOverride',
};
let _giHeaders = [], _giRows = [], _giMapping = []; // _giMapping[colIdx] = fieldKey | ''

function openGenericImport() {
  showModal('汎用取込（列を選んで取込）', `
    <p class="muted" style="margin:0 0 8px">Excel等をヘッダ行ごと貼り付け→列ごとに取込先を選択。<strong>コード・市場は必須</strong>。選んだ列だけ既存銘柄に上書き（ticker×market、未登録は新規作成可）。</p>
    <div class="btn-row" style="align-items:center">
      <label class="check" style="margin:0"><input type="checkbox" id="gi-create" checked> 未登録は新規作成</label>
      <label style="margin:0;font-size:12px">取込モード
        <select id="gi-mode">
          <option value="upsert">上書き（一致を更新・無ければ追加）</option>
          <option value="append">追加（既存はそのまま）</option>
          <option value="replace">洗い替え（固定の証券会社×市場を入替）</option>
        </select></label>
      <span style="flex:1"></span>
      <select id="gi-format"></select>
      <button class="btn btn-sm" onclick="giLoadFormat()">読込</button>
      <button class="btn btn-sm btn-danger" onclick="giDeleteFormat()">削除</button>
    </div>
    <textarea id="gi-text" rows="6" style="width:100%;font-family:monospace;font-size:12px" placeholder="ヘッダ行を含めて貼り付け（タブ/カンマ区切り）" oninput="giParse(this.value)"></textarea>
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
      <div class="field" style="width:auto"><label style="font-size:11px">買い増しルール</label>
        <select id="gi-fix-ruleName" onchange="giRenderPreview()"><option value="">―</option>${store.data.rules.map(r => `<option>${esc(r.name)}</option>`).join('')}</select></div>
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
  const raw = text.includes('\t') ? text.split(/\r?\n/).map(l => l.split('\t')) : parseCsvText(text);
  const rows = raw.filter(r => r.some(c => String(c).trim() !== ''));
  const mapDiv = document.getElementById('gi-map'), pvDiv = document.getElementById('gi-preview');
  if (!rows.length) { _giHeaders = []; _giRows = []; _giMapping = []; if (mapDiv) mapDiv.innerHTML = ''; if (pvDiv) pvDiv.innerHTML = ''; return; }
  _giHeaders = rows[0].map(h => String(h).trim());
  _giRows = rows.slice(1);
  _giMapping = _giHeaders.map(h => GI_AUTOMAP[h] || '');
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
    case 'quantity': case 'avgCost': case 'acqValue': case 'acqJpy': case 'prevBuyPrice': case 'fixedBuyPrice': case 'baseHighManual': case 'buyAmount':
      return numClean(v);
    case 'buyCount': case 'priority': case 'starValuation': case 'starStrength': case 'starRisk': { const n = parseInt(v, 10); return isNaN(n) ? null : n; }
    case 'enabled': return /有効|^1$|true|yes|○|有/i.test(v);
    case 'watch': return /注意|^1$|true|yes|○/i.test(v);
    case 'baseHighMode': return normBaseHighMode(v);
    case 'account': return normAccount(v);
    case 'market': { const u = v.toUpperCase(); return (u === 'US' || u === 'JP') ? u : (/米/.test(v) ? 'US' : /日|国内/.test(v) ? 'JP' : /^\d/.test(v) ? 'JP' : 'US'); }
    case 'detailType': return /ETF|ＥＴＦ/i.test(v) ? 'ETF' : (v || null);
    default: return v || null;
  }
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
  // 洗い替え: 固定の証券会社×市場が必須。そのスコープの保有を先に削除
  let removed = 0;
  if (mode === 'replace') {
    if (!fixed.broker || !fixed.market) { toast('洗い替えは「固定値」で証券会社と市場の指定が必要です'); return; }
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
      if (!create) { skipped++; continue; }
      sec = store.addSecurity({ market, ticker: tk, currency: market === 'US' ? 'USD' : 'JPY', assetClass: 'stock', enabled: true, ruleId: store.defaultRule().id });
      created++;
    } else updated++;
    // 銘柄属性（割り当てた列だけ上書き）。マスタ管理項目は変換マスタで正規化／スキップ
    const patch = {};
    for (const k of Object.keys(rec)) {
      if (k === 'ruleName') { const rn = convMaster('ruleName', rec.ruleName); if (rn === SKIP) continue; const r = store.data.rules.find(x => x.name === rn); if (r) patch.ruleId = r.id; continue; }
      if (GI_SEC_FIELDS.has(k)) { const cv = convMaster(k, rec[k]); if (cv !== SKIP) patch[k] = cv; }
    }
    if (Object.keys(patch).length) store.updateSecurity(sec.id, patch);
    // 保有・取得円
    const hasQty = ('quantity' in rec) && rec.quantity != null;
    const hasAcq = ('acqJpy' in rec) && rec.acqJpy != null;
    if (hasQty || hasAcq) {
      const broker = rec.broker || null, account = rec.account || '特定';
      if (broker) {
        const ex = store.data.holdings.find(x => x.securityId === sec.id && x.broker === broker && x.accountType === account);
        if (mode === 'append' && ex) { /* 追加モード: 既存はそのまま（上書きしない） */ }
        else {
          if (hasQty) {
            const ac = rec.avgCost != null ? rec.avgCost : (ex ? ex.avgCost : 0);
            store.setHolding(sec.id, broker, account, rec.quantity, ac, 'import'); holdingSet++;
          }
          if (hasAcq) { const h = store.data.holdings.find(x => x.securityId === sec.id && x.broker === broker && x.accountType === account); if (h) h.acqJpy = rec.acqJpy; }
        }
      } else if (hasAcq) {
        const hs = store.data.holdings.filter(x => x.securityId === sec.id && x.quantity > 0);
        if (hs.length === 1) { hs[0].acqJpy = rec.acqJpy; holdingSet++; }
      }
    }
    touched.push(sec);
  }
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
  const mapping = {};
  _giHeaders.forEach((h, i) => { if (_giMapping[i]) mapping[h] = _giMapping[i]; });
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
  _giMapping = _giHeaders.map(h => fmt.mapping[h] || '');
  const fx = fmt.fixed || {};
  for (const k of GI_FIXED_KEYS) { const e = document.getElementById('gi-fix-' + k); if (e) e.value = fx[k] || ''; }
  giRenderMap();
  toast(`フォーマット「${fmt.name}」を適用`);
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
    await api.refreshMeta(secs); await api.checkSplits(); render();
  }, '銘柄情報を更新しました').catch(() => {});
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
        ${pending.length ? `<button class="btn btn-primary btn-sm" onclick="openSplitAdjustChecked('sptbl-pending')">選択を調整</button>` : ''}</div>
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
    <p class="muted">行ごとに「種別」を選んで「調整実行」。初期はスキップ（何もしない）です。⚠＝単価/現在値が分割比率を超過＝既調整や異常の可能性。「全部」=保有も調整／「手入力のみ」=前回購入価格等のみ。取込日/手入力日が分割日より<strong>前</strong>（＝未調整の疑い）は<span class="after-split">この色</span>。<br>「推奨」列は当ツールの推奨処理（手入力日が分割前なら未調整とみなす）。チェックして「選択行を→推奨→に一括変更」でまとめて反映できます。</p>
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
}
function importData() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json';
  inp.onchange = () => {
    const file = inp.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try { restoreBundle(JSON.parse(r.result)); render(); toast('インポートしました（列設定も復元）'); }
      catch (_) { toast('JSONの読み込みに失敗しました'); }
    };
    r.readAsText(file);
  };
  inp.click();
}
function resetData() {
  if (confirm('すべてのデータを削除して初期状態に戻します。よろしいですか？\n（誤削除対策として、削除前に現在のデータをJSONで自動ダウンロードします）')) {
    try { exportData(); } catch (_) { /* バックアップ失敗でも削除は続行 */ }
    localStorage.removeItem(STORAGE_KEY); store.data = null; store.load(); render();
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
    const evalJ = p.price != null ? Math.round(p.price * h.quantity) : '';
    const acqJ = Math.round((h.avgCost || 0) * h.quantity);
    fundRows.push([sec.name, '', '投資信託', '投資信託', h.broker || '', h.accountType || '', 'JPY', evalJ, '', acqJ, '', '']);
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
    if (idx.qty == null && /保有数量|保有口数|^数量$|口数/.test(t)) idx.qty = i;          // 口数（投信の数量）
    if (idx.unitCost == null && /取得単価|平均取得(金額|価額)|取得価額/.test(t)) idx.unitCost = i; // 取得金額が無い時 単価×口数/10000 で算出
    if (idx.kind == null && /^種別$/.test(t)) idx.kind = i;                             // SBI明細: 行ごとの種別（投資信託判定）
    if (idx.code == null && /銘柄コード|ティッカー|^コード$/.test(t)) idx.code = i;
    if (idx.account == null && /口座|預り区分|口座区分/.test(t)) idx.account = i;
  });
  // SBI明細形式: 銘柄名の列見出しが無く コード列の次が名称 → name を補完
  if (idx.name == null && idx.kind != null && idx.code != null) idx.name = idx.code + 1;
  return (idx.eval != null && idx.name != null) ? idx : null;
}
function parseFundRows(text) {
  const rows = parseCsvText(text || '');
  let col = null, section = 'fund', acct = null;
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
  const rows = items.map(c => [c.name, '', '投資信託', '投資信託', broker, c.account || defAcct, 'JPY', r1(c.evalJpy), '', r1(c.acqJpy), '', '']);
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
  if (mode === 'replace') {
    store.data.holdings = store.data.holdings.filter(h => { const s = store.data.securities.find(x => x.id === h.securityId); return !(s && s.market === 'FUND' && h.broker === broker); });
  }
  let n = 0;
  for (const it of items) {
    const sec = findOrCreateFund(it.name); if (!sec) continue;
    const q = (it.qty && it.qty > 0) ? it.qty : 1;
    const avgCost = it.acqJpy != null ? it.acqJpy / q : 0;
    store.setHolding(sec.id, broker, it.account || defAcct, q, avgCost, 'import');
    if (it.evalJpy != null) store.data.prices['FUND:' + sec.ticker] = { price: it.evalJpy / q, prevClose: null, updatedAt: store._now() };
    n++;
  }
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
    const evalJ = p.price != null ? Math.round(p.price * h.quantity) : null;
    const acqJ = Math.round((h.avgCost || 0) * h.quantity);
    out.push({ name: s.name, broker: h.broker, account: h.accountType, evalJpy: evalJ, acqJpy: acqJ });
  }
  return out;
}
function fundTransferSavedGenerate() {
  const items = fundSavedRows();
  if (!items.length) { toast('保存済みの投信がありません（「取込」タブの投信取込で取り込んでください）'); return; }
  const r1 = (n) => n == null ? '' : Math.round(n);
  const rows = items.map(c => [c.name, '', '投資信託', '投資信託', c.broker || '', c.account || '', 'JPY', r1(c.evalJpy), '', r1(c.acqJpy), '', '']);
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
    targets[0].acqJpy = amt; applied++;
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
function go(view) {
  currentView = view;
  renderNav();
  render();
}
// 保有銘柄タブ内の US/JP 切替（列設定は市場ごとに保持）
function setHoldingsMarket(m) {
  holdingsMarket = m;
  if (currentView !== 'holdings') currentView = 'holdings';
  renderNav();
  render();
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function num(n) { return n == null ? '—' : Number(n).toLocaleString('ja-JP', { maximumFractionDigits: 2 }); }
function yen(n) { return n == null ? '—' : '¥' + Math.round(n).toLocaleString('ja-JP'); }
function money(n, ccy) { return n == null ? '—' : ccy + Number(n).toLocaleString('ja-JP', { maximumFractionDigits: 2 }); }
// 一覧表示用フォーマッタ（通貨記号なし=SEC-44 / 表示桁=SEC-45）。内部値は変えず表示だけ丸める。
// 株価・金額: 米国株=小数2桁固定 / 日本株=整数。
// 整数表示の金額（買い増し予定額・推奨購入額用。小数不要）
function fmtAmtInt(n) { return n == null ? null : Number(n).toLocaleString('ja-JP', { maximumFractionDigits: 0 }); }
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
function signed(n) { return n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(2); }
function cls(n) { return n == null ? '' : (n > 0 ? 'pos' : (n < 0 ? 'neg' : '')); }
function today() { return new Date().toISOString().slice(0, 10); }
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
function busyDone(msg, state = 'done') {
  const ov = document.getElementById('busy-overlay'); if (!ov || ov.hidden) return;
  ov.classList.remove('done', 'error'); ov.classList.add(state);
  document.getElementById('busy-msg').textContent = msg || (state === 'error' ? '失敗しました' : '完了しました');
  clearTimeout(_busyTimer);
  _busyTimer = setTimeout(() => { ov.hidden = true; ov.classList.remove('done', 'error'); }, state === 'error' ? 3000 : 1100);
}
function busyHide() { const ov = document.getElementById('busy-overlay'); if (!ov) return; ov.hidden = true; ov.classList.remove('done', 'error'); clearTimeout(_busyTimer); }
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
window.clearHoldFilters = clearHoldFilters;
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
window.setFilter = setFilter;
window.busyShow = busyShow;
window.busyDone = busyDone;
window.withBusy = withBusy;
window.toggleInlineEdit = toggleInlineEdit;
window.ieMark = ieMark;
window.ieKey = ieKey;
window.ieSaveAll = ieSaveAll;
window.ieDiscardAll = ieDiscardAll;
window.clearFilter = clearFilter;
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
window.refreshAllMeta = refreshAllMeta;
window.splitHistAll = splitHistAll;
window.openSplitAdjustChecked = openSplitAdjustChecked;
window.openSplitAdjustOne = openSplitAdjustOne;
window.saSelectAll = saSelectAll;
window.saApplyBulk = saApplyBulk;
window.runSplitAdjust = runSplitAdjust;
window.importData = importData;
window.resetData = resetData;
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
window.api = api;
window.render = render;

// ---------- 起動 ----------
renderNav();
document.getElementById('modal-close').onclick = closeModal;
document.getElementById('drawer-close').onclick = closeDrawer;
document.getElementById('drawer-overlay').addEventListener('click', (e) => { if (e.target.id === 'drawer-overlay') closeDrawer(); });
// モーダル外クリックでは閉じない（意図しない消失を防止）。× か各フォームのボタンのみで閉じる
// 「価格更新」: その日まだ高値を取得していなければ高値も取得（LDOS等の古い5年高値を修正）、以降は価格のみで軽量
// マーケットタブ表示中はランキングも更新（保有銘柄と同じ手動更新ルール）
document.getElementById('btn-refresh').onclick = () => withBusy('価格を更新中…', async () => {
  await api.refreshAll({ withHighs: store.data.lastHighsDate !== today() });
  if (currentView === 'market') mktRefresh();
  render();
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
}, true);

store.load();
loadColPrefs();
render();
// 1日1回（起動時）だけ銘柄名・セクター・業種・高値を更新
api.dailyStartup();
