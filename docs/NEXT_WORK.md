# 次フェーズ作業ロードマップ

> 2026-06-15 起票。`docs/REMAINING_WORK.md` (T1〜T10) の **次** に来る作業を、
> 本ファイルでまとめて管理する。意思決定は [ADR 0005](./decisions/0005-media-layer-rollout.md) を参照。
>
> カテゴリ:
>
> - **R**: メディア層実体化・本番配信化 (= ADR 0005 R1〜R7。最優先)
> - **O**: 運用準備 (AWS 認証・GitHub 設定・初回デプロイ手順)
> - **D**: 技術的負債 (今回 PR #9 で残した宿題)
> - **N**: Nice-to-have (UX/DX 改善・遠い未来)
> - **L**: 法的・運用 (公開前に決めるべき事項)
> - **P**: 未マージ PR (Dependabot 等)
>
> 各タスクは独立に着手可能なよう書く。**着手前にコスト見積もり**を PR description に書く慣習を維持。

---

## R: メディア層実体化・本番配信化 (ADR 0005)

> 詳細・決定背景は [ADR 0005](./decisions/0005-media-layer-rollout.md) を参照。
> 5 Stage に分けて段階的にロールアウト。各 Stage 完了まで次に進まない。

| ID     | Stage | スコープ                                                           | 想定 PR                                    | 完了基準                                                                   |
| ------ | ----- | ------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------- |
| **R1** | S3    | LiveKit Server の config.yaml + Valkey 接続 + UDP ポート公開 (NLB) | `claude/livekit-stage3` (IaC 完)           | stage-web から実 LiveKit に接続できる (deploy は別)                        |
| **R2** | S3    | LiveKit Egress の Chrome ヘッドレス設定 + Egress テンプレ URL      | `claude/livekit-stage3` (IaC 完)           | RoomComposite Egress で合成映像が RTMP に出る                              |
| **R3** | S3    | stage-web → 実 LiveKit E2E (Playwright)                            | `claude/stage-web-livekit-e2e`             | 雛形 (`describe.skip`) のみ。Playwright 実装は別 PR                        |
| **R4** | S4    | 字幕ワーカー Docker 化 + ECR Repository + GHA build/push           | `claude/caption-worker-docker` (IaC/CI 完) | Dockerfile + ECR + GHA build 完。実 push/疎通は deploy 後                  |
| **R5** | S5    | reconcile Lambda IAM 最小化 (CFN Service Role + PassRole)          | `claude/reconcile-iam-min` (完)            | reconcile は cloudformation:\* + iam:PassRole のみ (実権限は CFN ロールへ) |
| **R6** | S5    | Cognito 管理者 Custom Resource + CloudFront カスタムドメイン + ACM | `claude/cognito-admin-bootstrap`           | 初期管理者 1 名が IaC でデプロイされる                                     |
| **R7** | S5    | 統合テスト CI workflow + YouTube ingestion URL 自動取得            | `claude/integration-ci-youtube`            | 1 イベントを実 YouTube Live に配信、SLO 観測                               |

---

## O: 運用準備 (初回デプロイ前にやること)

### O1. AWS アカウント側の事前準備

- [ ] AWS アカウント (dev / staging / prod) の用意。最低でも dev は確保する
- [ ] 各アカウント × 主要リージョン (ap-northeast-1, us-east-1) で `cdk bootstrap`
  ```bash
  vp run --filter @stagecast/infra cdk -- bootstrap aws://<account>/ap-northeast-1
  vp run --filter @stagecast/infra cdk -- bootstrap aws://<account>/us-east-1   # Bedrock 用
  ```
- [ ] Bedrock のモデルアクセス申請 (`us.anthropic.claude-sonnet-4-5-...`) を us-east-1 で実施
- [ ] AWS Budgets でアカウント全体に **月額アラート** を設定 (例: 50 USD で通知, 100 USD で停止検討)

### O2. GitHub OIDC IAM Role の作成 (deploy.yml が引き受ける)

`.github/workflows/deploy.yml` は GitHub OIDC で AWS Role を引き受ける構成。
そのための IAM Role を **手動 or 別 CDK スタックで** 作る必要がある。

- [ ] IAM OIDC Provider (`token.actions.githubusercontent.com`) を有効化
- [ ] IAM Role `stagecast-github-deploy` を作成 (信頼ポリシーで repo + ref を限定)
- [ ] 必要権限を付与: CloudFormation / S3 (CDK assets / SPA bucket) / CloudFront invalidation / Lambda update / Secrets Manager
- [ ] GitHub の Environment (`dev` / `staging` / `prod`) を作成、`AWS_DEPLOY_ROLE_ARN` を vars に登録

参考: `.github/workflows/deploy.yml` の `permissions: id-token: write` と `aws-actions/configure-aws-credentials@v6` 部分。

### O3. main ブランチ保護

- [ ] GitHub Settings → Branches で `main` に branch protection rule
  - Require pull request reviews (1 approval) ※ 個人開発なら省略可
  - Require status checks: `build-test`
  - Restrict who can push to matching branches
  - Require linear history (rebase or squash 強制)

### O4. Cognito 管理者ユーザーの作成 (S2 一時手順)

R6 で Custom Resource 化されるまでの暫定手順:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <出力 AdminUserPoolId> \
  --username admin@example.com \
  --user-attributes Name=email,Value=admin@example.com Name=email_verified,Value=true \
  --temporary-password 'Temp#Password1!'
```

### O5. Secrets Manager の実値投入

CDK が空テンプレートで作成するので、デプロイ後に実値で更新:

```bash
aws secretsmanager update-secret --secret-id stagecast/livekit \
  --secret-string '{"url":"wss://...","apiKey":"...","apiSecret":"..."}'

aws secretsmanager update-secret --secret-id stagecast/youtube \
  --secret-string '{"apiKey":"...","oauthClientId":"...","oauthClientSecret":"..."}'
```

---

## D: 技術的負債 (今回 PR #9 で残した宿題)

### D1. reconcile Lambda の bundle が 34 MB (CDK 同梱) ✅ 対応済み (案 b)

~~`render-template.ts` を動的 import するため esbuild が aws-cdk-lib 全体をバンドル~~ →
**案 (b) 別 Lambda 切り出し**を採用。`RenderTemplateFunction` (aws-cdk-lib 同梱 ~34MB) を
新設し、reconcile はそれを invoke するだけにした。これにより **reconcile 本体のバンドルは
34.4MB → 7.3KB** に縮小 (synth で確認)。`renderTemplate` を `string | Promise<string>` に
拡張し Lambda invoke (async) に対応。案 (a) は D5 の short-hash 計算と競合するため不採用。

### D2. `infra/bin/app.ts` の file mode が 100755 になっている ✅ 対応済み

~~PR #9 マージ時に実行ビットが付いたままコミットされた~~ → `chmod 644` で 100644 に戻した。

### D3. LiveKit SDK 側の API 検証 ✅ (`claude/livekit-stage3` で対応)

- ~~`LiveKitEgressClient.startRoomCompositeEgress` のレイアウト名 (`speaker` / `grid` /
  `single-speaker`)~~ → LiveKit RoomComposite の組み込みプリセットと一致を確認 (ADR 0006 D-5)。
  実 `EgressClient` への `createLiveKitEgressApi` アダプタを追加し型整合。
- ~~`LiveKitAudioSource` の `@livekit/rtc-node` 想定 API~~ → 実 SDK の `RoomEvent.TrackSubscribed`
  - `AudioStream`(ReadableStream) に整合。string indirection を撤廃し `import type` へ (ADR 0006 D-7)。
- 実 SDK 経路の疎通確認は R3 (Playwright) で行う。

### D4. Cognito Hosted UI ドメインの衝突リスク

現状: `stagecast-admin-{account}` で domain prefix を組む。AWS 全体で一意なので、
他者が同じ account suffix を使った場合に衝突 (実際にはほぼ無い)。**ACM カスタムドメイン
に切替えれば回避** (R6 でやる)。

### D5. `EventMediaStack` の Valkey serverlessCacheName が 40 文字上限 ✅ (`claude/livekit-stage3` で対応)

~~`stagecast-${eventId}`.toLowerCase().slice(0, 40)` でクリップ~~ → `serverlessCacheName()`
ヘルパで eventId の sha256 short hash を末尾に付与し、40 文字に収めつつ衝突を回避
(クリップ後に prefix が衝突しても全体は一意)。単体テスト追加済み。

### D6. `pnpm-lock.yaml` に AWS SDK 子パッケージ追加で diff が出やすい ✅ 対応済み

`dependabot.yml` で `aws-sdk` / `aws-cdk` / `vite-plus` / `types` をグループ化済み。
LiveKit SDK 追加に合わせて `livekit` グループ (`livekit-server-sdk` / `@livekit/*`) も追加した。

### D7. reconcile Lambda IAM が広い (`ec2:* / ecs:* / iam:*`) ✅ R5 で対応

`EventMediaCfnExecRole` (CloudFormation サービスロール) に実リソース作成権限を集約し、
reconcile Lambda 自身は `cloudformation:*` (スタック操作) + `iam:PassRole` (当該ロール限定) のみに縮小。
副次的に、R1 で追加した NLB 作成に必要な `elasticloadbalancing:*` も CFN ロールへ付与し権限不足を解消。

---

## N: Nice-to-have (UX / DX 改善・遠い未来)

### N1. 配信後の成果物 UI

- 録画 (S3) と確定字幕 (SRT/VTT) を admin-web からダウンロードできる UI
- イベント詳細ページに「録画」「字幕 ja/en」のダウンロードリンク
- `S3AssetUploadSigner` を流用して presigned GET URL を発行

### N2. ローカル開発用 docker-compose

- LiveKit Server + Valkey + 字幕ワーカーをローカルで立ち上げる `docker-compose.yml`
- `USE_FAKE_ADAPTERS=true` で外部接続なしに動かす経路は既にあるが、**実プロトコルで
  鳴らしたい時** に欲しい

### N3. 観測性の強化

- AWS X-Ray の有効化 (Lambda / Fargate)。reconcile → CFN → ECS の trace が繋がる (未)
- ✅ 構造化ログ: `@stagecast/shared` の `createLogger` (1 行 1 JSON, `component`/`eventId` 束縛)
  に切替え。pino は使わず Lambda/Fargate バンドルを軽く保つ。caption-worker / audio-source /
  media-composer / reconcile で採用。CloudWatch Logs Insights で `eventId` 絞り込み可。
  EMF メトリクス出力 (`metrics.ts`) は別フォーマットなので据え置き
- Slack 通知 webhook を SNS Topic に subscribe (現状は SNS Topic を作っただけで購読者ゼロ) (未)

### N4. 配信前リハーサル機能

- イベント status `draft` で **本番と同じスタックを 5 分だけ起動** → 自動破棄
- リハーサル中は YouTube に送出しない (RTMP URL を空に)
- メディア層運用が落ち着いてからの拡張

### N5. 配信終了後の自動サマリー

- 配信終了 (status `ended`) → EventBridge → Lambda が起動
- 録画 + 字幕 (SRT) + 統計 (字幕数 / 平均遅延 / アラーム発生有無) をまとめてメール / Slack
- DESIGN.md 8 章「イベント設定」の延長として価値が高い

### N6. shadcn/ui への移行 (admin-web)

現状の admin-web はプレーン CSS。shadcn/ui + Tailwind に置き換えると見栄えと開発体験が
大幅に改善する。`/shadcn` スキルで段階的に。

### N7. stage-web の入室体験改善

- 招待 URL アクセス時の **デバイス事前テスト** (カメラ/マイクの選択 + 音量メーター)
- 接続失敗時のフォールバック (Audio only モード)

---

## L: 法的・運用 (公開前に決めるべき事項)

### L1. 利用規約 / プライバシーポリシー

- YouTube Live に映像を流す = 視聴者の音声/字幕を収集する可能性 (字幕は登壇者のみだが)
- 録画を S3 に保存 = データ保護法の対象になる場合あり
- **公開配信を始める前に最低限の Terms / Privacy ページを用意**
- Cognito 招待でも consent (利用同意) の UI を入れるかどうか決定

### L2. YouTube 利用規約遵守

- YouTube Live API のレート制限・利用条件を確認
- 配信が削除されるシナリオ (DMCA / Strike) の対応フロー

### L3. コスト監視と上限設定

- AWS Budgets で月額 USD 上限を設定 (O1 と重複)
- 暴走したイベントスタックが残らないよう、`reconcile` に **タイムアウト機能** を追加検討
  (ended 後 24h 残っている stack は強制 destroy)

---

## P: 未マージ PR (Dependabot)

### P1. #8: vite 5.4.21 → 8.0.16

- 状態: CI pass / mergeable / +197 -220 行
- ADR 0004 で Vite 8 (Vite+ 経由) に既に切替済みのため、これは **dependabot の追従**
- 影響: dev のみ (devDep)。マージ推奨

### P2. #7: @types/node 24.13.2 → 25.9.3

- 状態: CI pass / **CONFLICTING** (PR #9 マージで lockfile が動いた) / +61 -61 行
- @types/node の 25 系は Node.js 24 LTS と互換あり
- 影響: dev のみ。rebase してからマージ

### 着手手順

```bash
# P1 (conflict 無し)
gh pr merge 8 --merge --delete-branch

# P2 (rebase 必要)
gh pr update-branch 7    # or 手動 rebase
gh pr merge 7 --merge --delete-branch

# Dependabot のグループ化 (D6) を一緒にやっておくと将来の PR 数が減る
```

---

## 推奨着手順

1. **P1, P2**: Dependabot を片付ける (10 分)
2. **O1 + O2**: AWS 認証・GitHub Environment を整える (1〜2 時間)
3. **S1 + S2** (= 制御層 deploy): `cdk deploy StagecastControlPlane` → admin-web 配信 → 統合テスト疎通
   この段階で **「動く / 動かない」がはっきり見えるので一番学びが大きい**
4. **R1 → R2 → R3** (S3): LiveKit 実体化。難所はここ
5. **R4** (S4): 字幕 Docker 化。R3 が終わってから
6. **R5 + R6 + R7** (S5): 本番運用化
7. **N (Nice-to-have)** は配信が安定してから順次

D / L / N は R を進めながら **思い出した時に PR を切る** のが現実的。
