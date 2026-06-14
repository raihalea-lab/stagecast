# Claude Code 用プロジェクト指示書

StreamYard 型 YouTube ライブ配信プラットフォーム (`stagecast`) の開発で参照する。
グローバル設定 (`~/.claude/CLAUDE.md`) と併用。

## 設計の正と意思決定

- **`DESIGN.md`** が設計の唯一の正。要件・非機能 (N-1〜N-6)・コスト方針・アーキテクチャ図はここから引く。
- **逸脱する変更は ADR を書いてから**。`docs/decisions/0001-tech-stack.md` 〜 `0004-toolchain-vite-plus.md` 参照。
  新規 ADR は `0005-*.md` に。テンプレ: ステータス/日付/関連/コンテキスト/決定/影響・トレードオフ。
- 残作業ロードマップ: `docs/REMAINING_WORK.md` (T1〜T10)。フェーズ 0〜12 は実装済み。

## アーキテクチャ要点 (DESIGN.md 3 章)

3 層構成。**常時稼働するのは制御層のみ** (N-1)。

| 層              | 主な実装                                                        | 稼働形態                  |
| --------------- | --------------------------------------------------------------- | ------------------------- |
| 制御層          | `infra/lib/control-plane-stack.ts` (S3/CloudFront/APIGW/Lambda) | 常時・低コスト            |
| メディア/字幕層 | `infra/lib/event-media-stack.ts` (ECS/Fargate/Valkey)           | イベント時のみ・最大3並列 |
| 共有型          | `packages/shared`                                               | -                         |

イベント単位で `media-orchestrator` がスタックを起動・破棄する。**常時稼働リソースを増やすな** (DESIGN.md 7.2)。

## ツールチェイン (ADR 0004)

- **`vp`** が CLI のエントリ。`vp install / dev / build / test / check / lint / fmt`。
- ワークスペース横断: **`vp run -r <script>`** (例: `vp run -r build`)。
- 特定パッケージのみ: **`vp run --filter @stagecast/control-api <script>`**。
- 依存追加: **`vp add -D <pkg> --filter <ws>`**。
- `pnpm <script>` も同等に動く (root scripts が `vp run -r ...` を呼ぶ)。

## テスト方針 (重要)

- **外部接続なしで完結させる**。すべての外部依存 (AWS SDK・LiveKit・YouTube・Bedrock) はインターフェース + フェイク実装を経由。`USE_FAKE_ADAPTERS=true` で全部フェイクに切替可能。
- 統合テスト (実 AWS を叩く) は `*.integration.test.ts` 命名で分離し、`RUN_INTEGRATION=1` のときのみ走らせる予定 (`docs/REMAINING_WORK.md` T?)。
- テストファイルは **`*.test.ts`** で各 package の `src/` 内に同居 (vitest default 探索)。

## モデル ID / リージョン

- Bedrock デフォルトモデル: **`us.anthropic.claude-sonnet-4-5-20250929-v1:0`** (Claude Sonnet 4.5)
  - `services/caption-pipeline/src/bootstrap.ts` の `BEDROCK_MODEL_ID` フォールバック。
- Lambda / Fargate ランタイム: **Node.js 24** (Lambda は `NODEJS_24_X`)。
- AWS リージョン: `us-east-1` (Bedrock) / `ap-northeast-1` (制御層) を主に使う。

## コード規約

- TypeScript 6.0 / `strict: true` + `noUncheckedIndexedAccess` + `noFallthroughCasesInSwitch` + `noImplicitReturns` 等 (`tsconfig.base.json`)。
- バックエンド (`services/*`, `infra`) は `types: ["node"]` を tsconfig に明示し、`@types/node` を devDeps に持つ。
- フォーマット: oxfmt (`vp fmt`)。double quote / trailing comma / printWidth 80 (デフォルト)。
- Lint: oxlint (`vp lint`)。`.oxlintrc.json` でプロジェクトルールを明示 (eqeqeq / no-var / prefer-const / unicorn/prefer-node-protocol)。
- インポート: `node:` プロトコル必須 (`node:crypto`, `node:path`)。素の `crypto` / `path` は使わない。
- コメントは「なぜ」を残す。何をしているかはコードで読めるので不要。例外: DESIGN.md / ADR への参照は積極的に残す (例: `(DESIGN.md 7.2, ADR D-6)`)。

## コミット / PR

- ブランチ命名: `claude/<feature-slug>` (例: `claude/vite-plus-toolchain`)。
- コミットメッセージは 1 行・日本語・シンプル。Conventional Commits prefix を付ける (`feat:` / `chore:` / `docs:` / `ci:` / `fix:`)。
- PR は `gh pr create --base main --head <branch>`。auto-merge (`--auto --merge --delete-branch`) で CI 通過後に自動マージ可。

## 触らない方が良いもの

- `pnpm-workspace.yaml` の `overrides.vite` / `overrides.vitest` (Vite+ エイリアスの心臓部)
- `peerDependencyRules.allowedVersions.vite: "*"` (Vite+ alpha の peer 解決を緩めている誤検知対策)
- `overrides.esbuild: ">=0.28.1"` (Vite+ 0.1.x 内部 esbuild の CVE-fix)
- `infra/cdk.json` の `app: "npx tsx bin/app.ts"` (ts-node 廃止後の CDK エントリ)
- 各 backend package の `types: ["node"]` (TS 6 + pnpm 11 で auto-discovery が効かない補正)
