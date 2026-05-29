/* 証券管理ツール — MVP (ログインなし / localStorage保存)
 *
 * 構成メモ:
 *  - データは localStorage に保存（将来 Google スプレッドシートへ移行予定）
 *  - 価格・為替は「キャッシュ」扱いで、/api/price (Yahoo中継) から取得 or 手入力
 *  - 買い増し判定: 初回=基準高値-40% / 買い増し=前回購入価格-20%（ルールマスタで変更可）
 *  - 金額はカテゴリ別マスタ（日本株=円 / 米国株=÷100ドル）
 *  - 市場(米国株/日本株/投信)を分離して表示
 */

'use strict';

// ---------- 定数・初期データ ----------
const STORAGE_KEY = 'sm_data_v1';

const DEFAULT_CATEGORIES = [
  { category: '王道・鉄板', label: '文明のインフラ', amountJpy: 80000, sortOrder: 1 },
  { category: '主力・成長', label: '世界的覇権', amountJpy: 60000, sortOrder: 2 },
  { category: '準主力', label: '地域覇者・ニッチ', amountJpy: 50000, sortOrder: 3 },
  { category: '防御・配当', label: '成熟・安定', amountJpy: 40000, sortOrder: 4 },
  { category: '有望な投機', label: '宝くじのエース', amountJpy: 25000, sortOrder: 5 },
  { category: 'お遊び', label: '記念・優待', amountJpy: 15000, sortOrder: 6 },
  { category: '対象外', label: '投資不適格', amountJpy: 0, sortOrder: 7 },
];

const DEFAULT_RULE = {
  id: 1, name: '標準ルール', initialDropPct: 40, addonDropPct: 20, baseHighMode: '5y', isDefault: true,
};

const MARKET_LABEL = { US: '米国株', JP: '日本株', FUND: '投信' };
const BROKERS = ['SBI', '楽天', 'Webull', 'moomoo'];
const ACCOUNTS = ['特定', 'NISA', '一般'];

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
    this.data.rules ||= [DEFAULT_RULE];
    this.data.categories ||= structuredClone(DEFAULT_CATEGORIES);
    this.data.prices ||= {};
    this.data.fx ||= { USDJPY: null };
    this.data.seq ||= 1;
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

  // holdings (security×broker×account)
  upsertHolding(h) {
    const found = this.data.holdings.find(x =>
      x.securityId === h.securityId && x.broker === h.broker && x.accountType === h.accountType);
    if (found) { Object.assign(found, h); }
    else { h.id = this.nextId(); this.data.holdings.push(h); }
    this.save();
  },
  removeHolding(id) { this.data.holdings = this.data.holdings.filter(h => h.id !== id); this.save(); },

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
    } else { // sell: 数量のみ減算、平均取得単価は不変
      h.quantity = Math.max(0, h.quantity - t.quantity);
    }
  },

  rule(id) { return this.data.rules.find(r => r.id === id) || this.data.rules[0]; },
  defaultRule() { return this.data.rules.find(r => r.isDefault) || this.data.rules[0]; },
  categoryAmount(cat) {
    const c = this.data.categories.find(x => x.category === cat);
    return c ? c.amountJpy : 0;
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
    const rule = store.rule(sec.ruleId) || store.defaultRule();
    const mode = sec.baseHighMode || rule.baseHighMode || '5y';
    if (mode === 'manual') return typeof sec.baseHighManual === 'number' ? sec.baseHighManual : null;
    const p = store.data.prices[priceKey(sec)] || {};
    if (mode === '52w') return p.high52w || null;
    return p.high5y || null; // 5y デフォルト
  },

  // 判定結果: { type, base, trigger, price, remainingDropPct, reached, recoAmount, recoCcy }
  evaluate(sec) {
    if (sec.market === 'FUND' || sec.enabled === false) return null;
    const price = this.price(sec);
    if (price == null) return null;
    const rule = store.rule(sec.ruleId) || store.defaultRule();
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
    const amtJpy = store.categoryAmount(sec.category);
    const recoCcy = sec.market === 'US' ? 'USD' : 'JPY';
    const recoAmount = sec.market === 'US' ? amtJpy / 100 : amtJpy;
    return { type, base, trigger, price, remainingDropPct, reached: price <= trigger, recoAmount, recoCcy };
  },

  // 円換算の評価額
  valueJpy(sec) {
    const price = this.price(sec);
    const th = this.totalHolding(sec.id);
    if (price == null) return null;
    const v = price * th.qty;
    if (sec.market === 'US') { const fx = this.fx(); return fx ? v * fx : null; }
    return v; // JP / FUND は円
  },
  costJpy(sec) {
    const th = this.totalHolding(sec.id);
    const c = th.acquiredCost;
    if (sec.market === 'US') { const fx = this.fx(); return fx ? c * fx : null; }
    return c;
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
  let totalVal = 0, totalCost = 0, missing = false;
  const perMarket = {};
  for (const m of markets) perMarket[m] = { val: 0, cost: 0 };

  for (const sec of store.data.securities) {
    const v = calc.valueJpy(sec), c = calc.costJpy(sec);
    if (v == null || c == null) { if (calc.totalHolding(sec.id).qty > 0) missing = true; continue; }
    totalVal += v; totalCost += c;
    perMarket[sec.market].val += v; perMarket[sec.market].cost += c;
  }
  const pnl = totalVal - totalCost;
  const pnlPct = totalCost > 0 ? pnl / totalCost * 100 : 0;
  const sigCount = allSignals().length;

  app.innerHTML = `
    ${missing ? `<div class="notice">一部銘柄の価格または為替が未取得のため、合計に含まれていません。「価格更新」を押すか、各銘柄で価格を手入力してください。</div>` : ''}
    <div class="cards">
      <div class="card"><div class="label">総資産（円換算）</div><div class="value">${yen(totalVal)}</div></div>
      <div class="card"><div class="label">評価損益</div><div class="value ${cls(pnl)}">${yen(pnl)}</div><div class="sub ${cls(pnl)}">${signed(pnlPct)}%</div></div>
      <div class="card"><div class="label">取得原価（円換算）</div><div class="value">${yen(totalCost)}</div></div>
      <div class="card"><div class="label">買い増しサイン</div><div class="value ${sigCount ? 'neg' : ''}">${sigCount} 件</div></div>
    </div>
    <div class="section">
      <div class="section-head"><h2>市場別の内訳</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th class="l">市場</th><th>評価額(円)</th><th>取得原価(円)</th><th>損益(円)</th><th>損益率</th><th>銘柄数</th></tr></thead>
        <tbody>
          ${markets.map(m => {
            const d = perMarket[m];
            const p = d.val - d.cost; const pp = d.cost > 0 ? p / d.cost * 100 : 0;
            const cnt = store.data.securities.filter(s => s.market === m).length;
            return `<tr><td class="l"><span class="tag ${m.toLowerCase()}">${MARKET_LABEL[m]}</span></td>
              <td>${yen(d.val)}</td><td>${yen(d.cost)}</td>
              <td class="${cls(p)}">${yen(p)}</td><td class="${cls(p)}">${signed(pp)}%</td><td>${cnt}</td></tr>`;
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
function renderMarket(market) {
  const secs = store.data.securities.filter(s => s.market === market)
    .sort((a, b) => (a.name || a.ticker).localeCompare(b.name || b.ticker, 'ja'));
  const isStock = market !== 'FUND';

  app.innerHTML = `
    <div class="section">
      <div class="section-head">
        <h2><span class="tag ${market.toLowerCase()}">${MARKET_LABEL[market]}</span> 保有・ウォッチ銘柄</h2>
        <button class="btn btn-primary btn-sm" onclick="openSecurityForm(null, '${market}')">＋ 銘柄を追加</button>
      </div>
      <div class="section-body">
        ${secs.length === 0 ? `<div class="empty">銘柄がありません。「＋ 銘柄を追加」から登録してください。</div>` : `
        <div class="table-wrap"><table>
          <thead><tr>
            <th class="l">銘柄</th><th class="l">カテゴリ</th><th>数量</th><th>取得単価</th>
            <th>現在値</th><th>前日比</th><th>評価額(円)</th><th>損益率</th>
            ${isStock ? '<th>買い増しまで</th><th>推奨額</th>' : ''}
            <th></th>
          </tr></thead>
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
  const valJpy = calc.valueJpy(sec);
  const costJpy = calc.costJpy(sec);
  const pnlPct = (valJpy != null && costJpy) ? (valJpy - costJpy) / costJpy * 100 : null;
  const ev = isStock ? calc.evaluate(sec) : null;
  const ccy = sec.market === 'US' ? '$' : '¥';

  return `<tr>
    <td class="l"><strong>${esc(sec.name || sec.ticker)}</strong><br><span class="muted">${esc(sec.ticker)}</span></td>
    <td class="l">${sec.category ? `<span class="tag">${esc(sec.category)}</span>` : '<span class="muted">—</span>'}</td>
    <td>${th.qty ? num(th.qty) : '<span class="muted">0</span>'}</td>
    <td>${th.qty ? ccy + num(th.avgCost) : '<span class="muted">—</span>'}</td>
    <td>${price != null ? ccy + num(price) : priceInputBtn(sec)}</td>
    <td class="${cls(dayChg)}">${dayChg != null ? signed(dayChg) + '%' : '—'}</td>
    <td>${valJpy != null ? yen(valJpy) : '<span class="muted">—</span>'}</td>
    <td class="${cls(pnlPct)}">${pnlPct != null ? signed(pnlPct) + '%' : '—'}</td>
    ${isStock ? `<td>${dropBadge(ev)}</td><td>${recoText(ev)}</td>` : ''}
    <td class="l">
      <button class="btn btn-sm" onclick="openTxnForm(${sec.id})">取引</button>
      <button class="btn btn-sm" onclick="openSecurityForm(${sec.id})">編集</button>
    </td>
  </tr>`;
}

function dropBadge(ev) {
  if (!ev) return '<span class="muted">—</span>';
  if (ev.reached) return `<span class="drop reached">到達 (${signed(ev.remainingDropPct)}%)</span>`;
  const cls2 = ev.remainingDropPct <= 5 ? 'near' : 'far';
  return `<span class="drop ${cls2}">あと ${ev.remainingDropPct.toFixed(1)}%</span><br><span class="muted">トリガー ${money(ev.trigger, ev.recoCcy === 'USD' ? '$' : '¥')}</span>`;
}
function recoText(ev) {
  if (!ev) return '<span class="muted">—</span>';
  return money(ev.recoAmount, ev.recoCcy === 'USD' ? '$' : '¥');
}
function priceInputBtn(sec) {
  return `<button class="btn btn-sm" onclick="openPriceInput(${sec.id})">価格入力</button>`;
}

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
  const rule = store.defaultRule();
  app.innerHTML = `
    <div class="section">
      <div class="section-head"><h2>カテゴリ別 金額マスタ</h2></div>
      <div class="section-body"><div class="table-wrap"><table>
        <thead><tr><th class="l">カテゴリ</th><th class="l">位置づけ</th><th>日本株(円)</th><th>米国株($, ÷100)</th><th></th></tr></thead>
        <tbody>${cats.map(c => `<tr>
          <td class="l">${esc(c.category)}</td><td class="l muted">${esc(c.label || '')}</td>
          <td>${yen(c.amountJpy)}</td><td>$${num(c.amountJpy / 100)}</td>
          <td class="l"><button class="btn btn-sm" onclick="openCategoryEdit('${esc(c.category)}')">変更</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="muted" style="padding:0 16px 14px">金額は価格に左右されない固定値（ビジネスモデル・財務で決定）。米国株は円額÷100ドル。</p>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>買い増しルール（標準）</h2></div>
      <div class="section-body" style="padding:16px">
        <div class="row" style="display:flex;gap:24px;flex-wrap:wrap">
          <div>初回購入トリガー: <strong>基準高値 −${rule.initialDropPct}%</strong></div>
          <div>買い増しトリガー: <strong>前回購入価格 −${rule.addonDropPct}%</strong></div>
          <div>基準高値: <strong>${rule.baseHighMode === '5y' ? '5年高値' : rule.baseHighMode}</strong></div>
        </div>
        <div class="form-actions" style="justify-content:flex-start"><button class="btn" onclick="openRuleEdit()">ルールを編集</button></div>
      </div>
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
  const catOpts = store.data.categories.sort((a, b) => a.sortOrder - b.sortOrder)
    .map(c => `<option value="${esc(c.category)}" ${sec && sec.category === c.category ? 'selected' : ''}>${esc(c.category)}</option>`).join('');
  showModal(id ? '銘柄を編集' : '銘柄を追加', `
    <form id="sec-form">
      <div class="row">
        <div class="field"><label>市場</label>
          <select name="market">${['US', 'JP', 'FUND'].map(x => `<option value="${x}" ${x === m ? 'selected' : ''}>${MARKET_LABEL[x]}</option>`).join('')}</select></div>
        <div class="field"><label>ティッカー / コード</label><input name="ticker" value="${sec ? esc(sec.ticker) : ''}" placeholder="例: AAPL / 7203" required></div>
      </div>
      <div class="field"><label>銘柄名</label><input name="name" value="${sec ? esc(sec.name || '') : ''}" placeholder="例: Apple"></div>
      <div class="row">
        <div class="field"><label>カテゴリ（金額決定）</label><select name="category"><option value="">未設定</option>${catOpts}</select></div>
        <div class="field"><label>判定対象</label>
          <select name="enabled"><option value="1" ${!sec || sec.enabled !== false ? 'selected' : ''}>有効</option><option value="0" ${sec && sec.enabled === false ? 'selected' : ''}>無効</option></select></div>
      </div>
      <div class="field"><label>前回購入価格（買い取引が無い場合の買い増し基準・任意）</label>
        <input name="prevBuyPrice" type="number" step="any" value="${sec && sec.prevBuyPrice != null ? sec.prevBuyPrice : ''}" placeholder="原通貨"></div>
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
    const patch = {
      market, ticker: f.ticker.value.trim(), name: f.name.value.trim(),
      category: f.category.value || null, enabled: f.enabled.value === '1',
      currency: market === 'US' ? 'USD' : 'JPY',
      assetClass: market === 'FUND' ? 'fund' : 'stock',
      prevBuyPrice: f.prevBuyPrice.value ? parseFloat(f.prevBuyPrice.value) : null,
    };
    if (id) store.updateSecurity(id, patch);
    else store.addSecurity({ ...patch, ruleId: store.defaultRule().id });
    closeModal(); render();
  };
}

function deleteSecurity(id) {
  if (confirm('この銘柄と関連する保有・取引を削除します。よろしいですか？')) {
    store.removeSecurity(id); closeModal(); render();
  }
}

function openTxnForm(secId, presetType) {
  const sec = store.data.securities.find(s => s.id === secId);
  const ccy = sec.market === 'US' ? '$' : '¥';
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
  const ccy = sec.market === 'US' ? '$' : '¥';
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

function openCategoryEdit(category) {
  const c = store.data.categories.find(x => x.category === category);
  showModal(`金額を変更 — ${esc(category)}`, `
    <form id="cat-form">
      <div class="field"><label>日本株の金額（円）</label><input name="amount" type="number" step="1000" value="${c.amountJpy}" required></div>
      <p class="muted">米国株はこの金額 ÷100 ドルで適用されます（例: 60000円 → $600）。</p>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>`);
  document.getElementById('cat-form').onsubmit = (e) => {
    e.preventDefault();
    c.amountJpy = parseFloat(e.target.amount.value);
    store.save(); closeModal(); render();
  };
}

function openRuleEdit() {
  const r = store.defaultRule();
  showModal('買い増しルールを編集', `
    <form id="rule-form">
      <div class="row">
        <div class="field"><label>初回 下落率(%)</label><input name="initial" type="number" step="any" value="${r.initialDropPct}"></div>
        <div class="field"><label>買い増し 下落率(%)</label><input name="addon" type="number" step="any" value="${r.addonDropPct}"></div>
      </div>
      <div class="field"><label>基準高値</label>
        <select name="mode">
          <option value="5y" ${r.baseHighMode === '5y' ? 'selected' : ''}>5年高値</option>
          <option value="52w" ${r.baseHighMode === '52w' ? 'selected' : ''}>52週高値</option>
        </select></div>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">キャンセル</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>`);
  document.getElementById('rule-form').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    r.initialDropPct = parseFloat(f.initial.value);
    r.addonDropPct = parseFloat(f.addon.value);
    r.baseHighMode = f.mode.value;
    store.save(); closeModal(); render();
  };
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
window.deleteSecurity = deleteSecurity;
window.openTxnForm = openTxnForm;
window.openPriceInput = openPriceInput;
window.openCategoryEdit = openCategoryEdit;
window.openRuleEdit = openRuleEdit;
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
