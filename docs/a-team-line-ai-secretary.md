# Aチーム LINE AI秘書（承認制）— 導入手順

## 対象・非対象

- 対象：Aチーム7会場のLINE公式チャネルの1対1メッセージ。
- 非対象：B/C/Dチーム、グループ・ルーム、会費ペイWebhook、体験予約LIFF・イベント申込の既存機能。
- LINE署名検証後、既存GASへの転送とは独立に受信イベントをDurable Objectへ複製。
- webhookEventId をキーに受信重複を排除。
- テキストはGPTが日本語の返信案を作成し、代表の管理者トークン＋送信確認操作後だけLINE Push APIで送信。
- 画像・音声・添付は本文を推定せず、「手動確認」とする。LINE公式管理画面で確認すること。
- 過去のLINE会話の遡及取得・マスター過去行の一括登録は現状未実装。機能有効化後の新着が対象。

## 安全な有効化

初期状態は無効です。環境変数 ASSISTANT_ENABLED が完全一致で true にならない限り、Webhook複製もUI/APIも動きません。既存受信経路はそのまま稼働します。

Cloudflare Worker prospect-line-webhook のSecretsに次の値を設定する（GitHubに値を書かない）。

- OPENAI_API_KEY — GPT下書き生成専用のAPIキー。API利用料金はChatGPT月額とは別。
- ASSISTANT_ADMIN_TOKEN — 長さ32文字以上のランダムな管理者トークン。ブラウザの承認画面に入力する。URLやログ、チケットに貼らない。
- LINE公式アカウントのChannel access token。Aチームの必要な会場ごとに設定:
  - LINE_ACCESS_TOKEN_A_SAITAMA_SHIBAKAWA
  - LINE_ACCESS_TOKEN_A_SUGISHITA
  - LINE_ACCESS_TOKEN_A_MIZUHODAI
  - LINE_ACCESS_TOKEN_A_KAMEKUBO
  - LINE_ACCESS_TOKEN_A_AGEO_FUJIMI
  - LINE_ACCESS_TOKEN_A_AGEO_SHIBAKAWA
  - LINE_ACCESS_TOKEN_A_KASUMIGASEKI_NISHI

Variables（非秘密）：
- ASSISTANT_ENABLED=true（最終検証後に設定）
- ASSISTANT_MODEL=gpt-5-mini（利用可能なOpenAI Responses APIモデル名へ変更可能）

従来の GAS_WEBHOOK_URL、GAS_FORWARD_KEY、LINE_SECRET_A_* の値は変更しない。
LINE Developersに登録済みのWebhook URLも変更しない。

## 受信・保存・返信

1. POST /line/a/<会場> の既存署名検証に成功したイベントのうち、一対一の message だけをAI側に保存。LIFF予約フォームの送信とGAS転送は変更なし。
2. LINEのWebhookイベントIDで重複排除。A会場以外のデータはAI受信箱に入れない。
3. Durable ObjectのアラームでGPT下書きを生成。外部API失敗時は draft_failed にし、手動再生成可能。GPTは絶対に直接LINEへ返信しない。
4. Workerの /assistant/ にアクセス。管理者トークンを入力し受信箱を表示。返信案を修正し、確認ダイアログに同意したときだけ送信。
5. 送信前にイベント単位で sending に遷移し、同一メッセージの二重送信操作を拒否。LINE Push APIの結果が不明な場合は send_unknown とし、自動で再送しない。
6. 送信済み・対応不要は90日経過後に保存データを削除。未対応データの保持・消去ルールは業務規程に合わせて決定する。

## 本番運用前に必須の検証

1. PR上で npm test および npm run check を成功させる。
2. Cloudflareから追加Durable Object AssistantInbox の利用が可能なことを確認。
3. LINE開発用または明示されたテストアカウントからA会場にテキストを送り、既存GASとマスターの受信・体験連携が維持されることを確認。
4. Aの受信箱だけに新着が保存され、B/C/Dでは保存されないことを確認。
5. GPTの下書き生成・編集・未承認の非送信を検証。
6. 確認済み宛先に送信承認し、LINE側の到着と履歴を照合。Push通数計上を確認。
7. 再送ボタン連打やWebhook再配信で二重送信が発生しないことを確認。
8. LINEトークン無効・GPT利用制限・GAS障害時の挙動を確認。

## 制限と未完了事項

- 既存受信GASの本番バージョンとLINE DevelopersのWebhook URLの直接照合は別途必要。
- この機能は送信下書きの承認基盤。LINE公式管理画面から手動で返信した事実は現段階で自動反映できない。
- 1イベントごとの下書きです。会話単位での統合や返信スレッドの自動既読同期は今後の改良項目。
- Cloudflare Access等のSSOには未対応。厳格な管理者トークン認証を必須にする。
- 「返信漏れゼロ」の保証はありません。マスターとの未受信照合、期限内エスカレーションの追加が必要。
- Aチャネルのアクセストークン等はCloudflare実設定を確認していないため、現状では本番送信可否は未検証。
- 代表承認までは絶対に自動送信しません。
