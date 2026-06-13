# ADR 0001: 技術選定 (Tech Stack)

- ステータス: Accepted
- 日付: 2026-06-13
- 関連: `DESIGN.md` 全体、`PROMPT.md`「技術選定の確定」

## コンテキスト

`DESIGN.md` に基づき、StreamYard 型の YouTube ライブ配信プラットフォームを実装する。
要件の核は次の通り。

- 常時稼働するのは低コストな制御層のみ（S3/CloudFront, API Gateway/Lambda, DynamoDB, Cognito）。
  メディア層・翻訳層は配信時のみ起動し、非配信時はゼロスケールする（N-1, 7.2）。
- 最大 3 イベントを独立並列で配信。イベント単位でメディア/字幕スタックを起動・破棄する（F-9, N-5, 7.x）。
- ASR/翻訳エンジンと字幕出力先（Sink）の双方を差し替え可能にする（F-8, 6.2, 6.3）。
- 字幕遅延 3 秒以内を目標（N-2）。

本 ADR で、言語・フレームワーク・IaC・各層の具体サービスを確定する。

## 決定

### D-1. モノレポ構成: pnpm workspaces + TypeScript project references

- フロント（管理SPA・登壇者SPA）、制御API、オーケストレータ、メディア/字幕ワーカー、
  共有型、IaC を 1 リポジトリで管理する（PROMPT「モノレポ構成」）。
- パッケージマネージャは **pnpm**（ワークスペース機能・ディスク効率・厳密な依存解決）。
- TypeScript の **project references** でパッケージ間の型を解決し、増分ビルドを効かせる。
- ディレクトリは PROMPT「ディレクトリ構成」に従う: `/infra`, `/apps/*`, `/services/*`, `/packages/*`, `/docs`。

### D-2. 言語: TypeScript を全層で基本採用

- フロント・バックエンド・ワーカー・IaC をすべて TypeScript に統一し、`packages/shared` の
  型（字幕イベント、イベント設定、ロール、招待トークン）を全層で共有する。
- 例外: GPU 上の自前 ASR（`DESIGN.md` 6.2「自前 ASR」, 9.1）が必要になった場合のみ Python 等を許容。
  本フェーズではインターフェースのみ用意し、実装は将来拡張とする。
- ランタイムは Node.js 22（Lambda・Fargate ともに 22 系を前提）。

### D-3. フロントエンド: React + TypeScript + Vite

- `apps/admin-web`（管理SPA, Cognito 認証）と `apps/stage-web`（登壇者/モデレーター, 招待URL）。
- ビルドは Vite。成果物は S3 + CloudFront で静的配信（`DESIGN.md` 3.1）。
- WebRTC は LiveKit Client SDK（`livekit-client`）を使用。

### D-4. IaC: AWS CDK (TypeScript)

- PROMPT の第一候補どおり **AWS CDK v2 (TypeScript)** を採用。アプリと同一言語で記述でき、
  `packages/shared` の定数・型を IaC からも参照できる利点が大きい。Terraform は採用しない。
- スタックを 2 系統に分割する。
  - **制御層スタック**（常時稼働）: S3, CloudFront, API Gateway, Lambda, DynamoDB, Cognito, 成果物用 S3。
  - **イベント単位メディアスタック**（動的・最大3並列）: ECS/Fargate サービス（LiveKit/Egress/字幕ワーカー）、
    ElastiCache for Valkey Serverless。`media-orchestrator` が起動時に生成し終了時に破棄する。

### D-5. バックエンド（制御API）: API Gateway (HTTP API) + Lambda

- `services/control-api` を Lambda ハンドラ群として実装。イベント CRUD、発表者状態更新、
  招待 URL 発行・検証、メディア層起動/停止のオーケストレーション入口（`DESIGN.md` 3.1, 5.3, 4.1）。
- リクエスト課金のため非配信時はほぼ無料（N-1, 7.2）。
- 認証: 管理者は Cognito（JWT オーソライザ）。モデレーター・登壇者は署名付き招待トークン
  （HMAC 署名、イベントID・ロール・有効期限を含む）をサーバー側で検証する（F-12, 4.1）。

### D-6. メディア/字幕層のコンピュート: ECS/Fargate（イベント単位タスク）

- `DESIGN.md` 3.2 / 9.1、PROMPT に従い **ECS on Fargate** でイベント単位タスクを起動・破棄する。
- 1 イベント = 1 タスクセット（SFU/Egress 連携 + 字幕ワーカー）。最大 3 セット並列、相互非干渉（N-5, 7.3）。
- SFU は **LiveKit**。合成・Egress は LiveKit Egress（レイアウト合成 → RTMP）を利用（5.1, F-2/F-5/F-6）。
- GPU 自前 ASR が必要な場合のみ EC2 GPU を別途検討（本フェーズ対象外, 9.1）。

### D-7. 共有状態: ElastiCache for Valkey (Serverless)

- ルーム状態・発表者切替状態・低レイテンシ共有状態に使用（`DESIGN.md` 3.2, 5.3, 7.2）。
- Serverless を採用し、イベント時のみ課金。非配信時は確保しない。

### D-8. 字幕パイプライン: 抽象化された Engine / Bus / Sink

- 共通形式「字幕イベント」（6.1）を `packages/shared` の型として定義。
- `services/caption-pipeline` に **CaptionBus** と、共通インターフェースの **Engine**・**Sink** を実装。
  - Engine: `TranscribeStreamingEngine`(+Amazon Translate), `LLMEngine`(Bedrock), 自前 ASR は I/F のみ（F-8, 6.2）。
  - Sink: `YouTubeCaptionSink`(1言語/確定), `CustomCaptionApiSink`(WS/SSE・多言語・任意起動)（6.3）。
- 字幕バスの基盤は当面プロセス内 EventEmitter 抽象で実装し、分散実装（後述）に差し替え可能にする。
- 確定字幕は S3 に保存、SRT/VTT 出力に対応（6.4, N-4）。

### D-9. テスト/Lint/ビルド

- テスト: **Vitest**（全パッケージ共通、外部接続なしで完結。モック/フェイクを同梱）。
- Lint: **ESLint** + **Prettier**。型チェック: `tsc --noEmit`。
- ライブラリのバンドルは **tsup**、CDK は `cdk synth`。
- CI: GitHub Actions（install → lint → typecheck → build → test）。

### D-10. シークレット管理

- YouTube API キー、LiveKit キー等はコードに置かず、環境変数 / SSM パラメータストア /
  Secrets Manager で扱う。リポジトリには `.env.example` のみ置く（PROMPT 共通ルール）。

## 影響・トレードオフ

- TypeScript 全層統一により学習・共有コストを最小化。GPU ASR のみ将来別言語を許容する分界点を明確化。
- CDK 採用で IaC とアプリの型共有が可能。AWS ロックインは要件（N-3「AWS を利用する」）と整合。
- 字幕バスのプロセス内実装は単一タスク内では十分だが、将来クロスサービス化する際は
  Kinesis / MSK / Redis Streams 等への差し替えが必要（9.1「字幕バスの実装方式」は別 ADR で確定）。

## 未解決（別 ADR で確定する事項, `DESIGN.md` 9.1）

- 字幕バスの分散メッセージング基盤と暫定/確定字幕の同期方式。
- 独自字幕配信 API のプロトコル詳細（メッセージスキーマ、再接続、認証）。
- YouTube Live API 連携（配信開始・字幕送出）の詳細。
- 障害時フェイルオーバーと配信途中のリソース再起動方針。
