# syntax=docker/dockerfile:1
#
# 字幕ワーカー (services/caption-pipeline) のコンテナイメージ (R4, ADR 0005 D-3)。
# ビルドコンテキストは monorepo ルート (pnpm workspace のため):
#   docker build -f services/caption-pipeline/Dockerfile -t caption-worker .
#
# alpine ではなく slim(glibc) を採用する理由: @livekit/rtc-node 等のネイティブ依存の
# prebuilt バイナリは glibc 向けが安定して提供されるため (musl 互換は不安定)。

FROM node:24-slim AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

# lockfile 駆動で再現性のある install。workspace 全体が必要なのでルートごとコピーする
# (.dockerignore で node_modules / dist 等は除外済み)。
COPY . .
RUN pnpm install --frozen-lockfile

# 依存ワークスペース (shared) と本体をビルドし、prod 依存だけの自己完結ディレクトリへ deploy。
RUN pnpm --filter @stagecast/shared build \
  && pnpm --filter @stagecast/caption-pipeline build \
  && pnpm --filter @stagecast/caption-pipeline deploy --prod /app

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app ./
USER node
# エントリは services/caption-pipeline/src/main.ts → dist/main.js (環境変数で構成)。
CMD ["node", "dist/main.js"]
