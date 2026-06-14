# 実装計画 (PLAN)

`DESIGN.md` を正とし、`PROMPT.md` の実装フェーズをタスク分解したチェックリスト。
各フェーズは「動く最小単位 → テスト → コミット」で進める。フェーズ完了ごとに本ファイルを更新する。

凡例: `[ ]` 未着手 / `[~]` 進行中 / `[x]` 完了

---

## フェーズ 0: 足場

- [x] モノレポ初期化（pnpm workspaces, TS project references）
- [x] ルート設定（tsconfig.base, ESLint, Prettier, Vitest, .gitignore, .env.example）
- [x] CI 雛形（GitHub Actions: install → lint → typecheck → build → test）
- [x] `packages/shared` に中核の型を定義
  - [x] 字幕イベント `CaptionEvent`（6.1: 開始/終了時刻・言語・テキスト・確定フラグ・話者ID）
  - [x] ロール `Role`（admin/moderator/speaker/viewer）
  - [x] イベント定義 `EventDefinition` / イベント設定（8章）
  - [x] 招待トークンのペイロード `InviteTokenPayload`（4.1）
  - [x] 発表者状態 `SpeakerState` / `PresentationState`（5.3）
  - [x] 字幕エンジン/Sink の共通インターフェース型（6.2, 6.3）
- [x] 単体テスト（型ガード・スキーマ・ユーティリティ）
- 受け入れ基準: `pnpm build` と `pnpm test` が通る。型が `DESIGN.md` の用語と一致。

## フェーズ 1: 制御層インフラ（常時稼働・低コスト）

- [x] CDK 制御層スタック: S3+CloudFront（admin-web）, API Gateway+Lambda, DynamoDB, Cognito, 成果物S3
- [x] 常時稼働リソースを制御層のみに限定（N-1）。README に一覧を明記
- [x] CDK assertion テスト（オンデマンド課金/自己サインアップ不可/メディア層を含めない 等）
- 受け入れ基準: `cdk synth` が通り、常時稼働リソースが制御層のみ ✅

## フェーズ 2: 制御 API と認証

- [x] イベント CRUD API + ライフサイクル遷移ガード
- [x] 発表者状態更新 API（5.3, F-4）
- [x] 管理者認証（AdminAuthVerifier 抽象 + フェイク。本番は Cognito JWT）
- [x] 署名付き招待 URL の発行・検証・失効・再発行（4.1, HMAC-SHA256, jti/version）
- [x] フレームワーク非依存の HTTP ルーター + API Gateway v2 アダプタ
- 受け入れ基準: 管理者認証/イベントCRUD/招待URL発行→検証→失効→再発行 のテスト 11件 ✅

## フェーズ 3: イベント単位オーケストレーション

- [x] `media-orchestrator`: イベント開始で起動・終了で破棄（7.1, 冪等）
- [x] 最大3並列・4つ目は ConcurrencyLimitError・イベント間非干渉（N-5, 7.3, F-9）
- [x] 共有状態ストア抽象（Valkey 名前空間化）+ インメモリ実装
- [x] MediaStackProvisioner 抽象 + フェイク（イベントごとに独立資源）
- 受け入れ基準: 3イベント同時起動→独立動作→破棄→スロット解放 をテスト 6件 ✅

## フェーズ 4: メディア合成と配信

- [x] LiveKit アクセストークン発行（ロール別 publish/subscribe 権限, HS256）
- [x] スライド二方式をレイアウトで表現（画面共有 / 事前アップロード+ページ）（F-3, 5.2）
- [x] レイアウト合成（登壇者+スライド+QR+タイトル）→ Egress→RTMP（F-2/F-5/F-6, 5.1）
- [x] 発表者出し入れが状態変化→レイアウト再計算で Egress に即反映（F-4）
- [x] 録画を S3 に保存（EgressのrecordingS3Uri）（N-4）
- [x] EgressClient 抽象 + フェイクで外部接続なしに検証
- 受け入れ基準: 合成映像がモック RTMP に出る（StreamComposer テスト）✅ 12件
- 補足: 登壇者の WebRTC 送出 UI（stage-web）はフロントとしてフェーズ6で扱う

## フェーズ 5: 字幕パイプライン（差し替え可能設計）

- [x] 字幕バス InProcessCaptionBus（共通形式 6.1, フェイルソフト配信）
- [x] エンジン層の共通インターフェース（F-8, 6.2, shared の CaptionEngine）
  - [x] `TranscribeStreamingEngine` + `Translator`（AsrAdapter/Translator 抽象+フェイク）
  - [x] `LLMEngine`（asr+translate / translate-only 両モード）
  - [x] `SelfHostedAsrEngine` は I/F + 拡張ポイントのみ（未実装で throw）
- [x] 出力先 Sink の共通インターフェース（6.3）
  - [x] `YouTubeCaptionSink`（確定・1言語のみ送出）
  - [x] `CustomCaptionApiSink`（多言語・確定/暫定・プロトコル CaptionStreamMessage のみ）
- [x] ja/en サポート（F-7）。エンジン/Sink 注入で経路別構成可（N-2 配慮）
- [x] 確定字幕を S3 保存・SRT/VTT 出力（CaptionStore, 6.4, N-4）
- 受け入れ基準: 音声→ja/en字幕→2種Sink配信、エンジン/Sink差し替えをテスト 14件 ✅

## フェーズ 6: イベント設定 UI と素材管理

- [x] 管理SPA (React + Vite): イベント作成フォーム (タイトル/日時/字幕言語/
      YouTube送出言語/エンジン/独自API有効化/YouTube配信先)
- [x] イベント詳細: QR素材アップロード・招待URL発行・配信開始/終了
- [x] 制御APIクライアント抽象 (Http 本番 / Local=control-api実ロジックをテストで利用)
- [x] フォーム検証の純粋関数 + 一連フローのテスト
- 受け入れ基準: イベント作成→素材アップロード→設定保存→招待発行→配信開始(live)反映 ✅
  (フォーム3件 + フロー1件のテスト、vite build 通過)

---

## 運用化フェーズ（フェーズ7〜: あるべき姿への実体化）

### フェーズ 7: イベント単位メディアスタックの CDK 定義

- [x] `EventMediaStack`: ECS/Fargate(SFU/Egress/字幕worker) + ElastiCache Valkey Serverless
- [x] イベント単位で独立・破棄可能（N-5, 7.1, 7.3）。専用VPC・タグで隔離、bin で -c eventId 合成
- 受け入れ基準: synth + assertion（Valkey Serverless・3 Fargate・専用VPC・IAM最小権限）✅ 6件

### フェーズ 8: 登壇者/モデレーター用 stage-web

- [x] control-api に `/join` 追加（招待トークン検証 → LiveKit トークン払い出し）（4.1, F-1）
- [x] stage-web: 招待 URL 入室・ロール別 publish ガード（登壇者のみ送出, モデレーターは補助）
- [x] RoomConnector 抽象 + LiveKit 実装 + Fake（カメラ/マイク/画面共有, F-3）
- [x] スライド送り（事前アップロードのページ送りをデータ配信, 5.2）
- 受け入れ基準: StageController/入室/スライドのテスト 9件 + vite build ✅

### フェーズ 9: DynamoDB 永続化（control-api 実リポジトリ）

- [x] 単一テーブル設計の純粋マッパー（item ⇄ ドメイン, pk/sk/GSI1）+ 往復テスト
- [x] `DynamoEventRepository`/`DynamoInviteTokenRepository`/`DynamoPresentationRepository`
      （AWS SDK v3 DocumentClient。SDK 層はロジックを持たずマッパーに委譲）
- [x] factory が `METADATA_TABLE_NAME` 環境変数で Dynamo↔インメモリを自動選択
- 受け入れ基準: マッパー往復・キー設計のテスト 4件（SDK 層は統合時に検証）✅

### フェーズ 10: 実アダプタ群（外部サービス結線・差し替え可能実装）

- [x] 字幕エンジン実アダプタ（注入クライアントで単体テスト）
  - [x] `AmazonTranslateTranslator`（Translate）・`BedrockLlmAdapter`（Bedrock 翻訳）
  - [x] `TranscribeStreamingAsrAdapter`（push↔pull 橋渡し、結果マッパーは純粋関数でテスト）
- [x] 字幕保存 `S3ObjectStorage`（S3 Put/Get）
- [x] YouTube 送出 `HttpYouTubeCaptionPublisher`（タイムスタンプ整形・seq・注入 fetch）
- [x] 独自字幕配信 API プロトコル `CaptionConnectionHub`（welcome/subscribe/ping/pong/error・
      言語別配信・再接続バックログ追いつき・認証）+ `HubCaptionBroadcaster`（9.1 プロトコル詳細）
- [x] 共有状態 `ValkeySharedStateStore`（Valkey/Redis 互換、名前空間破棄）
- [x] 認証 `CognitoJwtAdminAuthVerifier`（aws-jwt-verify、検証関数を注入可能に）
- [x] 素材アップロード S3 署名 URL（`/events/{id}/assets/upload-url` + admin-web `HttpAssetService`）
- 受け入れ基準: 各アダプタを注入クライアント/フェイクで単体テスト ✅
  （caption-pipeline 30 / control-api 26 / media-orchestrator 8）

### フェーズ 11: ランタイム結線（実トランスポート・組み立て・プロビジョナ）

- [x] 独自字幕配信 API の WebSocket トランスポート（`WebSocketCaptionServer`/`attachConnection`、
      クエリの token/lang 解釈、ハブへの橋渡し）（6.3.2, 9.1）
- [x] 字幕ランタイム結線：イベント設定→エンジン/Sink 選択（`selectEngine`/`selectSinks`/
      `assembleCaptionPipeline`）（F-8, 6 章）
- [x] `CaptionWorker`：音声→エンジン→バス→Sink→ハブ→WebSocket を一気通貫で接続
- [x] `CloudFormationMediaStackProvisioner`：EventMediaStack を CFN 作成/削除・完了待ち
      （注入 CloudFormationLike でテスト）（7.1）
- 受け入れ基準: ws 橋渡し・選択・worker E2E・CFN 作成/待機/失敗/削除 をテスト ✅

### フェーズ 12: 障害時方針・実テンプレート供給・実ポート起動

- [x] **ADR 0003 障害時フェイルオーバー**（調整ループ・RTMP 再接続・Valkey Streams 追いつき・
      状態外部化）（`DESIGN.md` 9.1）
- [x] 実テンプレート供給：infra `renderEventMediaTemplate`（CDK を synth してテンプレート JSON 生成）+ `bin/render-template.ts` CLI + テスト
- [x] 実 CFN 結線：media-orchestrator `AwsCloudFormationClient`（SDK 実装）+
      `createAwsMediaStackProvisioner`（renderTemplate 注入の合流点）
- [x] 字幕ワーカー bootstrap：`CaptionService`（worker + WebSocket 実ポート起動 + AudioSource）、
      `configFromEnv`/`realProvidersFromEnv`/`runFromEnv` + `main.ts`、グレースフルシャットダウン
- 受け入れ基準: 実テンプレート生成・実 CFN マッピング・**実 ws ポートでの E2E**（実 ws クライアント
  が字幕受信）をテスト ✅

---

## 現在のステータス

- 完了: **フェーズ 0〜12 すべて** ✅（build / typecheck / lint / test / format 全通過、計 136 tests）
- パッケージ別テスト: shared 9 / infra 14 / control-api 26 / media-orchestrator 15 /
  media-composer 12 / caption-pipeline 47 / admin-web 4 / stage-web 9
- ADR: 0001 技術選定 / 0002 字幕バス分散化 (Valkey Streams) / 0003 障害時フェイルオーバー
- 残（実 AWS アカウントでのデプロイ/統合検証が本体。コードの実装単位は完了）:
  → **[`docs/REMAINING_WORK.md`](./REMAINING_WORK.md)** に Claude Code 実行用のタスク（T1〜T10）として分解済み。
  - 実 LiveKit からの音声取り込み AudioSource 実装（I/F とワーカー結線は実装・テスト済み）
  - オーケストレータ調整ループの定期実行スケジューラ（EventBridge → Lambda 配線）
  - `ValkeyStreamsCaptionBus` の実 Valkey クライアント結線（I/F・ロジックは実装・テスト済み）
  - 実 AWS デプロイと E2E（実キー・実課金が必要）
