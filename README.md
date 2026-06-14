# Stagecast

StreamYard 型の YouTube ライブ配信プラットフォーム。配信管理者・モデレーター・登壇者が
共同で配信を運営し、スライド + 登壇者映像の合成、発表者切替、QR / タイトルのオーバーレイ、
日英を中心としたリアルタイム字幕翻訳を行い、YouTube Live で配信する。

設計の正は [`DESIGN.md`](./DESIGN.md)。技術選定は [ADR 0001](./docs/decisions/0001-tech-stack.md)、
実装計画は [`docs/PLAN.md`](./docs/PLAN.md) を参照。

- 実 AWS デプロイ・統合に向けた残作業 (T1〜T10) は [`docs/REMAINING_WORK.md`](./docs/REMAINING_WORK.md) … **完了** ✅
- 本番配信までの次フェーズ (R1〜R7: LiveKit/Egress コンテナ実体化・字幕ワーカー Docker 化・最小権限化) は
  [`ADR 0005`](./docs/decisions/0005-media-layer-rollout.md) を参照。

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

現在の実装状況: **フェーズ 0〜12 すべて実装済み**（`vp run -r build / typecheck / test` + `vp lint / fmt` 全通過、136 tests）。
外部依存（AWS SDK・LiveKit・YouTube 等）は差し替え可能なインターフェース + フェイクで実装し、
テストは外部接続なしで完結する。実 AWS への結線・デプロイは残作業。詳細は `docs/PLAN.md` / `docs/REMAINING_WORK.md`。

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

前提: Vite+ CLI (`vp`)。Node.js / pnpm は `vp` が裏で管理する。

```bash
# 初回のみ: Vite+ CLI のインストール
curl -fsSL https://vite.plus | bash    # macOS / Linux
# (Windows PowerShell の場合は: irm https://vite.plus/ps1 | iex)

vp install            # 依存をインストール (内部で pnpm install を実行)
cp .env.example .env  # 環境変数を用意 (実値はコミットしない)

vp run -r build       # 全ワークスペースをビルド
vp run -r test        # 全ワークスペースのテスト (外部接続なしで完結)
vp run -r typecheck   # 型チェック
vp lint               # oxlint 相当
vp fmt                # oxfmt 相当
vp check              # lint + fmt + typecheck をまとめて

# パッケージ追加例
vp add -D some-pkg --filter @stagecast/admin-web   # admin-web に dev 依存を追加
```

> ℹ️ **Vite+ について**: フロントエンド/テスト/パッケージ管理の統合ツールチェイン。
> `pnpm-workspace.yaml` の `overrides` で `vite` / `vitest` を
> `@voidzero-dev/vite-plus-*` にエイリアスしているため、各 package.json の
> `vite` / `vitest` 記述はそのままで Vite+ 実装が使われる。
> `vp install` は `pnpm-workspace.yaml` + `pnpm-lock.yaml` を検出して
> pnpm を裏で呼び出すため、ロックファイルや packageManager 設定はそのまま。
> 公式: https://viteplus.dev/

> 💡 `pnpm <script>` 経由でも実行可（root scripts も `vp run -r ...` を呼ぶように
> なっているため、好みの入り口で OK）。devenv が用意する `pnpm` を引き続き使える。

外部依存 (YouTube Live API, LiveKit, Transcribe, Translate, Bedrock 等) は
フェイク実装に切り替えられる (`USE_FAKE_ADAPTERS=true`)。テストは外部接続なしで通る。

## デプロイ手順

制御層 (常時稼働) の CDK スタックを synth/deploy する。
**手動デプロイ** と **GitHub Actions (手動 dispatch)** の 2 経路がある。

### 事前準備 (一度きり)

```bash
# AWS 認証 (ローカル) — Claude Code 実行時はブラウザで認証操作する
aws sso login    # または aws login

# CDK bootstrap (アカウント x リージョンごとに 1 回)
vp run --filter @stagecast/infra cdk -- bootstrap aws://<account>/<region>
```

### ローカルから手動デプロイ

```bash
# 1. テンプレ生成の健全性チェック
vp run --filter @stagecast/infra synth

# 2. 差分確認
vp run --filter @stagecast/infra cdk -- diff StagecastControlPlane

# 3. 制御層デプロイ (control-api Lambda + Secrets + Cognito + reconcile Lambda)
vp run --filter @stagecast/infra cdk -- deploy StagecastControlPlane \
  --require-approval never \
  --outputs-file infra/cdk-outputs.json

# 4. シークレットを実値で更新 (LiveKit / YouTube)
aws secretsmanager update-secret --secret-id stagecast/livekit \
  --secret-string '{"url":"wss://...","apiKey":"...","apiSecret":"..."}'

# 5. フロント (admin-web / stage-web) をビルドして S3 へ配置
VITE_CONTROL_API_URL="$(jq -r '.StagecastControlPlane.ControlApiEndpoint' infra/cdk-outputs.json)" \
VITE_COGNITO_DOMAIN="$(jq -r '.StagecastControlPlane.AdminAuthDomain' infra/cdk-outputs.json)" \
VITE_COGNITO_USER_POOL_CLIENT_ID="$(jq -r '.StagecastControlPlane.AdminUserPoolClientId' infra/cdk-outputs.json)" \
  vp run --filter @stagecast/admin-web build

aws s3 sync apps/admin-web/dist \
  "s3://$(jq -r '.StagecastControlPlane.AdminWebBucketName' infra/cdk-outputs.json)" --delete

aws cloudfront create-invalidation \
  --distribution-id "$(jq -r '.StagecastControlPlane.AdminWebDistributionId' infra/cdk-outputs.json)" \
  --paths '/*'
```

### GitHub Actions から (T10)

`.github/workflows/deploy.yml` を **Actions → Deploy → Run workflow** で起動する。
入力:

- `environment`: dev / staging / prod のいずれか (GitHub Environment と一致)
- `dry-run`: true (cdk diff のみ) / false (cdk deploy + S3 sync まで実行)

事前に Environment ごとに以下を設定する:

- `vars.AWS_DEPLOY_ROLE_ARN`: GitHub OIDC で引き受ける IAM Role の ARN
- `vars.AWS_REGION`: 既定 ap-northeast-1

### 運用上の注意

- 常時稼働するのは制御層スタックのみ (S3/CloudFront・API Gateway/Lambda・DynamoDB・Cognito・成果物S3・SNS Topic)。
  メディア層/字幕層は `media-orchestrator` がイベント単位で起動・破棄する (N-1)。
- イベント単位スタックの起動・破棄は **reconcile Lambda** (60s tick) が自動で行う (ADR 0003 D-2)。
- シークレット (YouTube API キー・LiveKit キー等) はコードに置かず、Secrets Manager から注入する (T7, ADR D-10)。
- 実 AWS との疎通確認は `pnpm run test:integration` (`*.integration.test.ts`) で行える (T8)。
  RUN_INTEGRATION 環境変数が立たない通常 CI ではスキップされる。

## 開発ルール

- `DESIGN.md` を逸脱しない。仕様変更が要るときは ADR を書いてから。
- 各フェーズは「動く最小単位 → テスト → コミット」。テストのないコードを次フェーズへ持ち越さない。
- コスト方針 (DESIGN.md 7.2) を破る常時稼働リソースを足さない。足す場合は理由を明記。
