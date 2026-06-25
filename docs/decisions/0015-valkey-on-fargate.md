# ADR 0015: ElastiCache を廃止し Valkey を Fargate コンテナで稼働させる

- ステータス: Accepted
- 日付: 2026-06-25
- 関連: `DESIGN.md` 7.2 (常時稼働リソース最小化)、
  [ADR 0010](./0010-livekit-egress-sidecar.md) (D-6 cluster-mode-disabled 単一ノード)、
  [ADR 0008](./0008-livekit-multi-event-support.md) (per-event 隔離)

## コンテキスト

イベント開始時の CloudFormation スタック作成で、ElastiCache for Valkey (`CfnReplicationGroup`,
`cache.t4g.micro`, cluster-mode-disabled 単一ノード) の起動に **5-10 分** かかり、
イベント全体の起動時間 (約 6-10 分) の支配的ボトルネックになっている。

Valkey の用途は 3 つ:

1. **LiveKit psrpc** (SFU ↔ Egress の RPC): SUBSCRIBE/PUBLISH (標準 Redis Pub/Sub)
2. **字幕バス** (Caption Pipeline): Valkey Streams (XADD/XREAD)
3. **共有状態ストア**: GET/SET/DEL (発表者切替、ルーム状態)

すべて標準 Redis プロトコルで、ElastiCache 固有の機能 (自動バックアップ、フェイルオーバー、
マネージド TLS) は使用していない。データは ephemeral (イベント終了で破棄) であり、
永続性や高可用性は不要。

## 決定

ElastiCache `CfnReplicationGroup` を廃止し、Valkey を **Fargate コンテナ** として
EventMediaStack 内に起動する。

### D-1: Valkey コンテナ仕様

- イメージ: `valkey/valkey:8-alpine` (ARM64 対応、~30MB)
- リソース: 0.25 vCPU / 512 MiB (cache.t4g.micro 相当、ephemeral 用途に十分)
- コマンド: `valkey-server --save "" --appendonly no --protected-mode no --maxmemory 256mb --maxmemory-policy allkeys-lru`
- 永続性なし (`--save "" --appendonly no`): イベント終了で Task ごと破棄される

### D-2: サービスディスカバリ (CloudMap)

- EventMediaStack 内に `PrivateDnsNamespace` を per-event で作成
- Valkey サービスを CloudMap に登録し、DNS 名 `valkey.stagecast-{eventId}.local` で発見可能にする
- SFU/Egress/CaptionWorker は DNS 名でアクセス (CloudMap A レコード → Task private IP)

### D-3: TLS 撤去

- ElastiCache の `transitEncryptionEnabled: true` は不要 (VPC 内部通信のみ)
- LiveKit config: `use_tls: true` → `use_tls: false`
- Caption Pipeline: `VALKEY_ENDPOINT` にホスト名のみ渡し → 既存コードが `redis://` に自動変換

## 影響・トレードオフ

| 項目     | ElastiCache (Before)       | Fargate Valkey (After)      |
| -------- | -------------------------- | --------------------------- |
| 起動時間 | 5-10 分                    | 1-2 分 (Fargate タスク起動) |
| コスト   | ~$0.020/h                  | ~$0.012/h (0.25vCPU)        |
| TLS      | あり (transit encryption)  | なし (VPC 内部、ephemeral)  |
| 永続性   | RDB snapshot 可 (無効化済) | なし                        |
| 可用性   | マネージド (不要)          | Task 再起動のみ (十分)      |
| 運用     | AWS マネージド             | コンテナ管理 (最小限)       |

リスク: Valkey コンテナの起動順序。SFU/Egress/CaptionWorker より後に起動する可能性がある。
→ LiveKit の go-redis / ioredis は自動再接続機能を持つため問題なし。

## Phase 3: 共有 ECS Cluster + IAM Roles の事前作成

### D-4: 共有 ECS Cluster

ControlPlaneStack に ECS Cluster `stagecast-media` を事前作成する。
ECS Cluster はタスクが無ければ完全無料のため、N-1 (常時稼働コスト最小化) に違反しない。
per-event EventMediaStack は `fromClusterAttributes()` で共有 Cluster を参照し、
Cluster 作成の ~10s を省く。

共有 Cluster 利用時はサービス名衝突を回避するため `sfu-{eventId}` 形式を使用する
(per-event Cluster 時は従来通り `sfu` 固定)。

### D-5: 共有 IAM Roles

SFU TaskRole (S3 PutObject for recordings) と CaptionWorker TaskRole
(Transcribe/Translate/Bedrock) を ControlPlaneStack に事前作成する。
IAM Role は無料。per-event EventMediaStack は `fromRoleArn()` で参照する。

## Phase 4: スケジュール事前プロビジョニング (ウォームアップ)

### D-6: `warmup` ステータス

`EventStatus` に `"warmup"` を追加する。遷移ルール:

- `scheduled → warmup` (EventBridge Scheduler がタイマーで自動遷移)
- `warmup → live` (管理者が Go Live ボタン → インフラは既に稼働済み)
- `warmup → draft` (キャンセル)

DynamoDB の `gsi-live` GSI: `warmup` も `liveStatus = "live"` をセットし、
reconcile が通常通りインフラを起動する。

### D-7: EventBridge Scheduler による自動ウォームアップ

イベントが `setStatus("scheduled")` に遷移した時、`startsAt` の 5 分前に
one-time EventBridge Scheduler schedule を作成する。

- スケジュール名: `stagecast-warmup-{eventId}`
- ターゲット: reconcile Lambda (`{ warmupEventIds: [eventId] }` ペイロード)
- `ActionAfterCompletion: "DELETE"` で発火後に自動削除
- `startsAt` が現在時刻から 5 分以内の場合はスケジュール作成をスキップ

reconcile Lambda はウォームアップペイロードを受け取ると、DynamoDB の
イベントを `scheduled → warmup` に遷移させ、通常の reconcile フローを実行する。

### 影響

管理者が「Go Live」を押した時点でインフラが既に稼働済みのため、
体感起動時間がほぼゼロになる（予定イベントの場合）。

EventBridge Scheduler の追加コスト: $0 (無料枠: 月 1400 万回の呼び出し)。
