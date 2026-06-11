# 証券管理ツール 詳細設計書

最終更新: 2026-06-01
ステータス: §0 が現状実装、§1〜13 は**目標アーキテクチャ**（Sheets/Cron/通知/React は未実装＝次フェーズ）
関連: [REQUIREMENTS.md](./REQUIREMENTS.md) / [HANDOFF.md](./HANDOFF.md)

> **注意**: 本書の §1〜13 は当初の目標設計（React/Vite・Cloudflare・Google Sheets・Cron・通知）。
> 実際の実装はこれと一部異なります。**現状の実装は §0 を参照**してください。

---

## 0. 現状実装サマリ（2026-06-01）

- **技術**: バニラ HTML/CSS/JS（**ビルド無し**。React/Vite ではない）＋ Cloudflare Pages Functions。
- **保存**: ブラウザ **localStorage**（キー `sm_data_v1`、列設定は `sm_colprefs_v2`）。Sheets/KV は未実装。
- **デプロイ**: GitHub のブランチ `claude/securities-portfolio-tool-WGIsF`（既定＝本番）への push で **CF Pages 自動デプロイ**。
- **API（Pages Functions）**: `/api/price`（Yahoo価格・**日足で前日比正常化**）、`/api/info`（日本語名・セクター/業種・EPS/発行済株式数）、`/api/splits`（分割）、`/api/history`（終値時系列・チャート用）。Finnhub は `FINNHUB_API_KEY` 設定時のみ米株に使用。
- **データモデル（store）**: `securities / holdings / transactions / rules / categories / prices / fx / meta / indices / amountHistory / amountSnapshots / importHistory / importMappings`。
  - `securities` は分析メタ＋ `nameOverride/sectorOverride/industryOverride`（手動上書き、自動取得で潰れない）、`fixedBuyPrice`（買増固定値）、`prevBuyPrice`、`baseHighMode/baseHighManual`、`watch`（注意＝未保有でも一覧に残す）、`enabled`（判定対象）、`splitHistory[]`、`manualUpdatedAt`。
  - `meta`（`market:ticker`キー）= 名前/セクター/業種/PER/EPS/配当/時価総額/sharesOut の自動取得キャッシュ。
  - `prices`（`market:ticker`キー）= price/prevClose/high5y/high52w。`indices` = 参考指数 price/prevClose。
- **市場**: 日本株(JP)/米国株(US)のみ。**投信(FUND)は除外**（2026-05-30判断。後方互換で定義は残るがUI選択不可）。
- **一覧の表示条件**: 「保有あり(数量>0) または 注意銘柄」のみ。売却済み・非注意は銘柄マスタタブで管理。
- **タブ**: ダッシュボード/米国株/日本株/サイン/分割/レポート/銘柄マスタ/マスタ・設定。
- **未実装（§1〜13の目標のうち）**: Googleログイン、Sheets保存、Cron、KV、定時通知(LINE/Resend)、資産推移グラフ、サイン履歴の永続化。→ 次フェーズ（HANDOFF §4）。

---

## 1. システム構成

```
        ┌─────────────────────────────────────────────┐
        │            Cloudflare                        │
        │                                              │
  ┌───┐ │  ┌──────────────┐    ┌──────────────────┐   │
  │PC │─┼─▶│ Pages (SPA)  │    │ Pages Functions  │   │
  └───┘ │  │ React/Vite   │───▶│  /api/*  (REST)  │   │
  ┌───┐ │  └──────────────┘    └────────┬─────────┘   │
  │スマホ│─┘                              │             │
  └───┘    ┌──────────────────┐          ▼             │
           │ Cron Trigger      │   ┌──────────────┐    │
           │ (Scheduled Worker)│──▶│ Sheets + KV  │    │
           │ 価格取得/判定/通知 │   └──────────────┘    │
           └─────┬──────┬──────┘                       │
                 │      │      └────────────────────────┘
                 ▼      ▼              ▼          ▼
            ┌────────┐┌────────┐ ┌────────┐ ┌────────┐
            │Finnhub ││Yahoo Fin│ │LINE API│ │Resend  │
            │(米株RT) ││(日株/為替)│ │(push)  │ │(mail)  │
            └────────┘└────────┘ └────────┘ └────────┘
```

> **構成図の D1 ボックスは「Google スプレッドシート（Sheets API）」に置き換え**、
> さらに価格キャッシュ用の **Cloudflare KV** を併設する（下記参照）。

- **Pages (SPA)**: フロントエンド。レスポンシブ。`/api` を叩く
- **Pages Functions**: REST API。**Google Sheets への読み書きを集約（唯一の書き手）**、
  KV価格キャッシュ参照、オンデマンド価格取得のプロキシ
- **Scheduled Worker (Cron)**: 価格取得→**KVキャッシュ更新**→買い増し判定→サイン記録→定時通知
- **保管先 = Google スプレッドシート**: 資産データの原本（銘柄・保有・取引・ルール・金額マスタ・
  サイン・資産推移・設定）。自分のGoogleドライブに常に残り、ホスト非依存
- **KV（価格キャッシュ）**: 現在値・前日終値・為替など頻繁更新の一時データ。**Sheetsには書かない**
- **認証**: Google OAuth（許可アカウントのみ）
- **外部API**: Finnhub（米株/ETF）/ Yahoo（日株・為替）/ LINE / Resend

> 設計の要点: **頻繁更新（価格）は KV、永続資産データは Sheets** に切り分け、Sheets APIの
> レート制限を回避。無料・データ所有・ホスト非依存を満たす。Sheets書込はバックエンドに一本化し
> read-modify-write で扱う（単一ユーザー前提）。
> Pages と Cron Worker は機能分担。価格取得・判定ロジックは共通モジュール化して両者から呼ぶ。

---

## 2. データモデル（Google スプレッドシートのタブ構成）

**保管先は Google スプレッドシート**。1枚のスプレッドシートに、下記の各テーブルを
**タブ（シート）として 1:1 で対応**させる。各タブの 1 行目をヘッダ（列名）とし、
`id` は連番、関連は `*_id` 列で参照する（RDB的な使い方）。

> 価格・為替（`prices`/`fx`）は **Sheetsに置かず Cloudflare KV に保持**（頻繁更新の一時データ）。
> 5年高値など日次更新の参照値は `securities` タブに持つ（書込頻度が低く制限に当たらない）。

**タブ一覧**: `securities` / `fundamentals` / `holdings` / `transactions` /
`category_amount_master` / `amount_master_history` / `security_amount_snapshot` /
`rule_master` / `signals` / `portfolio_snapshots` / `settings`

### 2.1 関連（リレーション）
- `securities` 1 ─ N `transactions` / `holdings` / `signals` / `security_amount_snapshot`
- `securities` N ─ 1 `rule_master`（適用ルール） / `category_amount_master`（カテゴリ）
- `category_amount_master` 1 ─ N `amount_master_history`（金額の版管理）
- `holdings` は `securities`×`broker`×`account_type` 単位

### 2.2 各タブの列定義
下記は **論理スキーマ**（列＝Sheetsのカラム）。型は参考（Sheetsは値ベース）。
SQLライクに記すが、実体は各タブの列。

```sql
-- 銘柄マスタ（市場・分類・ファンダ・戦略メタ。保有有無に関わらず管理＝ウォッチ含む）
CREATE TABLE securities (
  id            INTEGER PRIMARY KEY,
  market        TEXT NOT NULL CHECK (market IN ('JP','US','FUND')), -- 日本株/米国株/投信
  ticker        TEXT,                     -- JP:"7203", US:"AAPL"。投信はNULL可
  fund_code     TEXT,                     -- 日本投信のファンドコード/ISIN（market=FUND時）
  name          TEXT NOT NULL,
  currency      TEXT NOT NULL,            -- 'JPY' | 'USD'
  asset_class   TEXT NOT NULL DEFAULT 'stock', -- 'stock'|'etf'|'fund'
  is_etf        INTEGER NOT NULL DEFAULT 0,
  -- 分類
  sector        TEXT,
  industry      TEXT,
  market_cap    REAL,                     -- 時価総額（参考表示・分類用）
  -- 戦略メタ（分析シート相当）
  overall_grade TEXT,                     -- 総合評価 S/A/B/C/D
  rating        TEXT,                     -- 銘柄格付 S/A/B/C/D
  buy_grade     TEXT,                     -- 買い時評価
  category      TEXT,                     -- 金額カテゴリ（王道・鉄板/主力・成長/準主力/防御・配当/有望な投機/お遊び/対象外）
  star_valuation INTEGER, star_strength INTEGER, star_risk INTEGER, -- ★評価
  priority      INTEGER,                  -- 購入優先順位
  note          TEXT,                     -- 備考
  watch         INTEGER NOT NULL DEFAULT 0, -- 注意銘柄(ウォッチ)フラグ
  -- 買い増し設定
  rule_id       INTEGER REFERENCES rule_master(id),
  base_high_mode TEXT DEFAULT NULL,       -- 個別上書き(任意): '5y'|'52w'|'all'|'manual'
  base_high_manual REAL DEFAULT NULL,
  prev_buy_price REAL DEFAULT NULL,       -- 「前回購入価格」手動入力値（買い取引が無い場合のaddon基準）
  high_5y       REAL,                     -- 5年高値（日次更新, 基準高値の算出用）
  high_52w      REAL,
  high_all      REAL,
  high_updated_at TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1, -- 買い増し判定対象か（投信は通常0）
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(market, ticker, fund_code)
);

-- ファンダメンタル（セクター一覧シート相当。別ソース取得・日次更新）
CREATE TABLE fundamentals (
  security_id   INTEGER PRIMARY KEY REFERENCES securities(id),
  per           REAL,   -- 株価収益率
  eps           REAL,   -- 1株当たり利益
  dividend      REAL,   -- 1株配当
  revenue       REAL,   -- 売上高
  shares_out    REAL,   -- 発行済株式数
  current_ratio REAL,
  fetched_at    TEXT
);

-- 保有（銘柄×証券会社×口座種別の単位で保有）
CREATE TABLE holdings (
  id            INTEGER PRIMARY KEY,
  security_id   INTEGER NOT NULL REFERENCES securities(id),
  broker        TEXT NOT NULL,            -- 'SBI'|'楽天'|'Webull'|'moomoo'
  account_type  TEXT NOT NULL,            -- '特定'|'NISA'|'一般' など
  quantity      REAL NOT NULL DEFAULT 0,  -- 保有数量（端株=小数対応）
  avg_cost      REAL NOT NULL DEFAULT 0,  -- 平均取得単価（原通貨）
  acquired_cost REAL NOT NULL DEFAULT 0,  -- 取得価額（原通貨）
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(security_id, broker, account_type)
);

-- 取引履歴（買い/売り）。判定は銘柄(security)単位のため security_id を保持
CREATE TABLE transactions (
  id          INTEGER PRIMARY KEY,
  security_id INTEGER NOT NULL REFERENCES securities(id),
  broker      TEXT,                       -- 約定した証券会社
  account_type TEXT,                      -- 特定/NISA
  type        TEXT NOT NULL CHECK (type IN ('buy','sell')),
  price       REAL NOT NULL,              -- 約定単価（原通貨）
  quantity    REAL NOT NULL,
  amount      REAL NOT NULL,              -- 約定金額（原通貨）= price*quantity
  fx_rate     REAL,                       -- 約定時USDJPY（米株のみ）
  traded_at   TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual', -- 'manual'|'csv'
  note        TEXT
);

-- 買い増しルール マスタ（テンプレート）
CREATE TABLE rule_master (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,          -- 例: "標準ルール"
  initial_drop_pct REAL NOT NULL DEFAULT 40,  -- 初回: 基準高値からの下落%
  addon_drop_pct  REAL NOT NULL DEFAULT 20,   -- 買い増し: 前回購入からの下落%
  base_high_mode  TEXT NOT NULL DEFAULT '5y', -- '5y'|'52w'|'all'|'manual'
  rearm           INTEGER NOT NULL DEFAULT 1, -- 価格が戻って再割込み時に再通知するか
  is_default      INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL
);

-- カテゴリ別 金額マスタ（1回あたり推奨エントリー額＝買い増し額）
-- amount_jpy は日本株の金額（円）。米国株は amount_jpy / 100 をドルとして解決
CREATE TABLE category_amount_master (
  category    TEXT PRIMARY KEY,          -- '王道・鉄板'|'主力・成長'|'準主力'|'防御・配当'|'有望な投機'|'お遊び'|'対象外'
  label       TEXT,                      -- 位置づけ（文明のインフラ 等）
  amount_jpy  REAL NOT NULL,             -- 日本株の金額（円）例: 80000,60000,50000,40000,25000,15000,0
  sort_order  INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);
-- 解決ルール: JP → amount_jpy(円) / US → amount_jpy / 100 (ドル)
-- 初期値: 王道80000/主力60000/準主力50000/防御40000/投機25000/お遊び15000/対象外0

-- 金額マスタの版管理（一括変更の履歴。「旧」値の保持）
CREATE TABLE amount_master_history (
  id            INTEGER PRIMARY KEY,
  category      TEXT NOT NULL,
  amount_jpy    REAL NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to   TEXT,                   -- NULL=現行
  reason        TEXT
);

-- 銘柄ごとの「適用された金額」スナップショット履歴
-- （マスタ変更前 or カテゴリ変更前の金額を銘柄単位で後から参照できるように保持）
CREATE TABLE security_amount_snapshot (
  id          INTEGER PRIMARY KEY,
  security_id INTEGER NOT NULL REFERENCES securities(id),
  category    TEXT NOT NULL,
  amount_jpy  REAL NOT NULL,             -- その時点で銘柄に適用されていた金額（円基準）
  recorded_at TEXT NOT NULL,
  trigger     TEXT NOT NULL              -- 'category_change'|'master_change'
);

-- 価格・為替は Sheets タブにしない。Cloudflare KV に保持（§2.3 参照）:
--   price:{market}:{ticker} = { price, prev_close, fetched_at, source }
--   fx:USDJPY               = { rate, fetched_at }
-- ※ 5年/52週/上場来高値（基準高値の算出用）は日次更新のため securities タブの
--    high_5y / high_52w / high_all 列に保持する。

-- 買い増しサイン状態（銘柄単位）
CREATE TABLE signals (
  id            INTEGER PRIMARY KEY,
  security_id   INTEGER NOT NULL REFERENCES securities(id),
  type          TEXT NOT NULL CHECK (type IN ('initial','addon')),
  base_value    REAL NOT NULL,           -- 基準高値 or 前回購入価格
  trigger_price REAL NOT NULL,           -- 発火閾値
  current_price REAL NOT NULL,           -- 発火時点の現在値
  reco_amount   REAL,                    -- 推奨買い増し額（カテゴリ由来。US=ドル/JP=円）
  reco_currency TEXT,                    -- 'JPY'|'USD'
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|notified|snoozed|done|expired
  fired_at      TEXT NOT NULL,
  notified_at   TEXT,
  snooze_until  TEXT,
  resolved_at   TEXT
);

-- 資産推移スナップショット（レポート/グラフ用）
CREATE TABLE portfolio_snapshots (
  id           INTEGER PRIMARY KEY,
  taken_at     TEXT NOT NULL,
  total_jpy    REAL NOT NULL,            -- 総資産（円換算）
  cost_jpy     REAL NOT NULL,            -- 取得原価（円換算）
  pnl_jpy      REAL NOT NULL,            -- 評価損益（円）
  fx_rate      REAL
);

-- アプリ設定（機密はSecretsで管理、ここは非機密の運用設定）
CREATE TABLE settings (
  key          TEXT PRIMARY KEY,         -- 'notify_line'|'notify_email'|'quiet_hours'...
  value        TEXT
);
```

> 機密情報（Finnhub APIキー、LINEトークン、Resend APIキー、**Google Sheets アクセス用の
> サービスアカウント鍵/OAuthトークン**）は Sheets ではなく Cloudflare の **環境変数 / Secrets** に保存する。

### 2.3 価格キャッシュ（KV。Sheets外）
- `price:{market}:{ticker}` → `{ price, prev_close, fetched_at }`
- `fx:USDJPY` → `{ rate, fetched_at }`
- KV は頻繁更新の一時データ専用。喪失しても次回ポーリングで再取得でき、資産データには影響しない。

### 2.4 Google Sheets アクセス方式
- バックエンド（Pages Functions / Cron Worker）が **サービスアカウント or OAuth** で
  Sheets API を呼ぶ。**書き込みはバックエンドに一本化**（唯一の書き手）。
- 読み取りは `spreadsheets.values.batchGet`、書き込みは `batchUpdate` でまとめて実行。
- 並行制御: 単一ユーザー前提のため read-modify-write で十分。`updated_at` で楽観的整合性を担保。
- レート目安: Sheets API は 60 req/min/user・300 req/min/project。価格はKVに退避するため、
  Sheets呼び出しはユーザー操作時と定時のみ＝**制限に到達しない**。

---

## 2.5 株式分割・併合の反映（2026-05-30 追加）

**比率** `r = 分割後株数 / 分割前株数`（1:5分割→r=5、5:1併合→r=0.2）。取得元は `/api/splits`（Yahoo chart の `events.splits`、`r = numerator/denominator`）。実施前（予告）の分割は無料では安定取得できないため**実施日以降のみ**検知する。

**検知と承認**（日次・起動時 `dailyStartup`）:
- 各銘柄の `splitHistory:[{date, ratio, label, status}]` に無い分割を `/api/splits` から検出
- **過去（today より前）** の新規分割 → `status:'recorded'`（記録のみ・調整しない＝既に反映済みとみなす）
- **当日以降** → `status:'pending'` で承認待ち。承認モーダルで個別/一括承認（取込日時と分割日を表示し、二重調整を目視回避）
- 承認 → `applySplit` 実行 → `status:'applied'`。スキップ → `status:'skipped'`

**`applySplit(secId, date, r)` が調整する対象**（手入力項目・保有・取引のみ。mode='full'は保有も）:
- 保有(mode='full'): `quantity ×= r` / `avgCost /= r`（取得価額は不変）
- 手動の `prevBuyPrice /= r`、`baseHighManual /= r`、**`fixedBuyPrice /= r`（買増固定値）**
- 分割日より前の取引: `price /= r` / `quantity ×= r`

**調整しないもの**（自動取得で自己補正・または金額/算出値で不変）:
- **価格キャッシュ（現在値・前日終値・52週/5年高値）は削除も調整もしない**（SEC-48）。
  YahooはEx-date以降は分割調整済みの値を返すため。※当初は delete していたが「自動取得データが消える」ため廃止。
- EPS・発行済株式数・1株配当（Yahoo が分割反映済み）／ PER・時価総額・配当利回り（常に算出）
- 1回購入額（金額）・取得価額（数量×単価で不変）

**推奨処理（recommendSplitMode）**: 保有が分割前なら「全部」、保有は分割後でも手入力項目(前回購入・手動高値・買増固定値)が**手入力日 < 分割日**なら「手入力のみ」、何も無ければ「スキップ」。一括調整モーダルに推奨列＋現→後プレビュー（取得単価/前回購入/買増固定値）。

---

## 3. 買い増し判定ロジック

### 3.1 基準高値の決定（base high）
銘柄の `base_high_mode`（個別上書き）→ 適用ルールの `base_high_mode` の順で解決：
- `5y`  → `securities.high_5y`
- `52w` → `securities.high_52w`
- `all` → `securities.high_all`
- `manual` → `holdings.base_high_manual`

### 3.2 判定アルゴリズム（擬似コード）
```
for each enabled holding h:
    price = kv_price(s.market, s.ticker)   # KVキャッシュから現在値
    if price is null: continue
    rule = resolve_rule(h)
    if h.quantity == 0 or no buy transactions:
        # 初回購入トリガー
        base = base_high(h)                      # 例: 5年高値
        trigger = base * (1 - rule.initial_drop_pct/100)   # 例 ×0.60
        type = 'initial'
    else:
        # 買い増しトリガー
        last_buy = latest buy transaction price of h
        last_buy_date = latest buy transaction date of h   # tradedAt(YYYY-MM-DD)
        type = 'addon'
        # 高値更新オプション（rule.high_reset_mode）: 「前回購入より後に最高値を更新した」場合は初回ルールで判定。
        # 判定は時間軸（最高値の付いた日 > 前回購入日）。値の大小ではなく日付で比較する。
        #   ※旧実装は base_high > last_buy の値比較で、暴落後に買った銘柄が常に高値更新扱いになる誤判定があった。
        #   高値の日付(high_5y_date 等)・前回購入日(取引履歴)が両方そろう時のみ発動。片方でも無ければ通常addon。
        if rule.high_reset_mode and last_buy_date and base_high_date(h) and base_high_date(h) > last_buy_date:
            base = base_high(h)
            trigger = base * (1 - rule.initial_drop_pct/100)   # 高値から初回下落率
        else:
            base = last_buy
            trigger = base * (1 - rule.addon_drop_pct/100)      # 例 ×0.80

    if price <= trigger:
        amt_jpy = category_amount_jpy(s.category)     # カテゴリ→金額（円）
        # US=ドル(÷100) / JP=円
        reco = amt_jpy / 100 if s.market=='US' else amt_jpy
        reco_ccy = 'USD' if s.market=='US' else 'JPY'
        upsert_signal(s, type, base, trigger, price, reco, reco_ccy)
    else:
        # 価格が戻った場合、rearm=1 なら既存pending/notifiedを解除して再武装
        maybe_rearm(s, rule)
```

> 判定対象は `securities.enabled=1` かつ `market in ('JP','US')` の個別株/ETF のみ。
> 投信（market='FUND'）は資産表示には含めるが判定対象外（要件どおり）。
> 「前回購入価格」は銘柄(security)単位で全口座の買い取引を横断して直近のものを採用。

### 3.3 「あと何%で買い増し」表示用の計算
一覧・サイン画面で表示する **トリガーまでの残り下落率**：
```
remaining_drop_pct = (price - trigger_price) / price * 100   # >0: あとこれだけ下落で到達
distance = price / trigger_price - 1                          # 参考値
```
- `remaining_drop_pct <= 0` の銘柄は「到達済み（買いサイン）」として強調表示

### 3.4 重複通知の防止と再武装（rearm）
- サイン発火 → `status = pending` で作成。通知後 `notified`。
- 同一トリガーが続く間は再通知しない。
- ユーザー操作:
  - **買いを記録** → buy transaction を追加 → **数量加算＋平均取得単価を加重平均で更新**、
    前回購入価格も更新 → 既存サインを `done` にし、次回判定で新しい基準で再計算。
  - **売りを記録** → sell transaction を追加 → **数量のみ減算。平均取得単価は不変**、
    前回購入価格にも影響しない（addonトリガーの基準は直近の buy のまま）。
  - **スヌーズ** → `status = snoozed`, `snooze_until` 設定（例: 当日24時）。
- 初期保有は transaction を介さず holdings に直接登録可。買い取引が無い銘柄の addon 基準は
  `securities.base_high_manual` ではなく別途「前回購入価格」手動入力値を用いる。
- `rearm = 1` の場合、価格が `trigger_price` を上回って戻った後に再度割り込むと、
  既存サインを `expired` にして新規発火（再通知）。`rearm = 0` なら据え置き。

---

## 3.5 取込時のマスタ値変換（importAliases）
マスタ管理項目を取り込む時、取込値がマスタの正規値と一致しないと金額参照などが静かに失敗する。これを防ぐ仕組み。

- **対象ドメイン**（`IMPORT_DOMAINS`）: `category`（カテゴリ別金額マスタ。fields=category）/ `grade`（S〜D固定。fields=overallGrade, rating, buyGrade）/ `detailType`（個別株/ETF固定）/ `rule`（ルールマスタ。fields=ruleName）。基準高値モードは別途 `normBaseHighMode` で正規化済みのため対象外。
- 備考: 旧「推奨カテゴリ(recoCategory)」フィールドは廃止し、カテゴリ(category)に一本化（買い増し金額の正）。分析シートの「カテゴリ」列・汎用取込の双方から `category` に取り込む。
- **照合**: `normKey`（NFKC＋trim）で表記ゆれを吸収して比較。一致すればマスタ正規値に置換。
- **未登録値**: 取込実行時に収集し、**変換モーダル**（`openImportConvertModal`）で「①既存マスタ値に変換／②新規マスタ追加（category のみ）／③スキップ」を選択。`[取り込まない（中止）]` で取込全体を中止（1件も書き込まない＝確認後にまとめて反映する設計）。
- **記憶**: 選んだ対応は `store.data.importAliases[domain][normKey(raw)] = 正規値 | '__skip__'` に保存し、次回以降は確認なしで自動変換。「マスタ・設定 > 取込変換マスタ」（`openImportAliasMaster`）で閲覧・削除可。
- **適用経路**: 汎用取込（`runGenericImport` / `runBrokerImport` の `row._sec`）と 分析結果取込（`importAnalysis`）。固定形式・保有取込は保有データのみのため対象外。
- 実装核: `resolveMaster(domain,raw)` / `convMaster(field,raw)` / `ensureMasterConversions(pairs)`。

---

## 4. 金額マスタの版管理（重要）

買い増し金額は **カテゴリ別金額マスタ1本**（王道80k/主力60k/準主力50k/防御40k/投機25k/
お遊び15k/対象外0、円。米国株は÷100ドル）。価格非依存の固定値。
要件「マスタで一括変更」かつ「変更前の金額を銘柄ごとに保持」を満たす（固定値シートの「旧」列に相当）。

### 4.1 データの持ち方
1. `category_amount_master.amount_jpy` … 各カテゴリの**現行金額**（既定表示・新規判定で使用）
2. `amount_master_history` … マスタ金額の**版管理**（category, effective_from/to）
3. `security_amount_snapshot` … **銘柄ごと**に、その時点で適用されていた金額のスナップショット

### 4.2 一括変更の処理フロー
```
PATCH /api/masters/category/{category}  { amount_jpy: newAmount }
  1) amount_master_history: 現行行(category)の effective_to = now（締め）
  2) amount_master_history: 新行を effective_from=now, amount_jpy=newAmount で追加
  3) 当該カテゴリの全 security に対し、変更"前"の金額を
     security_amount_snapshot に trigger='master_change' で記録
  4) category_amount_master.amount_jpy = newAmount に更新
```
→ 「現在の金額は一括変更」しつつ、各銘柄の **過去に適用されていた金額** を
  `security_amount_snapshot` から時系列で参照できる。

### 4.3 銘柄のカテゴリ変更時
- 変更前の（旧カテゴリの現行）金額を `security_amount_snapshot`
  （trigger='category_change'）に記録してから変更。

### 4.4 カテゴリ割当のガイドライン（鉄の掟）
- アプリは「銘柄に割り当てられたカテゴリ」と金額を保持する（カテゴリ判定は分析側の判断）。
- 掟: ①価格非依存の固定値 ②80kは安易に付けず迷えば60k ③一国限定/低シェアは最大50k
  ④キャピタルゲイン見込み薄（横ばい/低ROE）は強制的に40k以下。

---

## 5. API 仕様（REST / Pages Functions）

ベースパス `/api`。認証必須（§8）。レスポンスはJSON。

| メソッド | パス | 概要 |
|---------|------|------|
| GET | `/portfolio/summary?market=US\|JP\|FUND\|all` | 総資産・損益・前日比・サイン件数・内訳。**市場フィルタ対応** |
| GET | `/holdings?market=&broker=&account=&category=` | 保有一覧（現在値・損益・**残り下落率（通知単価まで）**・サイン状態）。市場/証券会社/口座/カテゴリで絞込 |
| GET/POST | `/securities` | 銘柄マスタ（分類・戦略メタ・ファンダ・ウォッチ）参照/追加 |
| GET/PATCH/DELETE | `/securities/{id}` | 銘柄詳細・編集（カテゴリ・ルール・基準高値上書き等）・削除 |
| POST | `/securities/{id}/holdings` | 保有（証券会社×口座）の追加/更新 |
| POST | `/securities/{id}/transactions` | 購入/売却の記録 |
| GET | `/securities/{id}/amount-history` | 銘柄ごとの適用金額スナップショット履歴 |
| GET | `/signals?market=` | サイン一覧（残り下落率・カテゴリ推奨額）。市場フィルタ |
| POST | `/signals/{id}/buy` | サインから購入記録（→ done） |
| POST | `/signals/{id}/snooze` | スヌーズ |
| GET | `/rules` / POST/PATCH/DELETE | ルールマスタ管理 |
| GET `/masters/category` / PATCH `/masters/category/{c}` | カテゴリ別金額マスタ（一括変更は §4.2） |
| GET | `/masters/category/history` | 金額マスタの変更履歴 |
| POST | `/import/preview` | CSVアップロード→列マッピング→プレビュー |
| POST | `/import/commit` | プレビュー確定→取込 |
| GET | `/reports/portfolio-history` | 資産推移（portfolio_snapshots） |
| GET | `/prices/refresh` | オンデマンド価格更新（画面表示時） |
| GET/PUT | `/settings` | 通知先・通知時間帯等 |

---

## 6. 株価データソース仕様

### 6.1 米国株・米国上場ETF（Finnhub・ほぼリアルタイム）
- Quote: `GET https://finnhub.io/api/v1/quote?symbol=AAPL&token=KEY`
  - `c`=現在値, `pc`=前日終値, `h/l/o` 当日高安始
- ETF（QLD/SOXL/EDV/VNM 等）も同じティッカーで取得可
- 5年/52週高値: candle/metric エンドポイント、または日足を集計して `high_5y/high_52w` を更新
- レート制限: 無料60回/分。保有米株数に応じバッチ化し、Cronは1分間隔
- 補足: ファンダ（PER/EPS/配当）は Finnhub の metric 等で取得し `fundamentals` を更新（日次）

### 6.2 日本株（Yahoo Finance系・15〜20分遅延）
- Quote: `query1.finance.yahoo.com/v8/finance/chart/7203.T`（現在値・前日終値）
- 5年高値: `range=5y&interval=1d` の日足から max(high) を算出
- Cronは15分間隔

### 6.3 日本の投資信託（非ETF・基準価額／日次）
- ティッカー無し。`fund_code`（協会コード/ISIN）で識別
- 基準価額は1日1回更新。取得元候補: 投信協会の公表データ、Yahoo!ファイナンス日本版の
  ファンドページ等。安定した無料APIが無い場合は **当面手入力**でも可
- 資産表示・合計には反映するが **買い増し判定の対象外**

### 6.4 為替
- `USDJPY=X` を Yahoo から取得、KV `fx:USDJPY` を更新

---

## 7. 定期実行（Cron Trigger）設計

| ジョブ | 頻度 | 処理 |
|--------|------|------|
| 米株価格更新＋判定 | 米国市場オープン中 毎1分 | Finnhubで保有米株を更新→§3判定→**サイン記録**（送信はしない） |
| 日本株価格更新＋判定 | 東証オープン中 毎15分 | Yahooで保有日本株を更新→§3判定→**サイン記録** |
| **日本株 通知送信** | **7:45 / 11:00 / 17:00 (JST)** | 未通知の日本株サインをまとめてLINE/メール送信 |
| **米国株 通知送信** | **24:00 / 7:00 (JST)** | 未通知の米国株サインをまとめてLINE/メール送信 |
| 投信基準価額更新 | 1日1回 | 日本投信の基準価額を取得（or 手入力反映）。判定はしない |
| ファンダ更新 | 1日1回 | PER/EPS/配当等 fundamentals を更新 |
| 高値リフレッシュ | 1日1回 | high_5y/52w/all を再計算 |
| 資産スナップショット | 1日1回（市場クローズ後） | portfolio_snapshots へ記録（市場別内訳も） |
| 為替更新 | 毎15分 | USDJPY更新 |

> **判定と通知の分離**: 価格更新ジョブはサインを `pending` で記録するだけ。
> 通知送信ジョブが定時に起動し、`status='pending'`（当該市場）をまとめて配信して `notified` に更新。
> これにより市場ごとの定時通知（日本株3回/米国株2回）を実現する。

- 取引時間判定はJST/EST（夏時間考慮）で実装。
- 価格更新ジョブはサイン記録のみ。通知は上記の定時送信ジョブが担当（判定と通知を分離）。

---

## 8. 通知設計

### 8.1 LINE（Messaging API push）
- `POST https://api.line.me/v2/bot/message/push`（Bearer: チャネルアクセストークン）
- メッセージ例:
  ```
  【買い増しサイン】トヨタ(7203) 初回
  現在値 2,450円 ≦ トリガー 2,460円（5年高値4,100円 −40%）
  カテゴリ: 主力・成長 → 推奨買い増し 60,000円
  （米国株なら ÷100 で $600 と表示）
  ```

### 8.2 メール（Resend）
- `POST https://api.resend.com/emails`（Bearer: APIキー）
- **既存のResendアカウントを利用可**。本アプリ用のAPIキーを別発行し、送信元アドレスを分ける。
- 同等内容をHTMLメールで送信。複数サインは定時にまとめて1通に集約。

### 8.3 配信制御（定時バッチ）
- **送信は市場ごとの定時のみ**（JST）: 日本株 7:45/11:00/17:00、米国株 24:00/7:00。
- 各定時に `status='pending'` の当該市場サインを集約配信し `notified` に更新。
- 同一サインは1回のみ通知（§3.4）。`notified_at` で管理。失敗時はリトライ（指数バックオフ）。

---

## 9. CSV取込設計

> **フェーズ3に後ろ倒し**: 実CSVサンプルが未提供のため、まずは手入力を中核とする。
> サンプル入手後に証券会社別プロファイルを実装。

- 対応（将来）: SBI / 楽天 / Webull / moomoo / 汎用CSV
- 文字コード自動判定（Shift_JIS / UTF-8 BOM）
- フロー: アップロード → プロファイル選択（or 自動判定）→ **列マッピング** → プレビュー → 取込
- 取込時の突合: `market + ticker` で既存銘柄を判定し「新規追加 / 数量・平均取得単価を更新」を選択
- 銘柄ごとのプロファイル（列名→項目）を保存し次回以降は自動マッピング

---

## 10. 認証・セキュリティ・データ保持

- **データ保持**: 資産データは **自分の Google スプレッドシートに保存**（システム・オブ・レコード）。
  ホスト・端末・ブラウザに依存せず、いつでもSheetsで直接閲覧でき、Googleドライブに原本が残る。
  価格・為替は KV キャッシュ（喪失しても再取得可、資産データに影響なし）。
- **認証 = Googleログイン（OAuth）**: パスワードの代わりに Google アカウントで認証。
  - 推奨実装: **Cloudflare Access** の Google IdP 連携。許可するメールアドレス（本人）を
    Access ポリシーで限定し、アプリ全体（Pages/Functions）を保護。
  - 代替: アプリ内で Google OAuth を実装しセッションCookie発行。
  - 認証で使う Google アカウントと、Sheets を置く Google アカウントは同一にできる。
- **Sheets アクセス**: バックエンドがサービスアカウント or OAuth で Sheets API を利用。
  サービスアカウント方式の場合、対象スプレッドシートをそのサービスアカウントに共有する。
- 外部APIキー（Finnhub）・通知トークン（LINE）・Resend APIキー・**Sheetsアクセス鍵**は
  Cloudflare の **Secrets / 環境変数** に保存。Sheetsには機密を置かない。
- HTTPS（Cloudflare標準）。
- **バックアップ**: 保管先がSheetsのため原本は常にGoogleドライブにあり、コピー作成も容易。

---

## 11. フロント構成（案）

- React + Vite + TypeScript、状態管理は軽量（TanStack Query でAPIキャッシュ）
- ルーティング: `/`（ダッシュボード）, `/holdings`, `/securities/:id`, `/signals`,
  `/rules`, `/masters`, `/import`, `/reports`, `/settings`
- **市場分離UI**: ダッシュボードは合算＋市場フィルタ。保有一覧・サインは
  **市場タブ（米国株 / 日本株 / 投信）** で独立表示。市場ごとに独立スクロール/集計
- チャート: 軽量ライブラリ（例: Recharts / lightweight-charts）でトリガーライン重畳
- レスポンシブ: スマホ=カード/縦並び、PC=テーブル。共通コンポーネントで
  「残り下落率（通知単価まで）」バッジ表示

---

## 12. 実装フェーズ（提案）

- **フェーズ1（MVP）**: Sheetsタブ作成＋Sheets APIアクセス→手入力で保有登録→
  価格取得（米株/日株/為替, KVキャッシュ）→評価額・残り下落率表示→買い増し判定→定時LINE/メール通知。
  認証はGoogleログイン
- **フェーズ2**: カテゴリ別金額マスタ＋版管理、ルールマスタ、
  証券会社×口座管理、CSV取込、ダッシュボード/サイン一覧の作り込み、市場タブ分離
- **フェーズ3**: 銘柄詳細チャート、ファンダ/戦略メタ、投信の基準価額取得、
  資産推移レポート（証券会社×資産クラス集計）、認証強化、バックアップ/エクスポート

---

## 13. 残論点（実装着手前に確認）

1. LINE公式アカウント（Messaging API チャネル）の準備可否
2. ログインを許可する Google アカウント（本人のメール）と、Sheets を置く Google アカウント
3. （将来）SBI/楽天/Webull/moomoo の実CSVサンプル（CSV取込はフェーズ3）

> 解決済み: 売却=数量のみ減算・単価不変 / 認証=Googleログイン / 金額=カテゴリ別マスタ /
> 通知時刻=日本株7:45,11:00,17:00・米国株24:00,7:00 / 保管先=Google スプレッドシート。

---

## 14. Googleログイン＋Sheets保存（方式A: ブラウザ完結 / GIS）（2026-06-01 設計）

> 当初設計（§10）はサーバー集約＋サービスアカウントだったが、**個人利用1人**のため、
> 秘密鍵を持たない **ブラウザ完結（Google Identity Services）** を採用する（すみぽん選定）。

> **更新（2026-06-10）**: データ同期は **Drive 自動マージ同期（§14.x dsync）に一本化**し、
> **Sheets 手動保存/読込（`_appdata` 方式）は廃止**した（Drive同期が上位互換のため）。これに伴い
> OAuthスコープから機微な `spreadsheets` を外し、**`drive.file`（アプリ作成ファイルのみ）＋`openid email`** に軽量化。
> 同意画面の項目が減り、再ログインの手順が軽くなる。トークン失効時は **`prompt:''` のサイレント再取得**で
> セッションが有効なら無音延長（401時に1回リトライ／自動同期前にも試行）。手動バックアップは JSON 書出し/読込で代替。
> 以下 §14.1〜14.2 の Sheets 記述は歴史的経緯（現行は Drive のみ）。

### 14.1 方式
- **Google Identity Services (GIS)** の OAuth トークンフロー（`google.accounts.oauth2.initTokenClient`）で、
  ブラウザから直接アクセストークンを取得し、**Sheets REST API をブラウザから呼ぶ**。
- 必要なのは **OAuthクライアントID（公開・ウェブ用）のみ**。**クライアントシークレット不要**。
- スコープ: `https://www.googleapis.com/auth/spreadsheets`（読み書き）＋ `openid email`（許可メール照合用）。
- 許可アカウント制限: 取得したアクセストークンで `userinfo` を引き、メールを**アプリ内allowlist**と照合。
  不一致ならトークン破棄＋拒否。
- トークンは**メモリ保持のみ**（永続化しない）。失効（約1時間）したら再取得（GISが再プロンプト）。

### 14.2 保存形式（v1 = JSONブロブ）
- スプレッドシート（`spreadsheetId` を設定で保持）に専用タブ **`_appdata`** を用意し、
  **セル A1 に `store.data` の JSON を丸ごと文字列で保存**。
- 読込: `values.get(_appdata!A1)` → JSON.parse → `store.replaceAll()` で差し替え。
- 保存: `values.update(_appdata!A1)` に JSON.stringify。
- メタ情報（`_appmeta!A1` に updatedAt 等）で簡易な整合性確認。
- v2（将来）: 保有/銘柄などを**表形式タブ**に展開（人が読める・元スプレッドシート風）。

### 14.3 同期方針（単一ユーザー前提）
- 自動上書きはしない。**明示操作**「Sheetsへ保存」「Sheetsから読込」をボタンで提供（v1）。
- 競合: 読込時に Sheets の updatedAt と localStorage を比較し、新しい方を採用するか確認。
- localStorage は引き続きローカルキャッシュとして併用（オフラインでも動く）。

### 14.4 セキュリティ・設定
- **OAuthクライアントIDは公開情報**（ブラウザ埋め込み前提）。リポジトリに置いてよいが、
  当面は**マスタ・設定にユーザーが入力**して `store.data.settings.google.clientId` に保持（差し込み式）。
- **承認済みJavaScript生成元**に「秘匿CFのURL」＋`http://localhost:8788` を登録（Google Cloud側・すみぽん）。
- 秘匿CF URL・許可メールはチャット/コミットに残さない運用。

### 14.5 実装状況（2026-06-01）
- **土台スキャフォールドのみ実装**（`gsync` モジュール＋マスタ・設定の「Google連携（実験的）」）。
  クライアントID未設定なら**完全に休眠**し、現行アプリ（ログイン不要・localStorage）に影響なし。
- クライアントID入手後に動作確認（ログイン→保存→別端末で読込）して有効化する。

## 15. 実装済みアーキテクチャ：通知＋Drive自動同期（2026-06-07 完成・AS-BUILT）

> §8/§10/§14 の設計を実装した結果の最終構成。以後はこちらが正。

### 15.1 データ保存：Drive自動マージ同期（Sheetsから移行）
- 正本＝**Google Drive の `securities-manager/data.json`**（`dataBundle()`=store.data+_colPrefs のJSON）。手動保存/読込は不要。
- **3-wayマージ**（`sync-merge.js` の `SyncMerge.mergeBundle(base, local, remote)`）。base=前回同期時点を localStorage `sm_sync_base` に保持。
  - 自然キー: securities=`market:ticker` / holdings=`securityId|broker|accountType` / categories=名前 / その他はid。整数ID2端末衝突を回避。削除も伝播、編集vs削除は編集優先。
  - prices/meta等のキャッシュはキー単位（新しいfetchedAt優先）、settings等は変更側優先、seq/日時はmax。
  - **削除伝播の安全策（2026-06-11）**: 配列キーが「存在して空（=削除の意思）」か「そもそも未提供（undefined＝情報なし）」かを区別し、**未提供側からは削除を伝播しない**。Driveファイルに配列キー（rules等）が欠落しただけで全レコードが消える事故を防ぐ。`store.load()` は rules が空なら既定ルールを再シード（空配列→`rules[0].isDefault`でのクラッシュを防止＝自己修復）。
- **Drive世代バックアップ（最大5世代・2026-06-11）**: 誤操作/不具合でのデータ消失対策。同じ `securities-manager` フォルダに `backup-YYYYMMDD-HHMMSS.json` を最大5世代保存（古いものから剪定。`data.json` 同期とは name 条件で非干渉）。作成タイミング＝**①1日1回（その日最初の同期で上書き前のDrive内容）②全データ削除/インポートの直前**。復元UI＝「バックアップ・出力」→「Driveのバックアップから復元…」。復元は `sm_sync_base` クリアで次回同期により反映。
- **同期基準点(`sm_sync_base`)のクリア規則**: 全データ削除・JSONインポート・バックアップ復元では base/at も消す。残すとローカルの空/置換が3-wayマージで「全削除」と誤解され他端末・Driveを巻き込むため、base={}の新規扱いにして安全側（pull/push）へ倒す。
- クライアント実装: `app.js` の **`dsync`**（Driveクライアント＋`syncNow`＋自動同期25秒/タブ非表示＋世代バックアップ）。OAuthは `gsync` と共用（スコープに `drive.file` 追加）。サインイン直後に初回同期（`afterSignIn`）。
- 設定配布: clientId/spreadsheetId はリポジトリに置かず **`/api/config`（CF env: GOOGLE_OAUTH_CLIENT_ID/GOOGLE_SHEET_ID）** から配る。`gsync.cfg()` がローカル空なら env で補完（新端末は入力不要）。
- Sheets（`_appdata`）は**保険として残置**（手動保存/読込ボタンは従来どおり）。

### 15.2 通知（買い増しサイン・メール）
- パイプライン（Cloudflare Functions・サーバー側、ツール未起動でも動く）:
  1. **データ読取** `functions/lib/sheets.js`：`readAppDataBundle(env)` = サービスアカウントで **Drive `data.json` を優先読取**（`readAppDataFromDrive`、drive.readonly）→失敗時 Sheets フォールバック（応答に `source`）。
  2. **現在値取得** `functions/lib/prices.js`：`/api/price?mode=light` を小分けで叩き最新化（高値は保存スナップショット流用）。
  3. **判定** `functions/lib/signal.js`（純判定コア＝app.js calc.evaluate と同一）＋ `functions/lib/portfolio.js`（バンドル→保有集計→`computeSignals`）。
  4. **送信** `functions/lib/notify.js`：Resend でメール。件名「【市場】M/D 購入基準価格通知」、本文＝種別/ティッカー/銘柄名/現在値(前日比)/前回から/買増ライン/(残り)/購入額。
  - エンドポイント `functions/api/notify-run.js`（`?send=1&market=JP|US`）。検証用 `sheet-check.js`/`signals-check.js`。
- **定時実行＝Cloudflare Cron Worker**（`worker/`）。cron 3本（UTC指定）:
  - `0 2,8 * * MON-FRI`（日本株 11/17時 JST 月〜金）/ `0 22 * * SUN-THU`（日本株 7時 JST 月〜金）/ `0 15,22 * * MON-FRI`（米国株 0/7時 JST 火〜土）。
  - ★**Cloudflareのcron曜日は「1=日曜…7=土曜」で 0 は無効**（標準cronと異なる）。`0-4` は invalid cron(code 10100) で弾かれ、数値 `1-5` も「日〜木」と誤解釈される。**曖昧回避のため曜日は3文字略称(MON-FRI/SUN-THU)で記述**（2026-06-07 修正・SEC-132）。`event.cron.startsWith('0 15,22')` で米国株を判定。
  - 米国株はJST火〜土（=米国の月〜金の取引。金曜引けはJST土曜配信、日月休場で送らない）。JST日曜はどのcronも発火しない。`workers_dev=false`で公開URL無効・cronのみ。
  - **デプロイ**: Worker は Pages とは別物。`.github/workflows/deploy.yml` に Worker デプロイステップ（`workingDirectory: worker` / `command: deploy`）を追加済みで、push時に Pages＋Worker を同時デプロイ（2026-06-07）。手動は `cd worker && npx wrangler deploy`。GitHub の `CLOUDFLARE_API_TOKEN` には **Account/Workersスクリプト/Edit** 権限が必要。
- 重複防止は「毎回その時点のサインを送る」シンプル方式（サインなしは送信スキップ）。高値は通知では再取得しない。

### 15.3 セキュリティ
- 内部API（notify-run/signals-check/sheet-check）と Worker手動fetch は **`NOTIFY_TRIGGER_TOKEN` 必須**（`functions/lib/auth.js` checkToken・fail-closed）。
- 価格/情報API（price/info/config）は公開市場データ/公開設定のみで非保護。

### 15.4 Cloudflare 環境変数（一覧）
- 通知（SA）: `GOOGLE_SA_EMAIL` / `GOOGLE_SA_PRIVATE_KEY` / `GOOGLE_SHEET_ID`
- メール: `RESEND_API_KEY` / `NOTIFY_EMAIL`（=Resend登録メール宛のみ可・onboarding@resend.dev）
- 保護: `NOTIFY_TRIGGER_TOKEN`（Pages env＋Cron Worker secret 同値）
- 公開設定配布: `GOOGLE_OAUTH_CLIENT_ID`（＋ GOOGLE_SHEET_ID 流用）
- 米株時価総額: `FINNHUB_API_KEY`（外国ADRはprofile2の通貨がUSD以外なら時価総額/配当を非表示）

### 15.5 すみぽん側の前提設定（再構築時の参照）
- Google Cloud: OAuthクライアント（project 381390060466。Sheets/Drive API 有効）＋ サービスアカウント（鍵JSON・Drive/Sheets API有効）。
- Drive: `securities-manager` フォルダを**サービスアカウントのメールに閲覧者共有**（通知サーバーがdata.jsonを読むため）。
- Resend: APIキー発行→CF env。手順書 `SERVICE_ACCOUNT_SETUP.md` / `NOTIFY_RESEND_SETUP.md`。
