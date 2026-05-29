# 証券管理ツール 詳細設計書

最終更新: 2026-05-29
ステータス: ドラフト（詳細設計フェーズ）
関連: [REQUIREMENTS.md](./REQUIREMENTS.md)

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
           │ (Scheduled Worker)│──▶│  D1 (SQLite) │    │
           │ 価格取得/判定/通知 │   └──────────────┘    │
           └─────┬──────┬──────┘                       │
                 │      │      └────────────────────────┘
                 ▼      ▼              ▼          ▼
            ┌────────┐┌────────┐ ┌────────┐ ┌────────┐
            │Finnhub ││Yahoo Fin│ │LINE API│ │Resend  │
            │(米株RT) ││(日株/為替)│ │(push)  │ │(mail)  │
            └────────┘└────────┘ └────────┘ └────────┘
```

- **Pages (SPA)**: フロントエンド。レスポンシブ。`/api` を叩く
- **Pages Functions**: REST API。D1 へCRUD、オンデマンド価格取得のプロキシ
- **Scheduled Worker (Cron)**: 定期的に価格取得→評価更新→買い増し判定→通知発火
- **D1**: 永続データ（保有・履歴・ルール・ランク・価格・サイン・設定）
- **外部API**: Finnhub（米株）/ Yahoo（日株・為替）/ LINE / Resend

> Pages と Cron Worker は機能分担。価格取得・判定ロジックは共通モジュール化して両者から呼ぶ。

---

## 2. データモデル（D1 / SQLite スキーマ）

### 2.1 ER 概要
- `holdings` 1 ─ N `transactions`
- `holdings` N ─ 1 `rule_master`（適用ルール）/ `rank_master`（ランク）
- `holdings` 1 ─ N `signals`
- `rank_master` 1 ─ N `rank_amount_history`（金額の版管理）
- `holdings` 1 ─ N `holding_amount_snapshot`（銘柄ごとの適用金額履歴）
- `prices` / `fx` は ticker 単位の価格キャッシュ

### 2.2 DDL（案）

```sql
-- 保有銘柄
CREATE TABLE holdings (
  id            INTEGER PRIMARY KEY,
  market        TEXT NOT NULL CHECK (market IN ('JP','US')),
  ticker        TEXT NOT NULL,            -- JP:"7203", US:"AAPL"
  name          TEXT NOT NULL,
  quantity      REAL NOT NULL DEFAULT 0,  -- 保有数量
  avg_cost      REAL NOT NULL DEFAULT 0,  -- 平均取得単価（原通貨）
  currency      TEXT NOT NULL,            -- 'JPY' | 'USD'
  rule_id       INTEGER REFERENCES rule_master(id),
  rank_code     TEXT REFERENCES rank_master(code),  -- 'S'..'D'
  base_high_mode TEXT DEFAULT NULL,       -- 個別上書き(任意): '5y'|'52w'|'all'|'manual'
  base_high_manual REAL DEFAULT NULL,     -- manual時の基準高値
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(market, ticker)
);

-- 取引履歴（買い/売り）
CREATE TABLE transactions (
  id          INTEGER PRIMARY KEY,
  holding_id  INTEGER NOT NULL REFERENCES holdings(id),
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

-- ランク マスタ（現在値）
CREATE TABLE rank_master (
  code        TEXT PRIMARY KEY,          -- 'S','A','B','C','D'
  label       TEXT,
  amount      REAL NOT NULL,             -- 1回の買い増し金額（円）
  sort_order  INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ランク金額の版管理（マスタ一括変更の履歴）
CREATE TABLE rank_amount_history (
  id           INTEGER PRIMARY KEY,
  rank_code    TEXT NOT NULL REFERENCES rank_master(code),
  amount       REAL NOT NULL,
  effective_from TEXT NOT NULL,          -- この金額が有効になった日時
  effective_to   TEXT,                   -- 次の変更で埋まる（NULL=現行）
  reason       TEXT
);

-- 銘柄ごとの「適用された金額」スナップショット履歴
-- （マスタ変更前の金額を銘柄単位で後から参照できるように保持）
CREATE TABLE holding_amount_snapshot (
  id          INTEGER PRIMARY KEY,
  holding_id  INTEGER NOT NULL REFERENCES holdings(id),
  rank_code   TEXT NOT NULL,
  amount      REAL NOT NULL,             -- その時点で銘柄に適用されていた金額
  recorded_at TEXT NOT NULL,             -- 記録時点（マスタ変更時/ランク変更時）
  trigger     TEXT NOT NULL              -- 'rank_change'|'master_change'
);

-- 価格キャッシュ
CREATE TABLE prices (
  market      TEXT NOT NULL,
  ticker      TEXT NOT NULL,
  price       REAL,                      -- 現在値（原通貨）
  prev_close  REAL,                      -- 前日終値
  high_5y     REAL,                      -- 5年高値（基準高値の算出用）
  high_52w    REAL,
  high_all    REAL,
  fetched_at  TEXT NOT NULL,
  source      TEXT NOT NULL,             -- 'finnhub'|'yahoo'
  PRIMARY KEY (market, ticker)
);

-- 為替
CREATE TABLE fx (
  pair        TEXT PRIMARY KEY,          -- 'USDJPY'
  rate        REAL NOT NULL,
  fetched_at  TEXT NOT NULL
);

-- 買い増しサイン状態
CREATE TABLE signals (
  id            INTEGER PRIMARY KEY,
  holding_id    INTEGER NOT NULL REFERENCES holdings(id),
  type          TEXT NOT NULL CHECK (type IN ('initial','addon')),
  base_value    REAL NOT NULL,           -- 基準高値 or 前回購入価格
  trigger_price REAL NOT NULL,           -- 発火閾値
  current_price REAL NOT NULL,           -- 発火時点の現在値
  reco_amount   REAL,                    -- 推奨買い増し金額（ランク由来）
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

> 機密情報（Finnhub APIキー、LINEトークン、Resend APIキー、ログインパスワードハッシュ）は
> D1 ではなく Cloudflare の **環境変数 / Secrets** に保存する。

---

## 3. 買い増し判定ロジック

### 3.1 基準高値の決定（base high）
銘柄の `base_high_mode`（個別上書き）→ 適用ルールの `base_high_mode` の順で解決：
- `5y`  → `prices.high_5y`
- `52w` → `prices.high_52w`
- `all` → `prices.high_all`
- `manual` → `holdings.base_high_manual`

### 3.2 判定アルゴリズム（擬似コード）
```
for each enabled holding h:
    price = prices[h].price
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
        base = last_buy
        trigger = base * (1 - rule.addon_drop_pct/100)      # 例 ×0.80
        type = 'addon'

    if price <= trigger:
        reco = current_rank_amount(h.rank_code)   # ランク→金額
        upsert_signal(h, type, base, trigger, price, reco)
    else:
        # 価格が戻った場合、rearm=1 なら既存pending/notifiedを解除して再武装
        maybe_rearm(h, rule)
```

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
  - **購入を記録** → 対象 transaction を追加 → 平均取得単価・前回購入価格が更新 →
    既存サインを `done` にし、次回判定で新しい基準で再計算。
  - **スヌーズ** → `status = snoozed`, `snooze_until` 設定（例: 当日24時）。
- `rearm = 1` の場合、価格が `trigger_price` を上回って戻った後に再度割り込むと、
  既存サインを `expired` にして新規発火（再通知）。`rearm = 0` なら据え置き。

---

## 4. ランク金額マスタの版管理（重要）

要件: 「マスタで一括変更」かつ「変更前の金額を銘柄ごとに保持」。

### 4.1 データの持ち方
1. `rank_master.amount` … 各ランクの**現行金額**（画面の既定表示・新規判定で使用）
2. `rank_amount_history` … マスタ金額の**版管理**（いつ・いくらに変えたか。effective_from/to）
3. `holding_amount_snapshot` … **銘柄ごと**に、その時点で適用されていた金額のスナップショット

### 4.2 一括変更の処理フロー
```
PATCH /api/ranks/{code}  { amount: newAmount }
  1) rank_amount_history: 現行行の effective_to = now（締め）
  2) rank_amount_history: 新行を effective_from=now, amount=newAmount で追加
  3) 当該ランクの全 holding に対し、変更"前"の金額を
     holding_amount_snapshot に trigger='master_change' で記録
  4) rank_master.amount = newAmount に更新
```
→ これにより「現在の金額は一括変更」しつつ、各銘柄の **過去に適用されていた金額** を
  `holding_amount_snapshot` から時系列で参照できる。

### 4.3 銘柄のランク変更時
- ランク変更前の（旧ランクの現行）金額を `holding_amount_snapshot`（trigger='rank_change'）に記録してから変更。

---

## 5. API 仕様（REST / Pages Functions）

ベースパス `/api`。認証必須（§8）。レスポンスはJSON。

| メソッド | パス | 概要 |
|---------|------|------|
| GET | `/portfolio/summary` | 総資産・損益・前日比・サイン件数・内訳（ダッシュボード用） |
| GET | `/holdings` | 保有一覧（現在値・損益・**残り下落率**・サイン状態を含む） |
| POST | `/holdings` | 銘柄追加（手入力） |
| GET | `/holdings/{id}` | 詳細（履歴・適用ルール/ランク・チャート用系列） |
| PATCH | `/holdings/{id}` | 編集（数量・ランク・ルール・基準高値上書き等） |
| DELETE | `/holdings/{id}` | 削除 |
| POST | `/holdings/{id}/transactions` | 購入/売却の記録 |
| GET | `/signals` | サイン一覧（pending/notified、残り下落率・推奨金額） |
| POST | `/signals/{id}/buy` | サインから購入記録（→ done） |
| POST | `/signals/{id}/snooze` | スヌーズ |
| GET | `/rules` / POST/PATCH/DELETE | ルールマスタ管理 |
| GET | `/ranks` / PATCH `/ranks/{code}` | ランクマスタ（一括変更は §4.2） |
| GET | `/ranks/{code}/history` | ランク金額の変更履歴 |
| GET | `/holdings/{id}/amount-history` | 銘柄ごとの適用金額スナップショット履歴 |
| POST | `/import/preview` | CSVアップロード→列マッピング→プレビュー |
| POST | `/import/commit` | プレビュー確定→取込 |
| GET | `/reports/portfolio-history` | 資産推移（portfolio_snapshots） |
| GET | `/prices/refresh` | オンデマンド価格更新（画面表示時） |
| GET/PUT | `/settings` | 通知先・通知時間帯等 |

---

## 6. 株価データソース仕様

### 6.1 米国株（Finnhub・ほぼリアルタイム）
- Quote: `GET https://finnhub.io/api/v1/quote?symbol=AAPL&token=KEY`
  - `c`=現在値, `pc`=前日終値, `h/l/o` 当日高安始
- 5年/52週高値: candle/metric エンドポイント、または日足を集計して `high_5y/high_52w` を更新
- レート制限: 無料60回/分。保有米株数に応じバッチ化し、Cronは1分間隔

### 6.2 日本株（Yahoo Finance系・15〜20分遅延）
- Quote: `query1.finance.yahoo.com/v8/finance/chart/7203.T`（現在値・前日終値）
- 5年高値: `range=5y&interval=1d` の日足から max(high) を算出
- Cronは15分間隔

### 6.3 為替
- `USDJPY=X` を Yahoo から取得、`fx` テーブル更新

---

## 7. 定期実行（Cron Trigger）設計

| ジョブ | 頻度 | 処理 |
|--------|------|------|
| 米株価格更新＋判定 | 米国市場オープン中 毎1分 | Finnhubで保有米株を更新→§3判定→通知 |
| 日本株価格更新＋判定 | 東証オープン中 毎15分 | Yahooで保有日本株を更新→§3判定→通知 |
| 高値リフレッシュ | 1日1回 | high_5y/52w/all を再計算 |
| 資産スナップショット | 1日1回（市場クローズ後） | portfolio_snapshots へ記録 |
| 為替更新 | 毎15分 | USDJPY更新 |

- 取引時間判定はJST/EST（夏時間考慮）で実装。
- 通知時間帯（quiet hours）外はサイン作成のみ行い、通知は抑止 or 時間内にまとめて送る。

---

## 8. 通知設計

### 8.1 LINE（Messaging API push）
- `POST https://api.line.me/v2/bot/message/push`（Bearer: チャネルアクセストークン）
- メッセージ例:
  ```
  【買い増しサイン】トヨタ(7203) 初回
  現在値 2,450円 ≦ トリガー 2,460円（5年高値4,100円 −40%）
  推奨買い増し: ランクB = 200,000円
  ```

### 8.2 メール（Resend）
- `POST https://api.resend.com/emails`（Bearer: APIキー）
- 同等内容をHTMLメールで送信。複数サイン時はまとめて1通に集約可。

### 8.3 配信制御
- 同一サインは1回のみ通知（§3.4）。`notified_at` で管理。
- quiet hours 設定を尊重。失敗時はリトライ（指数バックオフ）。

---

## 9. CSV取込設計

- 対応: SBI証券 / 楽天証券 / moomoo証券 / 汎用CSV
- 文字コード自動判定（Shift_JIS / UTF-8 BOM）
- フロー: アップロード → プロファイル選択（or 自動判定）→ **列マッピング** → プレビュー → 取込
- 取込時の突合: `market + ticker` で既存銘柄を判定し「新規追加 / 数量・平均取得単価を更新」を選択
- 銘柄ごとのプロファイル（列名→項目）を保存し次回以降は自動マッピング

---

## 10. 認証・セキュリティ（残論点あり）

- 個人利用前提の簡易認証（候補: 単一パスワード + セッションCookie / Cloudflare Access）
- パスワードはハッシュ化して Secrets 管理。APIは認証必須。
- 外部APIキー・通知トークンは Secrets。D1には機密を置かない。
- HTTPS（Cloudflare標準）。

---

## 11. フロント構成（案）

- React + Vite + TypeScript、状態管理は軽量（TanStack Query でAPIキャッシュ）
- ルーティング: `/`（ダッシュボード）, `/holdings`, `/holdings/:id`, `/signals`,
  `/rules`, `/ranks`, `/import`, `/reports`, `/settings`
- チャート: 軽量ライブラリ（例: Recharts / lightweight-charts）でトリガーライン重畳
- レスポンシブ: スマホ=カード/縦並び、PC=テーブル。共通コンポーネントで「残り下落率」バッジ表示

---

## 12. 実装フェーズ（提案）

- **フェーズ1（MVP）**: D1スキーマ→手入力で保有登録→価格取得（米株/日株/為替）→
  評価額・残り下落率表示→買い増し判定→LINE/メール通知
- **フェーズ2**: ランク/ルールマスタ管理＋版管理、CSV取込、ダッシュボード/サイン一覧の作り込み
- **フェーズ3**: 銘柄詳細チャート、資産推移レポート、認証強化、バックアップ/エクスポート

---

## 13. 残論点（実装着手前に確認）

1. 売却・一部売却の扱い（前回購入価格・平均取得単価への反映方法）
2. 認証方式（単一パスワード or Cloudflare Access）
3. SBI/楽天/moomoo の実CSVサンプル
4. LINE公式アカウント・Resend アカウントの準備
5. ランク初期金額（S/A/B/C/D）と通知時間帯
