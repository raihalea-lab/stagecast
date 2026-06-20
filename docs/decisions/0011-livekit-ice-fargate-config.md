# ADR 0011: Fargate + NLB 上の LiveKit Server で WebRTC ICE を確立するための設定

- ステータス: Accepted (実機 ICE pair success 検証待ち)
- 日付: 2026-06-20
- 関連: `DESIGN.md` 3.2 / 7.2、
  [ADR 0006](./0006-livekit-deployment.md) (LiveKit デプロイの基本構成、本 ADR は D-3 config 注入の具体化),
  [ADR 0009](./0009-livekit-tls-signaling-via-nlb.md) (NLB + ACM での TLS 終端、本 ADR と共存),
  [ADR 0010](./0010-livekit-egress-sidecar.md) (Egress sidecar + Valkey 非Serverless),
  [`docs/NEXT_WORK.md`](../NEXT_WORK.md) R12-followup-4〜9,
  memory `r12-livekit-fargate-gotchas.md`

## コンテキスト

R12 (YouTube Live RTMP 送出) の実機検証で、ADR 0010 までの対策を入れた後でも以下が継続:

- WSS シグナリング (`wss://event-XXX.{mediaDomainName}:443`) は接続 OK
- SFU は `--node-ip <Public IP>` で起動
- **しかし stage-web ↔ SFU の WebRTC ICE pair が `failed` (UDP responsesReceived: 0) で WebRTC メディア未確立**

ICE 失敗には複数の根本原因が絡んでいた:

| # | 症状                                                            | 原因                                                                                          |
| - | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1 | SFU が single-node routing で起動 (redis 認識せず)              | env 名を `LIVEKIT_CONFIG_BODY` と渡していたが、正しくは `LIVEKIT_CONFIG`                      |
| 2 | SFU 起動直後に panic                                            | `use_external_ip: true` で EC2 metadata 取得失敗 → `rand.Intn(0)` で panic                    |
| 3 | ICE candidate に外部 IP が広告されない                          | Fargate Task の Public IP は ENI metadata からしか取れない → `--node-ip` 注入が必要           |
| 4 | `rtc.portUDP: {Start: 7882, End: 0}` で中途半端な UDP 構成      | `udp_port` (mux mode) と `port_range_start/end` を同じポートで併記していた                    |
| 5 | 起動時の external_ip 検証が長くタイムアウト                     | NLB は hairpin NAT 不可で self-ping 失敗 → 検証がブロックする                                 |
| 6 | ICE host candidate に到達不能 IP (`169.254.x.x` / VPC Private) が混入 | Fargate awsvpc は eth0=Task Metadata 用 veth + eth1=Task ENI の 2 NIC、Pion は全 IP を広告する |

### 試行と結果

| 試行 (PR)                                        | 対象 | 結果                                                            |
| ------------------------------------------------ | ---- | --------------------------------------------------------------- |
| R12-followup-4 (#90): `LIVEKIT_CONFIG` env 名修正 | #1   | SFU が redis を認識するようになった ✅                          |
| R12-followup-5 (#91): `use_external_ip` 削除      | #2   | panic 解消、SFU が起動するようになった ✅                       |
| R12-followup-6 (#92): `--node-ip` 動的注入        | #3   | WSS 接続 OK だが ICE pair なお `failed` ⚠️                      |
| R12-followup-7 (#95): UDP mux mode 単独化         | #4   | yaml 整合性確保。実機未検証                                     |
| R12-followup-8 (#96): skip_external_ip_validation + 169.254/16 | #5/#6 | 起動高速化と link-local 除外。実機未検証                  |
| R12-followup-9 (#97): VPC CIDR を ICE excludes に動的注入 | #6 (続) | VPC Private IP も除外。実機未検証                          |

### 選択肢の検討

| 案                                                          | 評価                                                                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. yaml/CDK 設定のみで対策 (採用)**                       | コストゼロ。LiveKit Issue #3508/#4049 など一次情報で根拠あり。実機確認前に **6 件の設定組合せ** で潰せた                                        |
| B. LiveKit 内蔵 TURN 有効化 (`turn.enabled: true`)          | relay_range のポートを NLB or SG で 100 個程度開放する追加インフラが必要。A で駄目なら次手                                                       |
| C. coturn sidecar (ADR 0010 と同型)                         | sidecar イメージ追加、認証設定、relay_range 制限などコスト最大。B で駄目なら最後の手                                                            |
| D. LiveKit Server v1.10.x にダウングレード                  | v1.13.x の挙動差を切り分ける検証用。本番採用はしない                                                                                            |

**採用は A** (R12-followup-7〜9 で実装済み)。理由:

- 一次情報 (LiveKit ソース・Issue・公式 config-sample) で原因と対策がほぼ説明できている
- インフラ追加なしで全部入る = 失敗してもロールバックが楽
- 失敗時は B / C / D を順に試せる

## 決定

### D-1. config-body 注入の env 名は `LIVEKIT_CONFIG` (R12-followup-4)

- `livekit-server` の `cmd/server/main.go` は `cli.EnvVars("LIVEKIT_CONFIG")` を読む
- `LIVEKIT_CONFIG_BODY` は LiveKit には存在しない (Egress は `EGRESS_CONFIG_BODY` で別系統。混同注意)

### D-2. `use_external_ip` は config から削除する (R12-followup-5)

- LiveKit v1.13.x の `mediatransportutil.getNAT1to1IPsForConf` が EC2 instance metadata を取得 → Fargate には IMDS が無いため空配列 → `rand.Intn(0)` で panic
- `use_external_ip: false` を明示するのも可だが、デフォルト挙動と区別がないため **キーごと書かない** ことを正とする

### D-3. SFU 起動時に Public IP を解決して `--node-ip` で注入する (R12-followup-6)

- entryPoint を `sh -c` で wrap:
  ```sh
  NODE_IP=$(wget -qO- --timeout=5 https://ifconfig.io || wget -qO- --timeout=5 https://api.ipify.org)
  exec /livekit-server --node-ip "$NODE_IP"
  ```
- `livekit/livekit-server` は alpine ベースで wget 同梱
- ECS Task Metadata Endpoint v4 は **Private IP しか返さない**ため、外部 echo service が必要
- フォールバックで `api.ipify.org` を併記し ifconfig.io 障害に備える

### D-4. UDP は mux mode 単独 (`udp_port` のみ。`port_range_*` を書かない) (R12-followup-7)

- LiveKit は両指定すると `rtc.portUDP: {Start: 7882, End: 0}` の中途半端な状態になり ICE 失敗
- NLB で単一 UDP ポート (7882) しか公開しないので mux mode が自然な選択

### D-5. `rtc.skip_external_ip_validation: true` を入れる (R12-followup-8)

- NLB は hairpin NAT 不可 → 起動時の external_ip 自己検証が必ずタイムアウト
- v1.13 公式 config-sample に「NAT 環境で必要」と明記された設定

### D-6. `rtc.ips.excludes` で link-local と VPC CIDR を除外する (R12-followup-8/9)

- Fargate awsvpc コンテナは eth0 (Task Metadata 用 veth, 169.254.x.x) + eth1 (Task ENI, VPC Private IP) の 2 NIC
- Pion はデフォルトで全 NIC の全 IP を host candidate として列挙する (LiveKit Issue #3508)
- 除外すべき CIDR:
  - `169.254.0.0/16` (固定。ECS Task Metadata Endpoint v4 `169.254.170.2/32` を含む)
  - `vpc.vpcCidrBlock` (CDK Token として動的注入。SharedVpc / per-event VPC のどちらでも対応)

## 影響・トレードオフ

| 観点             | 影響                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| Cost             | yaml/CDK 設定のみなので増加なし                                                                  |
| 信頼性           | 起動時の self-ping タイムアウト解消で SFU 起動時間が短縮                                         |
| ICE 確立確率     | host candidate から不達 IP を除外することでブラウザ側の ICE 候補テスト時間が短縮                 |
| 観測性           | SFU 起動ログに `nodeIP=<Public IP>` が出るのは引き続き有効。`skip_external_ip_validation` 反映の確認も必要 |
| 将来拡張         | LiveKit ノードを冗長化する場合は SharedVpc の Private IP 経由で psrpc しているので excludes に VPC CIDR を入れると影響しないか要確認 (現状は psrpc は host candidate と無関係なので問題なし) |
| LiveKit サポート | 全部公式 config キー。公式 issue / config-sample で根拠あり                                       |

## 受け入れ基準

1. ControlPlane 再デプロイ後、新規イベントで `status=live` 遷移
2. SFU 起動ログに以下がすべて反映されている:
   - `Resolved NODE_IP=<Public IP>`
   - `skip_external_ip_validation: true`
   - `ips.excludes: [169.254.0.0/16, <VPC CIDR>]`
3. stage-web から `/join` → ICE pair `state: succeeded`
4. Chrome `chrome://webrtc-internals` で host candidate に `169.254.x.x` も `10.x.x.x` も流れていない
5. WebRTC メディア (映像/音声) が SFU 経由で配信できる

## フォールバック (本 ADR で対策しきれなかった場合)

順番に試す:

1. **案 B**: LiveKit 内蔵 TURN を有効化 (`turn.enabled: true`)、relay_range を 50300-50400 程度に絞り NLB or SG で開放
2. **案 C**: coturn sidecar を SFU と同 Task に配置 (ADR 0010 と同型)。relay_range は同じく狭く絞る
3. **案 D**: LiveKit Server v1.10.x にダウングレードして v1.13 系の挙動差を切り分け

## 関連 ADR

- ADR 0006: LiveKit デプロイの基本構成 (D-3 config 注入の具体化が本 ADR)
- ADR 0009: TLS 終端 NLB (本 ADR と共存。skip_external_ip_validation を入れることで self-ping タイムアウトが消える点で間接的に関係)
- ADR 0010: Egress sidecar + Valkey 非Serverless (本 ADR と独立)

## 参考リンク

- [LiveKit Issue #3508: Dual NIC external IP not used](https://github.com/livekit/livekit/issues/3508)
- [LiveKit Issue #4049: use_external_ip:true が --node-ip を無視](https://github.com/livekit/livekit/issues/4049)
- [LiveKit Issue #4095: use_external_ip:false でも TURN 経由で NAT GW IP が漏れる](https://github.com/livekit/livekit/issues/4095)
- [LiveKit Issue #4397: v1.10.0 NodeIP IPv6 空文字で ICE URL 破損](https://github.com/livekit/livekit/issues/4397)
- [livekit/livekit config-sample.yaml (master)](https://github.com/livekit/livekit/blob/master/config-sample.yaml)
- [AWS docs: Fargate task networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html)
- [AWS docs: Task metadata endpoint v4 (Fargate)](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-metadata-endpoint-v4-fargate-response.html)
