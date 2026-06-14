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

- [ ] `media-orchestrator`: イベント開始で起動・終了で破棄（7.1）
- [ ] 最大3並列・イベント間非干渉（N-5, 7.3）
- [ ] ElastiCache for Valkey (Serverless) を共有状態に
- 受け入れ基準: 3イベント同時起動→独立動作→破棄 をローカル模擬で確認

## フェーズ 4: メディア合成と配信

- [ ] LiveKit SFU 接続（登壇者/モデレーター/管理者）
- [ ] スライド二方式（画面共有 / 事前アップロード）（F-3, 5.2）
- [ ] 合成（登壇者+スライド+QR+タイトル）→ RTMP で YouTube Live（F-2/F-5/F-6, 5.1）
- [ ] 発表者出し入れが Valkey 経由で合成に即反映（F-4）
- [ ] 録画を S3 に保存（N-4）
- 受け入れ基準: 合成映像がモック RTMP/YouTube Live に出る

## フェーズ 5: 字幕パイプライン（差し替え可能設計）

- [ ] 字幕バス（共通形式 6.1 を流す）
- [ ] エンジン層の共通インターフェース（F-8, 6.2）
  - [ ] `TranscribeStreamingEngine` + `AmazonTranslate`
  - [ ] `LLMEngine`
  - [ ] 自前 ASR は I/F のみ
- [ ] 出力先 Sink の共通インターフェース（6.3）
  - [ ] `YouTubeCaptionSink`（1言語・確定）
  - [ ] `CustomCaptionApiSink`（WS/SSE・多言語・プロトコルのみ・任意起動）
- [ ] ja/en サポート（F-7）、遅延3秒以内を意識（N-2）
- [ ] 確定字幕を S3 保存・SRT/VTT 出力（6.4）
- 受け入れ基準: 音声→ja/en字幕→2種Sink配信、エンジン/Sink差し替えを単体テストで実証

## フェーズ 6: イベント設定 UI と素材管理

- [ ] 管理SPA で8章の項目を準備・登録
- 受け入れ基準: イベント作成→S3アップロード→設定保存→配信開始反映 が動く

---

## 現在のステータス

- 完了: **フェーズ 0**
- 次: フェーズ 1（CDK 制御層インフラ）
- 未解決の論点（`DESIGN.md` 9.1、別 ADR 予定）:
  - 字幕バスの分散メッセージング基盤
  - 独自字幕配信 API のプロトコル詳細
  - YouTube Live API 連携詳細
  - 障害時フェイルオーバー方針
