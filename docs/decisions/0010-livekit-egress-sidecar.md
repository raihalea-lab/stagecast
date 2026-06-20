# ADR 0010: LiveKit Egress を SFU と同一 ECS Task に sidecar 同居させる

- ステータス: Accepted
- 日付: 2026-06-20
- 関連: `DESIGN.md` 3.2 / 7.2、
  [ADR 0006](./0006-livekit-deployment.md) (D-3 config 注入は維持・D-2 Egress 独立 Service は本 ADR で撤回)、
  [ADR 0008](./0008-livekit-multi-event-support.md)、
  [ADR 0009](./0009-livekit-tls-signaling-via-nlb.md)、
  [`docs/NEXT_WORK.md`](../NEXT_WORK.md) R12-followup

## コンテキスト

R12 (YouTube Live RTMP 送出) の実機検証で、LiveKit Egress が SFU からジョブを受け取れない
事象が継続している。SFU ログには `topic: [""]` (Egress 発見テーブル空) と `no response from
servers` が出続け、Egress ログは `service ready` のあと無音 (登録ログが出ない)。

### これまでの試行と結果

| 対応                                                                        | 結果                                           |
| --------------------------------------------------------------------------- | ---------------------------------------------- |
| `LIVEKIT_WS_URL` を Egress に注入 (wss://event-XXX.media...)                | 効果なし                                       |
| SFU / Egress イメージタグを `v1.10.0/v1.13.0` / `latest` に変更             | 効果なし                                       |
| Valkey config を `address` → `cluster_addresses` に変更 (cluster mode 認識) | 効果なし (psrpc は cluster 側でなお登録できず) |
| Valkey Serverless の dual-endpoint (6379+6380) を SG で許可                 | dial timeout は解消、ただし topic 空は継続     |

すべて行っても、Egress が SFU の psrpc registry に登録されない。

### 根本原因の仮説

LiveKit Server / Egress は内部 RPC に **psrpc** (`github.com/livekit/psrpc`) を使い、
go-redis の `UniversalClient` でクライアントを構築する。`cluster_addresses` を指定すると
cluster mode を有効化するが、psrpc の Service Registration は **通常の SUBSCRIBE/PUBLISH** で
実装されている。AWS ElastiCache Valkey **Serverless** は内部実装が cluster mode 固定で、
sharded pub/sub の制約がある。psrpc が前提とする「全シャードに同じトピックがブロードキャスト
される」想定が崩れ、Egress が SFU 側のクエリに見えない結果となる仮説が最も濃い。

### 選択肢の検討

| 案                                                                    | 内容                                                                                      | 評価                                                                                                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. SFU と Egress を同一 Task に sidecar 同居 (採用)                   | 1 つの Fargate Task で 2 つの container を起動。SFU と Egress は **localhost** で疎通可能 | psrpc は依然 Valkey 経由だが、SFU が **同一ノードの Egress を発見** できれば、ローカルジョブを優先するパスがある可能性。Valkey 維持。実装シンプル |
| B. ElastiCache Valkey **非Serverless** (cluster mode disabled) に切替 | 単一ノードの Valkey インスタンス。psrpc が標準動作                                        | LiveKit 公式想定に最も近い。Valkey 維持。最小ノード ~$0.034/h × 起動時間。起動時間 +5-10 分                                                       |
| C. ElastiCache Redis Serverless に切替                                | Valkey 指示と矛盾                                                                         | ユーザー指示と矛盾するため不採用                                                                                                                  |
| D. Egress を完全廃止                                                  | YouTube への RTMP 送出機能を失う                                                          | スコープ違反                                                                                                                                      |

**採用は A**。理由:

- ユーザー指示「Valkey で実現する」「費用がかからない事前作成」を満たす
- 1 Task に 2 container を入れるだけで、追加リソースなし
- 失敗時は B にフォールバック可能 (sidecar を取り除き、ElastiCache 非Serverless 化)

ただし **A は LiveKit 公式想定外**であり、ローカル探索パスの有無を保証できない。実機で
動作確認の上、不可なら速やかに B へ移行する条件付き採用とする。

## 決定

### D-1. SFU TaskDef に Egress container を sidecar として追加

- `Sfu` 用 `ecs.FargateTaskDefinition` に Egress container (`livekit/egress:latest`) を sidecar
- Egress container は `essential: false` (Egress クラッシュで SFU が再起動しないよう保護)
- Task の CPU を 1024→2048 vCPU、メモリを 2048→4096 MiB に増強 (SFU + Chromium ヘッドレス)

### D-2. Egress から localhost で SFU に接続

- `LIVEKIT_WS_URL=ws://localhost:7880` (TLS なしの素 WebSocket、同一 Task 内)
- 環境変数で渡し、Egress config の `ws_url` を上書き
- Valkey 接続は SFU と同じエンドポイント (psrpc registry を共有)

### D-3. 独立 Egress Service / TaskDef / TaskRole を削除

- `EgressService` / `EgressTaskDef` は削除
- `EgressTaskRole` は SFU の TaskRole に統合 (S3 書き込み + Bedrock 呼び出し権限を SFU TaskRole が持つ)
- Egress 用 SG は不要 (SFU の SG を共有)
- `LiveKitEgressApi` を呼ぶ control-api 側の URL は変わらず (SFU の WSS エンドポイント経由)

### D-4. ADR 0006 D-2 (Egress を独立 Service とする) を本 ADR で撤回

ADR 0006 D-2 は「Chrome ヘッドレスのリソース消費を分離するため独立 Service」とした。
本 ADR ではリソース消費を Task 全体の cpu/memory 増強で吸収し、独立 Service を廃止する。
将来再分離が必要になったら別 ADR で評価する。

### D-5. SFU TaskRole の権限拡張

- `EgressTaskRole` が持っていた以下を SFU TaskRole に統合:
  - S3 PutObject (録画/字幕アセットの出力先プレフィックスに限定)
  - Bedrock InvokeModel (Caption Engine 用)
  - Secrets Manager GetSecretValue (LiveKit Keys)

### D-6. 動作不可時のフォールバック方針 (B 案)

A 案で psrpc 登録問題が解決しない場合、以下に切り替える:

- Valkey を Serverless から **CfnCacheCluster** (cluster mode disabled, `cache.t4g.micro` 等の最小ノード) に変更
- 起動時間が +5-10 分伸びるが、psrpc の前提 (単一 Redis ノード) を満たす
- 本 ADR は撤回せず、フォールバック手順として併記

## 影響・トレードオフ

| 観点             | 影響                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| Cost             | Task 増強で +~$0.024/h (1024→2048 vCPU)。Egress Service 廃止で +$0/h。net 同水準                 |
| 信頼性           | Egress クラッシュは `essential: false` で SFU に伝播しない。ただし Task 再起動時は SFU も再起動  |
| 観測性           | SFU と Egress が同じ CloudWatch Logs Stream にまざる可能性 (streamPrefix で分離するため問題なし) |
| Security         | SFU TaskRole が S3 write / Bedrock を持つ広めの権限になる。出力先プレフィックスは引き続き限定    |
| 起動時間         | Egress 用 Service 起動が消えて短縮 (-1〜2 分)                                                    |
| LiveKit サポート | 公式は独立 Service 構成想定。本構成で問題が出ても LiveKit 側のサポート外                         |

## 受け入れ基準

1. EventMediaStack デプロイで SFU Task に Egress container が含まれる
2. Egress が `service ready` 後に psrpc registration を完了する (CW Logs で確認)
3. control-api `startEgress` API が 200 を返し、SFU ログに `topic: [<egress-node-id>]` が出る
4. YouTube Live RTMP に映像が出る (E2E 完了)
5. 失敗時は D-6 の B 案へ移行可能

## 関連 ADR

- ADR 0006 D-2 (撤回): Egress 独立 Service → 本 ADR で撤回
- ADR 0008 D-1〜D-3, D-5〜D-7: 維持
- ADR 0009 D-1, D-2: 維持 (TLS は SFU シグナリングのみ。Egress は localhost なので TLS 不要)
