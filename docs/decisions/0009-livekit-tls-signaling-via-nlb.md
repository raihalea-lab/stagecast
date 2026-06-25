# ADR 0009: LiveKit シグナリングを NLB + ACM で TLS 終端する

- ステータス: Accepted
- 日付: 2026-06-19
- 関連: `DESIGN.md` F-9 / 7.3、
  [ADR 0006](./0006-livekit-deployment.md)（D-3 config 注入は維持）、
  [ADR 0008](./0008-livekit-multi-event-support.md)（**D-4 NLB 廃止を本 ADR で部分撤回**、D-1〜D-3, D-5〜D-7 は維持）、
  [`docs/NEXT_WORK.md`](../NEXT_WORK.md)（R9 検証中に発覚）

## コンテキスト

[ADR 0008 D-4](./0008-livekit-multi-event-support.md) で「NLB 廃止、Fargate task の Public IP
を直接公開する」方針を採択し、`wss://<TaskPublicIp>:7880` 形式でクライアントに渡していた。
ADR 0008 自身も「TLS 終端は将来課題」と明記しており、本 ADR がその将来課題を扱う。

### R9 検証で発覚した問題

2026-06-19 に R9（stage-web → 実 LiveKit 接続の E2E 確認）を実機検証中、ブラウザの WebSocket
セキュリティ制約により以下が発覚した：

- stage-web は CloudFront 上の **HTTPS ページ** として配信される
- HTTPS ページから WebSocket 接続するには **`wss://`（TLS over WebSocket）が必須**
  - `ws://` は mixed content として **ブラウザがブロック**
- `wss://13.112.201.51:7880` への接続は `ERR_SSL_PROTOCOL_ERROR` で失敗
  - LiveKit Server はプレーン HTTP で 7880 を提供しているため

### LiveKit Server の TLS サポート

LiveKit Server は `config.yaml` で **TLS を直接サポートしない**設計で、公式は Caddy 等の
リバースプロキシでの TLS 終端を推奨している。`dev_mode: true` はデバッグログ向け設定で、
TLS は有効化しない（実機で確認済み）。

### 選択肢の検討

| 案                                | 内容                                          | 評価                                                             |
| --------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| A. NLB + ACM + ドメイン（採用）   | NLB の TLS リスナーで TLS 終端                | LiveKit 公式推奨に近い、業界標準、ACM 自動更新                   |
| B. Caddy sidecar + 自己署名証明書 | SFU タスクに Caddy 同居、自己署名 TLS         | ユーザーが証明書信頼必要、毎イベントごとに新 IP → **実運用不可** |
| C. ALB + ACM                      | ALB の TLS 終端                               | ALB は L7 のみ。**WebRTC メディア UDP を扱えない**（NLB が必要） |
| D. CloudFront 経由                | CloudFront でシグナリング、SFU 直接でメディア | CloudFront 自体は WebSocket OK だが、SFU の Public IP 露出は同じ |
| E. LiveKit Cloud（SaaS）          | self-hosted を辞めて LiveKit Cloud            | ADR 0005 D-2 を全面撤回。スコープ外                              |

**案 A** を採用する。理由:

- ACM + Route53 で証明書管理が自動化（更新もゼロ運用）
- NLB の TLS リスナーは TCP L4 として動作するので LiveKit のシグナリング (TCP 7880) と整合
- ドメイン `example.com` の Route53 HostedZone を既に保有（DNS validation で自動検証可能）

### NLB と WebRTC メディアの関係

ただし、ADR 0008 D-4 で言及された「NLB の起動時間が 3〜5 分追加」「task 単発前提では DNS
安定性メリット薄い」というトレードオフは **依然有効**。**そのため NLB はシグナリング (TCP)
のみに限定し、WebRTC メディア (UDP 7882 / TCP 7881) は SFU の Public IP 直接公開を維持** する。

LiveKit 公式ドキュメント (docs.livekit.io/realtime/self-hosting/deployment/) も
"Media servers are best deployed without a load balancer in front of them" と推奨している。

本 ADR では以下を決める：

- **D-1**: LiveKit シグナリング (TCP 7880) を NLB + ACM TLS リスナーで TLS 終端する（ADR 0008 D-4 を部分撤回）
- **D-2**: WebRTC メディア (UDP 7882 / TCP 7881) は SFU の Public IP 直接公開を維持（ADR 0008 D-4 のうちメディア部分は継承）
- **D-3**: ACM 証明書は ControlPlaneStack で **1 つのワイルドカード証明書** `*.media.example.com` を作って全イベントで共有
- **D-4**: per-event DNS パターンは `event-{eventId.slice(0,8)}.media.example.com`
- **D-5**: 将来 SFU 冗長化が必要になったときは「全部 NLB 案」を別 ADR で再検討する

## 決定

### D-1. LiveKit シグナリングを NLB + ACM TLS リスナーで TLS 終端する

EventMediaStack に internet-facing Network Load Balancer を復活させ、以下を構成する：

- **NLB**: internet-facing, public subnet, cross-zone enabled
- **TLS Listener**: port 443, protocol TLS, ACM ワイルドカード証明書を attach, SSL Policy `TLS13_RES`
- **Target Group**: port 7880, protocol TCP, target type IP, health check TCP 7880
- **Target**: SFU の ECS Service の Fargate task を IP ターゲットとして自動登録

クライアントは `wss://event-XXXXXXXX.media.example.com` で接続し、NLB が TLS を終端
した後、VPC 内部で SFU の plain TCP 7880 に転送する。

`liveKitServerConfig()` から `dev_mode: true` を削除（不要）。`use_external_ip: true` は維持し、
ICE candidate に SFU の Public IP を引き続き広告する（メディア用、D-2 で説明）。

#### 代替案と却下理由

| 代替案                  | 却下理由                                                                       |
| ----------------------- | ------------------------------------------------------------------------------ |
| ALB + ACM               | ALB は L7 (HTTPS only)。WebSocket は OK だが、UDP メディアは別経路必要で複雑化 |
| Caddy sidecar           | 自己署名 → ユーザーが毎イベント新 IP の証明書を信頼する必要。実運用不可        |
| LiveKit Server 自前 TLS | LiveKit Server は config で TLS 直接サポートなし。公式も非推奨                 |

### D-2. WebRTC メディアは SFU の Public IP 直接公開を維持

WebRTC メディア (UDP 7882 / TCP 7881) は **NLB を経由しない**。SFU の Fargate task に Public IP
を付与し、クライアントが ICE candidate (SFU の Public IP) で直接接続する。

これは ADR 0008 D-4 のメディア部分の方針を継承するものであり、以下のメリットがある：

| 項目                       | 効果                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------- |
| WebRTC P2P 最適化          | ICE/STUN による直接接続で低遅延（LB 経由は遅延・jitter 増加）                         |
| 公式推奨に整合             | LiveKit 公式が「メディアは LB なし」を明記                                            |
| NLB UDP の未検証リスク回避 | NLB UDP リスナーは TCP に比べて成熟度低い。LiveKit との組み合わせ実績薄い             |
| `external_ip` 設定不要     | NLB 経由なら明示指定が必要だが、Public IP 直接なら `use_external_ip: true` で自動検出 |
| コスト                     | メディアトラフィック (映像) は大容量。NLB データ処理料金を回避                        |
| デバッグ                   | シグナリングと経路が分離されて切り分け容易                                            |

#### Security Group の構成

- **NLB の SG**: 0.0.0.0/0 → TCP 443（インバウンド）
- **SFU の SG**:
  - NLB の SG → TCP 7880（シグナリング、NLB 経由）**新規追加**
  - 0.0.0.0/0 → TCP 7881（WebRTC TCP fallback、Public IP 直接）**維持**
  - 0.0.0.0/0 → UDP 7882（WebRTC media、Public IP 直接）**維持**
  - 0.0.0.0/0 → TCP 7880 は **維持（後方互換と切り戻し用）**

#### 代替案と却下理由

| 代替案                            | 却下理由                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------- |
| 全部 NLB 経由（UDP リスナー追加） | NLB UDP は未検証領域、`external_ip` 明示指定の複雑さ、ICE 最適化が損なわれる |
| Cloudfront 経由                   | UDP は CloudFront を通せない                                                 |

### D-3. ACM 証明書は ControlPlaneStack で 1 つのワイルドカード証明書を共有する

ControlPlaneStack で以下を一度だけ作成し、全 EventMediaStack で共有する：

- **HostedZone**: `example.com` を `HostedZone.fromLookup` で参照（既存）
- **ACM 証明書**: `new acm.Certificate(this, "MediaCertificate", {...})` で `*.media.example.com` を発行
- **検証方法**: DNS validation（HostedZone に自動で CNAME を追加）

EventMediaStack は ControlPlaneStack の CfnOutput を `RenderTemplateFunction` 経由で
環境変数として受け取り、`acm.Certificate.fromCertificateArn()` で参照する。

#### なぜワイルドカード証明書か

| 案                                           | 評価                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| ワイルドカード `*.media.example.com`（採用） | 発行は 1 回、全イベント共有、ACM の自動更新もメンテゼロ                             |
| イベントごとに証明書発行                     | ACM 発行は数分かかる → イベント起動時間が長くなる、ACM の発行クォータ消費、運用負荷 |
| SAN 多数のマルチドメイン証明書               | イベント追加ごとに証明書再発行が必要、現実的でない                                  |

ACM ワイルドカードは無料、AWS 内のリソース（NLB, ALB, CloudFront 等）に attach する用途で
完全にサポートされる。

### D-4. per-event DNS パターンは `event-{eventId.slice(0,8)}.media.example.com`

EventMediaStack 内で Route53 ARecord を作成する：

- **HostedZone**: `route53.HostedZone.fromHostedZoneAttributes()` で env から受け取った id + name で参照
- **Record Name**: `event-${eventId.slice(0, 8)}.${mediaDomainName}` （例：`event-fb4067b5.media.example.com`）
- **Type**: A (Alias) → NLB DNS（`elbv2-targets.LoadBalancerTarget(nlb)`）
- **TTL**: alias なので不要

eventId は UUID v4 (36 文字)。先頭 8 文字 (= 32 bit) を使うので衝突確率は 3 並列イベントで
3/2^32 ≈ 7×10⁻¹⁰。実質ゼロ。

EventMediaStack 削除時に Route53 record も一緒に削除される（CFN 管理）。

#### CfnOutput

EventMediaStack は `LivekitDomainName` CfnOutput で完全 DNS 名を返す。reconcile はこれを
DescribeStacks で取得し、`wss://${domain}` 形式で `events.media.livekitUrl` に書き戻す。

ADR 0008 D-2 の reconcile による書き戻しロジックは維持しつつ、URL ソースが Public IP から
CfnOutput に変わる。Public IP 取得ロジックは **fallback として保持**（Output 取得失敗時のみ
発動）し、新旧スタックの混在を許容する。

### D-5. 将来 SFU 冗長化要件が出たら「全部 NLB 案」を別 ADR で再検討する

現状の D-2（メディア Public IP 直接）は **1 task per event** 前提で最適。将来以下のいずれかが
発生した場合は本決定を別 ADR で再検討する：

- 1 イベントあたり同時 1000 人以上のキャパが必要になり、複数 SFU タスクで負荷分散したい
- WebRTC TURN サーバを介した接続率が低く、TURN over TLS (TCP 443) のサポートが必要
- SFU の Public IP がスキャン攻撃の対象になり、IP を隠したい要件が顕在化

その時は「シグナリング + メディアの両方を NLB 経由」「専用 TURN サーバ」等を検討する。

## アーキテクチャ図

```
                    [stage-web (HTTPS)]
                          │
       wss:// (TCP 443)   │   ┌──── UDP 7882 (WebRTC media)
                          │   │     TCP 7881 (WebRTC TCP fallback)
                          ↓   │
   ┌──────────────────────────┴───────┐
   │ NLB (internet-facing, ACM TLS)   │
   │ Listener: TLS 443                │
   │ Cert: *.media.{your-domain}      │
   └──────────┬───────────────────────┘
              │ plain TCP 7880 (VPC 内部)
              ↓
   ┌─────────────────────────────────────┐
   │ SFU (LiveKit Server on Fargate)     │
   │ Public IP 付き (ENI Auto-assign)    │
   │ - 7880 TCP: signaling (NLB から)    │
   │ - 7881 TCP: ICE TCP (直接)          │
   │ - 7882 UDP: WebRTC media (直接)     │
   └─────────────────────────────────────┘
```

## 受け入れ基準 (シナリオチェックボックス)

実装 PR では以下すべてが PASS すること：

### TLS 終端と DNS

- [ ] `vp run --filter @stagecast/infra build` がエラーなく通る
- [ ] `vp run -r test` で全テストが PASS
- [ ] ControlPlaneStack デプロイ後、ACM 証明書が `Issued` 状態になる
- [ ] Route53 HostedZone に ACM 検証用 CNAME が自動追加されている
- [ ] EventMediaStack 起動後、`event-XXXXXXXX.media.example.com` の A レコードが NLB DNS に解決される
- [ ] `curl -v https://event-XXXXXXXX.media.example.com/` で TLS ハンドシェイク成功し、ACM 証明書が返る

### 接続 E2E

- [ ] イベント作成 → live → reconcile が EventMediaStack 起動（5〜8 分）
- [ ] DynamoDB の `events.media.livekitUrl` に `wss://event-XXXXXXXX.media.example.com` 形式の URL が書き込まれる
- [ ] stage-web の /join URL で入室 → LiveKit Server に WebSocket 接続成功（コンソールで "connected" ログ）
- [ ] ICE candidate に SFU の Public IP が広告されている（DevTools で確認）
- [ ] 並列 2 イベントで相互干渉なし（ADR 0008 D-1 の受け入れ基準を継承）

### config と互換

- [ ] `liveKitServerConfig()` の出力に `dev_mode: true` が含まれない
- [ ] `liveKitServerConfig()` の出力に `use_external_ip: true` が含まれる（維持）
- [ ] `EventMediaStackProps` の TLS 関連フィールドは optional で、未指定時は既存の Public IP 直接公開（ADR 0008 D-4）にフォールバック
- [ ] reconcile が `LivekitDomainName` Output 取得失敗時に Public IP 取得にフォールバックする

### ライフサイクル

- [ ] イベントを ended にすると EventMediaStack 全体が削除され、NLB と Route53 record も一緒に消える
- [ ] events.media が undefined にクリアされる（ADR 0008 D-2 を維持）

## セキュリティ考察

### TLS 1.3 採用

- SSL Policy: `ELBSecurityPolicy.TLS13_RES`（TLS 1.3 + 強力な TLS 1.2 fallback）
- ブラウザ互換性: Chrome 70+ / Safari 14+ / Firefox 63+ は全て TLS 1.3 対応

### NLB と SFU 間の暗号化

NLB が TLS 終端した後、VPC 内部で SFU の plain TCP 7880 に転送する。VPC 内通信は AWS 物理
インフラ内で完結し、AWS の SLA で保護される。VPC Flow Logs が必要なら別途有効化可能。

### Public IP 直接公開のリスク（D-2 関連）

メディア用の Public IP は ADR 0008 D-4 のセキュリティ考察を継承：

- Security Group で **TCP 7881 / UDP 7882 のみ** を許可
- LiveKit Server の WebRTC は **STUN + DTLS-SRTP** で暗号化済み
- 未認証アクセスは JWT 検証で拒否

### ACM 証明書の管理

- ACM は AWS が自動更新（メンテゼロ）
- ワイルドカード証明書は ControlPlaneStack で 1 回発行 → 持続
- 証明書失効時は ACM が自動再発行（HostedZone に検証 CNAME がある限り）

## トレードオフ

| 採用した方針                       | 失ったもの                                                  |
| ---------------------------------- | ----------------------------------------------------------- |
| NLB を **シグナリングだけ** に使う | 完全な対称性（メディア用 IP がクライアントに見える）        |
| NLB 復活（ADR 0008 D-4 部分撤回）  | 起動時間 +2-3 分（stage-web の exponential backoff で吸収） |
| ワイルドカード証明書共有           | per-event 証明書の隔離度（必要性低い）                      |
| 案 A（NLB + ACM）採用              | 案 B（Caddy 自己署名）の「ドメイン不要」というメリット      |

## マイグレーション計画

本 ADR を実装する PR で以下を順序立てて実施する：

1. **infra `control-plane-stack.ts`**: HostedZone + ACM 証明書 + CfnOutput + IAM 権限追加
2. **infra `render-template.ts`** + **`event-media-stack.ts` Props**: 環境変数から TLS 関連を受け取る経路を追加
3. **infra `event-media-stack.ts`**: NLB + TLS Listener + Route53 ARecord 追加、`liveKitServerConfig()` から `dev_mode` 削除
4. **media-orchestrator `reconcile-handler.ts`**: `LivekitDomainName` CfnOutput 取得経路を追加（Public IP fallback 保持）
5. **テスト更新**: NLB / ACM / Route53 のリソース検証、reconcile の URL 取得ロジック検証
6. **デプロイ**: ControlPlaneStack → ACM 検証完了 → 新規イベント live → stage-web 接続確認
7. **ADR 0008** のステータスに「**D-4 NLB 廃止は ADR 0009 で部分撤回 (シグナリングは NLB 復活)**」を追記

## 将来課題 (Out of Scope)

本 ADR では扱わない：

| 課題                              | トリガー                                                            |
| --------------------------------- | ------------------------------------------------------------------- |
| **全部 NLB 案への移行** (D-5)     | SFU 冗長化 / 1000 人キャパ要件 / TURN over TLS 要件が顕在化したとき |
| **専用 TURN サーバ**              | 企業ネットワーク等で UDP がブロックされ接続率が低いとき             |
| **per-event 証明書**              | 規制要件等で証明書の隔離が必要になったとき                          |
| **CloudFront 経由のシグナリング** | 地理的に近いエッジで接続させたい要件が出たとき                      |
