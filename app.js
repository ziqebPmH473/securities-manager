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
const BROKERS = ['SBI', '楽天', 'Webull', 'moomoo'];
const ACCOUNTS = ['特定', 'NISA', '一般'];
// 一覧で左寄せにする列（見出しと本文の寄せを一致させる）
const LEFT_COLS = new Set(['name', 'category', 'rating']);

// 分析メタの取込列マッピング（Excel「銘柄分析結果」のヘッダ名 → 内部キー）
const ANALYSIS_COLMAP = {
  '評価日': 'analysisDate', '銘柄名': 'ticker', 'ティッカー': 'ticker',
  '総合評価': 'overallGrade', '銘柄格付': 'rating', '買い時評価': 'buyGrade',
  '推奨投資額': 'recoAmount', '推奨カテゴリ': 'recoCategory',
  'バリュエーション': 'starValuation', '独自の強み': 'starStrength', 'リスク': 'starRisk',
  '備考': 'analysisNote', '評価時点_購入優先順位': 'priority', '購入優先順位': 'priority',
};
// 保有取込列マッピング（Excel「10_保有株」）
const HOLDING_COLMAP = {
  'ティッカー': 'ticker', '証券会社': 'broker', '口座種別': 'accountType',
  '取得単価': 'avgCost', '数量': 'quantity', '取得価額': 'acquiredCost',
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
      prices: {}, fx: { USDJPY: null }, seq: 1,
    };
  },
  nextId() { return this.data.seq++; },

  // securities
  addSecurity(s) { s.id = this.nextId(); this.data.securities.push(s); this.save(); return s; },
  updateSecurity(id, patch) {
    const s = this.data.securities.find(x => x.id === id);
    if (s) { Object.assign(s, patch); this.save(); }
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
  // 直接編集（取引を介さず数量・平均取得単価を上書き）
  setHolding(securityId, broker, accountType, quantity, avgCost) {
    let h = this.data.holdings.find(x => x.securityId === securityId && x.broker === broker && x.accountType === accountType);
    if (!h) {
      h = { id: this.nextId(), securityId, broker, accountType, quantity: 0, avgCost: 0 };
      this.data.holdings.push(h);
    }
    h.quantity = quantity; h.avgCost = avgCost;
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
};

// ---------- 計算 ----------
const calc = {
  fx() { return store.data.fx.USDJPY || null; },

  // 当該銘柄の現在値（キャッシュ）
  price(sec) {
    const p = store.data.prices[priceKey(sec)];
    return p && typeof p.price === 'number' ? p.price : null;
  },

  // 銘柄の合計保有（全口座合算）
  totalHolding(secId) {
    const hs = store.data.holdings.filter(h => h.securityId === secId);
    let qty = 0, cost = 0;
    for (const h of hs) { qty += h.quantity; cost += h.avgCost * h.quantity; }
    return { qty, avgCost: qty > 0 ? cost / qty : 0, acquiredCost: cost };
  },

  // 直近の買い約定単価（addon基準）。無ければ手動の前回購入価格
  lastBuyPrice(sec) {
    const buys = store.data.transactions
      .filter(t => t.securityId === sec.id && t.type === 'buy')
      .sort((a, b) => (a.tradedAt < b.tradedAt ? 1 : -1));
    if (buys.length) return buys[0].price;
    if (typeof sec.prevBuyPrice === 'number') return sec.prevBuyPrice;
    return null;
  },

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
    const lastBuy = this.lastBuyPrice(sec);

    let type, base, trigger;
    if (th.qty <= 0 && lastBuy == null) {
      type = 'initial';
      base = this.baseHigh(sec);
      if (base == null) return null;
      trigger = base * (1 - rule.initialDropPct / 100);
    } else {
      type = 'addon';
      base = lastBuy != null ? lastBuy : this.baseHigh(sec);
      if (base == null) return null;
      trigger = base * (1 - rule.addonDropPct / 100);
    }
    const remainingDropPct = (price - trigger) / price * 100; // >0: あとこれだけ下落で到達
    const recoCcy = sec.market === 'US' ? 'USD' : 'JPY';
    const recoAmount = this.buyAmount(sec);
    return { type, base, trigger, price, remainingDropPct, reached: price <= trigger, recoAmount, recoCcy };
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
  // 原通貨→円換算（米株は為替、JP/FUNDはそのまま）。為替未取得の米株は null
  toJpy(market, nativeAmt) {
    if (nativeAmt == null) return null;
    if (market === 'US') { const fx = this.fx(); return fx != null ? nativeAmt * fx : null; }
    return nativeAmt;
  },
};

function priceKey(sec) { return `${sec.market}:${sec.ticker}`; }
function yahooSymbol(sec) { return sec.market === 'JP' ? `${sec.ticker}.T` : sec.ticker; }

// ---------- 価格取得 ----------
const api = {
  async refreshAll() {
    const secs = store.data.securities.filter(s => s.ticker);
    const symbols = secs.map(yahooSymbol);
    symbols.push('USDJPY=X');
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
    store.save();
    toast('価格を更新しました');
  },
};

// ---------- ルーター/描画 ----------
const app = document.getElementById('app');
let currentView = 'dashboard';
// 一覧のソート/フィルタ状態（市場ごと）
const listState = {
  US: { sortKey: 'name', sortDir: 1, broker: '', account: '', category: '' },
  JP: { sortKey: 'name', sortDir: 1, broker: '', account: '', category: '' },
  FUND: { sortKey: 'name', sortDir: 1, broker: '', account: '', category: '' },
};

function render() {
  updateHeader();
  updateSignalBadge();
  switch (currentView) {
    case 'dashboard': renderDashboard(); break;
    case 'us': renderMarket('US'); break;
    case 'jp': renderMarket('JP'); break;
    case 'fund': renderMarket('FUND'); break;
    case 'signals': renderSignals(); break;
    case 'master': renderMaster(); break;
  }
}

function updateHeader() {
  const fx = calc.fx();
  document.getElementById('fx-indicator').textContent = `USD/JPY: ${fx ? fx.toFixed(2) : '--'}`;
}

function updateSignalBadge() {
  const n = allSignals().length;
  const b = document.getElementById('signal-badge');
  b.textContent = n; b.hidden = n === 0;
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
  const markets = ['US', 'JP', 'FUND'];
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

  app.innerHTML = `
    ${notes.map(n => `<div class="notice">${esc(n)}</div>`).join('')}
    <div class="cards">
      <div class="card"><div class="label">総資産（円換算${fxMissing ? '・米株除く' : ''}）</div><div class="value">${yen(totalJpy)}</div></div>
      <div class="card"><div class="label">評価損益（円換算）</div><div class="value ${cls(pnl)}">${yen(pnl)}</div><div class="sub ${cls(pnl)}">${signed(pnlPct)}%</div></div>
      <div class="card"><div class="label">取得原価（円換算）</div><div class="value">${yen(costJpy)}</div></div>
      <div class="card"><div class="label">買い増しサイン</div><div class="value ${sigCount ? 'neg' : ''}">${sigCount} 件</div></div>
    </div>
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
      <div class="section-body">${signalsTable(allSignals(), true)}</div>
    </div>`;
}

// ---------- 市場別 一覧 ----------
function sortSecurities(secs, market) {
  const st = listState[market];
  const key = st.sortKey, dir = st.sortDir;
  const val = (sec) => {
    const th = calc.totalHolding(sec.id);
    switch (key) {
      case 'name': return (sec.name || sec.ticker || '').toLowerCase();
      case 'ticker': return (sec.ticker || '').toLowerCase();
      case 'category': return sec.category || '';
      case 'qty': return th.qty;
      case 'avgCost': return th.avgCost;
      case 'cost': return th.acquiredCost;
      case 'buyCount': return calc.buyCount(sec) || 0;
      case 'buyAmount': return calc.buyAmount(sec) ?? -Infinity;
      case 'price': return calc.price(sec) ?? -Infinity;
      case 'value': return calc.valueOrCostNative(sec) ?? -Infinity;
      case 'pnl': return calc.pnlPctNative(sec) ?? -Infinity;
      case 'drop': { const ev = calc.evaluate(sec); return ev ? ev.remainingDropPct : Infinity; }
      case 'rating': return sec.rating || sec.overallGrade || 'zzz';
      case 'priority': return sec.priority ?? Infinity;
      default: return '';
    }
  };
  return [...secs].sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
}

function renderMarket(market) {
  const st = listState[market];
  const isStock = market !== 'FUND';
  let secs = store.data.securities.filter(s => s.market === market);
  // フィルタ（証券会社/口座は保有を持つ銘柄で判定）
  if (st.broker) secs = secs.filter(s => store.data.holdings.some(h => h.securityId === s.id && h.broker === st.broker && h.quantity > 0));
  if (st.account) secs = secs.filter(s => store.data.holdings.some(h => h.securityId === s.id && h.accountType === st.account && h.quantity > 0));
  if (st.category) secs = secs.filter(s => s.category === st.category);
  secs = sortSecurities(secs, market);

  const catOpts = [...store.data.categories].sort((a, b) => a.sortOrder - b.sortOrder)
    .map(c => `<option value="${esc(c.category)}" ${st.category === c.category ? 'selected' : ''}>${esc(c.category)}</option>`).join('');

  const ccy = MARKET_CCY[market];
  // カラム順は移行元スプレッドシート（銘柄リスト）の流れに準拠。評価額(円)は一覧では非表示（内部計算は保持）
  const cols = isStock
    ? [['name', '銘柄'], ['price', '現在値'], ['day', '前日比', true], ['drop', 'あと%'], ['trigger', 'トリガー', true],
       ['value', `評価額(${ccy})`], ['cost', `取得価額(${ccy})`], ['pnl', '損益率'],
       ['avgCost', '取得単価'], ['qty', '数量'], ['buyCount', '購入回数'], ['buyAmount', `1回購入額(${ccy})`],
       ['category', 'AI判断'], ['rating', '銘柄格付']]
    : [['name', '銘柄'], ['price', '現在値'], ['value', '評価額'], ['cost', '取得価額'], ['pnl', '損益率'],
       ['avgCost', '取得単価'], ['qty', '数量'], ['buyCount', '購入回数'], ['buyAmount', '1回購入額'], ['category', 'AI判断']];

  const headHtml = cols.map(([key, label, noSort]) => {
    const leftCls = LEFT_COLS.has(key) ? 'l' : '';
    if (noSort) return `<th class="${leftCls}">${label}</th>`;
    const active = st.sortKey === key;
    const arrow = active ? (st.sortDir === 1 ? ' ▲' : ' ▼') : '';
    return `<th class="sortable ${leftCls} ${active ? 'active' : ''}" onclick="setSort('${market}','${key}')">${label}${arrow}</th>`;
  }).join('');

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
        <span class="muted" style="margin-left:auto">${secs.length} 件</span>
      </div>
      <div class="section-body">
        ${secs.length === 0 ? `<div class="empty">該当する銘柄がありません。</div>` : `
        <div class="table-wrap"><table>
          <thead><tr>${headHtml}<th class="l"></th></tr></thead>
          <tbody>
            ${secs.map(sec => marketRow(sec, isStock)).join('')}
          </tbody>
        </table></div>`}
      </div>
    </div>`;
}

function marketRow(sec, isStock) {
  const th = calc.totalHolding(sec.id);
  const p = store.data.prices[priceKey(sec)] || {};
  const price = p.price ?? null;
  const dayChg = (price != null && p.prevClose) ? (price - p.prevClose) / p.prevClose * 100 : null;
  const valN = calc.valueOrCostNative(sec);
  const pnlPct = calc.pnlPctNative(sec);
  const ev = isStock ? calc.evaluate(sec) : null;
  const ccy = MARKET_CCY[sec.market];
  const priceCell = price != null ? ccy + num(price) : priceInputBtn(sec);
  const noPriceMark = (price == null && th.qty > 0) ? ' <span class="muted" title="価格未取得・取得原価で表示">*</span>' : '';
  const buyAmt = calc.buyAmount(sec);
  const buyCnt = calc.buyCount(sec);
  const recoAmt = store.categoryAmountFor(sec.category, sec.market); // AI判断カテゴリの推奨金額

  const m = (v) => v != null ? money(v, ccy) : '<span class="muted">—</span>';
  const nameCell = `<td class="l"><strong>${esc(sec.name || sec.ticker)}</strong> <span class="muted">${esc(sec.ticker)}</span>${sec.watch ? ' <span class="tag watch">注意</span>' : ''}</td>`;
  const priceTd = `<td>${priceCell}</td>`;
  const dayTd = `<td class="${cls(dayChg)}">${dayChg != null ? signed(dayChg) + '%' : '—'}</td>`;
  // 「あと%」: 到達は強調、それ以外は残り下落率のみ（語は見出しに任せる）
  const remainTd = !ev ? '<td class="muted">—</td>'
    : ev.reached ? '<td class="neg">到達</td>'
    : `<td class="drop ${ev.remainingDropPct <= 5 ? 'near' : 'far'}">${ev.remainingDropPct.toFixed(1)}%</td>`;
  const triggerTd = `<td>${ev ? m(ev.trigger) : '<span class="muted">—</span>'}</td>`;
  const valueTd = `<td>${th.qty ? money(valN, ccy) + noPriceMark : '<span class="muted">—</span>'}</td>`;
  const costTd = `<td>${th.qty ? m(th.acquiredCost) : '<span class="muted">—</span>'}</td>`;
  const pnlTd = `<td class="${cls(pnlPct)}">${pnlPct != null ? signed(pnlPct) + '%' : '—'}</td>`;
  const avgCostTd = `<td>${th.qty ? ccy + num(th.avgCost) : '<span class="muted">—</span>'}</td>`;
  const qtyTd = `<td>${th.qty ? num(th.qty) : '<span class="muted">0</span>'}</td>`;
  const buyCountTd = `<td>${buyCnt ? num(buyCnt) : '<span class="muted">—</span>'}</td>`;
  const buyAmtTd = `<td>${m(buyAmt)}</td>`;
  // AI判断 = カテゴリ + そのカテゴリの推奨金額
  const aiTd = `<td class="l">${sec.category ? `<span class="tag">${esc(sec.category)}</span> <span class="muted">${recoAmt ? money(recoAmt, ccy) : ''}</span>` : '<span class="muted">—</span>'}</td>`;
  const gradeTd = `<td class="l">${gradeBadge(sec)}</td>`;
  const actionsTd = `<td class="l nowrap">
      <button class="btn btn-sm" onclick="openTxnForm(${sec.id})">取引</button>
      <button class="btn btn-sm" onclick="openHoldingsForm(${sec.id})">保有</button>
      <button class="btn btn-sm" onclick="openSecurityForm(${sec.id})">編集</button>
    </td>`;

  // 並び: 銘柄→現在値→前日比→あと%→トリガー→評価額→取得価額→損益率→取得単価→数量→購入回数→1回購入額→AI判断→銘柄格付
  if (isStock) {
    return `<tr>${nameCell}${priceTd}${dayTd}${remainTd}${triggerTd}${valueTd}${costTd}${pnlTd}${avgCostTd}${qtyTd}${buyCountTd}${buyAmtTd}${aiTd}${gradeTd}${actionsTd}</tr>`;
  }
  return `<tr>${nameCell}${priceTd}${valueTd}${costTd}${pnlTd}${avgCostTd}${qtyTd}${buyCountTd}${buyAmtTd}${aiTd}${actionsTd}</tr>`;
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

// ---------- サイン一覧 ----------
function renderSignals() {
  const list = allSignals();
  app.innerHTML = `
    <div class="section">
      <div class="section-head"><h2>買い増しサイン（市場横断）</h2>
        <button class="btn btn-sm" onclick="api.refreshAll().then(render)">価格更新</button></div>
      <div class="section-body">${signalsTable(list, false)}</div>
    </div>`;
}

function signalsTable(list, compact) {
  if (list.length === 0) return `<div class="empty">現在、買い増しサインに到達している銘柄はありません。</div>`;
  list.sort((a, b) => a.ev.remainingDropPct - b.ev.remainingDropPct);
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th class="l">銘柄</th><th class="l">市場</th><th class="l">種別</th>
      <th>現在値</th><th>トリガー</th><th>基準</th><th>推奨買い増し</th>${compact ? '' : '<th></th>'}
    </tr></thead>
    <tbody>${list.map(({ sec, ev }) => {
      const ccy = ev.recoCcy === 'USD' ? '$' : '¥';
      return `<tr>
        <td class="l"><strong>${esc(sec.name || sec.ticker)}</strong> <span class="muted">${esc(sec.ticker)}</span></td>
        <td class="l"><span class="tag ${sec.market.toLowerCase()}">${MARKET_LABEL[sec.market]}</span></td>
        <td class="l">${ev.type === 'initial' ? '初回購入' : '買い増し'}</td>
        <td class="neg">${money(ev.price, ccy)}</td>
        <td>${money(ev.trigger, ccy)}</td>
        <td>${money(ev.base, ccy)}</td>
        <td><strong>${money(ev.recoAmount, ccy)}</strong></td>
        ${compact ? '' : `<td class="l"><button class="btn btn-sm btn-primary" onclick="openTxnForm(${sec.id}, 'buy')">購入を記録</button></td>`}
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
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
        <button class="btn" onclick="openPasteImport('holdings')">保有株を取込</button>
      </div>
      <p class="muted" style="padding:0 16px 14px">Excelの該当シートをヘッダ行ごとコピーして貼り付け→ティッカーで既存銘柄に紐づけ（未登録は新規作成も可）。</p>
    </div>
    <div class="section">
      <div class="section-head"><h2>データ管理</h2></div>
      <div class="section-body" style="padding:16px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn" onclick="exportData()">エクスポート(JSON)</button>
        <button class="btn" onclick="importData()">インポート(JSON)</button>
        <button class="btn btn-danger" onclick="resetData()">全データ削除</button>
      </div>
      <p class="muted" style="padding:0 16px 14px">現在の保存先: このブラウザ(localStorage)。将来 Google スプレッドシートへ移行予定。</p>
    </div>`;
}

// ---------- モーダル/フォーム ----------
function showModal(title, bodyHtml) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
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
          <select name="market">${['US', 'JP', 'FUND'].map(x => `<option value="${x}" ${x === m ? 'selected' : ''}>${MARKET_LABEL[x]}</option>`).join('')}</select></div>
        <div class="field"><label>ティッカー / コード</label><input name="ticker" value="${sec ? esc(sec.ticker) : ''}" placeholder="例: AAPL / 7203" required></div>
      </div>
      <div class="field"><label>銘柄名</label><input name="name" value="${sec ? esc(sec.name || '') : ''}" placeholder="例: Apple"></div>
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

      <details class="form-group" open>
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
        ${id ? `<button type="button" class="btn btn-danger" onclick="deleteSecurity(${id})">削除</button>` : ''}
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
    const patch = {
      market, ticker: f.ticker.value.trim(), name: f.name.value.trim(),
      category: f.category.value || null, ruleId: parseInt(f.ruleId.value, 10),
      enabled: f.enabled.value === '1', watch: f.watch.value === '1',
      currency: market === 'US' ? 'USD' : 'JPY',
      assetClass: market === 'FUND' ? 'fund' : 'stock',
      prevBuyPrice: numOrNull(f.prevBuyPrice.value),
      buyAmount: numOrNull(f.buyAmount.value), buyCount: intOrNull(f.buyCount.value),
      overallGrade: f.overallGrade.value || null, rating: f.rating.value || null, buyGrade: f.buyGrade.value || null,
      starValuation: intOrNull(f.starValuation.value), starStrength: intOrNull(f.starStrength.value), starRisk: intOrNull(f.starRisk.value),
      priority: intOrNull(f.priority.value), analysisDate: f.analysisDate.value || null,
      analysisNote: f.analysisNote.value.trim() || null,
    };
    if (id) {
      store.updateSecurity(id, patch);
    } else {
      const created = store.addSecurity({ ...patch });
      // 初期保有が入力されていれば作成
      const qty = parseFloat(f.initQty.value), cost = parseFloat(f.initCost.value);
      if (!isNaN(qty) && qty !== 0) store.setHolding(created.id, f.broker.value, f.accountType.value, qty, isNaN(cost) ? 0 : cost);
    }
    closeModal(); render();
  };
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
        h.quantity = parseFloat(tr.querySelector('.h-qty').value) || 0;
        h.avgCost = parseFloat(tr.querySelector('.h-cost').value) || 0;
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
        <select name="market">${['US', 'JP', 'FUND'].map(x => `<option value="${x}">${MARKET_LABEL[x]}</option>`).join('')}</select></div>
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
    const patch = {
      overallGrade: rec.overallGrade || sec.overallGrade || null,
      rating: rec.rating || sec.rating || null,
      buyGrade: rec.buyGrade || sec.buyGrade || null,
      starValuation: parseStars(rec.starValuation) ?? sec.starValuation ?? null,
      starStrength: parseStars(rec.starStrength) ?? sec.starStrength ?? null,
      starRisk: parseStars(rec.starRisk) ?? sec.starRisk ?? null,
      analysisNote: rec.analysisNote || sec.analysisNote || null,
      analysisDate: normDate(rec.analysisDate) || sec.analysisDate || null,
      recoCategory: rec.recoCategory || sec.recoCategory || null,
      recoAmount: rec.recoAmount ? parseFloat(rec.recoAmount) : (sec.recoAmount ?? null),
    };
    if (rec.priority) { const p = parseInt(rec.priority, 10); if (!isNaN(p)) patch.priority = p; }
    // カテゴリ未設定なら推奨カテゴリを採用
    if (!sec.category && rec.recoCategory) patch.category = rec.recoCategory;
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
    store.setHolding(sec.id, (rec.broker || 'SBI').trim(), (rec.accountType || '特定').trim(), qty, avgCost);
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
function signed(n) { return n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(2); }
function cls(n) { return n == null ? '' : (n > 0 ? 'pos' : (n < 0 ? 'neg' : '')); }
function today() { return new Date().toISOString().slice(0, 10); }
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2500);
}

// 公開（onclick用）
window.go = go;
window.openSecurityForm = openSecurityForm;
window.fillBuyAmount = fillBuyAmount;
window.maskDate = maskDate;
window.deleteSecurity = deleteSecurity;
window.openHoldingsForm = openHoldingsForm;
window.removeHolding = removeHolding;
window.sellAll = sellAll;
window.openTxnForm = openTxnForm;
window.openPriceInput = openPriceInput;
window.openCategoryEdit = openCategoryEdit;
window.syncUsdAmount = syncUsdAmount;
window.deleteCategory = deleteCategory;
window.openRuleEdit = openRuleEdit;
window.deleteRule = deleteRule;
window.setDefaultRule = setDefaultRule;
window.openPasteImport = openPasteImport;
window.setSort = setSort;
window.setFilter = setFilter;
window.clearFilter = clearFilter;
window.closeModal = closeModal;
window.exportData = exportData;
window.importData = importData;
window.resetData = resetData;
window.api = api;
window.render = render;

// ---------- 起動 ----------
document.querySelectorAll('.tab').forEach(t => t.onclick = () => go(t.dataset.view));
document.getElementById('modal-close').onclick = closeModal;
document.getElementById('modal-overlay').onclick = (e) => { if (e.target.id === 'modal-overlay') closeModal(); };
document.getElementById('btn-refresh').onclick = () => api.refreshAll().then(render);

store.load();
render();
