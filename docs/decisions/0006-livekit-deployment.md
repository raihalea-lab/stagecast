# ADR 0006: LiveKit Server / Egress のデプロイ構成と SDK 整合

- ステータス: Accepted
- 日付: 2026-06-14
- 関連: `DESIGN.md` 3.2 / 5.1 / 7 章、[ADR 0001](./0001-tech-stack.md)（D-3/D-6/D-7）、
  [ADR 0005](./0005-media-layer-rollout.md)（R1〜R3, D-2 self-hosted 確定）、
  [`docs/NEXT_WORK.md`](../NEXT_WORK.md)（R1 / R2 / D3 / D5）

## コンテキスト

ADR 0005 の Stage 3（R1〜R3）で LiveKit Server / Egress を Fargate 上で「実体化」する。
T1〜T10 の時点では `EventMediaStack` が `image: livekit/livekit-server:latest` を
`ecs.FargateService` で起動するだけで、以下が未整備だった（ADR 0005 コンテキスト表）:

- WebRTC 用 UDP ポート公開と外部到達性（Public IP / NLB / TURN）
- LiveKit Server の `config.yaml`（API キー・Redis アダプタ・ポート設定）
- LiveKit Egress の Chrome ヘッドレス前提と Egress テンプレ URL の置き場所
- 字幕ワーカー / Egress が参照する LiveKit SDK の実 API 整合（D3、string indirection で型回避中）

本 ADR で R1（Server）・R2（Egress）の配置方針と、D3 の SDK 整合方針を確定する。
**self-hosted Fargate 継続は ADR 0005 D-2 で確定済み**であり、本 ADR はその実装方針のみを扱う。

## 決定

### D-1. LiveKit Server の外部到達性: Network Load Balancer (NLB) を採用する

候補は (A) タスクに Public IP を直接付与、(B) NLB を前段に置く、の 2 つ。

| 観点                 | (A) Public IP 直付け                                              | (B) NLB 前段（採用）                                                  |
| -------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| エンドポイント安定性 | タスク再作成で IP が変わる。署名 URL / DNS の張り替えが必要        | NLB の DNS 名が固定。タスク入れ替えに追従                              |
| TLS / signaling      | タスクで直接終端。証明書管理がタスク側に漏れる                     | NLB（TCP 7880/443）で受けてターゲットに流す。将来 ACM 終端に拡張可     |
| UDP (WebRTC media)   | タスクの Public IP に直接届く。NAT 越えは LiveKit の ICE に依存    | NLB は UDP リスナ（7882）を持てる。`UDP` ターゲットグループで転送      |
| コスト               | 追加 LB 費用ゼロ                                                   | 約 $0.0225/h（≈ $16/月）+ LCU。イベント時のみ起動なので実コストは小    |
| セキュリティ         | タスクが直接公開。SG をタスクに直接張る                            | 公開面を NLB に集約。タスクは NLB の SG / VPC CIDR からのみ許可        |

**判断**: エンドポイント安定性と公開面の集約を重視し **(B) NLB** を採用する（R1）。
NLB は L4 なので WebRTC signaling(TCP/WS) と TURN/TLS(TCP) をパススルーでき、
UDP リスナで WebRTC media も受けられる。イベント単位スタックなので NLB も
**イベント時のみ起動・破棄**され、N-1（常時稼働を増やさない）と整合する。

- リスナ構成:
  - TCP 7880 … LiveKit signaling (HTTP/WS)
  - TCP 7881 … WebRTC over TCP (ICE/TCP fallback)
  - UDP 7882 … WebRTC over UDP (主たる media 経路)
- `internetFacing: true`。クロスゾーン負荷分散は有効（タスク 1 でも AZ 跨ぎに強くする）。

### D-2. WebRTC UDP 到達性と TURN: 初期は UDP 直 + TCP fallback、TURN は将来

WebRTC media は UDP 7882 を主経路にし、UDP が通らない視聴/登壇環境向けに
**TCP 7881 を ICE fallback** として開ける（LiveKit の `rtc.tcp_port`）。

- 専用 TURN サーバは **本 PR では立てない**。理由:
  - 登壇者は限定数（最大 3 イベント × 数名）で、TCP/443 fallback で大半の NAT は越えられる。
  - TURN を別タスクで常設すると運用面・コスト面で N-1 に反する。
- 将来、企業 FW 配下で UDP も TCP も通らないケースが観測されたら、LiveKit 内蔵 TURN
  (`turn.enabled`, TLS/5349) を NLB の TCP リスナ経由で有効化する ADR を別途立てる。

### D-3. LiveKit Server config: config.yaml を SSM 経由ではなく環境変数で注入

LiveKit Server は `LIVEKIT_CONFIG_BODY` 環境変数（YAML 文字列）で config を受け取れる。
イベント単位スタックは短命なので、**config.yaml ファイルを別管理せず CDK が YAML 文字列を
合成して環境変数で渡す**。API キー実値は Secrets Manager の `stagecast/livekit` から
ECS Secret として注入する（コードに置かない、ADR 0001 D-10）。

config の要点:

- `redis`: Valkey（`elasticache` serverless）エンドポイントを指す。複数ノード化や Egress と
  Server の状態共有のため **Redis アダプタモード**で動かす（R1 完了基準）。
- `port: 7880` / `rtc.port_range_start..end` を NLB リスナと一致させる。
- `rtc.use_external_ip: true`（タスクの ENI 越しに ICE candidate を正しく広告するため）。
- `keys`: `LIVEKIT_KEYS` 環境変数（`Secrets` 経由）で API キー/シークレットを渡す。

### D-4. LiveKit Egress: Chrome ヘッドレス前提、templateBaseUrl は CloudFront 配信

Egress(`livekit/egress`) は内部で **Chrome ヘッドレス**を起動し、RoomComposite テンプレートを
レンダリングして 1 本の映像に合成する。方針:

- Egress タスクは Server と同じ Valkey を `redis` で共有し、Server がジョブを Egress に
  ディスパッチする（LiveKit Egress の標準構成）。
- Egress も config を環境変数（`EGRESS_CONFIG_BODY`）で受け取り、`ws_url` は Server の
  **VPC 内エンドポイント**（NLB or サービス間）を指す。S3 出力先と RTMP は実行時に SDK 経由で渡す。
- **Egress テンプレ URL（templateBaseUrl）**: 当面は LiveKit 標準ホスト
  (`https://egress-composite.livekit.io`) の組み込みテンプレ（`grid` / `speaker` /
  `single-speaker`）を使う。カスタムテンプレが必要になったら **admin-web/stage-web と同じ
  CloudFront ディストリビューション配下の `/egress-templates/` に配置**し、
  `RoomCompositeOptions.customBaseUrl` で指す（R2 の置き場所決定）。
- S3 出力 IAM: Egress タスクロールに **録画バケットへの限定 PutObject** のみ付与する。

### D-5. Egress レイアウト名は LiveKit 組み込みプリセットと一致させる（D3）

`media-composer` の `layoutToLiveKit` が返す `speaker` / `grid` / `single-speaker` は、
LiveKit RoomComposite の**組み込みテンプレート名と一致**することを SDK ドキュメントで確認した。
`EgressClient.startRoomCompositeEgress(roomName, output, opts)` の `opts.layout` に
そのまま渡す（`updateLayout(egressId, layout)` も同じ名前空間）。
不一致が見つかった場合のみカスタムテンプレ（D-4）へ切替える。

### D-6. LiveKit SDK のバージョン固定方針: caret(^) で最新安定マイナーに固定（D3）

- `livekit-server-sdk@^2.15.4`（Egress クライアント。純 JS、`@stagecast/media-composer` の devDep）
- `@livekit/rtc-node@^0.13.29`（音声トラック購読。ネイティブ依存、`@stagecast/caption-pipeline`
  の **optionalDependency**）

caret 固定の理由: LiveKit は v2 系で API が安定しており、パッチ/マイナー追従を Dependabot に
任せても破壊的変更を踏みにくい。完全 pin は再現性が高い反面、セキュリティ修正の追従が手動に
なるため採らない。`@livekit/rtc-node` は **optionalDependency** とし、ネイティブビルド失敗が
他パッケージの install を巻き込まないようにする。

### D-7. D3 の SDK 整合は「型のみ正規 import + lazy ランタイム」で行う

`@livekit/rtc-node` はネイティブ依存を持つため、ハード依存にすると CI / ローカルの install を
不安定化させる。よって:

- **型整合は `import type`** で実 SDK の型（`Room` / `RoomEvent` / `AudioFrame` /
  `RemoteAudioTrack` / `EgressClient` / `EncodedOutputs` 等）を参照し、従来の
  `as unknown as { ... }`（string indirection）を撤廃する。
- **ランタイムは従来どおり dynamic import**（`await import("@livekit/rtc-node")`）を維持する。
  SDK 未インストール環境では実行時に throw する（テストは fake 注入で外部接続なしに完結する、
  CLAUDE.md テスト方針）。
- 実 SDK 経路の疎通確認は R3（Playwright E2E）で行う。本 PR ではユニットレベルの型/シグネチャ
  整合までを担保する。

## 影響・トレードオフ

- **利点**: 外部到達性が NLB に集約され、タスク入れ替えに強い安定エンドポイントを得る。
  SDK の型が実物と一致し、合成/字幕経路のシグネチャずれをコンパイル時に検出できる。
- **欠点**: NLB のぶん月 $16〜20 程度のコストが配信時に乗る（PR description のコスト試算参照）。
  TURN を持たないため、UDP/TCP ともに塞がれた極端な NAT 環境では接続できないリスクが残る。
- **緩和**: NLB はイベント時のみ起動・破棄。TURN は実観測で必要になってから ADR 追加。

## 次にやること（本 ADR の射程外）

- R3: stage-web → 実 LiveKit の E2E（Playwright）。本 PR は `test.skip` の雛形のみ。
- 実 AWS への `cdk deploy` / Secrets 実値投入 / Bedrock モデルアクセス申請。
- GitHub OIDC IAM Role 作成 / Environment 設定（ADR 0005 O2）。
- TURN サーバ要否の実測（D-2）。
- LiveKit Egress カスタムテンプレの実配置（D-4、必要になったら）。
