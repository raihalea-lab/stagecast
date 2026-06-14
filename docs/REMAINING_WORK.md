# 残作業ロードマップ（Claude Code 実行用）

このドキュメントは、`DESIGN.md` の設計に対して **コード上の実装単位は完了**した後に残る
「実 AWS アカウントでのデプロイ・統合・運用結線」を、Claude Code で順に実行できる粒度の
タスクに分解したものである。各タスクは独立に着手でき、既に用意済みの**差し替えポイント（seam）**に
実装を流し込む形にしてある。

- 設計の正: [`DESIGN.md`](../DESIGN.md)
- 技術選定: [ADR 0001](./decisions/0001-tech-stack.md) / 字幕バス: [ADR 0002](./decisions/0002-caption-bus.md) / 障害時: [ADR 0003](./decisions/0003-failover.md)
- フェーズ別の実装状況: [`PLAN.md`](./PLAN.md)

## 現状（前提）

- フェーズ 0〜12 実装済み。`pnpm build / typecheck / lint / test / format` 全通過（136 tests）。
- 外部依存はすべて**インターフェース + フェイク**で実装済み。実アダプタ（AWS SDK 実装）も
  注入クライアントで単体テスト済み。**未了は「実アカウントでの結線・デプロイ・E2E」**のみ。

## 進め方（共通ルール）

- 各タスクは「動く最小単位 → テスト → コミット」。`DESIGN.md` を逸脱する変更は ADR を追加してから。
- 外部接続が必要なテストは**統合テスト**として分離し、CI のユニットテスト（外部接続なし）を壊さない。
  例: `*.integration.test.ts` を別 vitest プロジェクト/タグにし、`RUN_INTEGRATION=1` のときのみ実行。
- 秘密情報はコードに置かず Secrets Manager / SSM から注入（[ADR 0001 D-10]）。`.env.example` を更新。
- コスト方針（`DESIGN.md` 7.2 / N-1）を破る常時稼働リソースを足さない。

---

## T1. 実 LiveKit からの音声取り込み（AudioSource 実装）

- **目的**: 字幕ワーカーが SFU(LiveKit) の登壇者音声トラックを受け取り、`CaptionService` に流す。
- **背景/参照**: `DESIGN.md` 3.4(4)/6 章。字幕は登壇者音声を分岐して生成する。
- **既存 seam**:
  - `services/caption-pipeline/src/bootstrap.ts` の `AudioSource` インターフェース（`FakeAudioSource` あり）。
  - `CaptionService` は `audioSource` を受け取り `worker.pushAudio` に接続済み。
- **作業内容**:
  - `LiveKitAudioSource implements AudioSource` を追加。`livekit-server-sdk`（または egress/track の
    音声購読）で対象ルームの登壇者トラックを購読し、PCM 16k mono にリサンプルして `AudioChunk` を emit。
  - `runFromEnv` に `LIVEKIT_URL/API_KEY/SECRET` と対象ルーム(eventId) からの構築を配線。
- **受け入れ基準**: ローカル LiveKit（docker）で音声 → 字幕 → WebSocket 配信が通る統合手順を
  `docs/` か README に記載。ユニットテストはフェイクのまま緑。
- **想定ファイル**: `services/caption-pipeline/src/livekit-audio-source.ts`（+ integration test）。

## T2. メディア合成・Egress の実 LiveKit 結線（RTMP 送出・録画）

- **目的**: `media-composer` のレイアウト/Egress 抽象を実 LiveKit Egress に接続し、合成映像を
  RTMP で YouTube Live へ送出、録画を S3 に保存する。
- **背景/参照**: `DESIGN.md` 5 章/F-2/F-5/F-6/N-4。
- **既存 seam**: `services/media-composer` の `EgressClient` インターフェース（`FakeEgressClient` あり）、
  `computeLayout` / `StreamComposer`。LiveKit トークンは `createLiveKitAccessToken` 実装済み。
- **作業内容**:
  - `LiveKitEgressClient implements EgressClient` を追加（`livekit-server-sdk` の EgressClient を使用）。
    `start` で RoomComposite/Track Egress を開始（layout → LiveKit のレイアウト/テンプレート指定）、
    `updateLayout` でレイアウト更新、`stop` で停止。録画出力は S3（`EncodedFileOutput`）。
  - 発表者状態（Valkey）の変化を購読 → `StreamComposer.onPresentationChanged` を駆動する結線。
- **受け入れ基準**: ステージング or モック RTMP に合成映像が出る統合手順。ユニットは緑のまま。
- **想定ファイル**: `services/media-composer/src/livekit-egress.ts`（+ integration）。

## T3. ValkeyStreamsCaptionBus の実 Valkey クライアント結線

- **目的**: クロスタスク構成（字幕ワーカーと独自字幕 API サーバを分離/水平スケール）で
  字幕バスを Valkey Streams にする（[ADR 0002]）。
- **既存 seam**: `services/caption-pipeline/src/valkey-bus.ts` の `CaptionStreamClient`
  （`xadd` / `read`）。`ValkeyStreamsCaptionBus` は実装・テスト済み。
- **作業内容**:
  - `redis`（node-redis）または `ioredis` の薄いラッパで `CaptionStreamClient` を実装
    （`XADD ... MAXLEN ~ N` と `XREAD BLOCK` / コンシューマグループ `XREADGROUP`）。
  - `CaptionPipeline` 構築時に `InProcessCaptionBus` ↔ `ValkeyStreamsCaptionBus` を
    環境変数（例: `CAPTION_BUS=valkey`）で切替できるよう `runtime.ts`/`bootstrap.ts` に配線。
  - 接続先は `EventMediaStack` の Valkey エンドポイント（`VALKEY_ENDPOINT` 環境変数で注入済み）。
- **受け入れ基準**: ローカル Valkey/Redis に対する統合テストで publish→subscribe 往復が通る。
  ユニットはフェイクのまま緑。
- **想定ファイル**: `services/caption-pipeline/src/valkey-stream-client.ts`（+ integration）。
- **未決（[ADR 0002] 末尾）**: コンシューマグループの ack 戦略・カーソル永続化・水平スケール時の
  パーティショニング。実装前に ADR 追補を検討。

## T4. オーケストレータ調整ループ（reconciliation）と起動配線

- **目的**: live イベント集合（DynamoDB）と実スタック（CloudFormation）を収束させる自己修復ループ
  （[ADR 0003 D-2]）。
- **既存 seam**: `MediaOrchestrator`（冪等 start/stop）、`CloudFormationMediaStackProvisioner`
  （作成/完了待ち/失敗検知/削除）、`createAwsMediaStackProvisioner`（renderTemplate 注入の合流点）、
  infra `renderEventMediaTemplate`。
- **作業内容**:
  - `reconcile(desired, actual)` 関数を実装（live なのに無 → provision、ended なのに有 → destroy、
    FAILED/ROLLBACK → destroy 後 provision）。純粋ロジックとして単体テスト可能に切り出す。
  - EventBridge スケジュール（30〜60s）→ Lambda → `reconcile` を起動する CDK 配線を `infra` に追加
    （制御層スタック内、常時稼働の最小コストで）。DynamoDB の live 集合読み出し + provisioner 呼び出し。
  - control-api の「イベント開始/終了」操作が DynamoDB の desired を更新するだけにし、実起動は
    ループに委譲（即時性が要るなら開始時に一度 provision をキックしてもよい）。
- **受け入れ基準**: `reconcile` の単体テスト（各遷移）。Lambda ハンドラの組み立てテスト。
  `cdk synth` に EventBridge ルール + Lambda が出る assertion。
- **想定ファイル**: `services/media-orchestrator/src/reconcile.ts`、`infra/lib/reconcile-lambda` 等。

## T5. control-api 実ハンドラの CDK バンドル（NodejsFunction 化）

- **目的**: 現在プレースホルダの Lambda を `@stagecast/control-api` の実 `handler` に差し替える。
- **既存 seam**: `services/control-api` の `handler`（API Gateway v2 アダプタ実装済み）。
  `infra/lib/control-plane-stack.ts` は現在 `lambda/control-api-placeholder` を参照。
- **作業内容**:
  - `aws_lambda_nodejs.NodejsFunction` で `services/control-api/src/index.ts` の `handler` を
    バンドル（esbuild）。`@aws-sdk/*` は Lambda ランタイム提供分を external 化。
  - 環境変数（`METADATA_TABLE_NAME` / `ASSETS_BUCKET_NAME` / `COGNITO_*` / `INVITE_TOKEN_SECRET`
    （Secrets 参照）/ `LIVEKIT_*`）を注入。Cognito JWT オーソライザを HTTP API に設定。
  - 招待トークン秘密と LiveKit 鍵を Secrets Manager から注入（T7 と連動）。
- **受け入れ基準**: `cdk synth` が NodejsFunction を出力。デプロイ後 `/events` 等が疎通する手順。
- **想定ファイル**: `infra/lib/control-plane-stack.ts` 改修、不要になった placeholder 削除。

## T6. フロント配備（admin-web / stage-web）

- **目的**: SPA を S3 + CloudFront に配備し、`VITE_CONTROL_API_URL` 等を本番値でビルド。
- **既存 seam**: `apps/admin-web` / `apps/stage-web`（`vite build` 通過済み）。制御層スタックに
  `AdminWebBucket` + CloudFront あり。
- **作業内容**:
  - stage-web 用の配信（S3+CloudFront）を制御層スタックに追加（admin と同形）。
  - ビルド成果物の S3 同期（`aws s3 sync`）と CloudFront invalidation を deploy 手順/CI に追加。
  - Cognito Hosted UI もしくは Amplify Auth で管理者ログインを admin-web に実装（現状トークンは
    `sessionStorage` 前提のスタブ）。
- **受け入れ基準**: デプロイ後、admin-web からイベント作成→素材アップロード→配信開始が実 API で動く。
- **想定ファイル**: `infra/lib/control-plane-stack.ts`、`apps/*` の auth 実装、deploy スクリプト。

## T7. シークレット管理（Secrets Manager / SSM）

- **目的**: YouTube API キー・LiveKit 鍵・招待トークン署名鍵を安全に注入（[ADR 0001 D-10]）。
- **作業内容**:
  - Secrets Manager に `stagecast/invite-token-secret`、`stagecast/livekit`、`stagecast/youtube` を定義
    （CDK で作成 or 既存参照）。各 Lambda/タスクに読み取り権限を付与し、環境変数 or 起動時取得で注入。
  - `.env.example` を実運用の変数名に合わせて更新。
- **受け入れ基準**: 平文鍵がコード/テンプレートに現れない（`cdk synth` 出力を grep で検査）。
- **想定ファイル**: `infra/lib/*`、`.env.example`。

## T8. 実アダプタの統合テスト（疎通確認）

- **目的**: 実認証情報で各実アダプタの疎通を確認（ユニットはフェイクで緑のまま）。
- **対象**: `TranscribeStreamingAsrAdapter` / `AmazonTranslateTranslator` / `BedrockLlmAdapter` /
  `S3ObjectStorage` / `HttpYouTubeCaptionPublisher` / Dynamo\*Repository / `CognitoJwtAdminAuthVerifier` /
  `AwsCloudFormationClient` / `renderEventMediaTemplate`→実 deploy。
- **作業内容**: `*.integration.test.ts` を追加し、`RUN_INTEGRATION=1` + 実認証情報のときのみ実行。
  CI には別ジョブ（任意・手動 dispatch）として用意。
- **受け入れ基準**: 各アダプタの最小疎通（例: Translate で 1 文翻訳、S3 put/get、DynamoDB put/get）。

## T9. オブザーバビリティ（[ADR 0003] の監視を実装）

- **目的**: タスク異常終了・RTMP 切断・字幕遅延の検知とアラーム。
- **作業内容**: `EventMediaStack` に CloudWatch アラーム（ECS タスク異常・ログメトリクスフィルタ）、
  字幕遅延メトリクス（ワーカーが publish する custom metric）、ダッシュボードを追加。
- **受け入れ基準**: `cdk synth` にアラーム/メトリクスが出る assertion。閾値超過で通知される手順。
- **想定ファイル**: `infra/lib/event-media-stack.ts` 拡張、ワーカーのメトリクス送信。

## T10. デプロイ手順・CI 拡張

- **目的**: 再現可能なデプロイと CI 強化。
- **作業内容**:
  - CI に `pnpm --filter @stagecast/infra synth`（テンプレ生成の健全性）を追加。
  - `deploy` ワークフロー（手動 dispatch）: 制御層 `cdk deploy` → フロント `s3 sync` → invalidation。
  - README の「デプロイ手順」を実コマンドで更新（bootstrap・account/region・secrets 準備含む）。
- **受け入れ基準**: ワークフローが lint/build を通り、dry-run（`--no-execute` 等）で検証できる。

---

## 依存関係（推奨順）

1. **T5（実 Lambda）→ T7（Secrets）→ T6（フロント+認証）** … 制御層を実運用に。
2. **T4（調整ループ）→ T2（Egress）/ T1（音声）/ T3（Valkey バス）** … メディア/字幕層を実運用に。
3. **T8（統合テスト）/ T9（監視）/ T10（CI・デプロイ）** … 横断的に随時。

各タスク着手時は本ファイルの該当節を Claude Code に渡し、「既存 seam を使って実装し、ユニットテストを
壊さずに統合テスト/synth assertion を追加、`PLAN.md` を更新」と指示すればよい。
