# YouTube 連携の運用メモ (NEXT_WORK L2)

2026-09-17 調査。**このドキュメントは調査結果であり、YouTube の規約そのものではありません。**
公開運用の前に、下記の出典で最新の内容を確認してください。

## 1. API のレート制限 — **stagecast には適用されません**

NEXT_WORK L2 は「YouTube Live Streaming API のレート制限を確認」としていましたが、
**stagecast は YouTube Data API / Live Streaming API を一切呼んでいません。**

実際に使っている YouTube のエンドポイントは 1 つだけです。

| 用途           | 経路                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 映像・音声送出 | **LiveKit Egress が RTMP で push**。ストリームキーを使うだけで API 呼び出しは無い                                       |
| 字幕送出       | `https://upload.youtube.com/closedcaption?cid=...` へ POST (`services/caption-pipeline/src/sinks/youtube-publisher.ts`) |

したがって **YouTube Data API の 1 日 10,000 units のクォータは消費しません**。
コンプライアンス監査 (quota 引き上げ申請) も現状は不要です。

将来 API を使う機能 (配信の自動作成、タイトル更新、アーカイブ取得など) を足すときに、
初めてこの制約が効いてきます。

### 字幕投入エンドポイントについて

`cid` (caption ingestion URL) は YouTube Studio の配信設定から取得する値で、API キーではありません。
このエンドポイントには公開された明示的なレート制限がありません。stagecast 側では
5xx / 408 / 429 を再試行対象として扱い、失敗しても**配信自体は止めません** (best-effort, N-2)。

### 設定に残っている未使用フィールド

`stagecast/youtube` の Secret と設定画面には `apiKey` / `oauthClientId` / `oauthClientSecret` を
保存できますが、**現状どのコードもこれらを読んでいません** (`usecases/settings.ts` で保存・検証
しているだけ)。将来の OAuth 連携を見越した置き場所です。
「OAuth が設定済みだから API が使える」と誤解しないよう注意してください。

## 2. ストライクと配信停止のリスク

配信が削除・制限されるシナリオは、大きく 2 系統あります。**両者は別カウント**です。

### コミュニティガイドライン違反のストライク

- 初回は**警告**。ポリシートレーニングを受けると 90 日で消える
- 1 回目のストライク: **1 週間**、動画・ライブ配信・投稿ができない
- 2 回目 (90 日以内): **2 週間**の投稿禁止
- 3 回目 (90 日以内): **チャンネルの永久削除**
- ストライクは発行から **90 日**で失効する
- ライブ配信が制限された場合、**14 日間**配信できなくなることがある
- 重大な違反は**一発でチャンネル削除**されうる

### 著作権 (DMCA) 侵害の申し立て

コミュニティガイドラインのストライクとは別系統で、著作権侵害の申し立てによる
ストライクが存在します。異議申し立て (dispute / counter notification) の手続きも別です。

## 3. 運用フロー (案)

**この節は stagecast 固有の提案であり、YouTube の規定ではありません。**

### 配信前

1. 登壇資料と BGM に第三者の著作物が含まれていないか登壇者に確認する
2. 配信するチャンネルの現在の**アカウントの状態**を確認する
   (既にストライクがあると配信できない場合がある)

### 配信中に停止させられた場合

1. **メディアスタックを手動で終了させる** (配信終了操作)。
   YouTube 側で止まっても stagecast の Fargate は動き続け、課金が続きます
2. 録画は S3 に残っているので、原因の確認に使える
3. 登壇者・参加者への連絡

### ストライクを受けた場合

1. YouTube Studio で理由と失効日を確認する
2. 心当たりが無ければ異議申し立てを行う
3. **次の配信日程が禁止期間に重なっていないか確認する** (1 回目なら 1 週間、2 回目なら 2 週間)

## 4. 未確認 (運用者が判断・確認すること)

- [ ] 配信に使うチャンネルの所有者と、ストライクを受けたときの連絡経路
- [ ] 登壇者が持ち込む資料の著作権確認を、申請フォームの段階で取るか
- [ ] 複数チャンネルを使い分けるか (1 チャンネルが止まると全配信が止まる)
- [ ] YouTube の規約は変わるので、公開前に下記出典で最新を確認すること

## 出典

- [Community Guidelines strike basics on YouTube](https://support.google.com/youtube/answer/2802032)
- [Understand copyright strikes](https://support.google.com/youtube/answer/2814000)
- [Avoid restrictions on YouTube live streaming](https://support.google.com/youtube/answer/2853834)
- [Quota and Compliance Audits | YouTube Data API](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)
- [Quota Calculator | YouTube Data API](https://developers.google.com/youtube/v3/determine_quota_cost)
