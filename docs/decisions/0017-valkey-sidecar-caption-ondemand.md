# ADR 0017: Valkey を SFU sidecar に統合 + CaptionWorker オンデマンド起動

- **ステータス**: Accepted
- **日付**: 2026-06-27
- **関連**: ADR 0010 (Egress sidecar), ADR 0015 (Valkey on Fargate), ADR 0016 (desiredCount)

## コンテキスト

イベントごとに 3 つの ECS Fargate タスク (SFU+Egress / CaptionWorker / Valkey) が起動していた。

課題:

- 字幕不要なイベントでも CaptionWorker が起動している (無駄なコスト)
- CloudFormation リソース数が多く、スタック作成・削除が遅い
- CloudMap DNS によるサービスディスカバリのオーバーヘッド

CaptionWorker を SFU に統合する案 (旧選択肢 B) も検討したが、
GPU ASR / LLM 経路への拡張性、独立デプロイ可能性を保つため却下した。

## 決定

### D-1. Valkey を SFU Task の sidecar に統合

- ADR 0015 の独立 Fargate Service を廃止
- SFU TaskDef に `essential: true` の Valkey コンテナを追加
- SFU/Egress → Valkey は `localhost:6379` で通信
- CloudMap PrivateDnsNamespace を完全廃止
- SFU タスクのメモリを 4 GiB → 5 GiB に微増 (Valkey の 512 MiB を吸収)

### D-2. CaptionWorker を独立 desiredCount でオンデマンド起動

- `EventMediaStackProps` に `captionDesiredCount` を追加
- 字幕不要なイベントでは `captionDesiredCount=0` でタスクを起動しない
- 字幕が必要になったら ECS `UpdateService(desiredCount=1)` で 30-60 秒で起動
- `DesiredEvent` に `captionEnabled` フラグを追加し、reconcile が `captionDesiredCount` を制御

### D-3. CaptionWorker の Valkey 依存を解消

- `CAPTION_BUS=valkey` (ValkeyStreamsCaptionBus) を廃止し InProcessCaptionBus を使用
- CaptionWorker は公開 LiveKit URL 経由で SFU に接続 (VPC 内部通信不要)
- CaptionWorker に注入される `VALKEY_ENDPOINT=localhost` は参照されない (無害)

## 影響・トレードオフ

| 項目                 | 変更前          | 変更後                               |
| -------------------- | --------------- | ------------------------------------ |
| タスク数             | 3 (常時)        | 1-2 (字幕有無で変動)                 |
| 字幕なし時コスト     | $0.128/h        | $0.083/h (-35%)                      |
| 字幕あり時コスト     | $0.128/h        | $0.123/h (-4%)                       |
| CloudMap             | 必要            | 不要                                 |
| Valkey 障害分離      | 独立タスク      | SFU と共有 (essential:true で再起動) |
| CaptionWorker 拡張性 | ○               | ○ (独立タスクのまま)                 |
| 字幕開始ラグ         | なし (常時起動) | 30-60 秒 (Fargate 起動時間)          |
