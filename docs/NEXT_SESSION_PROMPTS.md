# 次セッション用 Claude Code プロンプト集

> R12 残 + R15/R16/R17 admin-web 完了 (2026-06-21) 後の優先順位は [`NEXT_WORK.md`](./NEXT_WORK.md) と [`NEXT_SESSION.md`](./NEXT_SESSION.md) 冒頭参照。
> 本ファイルは **次セッションでそのままコピペして Claude Code に渡せる形式** のプロンプト集。
> 1 プロンプト = 1 PR を想定。 着手前に最新の main を pull してブランチを切ること。

## 使い方

1. 下記から「やりたいタスク」を 1 つ選ぶ
2. **プロンプト (コピペ用)** ブロックの中身を Claude Code に貼り付け
3. Claude Code が PR を起票して auto-merge までやる
4. 実機検証など人手が必要な箇所は Claude Code が依頼を出してくる

## 2026-06-24 時点の優先順位

1. **P-14 (R14)**: Egress fileOutputs (S3 録画) → P-01 完了条件の最後
2. **P-02**: DESIGN.md に KVS WebRTC TURN + composer-template 運用反映
3. **P-04 (R7)**: 統合テスト CI workflow (1 日規模)
4. **P-05 (O 系)**: 運用準備
5. **P-03**: 本番リハーサル

## 完了済み (履歴)

- [P-01] R12 残 → **完了** (PR #119/#120, 2026-06-21)
- ADR 0012 (R15/R16/R17 admin-web) → **完了** (PR #121-#131, 2026-06-21)
- **[P-13] R17-Phase3 stage-web プレビュー → 完了** (PR #134/#135, 2026-06-24) → **要件 1-3 全達成 🎉**

---

## 🔥 すぐやる

### [P-01] R12 残: YouTube Live RTMP 送出の E2E 検証 (完了: PR #119/#120, 2026-06-21)

**目的**: stage-web → SFU は確立済 (R12-followup-22)。 残るは Egress → YouTube Live RTMP 送出が実機で動くか確認。

**プロンプト (コピペ用)**:

````
/loop なし

R12 残作業として、 YouTube Live RTMP 送出の E2E を検証してください。 R12 (stage-web → SFU) は 2026-06-21 に完了済 (PR #115)。 残るのは Egress (RoomComposite で映像を合成 → YouTube RTMP) の動作確認です。

## 前提

- ADR 0010 で SFU と Egress は同一 Fargate Task に sidecar 同居済 (動作確認済み)
- ADR 0011 案 E で KVS WebRTC TURN 経由で stage-web 入室成功済み
- YouTube ストリームキーは admin-web の管理画面で設定する仕様 (R12 で実装済)
- control-api の Egress 起動 API (`POST /events/{id}/egress/start`) は R12 で実装済

## やること

1. AWS ログイン確認 (`aws sts get-caller-identity`)
2. ControlPlane の最新 deploy 確認 (差分があれば deploy)
3. 新規イベント作成 → live 遷移 → stage-web 招待 URL 発行
4. ユーザーに 「stage-web で入室 → カメラ/マイク publish 開始」 を依頼
5. admin-web で YouTube ストリームキー (Studio.youtube.com からコピー) を設定 → Egress 起動
6. ユーザーに YouTube Studio の Live Control Room で映像が届いているか確認依頼
7. Egress の起動ログを CloudWatch で確認 (Chromium ヘッドレスの RoomComposite が動いているか)
8. 不具合があれば R12-followup-23 として原因特定 + 修正 PR
9. 動作確認できたら NEXT_WORK.md の「R12 残」を ✅ に + ADR 0011 を Closed に + memory `r12-livekit-fargate-gotchas.md` に YouTube Live RTMP の確認結果を追記

## 確認ポイント

- Egress container ログで `RoomComposite started` / `RTMP output connected` が出るか
- YouTube Studio で「ライブ配信受信中」と表示されるか (通常 30 秒〜1 分の遅延)
- 配信終了で Egress stop → recording S3 に保存されるか (N1 の artifact UI で確認)

## ハマったら

- LiveKit Egress 公式 docs: https://docs.livekit.io/home/egress/overview/
- 関連 ADR: ADR 0006 (LiveKit デプロイ) / ADR 0010 (Egress sidecar)
- memory `r12-livekit-fargate-gotchas.md` の罠リスト
````

**完了条件**:
- YouTube Live でスピーカー映像 + スライド合成が再生できる
- 配信終了で recording が S3 に出力される
- NEXT_WORK.md R12 行が完全 ✅ に

---

### [P-02] DESIGN.md に KVS WebRTC TURN 運用を追記

**目的**: 設計の正である DESIGN.md に R12-followup-19/22 の決定 (案 E) を反映。 ADR 0011 から本文化して未来のメンテナが迷わないようにする。

**プロンプト (コピペ用)**:

````
DESIGN.md に R12-followup-19/22 で決定した「AWS KVS WebRTC を TURN として使う」運用を追記してください。 ADR 0011 (案 E + D-6 訂正) で詳細が決まっているので、 それを DESIGN.md の該当章に反映します。

## 前提

- ADR 0011: `docs/decisions/0011-livekit-ice-fargate-config.md` (D-1〜D-7 + D-6 訂正)
- R12-followup-19 (PR #110): KVS WebRTC TURN 採用、 control-api /join 拡張、 stage-web rtcConfig.iceServers 直接設定
- R12-followup-22 (PR #114): ips.excludes から VPC CIDR 除去 (R12-followup-9 訂正)
- KVS Signaling Channel は ControlPlane stack に常設 (`infra/lib/control-plane-stack.ts` の `WebRtcSignalingChannel`)

## やること

1. DESIGN.md の 3.2 章 (メディア層構成図) に **「TURN: AWS KVS WebRTC Signaling Channel」** を追記。 SFU と並列の構成要素として表現
2. 7.2 章 (常時稼働リソース) に **「KVS Signaling Channel × 1 (月 $0.03)」** を追加。 N-1 制約と整合することを明記
3. 8 章 (運用) に **AWS KVS WebRTC 関連の監視ポイント** を追記:
   - control-api の `/join` で `GetIceServerConfig` 失敗が CloudWatch logs に出るか
   - KVS Signaling Channel ステータスが ACTIVE か
   - TURN Streaming 利用量の Budget アラート
4. 4.1 章 (制御層 API) の `/join` レスポンス例に `iceServers` フィールドを追記
5. 5.2 章 (stage-web の WebRTC 接続) に `rtcConfig.iceServers` で KVS TURN を直接設定する流れを明記
6. ADR 0011 への参照リンクを各箇所に
7. PR description に「DESIGN.md と ADR の整合性を取った」と明記

## ハマったら

- DESIGN.md の既存章構成を崩さない (構成変更ではなく追記中心)
- 図解 (mermaid 等) があれば KVS WebRTC を追記
- 既存の TURN 関連記述 (もしあれば) は R12-followup-19 で廃止と書き換え
````

**完了条件**:
- DESIGN.md に「TURN: AWS KVS WebRTC」が 4 箇所以上追記
- 既存設計図 (3.2 章) と新規 TURN レイヤーが矛盾しない
- ADR 0011 への参照リンクが本文化されている

---

### [P-03] 本番リハーサル (安定性確認)

**目的**: R12 完了後に「30 分間の継続接続」が破綻しないか実機確認。 公開前の最後の確認。

**プロンプト (コピペ用)**:

````
R12 完了後の本番リハーサルを実施してください。 stage-web 入室 → 30 分継続 で安定性を確認します。

## 前提

- R12-followup-22 までで stage-web の入室は確認済
- AWS KVS WebRTC TURN 経由で動作

## やること

1. AWS ログイン確認
2. ControlPlane の差分 deploy (必要なら)
3. 新規イベント作成 → live → 招待 URL 発行
4. ユーザーに「stage-web で入室 → カメラ/マイク publish → 30 分維持」を依頼
5. その間に CloudWatch Logs で以下を確認:
   - SFU container: error / disconnect の発生数
   - caption-worker: 字幕生成の継続性 (Transcribe / Bedrock 呼び出しエラー無し)
   - control-api: `/join` のレスポンスタイム (p95 < 1s 維持)
   - KVS Signaling Channel: TURN Streaming の異常終了無し
6. 30 分後にユーザーに切断依頼 → 接続状態 (LiveKit room destroy → ECS task stop → reconcile destroy stack) を確認
7. 結果を `docs/operations/rehearsal-2026-06-XX.md` に記録 (テンプレ作成)
8. 不具合 (再接続失敗 / 字幕断絶 / メモリリーク等) があれば NEXT_WORK.md に Followup として追記

## 確認ポイント

- `LiveKit Reconnecting / Reconnected` の頻度 (1 時間に 1〜2 回程度なら許容)
- caption-worker の memory 使用量 (徐々に増えていないか)
- Egress を起動した場合は YouTube Live 側で映像断絶が無いか

## ハマったら

- memory `r12-livekit-fargate-gotchas.md` の罠リスト (10 件)
- ADR 0011 (Fargate ICE 設定の正本)
````

**完了条件**:
- 30 分間 連続で stage-web が SFU 接続を維持
- リハーサル記録ドキュメントが残る
- 発生した issue が NEXT_WORK.md に Followup 化されている

---

## ⏳ 次にやる

### [P-04] R7: 統合テスト CI workflow + YouTube ingestion URL 自動取得

**プロンプト (コピペ用)**:

````
R7 (統合テスト CI workflow + YouTube ingestion URL 自動取得) を実装してください。

## 前提

- NEXT_WORK.md R7 行 / ADR 0005 R7
- 既存の GH Actions: `.github/workflows/deploy.yml` (deploy のみ)
- 既存の test: `RUN_INTEGRATION=1` で integration test を走らせる仕組みは未実装 (CLAUDE.md 参照)

## やること

1. `.github/workflows/integration.yml` を新規作成
2. workflow_dispatch で手動起動。 1 イベントを実 YouTube Live に配信して SLO を観測:
   - イベント作成 (control-api 直接 PUT)
   - status=live → reconcile が EventMediaStack を立てる
   - admin-web 認証 → 招待発行
   - playwright で stage-web に入室 → カメラ/マイクの自動 publish
   - admin-web から YouTube ストリームキーを設定 → Egress 起動
   - YouTube Live API でストリーム受信状態を確認
   - 5 分待つ
   - イベント終了 → reconcile が destroy
3. YouTube ストリームキーは GitHub Secrets で管理 (`YOUTUBE_STREAM_KEY`)
4. SLO 観測項目を CloudWatch Insights クエリで集計:
   - 入室 → SFU 接続成功までの時間 (p95 < 10s)
   - 字幕初出までの時間 (p95 < 5s)
   - YouTube Live 受信遅延 (p95 < 30s)
5. テストの skip 設定: `RUN_INTEGRATION=1` env で local 実行可能に
6. PR description に SLO 結果を含める

## ハマったら

- LiveKit Server SDK (Node.js): `livekit-server-sdk` の RoomServiceClient で room state 確認
- YouTube Live Streaming API: https://developers.google.com/youtube/v3/live/docs
- ADR 0007 (字幕レジリエンス) も参照
````

---

### [P-05] O1〜O5: 運用準備 (一括で)

**プロンプト (コピペ用)**:

````
NEXT_WORK.md の O1〜O5 を順に実装してください。 本番運用前の必須項目です。

## 前提

- O1: AWS アカウント側の事前準備 (Bedrock model access, AWS Budgets は実装済)
- O2: GitHub OIDC IAM Role (`.github/workflows/deploy.yml` が引き受ける)
- O3: main ブランチ保護
- O4: Cognito 管理者ユーザー (R6 で Custom Resource 化済み、 確認のみ)
- O5: Secrets Manager の実値投入 (LiveKit / YouTube)

## やること

1. O2 のための IAM Role を CDK で構築:
   - `infra/lib/control-plane-stack.ts` に `GithubOidcRole` を追加
   - 信頼ポリシー: `token.actions.githubusercontent.com` + repo:raihalea/stagecast:ref:refs/heads/main
   - 権限: CloudFormation / S3 (CDK assets) / Lambda update / Secrets Manager get/put
2. GitHub Environments (`dev` / `staging` / `prod`) のセットアップ手順を `docs/operations/github-environments.md` に記録
3. O3 main 保護: `.github/CODEOWNERS` 作成 (R12 後の運用安定化のため) + main 保護ルールを `docs/operations/branch-protection.md` に記述
4. O4 Cognito 管理者: 現状の `-c initialAdmins=...` で何人登録されているか aws cognito-idp list-users で確認 → 不足があれば追加
5. O5 Secrets 実値投入の手順を `docs/operations/secrets-bootstrap.md` に整理 (LiveKit API key 自動生成済、 YouTube は手動投入が必要)
6. PR description に「O 系すべて完了」と記載 + 各 doc へのリンク

## ハマったら

- GitHub OIDC + AWS IAM: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html
- 既存 deploy.yml の `permissions: id-token: write` を踏まえる
````

---

### [P-06] L1: 利用規約 / プライバシーポリシー (本番化準備)

**プロンプト (コピペ用)**:

````
NEXT_WORK.md の L1 を進めてください。 利用規約 / プライバシーポリシーのテンプレを実運用者向けに整える PR です。

## 前提

- テンプレ済: `docs/legal/terms-template.md` と `docs/legal/privacy-template.md`
- 公開前に運用者が編集 + 弁護士レビューが必要

## やること

1. テンプレを `docs/legal/terms.md` と `docs/legal/privacy.md` にコピー (運用者編集の起点に)
2. 各テンプレの placeholder (例: `{{COMPANY_NAME}}` `{{CONTACT_EMAIL}}`) を抽出して「編集が必要な箇所一覧」を `docs/legal/customization-checklist.md` に作成
3. Cognito 招待 / stage-web 入室時の同意 UI フローを設計:
   - 招待 URL を開く → 「利用規約に同意して入室」 ボタン
   - 同意した jti を DynamoDB に記録 (将来の問い合わせ対応用)
4. admin-web に 「利用規約 / プライバシーポリシー」 ページを追加 (S3 から markdown を fetch して表示)
5. PR description に「弁護士レビュー前のドラフト」と明記。 マージしても法的拘束力は無いことを示す

## ハマったら

- 一般的な利用規約: https://www.iubenda.com/en/help/8388 等を参考に
- AWS Bedrock / Transcribe / Translate の利用条件もテンプレに反映 (字幕生成で第三者音声を送るため)
````

---

## 📅 余裕があれば

### [P-07] D8 残: エンジン側 (Transcribe / Translate / Bedrock) の一過性エラー再試行

**プロンプト (コピペ用)**:

````
D8 残作業として、 字幕パイプラインのエンジン呼び出し (Transcribe / Translate / Bedrock) に withRetry を展開してください。 二重字幕回避を考慮する必要があります。

## 前提

- `@stagecast/shared` に `withRetry` (指数バックオフ、 retryable マーカー対応) が実装済
- 字幕 Sink 配信は既に withRetry 化済 (PR #46/#47)
- ADR 0007 (字幕レジリエンス) の方針に従う

## やること

1. `services/caption-pipeline/src/engines/` 配下の Transcribe / Translate / Bedrock adapter を確認
2. transient error (network / throttle) は withRetry で 3 回まで再試行
3. permanent error (auth failure / quota exhausted) は CaptionIngestionError で即断念
4. **二重字幕回避**: 再試行で同じ text が複数 publish されないよう、 publish 直前で dedupe (cue id + text hash)
5. metrics: `EngineRetries`, `EngineFailures` を CloudWatch に出力 (既存の N3 構造化 logger に乗せる)
6. unit test で各 engine の retry 挙動を確認
7. PR description に SLO 影響 (字幕遅延の悪化が無いか) を記載
````

---

### [P-08] N6: shadcn/ui への移行 (admin-web)

**プロンプト (コピペ用)**:

````
admin-web を shadcn/ui + Tailwind に段階移行してください。 1 PR では大きすぎるので 3 PR に分割します。

## 前提

- 現状の admin-web はプレーン CSS
- グローバル CLAUDE.md: shadcn 追加には `/shadcn` スキルを利用
- 既存 page: イベント一覧, EventDetail, SettingsPage, 招待発行 UI

## やること (PR #1: 基盤)

1. Tailwind CSS を admin-web に導入 (vite config + postcss)
2. shadcn/ui を初期化 (`npx shadcn@latest init`)
3. 既存 CSS を共存させたまま shadcn primitives (Button, Input, Card) を 1 つだけ画面に適用 (例: ログイン UI)
4. PR description に「PR #2 で全画面移行、 PR #3 で 旧 CSS 削除」と明記

## やること (PR #2: 移行本体)

5. イベント一覧 → Table + Card レイアウト
6. EventDetail → Tabs (基本情報 / 招待 / Egress / 成果物)
7. SettingsPage → Form + Validation (zod)
8. 招待発行 → Dialog (Sheet) + Toast

## やること (PR #3: cleanup)

9. 旧 CSS ファイル削除
10. ダークモード対応
11. アクセシビリティ (aria-label, focus management) 確認
````

---

### [P-09] N4: 配信前リハーサル機能

**プロンプト (コピペ用)**:

````
N4 (配信前リハーサル機能) を実装してください。 status=draft で 5 分起動して自動破棄する機能です。

## 前提

- reconcile が status=live のイベントに対して EventMediaStack を作る (現状の仕様)
- リハーサル = status=draft でも一時的にスタック起動、 ただし YouTube に送出しない (RTMP URL 空)

## やること

1. event.status に `rehearsing` を追加 (draft / live / rehearsing / ended)
2. reconcile が `rehearsing` も live と同等に扱って stack を立てる (ただし Egress の RTMP 送出を skip)
3. `rehearsing` 開始時刻を DynamoDB に記録 → 5 分経過したら reconcile が自動 ended に
4. admin-web に「リハーサル開始」ボタン (5 分カウントダウン表示)
5. stage-web で入室するとリハーサル中バナー表示
6. 録画は S3 に出すが prefix を `rehearsals/` にして本番 recordings/ と分離 (lifecycle で 1 日後削除)
7. PR description にコスト見積もり ($0.05/リハーサル程度)
````

---

### [P-13] R17-Phase3: stage-web 登壇者ビュー右下小窓プレビュー (完了: PR #134/#135, 2026-06-24)

**目的**: ADR 0012 D-6 の stage-web 側を実装し、 要件 1 (プレビュー画面) を完全達成する。
**結果**: ADR 0012 D-1〜D-6 全達成 + 要件 1-3 完全達成 🎉

**プロンプト (コピペ用)**:

````
ADR 0012 R17-Phase3 を実装してください。 admin-web 側のプレビュー (PR #130) は完了済みです。
stage-web の登壇者ビュー右下に「現在の配信」を picture-in-picture 風の小窓で表示します。

## 前提

- ADR 0012 D-6 (詳細は `docs/decisions/0012-custom-egress-template.md`)
- admin-web 側 LivePreview: `apps/admin-web/src/components/LivePreview.tsx` を参考にできる
- 現状の preview-token endpoint は `requireAdmin` (Cognito JWT) で守られている → stage-web からは叩けない

## やること

### 1. control-api に invite token 認証経路の preview-token を追加

実装方針候補 (ADR 0012 末尾参照):
- (A) `POST /preview-token` (body: { inviteToken }) を新規追加。 invite-service.verify で event.id 解決 → preview-token-service.issue を呼ぶ。 responsability 分離が綺麗
- (B) `/join` の結果に previewToken を含めて返す。 1 API call で完結だが JoinResult が肥大化

**推奨は (A)**。 既存の `usecases/join.ts` が invite-service.verify を使っているのと同じパターン。

### 2. stage-web に PreviewWindow コンポーネントを新規

- `apps/stage-web/src/components/PreviewWindow.tsx` (新規)
- 右下に 16:9 / 幅 240px くらいの小窓 (position: fixed, right: 16, bottom: 16, z-index 高め)
- toggle ボタン (✕ で非表示)
- iframe で composer-template を埋め込み
- preview-token は join 後に API call で取得 (controller.client.issuePreviewToken?(eventId, inviteToken))

### 3. stage-web の App.tsx に組み込み

session が確立した後 (= join 成功後) に PreviewWindow を表示。 toggle で開閉。

### 4. runtime config に composerTemplateUrl を追加

- `apps/stage-web/src/config.ts` の RuntimeConfig に composerTemplateUrl を追加
- `infra/lib/control-plane-stack.ts` の StageWebDeployment の config.json に注入

### 5. テスト + ビルド + PR

- control-api: preview-token-invite.test.ts (invite 認証パス)
- stage-web: PreviewWindow の最小テスト (mount + toggle)
- pnpm vp run -r build / test 全 pass
- PR 起票 + auto-merge + deploy

## 検証

deploy + ECS Task force-new-deployment 後:
1. stage-web で speaker 入室 + publish
2. 右下に小窓プレビューが出るか確認
3. layout 切替 (admin-web から) が stage-web プレビューにも sub-second 反映するか
4. R17-Phase3 完了で ADR 0012 D-6 全達成 → 要件 1-3 完全達成

## ハマったら

- LiveKit Egress プロトコル罠 (`/memory r12-livekit-fargate-gotchas.md` の罠 11)
- composer-template 更新後は **CloudFront invalidation + ECS Task force-new-deployment** で Chrome に新 bundle を読ませる必要あり
````

**完了条件**:
- stage-web の登壇者ビュー右下に小窓プレビューが表示される
- layout 切替が stage-web プレビューにも同期される
- ADR 0012 受け入れ基準 6 達成
- ADR 0012 D-6 全達成 + 要件 1-3 完全達成のマークを ADR / NEXT_WORK.md に反映

---

### [P-14] R14: Egress fileOutputs (S3 録画ファイル出力)

**目的**: P-01 (R12 残: YouTube Live RTMP 送出) の完了条件のうち未達の S3 録画を実装。

**プロンプト (コピペ用)**:

````
R14 を実装してください。 LiveKit Egress に fileOutputs (S3 録画) を追加し、 配信終了時に mp4 が ControlPlane の AssetsBucket に保存されるようにします。

## 前提

- 現状の `services/control-api/src/lambda.ts:178-187` は `StreamOutput` (RTMP) のみ
- SFU TaskRole は既に S3 PutObject 権限を持つ (ADR 0010 D-5 で `recordings/*` プレフィックス)
- ControlPlane の AssetsBucket = `recordingsBucketName` env で event-media-stack に渡す経路は既存

## やること

1. `services/control-api/src/lambda.ts` の startRoomCompositeEgress 呼び出しに file output を追加:

   ```ts
   const recordingsBucketName = env.RECORDINGS_BUCKET_NAME;
   const info = await client.startRoomCompositeEgress(
     roomName,
     {
       stream: new sdk.StreamOutput({ ... }),
       ...(recordingsBucketName ? {
         file: new sdk.EncodedFileOutput({
           filepath: `recordings/${eventId}/{egress_id}.mp4`,
           output: { case: "s3", value: new sdk.S3Upload({ bucket: recordingsBucketName, region: "ap-northeast-1" }) },
         }),
       } : {}),
     },
     { layout: "grid" },
   );
   ```

2. ControlPlane の ControlApiFunction の env に `RECORDINGS_BUCKET_NAME` を追加 (既存 RenderTemplateFunction には注入済みだが、 ControlApiFunction にもバケット名を渡す)

3. existing artifact-download.ts は既に S3 から `recordings/*` を listing する実装があるので、 admin-web の「成果物」一覧に自動的に表示される

4. test + build + PR + deploy + 検証

## 検証

1. 既存 live event で stage-web 入室 → publish → Egress 起動 → YouTube 確認
2. admin-web から「配信終了」で event を ended
3. reconcile が EventMediaStack を destroy する直前に Egress も終了 → S3 に mp4 アップロード
4. admin-web の EventDetail で「成果物」一覧を更新 → recording が表示される
5. ダウンロード URL をクリックして再生確認
````

**完了条件**:
- 配信終了で `recordings/{eventId}/{egressId}.mp4` が S3 に保存される
- admin-web の「成果物」一覧に表示 + ダウンロード可能
- NEXT_WORK.md R14 行を ✅ に

---

## 🌱 将来

### [P-10] R13: SFU 冗長化検討

> 1 イベント 1000 人以上のキャパや TURN over TLS が必要になったタイミングで着手。
> その時点で改めて ADR を起票してから実装に入ること。

### [P-11] N5: 配信終了後の自動サマリー

> EventBridge → Lambda で 録画 + 字幕 + 統計をまとめてメール/Slack。
> 配信運用が安定してから着手。

### [P-12] L3: コスト監視と上限設定

> AWS Budgets の月額アラート (実装済) に Slack subscribe 追加 + reconcile に stack 自動 destroy のタイムアウト機能。

---

## プロンプトのメンテナンス

- PR がマージされたら該当 [P-NN] セクションを `(完了: PR #XXX, YYYY-MM-DD)` に書き換え
- 新しいタスクが発生したら最後尾に追加 (`P-13` 以降)
- NEXT_WORK.md と整合性を取る (片方だけ更新しない)

## 関連ドキュメント

- [NEXT_WORK.md](./NEXT_WORK.md) — タスク詳細と完了基準
- [DESIGN.md](../DESIGN.md) — 設計の正
- [ADR 一覧](./decisions/) — 0001〜0011
