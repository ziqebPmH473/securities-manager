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
const BROKERS = ['SBI', '楽天', 'Webull', 'moomoo', 'SMBC日興'];
const ACCOUNTS = ['特定', 'NISA', '一般'];
// ---------- カラム定義 ----------
// 全カラムのマスタ定義。配列の順＝表示順のベース（ピッカーで個別に並び替え可）
// markets に含む画面でのみ選択可能。'SIGNAL' はサインタブ。
const ALLM = ['US','JP','FUND','SIGNAL'];
const STKM = ['US','JP','SIGNAL'];
const MASTER_COLS = [
  { key: 'ticker',      label: 'コード',           left: true,  markets: ALLM, noSort: false, narrow: true },
  { key: 'name',        label: '銘柄名',           left: true,  markets: ALLM, noSort: false },
  { key: 'market',      label: '市場',             left: true,  markets: ['SIGNAL'], noSort: false },
  { key: 'broker',      label: '証券会社',         left: true,  markets: ALLM, noSort: false },
  { key: 'sigType',     label: '種別',             left: true,  markets: ['SIGNAL'], noSort: false },
  { key: 'price',       label: '現在値',           left: false, markets: ALLM, noSort: false },
  { key: 'day',         label: '前日比',           left: false, markets: ALLM, noSort: true  },
  { key: 'trigger',     label: '次回購入',         left: false, markets: STKM, noSort: true  },
  { key: 'base',        label: '基準値',           left: false, markets: ['SIGNAL'], noSort: true },
  { key: 'drop',        label: '残り下落率',       left: false, markets: STKM, noSort: false },
  { key: 'dropPrev',    label: '残り下落率(前日)', left: false, markets: STKM, noSort: false },
  { key: 'high5y',      label: '5年高値',          left: false, markets: STKM, noSort: false },
  { key: 'high52w',     label: '52週高値',         left: false, markets: STKM, noSort: false },
  { key: 'dropFrom5y',  label: '5年高値からの下落率', left: false, markets: STKM, noSort: false },
  { key: 'dropFrom52w', label: '52週高値からの下落率', left: false, markets: STKM, noSort: false },
  { key: 'prevBuyPrice', label: '前回購入単価',     left: false, markets: STKM, noSort: false },
  { key: 'dropFromPrev', label: '前回からの下落率', left: false, markets: STKM, noSort: false },
  { key: 'sector',      label: 'セクター',         left: true,  markets: STKM, noSort: false },
  { key: 'industry',    label: '業種',             left: true,  markets: STKM, noSort: false },
  { key: 'marketCap',   label: '時価総額(百万)',    left: false, markets: STKM, noSort: false },
  { key: 'value',       label: '評価額',           left: false, markets: ALLM, noSort: false },
  { key: 'cost',        label: '取得価額',         left: false, markets: ALLM, noSort: false },
  { key: 'pnl',         label: '損益率',           left: false, markets: ALLM, noSort: false },
  { key: 'avgCost',     label: '取得単価',         left: false, markets: ALLM, noSort: false },
  { key: 'qty',         label: '数量',             left: false, markets: ALLM, noSort: false },
  { key: 'buyCount',    label: '購入回数',         left: false, markets: ALLM, noSort: false },
  { key: 'buyAmount',   label: '買い増し予定額',    left: false, markets: ALLM, noSort: false },
  { key: 'reco',        label: '推奨購入額',       left: false, markets: ALLM, noSort: false },
  { key: 'category',    label: 'AI判断',           left: true,  markets: ALLM, noSort: false },
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
  { key: 'recoCategory', label: 'AI推奨カテゴリ',  left: true,  markets: STKM, noSort: false },
  { key: 'stars',        label: '★(ﾊﾞﾘｭ/強/ﾘｽｸ)', left: true,  markets: STKM, noSort: true },
  { key: 'analysisDate', label: '評価日',          left: true,  markets: STKM, noSort: false },
  { key: 'analysisNote', label: '分析メモ',        left: true,  markets: STKM, noSort: true },
];
// デフォルト表示列（市場ごと）。表示順は MASTER_COLS の順、ここに含まれるkeyが初期表示
const DEFAULT_VISIBLE = {
  US:   ['ticker','name','price','day','trigger','drop','dropPrev','high5y','high52w','prevBuyPrice','dropFromPrev','dropFrom5y','sector','industry','marketCap','value','cost','pnl','avgCost','qty','buyCount','buyAmount','category','ruleName','fixedBuyPrice','rating'],
  JP:   ['ticker','name','price','day','trigger','drop','dropPrev','high5y','high52w','prevBuyPrice','dropFromPrev','dropFrom5y','sector','industry','marketCap','value','cost','pnl','avgCost','qty','buyCount','buyAmount','category','ruleName','fixedBuyPrice','rating'],
  FUND: ['ticker','name','price','value','cost','pnl','avgCost','qty','buyCount','buyAmount','category'],
  SIGNAL: ['ticker','name','market','broker','sigType','price','day','drop','dropPrev','trigger','base','prevBuyPrice','dropFromPrev','dropFrom5y','buyAmount','reco','ruleName','fixedBuyPrice','rating'],
};
const COL_PREFS_KEY = 'sm_colprefs_v2';

// 分析メタの取込列マッピング（Excel「銘柄分析結果」のヘッダ名 → 内部キー）
const ANALYSIS_COLMAP = {
  '評価日': 'analysisDate', '銘柄名': 'ticker', 'ティッカー': 'ticker',
  '総合評価': 'overallGrade', '銘柄格付': 'rating', '買い時評価': 'buyGrade',
  '推奨投資額': 'recoAmount', '推奨カテゴリ': 'recoCategory',
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
    this.data.lastInfoDate ||= null;  // 銘柄情報の日次更新を実行した日（YYYY-MM-DD）
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
  addSecurity(s) { s.id = this.nextId(); this.data.securities.push(s); this.save(); return s; },
  updateSecurity(id, patch) {
    const s = this.data.securities.find(x => x.id === id);
    if (s) {
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
      // 購入回数を加算
      const sec = this.data.securities.find(s => s.id === t.securityId);
      if (sec) sec.buyCount = (sec.buyCount || 0) + 1;
    } else { // sell: 数量のみ減算（平均取得単価は不変）。ただし数量0なら保有解消につき単価もクリア
      h.quantity = Math.max(0, h.quantity - t.quantity);
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
  async signIn() {
    const cfg = this.cfg();
    if (!cfg.clientId) { toast('クライアントIDを設定してください'); return false; }
    await this.ensureGis();
    const token = await new Promise((res, rej) => {
      const tc = google.accounts.oauth2.initTokenClient({
        client_id: cfg.clientId,
        scope: 'https://www.googleapis.com/auth/spreadsheets openid email',
        callback: (r) => (r && r.access_token) ? res(r.access_token) : rej(new Error('トークン取得失敗')),
        error_callback: (e) => rej(new Error((e && e.type) || 'OAuthエラー')),
      });
      tc.requestAccessToken({ prompt: '' });
    });
    // 許可メール照合
    const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
    const email = ((info && info.email) || '').toLowerCase();
    const allow = (cfg.allowedEmails || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    if (allow.length && !allow.includes(email)) { this._token = null; toast(`許可されていないアカウントです: ${email}`); return false; }
    this._token = token; this._email = email; toast(`ログイン: ${email || 'OK'}`); return true;
  },
  async _call(method, range, body) {
    const cfg = this.cfg();
    if (!cfg.spreadsheetId) { toast('スプレッドシートIDを設定してください'); return null; }
    if (!this._token) { const ok = await this.signIn(); if (!ok) return null; }
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cfg.spreadsheetId)}/values/${encodeURIComponent(range)}`;
    const url = method === 'PUT' ? `${base}?valueInputOption=RAW` : base;
    const res = await fetch(url, { method, headers: { Authorization: 'Bearer ' + this._token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { this._token = null; throw new Error('トークン失効。再ログインしてください'); }
    if (!res.ok) throw new Error('Sheets API ' + res.status + '（_appdata シートの有無も確認）');
    return res.json();
  },
  async save() {
    try { await this._call('PUT', '_appdata!A1', { values: [[JSON.stringify(store.data)]] }); toast('スプレッドシートへ保存しました'); }
    catch (e) { toast('保存失敗: ' + (e.message || e)); }
  },
  async load() {
    if (!confirm('スプレッドシートの内容で現在のデータを上書きします。よろしいですか？')) return;
    try {
      const d = await this._call('GET', '_appdata!A1');
      const cell = d && d.values && d.values[0] && d.values[0][0];
      if (!cell) { toast('スプレッドシートにデータがありません'); return; }
      store.data = JSON.parse(cell); store.save(); store.load(); render(); toast('スプレッドシートから読み込みました');
    } catch (e) { toast('読込失敗: ' + (e.message || e)); }
  },
};
function gsaveSettings(f) {
  store.data.settings = store.data.settings || {};
  store.data.settings.google = { clientId: f.gClientId.value.trim(), allowedEmails: f.gAllowed.value.trim(), spreadsheetId: f.gSheetId.value.trim() };
  store.save(); toast('Google連携設定を保存しました'); renderMaster();
}
function gsyncSignIn() { gsync.signIn(); }
function gsyncSave() { gsync.save(); }
function gsyncLoad() { gsync.load(); }

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

  // 前回購入単価の情報 {price, source}。source: 'txn'(買い取引)|'manual'(登録値)|'みなし'(取得単価)|null
  lastBuyInfo(sec) {
    const buys = store.data.transactions
      .filter(t => t.securityId === sec.id && t.type === 'buy')
      .sort((a, b) => (a.tradedAt < b.tradedAt ? 1 : -1));
    if (buys.length) return { price: buys[0].price, source: 'txn' };
    if (typeof sec.prevBuyPrice === 'number') return { price: sec.prevBuyPrice, source: 'manual' };
    // 未登録なら取得単価を「みなし前回購入単価」として使用
    const th = this.totalHolding(sec.id);
    if (th.qty > 0 && th.avgCost > 0) return { price: th.avgCost, source: 'みなし' };
    return { price: null, source: null };
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
      base = lb.price != null ? lb.price : this.baseHigh(sec);
      baseSource = lb.price != null ? lb.source : 'high';
      if (base == null) return null;
      trigger = base * (1 - rule.addonDropPct / 100);
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
  { key: 'sp500', sym: '^GSPC', label: 'S&P500', market: 'US' },
  { key: 'ndx', sym: '^NDX', label: 'NASDAQ100', market: 'US' },
];

// ---------- 価格取得 ----------
const api = {
  async refreshAll() {
    const secs = store.data.securities.filter(s => s.ticker);
    const symbols = secs.map(yahooSymbol);
    symbols.push('USDJPY=X');
    INDICES.forEach(ix => symbols.push(ix.sym)); // 参考指数も一緒に取得
    if (symbols.length === 0) return;
    let res;
    try {
      res = await fetch(`/api/price?symbols=${encodeURIComponent(symbols.join(','))}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch (e) {
      toast('価格取得に失敗（手入力で更新できます）');
      return;
    }
    const quotes = await res.json();
    for (const sec of secs) {
      const q = quotes[yahooSymbol(sec)];
      if (q && !q.error && q.price != null) {
        store.data.prices[priceKey(sec)] = {
          price: q.price, prevClose: q.prevClose,
          high5y: q.high5y, high52w: q.high52w, fetchedAt: q.fetchedAt,
        };
      }
    }
    const fx = quotes['USDJPY=X'];
    if (fx && fx.price != null) store.data.fx.USDJPY = fx.price;
    // 参考指数の前日比用に price/prevClose を保存
    store.data.indices = store.data.indices || {};
    for (const ix of INDICES) {
      const q = quotes[ix.sym];
      if (q && !q.error && q.price != null) store.data.indices[ix.key] = { price: q.price, prevClose: q.prevClose, fetchedAt: q.fetchedAt };
    }
    store.data.lastPriceUpdate = new Date().toISOString();
    store.save();
    // 銘柄情報は名前未取得の銘柄だけ取得（名前はほぼ不変＝毎回取らない。APIリクエスト削減＋名称ブレ防止）
    const need = secs.filter(s => !(store.data.meta[priceKey(s)] && store.data.meta[priceKey(s)].name));
    if (need.length) await this.refreshMeta(need);
    toast('価格を更新しました');
  },

  // 銘柄情報マスタを一括取得して store.data.meta にキャッシュ
  async refreshMeta(secs) {
    secs = secs || store.data.securities.filter(s => s.ticker);
    if (secs.length === 0) return;
    const symbols = [...new Set(secs.map(yahooSymbol))];
    try {
      const res = await fetch(`/api/info?symbols=${encodeURIComponent(symbols.join(','))}`);
      if (!res.ok) return;
      const infos = await res.json();
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
    } catch (_) { /* 取得失敗は無視（手入力可） */ }
  },

  // 起動時の日次更新: 1日1回だけ 銘柄名/セクター/業種/高値 をまとめて更新（名称変更や高値の日次反映用）
  async dailyStartup() {
    if (store.data.securities.every(s => !s.ticker)) return;
    if (store.data.lastInfoDate === today()) return; // 本日実行済み
    store.data.lastInfoDate = today(); store.save();
    await this.refreshAll();              // 価格＋高値（52週/5年）＋名前未取得分
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
// 一覧のソート/フィルタ・カラム設定（市場ごと）。デフォルトはティッカー順
const listState = {
  US:     { sortKey: 'ticker', sortDir: 1, broker: '', account: '', category: '' },
  JP:     { sortKey: 'ticker', sortDir: 1, broker: '', account: '', category: '' },
  FUND:   { sortKey: 'ticker', sortDir: 1, broker: '', account: '', category: '' },
  SIGNAL: { sortKey: 'drop',   sortDir: 1, broker: '', account: '', category: '' },
};
// カラム設定: 市場ごとに [{key, visible}] の配列
let colPrefs = {};
function loadColPrefs() {
  try { colPrefs = JSON.parse(localStorage.getItem(COL_PREFS_KEY)) || {}; } catch(_) { colPrefs = {}; }
}
function saveColPrefs() { localStorage.setItem(COL_PREFS_KEY, JSON.stringify(colPrefs)); }
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
  ticker:    (s,c) => `<td class="l col-code"><span class="lnk" onclick="openSecurityDetail(${s.id})">${esc(s.ticker)}</span></td>`,
  name:      (s,c) => `<td class="l"><strong class="lnk" onclick="openSecurityDetail(${s.id})">${esc(calc.displayName(s))}</strong>${s.watch ? ` <span class="tag watch">注意</span>` : ''}</td>`,
  market:    (s,c) => `<td class="l"><span class="tag ${s.market.toLowerCase()}">${MARKET_LABEL[s.market]}</span></td>`,
  broker:    (s,c) => { const b = calc.lastBroker(s); return `<td class="l">${b ? esc(b) : muted}</td>`; },
  sigType:   (s,c) => `<td class="l">${c.ev ? (c.ev.type === 'initial' ? '初回購入' : '買い増し') : muted}</td>`,
  // 現在値: 価格があれば株探チャートへの外部リンク。未取得時は手入力ボタンのまま。
  price:     (s,c) => `<td>${c.price != null ? `<a href="${kabutanUrl(s)}" target="_blank" rel="noopener" class="lnk-ext">${fmtAmt(c.price, c.market)}</a>` : c.priceCell}</td>`,
  // 前日比: 株探チャートへの外部リンク。条件付き背景・文字色(緑/赤)は維持。
  day:       (s,c) => { const v = c.dayChg, st = condStyle('day', v); return `<td class="${st ? '' : cls(v)}"${st}><a href="${kabutanUrl(s)}" target="_blank" rel="noopener" class="lnk-ext">${v != null ? signed(v) + '%' : '—'}</a></td>`; },
  trigger:   (s,c) => `<td>${c.ev ? (c.ev.baseSource === 'みなし' ? MINASHI : c.ev.baseSource === '固定' ? FIXED_MARK : '') + c.m(c.ev.trigger) : muted}</td>`,
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
  dropFromPrev: (s,c) => pctTdBg(calc.dropFromPrev(s), 'dropFromPrev'),
  sector:    (s,c) => { const v = calc.field(s,'sector'); return `<td class="l">${v ? esc(v) : muted}</td>`; },
  industry:  (s,c) => { const v = calc.field(s,'industry'); return `<td class="l">${v ? esc(v) : muted}</td>`; },
  marketCap: (s,c) => { const v = calc.marketCap(s); return `<td>${v != null ? Number(Math.round(v)).toLocaleString('ja-JP') : muted}</td>`; },
  value:     (s,c) => `<td>${c.th.qty ? fmtAmt(c.valN, c.market) + c.noPriceMark : muted}</td>`,
  cost:      (s,c) => `<td>${c.th.qty ? c.m(c.th.acquiredCost) : muted}</td>`,
  pnl:       (s,c) => pctTd(c.pnlPct),
  avgCost:   (s,c) => `<td>${c.th.qty ? fmtAmt(c.th.avgCost, c.market) : muted}</td>`,
  qty:       (s,c) => `<td>${c.th.qty ? fmtQty(c.th.qty, c.market) : '<span class="muted">0</span>'}</td>`,
  buyCount:  (s,c) => `<td>${c.buyCnt ? num(c.buyCnt) : muted}</td>`,
  buyAmount: (s,c) => `<td>${c.m(c.buyAmt)}</td>`,
  reco:      (s,c) => `<td>${c.recoAmt ? fmtAmt(c.recoAmt, c.market) : muted}</td>`,
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
  recoCategory: (s,c) => `<td class="l">${s.recoCategory ? esc(s.recoCategory) : muted}</td>`,
  stars:     (s,c) => { const a = [s.starValuation, s.starStrength, s.starRisk]; return `<td class="l">${a.some(x => x != null) ? a.map(x => x ?? '—').join('/') : muted}</td>`; },
  analysisDate: (s,c) => `<td class="l">${s.analysisDate ? esc(s.analysisDate) : muted}</td>`,
  analysisNote: (s,c) => `<td class="l" title="${esc(s.analysisNote || '')}">${s.analysisNote ? esc(String(s.analysisNote).slice(0, 24)) + (s.analysisNote.length > 24 ? '…' : '') : muted}</td>`,
};

function render() {
  updateHeader();
  updateSignalBadge();
  updateSplitBadge();
  switch (currentView) {
    case 'dashboard': renderDashboard(); break;
    case 'us': renderMarket('US'); break;
    case 'jp': renderMarket('JP'); break;
    case 'signals': renderSignals(); break;
    case 'splits': renderSplitsTab(); break;
    case 'report': renderReport(); break;
    case 'secmaster': renderSecMaster(); break;
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
    const avail = Math.max(200, window.innerHeight - top - 36);
    if (wrap.scrollHeight > avail) wrap.style.maxHeight = avail + 'px'; // はみ出す時だけ枠内スクロール化
  });
}
let _fitTimer = null;
window.addEventListener('resize', () => { clearTimeout(_fitTimer); _fitTimer = setTimeout(fitListTables, 120); });

function updateHeader() {
  const fx = calc.fx();
  document.getElementById('fx-indicator').textContent = `USD/JPY: ${fx ? fx.toFixed(2) : '--'}`;
  const lu = document.getElementById('last-update');
  if (lu) lu.textContent = store.data.lastPriceUpdate ? `更新: ${fmtDateTime(store.data.lastPriceUpdate)}` : '更新: 未取得';
}

function updateSignalBadge() {
  const n = allSignals().length;
  const b = document.getElementById('signal-badge');
  b.textContent = n; b.hidden = n === 0;
}

function updateSplitBadge() {
  const n = pendingSplits().length;
  const b = document.getElementById('split-badge');
  if (b) { b.textContent = n; b.hidden = n === 0; }
}

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

  // 前日比（金額・円換算）＋参考指数
  const dcCell = (x) => `<span class="${cls(x.amount)}">${x.amount >= 0 ? '+' : ''}${yen(x.amount)}</span>${x.pct != null ? ` <span class="${cls(x.pct)}">(${signed(x.pct)}%)</span>` : ''}`;
  const idxPct = (k) => { const v = calc.indexChangePct(k); return v == null ? '<span class="muted">—</span>' : `<span class="${cls(v)}">${signed(v)}%</span>`; };
  const dayChangeSection = `<div class="section">
      <div class="section-head"><h2>前日比（金額・円換算）</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th class="l">区分</th><th class="l">前日比（金額）</th><th class="l">参考指数（前日比）</th></tr></thead>
        <tbody>
          <tr><td class="l"><strong>全体</strong></td><td class="l">${dcCell(calc.dayChangeJpy())}</td><td class="l muted">—</td></tr>
          <tr><td class="l"><span class="tag jp">日本株</span></td><td class="l">${dcCell(calc.dayChangeJpy('JP'))}</td><td class="l">日経平均 ${idxPct('n225')}　／　TOPIX ${idxPct('topix')}</td></tr>
          <tr><td class="l"><span class="tag us">米国株</span></td><td class="l">${dcCell(calc.dayChangeJpy('US'))}</td><td class="l">S&amp;P500 ${idxPct('sp500')}　／　NASDAQ100 ${idxPct('ndx')}</td></tr>
        </tbody>
      </table></div>
      <p class="muted" style="padding:0 16px 12px">前日比金額＝Σ 数量×(現在値−前日終値) を円換算。指数は前日比%（TOPIXは連動ETF 1306.T を参考値として使用）。</p>
    </div>`;

  app.innerHTML = `
    ${notes.map(n => `<div class="notice">${esc(n)}</div>`).join('')}
    <div class="cards">
      <div class="card"><div class="label">総資産（円換算${fxMissing ? '・米株除く' : ''}）</div><div class="value">${yen(totalJpy)}</div></div>
      <div class="card"><div class="label">評価損益（円換算）</div><div class="value ${cls(pnl)}">${yen(pnl)}</div><div class="sub ${cls(pnl)}">${signed(pnlPct)}%</div></div>
      <div class="card"><div class="label">取得原価（円換算）</div><div class="value">${yen(costJpy)}</div></div>
      <div class="card"><div class="label">買い増しサイン</div><div class="value ${sigCount ? 'neg' : ''}">${sigCount} 件</div></div>
    </div>
    ${dayChangeSection}
    <div class="section">
      <div class="section-head"><h2>市場別の内訳</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th class="l">市場</th><th>評価額(原通貨)</th><th>取得原価(原通貨)</th><th>損益率</th><th>評価額(円換算)</th><th>銘柄数</th></tr></thead>
        <tbody>
          ${markets.map(m => {
            const d = per[m];
            const ccy = MARKET_CCY[m];
            const p = d.valN - d.costN; const pp = d.costN > 0 ? p / d.costN * 100 : null;
            const vj = calc.toJpy(m, d.valN);
            return `<tr><td class="l"><span class="tag ${m.toLowerCase()}">${MARKET_LABEL[m]}</span></td>
              <td>${money(d.valN, ccy)}</td><td>${money(d.costN, ccy)}</td>
              <td class="${cls(pp)}">${pp != null ? signed(pp) + '%' : '—'}</td>
              <td>${vj != null ? yen(vj) : '<span class="muted">為替未取得</span>'}</td>
              <td>${d.held}/${d.cnt}</td></tr>`;
          }).join('')}
        </tbody>
      </table></div>
    </div>
    <div class="section">
      <div class="section-head"><h2>買い増しサイン（到達済み）</h2>
        <button class="btn btn-sm" onclick="go('signals')">一覧へ</button></div>
      <div class="section-body">${dashSignalsTable()}</div>
    </div>`;
}

// ---------- 市場別 一覧 ----------
// ソート用の比較値（一覧・サイン共通）
function sortValue(sec, key) {
  const th = calc.totalHolding(sec.id);
  switch (key) {
    case 'name': return calc.displayName(sec).toLowerCase();
    case 'ticker': return (sec.ticker || '').toLowerCase();
    case 'market': return sec.market;
    case 'broker': return (calc.lastBroker(sec) || '').toLowerCase();
    case 'sigType': { const ev = calc.evaluate(sec); return ev ? ev.type : 'z'; }
    case 'category': return sec.category || '';
    case 'ruleName': { const r = store.rule(sec.ruleId); return r ? (r.name || '').toLowerCase() : ''; }
    case 'fixedBuyPrice': return sec.fixedBuyPrice ?? -Infinity;
    case 'qty': return th.qty;
    case 'avgCost': return th.avgCost;
    case 'cost': return th.acquiredCost;
    case 'sector': return calc.field(sec, 'sector') || 'zzz';
    case 'industry': return calc.field(sec, 'industry') || 'zzz';
    case 'marketCap': return calc.marketCap(sec) ?? -Infinity;
    case 'per': return calc.per(sec) ?? Infinity;
    case 'divYield': return calc.divYield(sec) ?? -Infinity;
    case 'eps': return calc.field(sec, 'eps') ?? -Infinity;
    case 'overallGrade': return sec.overallGrade || 'zzz';
    case 'buyGrade': return sec.buyGrade || 'zzz';
    case 'recoCategory': return sec.recoCategory || 'zzz';
    case 'analysisDate': return sec.analysisDate || '';
    case 'buyCount': return calc.buyCount(sec) || 0;
    case 'buyAmount': return calc.buyAmount(sec) ?? -Infinity;
    case 'reco': return store.categoryAmountFor(sec.category, sec.market) || -Infinity;
    case 'price': return calc.price(sec) ?? -Infinity;
    case 'high5y': return calc.high5y(sec) ?? -Infinity;
    case 'high52w': return calc.high52w(sec) ?? -Infinity;
    case 'prevBuyPrice': return calc.lastBuyPrice(sec) ?? -Infinity;
    case 'dropFromPrev': return calc.dropFromPrev(sec) ?? Infinity;
    case 'dropFrom5y': return calc.dropFrom5y(sec) ?? Infinity;
    case 'dropFrom52w': return calc.dropFrom52w(sec) ?? Infinity;
    case 'value': return calc.valueOrCostNative(sec) ?? -Infinity;
    case 'pnl': return calc.pnlPctNative(sec) ?? -Infinity;
    case 'trigger': { const ev = calc.evaluate(sec); return ev ? ev.trigger : -Infinity; }
    case 'base': { const ev = calc.evaluate(sec); return ev ? ev.base : -Infinity; }
    case 'drop': { const ev = calc.evaluate(sec); return ev ? ev.remainingDropPct : Infinity; }
    case 'dropPrev': return calc.remainingDropPrev(sec) ?? Infinity;
    case 'rating': return sec.rating || sec.overallGrade || 'zzz';
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
  const st = listState[market];
  const isStock = market !== 'FUND';
  let secs = store.data.securities.filter(s => s.market === market);
  // 一覧に出すのは「保有あり(数量>0) または 注意銘柄」のみ。
  // 保有なし＆非注意（例: 分析後に全売却した銘柄）は一覧から外し、銘柄マスタタブで管理する。
  secs = secs.filter(s => s.watch || store.data.holdings.some(h => h.securityId === s.id && h.quantity > 0));
  if (st.broker)   secs = secs.filter(s => store.data.holdings.some(h => h.securityId === s.id && h.broker === st.broker && h.quantity > 0));
  if (st.account)  secs = secs.filter(s => store.data.holdings.some(h => h.securityId === s.id && h.accountType === st.account && h.quantity > 0));
  if (st.category) secs = secs.filter(s => s.category === st.category);
  secs = sortSecurities(secs, market);

  const catOpts = [...store.data.categories].sort((a, b) => a.sortOrder - b.sortOrder)
    .map(c => `<option value="${esc(c.category)}" ${st.category === c.category ? 'selected' : ''}>${esc(c.category)}</option>`).join('');

  const ccy = MARKET_CCY[market];
  // 表示するカラム（ユーザー設定済みの順・表示フラグ反映）
  const visibleCols = getColOrder(market).filter(c => c.visible)
    .map(c => MASTER_COLS.find(m => m.key === c.key)).filter(Boolean);

  const headHtml = colHeadHtml(visibleCols, st, market, ccy);

  app.innerHTML = `
    <div class="section">
      <div class="section-head">
        <h2><span class="tag ${market.toLowerCase()}">${MARKET_LABEL[market]}</span> 保有・ウォッチ銘柄</h2>
        <button class="btn btn-primary btn-sm" onclick="openSecurityForm(null, '${market}')">＋ 銘柄を追加</button>
      </div>
      <div class="filterbar">
        <label>証券会社
          <select onchange="setFilter('${market}','broker',this.value)">
            <option value="">すべて</option>${BROKERS.map(b => `<option ${st.broker === b ? 'selected' : ''}>${b}</option>`).join('')}
          </select></label>
        <label>口座
          <select onchange="setFilter('${market}','account',this.value)">
            <option value="">すべて</option>${ACCOUNTS.map(a => `<option ${st.account === a ? 'selected' : ''}>${a}</option>`).join('')}
          </select></label>
        <label>カテゴリ
          <select onchange="setFilter('${market}','category',this.value)">
            <option value="">すべて</option>${catOpts}
          </select></label>
        ${(st.broker || st.account || st.category) ? `<button class="btn btn-sm" onclick="clearFilter('${market}')">絞込解除</button>` : ''}
        <button class="btn btn-sm col-picker-btn" onclick="openColPicker('${market}')" title="列の表示設定">⊞ 列</button>
        <span class="muted" style="margin-left:auto">${secs.length} 件</span>
      </div>
      <div class="bulkbar">
        <button class="btn btn-sm btn-danger" onclick="bulkSellAll()">選択を全売却</button>
        <span class="muted" id="bulk-count">選択 0 件</span>
      </div>
      <div class="section-body">
        ${secs.length === 0 ? `<div class="empty">該当する銘柄がありません。</div>` : `
        <div class="table-wrap"><table>
          <thead><tr><th class="l"><input type="checkbox" id="select-all" onchange="toggleSelectAll(this)"></th>${headHtml}<th class="l"></th></tr></thead>
          <tbody>
            ${secs.map(sec => marketRow(sec, visibleCols, { select: true })).join('')}
          </tbody>
        </table></div>`}
      </div>
    </div>`;
  bindRowSelect();
}

// ヘッダHTML生成（一覧・サイン共通）
function colHeadHtml(visibleCols, st, market, ccy) {
  return visibleCols.map(col => {
    const mc = MASTER_COLS.find(c => c.key === col.key);
    const cls2 = `${mc.left ? 'l' : ''} ${mc.narrow ? 'col-code' : ''}`.trim();
    const label = (['value','cost','buyAmount','reco','high5y','high52w','prevBuyPrice'].includes(col.key) && ccy && ccy !== '¥')
      ? `${mc.label}(${ccy})` : mc.label;
    if (mc.noSort) return `<th class="${cls2}">${label}</th>`;
    const active = st.sortKey === col.key;
    const arrow = active ? (st.sortDir === 1 ? ' ▲' : ' ▼') : '';
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
    dayChg: (price != null && p.prevClose) ? (price - p.prevClose) / p.prevClose * 100 : null,
    buyAmt: calc.buyAmount(sec),
    buyCnt: calc.buyCount(sec),
    recoAmt: store.categoryAmountFor(sec.category, market),
    high5y: calc.high5y(sec),
    high52w: calc.high52w(sec),
    prevBuy: calc.lastBuyPrice(sec),
    m: (v) => v != null ? fmtAmt(v, market) : '<span class="muted">—</span>',
  };
  const selectTd = opts.select ? `<td class="l"><input type="checkbox" class="row-select" data-id="${sec.id}"></td>` : '';
  const dataCells = visibleCols.map(col => {
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
  render();
}
function setFilter(market, field, value) { listState[market][field] = value; render(); }
function clearFilter(market) { Object.assign(listState[market], { broker: '', account: '', category: '' }); render(); }

// ---------- カラムピッカー ----------
let _colPickerMarket = null;
let _dragSrcIdx = null;

function openColPicker(market) {
  _colPickerMarket = market;
  const order = getColOrder(market);
  const itemsHtml = order.map((c, i) => {
    const mc = MASTER_COLS.find(m => m.key === c.key);
    if (!mc) return '';
    return `<div class="cp-item" draggable="true" data-idx="${i}"
        ondragstart="cpDragStart(event,${i})" ondragover="cpDragOver(event,${i})" ondrop="cpDrop(event,${i})" ondragend="cpDragEnd()">
      <span class="cp-handle">⠿</span>
      <label><input type="checkbox" onchange="cpToggle('${c.key}',this.checked)" ${c.visible ? 'checked' : ''}> ${esc(mc.label)}</label>
    </div>`;
  }).join('');
  showModal('列の表示・並び替え', `
    <div class="cp-wrapper">
      <p class="muted" style="margin:0 0 10px">チェックで表示/非表示。ハンドル(⠿)をドラッグで並び替え。</p>
      <div id="cp-list">${itemsHtml}</div>
    </div>
    <div class="form-actions" style="margin-top:12px">
      <button type="button" class="btn btn-sm" onclick="cpReset()">デフォルトに戻す</button>
      <button type="button" class="btn btn-primary" onclick="closeModal();render()">適用</button>
    </div>`);
}
function cpToggle(key, checked) {
  const order = getColOrder(_colPickerMarket);
  const c = order.find(x => x.key === key);
  if (c) { c.visible = checked; saveColPrefs(); }
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
  const visibleCols = getColOrder('SIGNAL').filter(c => c.visible)
    .map(c => MASTER_COLS.find(m => m.key === c.key)).filter(Boolean);
  const colCount = visibleCols.length + 1; // +1 = アクション列
  const head = colHeadHtml(visibleCols, st, 'SIGNAL', null);
  // 到達／もうすぐ を1つの表にまとめ、グループ見出し行で区切る（列幅を揃えるため）
  const groupRow = (label, cls2, n) => `<tr class="sig-group ${cls2}"><td colspan="${colCount}">${label}　${n} 件</td></tr>`;
  const bodyRows = (secs) => secs.length
    ? secs.map(sec => marketRow(sec, visibleCols, { actions: 'signal' })).join('')
    : `<tr><td class="muted" colspan="${colCount}" style="padding:12px 16px">該当する銘柄はありません。</td></tr>`;
  const seg = (m, label) => `<button class="btn btn-sm${signalMarketFilter === m ? ' btn-primary' : ''}" onclick="setSignalMarket('${m}')">${label}</button>`;
  app.innerHTML = `
    <div class="section">
      <div class="section-head">
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <h2>買い増しサイン</h2>
          <div class="seg-toggle">${seg('all', '全市場')}${seg('JP', '日本株')}${seg('US', '米国株')}</div>
        </div>
        <button class="btn btn-sm col-picker-btn" onclick="openColPicker('SIGNAL')" title="列の表示設定">⊞ 列</button>
      </div>
      <div class="section-body">
        <div class="table-wrap"><table>
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
}

function signalTable(secs, visibleCols, st) {
  if (secs.length === 0) return `<div class="empty" style="padding:14px">該当する銘柄はありません。</div>`;
  const head = colHeadHtml(visibleCols, st, 'SIGNAL', null);
  return `<div class="table-wrap"><table>
    <thead><tr>${head}<th class="l"></th></tr></thead>
    <tbody>${secs.map(sec => marketRow(sec, visibleCols, { actions: 'signal' })).join('')}</tbody>
  </table></div>`;
}

// ダッシュボード用の簡易サイン表（到達のみ・上位）
function dashSignalsTable() {
  const { reached } = signalRows();
  if (reached.length === 0) return `<div class="empty">現在、買い増しサインに到達している銘柄はありません。</div>`;
  const cols = ['ticker', 'name', 'market', 'price', 'drop', 'trigger', 'buyAmount']
    .map(k => MASTER_COLS.find(m => m.key === k));
  const head = cols.map(c => `<th class="${c.left ? 'l' : ''}">${c.label}</th>`).join('');
  const sorted = sortSecurities(reached, 'SIGNAL');
  return `<div class="table-wrap"><table>
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

// ---------- レポート（SEC-17） ----------
let reportPeriod = 'all'; // 'all' | 'ytd'
function setReportPeriod(p) { reportPeriod = p; renderReport(); }
function renderReport() {
  const byMarket = {}, byBroker = {}, matrix = {};
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
  }
  let totalVal = 0, totalCost = 0;
  Object.values(byMarket).forEach(d => { totalVal += d.valJpy; totalCost += d.costJpy; });
  const pnl = totalVal - totalCost, pnlPct = totalCost > 0 ? pnl / totalCost * 100 : 0;
  const pnlCls = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '';

  const mkRows = ['US', 'JP'].filter(m => byMarket[m]).map(m => { const d = byMarket[m], p = d.valJpy - d.costJpy, pp = d.costJpy > 0 ? p / d.costJpy * 100 : 0; return `<tr><td class="l"><span class="tag ${m.toLowerCase()}">${MARKET_LABEL[m]}</span></td><td>${yen(d.valJpy)}</td><td>${yen(d.costJpy)}</td><td class="${cls(p)}">${yen(p)}</td><td class="${cls(pp)}">${signed(pp)}%</td><td>${d.secs.size}</td></tr>`; }).join('');
  const brokers = Object.keys(byBroker).sort((a, b) => byBroker[b].valJpy - byBroker[a].valJpy);
  const bkRows = brokers.map(b => { const d = byBroker[b], p = d.valJpy - d.costJpy, pp = d.costJpy > 0 ? p / d.costJpy * 100 : 0; return `<tr><td class="l">${esc(b)}</td><td>${yen(d.valJpy)}</td><td>${yen(d.costJpy)}</td><td class="${cls(p)}">${yen(p)}</td><td class="${cls(pp)}">${signed(pp)}%</td><td>${d.secs.size}</td></tr>`; }).join('');
  const mxRows = brokers.map(b => { const us = (matrix[b] || {}).US || 0, jp = (matrix[b] || {}).JP || 0; return `<tr><td class="l">${esc(b)}</td><td>${us ? yen(us) : muted}</td><td>${jp ? yen(jp) : muted}</td><td><strong>${yen(us + jp)}</strong></td></tr>`; }).join('');

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
  const seg = (p, l) => `<button class="btn btn-sm${reportPeriod === p ? ' btn-primary' : ''}" onclick="setReportPeriod('${p}')">${l}</button>`;

  app.innerHTML = `
    <div class="cards">
      <div class="card"><div class="label">総資産（円換算）</div><div class="value">${yen(totalVal)}</div></div>
      <div class="card"><div class="label">取得原価（円換算）</div><div class="value">${yen(totalCost)}</div></div>
      <div class="card"><div class="label">評価損益</div><div class="value ${pnlCls}">${yen(pnl)}</div><div class="sub ${cls(pnlPct)}">${signed(pnlPct)}%</div></div>
    </div>
    ${fxMissing ? '<div class="notice">USD/JPY 為替が未取得のため、円換算に米国株を含めていません。「価格更新」で取得できます。</div>' : ''}
    <div class="section"><div class="section-head"><h2>市場別の集計（円換算）</h2></div>
      <div class="table-wrap"><table><thead><tr><th class="l">市場</th><th>評価額</th><th>取得原価</th><th>評価損益</th><th>損益率</th><th>銘柄数</th></tr></thead>
      <tbody>${mkRows || `<tr><td colspan="6" class="empty">保有銘柄がありません。</td></tr>`}</tbody></table></div></div>
    <div class="section"><div class="section-head"><h2>証券会社別の集計（円換算）</h2></div>
      <div class="table-wrap"><table><thead><tr><th class="l">証券会社</th><th>評価額</th><th>取得原価</th><th>評価損益</th><th>損益率</th><th>銘柄数</th></tr></thead>
      <tbody>${bkRows || `<tr><td colspan="6" class="empty">保有銘柄がありません。</td></tr>`}</tbody></table></div></div>
    <div class="section"><div class="section-head"><h2>証券会社 × 市場（評価額・円換算）</h2></div>
      <div class="table-wrap"><table><thead><tr><th class="l">証券会社</th><th>米国株</th><th>日本株</th><th>合計</th></tr></thead>
      <tbody>${mxRows || `<tr><td colspan="4" class="empty">—</td></tr>`}</tbody></table></div></div>
    <div class="section"><div class="section-head"><h2>取引サマリー（${reportPeriod === 'ytd' ? '今年' : '全期間'}・円換算）</h2>
        <div class="seg-toggle">${seg('all', '全期間')}${seg('ytd', '今年')}</div></div>
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
function renderSecMaster() {
  const secs = [...store.data.securities].sort((a, b) => (a.market + a.ticker).localeCompare(b.market + b.ticker));
  const cell = (v, l) => `<td class="${l ? 'l ' : ''}">${v != null && v !== '' ? esc(String(v)) : muted}</td>`;
  const rows = secs.map(s => {
    const rule = store.rule(s.ruleId);
    const ov = (k) => s[k + 'Override'] ? ' <span class="tag" title="手動上書き中">手</span>' : '';
    return `<tr>
      <td class="l col-code"><span class="lnk" onclick="openSecurityDetail(${s.id})">${esc(s.ticker)}</span></td>
      <td class="l"><strong class="lnk" onclick="openSecurityDetail(${s.id})">${esc(calc.displayName(s))}</strong>${ov('name')}${s.enabled === false ? ' <span class="tag" title="無効">無効</span>' : ''}</td>
      <td class="l"><span class="tag ${s.market.toLowerCase()}">${MARKET_LABEL[s.market]}</span></td>
      <td class="l">${calc.field(s, 'sector') ? esc(calc.field(s, 'sector')) + ov('sector') : muted}</td>
      <td class="l">${calc.field(s, 'industry') ? esc(calc.field(s, 'industry')) + ov('industry') : muted}</td>
      <td class="l">${gradeBadge(s)}</td>
      ${cell(s.overallGrade, true)}
      ${cell(s.buyGrade, true)}
      ${cell(s.recoCategory, true)}
      <td>${s.priority != null ? num(s.priority) : muted}</td>
      <td class="l">${rule ? esc(rule.name) : muted}</td>
      <td class="l">${s.category ? `<span class="tag">${esc(s.category)}</span>` : muted}</td>
      <td class="l nowrap"><button class="btn btn-sm" onclick="openSecurityForm(${s.id})">編集</button></td>
    </tr>`;
  }).join('');
  app.innerHTML = `
    <div class="section">
      <div class="section-head"><h2>銘柄マスタ（${secs.length} 件）</h2>
        <button class="btn btn-sm btn-primary" onclick="openSecurityForm()">＋ 銘柄を追加</button></div>
      <div class="section-body">
        <p class="muted" style="padding:10px 16px 0">名前・セクター・業種は「編集」から手動で上書きできます（自動取得では上書きされません）。「手」=手動上書き中。</p>
        <div class="table-wrap"><table>
          <thead><tr>
            <th class="l col-code">コード</th><th class="l">銘柄名</th><th class="l">市場</th>
            <th class="l">セクター</th><th class="l">業種</th><th class="l">格付</th>
            <th class="l">総合評価</th><th class="l">買い時評価</th><th class="l">AI推奨カテゴリ</th>
            <th>優先順位</th><th class="l">買い増しルール</th><th class="l">AI判断</th><th class="l"></th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="13" class="empty">銘柄がありません。</td></tr>`}</tbody>
        </table></div>
      </div>
    </div>`;
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
      <div class="section-head"><h2>一括取込（Excel/CSV 貼り付け）</h2></div>
      <div class="section-body" style="padding:16px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn" onclick="openPasteImport('analysis')">銘柄分析結果を取込</button>
        <button class="btn" onclick="openBrokerImport()">保有を取込（証券会社別）</button>
        <button class="btn" onclick="openImportMapping()">取込フィールド設定</button>
        <button class="btn" onclick="refreshAllMeta()">銘柄情報を更新（名前・セクター・PER等）</button>
      </div>
      <p class="muted" style="padding:0 16px 14px">Excelの該当シートをヘッダ行ごとコピーして貼り付け→ティッカーで既存銘柄に紐づけ（未登録は新規作成も可）。</p>
      ${importHistorySection()}
    </div>
    <div class="section">
      <div class="section-head"><h2>データ管理</h2></div>
      <div class="section-body" style="padding:16px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn" onclick="exportData()">エクスポート(JSON)</button>
        <button class="btn" onclick="importData()">インポート(JSON)</button>
        <button class="btn" onclick="exportGeneric()">汎用出力(CSV)</button>
        <button class="btn btn-danger" onclick="resetData()">全データ削除</button>
      </div>
      <p class="muted" style="padding:0 16px 14px">現在の保存先: このブラウザ(localStorage)。将来 Google スプレッドシートへ移行予定。</p>
    </div>
    ${googleSyncSection()}`;
}

// Google連携（実験的・任意）。クライアントID未設定なら休眠＝現行アプリに影響しない。
function googleSyncSection() {
  const g = (store.data.settings && store.data.settings.google) || {};
  const configured = !!g.clientId;
  return `<div class="section">
    <div class="section-head"><h2>Google連携（実験的・任意）</h2>
      <span class="tag ${configured ? 'jp' : ''}">${configured ? '設定済み' : '未設定'}</span></div>
    <div class="section-body" style="padding:16px">
      <p class="muted" style="margin:0 0 12px">ブラウザ完結方式(GIS)。Googleスプレッドシートへ手動で保存/読込（v1=JSONブロブ）。
        クライアントID未設定なら何も起きません。<strong>実機での動作確認は未実施</strong>（クライアントID入手後に検証）。</p>
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
        <div class="field"><label>前回購入価格（買い取引が無い場合の基準・任意）</label>
          <input name="prevBuyPrice" type="number" step="any" value="${sec && sec.prevBuyPrice != null ? sec.prevBuyPrice : ''}" placeholder="原通貨"></div>
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
      fixedBuyPrice: numOrNull(f.fixedBuyPrice.value),
      baseHighMode: f.baseHighMode.value || null,
      baseHighManual: f.baseHighMode.value === 'manual' ? numOrNull(f.baseHighManual.value) : null,
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
    // マスタ情報を取得（名前・セクター等）。未取得なら裏で取得して再描画
    if (target && !store.data.meta[priceKey(target)]?.name) api.refreshMeta([target]).then(render);
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
  const rowsHtml = hs.map(h => `
    <tr data-hid="${h.id}">
      <td class="l">${esc(h.broker)}</td><td class="l">${esc(h.accountType)}</td>
      <td><input type="number" step="any" class="h-qty" value="${h.quantity}"></td>
      <td><input type="number" step="any" class="h-cost" value="${h.avgCost}"></td>
      <td class="l"><button type="button" class="btn btn-sm btn-danger" onclick="removeHolding(${h.id},${secId})">削除</button></td>
    </tr>`).join('');

  showModal(`保有を直接編集 — ${esc(sec.name || sec.ticker)}`, `
    <form id="holdings-form">
      <p class="muted">取引履歴を介さず、数量・平均取得単価を直接修正できます（単価 ${ccy}）。</p>
      <div class="table-wrap"><table>
        <thead><tr><th class="l">証券会社</th><th class="l">口座</th><th>数量</th><th>平均取得単価(${ccy})</th><th></th></tr></thead>
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
      }
    });
    // 新規追加
    if (f.newQty.value || f.newCost.value) {
      store.setHolding(secId, f.broker.value, f.accountType.value,
        parseFloat(f.newQty.value) || 0, parseFloat(f.newCost.value) || 0);
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
  // 判定
  const judge = ruleInfo + (ev ? [
    kv('種別', ev.type === 'initial' ? '初回購入' : '買い増し'),
    kv('基準値', (ev.baseSource === 'みなし' ? MINASHI : ev.baseSource === '固定' ? FIXED_MARK : '') + m(ev.base)),
    kv('次回購入(トリガー)', (ev.baseSource === '固定' ? FIXED_MARK : '') + m(ev.trigger)),
    kv('現在値', m(price)),
    kv('残り下落率', ev.remainingDropPct != null ? `<span class="${ev.reached ? 'neg' : ''}">${ev.remainingDropPct.toFixed(1)}%</span>` + (ev.reached ? '（到達）' : '') : '—'),
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
    kv('AI判断 / 推奨カテゴリ', `${esc(sec.category || '—')} / ${esc(sec.recoCategory || '—')}`),
    kv('優先順位 / 評価日', `${sec.priority != null ? sec.priority : '—'} / ${esc(sec.analysisDate || '—')}`),
    sec.analysisNote ? kv('分析メモ', esc(sec.analysisNote)) : '',
  ].join('');
  // ファンダ
  const fund = [
    kv('セクター / 業種', `${esc(calc.field(sec, 'sector') || '—')} / ${esc(calc.field(sec, 'industry') || '—')}`),
    kv('PER / EPS', `${calc.per(sec) != null ? num(calc.per(sec)) : '—'} / ${calc.field(sec, 'eps') != null ? m(calc.field(sec, 'eps')) : '—'}`),
    kv('配当/株 / 利回り', `${calc.field(sec, 'dividend') != null ? m(calc.field(sec, 'dividend')) : '—'} / ${calc.divYield(sec) != null ? calc.divYield(sec).toFixed(2) + '%' : '—'}`),
    kv('時価総額(百万) / 5年高値 / 52週高値', `${calc.marketCap(sec) != null ? num(Math.round(calc.marketCap(sec))) : '—'} / ${m(calc.high5y(sec))} / ${m(calc.high52w(sec))}`),
  ].join('');
  const sectionBox = (title, inner) => `<fieldset class="form-group"><legend>${title}</legend><div class="auto-info">${inner}</div></fieldset>`;
  showModal(`${calc.displayName(sec)}（${sec.ticker}）`, `
    <div style="margin:-4px 0 10px"><span class="tag ${sec.market.toLowerCase()}">${MARKET_LABEL[sec.market]}</span></div>
    <fieldset class="form-group"><legend>価格チャート（5年・週足終値）</legend>
      <div id="detail-chart" class="muted" style="min-height:160px;display:flex;align-items:center;justify-content:center">読み込み中…</div>
      <p class="muted" style="margin:6px 0 0;font-size:11px">青=終値 / 赤破線=次回購入(トリガー) / 緑破線=現在値${typeof sec.prevBuyPrice==='number'||lb.price!=null?' / 橙破線=前回購入':''} / ◆高値・安値 / 灰=補助目盛</p>
    </fieldset>
    ${sectionBox('判定', judge)}
    ${sectionBox('保有', holdRows + (holdSummary || ''))}
    ${sectionBox('購入・取引履歴', txnRows)}
    ${sectionBox('分析メタ', meta)}
    ${sectionBox('ファンダ', fund)}
    <div class="form-actions">
      <button type="button" class="btn" onclick="openTxnForm(${sec.id})">取引を記録</button>
      <button type="button" class="btn" onclick="openSecurityForm(${sec.id})">編集</button>
      <button type="button" class="btn btn-primary" onclick="closeModal()">閉じる</button>
    </div>`, { wide: true });
  loadDetailChart(sec, ev, price, lb);
}
// 終値時系列を取得してSVGチャートを描画（トリガー/現在値/前回購入の水平線つき）
async function loadDetailChart(sec, ev, price, lb) {
  const el = document.getElementById('detail-chart'); if (!el) return;
  try {
    const res = await fetch(`/api/history?symbol=${encodeURIComponent(yahooSymbol(sec))}&range=5y&interval=1wk`);
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
      <p class="muted">買い=数量加算＆平均取得単価を更新 / 売り=数量のみ減算（単価は不変）</p>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
        <button type="submit" class="btn btn-primary">記録</button>
      </div>
    </form>`);
  document.getElementById('txn-form').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    store.addTransaction({
      securityId: secId, type: f.type.value,
      price: parseFloat(f.price.value), quantity: parseFloat(f.quantity.value),
      broker: f.broker.value, accountType: f.accountType.value, tradedAt: f.tradedAt.value,
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
    ? '評価日 / 銘柄名 / 総合評価 / 銘柄格付 / 買い時評価 / 推奨投資額 / 推奨カテゴリ / バリュエーション / 独自の強み / リスク / 備考 / 評価時点_購入優先順位'
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
  form.data.addEventListener('input', () => {
    const rows = parsePasted(form.data.value);
    preview.textContent = rows.length ? `${rows.length} 行を検出（ヘッダ含む）。${rows.length - 1} 件を取り込みます。` : '';
  });
  form.onsubmit = (e) => {
    e.preventDefault();
    const market = form.market.value;
    const create = form.create.checked;
    const result = isAnalysis
      ? importAnalysis(form.data.value, market, create)
      : importHoldings(form.data.value, market, create);
    closeModal(); render();
    toast(`取込完了: 更新 ${result.updated} 件 / 新規 ${result.created} 件${result.skipped ? ` / スキップ ${result.skipped}` : ''}`);
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

function importAnalysis(text, market, create) {
  const rows = parsePasted(text);
  if (rows.length < 2) return { updated: 0, created: 0, skipped: 0 };
  const idx = mapHeader(rows[0], ANALYSIS_COLMAP);
  let updated = 0, created = 0, skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    const rec = {};
    rows[i].forEach((cell, j) => { if (idx[j]) rec[idx[j]] = (cell || '').trim(); });
    const ticker = (rec.ticker || '').trim();
    if (!ticker) { skipped++; continue; }
    let sec = store.findSecurity(market, ticker);
    if (!sec) {
      if (!create) { skipped++; continue; }
      sec = store.addSecurity({
        market, ticker: ticker.toUpperCase(), name: '', currency: market === 'US' ? 'USD' : 'JPY',
        assetClass: market === 'FUND' ? 'fund' : 'stock', enabled: market !== 'FUND', ruleId: store.defaultRule().id,
      });
      created++;
    } else updated++;
    const nf = (v) => (v && v.trim()) ? parseFloat(v) : null;
    const sf = (v, fb) => (v && v.trim()) || fb || null;
    // 分析の「判断」項目はレコードへ
    const patch = {
      overallGrade: sf(rec.overallGrade, sec.overallGrade),
      rating: sf(rec.rating, sec.rating),
      buyGrade: sf(rec.buyGrade, sec.buyGrade),
      starValuation: parseStars(rec.starValuation) ?? sec.starValuation ?? null,
      starStrength: parseStars(rec.starStrength) ?? sec.starStrength ?? null,
      starRisk: parseStars(rec.starRisk) ?? sec.starRisk ?? null,
      analysisNote: sf(rec.analysisNote, sec.analysisNote),
      analysisDate: normDate(rec.analysisDate) || sec.analysisDate || null,
      recoCategory: sf(rec.recoCategory, sec.recoCategory),
      recoAmount: rec.recoAmount ? parseFloat(rec.recoAmount) : (sec.recoAmount ?? null),
    };
    if (rec.priority) { const p = parseInt(rec.priority, 10); if (!isNaN(p)) patch.priority = p; }
    // カテゴリ未設定なら推奨カテゴリを採用
    if (!sec.category && rec.recoCategory) patch.category = rec.recoCategory;
    // セクター/業種/時価総額/PER/EPS/配当はマスタ(meta)へ（自動取得項目と同じ置き場所）
    const metaPatch = clean({
      sector: sf(rec.sector), industry: sf(rec.industry),
      marketCap: nf(rec.marketCap), per: nf(rec.per), eps: nf(rec.eps), dividend: nf(rec.dividend),
    });
    if (Object.keys(metaPatch).length) store.setMeta(priceKey(sec), metaPatch);
    // 1回購入額が未設定なら推奨投資額を転記（米株は÷100ドル）。手入力済みは保持
    if (sec.buyAmount == null && rec.recoAmount) {
      const a = parseFloat(rec.recoAmount);
      if (!isNaN(a)) patch.buyAmount = market === 'US' ? a / 100 : a;
    }
    store.updateSecurity(sec.id, patch);
  }
  return { updated, created, skipped };
}

function importHoldings(text, market, create) {
  const rows = parsePasted(text);
  if (rows.length < 2) return { updated: 0, created: 0, skipped: 0 };
  const idx = mapHeader(rows[0], HOLDING_COLMAP);
  let updated = 0, created = 0, skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    const rec = {};
    rows[i].forEach((cell, j) => { if (idx[j]) rec[idx[j]] = (cell || '').trim(); });
    const ticker = (rec.ticker || '').trim();
    if (!ticker) { skipped++; continue; }
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
  }
  return { updated, created, skipped };
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
  'sbi-us':  { qtyPos: 1, avgCostPos: 2 },                                   // 数量, 取得単価, 現在値, 評価損益
  'sbi-jp':  { ticker: '銘柄コード', quantity: '保有株数', avgCost: '取得単価' },
  'moomoo':  { ticker: 'コード', quantity: '数量', avgCost: '平均取得価額', account: '口座区分', currency: '通貨' },
  'rakuten': { kind: '種別', ticker: '銘柄コード・ティッカー', quantity: '保有数量', avgCost: '平均取得価額', account: '口座' },
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
function parseSbiUsScreen(text, map) {
  const m = map || DEFAULT_IMPORT_MAPPINGS['sbi-us'];
  const qp = (m.qtyPos || 1) - 1, ap = (m.avgCostPos || 2) - 1;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const skip = new Set(['現買', '現売', '積立', '(株価：リアルタイム)', '保有数量', '取得単価', '現在値', '外貨建評価損益']);
  const isTicker = (s) => /^[A-Z][A-Z.]{0,5}\s*[^\x00-\x7F]/.test(s);
  const out = []; let account = '特定', i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/特定預り/.test(ln)) { account = '特定'; i++; continue; }
    if (/NISA預り/.test(ln)) { account = 'NISA'; i++; continue; }
    if (/米国株式|株価：リアルタイム/.test(ln) || skip.has(ln)) { i++; continue; }
    const tm = ln.match(/^([A-Z][A-Z.]{0,5})\s*[^\x00-\x7F]/);
    if (tm) {
      const ticker = tm[1]; const nums = []; let j = i + 1;
      while (j < lines.length && !isTicker(lines[j])) {
        if (!skip.has(lines[j])) { const n = numClean(lines[j]); if (n != null) nums.push(n); }
        j++;
      }
      if (nums.length > qp && nums.length > ap) out.push({ market: 'US', ticker, broker: 'SBI', account, quantity: nums[qp], avgCost: nums[ap] });
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
const GENERIC_MAP = {
  'ティッカー': 'ticker', 'コード': 'ticker', '市場': 'market', '証券会社': 'broker', '口座': 'account', '口座種別': 'account',
  '数量': 'quantity', '取得単価': 'avgCost', '平均取得単価': 'avgCost',
  '前回購入価格': 'prevBuyPrice', '基準高値モード': 'baseHighMode', '手動基準高値': 'baseHighManual',
  '買増固定値': 'fixedBuyPrice', '次回購入固定値': 'fixedBuyPrice',
  'ルール': 'ruleName', '買い増しルール': 'ruleName', 'カテゴリ': 'category',
  '1回購入額': 'buyAmount', '買い増し予定額': 'buyAmount', '購入回数': 'buyCount', '判定対象': 'enabled', 'ウォッチ': 'watch',
};
const GENERIC_HEADER = ['ティッカー', '市場', '証券会社', '口座', '数量', '取得単価', '前回購入価格', '基準高値モード', '手動基準高値', '買増固定値', 'ルール', 'カテゴリ', '1回購入額', '購入回数', '判定対象', 'ウォッチ'];
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
  'generic': { label: '汎用（貼り付け: ティッカー,市場,数量,取得単価）', input: 'paste', parse: parseGeneric, fixed: false },
};

// データ内の基準日（基準日/作成日/出力日/評価日 等のラベル付き日付）を抽出。無ければnull
function extractBaseDate(text) {
  const m = String(text || '').match(/(基準日|作成日|出力日|評価日|データ日付|日付)[^\d]{0,8}(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (!m) return null;
  return `${m[2]}-${String(m[3]).padStart(2, '0')}-${String(m[4]).padStart(2, '0')}`;
}

let _importRows = [], _importProfile = 'sbi-us', _importText = '';

function openBrokerImport() {
  const profOpts = Object.entries(IMPORT_PROFILES).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('');
  _importRows = []; _importProfile = 'sbi-us'; _importText = '';
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
  onImportProfileChange('sbi-us');
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
function runBrokerImport() {
  if (!_importRows.length) { toast('取込データがありません'); return; }
  const f = document.getElementById('bimport-form');
  const create = f.create.checked;
  const prof = IMPORT_PROFILES[_importProfile];
  const defBroker = f.broker ? f.broker.value : 'SBI';
  // モード決定: 固定プロファイルは replace（洗い替え）、汎用は選択
  const mode = prof.fixed ? 'replace' : (f.mode ? f.mode.value : 'append');
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

  let updated = 0, created = 0, skipped = 0;
  const touched = [];
  for (const row of _importRows) {
    const tk = row.market === 'US' ? row.ticker.trim().toUpperCase() : row.ticker.trim();
    let sec = store.findSecurity(row.market, tk);
    if (!sec) {
      if (!create) { skipped++; continue; }
      sec = store.addSecurity({ market: row.market, ticker: tk, currency: row.market === 'US' ? 'USD' : 'JPY', assetClass: 'stock', enabled: true, ruleId: store.defaultRule().id });
      created++;
    } else updated++;
    // 汎用: 銘柄属性（前回購入価格・基準高値・ルール・カテゴリ 等）を反映（分析結果は対象外）
    if (row._sec) {
      const p = { ...row._sec };
      if ('ruleName' in p) { const r = store.data.rules.find(x => x.name === p.ruleName); if (r) p.ruleId = r.id; delete p.ruleName; }
      store.updateSecurity(sec.id, p);
    }
    // 数量がある行のみ保有を作成/更新
    if (row.quantity != null) {
      const broker = row.broker || defBroker, account = row.account || '特定';
      const exists = store.data.holdings.some(h => h.securityId === sec.id && h.broker === broker && h.accountType === account);
      if (mode === 'append' && exists) { /* 既存はそのまま（上書きしない） */ }
      else store.setHolding(sec.id, broker, account, row.quantity, row.avgCost ?? 0, 'import');
    }
    touched.push(sec);
  }
  store.save();
  // 取込履歴
  const baseDate = extractBaseDate(_importText);
  store.data.importHistory.unshift({
    id: store.nextId(), profile: _importProfile, label: prof.label,
    broker: scope.broker, markets: scope.markets, mode, count: _importRows.length,
    importedAt: new Date().toISOString(), baseDate: baseDate || null,
  });
  store.save();
  closeModal(); render();
  toast(`取込完了: 更新 ${updated} / 新規 ${created}${removed ? ` / 洗い替え削除 ${removed}` : ''}${skipped ? ` / スキップ ${skipped}` : ''}`);
  if (touched.length) api.refreshMeta(touched).then(render);
}

// 取込フィールド設定（マッピング）の編集UI。列名/位置が変わってもコード変更なしで調整可
const MAPPING_FIELDS = {
  'sbi-jp':  [['ticker', '銘柄コードの列名'], ['quantity', '保有株数の列名'], ['avgCost', '取得単価の列名']],
  'moomoo':  [['ticker', 'コード列名'], ['quantity', '数量列名'], ['avgCost', '平均取得価額列名'], ['account', '口座区分列名'], ['currency', '通貨列名']],
  'rakuten': [['kind', '種別列名'], ['ticker', '銘柄コード列名'], ['quantity', '保有数量列名'], ['avgCost', '平均取得価額列名'], ['account', '口座列名']],
  'sbi-us':  [['qtyPos', '数量は数値の何番目か'], ['avgCostPos', '取得単価は数値の何番目か']],
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
      s.prevBuyPrice ?? '', s.baseHighMode || '', s.baseHighManual ?? '', s.fixedBuyPrice ?? '', ruleName, s.category || '',
      s.buyAmount ?? '', s.buyCount ?? '', s.enabled === false ? '無効' : '有効', s.watch ? '注意' : '通常'];
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

// 銘柄情報マスタ（名前・セクター・ファンダ）を全銘柄ぶん再取得（任意タイミング）
function refreshAllMeta() {
  const secs = store.data.securities.filter(s => s.ticker);
  if (!secs.length) { toast('銘柄がありません'); return; }
  toast('銘柄情報を取得中…');
  api.refreshMeta(secs).then(() => api.checkSplits()).then(() => { render(); toast('銘柄情報を更新しました'); });
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
  const blob = new Blob([JSON.stringify(store.data, null, 2)], { type: 'application/json' });
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
      try { store.data = JSON.parse(r.result); store.save(); store.load(); render(); toast('インポートしました'); }
      catch (_) { toast('JSONの読み込みに失敗しました'); }
    };
    r.readAsText(file);
  };
  inp.click();
}
function resetData() {
  if (confirm('すべてのデータを削除して初期状態に戻します。よろしいですか？')) {
    localStorage.removeItem(STORAGE_KEY); store.data = null; store.load(); render();
  }
}

// ---------- ユーティリティ ----------
function go(view) {
  currentView = view;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  render();
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function num(n) { return n == null ? '—' : Number(n).toLocaleString('ja-JP', { maximumFractionDigits: 2 }); }
function yen(n) { return n == null ? '—' : '¥' + Math.round(n).toLocaleString('ja-JP'); }
function money(n, ccy) { return n == null ? '—' : ccy + Number(n).toLocaleString('ja-JP', { maximumFractionDigits: 2 }); }
// 一覧表示用フォーマッタ（通貨記号なし=SEC-44 / 表示桁=SEC-45）。内部値は変えず表示だけ丸める。
// 株価・金額: 米国株=小数2桁固定 / 日本株=整数。
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
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2500);
}

// 公開（onclick用）
window.go = go;
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
window.api = api;
window.render = render;

// ---------- 起動 ----------
document.querySelectorAll('.tab').forEach(t => t.onclick = () => go(t.dataset.view));
document.getElementById('modal-close').onclick = closeModal;
// モーダル外クリックでは閉じない（意図しない消失を防止）。× か各フォームのボタンのみで閉じる
document.getElementById('btn-refresh').onclick = () => api.refreshAll().then(render);

store.load();
loadColPrefs();
render();
// 1日1回（起動時）だけ銘柄名・セクター・業種・高値を更新
api.dailyStartup();
