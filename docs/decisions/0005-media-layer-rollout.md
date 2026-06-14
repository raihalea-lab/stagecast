# ADR 0005: メディア層運用化と段階的デプロイ戦略

- ステータス: Accepted
- 日付: 2026-06-15
- 関連: `DESIGN.md` 3.2 / 7 章 / 9.1、ADR 0001（D-6 ECS, D-7 Valkey, D-10 Secrets）、
  ADR 0003（障害時方針）、[`docs/REMAINING_WORK.md`](../REMAINING_WORK.md)（T1〜T10 = 完了）

## コンテキスト

REMAINING_WORK T1〜T10（PR #9）で次のものが揃った:

- 制御層 (ControlPlaneStack): NodejsFunction control-api / Cognito + Hosted UI / Secrets Manager
  / reconcile Lambda（EventBridge 60 s）/ admin-web + stage-web の S3+CloudFront 配信
- 字幕パイプライン: LiveKit AudioSource + ValkeyStreamClient + EMF メトリクス
- メディア合成: LiveKit Egress クライアント + 発表状態購読
- 統合テスト基盤 (`*.integration.test.ts` / `RUN_INTEGRATION=1`)
- CI に `cdk synth` を追加、`deploy.yml` を OIDC 認証で雛形化

しかし **「いま `cdk deploy` だけして本番配信ができる状態か？」** を冷静に評価すると、
メディア層 (EventMediaStack) のコンテナ運用が骨格のみで、以下が未整備である:

| 領域                   | 状況                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| LiveKit Server (SFU)   | `image: livekit/livekit-server:latest` を指定しただけ。WebRTC ポート (UDP 7882 等)・config.yaml・外部到達性 (NLB or Cloudflare) なし |
| LiveKit Egress         | 同上。Egress テンプレ URL や Chrome ヘッドレス前提が未整理                                                                           |
| 字幕ワーカー           | `node:24-alpine` プレースホルダ。`services/caption-pipeline` を実際に Docker 化 + ECR push する仕組みなし                            |
| Cognito 管理者ユーザー | CDK は User Pool を作るだけ。実ユーザーの招待手順が未自動化                                                                          |
| reconcile Lambda IAM   | `ec2:* / ecs:* / iam:* / logs:*` と広い。動作確認後に絞る必要                                                                        |
| 統合テスト             | 一度も実 AWS で実行していない (skip されるだけ)                                                                                      |
| YouTube Live 連携      | ingestion URL の取得・stream key のローテーション運用が未策定                                                                        |

このまま全部一気に進めると変更範囲が大きく、デバッグが困難になる。本 ADR で **段階的
ロールアウト戦略** と **次の作業項目 (R1〜R7)** を確定し、PR を分割する基準にする。

## 決定

### D-1. ロールアウトを 5 ステージに分割する

| Stage                                   | スコープ                                                                                                                                                 | 終了条件                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **S1: 制御層 dry-run**                  | `vp run --filter @stagecast/infra cdk -- diff` で全リソースを確認、`cdk bootstrap` 実施                                                                  | diff が想定どおり                                              |
| **S2: 制御層 deploy**                   | `cdk deploy StagecastControlPlane`、Cognito 管理者 1 名手動作成、admin-web を S3+CloudFront へ配信、`RUN_INTEGRATION=1` で DynamoDB/S3/Cognito 疎通 (T8) | admin-web からログインしてイベント作成できる                   |
| **S3: LiveKit コンテナ実体化 (R1〜R3)** | LiveKit Server/Egress を Fargate で動かす config と外部到達性整備、stage-web から実 LiveKit に接続                                                       | ローカル → 実 LiveKit → 実 SFU で音声/映像が往復               |
| **S4: 字幕ワーカー Docker 化 (R4)**     | `services/caption-pipeline` の Dockerfile + ECR repository + CodeBuild or GitHub Actions による push、reconcile Lambda が新イメージを使うよう更新        | 1 イベント手動起動で字幕が CaptionConnectionHub から流れる     |
| **S5: 最小権限化・本番化 (R5〜R7)**     | reconcile Lambda IAM を最小権限に、CloudFront カスタムドメイン+ACM、Cognito 招待運用、YouTube ingestion 取得を自動化                                     | 1 イベントを実 YouTube Live に配信、SLO (字幕遅延 ≦ 3s) を観測 |

各 Stage は **独立した PR** とし、Stage が完了するまで次に進まない。S3 以降は実 AWS
コストが発生するため、コスト試算を PR description に必ず付ける。

### D-2. LiveKit 運用方針: self-hosted Fargate を継続。LiveKit Cloud は将来検討

ADR 0001 D-6 で「SFU は LiveKit (Fargate)」と決めた。本 ADR でも維持する。

- **Self-hosted (現状方針)**:
  - メリット: コスト N-1 と整合（イベント時のみ起動）、Valkey/Egress とネットワーク共有が楽
  - デメリット: 外部到達性 (Public IP / NLB / TURN / Cloudflare WebRTC) の構築が必要、
    config.yaml の管理、TURN サーバ運用
- **LiveKit Cloud (将来選択肢)**:
  - メリット: 上記運用負担ゼロ、グローバル分散、自動スケール
  - デメリット: 月額固定費 (N-1 に反する)、字幕生成タスクを別経路で扱う必要

判断: **規模が小さい (最大 3 並列イベント) うちは self-hosted で十分**。年間配信時間が
ある閾値を超えたら LiveKit Cloud へ移行する ADR を別途立てる (本 ADR の射程外)。

### D-3. 字幕ワーカー Docker 化: monorepo 用マルチステージビルド + ECR

`services/caption-pipeline` を Lambda ではなく Fargate で動かす理由は `DESIGN.md` 6 章で
「ストリーミング ASR は持続接続のためサーバレスとミスマッチ」だから。Docker 化の方針:

- **Dockerfile は monorepo 全体をビルドコンテキストに取る**（pnpm workspace のため）。
  マルチステージで builder → runtime に分け、runtime は `services/caption-pipeline/dist/main.js`
  と関連ワークスペース dist だけを含める。
- **イメージレジストリは ECR Private**。ControlPlaneStack に `ecr.Repository` を追加し、
  EventMediaStack はそこから pull する。リポジトリ名は `stagecast/caption-worker`。
- **タグ戦略**: `main-${git-sha-short}` と `latest`。reconcile が参照するのは `latest`
  (再起動時に必ず新版を引く)。
- **ビルド/push**: 当面は GitHub Actions の `deploy.yml` 内 (環境 dev のみ)、後段で
  AWS CodeBuild に切替検討。
- **イメージサイズ目標**: 250 MB 未満 (alpine + Node 24 + AWS SDK 同梱なし)。

### D-4. Cognito 管理者ユーザーの初期投入: 手動 → CDK Custom Resource

S2 では `aws cognito-idp admin-create-user` で手動投入する。S5 で以下のいずれかへ:

- **(A) CDK Custom Resource** で初期管理者リストを context (`-c initialAdmins=a@x,b@y`) で渡し、
  デプロイ時に AdminCreateUser を呼ぶ
- **(B) Slack / Linear などの招待ワークフロー** から API を叩く別ツールを切り出す

採用は (A)。Custom Resource は Lambda を 1 つ増やすが、IaC 内に閉じるのでドリフトしない。
パスワードは初回招待メール経由 (Cognito 標準)。

### D-5. reconcile Lambda IAM の最小権限化

現状の広い権限 (`ec2:* / ecs:* / iam:* / s3:*` 等) は **EventMediaStack の作成・破棄に
必要な全権限を CFN に委譲しているため**。S5 で:

- CloudFormation Service Role を別途定義し、reconcile Lambda は **その Service Role を
  `iam:PassRole` で渡すだけ** にする (Lambda 自身は ec2/ecs/iam を直接持たない)
- Service Role の信頼ポリシーは `cloudformation.amazonaws.com` 限定
- これにより Lambda が乗っ取られても EventMediaStack 経由でしか権限を行使できない

### D-6. 統合テストを CI に手動 dispatch ジョブとして追加

T8 で書いた `*.integration.test.ts` は S2 完了後に CI から走らせたい。

- `.github/workflows/integration.yml` を **手動 dispatch + environment ガード** で追加
- 引数で対象 package を選べる (`@stagecast/control-api`, `@stagecast/caption-pipeline` 等)
- OIDC で test 用 IAM Role を引き受け、`RUN_INTEGRATION=1 pnpm --filter <pkg> test` を実行
- 結果は GitHub Step Summary にコスト概算 (Translate 文字数 / Bedrock token / S3 PUT 数) と共に出す

## 次の作業項目 (R1〜R7)

| ID     | スコープ                                                                                                                                                                                      | Stage | 想定 PR                          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------- |
| **R1** | LiveKit Server config.yaml と環境変数を `EventMediaStack` に注入 (Valkey 接続、Redis Adapter モード)。WebRTC 用 UDP ポート公開 (NLB or Public IP)。AWS Network Load Balancer + Security Group | S3    | `claude/livekit-server-config`   |
| **R2** | LiveKit Egress を `livekit/egress` イメージで動かす設定。Chrome ヘッドレスの依存・S3 出力 IAM・Egress テンプレ URL (CloudFront 上で配信)                                                      | S3    | `claude/livekit-egress-config`   |
| **R3** | stage-web → 実 LiveKit 接続疎通。`/join` から発行されたトークンで実 SFU に publish/subscribe できることを E2E (Playwright)                                                                    | S3    | `claude/stage-web-livekit-e2e`   |
| **R4** | 字幕ワーカー Docker 化 (Dockerfile + ECR Repository + GHA build & push)。`reconcile` が新タグを反映                                                                                           | S4    | `claude/caption-worker-docker`   |
| **R5** | reconcile Lambda IAM の最小権限化 (D-5)。CFN Service Role + PassRole                                                                                                                          | S5    | `claude/reconcile-iam-min`       |
| **R6** | Cognito 管理者 Custom Resource (D-4)。CloudFront カスタムドメイン + ACM 証明書 (us-east-1)                                                                                                    | S5    | `claude/cognito-admin-bootstrap` |
| **R7** | 統合テスト CI ワークフロー (D-6) + YouTube Live 連携 (ingestion URL 取得自動化、stream key を Secrets Manager に保存)                                                                         | S5    | `claude/integration-ci-youtube`  |

## 影響・トレードオフ

- **利点**: PR が小さく独立するため、各段階で回帰を切り分けやすい。コストも段階的に発生する
  (S2 までは月数 USD、S3 以降は配信時間に応じて増える)。本番事故時に「直前の Stage に戻す」
  という選択肢が常に取れる。
- **欠点**: フルスタックの配信フローが通るまで 5 Stage = 5 PR 分の時間がかかる。学びが
  Stage を跨いだ際に古びるリスク (例: S3 で気付いた LiveKit config の制約が S5 までに
  影響する)。
- **緩和**: 本 ADR を Stage 進行中も更新し、各 Stage 完了時に「想定外だったこと」を
  追記する。R1〜R7 完了後に「ADR 0006 本番運用知見」として総括する。

## 補足: 今すぐ部分デプロイしたい場合の最小経路 (S1+S2 だけ)

```bash
# 制御層のみ。メディア層 (EventMediaStack) は reconcile が live イベントを見つけない限り起動しない。
aws sso login
vp run --filter @stagecast/infra cdk -- bootstrap aws://<account>/ap-northeast-1
vp run --filter @stagecast/infra cdk -- deploy StagecastControlPlane

# 出力からフロントをビルド + 配信 (README デプロイ手順参照)。
# 管理者 1 名を作成:
aws cognito-idp admin-create-user \
  --user-pool-id <AdminUserPoolId> \
  --username admin@example.com \
  --user-attributes Name=email,Value=admin@example.com Name=email_verified,Value=true \
  --temporary-password 'Temp#Password1!'

# 統合テスト疎通 (DynamoDB / S3 / Cognito):
COGNITO_ID_TOKEN=<手動取得> RUN_INTEGRATION=1 \
  pnpm --filter @stagecast/control-api test
```

これだけで「制御層が動いているがメディア層は無 (= reconcile が空ループ)」という安全な
状態が作れる。コストは月 数 USD オーダーに収まる (N-1 の精神を保つ)。

## 未解決 (将来 ADR)

- LiveKit Cloud への移行判断基準 (年間配信時間・スループット閾値)
- マルチリージョン DR (us-east-1 が落ちたら ap-northeast-1 で再開、など)
- 配信中の二重 Egress による完全無停止 (ADR 0003 未解決事項)
