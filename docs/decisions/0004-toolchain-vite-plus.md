# ADR 0004: ツールチェインを Vite+ ベースに統合 (Node 24 / TS 6 / pnpm 11)

- ステータス: Accepted
- 日付: 2026-06-15
- 関連: ADR 0001 D-9（テスト/Lint/ビルド）を一部置き換え

## コンテキスト

ADR 0001 D-9 で「テスト = Vitest / Lint = ESLint + Prettier / バンドル = tsup / CDK = cdk synth」と
固定したが、開発開始から数日で次の状況になった。

- 2026-03 リリースの **Vite 8（Rolldown 統合）** で本番ビルドが 10〜30 倍高速。
- **Vite+**（[viteplus.dev](https://viteplus.dev/)）が `vite / vitest / oxlint / oxfmt / tsdown` を
  統合した CLI (`vp`) として提供され、ローカル/CI のエントリポイントを 1 本に絞れる。
- pnpm 11 リリース、TypeScript 6 リリース、Node.js 24 LTS が Lambda でも利用可能（2025-11〜）に。

`DESIGN.md` 9 章および N-1（非配信時固定費ゼロ）に影響しない範囲でツールチェインを
今のうちに統一しておく方が、後段（実 AWS 結線・E2E）での認知負荷が下がる。

## 決定

### D-1. ランタイム: Node.js 24 LTS に統一

- ローカル（devenv `nodejs_24`）/ CI（`actions/setup-node@v4`）/ Lambda（`NODEJS_24_X`）/
  Fargate（`node:24-alpine`）すべてを 24 系で揃える。
- Node 24 LTS のサポートは 2028-04 まで（参考: AWS Lambda の Node.js 24 ランタイムも同年 EOL）。

### D-2. パッケージマネージャ: pnpm 11 + corepack + Vite+ (`vp install`)

- `packageManager: pnpm@11.6.0` を package.json に明示。corepack 経由で解決。
- `pnpm-workspace.yaml` の `overrides` で `vite` / `vitest` を
  `@voidzero-dev/vite-plus-core` / `@voidzero-dev/vite-plus-test` にエイリアス。
- `vp install` は内部で pnpm を呼び出すラッパで、`pnpm-workspace.yaml` + `pnpm-lock.yaml`
  をそのまま利用する（脱 pnpm の意図ではなく、UI を `vp` に統一するだけ）。

### D-3. フロント/テストビルド: Vite 8 + Vitest 4 (Vite+ 経由) + Rolldown

- `apps/admin-web` / `apps/stage-web` の `vp dev` / `vp build` は Vite 8 + Rolldown。
- 既存の `import { describe, expect, it } from "vitest"` は overrides 解決で
  そのまま `@voidzero-dev/vite-plus-test` を指すため、テストコード本体は無改修。
- `stage-web` の `vite.config.ts` で `livekit-client` を別チャンク化し、初期 bundle を
  614KB → 145KB に削減。

### D-4. Lint / Format: oxlint + oxfmt (`vp lint` / `vp fmt` / `vp check`)

- ESLint + Prettier を撤去し、Vite+ 同梱の **oxlint**（Rust 製・並列）/ **oxfmt** に置換。
- oxfmt の既定（double quote 等）を採用。コードベース全体（153 ファイル）を一度に整形して
  差分を吸収。プロジェクトルートの `vite.config.ts` で `fmt.ignorePatterns` のみ管理。
- `vp check` で lint + fmt + typecheck をまとめて回す（CI も同等）。

### D-5. TypeScript 6 採用と `@types/node` の明示化

- 全パッケージ `typescript: ^6.0.3`。
- pnpm 11 + TS 6 の組み合わせは workspace 配下の `@types/*` auto-discovery が効きづらい
  ため、Node API を使うパッケージには `@types/node` を **明示的に devDeps へ追加**し、
  tsconfig に `types: ["node"]` を入れる（`services/media-composer`, `services/media-orchestrator`,
  `infra`）。Apps（browser）は `types: ["vite/client"]` のままで Node 型を含めない。
- `infra` の `moduleResolution` は TS 7 で廃止予定の `Node`（=node10）から
  `Bundler` に変更（ts-node + CDK で動作確認済み）。

### D-6. CI: `voidzero-dev/setup-vp@v1` で 1 ステップ起動

- `actions/setup-node` を撤去し、`voidzero-dev/setup-vp@v1` に集約（`node-version: "24"` /
  `cache: true` / `run-install: true`）。
- ジョブ本体は `vp lint → vp run -r build → vp run -r typecheck → vp run -r test`。

## 影響・トレードオフ

- **採否のリスク**: Vite+ は 0.1.x（alpha 相当）。`./config` サブパスが未エクスポート等の
  小さい packaging 不備があり、回避のため per-app の `vite.config.ts` から `test:` キーは
  外している（default 探索で十分）。GA 後に再評価する。
- **二重管理回避**: pnpm 11 から package.json の `pnpm` フィールドが読まれず、
  `allowBuilds` などは `pnpm-workspace.yaml` に集約される。
- **乗り換えコストはほぼゼロ**: ADR 0001 で確定した「pnpm workspaces + TypeScript project
  references」の構造は維持。`pnpm <script>` も引き続き動く（root scripts が `vp run -r ...`
  を呼ぶため、入口は好みで選べる）。
- **bundle 速度**: Vite 8 + Rolldown 化で admin-web/stage-web のビルドが大幅短縮（数百 ms 台）。
- **devenv**: `corepack.enable = true` を残し、`vp` 未インストール環境でも `pnpm <script>` が
  動くフォールバックを確保（`devenv.nix` 参照）。

## ADR 0001 D-9 との関係

ADR 0001 D-9 の「テスト/Lint/ビルド」の具体ツール選定を本 ADR で置き換える:

| 項目       | ADR 0001 D-9              | 本 ADR (0004)                                     |
| ---------- | ------------------------- | ------------------------------------------------- |
| テスト     | Vitest                    | Vitest 4 API（Vite+ 経由で実体は vite-plus-test） |
| Lint       | ESLint                    | oxlint (`vp lint`)                                |
| Format     | Prettier                  | oxfmt (`vp fmt`)                                  |
| 型チェック | `tsc --noEmit`            | `tsc --noEmit`（変更なし）                        |
| バンドラ   | tsup                      | Rolldown / tsdown（Vite+ 内包）                   |
| CI 入口    | GitHub Actions（pnpm 系） | GitHub Actions + `setup-vp@v1`                    |
