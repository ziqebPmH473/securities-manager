# 定時実行（Cron）の結果を Cloudflare ダッシュボードで確認する手順

通知メール（寄り付きランキング 9:10 ／ 買い増しサイン 7:00・11:00・17:00 など）が届かない時に、
定時処理が「動いたか」「何を返したか」を確認する。

## 1. 動いたかどうか（Cron の実行履歴）
1. https://dash.cloudflare.com/ を開いてログインする
2. 左メニューの「コンピューティング（Workers）」→「Workers & Pages」を開く
   （メニュー名が違う場合は、上部の検索欄に `securities-notify-cron` と入れて開く）
3. 一覧から **`securities-notify-cron`** を開く
   ※ 似た名前の `securities-manager-9fno6acdqirgdgb76qks`（Pages＝アプリ本体）ではない方
4. 「設定（Settings）」タブ →「トリガー（Triggers）」の「Cron トリガー（Cron Triggers）」欄で、
   `10 0 * * MON-FRI` などが並んでいることを確認する。近くにある「イベントを表示（View events）」/
   「過去のイベント（Past events）」から、いつ実行され成功/失敗したかの一覧が見られる

## 2. 何を返したか（ログ）
1. 同じ `securities-notify-cron` の画面で「ログ（Logs）」タブを開く
2. 期間を当日の朝（例: 9:05〜9:20）に絞る
3. `[open-ranking]` で始まる行に、送信結果（`status=200 {"ok":true,"sent":...}` や
   `skipped`・`error`）が出ている。この行をコピーして Claude に渡せば原因を特定できる
   ※ ログは 2026-11-18 の設定（observability 有効化）以降の実行分だけ残る
