# ADR 0019: 字幕ワーカーイメージのビルドを GitHub Actions から CDK DockerImageAsset に移行

- **ステータス**: 採用
- **日付**: 2026-09-08
- **関連**: ADR 0005 D-3 (supersede), ADR 0016 D-6, ADR 0017

## コンテキスト

ADR 0005 D-3 では字幕ワーカー (`services/caption-pipeline`) のイメージを「当面は GitHub Actions で
build/push し、後段で CodeBuild を検討」とし、R4 で `build-caption-worker.yml` (workflow_dispatch) と
専用 ECR リポジトリ `stagecast/caption-worker` を用意した。reconcile は `latest` タグを参照する。

その後の運用で前提が変わった。

- CI (`ci.yml`) は pre-push フックに置き換えて無効化しており、デプロイもローカルの `cdk deploy` から行う。
  イメージビルドだけが GHA に残り、「マージ後にワークフローを手動実行する」手順が必要だった
  (ADR 0017 の keepalive 修正時に実際にこの手順が発生した)。
- ADR 0016 D-6 で Caddy サイドカーを `DockerImageAsset` でビルドする前例ができ、
  reconcile へは `CADDY_SIDECAR_IMAGE` 環境変数でイメージ URI を渡す配線が既にある。
- `latest` タグは「どのコードが動いているか」をデプロイから追えない。

## 決定

- `ControlPlaneStack` に `DockerImageAsset` (`CaptionWorkerImage`) を追加し、`cdk deploy` 時に
  monorepo ルートをコンテキストとして `services/caption-pipeline/Dockerfile` をビルド・push する。
  `platform` は EventMediaStack の Fargate に合わせて `LINUX_ARM64` を明示する。
- reconcile Lambda の `CAPTION_WORKER_IMAGE` にはハッシュタグ付きの `imageUri` を渡す。
  `CfnOutput` `CaptionWorkerImageUri` で確認できる。
- `build-caption-worker.yml` と `ecr.Repository` (`stagecast/caption-worker`) は削除する。
  CDK Assets 用 ECR (bootstrap が作るもの) に格納される。
- `.dockerignore` に `.devenv` / `.direnv` / `.claude` / `.env*` を追加する。devenv の `profile` は
  `/nix/store` への symlink で、これを除外しないと DockerImageAsset の走査が終わらない
  (GHA ではチェックアウト直後で存在しなかったため顕在化していなかった)。
  `exclude` で `docs` と Markdown も追加除外し、文書変更で再ビルドが走らないようにする。

## 影響・トレードオフ

| 項目         | 変更前 (ADR 0005 D-3)              | 変更後                                      |
| ------------ | ---------------------------------- | ------------------------------------------- |
| ビルド場所   | GitHub Actions (手動 dispatch)     | `cdk deploy` を実行するマシン (Docker 必須) |
| 反映手順     | マージ → dispatch → 次イベントから | `cdk deploy` のみ                           |
| タグ         | `latest` (mutable)                 | コンテンツハッシュ (immutable)              |
| 常設リソース | ECR Repository + lifecycle rule    | なし (CDK Assets ECR を共用)                |
| ビルド頻度   | 手動                               | ルート配下の変更ごと (`docs`/`*.md` は除外) |

- monorepo 全体がハッシュ対象なので、無関係な変更でも次回 deploy で再ビルドが走る
  (数分)。実害が出たら `exclude` を `apps/*/src` や `infra/lib` まで広げる
  (`package.json` は `pnpm install --frozen-lockfile` に必要なので残す)。
- ADR 0016 で事前作成済み (desiredCount 0) の EventMediaStack は古い URI を保持する。
  次回のテンプレート再レンダリングで新イメージに切り替わる。
- Docker Desktop の無いマシンからはデプロイできなくなる。Caddy で既に同じ制約があるため新規の制約ではない。
- 旧 ECR の「直近 10 イメージ保持」ライフサイクルルールは無くなり、CDK Assets ECR には
  ハッシュごとのイメージ (約 420 MB) が溜まる。ECR は $0.10/GB-月なので 10 世代で $0.4/月程度。
  気になったら `cdk gc` で未参照アセットを掃除する。
- PR 時に Dockerfile をビルドする自動チェック (`build-caption-worker.yml` の pull_request トリガー) も無くなる。
  CI 無効化 + pre-push フックの現行運用では、Dockerfile の破損は `cdk deploy` で初めて分かる。
