# 次セッション開始ガイド (2026-06-21 R12 完了直後)

> このドキュメントは前セッション (R12-followup-22 + cleanup PR #115 マージ済) の引継ぎ。
> 次の Claude Code セッション開始時に **冒頭のプロンプト (§3) をそのまま貼り付け** て自走させる想定。

---

## 1. 現状サマリ (2026-06-21 時点)

### 完了済み

- **R12 (stage-web → LiveKit SFU 入室成功)** ✅
- ADR 0011 案 E: TURN を **AWS KVS WebRTC** に外出し、 stage-web の `rtcConfig.iceServers` 直接設定で確実な NAT 越え
- LiveKit Server (v1.13.1, ARM64 Fargate) + Egress sidecar + caption-worker は維持
- LiveKit 内蔵 TURN / coturn sidecar は採用せず (R12-followup-10〜18 は撤回済)
- 詳細は [ADR 0011](./decisions/0011-livekit-ice-fargate-config.md), [NEXT_WORK.md](./NEXT_WORK.md) R12-followup-22 行参照

### 動作中の構成

| 項目 | 値 |
|---|---|
| AWS Account | `542328051110` (ap-northeast-1) |
| ControlPlane Stack | `StagecastControlPlane` |
| admin-web | https://dXXXXXXXX.cloudfront.net |
| stage-web | https://dXXXXXXXX.cloudfront.net |
| control-api | https://68p7p25j1a.execute-api.ap-northeast-1.amazonaws.com |
| Cognito UserPool | `ap-northeast-1_BxiekyXuK` |
| KVS Signaling Channel | `stagecast-turn` (月 $0.03) |
| Invite Token Secret | `stagecast/invite-token-secret-7lP2SZ` |
| LiveKit Secret | `stagecast/livekit-9IE5eH` (apiKey/apiSecret/livekitKeys) |
| DynamoDB Table | `StagecastControlPlane-MetadataTable30E05F1F-L3CN4XJPLUE1` |

---

## 2. 次にやるべきタスク (優先度順)

### 2-1. 最優先: YouTube Live RTMP 送出の E2E 検証

R12 はクライアント入室まで完了。 残りは「Egress → YouTube Live への RTMP 送出 → 録画 S3 保存」の動作確認。

- 関連実装: R12 PR #78 (control-api / admin-web / Egress 配線済、 YouTube ストリームキー管理画面投入済)
- 関連 ADR: [0010](./decisions/0010-livekit-egress-sidecar.md) (Egress sidecar 同居)
- 検証手順:
  1. admin-web で YouTube ストリームキーを設定 (`PUT /settings/youtube`)
  2. 新規イベント作成 → live → 招待 URL 発行 → 入室 → publish (映像/音声)
  3. admin-web から「録画/配信開始」ボタン (もしくは control-api `POST /events/{id}/egress`)
  4. YouTube Live Studio で配信受信を確認
  5. 配信終了後、 S3 (`recordings/{eventId}/`) に録画ファイルが置かれるか確認

### 2-2. DESIGN.md に KVS WebRTC TURN 運用を反映

設計の正である `DESIGN.md` に ADR 0011 案 E の決定を反映。

- 3.2 (メディア層) に「NAT 越えは AWS KVS WebRTC TURN を控除」と追記
- 7.2 (コスト) に KVS Signaling Channel 月 $0.03 + TURN $0.12/1000 分 を追加
- 9 章 (アーキテクチャ図) に控除追加 (図がある場合)

### 2-3. Dependabot PR 整理 (P1 / P2)

[NEXT_WORK.md §P](./NEXT_WORK.md) より:
- **PR #8**: vite 5.4.21 → 8.0.16 (CI pass / mergeable)
- **PR #7**: @types/node 24.13.2 → 25.9.3 (CONFLICTING / 要 rebase)

```bash
gh pr merge 8 --merge --delete-branch
gh pr update-branch 7 && gh pr merge 7 --merge --delete-branch
```

### 2-4. memory `r12-livekit-fargate-gotchas.md` の見直し (任意)

R12 完了で「踏破済の 10 罠」になっている。 過去履歴として残してよいが、 もし新規開発者向けに整理し直すなら ADR 0011 に集約済の情報と重複が出始める。 メモリは「経緯」、 ADR は「決定」の役割分担で OK。

### 2-5. その他 (NEXT_WORK.md の D / N / L カテゴリ)

R12 完了で R カテゴリ (メディア層実体化) はほぼクローズ。 残: D / N / L カテゴリは `docs/NEXT_WORK.md` を参照して着手。

---

## 3. 次セッション開始時の自走プロンプト

**コピペで Claude Code に貼り付けてください**:

````
stagecast プロジェクトの開発を続けます。 前回 R12 (LiveKit + AWS KVS WebRTC TURN で stage-web 入室成功) が完了したところです。

## 引継ぎ

以下を読んでから作業開始:
- @docs/NEXT_SESSION.md (このプロンプトの出所)
- @docs/NEXT_WORK.md (タスク全体)
- @docs/decisions/0011-livekit-ice-fargate-config.md (LiveKit + Fargate の決定)
- /memory r12-livekit-fargate-gotchas.md (踏破済の 10 罠)

## やってほしいこと

[ここに具体的なタスクを書く。例:]

(例 A) docs/NEXT_SESSION.md §2-1 (YouTube Live RTMP 送出の E2E 検証) を進めて。 admin-web からの操作が必要なら都度依頼して。

(例 B) docs/NEXT_SESSION.md §2-2 (DESIGN.md に KVS WebRTC TURN 運用を反映) を進めて。 ADR 0011 案 E を引用しながら 3.2 / 7.2 / 9 章を更新する。

(例 C) docs/NEXT_SESSION.md §2-3 (Dependabot P1/P2) を片付けて。 conflict は rebase で解消。

## 注意事項

- 新規ブランチは main から派生 (`git switch -c claude/<feature-slug>`)
- コミット/PR タイトルは日本語 1 行 + Conventional Commits prefix (`feat:` / `fix:` / `chore:` / `docs:` etc.)
- deploy 必要時は `cdk deploy StagecastControlPlane -c mediaHostedZoneName=aws.example.com -c budgetMonthlyUsd=30 -c budgetEmail=ops@example.com -c initialAdmins=ops@example.com --require-approval never` を使う (context 省略すると既存リソースが削除される diff になる、注意)
- AWS session 期限切れたら `aws login` を依頼
- 私 (ユーザー) のブラウザ操作が必要な場合は明示的に依頼。 control-api を直接叩く必要があれば下記の Quick reference を使う
- `--no-verify` で pre-push hook を skip しない (CLAUDE.md 規約)
- auto-merge は CLAUDE.md 規約どおり `gh pr merge --auto --merge --delete-branch` を使う

## Quick reference

### 招待 URL 生成 (curl で control-api を叩く想定)

```bash
node -e '
const crypto = require("node:crypto");
const SECRET = "<<aws secretsmanager get-secret-value --secret-id stagecast/invite-token-secret --query SecretString --output text | jq -r .secret>>";
const EVENT_ID = "<event-id>";
const jti = crypto.randomUUID();
const iat = Math.floor(Date.now() / 1000);
const exp = iat + 3600;
const payload = { jti, eventId: EVENT_ID, role: "speaker", iat, exp, version: 1 };
const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
const sig = crypto.createHmac("sha256", SECRET).update(payloadB64).digest("base64url");
console.log("URL=https://dXXXXXXXX.cloudfront.net/join?token=" + encodeURIComponent(`${payloadB64}.${sig}`));
console.log("JTI=" + jti);
'

# DynamoDB に invite item を put することも忘れない:
# aws dynamodb put-item --table-name StagecastControlPlane-MetadataTable30E05F1F-L3CN4XJPLUE1 \
#   --item '{"pk":{"S":"INVITE#<jti>"},"sk":{"S":"META"},"type":{"S":"invite"},"gsi1pk":{"S":"INVITE#<event-id>"},"gsi1sk":{"S":"<jti>"},"jti":{"S":"<jti>"},"eventId":{"S":"<event-id>"},"role":{"S":"speaker"},"currentVersion":{"N":"1"},"revoked":{"BOOL":false}}'
```

### 新規イベント作成 (DynamoDB 直接)

```bash
NEW_ID=$(node -e "console.log(crypto.randomUUID())")
NOW_MS=$(node -e "console.log(Date.now())")
NOW_ISO=$(node -e "console.log(new Date().toISOString().slice(0,16))")
aws dynamodb put-item --table-name StagecastControlPlane-MetadataTable30E05F1F-L3CN4XJPLUE1 --item "{
  \"pk\": {\"S\": \"EVENT#$NEW_ID\"}, \"sk\": {\"S\": \"META\"},
  \"id\": {\"S\": \"$NEW_ID\"}, \"eventId\": {\"S\": \"$NEW_ID\"}, \"type\": {\"S\": \"EVENT\"},
  \"title\": {\"S\": \"検証\"}, \"status\": {\"S\": \"live\"}, \"liveStatus\": {\"S\": \"live\"},
  \"startsAt\": {\"S\": \"${NOW_ISO}\"},
  \"caption\": {\"M\": {\"engine\": {\"S\": \"transcribe\"}, \"customApiEnabled\": {\"BOOL\": false}, \"languages\": {\"L\": [{\"S\": \"ja\"}, {\"S\": \"en\"}]}, \"youtubeLanguage\": {\"S\": \"ja\"}}},
  \"gsi1pk\": {\"S\": \"EVENT\"}, \"gsi1sk\": {\"S\": \"${NOW_ISO}#$NEW_ID\"},
  \"createdAtMs\": {\"N\": \"$NOW_MS\"}, \"updatedAtMs\": {\"N\": \"$NOW_MS\"}
}"
```

### 既存 live イベントを ended に

```bash
NOW_MS=$(node -e "console.log(Date.now())")
aws dynamodb update-item --table-name StagecastControlPlane-MetadataTable30E05F1F-L3CN4XJPLUE1 \
  --key '{"pk":{"S":"EVENT#<event-id>"},"sk":{"S":"META"}}' \
  --update-expression "SET #s = :ended, updatedAtMs = :now REMOVE liveStatus" \
  --condition-expression "#s = :live" \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values "{\":ended\":{\"S\":\"ended\"},\":live\":{\"S\":\"live\"},\":now\":{\"N\":\"$NOW_MS\"}}"
```

### SFU debug log を有効化したいとき

`infra/lib/event-media-stack.ts` の `liveKitServerConfig()` 末尾 `logging.level: info` を `debug` に変更 → PR + deploy。 確認終わったら必ず `info` に戻す。

### EventMediaStack ログ取得

```bash
EVENT_ID=<event-id>
LG=$(aws logs describe-log-groups --query "logGroups[?contains(logGroupName, '$EVENT_ID') && contains(logGroupName, 'Logs')].logGroupName" --output text | head -1)
SFU_TASK=$(aws ecs list-tasks --cluster stagecast-event-$EVENT_ID --service-name sfu --query "taskArns[0]" --output text | awk -F'/' '{print $NF}')
aws logs get-log-events --log-group-name "$LG" --log-stream-name "Sfu/SfuContainer/$SFU_TASK" --start-from-head --limit 50 --query "events[].message" --output text
```

````

---

## 4. R12 で踏んだ「踏んではいけない罠」(memory に集約)

詳細は `/memory r12-livekit-fargate-gotchas.md` 参照。 サマリ:

1. `LIVEKIT_CONFIG_BODY` ではなく `LIVEKIT_CONFIG` env で yaml 注入
2. `use_external_ip: true` は Fargate で panic (削除する)
3. `--node-ip` を wget で動的注入
4. `udp_port` と `port_range_*` は同時指定しない (mux mode 単独)
5. eth0 (169.254/16) link-local は ICE 候補から除外 (`ips.excludes`)
6. NLB hairpin NAT 不可なので `skip_external_ip_validation: true`
7. EC2 SG description は ASCII 限定 (日本語 NG)
8. シンメトリック NAT 越えは TURN 必須
9. **`ips.excludes` に VPC CIDR を入れると host candidate 0 個になり trickle ICE 不能** (R12-followup-22 で訂正)
10. **TURN は AWS KVS WebRTC を外出し → stage-web の `rtcConfig.iceServers` 直接設定** (公式 sanctioned)

---

## 5. 補足: R12-followup の試行錯誤履歴

時間軸の参考まで。 詳細はクローズ済 PR の説明文に。

| Followup | PR | 何を試みた | 結果 |
|---|---|---|---|
| 1〜3 | #85 #88 | Egress sidecar + Valkey 切替 | ADR 0010 で確定 |
| 4 | #90 | `LIVEKIT_CONFIG` env 名修正 | SFU が redis 認識 ✅ |
| 5 | #91 | `use_external_ip` 削除 | panic 解消 ✅ |
| 6 | #92 | `--node-ip` 注入 | Public IP 配信 ✅ |
| 7 | #95 | `udp_port` mux mode 単独化 | 必要 |
| 8 | #96 | `skip_external_ip_validation` + `169.254/16` excludes | 必要 |
| 9 | #97 | VPC CIDR を excludes に追加 | **NG**: R12-followup-22 で訂正 |
| 10〜13 | #100〜#104 | LiveKit 内蔵 TURN (静的→HMAC) | NG: wire に credential 乗らず |
| 14〜18 | #105〜#109 | coturn sidecar 同居 + sed 注入 | NG: 同上 |
| **19** | **#110/#111** | **AWS KVS WebRTC TURN 採用** | ✅ |
| 20 | #111 | Lambda bundle に KVS SDK 含める | 必要 |
| 21〜22 | #112〜#114 | debug log + VPC CIDR 除去 | **R12 完了** ✅ |
| cleanup | #115 | debug log → info / ドキュメント最終化 | 完了 |
