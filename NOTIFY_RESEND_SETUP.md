# メール通知（Resend）の準備（通知 N3 の前提）

> 買い増しサインをメールで受け取るための準備。Resend = メールをプログラムから送るサービス。
> 関連: `NOTIFICATION_PLAN.md` / Notion「📋 通知機能 実装計画・実施順（SEC-98）」

## Resend とは（噛み砕き）
- 自前のメールサーバー（SMTP）を用意しなくても、**APIキー1つでメールを送れる**サービス。
- 無料枠：**100通/日・3,000通/月**（通知は1日数通なので十分）。
- 公式: https://resend.com

---

## 手順

### 1. Resend にログイン / 登録
- ログイン: https://resend.com/login
- 新規登録: https://resend.com/signup
  - （以前「既存のResendアカウントが使える」とのことだったので、あればそれでOK）

### 2. APIキーを発行
1. https://resend.com/api-keys を開く
2. 「**Create API Key**」→ 名前（例 `securities-manager`）→ 権限は「**Sending access**」でOK →「Add」
3. **`re_` で始まるキーが一度だけ表示される**のでコピー（⚠️秘密・再表示されないので無くしたら作り直し）

### 3. 送信元(From)について ＝ お手軽方式なら「設定不要」
- 送信元(From)は**Resendダッシュボードで設定する項目ではなく、送信時にコード側で指定**します。
- **お手軽（今はこれ）**：コード側で `onboarding@resend.dev` を使う（Claudeが実装）。**あなたは何もしなくてOK**。`NOTIFY_FROM` も未設定で可。
  - ⚠️ この送信元は、**送信先が「あなたがResendに登録したメール」宛てに限定**されます（＝自分宛て通知なら問題なし。手順4の `NOTIFY_EMAIL` をResend登録メールと同じにする）。
- **本格（将来だけ）**：自分のドメインから送りたい時だけ、https://resend.com/domains でドメイン登録・DNS認証 → そのドメインのFromを使う。今はやらない。

### 4. Cloudflare に登録（環境変数）
Workers & Pages → プロジェクト → Settings → Environment variables（**Production**）に追加：

| 変数名 | 値 | 暗号化 |
|---|---|---|
| `RESEND_API_KEY` | 手順2の `re_…` キー | ✅必須 |
| `NOTIFY_EMAIL` | 通知の**受信先**メール（お手軽方式なら**Resend登録メールと同じにする**） | 任意 |
| `NOTIFY_FROM` | 送信元。未設定なら `onboarding@resend.dev` を使用（任意） | 任意 |

保存 → 再デプロイで反映。

### 5. 完了したら Claude に一言
「Resendキー登録した」と教えてください。私が送信コード（N3）を書いて、**テスト送信→実際にメールが届くか**を確認します。

---

## まとめ（最短ルート）
1. https://resend.com/api-keys でキー発行（`re_…`）
2. Cloudflare に `RESEND_API_KEY`（暗号化）＋ `NOTIFY_EMAIL`（=Resend登録メール）を登録
3. 「登録した」と連絡 → Claudeが送信実装＆テスト

これだけで「自分宛てに買い増しサインのメールが届く」ところまで行けます。
