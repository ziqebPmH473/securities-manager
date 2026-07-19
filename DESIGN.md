# 証券管理ツール 詳細設計書

最終更新: 2026-07-02
ステータス: §0 が現状実装、§1〜13 は**目標アーキテクチャ**（Sheets/Cron/通知/React は未実装＝次フェーズ）
関連: [REQUIREMENTS.md](./REQUIREMENTS.md) / [HANDOFF.md](./HANDOFF.md)

> **注意**: 本書の §1〜13 は当初の目標設計（React/Vite・Cloudflare・Google Sheets・Cron・通知）。
> 実際の実装はこれと一部異なります。**現状の実装は §0 を参照**してください。

---

## 0. 現状実装サマリ（2026-06-01）

- **技術**: バニラ HTML/CSS/JS（**ビルド無し**。React/Vite ではない）＋ Cloudflare Pages Functions。
- **保存**: ブラウザ **localStorage**（キー `sm_data_v1`、列設定は `sm_colprefs_v2`、**列フィルター**は `sm_filters_v1`（分析・個別銘柄のライブ状態）と `sm_filter_presets_v1`（パターン＝3タブ共通））。Sheets/KV は未実装。
- **描画パフォーマンス**（2026-07-01）: ①**列フィルターの詳細パネル開閉は全再描画しない**（`fltToggle` は `render()` を呼ばず `#flt-host-<scope>` のDOMと `#flt-toggle-<scope>` ボタンだけ差し替え＋`scheduleFit`）。開閉が一覧再計算を伴わず即時化（大量銘柄で約2000ms→数十ms）。フィルタ値の変更・追加削除は従来どおり `fltRerender→render`。②**1描画中だけ有効な計算メモ**（`calcMemoBegin/End`。`render()` の最外側で開始・終了）で `calc.evaluate/totalHolding/lastBuyInfo` を銘柄ごとに1回に（保有・取引履歴の重複走査を削減。描画外はメモOFF＝常に最新をその場計算で古い値が残らない）。データ・保存・同期・表示結果は不変。
- **共通列フィルター**（2026-06-26）: 分析・個別銘柄・銘柄マスタの3タブで**同一のフィルターパネル**を共用（`fltState[scope]` / `filterPanelHtml(scope)` / `applyColFilters(secs, scope)`、`scope='holdings'|'analysis'|'secmaster'`）。項目を追加して数値=範囲 / 選択肢=複数選択（いずれか一致）で絞る。対象列は `filterableCols(scope)`（分析=ANALYSIS列、個別銘柄=現在市場の列、銘柄マスタ=固定キー）。**次回起動時の引継ぎ**＝分析・個別銘柄のみ `loadFilterState`/`saveFilterState` で永続（銘柄マスタは保存しない）。**パターン**（名前付きプリセット）は3タブ共通の1リストで、適用時はそのタブに無い列キーを無視。個別銘柄の旧 種別/会社/口座/カテゴリ ドロップダウンはこのパネルへ統合（`setFilter`/`clearFilter` 廃止）。
- **銘柄名検索の正規化**（2026-06-26）: `searchNorm()`＝`NFKC`（全角英数字→半角・半角カナ→全角カナ）＋小文字化＋カタカナ→ひらがな。保有・銘柄マスタ・分析・カルテの銘柄名/コード検索すべてに適用（`secMatchesQuery`）。**銘柄カルテ**は市場選択を廃止し、コード/ティッカー/銘柄名のいずれかで検索（複数一致は候補リスト→選択、`karteMatches`）。
- **デプロイ**: GitHub のブランチ `claude/securities-portfolio-tool-WGIsF`（既定＝本番）への push で **CF Pages 自動デプロイ**。
- **API（Pages Functions）**: `/api/price`（Yahoo価格・**日足で前日比正常化**）、`/api/info`（日本語名・セクター/業種・EPS/発行済株式数）、`/api/splits`（分割）、`/api/history`（終値時系列・チャート用）。Finnhub は `FINNHUB_API_KEY` 設定時のみ米株に使用。
- **描画パフォーマンス追補**（2026-07-02）: ①**列幅の自動調整 `autoFitColumns` の layout thrashing を除去**（旧: セルごとに計測用spanへ `innerHTML` 書換→`offsetWidth` 読みを繰り返し、行×列ぶんの強制リフローで一覧描画が約1秒。新: 全セルの計測spanを先に生成→1回のレイアウトでまとめて `offsetWidth` を読む。計測は同じ offsetWidth ベースで精度不変。render 約1091ms→150ms）。②**ランキング順位バッジ `/api/ranking` の取得をタブ表示のたびから外し、株価更新時（`api.refreshAll` 末尾）のみに**（保有銘柄タブを開くたびの通信・引っかかりを解消。`_render` の取得トリガー廃止）。③**日次更新（`refreshAll` 価格 / `refreshMeta` 情報）から投信(FUND)を除外**（Yahooに無い協会コードへの無駄な問い合わせで更新が遅くなるため。投信名はコードマスタの「名称取得」で個別取得）。④**高値(5年/52週)の補完取得**（日次高値取得後に追加・取込した銘柄は `withHighs=false` の通常更新で高値が取れず残り下落率が出ないため、`refreshAll` 末尾で `allSecs` から `high5y` 欠けを拾い `highs=1` で10件ずつ補完＝取込・手動価格更新の双方で自己修復）。
- **マーケットランキングの列設定（`MKTRANK` スコープ・2026-07-16）**: マーケット（ランキング）タブの列を保有銘柄と同じ「列」ボタン（`openColPicker('MKTRANK')`）で表示/非表示・並べ替え・幅・列名を変更可能にした。土台は既存の列基盤を再利用（`colPrefs['MKTRANK']` / `getColOrder` / `colHeadHtml` / `colTag`）。利用可能列は `MKTRANK_KEYS`（`colsForScope('MKTRANK')` が MASTER_COLS と交差）、既定表示は `DEFAULT_VISIBLE.MKTRANK`（＝従来相当。順位/コード/名称は先頭固定でピッカー対象外）。行描画 `mktRankRow` は、**市場データ列（`MKTRANK_IT_KEYS`＝現在値/前日比/前日終値/値幅/5年・52週高値/高値比/1年・3年安値/安値からの上昇率/売買代金/時価総額）をランキング取得値 `it` から描画（`store.data.prices` は非参照＝買いサイン判定に無影響／追加取得ゼロ）**。それ以外の列は登録済み銘柄のみ既存 `COL_RENDERERS(sec)` に委譲（カテゴリ/格付/ラベル等のツール内情報を紐づけ表示）、未登録は「—」。取得は従来の `highs=1` 1回のままで、今まで捨てていた `high52w/low1y/low3y/prevClose/volume` を `loadRanking` で `it` に保持するだけ。ソートは順位固定＋列ヘッダクリックで `mktSortVal`（市場列=it値／ツール列=`sortValue(sec)`）。`marketRow` の ctx 構築は `rowContext(sec)` に抽出して共用。Google同期は `_colPrefs` に自動同梱。
- **マーケットランキングの配当列（`MKTRANK_HYBRID_KEYS`・2026-07-17）**: ランキングに **配当利回り（`divYield`）／配当per株（`dividend`）** を追加。**追加取得ゼロ**＝米株は既存のYahoo screener（`/api/ranking`）の**同一レスポンス**に `trailingAnnualDividendYield`（小数。×100で%）と `trailingAnnualDividendRate` が含まれるため、捨てずに `it` へ載せるだけ。日本株のランキングHTMLには配当が無い。そこで市場データ列（`it` 専用）／ツール内情報列（登録済み銘柄専用）の二分に収まらない**第3の「ハイブリッド列」`MKTRANK_HYBRID_KEYS`** を導入し、`mktHybridValue` が **`it` の値 → 無ければ登録済み銘柄のマスタ値（`calc.divYield(sec)`）** の順で解決する（＝米株は全50行、日本株は登録済みのみ表示、それ以外は「—」）。描画/ソート/背景色ルールの3経路すべてに通すこと（`mktHybridCell` / `mktSortVal` / `mktCfValue`）。
  - **ADR（表示通貨≠財務通貨）の配当は載せない**: `currency`(USD) と `financialCurrency`(BRL/KRW/EUR等) が食い違う銘柄は、**配当が現地通貨建てなのに株価がUSD**のため Yahoo の `trailingAnnualDividendYield` 自体が壊れる（実測: ITUB 39.75%／BBD 35.30%／SKHY 1912.61%）。`rate/price` で自前計算しても同じ汚染値になるので**検算では検出できない**。`rankUs` で `currency !== financialCurrency` なら `dividend`/`divYield` を `null` にして「—」表示にする（`info.js` の `foreign` ガードと同じ思想。NOK等の誤差が小さいケースも巻き込むが、**誤った数値を出すより「—」が安全**）。
- **非同期取得の完了後は「現在タブ」を確認してから描画する（2026-07-17）**: `#app` は全タブ共有の1コンテナなので、**await を挟む処理の完了後に各タブの `renderXxx()` を無条件で呼ぶと、ユーザーが移動した先のタブを上書きする**。マーケットは `loadRanking` の取得（数秒）中に別タブへ移ると、完了時の `renderMarketTab()` が現在のタブへマーケット画面を描画し「数秒後に前のタブへ戻される」ように見えた（`currentView`／ナビ／タイトルは移動先のまま＝中身だけ差し替わる）。対策＝`renderMarketTab()` 冒頭で `currentView !== 'market'` なら描画しない（取得結果は `store.data.mktRanking` に保存済みなので、戻れば表示され取得は無駄にならない）。**同種の非同期描画を足す時は同じガードを入れる**（`render()` 経由なら `currentView` で分岐するので安全）。
- **データモデル（store）**: `securities / holdings / transactions / rules / categories / investCategories / labelDefs / prices / fx / meta / indices / amountHistory / amountSnapshots / analyses / importHistory / importMappings / matrixBands / matrixSettings`。
  - `labelDefs`（**銘柄ラベル＝複数タグのマスタ**・2026-07-02）= `{ name, color, sortOrder }` の配列（`DEFAULT_LABELS`＝半導体/宇宙/防衛/高配当）。**投資テーマ・分類のタグで、1銘柄に複数付与できる**（`securities[].labels` = 名前の配列）。投資カテゴリ（単一選択）とは別物として共存。狙い＝前提（テーマ）が崩れた時に**ラベルで絞り込み→一括判断（売却等）**。色は `LABEL_COLORS` 共有、`labelsTag()`/`labelsTagOne()` で描画。マスタ「銘柄ラベル マスタ」(`openLabelMaster`)で編集（`store.add/update/removeLabelDef`。改名は銘柄へ追従、削除は銘柄配列から除去）。取込・出力の直列化は **`; ` 区切り**（`serializeLabels`/`parseLabels`、区切りは `; , 、／/ |` 許容）、未登録ラベルは取込時に `ensureLabelDefs` で自動追加。**配線**: 銘柄編集フォーム（チェックボックス＋新規追加テキスト）＋保存patch / 表の列（`MASTER_COLS`「labels」・`COL_RENDERERS`・`DEFAULT_VISIBLE`(US/JP)・`sortValue`・`colDefaultWidth`）/ **列フィルタ**（`fltSelectSpec` multi=true＝いずれか一致・`applyColFilters` の multi 分岐。ついでに investCategory もフィルタ可に）/ 一括変更（`SM_BULK_FIELDS` の `labelAdd`/`labelRemove`＝銘柄ごとの配列に加除。`bulkPatch(field,val,sec)` に第3引数 sec を追加）/ 取込（`GI_FIELDS/GI_GROUPS/GI_AUTOMAP/giParseValue`・`GENERIC_MAP/HEADER`末尾・`parseGeneric`・`genericFieldValue`・`ANALYSIS_COLMAP`）/ 詳細ドロワー・銘柄カルテ / Google同期（`sync-merge.js` SCHEMA に `labelDefs` を records で登録）。**インライン編集は非対応**（複数タグを1セルで編集するのは操作性が悪いため、フォーム/一括/マスタで編集）。
  - `investCategories`（**投資カテゴリ＝分析枠ラベルマスタ**・2026-07-01）= `{ name, color, sortOrder }` の配列（`DEFAULT_INVEST_CATEGORIES`＝テーマ/お遊び/コア/王道/主力/準主力/投機/宝くじ/防御・配当）。**既存の `categories`（投資額カテゴリ・金額付き）とは完全に別管理**。銘柄側フィールドは `securities[].investCategory`（銘柄が「どういう枠か」＝高配当狙い/テーマ株 等のラベル。金額計算には一切関与しない）。色は `LABEL_COLORS` を共有し `investCategoryTag()` で描画。マスタ「投資カテゴリ マスタ」(`openInvestCategoryMaster`)で名前・色・並び順を編集（`add/update/removeInvestCategory`。改名は銘柄へ追従、削除は銘柄を null）。**配線**: 銘柄編集フォーム＋保存patch / 表の列（`MASTER_COLS`・`COL_RENDERERS`・`DEFAULT_VISIBLE`(US/JP)・`sortValue`・`INLINE_FIELDS`・銘柄マスタ`SM_COLS`）/ 一括変更（`SM_BULK_FIELDS`・`bulkValueHtml`）/ 取込（`GI_FIELDS/GI_SEC_FIELDS/GI_GROUPS/GI_FIXED_KEYS/GI_AUTOMAP`・`GENERIC_MAP/HEADER`末尾[22]・`parseGeneric`・`exportGeneric`・`ANALYSIS_COLMAP`「投資カテゴリ」列・`IMPORT_DOMAINS.investCategory`(canAdd)）/ 詳細ドロワー・銘柄カルテ。**取込方針**: 既存「カテゴリ」列は従来どおり金額カテゴリへ、新「投資カテゴリ」列を追加（既存フローは不変）。後方互換は `load()` の `||=` と `restoreBundle` 内 `store.load()` で自動シード。
  - `matrixBands`: レポートの分布マトリックスの取得額レンジ（`{max, label, color}` の配列。max=null で「それ以上」）。マスタ「マトリックス レンジ設定」で編集。
  - **取引サマリー（レポート内タブ・円換算）**（2026-07-09 改）: 期間トグル `reportPeriod`＝`all`（全期間）/`year`（年別・`reportYear` を年プルダウンで選択）/`month`（月別・`reportYear`＋`reportMonthNum` を年/月プルダウンで選択）。年の選択肢は取引データに存在する年（`txnYears`・降順）。期間セレクタ（プルダウン）はトグルの**左**に置き、トグル自体は右端固定＝月別に切替えてもトグル位置が動かない（`.txn-head-ctrls` を `margin-left:auto` で右寄せ、内部順は セレクタ→トグル→絞り込み）。集計・明細一覧は共通の `txnInPeriod()` が期間＋絞り込みで抽出。買い/売り行クリックで明細一覧モーダル（`openTxnList`）。**汎用フィルタ `txnFilter`**（`{market, labels[], labelMode}`・セッション状態）＝「🔎 絞り込み」(`openTxnFilter`)で 市場（ALL/US/JP）と銘柄ラベル（選択を除外 `exclude` / 選択のみ `include`）を指定。判定は `txnSecMatchesFilter`。**取引サマリーの金額・件数・明細一覧のみに効き**、保有・資産集計・判定など他の扱いは不変（短期投資ラベルを「選択を除外」にする用途を汎用化。旧 `labelDefs.excludeFromTxn` フラグ方式は本フィルタに置換して廃止）。適用中はフィルタチップ＋クリアを表示。**モーダルは枠外（オーバーレイ）クリック／Escで閉じる**（`modal-overlay` の click 委譲・keydown。ドロワーも従来どおり枠外クリックで閉じる）。
  - **共通ドル円換算レート `settings.masterUsdJpy`（初期値100・2026-06-30）**: 米国株($)を円換算して「評価のものさし」にする共通レート（実勢レートではない）。マスタ「ドル円換算レート（マスタ評価用）」で編集（`saveFxRate`）。**2用途で共用**: ①**背景色ルール**＝金額系列（`CF_MONEY_KEYS`：価格・取得価額・評価額・取得単価・時価総額 等のネイティブ通貨列）は US のとき `cfConvVal` で「ドル×レート＝円相当」に換算してから範囲判定（表示は$のまま色だけ円相当。%・倍率・株数・スコア・既に円の `acqJpy` は対象外）。②**マトリックス**の取得額円換算（`masterUsdJpy()`）。旧 `matrixSettings.usdJpy` は load 時に `masterUsdJpy` へ移行（後方互換で参照フォールバックも残す）。`matrixSettings` は `matrixBands` の同期タイブレーク用 `_updatedAt` 専用に縮小。
  - `securities` は分析メタ（**最新分析のミラー**）＋ `nameOverride/sectorOverride/industryOverride`（手動上書き、自動取得で潰れない）、`fixedBuyPrice`（買増固定値）、`prevBuyPrice`、`baseHighMode/baseHighManual`、`watch`（注意フラグ＝「注意」タグ表示。2026-06-30以降は保有銘柄タブが保有有無に関わらず全銘柄表示になったため一覧の出し分けには使わない。絞り込みは列フィルタで行う）、`enabled`（判定対象）、`splitHistory[]`、`manualUpdatedAt`、`principalSold/principalSoldAmount`（元本売却・情報管理のみ）、`memo`（自由記述メモ・2026-06-20。判定には影響しない。フォーム/列「メモ」/詳細ドロワー/汎用往復(取込⇄出力)に配線）。
  - `holdings` = `{ id, securityId, broker, accountType, quantity, avgCost, acqJpy?, evalJpy?, source?, updatedAt?, origBuyAmount? }`。`evalJpy`（**投信の評価額(円)・保有単位**・2026-07-02）= 投信(FUND)は価格を自動取得しないため、**証券会社×口座ごとに評価額を手入力**する値（保有直接編集フォームの投信行に入力欄・新規追加行にも）。表示・損益率・マネフォ用転記は `h.evalJpy` を優先し、未入力の保有だけ共有単価 `prices['FUND:ticker'].price × 口数` で概算補完（`calc.valueNative`/`pnlPctNative` の FUND 分岐、`fundSavedRows`・資産一括エクスポート `excelExportGenerate` の投信行）。投信取込3経路（証券会社CSV自動仕分け・新規コード登録・投信取込）でも保有ごとに `evalJpy` を保存。**投信コード**は転記2種＋資産一括エクスポートすべてに `sec.ticker`（協会コード）を出力（旧: コード列を空文字固定にしていた不具合を修正）。マネックス投信CSVは口数列名が「保有数」（`detectFundHeader` の口数regexに追加）／投信専用取込は非strict（`parseFundRows` の strict は株ファイル混在の moomoo/楽天のみ）。`origBuyAmount`（**売却前購入額**・原通貨・2026-06-20）= 一旦売却→他社で買い直し（損出し）等で「最初の購入額」を保有レコード単位で残す手入力値（例: 100万で買い80万で売却し80万で買い直した銘柄は、買い直した保有レコードに `origBuyAmount=100万` を入れると、その保有の取得価額80万を**置換**して「購入額（本来）」に100万が出る）。金額（総額）なので**分割調整(applySplit)の対象外**。これを集計した列が **`origCost`「購入額（本来）」**（`calc.originalCostNative`＝保有ごとに `origBuyAmount` があればそれ・無ければ取得価額`avgCost×quantity` を合算）。保有を直接編集フォームで入力、US/JP一覧の既定列・詳細ドロワー「保有」に表示。**汎用往復**（`GENERIC_MAP/HEADER`「売却前購入額」列＝保有単位・`parseGeneric`は `row` 直下・`runGenericImport` の保有付与・`exportGeneric` は保有行の `r[20]`）に配線。
  - `analyses`（**銘柄分析の履歴**・2026-06-13）= `{ id, securityId, analysisDate, overallGrade, rating, buyGrade, starValuation, starStrength, starRisk, priority, recoAmount, analysisNote, createdAt, updatedAt }`。**自然キー＝`securityId|analysisDate`**（1銘柄×1評価日＝1件、別評価日は別レコード＝履歴）。銘柄レコードの平置き分析フィールドは `latestAnalysis`（評価日が最も新しい1件）の**ミラー**で、表・ソート・ドロワー・背景色・取込往復などの既存配線はそのミラーを参照する（`amountHistory`/`amountSnapshots` と同じ「履歴は別ストア・現在値は本体」方式）。記録の入口は **①銘柄編集フォーム「分析メタ」保存**（評価日キーで upsert→ `syncLatestAnalysis` でミラー更新）と **②分析結果の取込**（評価日ごとに upsert。古い評価日も履歴として残す＝旧実装の stale 破棄は廃止）。閲覧は編集フォームの **「分析履歴」ボタン→モーダル（閲覧専用・評価日降順）**。後方互換で初回 load 時に既存の平置き分析（`analysisDate` あり）を履歴へ1件起こす（`_migrateAnalyses`・自然キーで冪等）。
  - `meta`（`market:ticker`キー）= 名前/セクター/業種/PER/EPS/配当/時価総額/sharesOut の自動取得キャッシュ。
  - `prices`（`market:ticker`キー）= price/prevClose/high5y/high52w/low1y/low3y（＋各 *Date）。`low1y/low3y`＝直近1年/3年の最安値（情報表示専用。買い増し判定には未使用）。`indices` = 参考指数 price/prevClose。
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
- **価格キャッシュ（現在値・前日終値・52週/5年高値・1年/3年安値）は削除も調整もしない**（SEC-48）。
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
        # 「買い増しも初回基準」フラグ（securities.addon_from_high / sec.addonFromHigh）:
        # ONなら買い増しでも常に初回と同じ判定＝ base_high × (1 - initial_drop_pct/100)。
        # 前回購入単価に依らずトリガーが動かない（1回目を少額で買っても次回購入ラインが下がらず、
        # 同じ初回ライン=例−40%で残り全額を買い増せる）。addon_drop_pct は使わない。baseSource='初回固定'。
        # 買増固定値(fixed_buy_price)があればそちらが優先。高値更新オプションより優先。
        if s.addon_from_high:
            base = base_high(h)
            trigger = base * (1 - rule.initial_drop_pct/100)
        # 高値更新オプション（rule.high_reset_mode）: 「前回購入より後に最高値を更新した」場合は初回ルールで判定。
        # 判定は時間軸（最高値の付いた日 > 前回購入日）。値の大小ではなく日付で比較する。
        #   ※旧実装は base_high > last_buy の値比較で、暴落後に買った銘柄が常に高値更新扱いになる誤判定があった。
        #   高値の日付(high_5y_date 等)・前回購入日(取引履歴)が両方そろう時のみ発動。片方でも無ければ通常addon。
        elif rule.high_reset_mode and last_buy_date and base_high_date(h) and base_high_date(h) > last_buy_date:
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
  - prices はキー単位で新しい fetchedAt 優先、**meta はキー単位で新しい `updatedAt` 優先**（2026-06-13。従来は両端末に同キーがあると local 固定で別端末の更新を握り潰していた）、seq/日時はmax。
  - **列設定 `_colPrefs` は市場ごとに3-wayマージ（`colprefs` 規則・2026-06-13）**: 市場単位で内容を比較し、編集時刻 `_ts[market]` の**新しい方を採用**。`_ts` は **ユーザーが実際に列を編集した時だけ**更新（`touchColPrefs`）し、画面表示に伴う `reconcileColPrefs`/`resetColPrefs`（新列補完・初回生成）では更新しない。これにより「別端末でタブを開いただけ」の受動的な列補完が、他端末の本物の編集を上書き＝巻き戻す事故を防ぐ（旧 `single` 規則は base から変化していれば局所優先で、受動変化でも local が勝ち巻き戻していた）。`_ts` が両端末とも無い市場は従来どおり base 基準にフォールバック。
  - **`settings` は `singleTs` 規則（2026-06-13）**: 両端末で変更された時は `_updatedAt` の新しい方を採用（無ければ local）。Google 連携設定を2端末で別々に編集した際の取りこぼしを防ぐ。
  - **マスタ系の同期規則（2026-06-30）**: 従来 SCHEMA 未登録で `single`（ローカル優先・時刻無視）扱いだったマスタを正しく登録。`cfRules`（背景色ルール）/`grades`（格付け色）/`_filterPresets`（フィルタ保存）＝**records ＋ `updatedAt`**（id・grade をキーに新しい方）、`matrixBands`（マトリックスのレンジ＝順序つき配列）＝**`pairTs`**（配列は `_updatedAt` を持てないため相方 `matrixSettings._updatedAt` を編集時刻として参照）、`matrixSettings`＝**`singleTs`**、`mktRanking`（キャッシュ）＝**map（`at` の新しい方）**。
    - **`single` 由来の事故**: ①時刻が無く両端末編集で後勝ち/ローカル勝ちで黙って消える ②ロード時に「未登録(undefined)の端末がデフォルトを seed」→そのデフォルトが他端末のカスタムを上書き＝**背景色等がデフォルトに戻る**。
    - **削除はトンボストン**: `cfRules`/`_filterPresets` の削除は配列除去ではなく `deleted:true ＋ updatedAt`。これで削除が他端末へ伝播し、別端末が既定を再シードしても新しい削除が勝つ（勝手に復活しない）。表示・判定（`cfBgFor` 等）は `deleted` を除外。
    - **records 両在比較の修正**: 旧 `a && c && c > a`（両方に updatedAt がある時だけ比較）を **`c > a`** に変更。片側だけ updatedAt を持つ場合に「持つ方（＝編集された方）」が勝つ（`'' < 実時刻`）。これが seed（updatedAt 無し）に対する別端末の編集を勝たせ、デフォルト巻き戻しを防ぐ。
    - **既定idの固定化**: `defaultCfRules()` は固定id `cf_def_<col>`。ランダムidだと端末ごとに別idの既定が生まれ records マージで重複合算するため。旧ランダムid既定は `cfNormalizeDefaultIds`（ranges 一致で判定）で固定idへ寄せる（冪等）。seed 段階では updatedAt を付けず（remote の編集に負ける）、`resetCfRules` 操作時のみ updatedAt を打つ。
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

### 15.3 資産推移（日次スナップショット・2026-06-13）
- 目的: 総資産（円換算）の時系列グラフをレポートに表示。**毎朝の通知cronに相乗り**して日次で蓄積（アプリ未起動でも貯まる）。
- **保存先＝別ファイル `portfolio-history.json`**（`securities-manager` フォルダ内）。`data.json`(同期本体)とは別にすることで、アプリの3-wayマージ同期と**競合しない**。
- 書込: `notify-run` が判定後に `computeTotalsJpy(bundle)`（保有>0のJP/US合算・為替未取得の米株は除外）で当日(JST)の `{date,totalJpy,costJpy}` を `writePortfolioSnapshot`（`functions/lib/sheets.js`）で upsert（同日上書き・best-effort、失敗は応答 `snapshot.error` に記録し通知は継続）。**SAに `drive`(書込)スコープ＋フォルダを「編集者」共有**が必要。
- 読取: `GET /api/portfolio-history`。総資産は機微なため**クライアントのGoogleアクセストークンを検証**（`tokeninfo`で email/aud 取得→aud=本アプリclientId＋allowedEmails一致のみ許可）。クライアントは `gsync._token` を Authorization に付与。
- 表示: `renderReport` の従来「対応予定」注記を置換し、`loadPortfolioChart()` が `/api/portfolio-history` を取得して `detailSvgChart`（実線=総資産/破線=取得原価）で描画。**今日以降のみ蓄積**（過去遡及なし）。
- セットアップ（すみぽん）: Driveの `securities-manager` フォルダを `GOOGLE_SA_EMAIL` に**「編集者」で共有**（従来は閲覧者）。これだけで cron が日次記録を開始。

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

## 16. ニュースタブ（フェーズN1・2026-07-18）

全体は5フェーズ構成（N1=基盤 / N2=銘柄紐付け・銘柄別表示 / N3=YouTube要約(Gemini) / N4=開示・決算(TDnet/EDGAR) / N5=X連携[有料・費用判断後]）。本節はN1。

### 16.1 取得（functions/api/news.js）
- `GET /api/news` → `{ items:[{title,link,source,pubDate}], at }`。無料RSSのみ・見出し＋リンク＋時刻だけ返す（本文は取得しない＝著作権配慮。クリックで元記事へ）。
- フィード: Yahoo!ニュース経済トピックス / Yahoo!ニュース経済カテゴリ（broad） / NHK経済(cat5)。リンクで重複排除・新しい順・最大120件。エッジ5分キャッシュ（cf.cacheTtl）。
- **broadフィードは `MARKET_RE`（株/金利/決算…のキーワード正規表現）に一致する見出しだけ通す**。Yahoo!経済カテゴリは車・生活・エンタメ記事が大半のため必須（全通しにするとニュースタブがノイズで埋まる）。
- Yahoo!見出し末尾の「(配信元)」は分離して source に採用（表示は「ロイター」等になる）。
- Workers に DOMParser は無いので RSS は正規表現でパース（`<item>`→title/link/pubDate）。

### 16.2 表示（app.js renderNews）
- ナビ「メイン>ニュース」。見出し一覧（未読=太字＋青ドット）＋配信元＋相対時刻、クリックで元記事を新規タブ表示。
- カテゴリはクライアント側キーワード判定 `newsCategory(title)`（判定順=特異度順: 決算→為替・金利→市況→その他）。segボタンで絞り込み。
- 記事一覧は**メモリキャッシュのみ**（`_newsCache`。RSS取得は無料なので永続化しない）。タブを開いた時に自動取得、キャッシュ5分超で裏更新。取得完了時は `currentView==='news'` を確認してから描画（別タブ上書き防止・§マーケットと同じ）。
- 一覧は `.table-wrap` に入れて枠内スクロール（`fitListTables` の対象。main.content はスクロールさせない）。

### 16.3 既読（唯一の永続データ）
- `store.data.newsRead = { link: 読了ISO }`。クリック時に記録し **45日より古いエントリは自動掃除**（同期データの肥大防止）。
- **sync-merge.js SCHEMA に `newsRead:['map',null]` 登録済み**（キー単位3-way。端末間で既読が同期される）。
- 将来のN3（YouTube要約）は「1動画=世界で1回生成」のためサーバー側共有キャッシュ方式を予定（端末単位で再生成しない）。

### 16.4 銘柄紐付け・銘柄別ニュース（フェーズN2・2026-07-18）
- **マッチング（クライアント）**: `newsSecHit(title, sec)`。銘柄ごとの照合パターンは `_newsPat`（Mapキャッシュ。storeへは保存しない）。
  - 日本語名: 会社種別除去＋略称エイリアス自動生成（トヨタ自動車→トヨタ〔先頭カタカナ語〕/ 〜グループ→〜・〜G / 〜ホールディングス→〜HD・〜）
  - 英語名: Inc/Corp等を除去して単語境界マッチ。USティッカーは3〜5文字のみ照合（A/IT等の1〜2文字は誤検知するため対象外）
  - JPコード: 4桁を数字境界で照合（後続が円/万/億/兆なら金額の一部とみなし除外）
  - **米国主要銘柄はカタカナ辞書 `NEWS_US_ALIAS`**（AAPL→アップル 等。日本語見出しは「米アップル」表記のため）。辞書外はユーザーが nameOverride で補える
- **ニュースタブ**: 各記事に一致銘柄チップ（最大3・クリックで銘柄詳細）＋「関連銘柄のみ」絞り込みトグル
- **銘柄詳細ドロワー**: 「ニュース」欄を追加（`loadSecNews`）。RSSプールの一致分＋米国株は `/api/news?symbol=` の Finnhub company-news（直近14日・キー未設定なら空で自動フォールバック）。リンク重複排除・新しい順12件
- 既読は data-link 方式 `newsReadLink(el)` に統一（タブ・ドロワー共用。newsRead に記録）

### 16.5 取得元拡充・マッチング強化・注目タグ（フェーズN2追補・2026-07-18）
- **取得元（news.js FEEDS）**: 日経マーケット（assets.wor.jp・全通し良質）／日経ビジネス（公式RDF）／東洋経済・ダイヤモンド・日経ニュース総合・Yahoo経済カテゴリ（broad=MARKET_RE絞り込み）／Yahoo経済トピックス・NHK経済（全通し）。
  - **ブルームバーグ・ロイター日本語は取得不可**（CFから403/404。本文有料）。日経本体は公式RSSが無く第三者(assets.wor.jp)再配信＝継続性リスクありのため複数ソース構成。
  - **タイトル正規化**: 「見出し｜カテゴリ｜媒体名」形式（東洋経済等）は先頭セグメントだけ採用。媒体名「東洋経済オンライン」の"経済"がMARKET_REや銘柄名に誤ヒットするのを防ぐ（重要）。Yahooの「(媒体名)」接尾辞は splitSuffix フィードのみ分離。
  - **各フィード6秒タイムアウト**（AbortController）。遅い1本で全体が止まらないように（実測20秒→6秒上限）。クライアントも25秒の保険タイムアウト＋newsBusyをfinallyで確実解除。
  - RSS1.0(RDF)/2.0/Atom対応（linkは要素値/href属性の両対応、日付は pubDate/dc:date/updated/published）。
- **マッチング強化（app.js）**: `newsSecHit` を searchNorm ベースに変更（NFKCで半角全角統一・カナ/かな吸収）。「ＮＴＴ/NTT」「９４３２/9432」等の表記ゆれを吸収。
  - 日本株通称辞書 `NEWS_JP_ALIAS`（9432→NTT、9022→JR東海、9984→ソフトバンクG/SBG 等・約60銘柄）。正式名と見出し通称が乖離する銘柄を補う。
- **注目タグ `store.data.newsTags`**（フェーズN2）: 保有登録なしの企業/人物/テーマ名。見出し一致で保有銘柄（青）とは別色（グレー破線）チップを表示・**クリックしても銘柄画面は開かない**。ニュースタブの「注目タグ」ボタンで改行区切り一括編集。「関連のみ」絞り込みは銘柄＋注目タグの両方を対象。sync SCHEMA `newsTags:['records', name]` 登録済み（同期）。

### 16.6 本文（要約）マッチング（フェーズN2追補2・2026-07-18）
- `/api/news` の各記事に `desc`（description/summary/content から抽出・HTMLタグ除去・200字上限）を追加。RSSに入るのは**記事全文でなく要約スニペット**（全文はスクレイピングになるため取得しない）。
- 本文が取れるフィード: NHK・東洋経済・ダイヤモンド・日経ビジネス・ブルームバーグ等（実測78/120件）。日経マーケット(RDF)・Yahooは本文なし＝見出しのみ。
- クライアントのマッチングを見出し＋本文の合算テキスト（`newsText(it)`）で判定するよう変更（`newsSecHit`/`newsMatchSecs`/`newsMatchTags`）。見出しに社名が無くても本文言及で拾える（例:「逆襲のファーウェイ」見出しの記事を本文の"トヨタ"で拾う）。
- 調査メモ（取得可否の実測）: ブルームバーグ**英語版**(feeds.bloomberg.com/markets|technology|economics)は200で取得可（本文付き・ただし英語）。**日本語版は不可**。株探・みんかぶは公式RSS無し（Yahoo配信も404）＝取得不可。TDnet適時開示は webapi.yanoshin.jp 経由でRSS取得可（N4候補・300件）。上場銘柄マスタはJPX公式がExcelバイナリで機械処理困難、手軽なJSON配布は未発見。

### 16.7 主要銘柄の自動タグ＋ブルームバーグ英語版（フェーズN2追補3・2026-07-18）
- **自動タグ（保有外の主要上場銘柄）**: `NEWS_MAJORS`（NEWS_JP_ALIAS＋NEWS_US_ALIAS＝コード付きの主要約120社を再利用）。見出し＋本文に一致し、かつ**保有登録なし・注目タグでも未表示**の銘柄を枠線チップ（.news-listed）で表示。**クリックで株探**（mktKabutan・新規タブ）。保有済みは青チップ・注目タグはグレーで出るので三者は排他表示。
  - 誤検知抑制: 照合語は「3文字以上」または「2文字以上かつ非ASCII（日立・東芝等）」のみ（JT/au等の短ASCIIを除外）。「JR東」のような部分一致する短縮別名は辞書から除去（JR東海がJR東日本に誤ヒットした問題を修正）。
  - 「関連のみ」フィルタの対象は保有銘柄＋注目タグのみ（自動タグは含めない＝ほぼ全記事が該当し絞り込みが無意味になるため）。
  - **将来**: 全上場マスタ（JPX約3900社）取込に対応予定（すみぽん選択=主要辞書＋後で全取込）。取込後はマイナー銘柄も対象・クリックで詳細/株探。
- **ブルームバーグ英語版**: feeds.bloomberg.com の markets/economics を追加（source='Bloomberg'）。**英語見出し**（米国株・マクロ向け）。更新頻度が高いので `max`（8/6件）で件数を抑え日本語ソースを圧迫しない。日本語版は取得不可のため英語版のみ。
- **フィード件数上限 `max`**: 更新頻度の高いフィードの寄与件数を制限（一覧が特定ソースに偏るのを防ぐ）。

### 16.8 非表示（除外）機能（フェーズN2追補4・2026-07-18）
- `store.data.newsHidden`（記事リンク→非表示日時ISO）。**既読とは別**の「一覧から消す」操作。45日で自動掃除・sync SCHEMA `newsHidden:['map',null]` 登録済み（同期）。
- 各記事の右上に✕（ホバーで出現）。クリックで一覧から除外（リンク遷移はさせない）。
- ヘッダに「表示中を非表示」（現在の絞り込み結果を一括除外・confirm確認）／「非表示 N」（非表示一覧を開く）。
- 非表示一覧では各行「戻す」＋「すべて解除」で復元可（誤操作に対応）。非表示はセッションの取得プール内のもののみ表示（RSSは永続保存しないため、再取得で消えた古い記事は一覧に出ない＝実害なし）。
- 未読カウントは非表示分を除外して算出。

### 16.9 英語ニュースの日本語訳＋要約パネル（フェーズN2追補5・2026-07-18）
- **翻訳（`/api/translate`）**: Google翻訳の非公式エンドポイント(gtx)を利用。**公式APIではなく規約グレー・暫定**（壊れたらクライアントが原文=英語にフォールバック）。将来は Gemini/DeepL 等へ差し替え可能。エッジ1日キャッシュ＋8秒タイムアウト。
  - 翻訳対象＝英語フィード（Bloomberg、`lang:'en'` を付与）。見出し＋要約を翻訳し `store.data.newsTrans`（リンク→{t,d,at}）にキャッシュ＝**1記事1回だけ翻訳・端末間同期**（sync SCHEMA `newsTrans:['map',null]`・30日で掃除）。
  - `newsTranslatePending()` が未翻訳の英語記事を裏で順次翻訳→完了後に再描画（多重起動ガード・最大20件/回）。一覧は翻訳があれば日本語（「訳」バッジ）、無ければ原文（「EN」バッジ）。
- **要約パネル（`newsOpenArticle`）**: 記事クリックで**元記事へ直接飛ばず**アプリ内モーダルを表示。見出し（英語は訳＋原題）／配信元・時刻／一致銘柄チップ／**配信元の要約（英語は翻訳）**／「元記事を開く」。
  - **全文はRSSに無く取得しない**（スクレイピング回避）。表示できるのは配信元の要約まで＝パネルにその旨を明記。要約が無い記事（日経マーケット/Yahoo等）は「要約なし・元記事へ」を表示。

### 16.10 翻訳バッチ化・非表示スクロール維持・期間フィルタ（フェーズN2追補6・2026-07-18）
- **翻訳バッチ化（EN残り対策）**: `/api/translate` を複数q対応に（clients5 dict-chrome-ex＝1リクエストで全件翻訳→gtx単体フォールバック）。**見出しは1リクエストで一括翻訳**しレート制限を回避（本番でENが残る＝逐次呼びで弾かれていた対策）。本文(要約)はパネルを開いた時に遅延翻訳（上限を下げる）。
- **非表示のスクロール維持**: ✕押下時は全体再描画せず**該当行だけDOMから削除**＋ヘッダ件数のみ更新（`_newsUpdateHeaderCounts`）。一覧が上に戻らない。
- **期間フィルタ**: 全期間/24時間/3日/7日（`newsDays`・pubDateで絞り込み）。

## 17. 開示・決算（フェーズN4・2026-07-18）
N3(YouTube要約)より先に実施（すみぽん指示）。SEC(EDGAR)は英語のため日本語ラベル化。

### 17.1 取得（functions/api/disclosure.js）
- `GET /api/disclosure?recent=1[&limit]` → TDnet直近の適時開示（日本株・全社）。yanoshin webapi(JSON)。
- `GET /api/disclosure?market=JP&code=7203` → TDnet 銘柄別（company_codeは5桁=末尾0付きなので先頭4桁に正規化）。
- `GET /api/disclosure?market=US&ticker=AAPL` → SEC EDGAR 銘柄別（browse-edgar ATOM・ティッカー直指定可）。**form種別を日本語ラベル化**（10-Q→四半期報告書 等・`EDGAR_FORM_JP`）。内部者取引(3/4/5)/144/SD等の定型ノイズは除外し、決算/重要事象/年次・四半期/株主総会/登録届出のみ採用（`KEEP`）。
- 正規化アイテム: `{code, company, title, link, pubDate, form, market, kind}`。kind='earnings'(決算/業績/配当) | 'disclosure'。日付は TDnet=JST / EDGAR=日付のみ を吸収（`isoOf`）。UA・8秒タイムアウト・エッジ5分キャッシュ。

### 17.2 表示
- **銘柄詳細ドロワー**: 「開示・決算」欄を新設（`loadSecDisc`）。JP=TDnet銘柄別 / US=EDGAR銘柄別。決算=橙/開示=グレーのチップ、クリックで原本(PDF/EDGAR)。
- **ニュースタブ**: TDnet直近開示のうち**登録銘柄(JP)に一致するものだけ**を一覧に合流（`_newsDiscForHoldings`・source='適時開示'）。カテゴリ「開示」を新設（`newsCategory`は開示アイテムの `cat` を優先）。保有銘柄が開示した時に自動で一覧・「開示」絞り込みに出る。
- 銘柄マッチングはコード一致で確実（見出しの表記ゆれに依存しない）。

### 17.3 開示の改善（フェーズN4追補・2026-07-18）
- **取得範囲を拡大**: ニュースタブの開示合流を「直近全社120件のフィルタ」から**保有銘柄ごとの取得**に変更。`/api/disclosure?codes=7203,6758,...`（TDnetを銘柄別に並行取得しマージ・最大40銘柄×各5件）＋米国株は EDGAR を銘柄別に並行取得（最大12銘柄×各4件）。→ 保有銘柄の開示が漏れなく出る（従来は直近に無いと0件）。
- **銘柄タグ表示**: 開示アイテムに `code` を付与し、`newsMatchSecs` を**コード一致でも紐付け**るよう変更。開示に銘柄チップが出る（TDnet見出しは社名を含まないため必須）。
- **要約なしは直接リンク**: `newsOpenArticle` は `it.desc` が無い記事（開示・日経マーケット・Yahoo等）はパネルを出さず**一発で元記事(PDF/EDGAR)を開く**。要約があるもの（NHK/東洋経済/ダイヤ/Bloomberg）だけパネル表示。
- **翻訳の事前一括化**: 英語記事の「見出し＋本文(要約)」を1リクエストでまとめて翻訳・キャッシュ（パネルを開いた時の個別翻訳失敗を解消）。
- **一括非表示ボタンを撤去**（「表示中を非表示」は誤操作リスクが高く不要との判断）。非表示は1件ずつ✕＋「非表示」一覧から復元。

### 17.4 開示の細分類・表示設定・翻訳再試行（フェーズN4追補2・2026-07-18）
- **開示の細分類 `disclosureType`**: TDnet/EDGARの見出し・書類種別を細かく分類（決算/業績修正/配当/自己株取得/自己株処分/株式分割/株式報酬/人事/M&A・組織/重要事象(8-K)/株主総会/訂正・変更/その他開示）。一覧・ドロワーのチップに細分類ラベルを表示。
- **表示設定 `store.data.newsPrefs`**（`{hideCats, hideDiscTypes}`・sync singleTs）: ニュースタブの「表示設定」ボタンから、①「すべて」タブに出すカテゴリ、②表示する開示の種類 をチェックで選択。除外カテゴリは「すべて」でのみ隠す（個別カテゴリを押せば見える）／除外した開示種類は全カテゴリで隠す（例：自己株取得を外すと決算から自社株買いが消える）。`_newsCurrentEntries` で適用。
- **翻訳の再試行**: 未翻訳のまま（失敗）の英語記事も、`_newsTransTried`（非永続・5分ゲート）で時間をあけて再試行するよう変更（「取得済み＝翻訳済み」ではない問題を解消）。見出し済み・要約未訳の記事も対象。
- **スクロールバー操作**: 記事リンクに `draggable="false"` ＋ `-webkit-user-drag:none`（スクロールバーのドラッグがリンクのドラッグに奪われないように）。
- ドロワーのニュース欄「なし」表示を短く（長文の折返しを解消）。

### 17.5 銘柄別ニュース・開示 専用画面（フェーズN4追補3・2026-07-18）
- 詳細ドロワーのインライン「ニュース」「開示・決算」欄を**撤去**（件数が増えると下の情報を圧迫する問題の解消）。
- 代わりに詳細ドロワーのフッター（取引/保有/編集の**左**）と銘柄カルテのアクションに「📰 ニュース・開示」ボタンを追加。
- ボタンで**専用画面（wideモーダル `openSecNews`）**を開く: 左=ニュース（RSS見出し一致＋US=Finnhub）/ 右=開示（TDnet/EDGAR）の2カラム（狭い時1カラム・各内側スクロール）。
- 開示は**細分類ボタンで複数選択フィルタ**（`_secNewsCtx.typeSel`・初期＝存在する全種類・「すべて」トグル）。存在する種類のボタンだけ出す。

### 16.11 ニュース: カテゴリ複数選択トグル・市場フィルタ・専用画面固定・ドラッグスクロール（2026-07-19）
- **カテゴリを複数選択トグル化**: 設定モーダルではなくツールバーのボタンで即切替（市況/決算/開示/為替金利/その他＋すべて）。選択状態は `newsPrefs.hideCats`（非表示カテゴリ）に**永続保存＆同期**。「すべて」で全表示・全部外すと自動で全表示に戻す。旧「表示設定」モーダルはカテゴリ欄を撤去し**開示の種類のみ**に。
- **市場フィルタ**: 全市場/日本株/米国株（`newsMkt`）。関連銘柄の市場＋開示元（TDnet=JP/EDGAR=US）＋英語(Bloomberg=US)で判定。市場情報のない一般ニュースは常に表示。
- **専用画面（銘柄別ニュース・開示）を固定サイズに**: モーダルに `fixHeight`（`.modal-fixh`）＝高さ `min(78vh,820px)` 固定、内側だけスクロール。件数でウィンドウが伸縮しない。開示の分類ボタンはスクロール領域の外（固定）へ。
- **ドラッグでスクロール**: `.news-wrap`/`.sec-news-scroll` を左ドラッグでスクロール（`initNewsDragScroll`・4px超で発動しクリックは抑止）。cursor=grab/grabbing。スクロールバーが掴みにくい/中ボタンautoscrollがリンクに奪われる問題への対処。

### 16.12 開示種類もインライン化・専用画面の英語翻訳・幅も固定（2026-07-19）
- **開示の細分類もインラインのトグル化**: ツールバー別行に「開示: すべて/決算/自己株取得/…」を表示（プールに存在する種類だけ）。選択状態は `newsPrefs.hideDiscTypes` に永続保存＆同期。旧「開示の種類」設定モーダルのボタンは撤去（`openNewsPrefs` は残置・未使用）。
- **銘柄別専用画面の英語ニュースを翻訳**: Finnhub銘柄別ニュース（US）に `lang:'en'` を付与し、`_secNewsTranslate` で見出しをバッチ翻訳→再描画。Bloomberg同様に日本語表示。
- **専用画面モーダルの幅も固定**: `.modal.wide.modal-fixh` に `width: min(1000px,94vw)` を追加。グリッド中央寄せで content 幅になり「小さく開いて広がる」問題を解消（開いた瞬間から一定サイズ）。

## 18. ニュース: 銘柄フィルタ（保有銘柄フィルタ流用）＋開示グルーピング＋翻訳先行（2026-07-19）
- **銘柄フィルタ（`news` スコープ）**: 共通フィルタ機構（`fltState`/`applyColFilters`/`filterPanelHtml`/`filterBtnHtml`）に `news` スコープを追加。ニュースツールバーに「パターン選択＋詳細」を設置し、`filterableCols('news')`＝`NEWS_FILTER_KEYS`（市場/カテゴリ/投資カテゴリ/ラベル/格付/セクター/業種/ルール/種別）で絞れる。条件が有効なとき、`applyColFilters(全JP/US銘柄,'news')` を通った銘柄の記事だけ表示（一致銘柄なしの一般記事は除外）。状態は localStorage 保存・パターンは保有銘柄と共通。
- **開示のグルーピング（タグは細分類・フィルタタブは束ねる）**: `disclosureGroup`＝決算グループ(決算/業績修正/配当/月次)・自己株グループ(取得/処分)・他は個別。フィルタのトグルは `NEWS_DISC_GROUPS`（決算/自己株/…）で束ね、チップ（`disclosureTypeLabel`）は細分類のまま。`月次`種別を新設。`hideDiscTypes` はグループIDで保存。
- **専用画面の英語ニュースを先に翻訳してから描画**（英語のちらつき解消）。Finnhub(US)は `lang:'en'` 付与済み。

### 18.1 開示種別マスタ（ユーザー編集可・2026-07-19）
- 開示の分類はキーワード判定。定義を **`store.data.discTypeDefs`** にデータ化（`DEFAULT_DISC_TYPES` をシード・同期 `['single']`）。各行 `{name(タグ名=ID), group(フィルタタブのまとめ名), keywords(正規表現・| 区切り)}`。上から順に最初に一致した種別のタグが付く。
- **マスタ・設定＞開示種別マスタ**（`openDiscTypeMaster`）で種別名・まとめ・キーワードを追加/編集/削除/並べ替え・既定に戻す。保存時に正規表現を検証。編集は**タグ付けと分類（フィルタタブ）の両方に反映**。
- `disclosureType/Group/Label` はマスタ駆動に変更（`_discRe` で正規表現キャッシュ）。フィルタタブの並びは `discGroupsOrdered()`（定義順＋末尾その他開示）。onclickの種別名は `jsq()` でエスケープ（M&A・重要事象(8-K)等の記号対応）。
- 旧「表示設定」モーダル（openNewsPrefs）は撤去（カテゴリ・開示種別ともインライン化済み）。

### 18.2 銘柄フィルタの補足
- ニュースの銘柄フィルタ（詳細）は他の絞り込みと **AND**（銘柄フィルタ→市場→関連のみ の順で全適用）。銘柄フィルタが有効な時は「関連銘柄の記事のみ」に既に絞られるため、`関連のみ` を足しても結果は変わらない（＝関連のみは登録銘柄・注目タグに一致する記事に絞るトグル、銘柄フィルタはさらにその中を条件で絞る上位互換）。

### 18.3 開示種別マスタの並び替え＋銘柄フィルタ/関連トグルの独立AND化（2026-07-19）
- **開示種別マスタに並び替え（▲▼）**: 行をDOMごと上下移動（入力値保持・再入力不要）。保存はDOM順で読む（判定順＝タグ優先順位に反映）。
- **銘柄フィルタと「保有・注目のみ」を独立したAND**に変更:
  - 銘柄フィルタ（詳細）: 銘柄に紐づく記事のうち条件に合う銘柄だけ残す。**一般ニュース（銘柄一致なし）は落とさない**（`ms.length===0 || ms.some(...allow)`）。
  - 「関連のみ」→**「保有・注目のみ」に改名**: 保有銘柄・注目タグに関連しない一般ニュースを除外するトグル。
  - 両者はAND。例: フィルタ(米国株)のみ=一般107＋AAPL6=113件／＋保有・注目のみ=AAPL6件のみ。

### 18.4 ニュース銘柄フィルタに保有状況＋トグル改名（2026-07-19）
- **銘柄フィルタに「保有状況（保有/未保有）」項目を追加**（`fltSelectSpec('held')`＝`calc.totalHolding().qty>0`判定・`NEWS_FILTER_KEYS`先頭）。未保有だけ/保有だけで絞れる。→「未保有だけにしても保有株が消えない」＝保有状況の絞り込み項目自体が無かったのが原因。
- **「保有・注目のみ」→「一般ニュース除外」に改名**（挙動同じ＝保有・注目タグに無関係の一般ニュースを除外）。
