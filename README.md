# Stagecast

StreamYard 型の YouTube ライブ配信プラットフォーム。配信管理者・モデレーター・登壇者が
共同で配信を運営し、スライド + 登壇者映像の合成、発表者切替、QR / タイトルのオーバーレイ、
日英を中心としたリアルタイム字幕翻訳を行い、YouTube Live で配信する。

設計の正は [`DESIGN.md`](./DESIGN.md)。技術選定は [ADR 0001](./docs/decisions/0001-tech-stack.md)、
実装計画は [`docs/PLAN.md`](./docs/PLAN.md) を参照。
実 AWS デプロイ・統合に向けた残作業は [`docs/REMAINING_WORK.md`](./docs/REMAINING_WORK.md)（T1〜T10）にまとめてある。

## アーキテクチャ概要 (DESIGN.md 3 章 / 9 章)

3 層構成。**制御層のみ常時稼働**し、メディア層・翻訳層は配信時のみ起動し非配信時はゼロスケールする (N-1)。

| 層           | 主なサービス                                           | 稼働形態                  |
| ------------ | ------------------------------------------------------ | ------------------------- |
| 制御層       | S3, CloudFront, API Gateway, Lambda, DynamoDB, Cognito | 常時稼働・低コスト        |
| 共有状態     | ElastiCache for Valkey (Serverless)                    | イベント時のみ            |
| メディア層   | SFU (LiveKit), 合成・Egress (ECS/Fargate)              | イベント時のみ・最大3並列 |
| 翻訳・字幕層 | 字幕パイプライン・字幕バス・各エンジン/Sink            | イベント時のみ            |
| 保存         | S3 (録画・確定字幕・素材)                              | 常時                      |
| 配信         | YouTube Live                                           | 外部                      |

### 非配信時に稼働するリソース一覧 (常時課金されるのはこれだけ・N-1 / DESIGN.md 7.2)

- **S3 + CloudFront** — 管理 SPA の静的配信 (アクセス量課金)
- **API Gateway + Lambda** — 制御 API (リクエスト課金、非配信時はほぼ無料)
- **DynamoDB** — メタデータ (オンデマンド課金、小規模)
- **S3 (成果物)** — 素材・録画・確定字幕 (ストレージ課金)
- **Cognito** — 管理者認証

> SFU / Egress / 字幕パイプライン / ElastiCache / 独自字幕 API は配信時のみ起動し、
> 終了で破棄するため非配信時は課金されない。常時稼働リソースをこの一覧の外に増やさないこと。

## リポジトリ構成

```
/infra                # AWS CDK スタック (制御層)。イベント単位メディアスタックは今後追加  [実装済]
/apps
  /admin-web          # 管理SPA (S3+CloudFront, Cognito 認証)                         [実装済]
  /stage-web          # 登壇者・モデレーター用 (招待URL入室, LiveKit WebRTC送出, スライド送り)  [実装済]
/services
  /control-api        # 制御 API。イベント設定・発表者制御・招待トークン・認証         [実装済]
  /media-orchestrator # メディア/字幕スタックの起動・破棄・最大3並列・共有状態         [実装済]
  /media-composer     # LiveKitトークン・レイアウト合成・Egress/RTMP・録画            [実装済]
  /caption-pipeline   # ASR/翻訳エンジン + 字幕バス + 出力先(Sink) + SRT/VTT保存       [実装済]
/packages
  /shared             # 中核の型 (字幕イベント・イベント設定・ロール・招待トークン 等)  [実装済]
/docs
  /decisions          # ADR
  PLAN.md
DESIGN.md             # 設計の正
```

現在の実装状況: **フェーズ 0〜6 すべて実装済み**（`pnpm build` / `typecheck` / `lint` / `test` 全通過、66 tests）。
外部依存（AWS SDK・LiveKit・YouTube 等）は差し替え可能なインターフェース + フェイクで実装し、
テストは外部接続なしで完結する。実 AWS への結線・デプロイは残作業。詳細は `docs/PLAN.md`。

| パッケージ                    | 役割                                                                   | フェーズ |
| ----------------------------- | ---------------------------------------------------------------------- | -------- |
| `packages/shared`             | 中核型（字幕イベント・ロール・招待・発表状態・設定・パイプライン I/F） | 0        |
| `infra`                       | 制御層 CDK スタック（常時稼働・低コスト）                              | 1        |
| `services/control-api`        | イベント CRUD・発表者制御・招待トークン・認証                          | 2        |
| `services/media-orchestrator` | イベント単位の起動/破棄・最大3並列・共有状態                           | 3        |
| `services/media-composer`     | LiveKit トークン・レイアウト合成・Egress/RTMP・録画                    | 4        |
| `services/caption-pipeline`   | 字幕バス・差し替え可能エンジン/Sink・SRT/VTT 保存                      | 5        |
| `apps/admin-web`              | 管理 SPA（イベント設定・素材・招待・配信制御）                         | 6        |

## ローカル起動手順

前提: Node.js 22+, pnpm 10+。

```bash
pnpm install          # 依存をインストール
cp .env.example .env  # 環境変数を用意 (実値はコミットしない)

pnpm build            # 全ワークスペースをビルド
pnpm test             # 全ワークスペースのテスト (外部接続なしで完結)
pnpm typecheck        # 型チェック
pnpm lint             # ESLint
pnpm format           # Prettier 整形
```

外部依存 (YouTube Live API, LiveKit, Transcribe, Translate, Bedrock 等) は
フェイク実装に切り替えられる (`USE_FAKE_ADAPTERS=true`)。テストは外部接続なしで通る。

## デプロイ手順

制御層 (常時稼働) の CDK スタックを synth/deploy する。

```bash
# 制御層スタックの合成 (テンプレ確認)
pnpm --filter @stagecast/infra synth

# デプロイ (要 AWS 資格情報・cdk bootstrap 済み)
pnpm --filter @stagecast/infra cdk deploy StagecastControlPlane

# 管理 SPA をビルドし、出力された S3 バケットへ配置 (CloudFront 配信)
pnpm --filter @stagecast/admin-web build
# aws s3 sync apps/admin-web/dist s3://<AdminWebBucket> --delete
```

- 常時稼働するのは制御層スタックのみ (S3/CloudFront・API Gateway/Lambda・DynamoDB・Cognito・成果物S3)。
  メディア層/字幕層は `media-orchestrator` がイベント単位で起動・破棄する (N-1)。
- シークレット (YouTube API キー・LiveKit キー等) はコードに置かず、
  SSM パラメータストア / Secrets Manager で管理する (ADR D-10)。
- 残作業: control-api 実ハンドラの NodejsFunction 化、イベント単位メディアスタックの
  CDK 定義、各フェイクの実 AWS SDK 実装 (`docs/PLAN.md` 末尾参照)。

## 開発ルール

- `DESIGN.md` を逸脱しない。仕様変更が要るときは ADR を書いてから。
- 各フェーズは「動く最小単位 → テスト → コミット」。テストのないコードを次フェーズへ持ち越さない。
- コスト方針 (DESIGN.md 7.2) を破る常時稼働リソースを足さない。足す場合は理由を明記。
