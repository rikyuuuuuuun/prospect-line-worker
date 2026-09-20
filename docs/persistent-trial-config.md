# LIFF 起動設定の永続化

## 実コードで確認した遅延経路

監査元: `prospect-line-worker` c01a93c935eb4eee0f7135dbcac6d5876014c2c1、`prospect-gas` e80a13ea8c8165f2efbf07ad983ab4cdf6576eb6。
両リポジトリの全ファイルを取得・確認。GAS catalog は line-reception を除外している。
別途、体験管理シートに紐づく Apps Script のコードをブラウザで読み取り、既存のカレンダー解析・クラス解析・保存処理を確認した。既存コードは変更せず、TrialConfigSync.gsを追加して初回同期を実行済み。既存予約Webアプリのデプロイは変更していない。

```
LINE → URL/HTML（GAS通信なし、未計測）→ inline JS
 ├ 子ども入力欄表示（既存実装でも先行表示）
 ├ SDK async → liff.init → context/ID token → LINE session API（非同期）
 └ availability API → daily DO（期限内なら返却）
                       └期限切れ/空 → edge cache → GAS（最大8秒）→ Sheets
                         → 日程/クラス → 選択操作可能
```

1. High: `worker.js/readDailySnapshot_` の24時間期限切れで `core.fetch` → `index.js/handleReservationAvailability_` → GASへ戻る。日次更新が失敗すると遅延・障害が利用者に波及する。
2. High: 元の cron は30会場を逐次refresh。元GASは全会場一括取得関数も持つが、Worker側は各会場経路を使っていた。未実測なのでCPUやSheetsが何msとは断定しない。
3. Medium: daily snapshotはJST日付跨ぎで過去日を表示し得た。新経路は配信時に今日〜翌月末へ絞る。
4. Medium: LIFF SDK/initとLINE本人確認は外部依存。設定経路を直してもLINEが遅ければ送信開始は待つ。プロフィール取得は体験予約起動経路にはない。
5. Low: `index.js` のフォームDOMは小規模。日付・クラス各取得は1回、LIFFとは既に並列。架空のPromise.all改善は加えていない。

## 新しい起動経路

```
HTML → inline JS → 子ども入力
              ├ LIFF SDK/init → LINE session（既存）
              └ POST /api/reservations/availability（互換URL、1回）
                 → 永続DO設定読取 → 日付範囲フィルタ・短期証明署名 → 操作可能
```

`GET /trial-config?route=...` も同じ設定を返す。既存HTMLが残る端末を壊さないため、フロントのPOST URLを維持。どちらもGAS・Sheets・LINEへ設定取得を転送しない。端末キャッシュは持たず、毎回 `no-store` で取得する。

既存 `AvailabilitySnapshot` の名前 `trial-config-v1` を使用し、全30会場を1トランザクションで保存。各会場は別キーのためDOの単一値サイズ制限にも依存しない。ソース設定にTTL/失効なし。古いdailyキーは破壊せず、切り戻し可能。予約Outboxは変更していない。

更新: `POST /internal/trial-config`。既存GAS_FORWARD_KEYを用途分離したHMACに使う。5分以内の署名・全30会場・クラス・日付・サイズを検証。古いrevision/同revision別内容を拒否。内容不変なら会場データを書き直さず順序用revisionのみ進める。署名・秘密・個人情報はログに出さない。

未初期化・DO障害時は503と入力保持/再試行。GASへフォールバックしない。永続保存済み設定があればGAS障害中も使える。DO自体の障害を無停止にする設計ではない。

`generatedAt` は同期revision、`policyIssuedAt` は送信用証明の新規発行時刻。ソース取得時刻を今日に偽装しない。既存の24時間証明・本人認証・予約保存前の過去日/クラス/受付区分検証は維持。すでに開いたフォームは既存仕様どおり証明期限まで旧表示で申し込める（最大24時間）。新たに開くフォームは更新直後の設定を取得する。

## GAS同期と変更経路

追加ファイル: `gas/TrialConfigSync.gs`。既存LINE受信プロジェクトへ追加するモジュールであり、受信コード全文の置換ではない。
確認したプロジェクト: `1zWch6bz8H6L1WJhb-Tbt5xfUTyzJnf49shac_WM8SFcWKR0M-E9Uwe9Z`。ブラウザで見たHEADと現在公開されているWebアプリのバージョン一致までは未確認。

既存関数 `readProspectCalendarAvailabilityValues_` / `readProspectClassAvailabilityAllLive_` / `selectProspectClassAvailability_` / `resolveProspectReservationFixedClass_` を再利用。会場別名、○の日付、同曜日隣接列、上尾富士見1コマ、宗岡第二3クラスを独自に再定義しない。

| 変更経路 | 同期方法 |
| --- | --- |
| マスター15_LINE体験受付設定 A:H の直接編集 | 対象範囲のinstallable onEdit |
| 活動カレンダー月タブの直接編集 | 同上 |
| A/B/C/D運営入力→`運営入力受付同期.js/applyTeamReceptionRows_` のsetValues | 15分のファイル更新日時watchdogで検知 |
| `syncATeam...`等、`reconcile...`、他のSheets API/スクリプト書込み | 同じwatchdogで検知。書込み側の修正漏れに依存しない |
| 行追加/削除、月タブ変更、失敗したpush | watchdogで検知・再試行 |

onEditはAPI/スクリプト書込みで発火しない: [Google公式制約](https://developers.google.com/apps-script/guides/triggers/installable#restrictions)。そのためonEditだけには依存しない。
watchdogはDriveの更新日時2件だけを確認し、不変ならSheets読み取り0。ファイル更新があれば範囲を読む。内容ハッシュが同じなら日程生成・pushは省略。予約保存など同じマスターファイルの別タブ更新でも範囲の再読取は発生し得るが、LIFFリクエストとは独立。未知の外部IMPORT関数の自動再計算など、Drive更新日時が変わらない経路は未検証。

変更時のSheets操作: カレンダーopenById 1、getSheets 1、月タブごと最大120行×14列のgetDisplayValues 1（最大12回）、既存クラス関数のマスターopenById 1/getSheetByName 1/getDisplayValues 1。1会場ごとの再読取ではない。getValue/getValues/setValue/setValuesはこの新同期モジュールで0。既存予約保存・運営同期の書込みには触らない。
日程はカレンダーにある各月を保存するため、月替わりだけを理由にSheetsへ再取得しない。ただし未作成の将来日程を自動生成はしない。

## リリース手順

1. 同期モジュールを対象GASへ追加し、既存秘密値をコピーせず同プロジェクトの `LINE_WEBHOOK_FORWARD_KEY` を利用。`PROSPECT_TRIAL_CONFIG_URL` に対象Workerの `/internal/trial-config` URLを設定する。
2. Drive metadata読取など追加権限が必要なら、管理者の認可を完了する。対象の2編集トリガー+15分watchdog以外の既存トリガーを変更しない。
3. 初回は `TRIAL_CONFIG_BRIDGE_ONLY=true` を明示した橋渡しdeployを行う。このモードだけPOSTを保存した旧 `legacy-availability.js` に接続し、push/RPC/GET設定読取を先行利用できる。同期・全30会場のGET内容比較を完了した後、フラグを明示的にfalseにして本設定をdeployする。通常モードに自動GASフォールバックはない。**空ストアのまま本PRをmainへmergeしない**。本リポジトリはmainが本番自動deploy対象。橋渡し期間中は日次cronを止めるため、初期同期・切替を同じ作業時間内に行い、失敗なら旧バージョンへ戻す。
4. `syncProspectTrialConfig` は明示的な再送/復旧用。成功後 `installProspectTrialConfigSync` でwatchdog等を導入し、手編集および運営同期の両方が反映されることを確認する。
5. 実機LINEでA/B/C/Dと単一/3クラス、当日/翌月末/過去日、受付停止/待ち、紹介者、控え、保存、重複送信を確認。予約データを無断でテスト登録しない。
6. 問題があれば旧Workerバージョンへ戻す。旧DOデータと予約Outboxを削除していないため切り戻せる。

## 計測

フロント `window.prospectReservationPerformance()` がnavigation/HTML/SDK/init/API/フォーム表示/選択可能/送信可能の時刻を返す。個人情報を含まず自動送信もしない。フォームvisible/paint opportunityはブラウザの実描画完了そのものとは区別する。
Worker `Server-Timing: config, gas, worker` と匿名タイミングログ。GASは変更同期時のみ `sheetsMs/processMs/totalMs`。GAS起動前のプラットフォーム待ち時間をGAS内部時計で測定したとは扱わない。

比較用 `scripts/benchmark-startup.mjs` は実ソースをVM/happy-domで動かす。GAS6,000ms、DO10ms、LIFF init900msを固定した模擬外部I/O。HTML受信はローカルResponseであり実HTTP/実描画ではない。coldは旧設定キャッシュMISSを意味し、実Cloudflare/GASコールドスタートの実測ではない。各通常ケース3回の中央値、障害は1回。

| 条件 | 変更前 選択/送信可能 | 変更後 選択/送信可能 |
| --- | ---: | ---: |
| 旧キャッシュMISS、GAS6秒 | 6049.4 / 6049.4ms | 44.0 / 914.0ms |
| 旧キャッシュHIT | 43.1 / 915.4ms | 29.2 / 914.1ms |
| GAS障害 | 約6039ms後エラー、選択不可 | 44.1 / 922.4ms |

枠の初期表示は変更前7.9ms→変更後5.8ms（MISS条件、ローカル）。もともと先行表示済みであり、この差を高速化効果とは主張しない。効果は期限切れ時のGAS依存をなくすこと。実機LINEの3秒/5秒達成、実ネットワークHTML/SDK速度、GAS実行時間、Cloudflare実コールドスタートは未計測。

## 本番切替前の確認（2026-09-20 JST）

- 初回同期成功: 30会場。Sheets 3632ms / 加工554ms / 同期全体9372ms（利用者のリクエスト外）。
- 新GET設定APIの全30会場: 200、61〜159ms、Server-Timing gas=0。
- 旧POST応答と、新GET応答のdates/classes/fixedClassを全30会場でdeepEqual確認。受付状態・時刻を含め一致。
- 本番GASへ2つの編集トリガーと15分watchdogを設置。
- 最終切替はTRIAL_CONFIG_BRIDGE_ONLY=falseの明示設定。元のbridge版へ戻す場合はtrueを再deploy。
- 実機LINEの起動から送信までのE2E時間と実予約登録は別途未実測。
