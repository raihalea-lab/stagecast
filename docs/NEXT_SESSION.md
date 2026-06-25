# 次セッション開始ガイド (2026-06-24 ADR 0012 完全達成直後)

> このドキュメントは前セッション (R12 残 + R15/R16/R17 完全達成、 計 18 PR マージ) の引継ぎ。
> **ユーザー要件 1-3 (プレビュー / レイアウト操作 / 待機画面) は全達成**。
> 次の Claude Code セッション開始時に **冒頭のプロンプト (§3) をそのまま貼り付け** て自走させる想定。

---

## 1. 現状サマリ (2026-06-22 時点)

### 完了済み

- **R12 (YouTube Live RTMP 送出 E2E)** ✅ (PR #119/#120)
  - Egress LNA / mixed content 問題を `insecure: true` で解決 (ADR 0010 D-7)
- **ADR 0012 起票** ✅ (PR #121): カスタム Egress テンプレートの全体方針
- **R15 (composer-template + 待機画面)** ✅ (PR #122-#126)
  - React + Vite で composer-template 新規実装、 S3+CloudFront ホスティング
  - 待機画面 (publishing 0 人時の fallback) で要件 3 達成
  - 4 件の followup (START_RECORDING シグナル / mute-unmute 再 attach / カメラ+画面共有並列)
- **R16 (admin-web layout 切替 UI + 4 layouts)** ✅ (PR #127-#129)
  - grid / spotlight / pip / screen-share-main の 4 layouts
  - admin-web から LiveKit data channel で broadcast → sub-second 反映
  - 要件 2 達成
- **R17 admin-web プレビュー** ✅ (PR #130/#131)
  - `/events/{id}/preview-token` (viewer role) 追加
  - LivePreview iframe で composer-template を埋め込み
  - 要件 1 の admin-web 部分達成
- **R17-Phase3 stage-web プレビュー** ✅ (PR #134/#135, 2026-06-24)
  - `POST /preview-token` (招待トークン認証) 追加
  - stage-web の登壇者ビュー右下に小窓 (240px × 16:9) で composer-template iframe 埋め込み
  - API Gateway 公開ルート (NONE 認証) リストに明示登録が必要だった (followup-1)
  - **ADR 0012 D-1〜D-6 全達成 + 要件 1-3 完全達成** 🎉

### 動作中の構成

| 項目                  | 値                                                          |
| --------------------- | ----------------------------------------------------------- |
| AWS Account           | `542328051110` (ap-northeast-1)                             |
| ControlPlane Stack    | `StagecastControlPlane`                                     |
| admin-web             | https://dXXXXXXXX.cloudfront.net                       |
| stage-web             | https://dXXXXXXXX.cloudfront.net                       |
| composer-web          | https://dcxk8k5d51220.cloudfront.net                        |
| control-api           | https://68p7p25j1a.execute-api.ap-northeast-1.amazonaws.com |
| Cognito UserPool      | `ap-northeast-1_BxiekyXuK`                                  |
| KVS Signaling Channel | `stagecast-turn` (月 $0.03)                                 |
| Invite Token Secret   | `stagecast/invite-token-secret-7lP2SZ`                      |
| LiveKit Secret        | `stagecast/livekit-9IE5eH`                                  |
| YouTube Secret        | `stagecast/youtube-CSMIPL`                                  |
| DynamoDB Table        | `StagecastControlPlane-MetadataTable30E05F1F-L3CN4XJPLUE1`  |

### ユーザー要件の進捗 (ADR 0012) — **全達成 🎉**

| 要件                                                  | 状況                                                  |
| ----------------------------------------------------- | ----------------------------------------------------- |
| 1. 登壇者・管理者・スピーカーが現在の画面を確認できる | ✅ R17 admin-web + stage-web                          |
| 2. 管理者がレイアウトを調整できる                     | ✅ R16                                                |
| 3. 誰も投影してなくても何かしらの配信が続いている     | ✅ R15 (イベント中 fallback)、 365日24h は R18 別 ADR |

---

## 2. 次にやるべきタスク (優先度順)

### 2-1. 最優先: R14 (Egress fileOutputs / S3 録画)

P-01 完了条件の最後の 1 ピース。

- `services/control-api/src/lambda.ts:178-187` の `startRoomCompositeEgress` 呼び出しに `file: new sdk.EncodedFileOutput({...})` を追加
- ControlPlane の `AssetsBucket` 配下 `recordings/{eventId}/` プレフィックスに mp4 出力
- SFU TaskRole は既に S3 PutObject 権限を持つ (ADR 0010 D-5)
- 完了基準: 配信終了で `recordings/{eventId}/{egressId}.mp4` が S3 に保存 + admin-web の「成果物」一覧に表示

### 2-2. P-02: DESIGN.md に KVS WebRTC TURN 運用反映

ADR 0011 案 E + ADR 0010 D-7 + ADR 0012 の内容を DESIGN.md に本文化。

- 3.2 章 (メディア層): TURN レイヤー + composer-template 追記
- 7.2 章 (常時稼働): KVS Signaling Channel + ComposerWebDistribution 追記
- 8 章 (運用): KVS WebRTC 関連の監視ポイント追記
- 4.1 章 (制御 API): `/admin-token` / `/preview-token` を追記
- 5.2 章 (stage-web): rtcConfig.iceServers 直接設定の流れ
- ADR 0011 / ADR 0012 への参照リンクを本文化

### 2-3. P-04: R7 統合テスト CI workflow

GH Actions で「event 作成 → stage-web 自動入室 → Egress 起動 → YouTube 受信確認」を自動化。 SLO 観測込み。 大規模 PR (1 日以上)。

### 2-4. R18: 365 日 24h 配信 (将来)

DESIGN.md N-1 (常時稼働リソースなし) と矛盾するため別 ADR で議論。
候補: 常時 ffmpeg loop + S3 mp4 / LiveKit Standby Room / EventBridge Schedule。

### 2-5. Dependabot PR 整理 (P1 / P2)

- **PR #8**: vite 5.4.21 → 8.0.16
- **PR #7**: @types/node 24.13.2 → 25.9.3

---

## 3. 次セッション開始時の自走プロンプト

**コピペで Claude Code に貼り付けてください**:

````
stagecast プロジェクトの開発を続けます。 前セッション (2026-06-21) で R12 残 +
ADR 0012 (R15/R16/R17 admin-web) まで完了したところです。 計 15 PR マージ。

## 引継ぎ

以下を読んでから作業開始:
- @docs/NEXT_SESSION.md (このプロンプトの出所)
- @docs/NEXT_WORK.md (タスク全体)
- @docs/NEXT_SESSION_PROMPTS.md (各タスクのコピペプロンプト集)
- @docs/decisions/0012-custom-egress-template.md (R15/R16/R17 の決定)
- /memory r12-livekit-fargate-gotchas.md (Fargate + LiveKit 罠 11 件)

## やってほしいこと

[ここに具体的なタスクを書く。 例:]

(例 A) docs/NEXT_SESSION_PROMPTS.md の P-13 (R17-Phase3) を進めて。
       stage-web に登壇者ビュー右下小窓プレビューを追加する。

(例 B) docs/NEXT_SESSION_PROMPTS.md の P-14 (R14) を進めて。
       Egress に fileOutputs (S3 録画) を追加する。

(例 C) docs/NEXT_SESSION_PROMPTS.md の P-02 を進めて。
       DESIGN.md に KVS WebRTC TURN + composer-template 運用を反映する。

## 注意事項

- 新規ブランチは main から派生 (`git switch -c claude/<feature-slug>`)
- コミット/PR タイトルは日本語 1 行 + Conventional Commits prefix (`feat:` / `fix:` / `chore:` / `docs:` etc.)
- deploy 必要時は `cdk deploy StagecastControlPlane -c mediaHostedZoneName=aws.example.com -c budgetMonthlyUsd=30 -c budgetEmail=ops@example.com -c initialAdmins=ops@example.com --require-approval never` を使う (context 省略すると既存リソース消える diff、 注意)
- AWS session 期限切れたら `aws login` を依頼
- 私 (ユーザー) のブラウザ操作が必要な場合は明示的に依頼
- composer-template の更新は CloudFront cache invalidation + ECS Task force-new-deployment (`aws ecs update-service --cluster stagecast-event-<id> --service sfu --force-new-deployment`) で Chrome に新 bundle 読ませる
- `--no-verify` で pre-push hook を skip しない (CLAUDE.md 規約)
- auto-merge は CLAUDE.md 規約どおり `gh pr merge --auto --merge --delete-branch` を使う

## Quick reference

### 招待 URL 生成 (stage-web)

```bash
EVENT_ID=<event-id>
SECRET=$(aws secretsmanager get-secret-value --secret-id stagecast/invite-token-secret --query SecretString --output text | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).secret))')
JTI=$(node -e "console.log(require('node:crypto').randomUUID())")
aws dynamodb put-item --table-name StagecastControlPlane-MetadataTable30E05F1F-L3CN4XJPLUE1 \
  --item "{\"pk\":{\"S\":\"INVITE#$JTI\"},\"sk\":{\"S\":\"META\"},\"type\":{\"S\":\"invite\"},\"gsi1pk\":{\"S\":\"INVITE#$EVENT_ID\"},\"gsi1sk\":{\"S\":\"$JTI\"},\"jti\":{\"S\":\"$JTI\"},\"eventId\":{\"S\":\"$EVENT_ID\"},\"role\":{\"S\":\"speaker\"},\"currentVersion\":{\"N\":\"1\"},\"revoked\":{\"BOOL\":false}}" > /dev/null
SECRET="$SECRET" EVENT_ID="$EVENT_ID" JTI="$JTI" node -e '
const crypto = require("node:crypto");
const iat = Math.floor(Date.now() / 1000);
const payload = { jti: process.env.JTI, eventId: process.env.EVENT_ID, role: "speaker", iat, exp: iat + 3600, version: 1 };
const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
const sig = crypto.createHmac("sha256", process.env.SECRET).update(payloadB64).digest("base64url");
console.log("URL=https://dXXXXXXXX.cloudfront.net/join?token=" + encodeURIComponent(payloadB64 + "." + sig));
'
```

### 新規 live event 作成 (youtube 設定込み)

```bash
NEW_ID=$(node -e "console.log(require('node:crypto').randomUUID())")
NOW_MS=$(node -e "console.log(Date.now())")
NOW_ISO=$(node -e "console.log(new Date().toISOString().slice(0,16))")
aws dynamodb put-item --table-name StagecastControlPlane-MetadataTable30E05F1F-L3CN4XJPLUE1 --item "{
  \"pk\": {\"S\": \"EVENT#$NEW_ID\"}, \"sk\": {\"S\": \"META\"},
  \"id\": {\"S\": \"$NEW_ID\"}, \"eventId\": {\"S\": \"$NEW_ID\"}, \"type\": {\"S\": \"EVENT\"},
  \"title\": {\"S\": \"検証\"}, \"status\": {\"S\": \"live\"}, \"liveStatus\": {\"S\": \"live\"},
  \"startsAt\": {\"S\": \"${NOW_ISO}\"},
  \"caption\": {\"M\": {\"engine\": {\"S\": \"transcribe\"}, \"customApiEnabled\": {\"BOOL\": false}, \"languages\": {\"L\": [{\"S\": \"ja\"}, {\"S\": \"en\"}]}, \"youtubeLanguage\": {\"S\": \"ja\"}}},
  \"youtube\": {\"M\": {\"rtmpUrl\": {\"S\": \"rtmp://a.rtmp.youtube.com/live2\"}, \"streamKeyRef\": {\"S\": \"streamKey\"}}},
  \"gsi1pk\": {\"S\": \"EVENT\"}, \"gsi1sk\": {\"S\": \"${NOW_ISO}#$NEW_ID\"},
  \"createdAtMs\": {\"N\": \"$NOW_MS\"}, \"updatedAtMs\": {\"N\": \"$NOW_MS\"}
}"
echo "New event: $NEW_ID"
```

### 既存 live event を ended に (reconcile が destroy)

```bash
EVENT_ID=<event-id>
NOW_MS=$(node -e "console.log(Date.now())")
aws dynamodb update-item --table-name StagecastControlPlane-MetadataTable30E05F1F-L3CN4XJPLUE1 \
  --key "{\"pk\":{\"S\":\"EVENT#$EVENT_ID\"},\"sk\":{\"S\":\"META\"}}" \
  --update-expression "SET #s = :ended, updatedAtMs = :now REMOVE liveStatus, media" \
  --condition-expression "#s = :live" \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values "{\":ended\":{\"S\":\"ended\"},\":live\":{\"S\":\"live\"},\":now\":{\"N\":\"$NOW_MS\"}}"
```

### composer-template 更新後の即時反映

```bash
# 1. ControlPlane deploy (S3 + CloudFront invalidation 自動)
cd infra && pnpm cdk deploy StagecastControlPlane ... --require-approval never

# 2. SFU Task force-new-deployment (Chrome に新 bundle を読ませる)
EVENT_ID=<event-id>
aws ecs update-service --cluster stagecast-event-$EVENT_ID --service sfu --force-new-deployment

# 3. 90s 待って Task replace 完了確認
sleep 90
aws ecs describe-services --cluster stagecast-event-$EVENT_ID --services sfu --query "services[0].deployments[].{Status:status,Running:runningCount,Desired:desiredCount}"
```

### EventMediaStack ログ取得

```bash
EVENT_ID=<event-id>
LG=$(aws logs describe-log-groups --query "logGroups[?contains(logGroupName, '$EVENT_ID') && contains(logGroupName, 'Logs')].logGroupName" --output text | head -1)
# Egress container ログ
EGRESS_STREAM=$(aws logs describe-log-streams --log-group-name "$LG" --order-by LastEventTime --descending --limit 10 --query "logStreams[?starts_with(logStreamName, 'Egress/')].logStreamName" --output text)
aws logs get-log-events --log-group-name "$LG" --log-stream-name "$EGRESS_STREAM" --limit 30 --query "events[].message" --output text | tr '\t' '\n' | tail -30
```

### Chrome MCP で composer-template の動作確認

```
mcp__claude-in-chrome__tabs_context_mcp で tab 取得
→ navigate("https://dcxk8k5d51220.cloudfront.net?layout=grid&token=DUMMY&url=ws%3A%2F%2Flocalhost%3A7880")
→ read_console_messages で START_RECORDING / エラーを確認
```

````

---

## 4. 今セッションで踏んだ「踏んではいけない罠」

### 4-1. LiveKit Egress プロトコル (R15)

LiveKit Egress (`pkg/source/web.go`) は **カスタムテンプレートからの `console.log("START_RECORDING")` を Chrome console event として検出** して GStreamer pipeline を `playing` に遷移させる。 発行しないと `pipeline playing` まで進まず YouTube に何も届かない。

- 公式テンプレート (`template-sdk/src/index.ts` L78) は `startRecording()` ヘルパーで発行
- 我々は要件 3 (待機画面でも配信継続) のため Room.connect 成功時点で **無条件に即発行**
- Disconnected で `console.log("END_RECORDING")` も発行

### 4-2. mute/unmute サイクルの track 再 attach (R15)

`adaptiveStream: true` の SFU は mute 時に track を自動 unsubscribe するため:

- `RoomEvent.TrackSubscribed` / `TrackUnsubscribed` を refresh のトリガーに必須
- Tile の `useEffect` dependency に **track 参照** (`publication.track`) を含める
- Chrome autoplay policy で attach 後 `videoRef.current.play().catch(() => {})` 明示呼出

### 4-3. 1 participant = 1 tile は誤り (R15)

`videoTrackPublications.find((t) => !t.isMuted)` は **先頭 1 つだけ**取得するため、 同 participant がカメラ + 画面共有を同時 publish すると画面共有が無視される。 **1 video publication = 1 tile** で並べる (StreamYard 風)。

### 4-4. flex column の絶対高さは Chrome で壊れる (R16)

`display: flex; flex-direction: column` で子要素に `flex: 0 0 80%` (高さ 80%) を指定すると、 Chrome の一部バージョンで Tile の `height: 100%` と組み合わさったときに main 高さが 0 になる。 **`display: grid; gridTemplateRows: "1fr 200px"` + `minHeight: 0`** で確実に展開。 flex row なら問題ない。

### 4-5. shared に DOM lib (R16)

`TextEncoder` / `TextDecoder` は Web 標準 + Node.js globalThis にあるが、 TypeScript の `lib: ["ES2022"]` には含まれない。 `packages/shared/tsconfig.json` に `"DOM"` lib を追加して型解決。

---

## 5. 補足: 今セッションの全 PR 一覧

| PR   | カテゴリ | 内容                                                                |
| ---- | -------- | ------------------------------------------------------------------- |
| #119 | fix      | Egress LNA / insecure: true (R12-followup-23)                       |
| #120 | chore    | R12 cleanup + 完了マーク                                            |
| #121 | docs     | ADR 0012 起票                                                       |
| #122 | feat     | R15 基盤 (composer-template + S3+CloudFront + Egress template_base) |
| #123 | fix      | R15-followup-1: START_RECORDING シグナル                            |
| #124 | fix      | R15-followup-2: mute/unmute 再 attach                               |
| #125 | fix      | R15-followup-3: 1 video publication = 1 tile                        |
| #126 | docs     | R15 完了マーク                                                      |
| #127 | feat     | R16 (layout 切替 + 4 layouts + admin-token)                         |
| #128 | fix      | R16-followup-1: Spotlight flex → grid                               |
| #129 | docs     | R16 完了マーク                                                      |
| #130 | feat     | R17 admin-web (preview-token + LivePreview)                         |
| #131 | docs     | R17 admin-web 完了マーク                                            |

合計 13 PR (R12 残 2 + ADR 0012 11)。
