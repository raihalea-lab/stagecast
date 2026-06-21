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

## 📌 次にやること (2026-06-21 R12 完了後の優先順位)

R12-followup-1〜22 で **stage-web から SFU への WebRTC 接続** が完了 (案 E: AWS KVS WebRTC TURN 採用 / ADR 0011)。
次はこの順序で進める想定。 各項目は独立した PR・作業として着手可能:

> 💡 **次セッションでそのまま Claude Code に渡せるプロンプト集** は [`NEXT_SESSION_PROMPTS.md`](./NEXT_SESSION_PROMPTS.md) にまとめてあります。 各 P-NN を貼り付けるだけで作業開始できます。

### 🔥 すぐやる (1〜3 日以内)

1. **R12 完了 ✅ (2026-06-21 R12-followup-23 で映像受信成功)**
   - R12-followup-23 (PR #119) で Egress config に `insecure: true` を追加 → Chrome 147+ の LNA WebSocket 制限を回避 → YouTube Live で映像受信成功 ✅
   - 残: **S3 録画ファイル出力**は control-api `startRoomCompositeEgress` が現状 `streamOutputs` のみで `fileOutputs` 未指定のため別タスク (R14 として識別、 下記参照)
   - cleanup PR: 検証用 `debug.enable_chrome_logging: true` + `logging.level: debug` を info に戻す + 本 NEXT_WORK.md / ADR 0010 D-7 / memory `r12-livekit-fargate-gotchas` を更新

2. **R14 (新規): Egress の fileOutputs (S3 録画) 追加**
   - 現状の `services/control-api/src/lambda.ts:178-187` は `StreamOutput` (RTMP) のみ
   - `sdk.EncodedFileOutput({...})` を追加し、 ControlPlane の `AssetsBucket` 配下 `recordings/{eventId}/` プレフィックスに書き出す
   - SFU TaskRole は既に S3 PutObject 権限を持つ (ADR 0010 D-5) ので追加権限は不要
   - 完了基準: 配信終了で `recordings/{eventId}/{egressId}.mp4` が S3 に保存される + admin-web の「成果物」一覧に表示

3. **R15-R17 (新規): カスタム Egress テンプレート (ADR 0012)**
   - 要件 1 (プレビュー) / 要件 2 (レイアウト操作) / 要件 3 (待機画面) を実現する全体方針を [ADR 0012](./decisions/0012-custom-egress-template.md) で定義
   - R15: `apps/composer-template/` 新規 + S3+CloudFront ホスティング + Egress `template_base` 切替 + 待機画面 (要件 3 のイベント中 fallback)
   - R16: admin-web から layout 切替 UI (LiveKit data channel) + spotlight / pip layouts 追加 (要件 2)
   - R17: admin-web / stage-web の iframe プレビュー埋め込み (要件 1)
   - R18 (将来): 365 日 24h 配信 (DESIGN.md N-1 と矛盾するため別 ADR で議論)

4. **DESIGN.md 更新: KVS WebRTC TURN 運用の追記**
   - 3.2 章 (メディア層構成) に TURN レイヤーの記述追加
   - 7.2 章 (常時稼働リソース) に「KVS Signaling Channel (1 個, $0.03/月)」を追記
   - 8 章 (運用) に AWS KVS WebRTC 関連の監視ポイント追記
   - ADR 0011 への参照を本文化

5. **R12-followup-NN 系の cleanup**
   - 念のため本番リハーサル (新規イベント作成 → stage-web 入室 → カメラ・マイク publish → 30 分維持) で安定性確認
   - 不具合あれば NEXT_WORK.md に R12-followup-23+ で追加

### ⏳ 次にやる (1〜2 週間以内)

4. **R7: 統合テスト CI workflow + YouTube ingestion URL 自動取得**
   - イベント作成 → live → stage-web 接続 → Egress → YouTube 確認 までを GH Actions で自動化
   - SLO 観測 (字幕遅延・接続時間) を含める

5. **O1〜O5: 運用準備 (本番運用前の必須)**
   - O2 GitHub OIDC IAM Role (deploy.yml が引き受ける用)
   - O3 main ブランチ保護
   - O4 Cognito 管理者ユーザー (R6 で Custom Resource 化済み、 確認のみ)
   - O5 Secrets Manager の実値投入 (LiveKit / YouTube)

6. **L1: 利用規約 / プライバシーポリシー**
   - テンプレ ([`docs/legal/terms-template.md`](./legal/terms-template.md)) を実運用者向けに編集
   - 配信前に弁護士レビュー

### 📅 余裕があれば (1 ヶ月以内)

7. **D8 残: エンジン側 (Transcribe/Translate/Bedrock) の一過性エラー再試行**
   - 二重字幕回避を考慮しつつ withRetry を字幕パイプラインの engine 呼び出しにも展開

8. **N3 残: SNS Slack subscribe** (アラート通知の届け先設定)

9. **N6: shadcn/ui への移行 (admin-web の見栄え改善)**

10. **N4: 配信前リハーサル機能** (status=draft で 5 分起動 → 自動破棄)

### 🌱 将来 (3 ヶ月以降)

11. **R13: 将来の SFU 冗長化時に NLB UDP も検討** (1 イベント 1000 人以上のキャパが必要になったとき)
12. **N5: 配信終了後の自動サマリー** (録画 + 字幕 + 統計を Slack/メール)
13. **L3: コスト監視と上限設定の運用** (Budget アラート subscribe)

### 詳細表 (これまでの R / O / D / N / L / P 行は以下のセクション参照)

---

## R: メディア層実体化・本番配信化 (ADR 0005)

> 詳細・決定背景は [ADR 0005](./decisions/0005-media-layer-rollout.md) を参照。
> 5 Stage に分けて段階的にロールアウト。各 Stage 完了まで次に進まない。

| ID                 | Stage | スコープ                                                                     | 想定 PR                                            | 完了基準                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ----- | ---------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1**             | S3    | LiveKit Server の config.yaml + Valkey 接続 + UDP ポート公開 (NLB)           | `claude/livekit-stage3` (IaC 完)                   | stage-web から実 LiveKit に接続できる (deploy は別)                                                                                                                                                                                                                                                                                                                                                                                         |
| **R2**             | S3    | LiveKit Egress の Chrome ヘッドレス設定 + Egress テンプレ URL                | `claude/livekit-stage3` (IaC 完)                   | RoomComposite Egress で合成映像が RTMP に出る                                                                                                                                                                                                                                                                                                                                                                                               |
| **R3**             | S3    | stage-web → 実 LiveKit E2E (Playwright)                                      | `claude/stage-web-livekit-e2e`                     | 雛形 (`describe.skip`) のみ。Playwright 実装は別 PR                                                                                                                                                                                                                                                                                                                                                                                         |
| **R4**             | S4    | 字幕ワーカー Docker 化 + ECR Repository + GHA build/push                     | `claude/caption-worker-docker` (IaC/CI 完)         | Dockerfile + ECR + GHA build 完。実 push/疎通は deploy 後                                                                                                                                                                                                                                                                                                                                                                                   |
| **R5**             | S5    | reconcile Lambda IAM 最小化 (CFN Service Role + PassRole)                    | `claude/reconcile-iam-min` (完)                    | reconcile は cloudformation:\* + iam:PassRole のみ (実権限は CFN ロールへ)                                                                                                                                                                                                                                                                                                                                                                  |
| **R6**             | S5    | Cognito 管理者 Custom Resource (✅) + CloudFront カスタムドメイン + ACM (未) | `claude/cognito-admin-bootstrap` (CR 完)           | `-c initialAdmins=...` で初期管理者を IaC 投入。ACM/独自ドメインは要ドメインで別途                                                                                                                                                                                                                                                                                                                                                          |
| **R7**             | S5    | 統合テスト CI workflow + YouTube ingestion URL 自動取得                      | `claude/integration-ci-youtube`                    | 1 イベントを実 YouTube Live に配信、SLO 観測                                                                                                                                                                                                                                                                                                                                                                                                |
| **R8**             | S3+   | LiveKit per-event URL ルーティング + NLB 廃止 (ADR 0008)                     | `claude/livekit-per-event-url` (**✅ 完**)         | events.media.livekitUrl を reconcile が書き戻し、/join が per-event URL を返す。並列 2 イベントで相互干渉なし (ADR 0008 受け入れ基準)                                                                                                                                                                                                                                                                                                       |
| **R9**             | S3+   | stage-web → 実 LiveKit 接続の E2E 確認 (TLS 込み)                            | `claude/r11-caption-worker-ecr-push` (ADR 0009)    | 招待 URL 発行 → stage-web で /join → LiveKit Server に WebSocket 接続成功。**ADR 0009 で NLB + ACM + Route53 による TLS 終端を実装**。確認は実機デプロイ後                                                                                                                                                                                                                                                                                  |
| **R10**            | S3+   | イベント終了で EventMediaStack が破棄されること確認                          | `claude/r11-caption-worker-ecr-push` (**✅ 完**)   | status=ended → reconcile が stack destroy → events.media がクリア。実機で確認済み (2026-06-19)                                                                                                                                                                                                                                                                                                                                              |
| **R11**            | S4    | caption-worker イメージを ECR に push + CAPTION_WORKER_IMAGE 有効化          | `claude/r11-caption-worker-ecr-push` (**✅ 完**)   | docker build (arm64) + ECR push 完了。control-plane-stack.ts のコメントアウトを解除 → CaptionWorker が実イメージで起動                                                                                                                                                                                                                                                                                                                      |
| **R12**            | S5    | YouTube Live RTMP 送出の E2E 確認 (**実機 stage-web 入室まで完了** ✅)        | `claude/r12-youtube-rtmp` (PR #78) ほか R12-followup-1〜22 | **2026-06-21 stage-web 入室成功**。 LiveKit Egress + Valkey psrpc は ADR 0010 (sidecar 同居 + 非Serverless) で解消、 NAT 越え ICE は ADR 0011 案 E (AWS KVS WebRTC TURN を stage-web の rtcConfig.iceServers に直接渡す) で解消。 R12-followup-1〜22 の試行錯誤は ADR 0011 に集約。 残: YouTube Live RTMP 送出までの E2E (Egress + RTMP) は別 deploy で確認予定                                                                       |
| **R12-followup**   | S5    | LiveKit Egress が SFU からジョブを受け取れない問題の根本対策                 |                                                    | SFU ログで `topic: [""]` (Egress 発見テーブル空)、Egress ログは "service ready" 止まり。試行: `LIVEKIT_WS_URL` 注入・SFU/Egress イメージタグ変更 (`v1.10.0/v1.13.0` / `latest`) 効果なし。**残仮説**: (1) ElastiCache Valkey Serverless の cluster mode 制約で psrpc pub/sub が動かない (2) Valkey TLS 接続で psrpc が認識する topic が空になる。対策候補: ElastiCache Redis (非 Serverless) への切替、または Egress を ECS on EC2 で動かす |
| **R12-followup-2** | S5    | SFU と Egress を同一 ECS Task に sidecar 同居 (ADR 0010)                     | `claude/r12-egress-sidecar` (PR #85 マージ, **検証 NG**) | Egress を SFU TaskDef の sidecar として配置し localhost で疎通 (`ws://localhost:7880`)。Valkey 維持。Task は 2 vCPU / 4 GiB に増強。独立 Egress Service を廃止。**実機検証 (2026-06-20)**: sidecar 同居だけでは psrpc 登録不可、`no response from servers` 継続 → ADR 0010 D-6 (Valkey 非Serverless) に進む |
| **R12-followup-3** | S5    | Valkey 非Serverless (cluster mode disabled) に切替 (ADR 0010 D-6)            | `claude/r12-valkey-nonserverless` (PR #88 マージ, **検証 NG**) | CfnServerlessCache → CfnReplicationGroup (engine=valkey, cache.t4g.micro × 1)。SG 6379 のみ。LiveKit config を `cluster_addresses` → `address` に戻す。**実機検証 (2026-06-20)**: Egress は `"simple":true` で接続成功するも、依然 `service ready` 後ログ無し / SFU は `topic: [""]` で `no response from servers` 継続。**仮説**: SFU `livekit/livekit-server:latest` (v1.13.1) と Egress `livekit/egress:latest` の psrpc protocol version 不一致 |
| **R12-followup-4** | S5    | SFU の `LIVEKIT_CONFIG` env 名修正 (根本原因)                                 | `claude/r12-livekit-config-env-fix` (PR #90 マージ) | livekit-server は `LIVEKIT_CONFIG` を読むのに `LIVEKIT_CONFIG_BODY` を渡していたため redis config が解析されず single-node routing で起動していた。**実機検証**: SFU が redis に接続するようになった ✅ |
| **R12-followup-5** | S5    | `use_external_ip` を削除して Fargate panic 回避                              | `claude/r12-disable-use-external-ip` (PR #91 マージ) | LIVEKIT_CONFIG が読まれるようになった結果、`use_external_ip: true` + Fargate に EC2 metadata が無い組み合わせで `getNAT1to1IPsForConf` が `rand.Intn(0)` で panic。`use_external_ip` を削除して Public IP は別経路で渡す |
| **R12-followup-6** | S5    | SFU 起動時に Public IP を解決して `--node-ip` 注入                            | `claude/r12-sfu-node-ip` (PR #92 マージ) | entryPoint を `sh -c` で wrap し `wget -qO- https://ifconfig.io` で Task の Public IP を取得 → `--node-ip` フラグで LiveKit Server に渡す。**実機検証**: SFU が `nodeIP=13.231.145.187` で起動、WSS シグナリング接続 ✅。だが **ICE pair が `failed` (UDP responsesReceived: 0)** で WebRTC メディア未確立。SFU が複数 NIC (eth0/eth1) で listen し ICE candidate が混在、Fargate task の二重 ENI 構造との相性が疑わしい |
| **R12-followup-7** | S5    | ICE 設定の見直し (port_range vs udp_port mux mode)                           | `claude/r12-livekit-udp-mux-mode` (PR #95 マージ, 案 (a))  | LiveKit config で `udp_port: 7882` + `port_range_start/end: 7882` が混在しており、ログには `rtc.portUDP: {Start: 7882, End: 0}` と出る。LiveKit 推奨は `udp_port` 単一 mux モード **か** `port_range` (50000-60000) のどちらか択一。**実施 (案 (a))**: `port_range_start/end` を削除し `udp_port: 7882` 単独 (UDP mux mode) に統一。infra ユニットテストに「port_range は使わない」アサーション追加。実機検証は ControlPlane 再デプロイ後に SFU ログで `rtc.portUDP` の表示と stage-web ICE pair の `state: succeeded` を確認。**ダメなら案 (b) (coturn sidecar) → 案 (c) (v1.10.x ダウン)** |
| **R12-followup-8** | S5    | NLB self-ping 不可と eth0 link-local 汚染への対策 (yaml 設定のみ)              | `claude/r12-livekit-skip-ip-validation` (PR #96 マージ)    | Web 調査で判明した 2 つの根本要因を yaml 設定だけで潰す。**(1)** `rtc.skip_external_ip_validation: true` 追加 (v1.13 公式 config-sample で「NAT 環境で必要」と明記。Fargate + NLB は hairpin NAT 不可で self-ping が必ずタイムアウトする)。**(2)** `rtc.ips.excludes: [169.254.0.0/16]` 追加 (Fargate awsvpc コンテナは eth0=Task Metadata 用 veth + eth1=Task ENI の 2 NIC 構成で、Pion が全 NIC の全 IP を host candidate にしてしまう → リンクローカルを除外)。出典: LiveKit Issue [#3508](https://github.com/livekit/livekit/issues/3508), [#4049](https://github.com/livekit/livekit/issues/4049), 公式 [config-sample.yaml](https://github.com/livekit/livekit/blob/master/config-sample.yaml)。**残課題は R12-followup-9 で対応** |
| **R12-followup-9** | S5    | VPC Private IP も ICE excludes に動的注入                                      | `claude/r12-livekit-exclude-vpc-cidr` (PR #97 マージ)      | R12-followup-8 では link-local しか除外できていなかった。Fargate Task ENI の VPC Private IP (例 10.0.x.x) もブラウザからは到達不可なので Pion が host candidate として広告すると ICE 確立が遅延する。`liveKitServerConfig` に `vpcCidr` 引数を追加し CDK 側で `vpc.vpcCidrBlock` を流し込む。SharedVpc / per-event VPC のどちらでも安全に動く (vpcCidrBlock は CDK Token として渡るので yaml 内で正しく解決される) |
| **R12-followup-10** | S5    | LiveKit 内蔵 TURN 有効化 (ADR 0011 案 B、シンメトリック NAT 救済)              | `claude/r12-livekit-turn-server` (PR #100/#101 マージ, 案 B) | 実機検証 (2026-06-20) で publisherCandidates の `srflx 14.8.39.x:46547 related 192.168.1.39:57015` を確認 → STUN 用 port と SFU 用 port が異なる = **シンメトリック NAT 確定**。SFU 直接 UDP では NAT 応答が抜けられないので **TURN over UDP** で救済する (クライアントは TURN サーバへの単一接続を維持するので NAT mapping が安定)。実装: yaml に `turn: {enabled: true, udp_port: 3478, relay_range_start/end: 50300-50400}` 追加、SG に UDP 3478 + UDP 50300-50400 を `0.0.0.0/0` 開放、TaskDef portMapping に 3478 追加。TLS は不要 (UDP TURN のみ)。クライアントには LiveKit が JoinResponse で `iceServers: [{urls: "turn:..."}]` を自動配信 (HMAC 短期 credential)。**実機検証 (2026-06-20)**: TURN allocate は成功し relay candidate 取得まで動作するも、**iceServers に username/credential が空**で配信され TURN authentication 失敗 → R12-followup-11 で対応 |
| **R12-followup-11** | S5    | LIVEKIT_KEYS を yaml `keys:` に動的注入 (TURN credential 配信修正)              | `claude/r12-livekit-keys-yaml-inject` (PR #102 マージ, **検証 NG**) | R12-followup-10 で TURN は起動するも、JoinResponse の iceServers に username/credential が空で配信される問題が判明。LiveKit ソース (`pkg/service/roommanager.go:1045-1087`) で `iceServersForParticipant` が `keys.GetSecret(apiKey)` で API secret を引いて HMAC でcredential を生成する仕様。`LIVEKIT_KEYS` env から `keys:` map への変換が機能していない仮説。**対策**: entryPoint の sh -c で `LIVEKIT_CONFIG` + `LIVEKIT_KEYS` を `/tmp/livekit.yaml` に合成 → `/livekit-server --config /tmp/livekit.yaml --node-ip <ip>` で起動。 /tmp は Fargate tmpfs なので Secret は永続化されない。**実機検証**: yaml には keys が反映されたが iceServers は依然 credential 空 |
| **R12-followup-12** | S5    | SFU 起動時の yaml 構造 trace ログ追加                                              | `claude/r12-livekit-yaml-debug-log` (PR #103 マージ)         | yaml 行数 / keys セクション存在 / keys 行長を ログ出力。 結果: yaml は正しく書かれていた (`HAS_KEYS_SECTION=1, KEYS_LINE_LEN=65`) |
| **R12-followup-13** | S5    | SFU に --keys CLI flag 併用 + logging.level: debug                                | `claude/r12-livekit-keys-cli-debug` (PR #104 マージ)         | `--keys` CLI で念のため両経路で渡し、 debug ログで iceServers 生成 trace を確認。 結果: SFU 側 debug ログでは `iceServers: [{urls:[...], username:"<redacted>", credential:"<redacted>"}]` が出力 (内部では credential 生成済) だが、 webrtc-internals dump 上は credential 空。 wire 上で空文字 → proto3 omit と推測 |
| **R12-followup-14** | S5    | coturn sidecar + 静的認証 (ADR 0011 案 C)                                          | `claude/r12-coturn-sidecar` (PR #105 マージ, **検証 NG**)   | LiveKit 内蔵 TURN を `enabled: false` で停止し、 coturn を SFU TaskDef に sidecar 同居 (PR #106/#107 で arm64 対応の `coturn/coturn:alpine` に変更, PR #108 で `unset LIVEKIT_CONFIG`, PR #109 で `secret:` field の HMAC)。 結果: dump で **依然として username/credential 空のまま**。 LiveKit Server v1.13.1 が `rtc.turn_servers` の credential を wire に乗せない挙動を確認 |
| **R12-followup-19** | S5    | **TURN を AWS KVS WebRTC に外出し (ADR 0011 案 E)**                                | `claude/r12-kvs-webrtc-turn` (PR #110/#111 マージ)          | LiveKit 内蔵 TURN / coturn sidecar (R12-followup-10〜18) を全部撤回。 AWS Kinesis Video Streams WebRTC が提供する TURN を **control-api の /join で取得** → **stage-web の Room.connect の `rtcConfig.iceServers` に直接渡す** → LiveKit Client SDK の `if (!rtcConfig.iceServers)` 判定で server からの iceServers を bypass。 KVS マネージドなので公式 sanctioned、 月 $0.03 (Signaling Channel) + イベント分のみ |
| **R12-followup-22** | S5    | **R12-followup-9 訂正: ips.excludes から VPC CIDR 除去 (host candidate 0 個問題)**  | `claude/r12-remove-vpc-cidr-excludes` (PR #114 マージ) **R12 完了** | R12-followup-9 で「Private IP はブラウザから到達不可」として VPC CIDR を ips.excludes に追加していたが、 `--node-ip` の NAT1To1 は **既存の host candidate の IP を書き換える** 仕様であり、 host candidate が 0 個だと書き換える対象がなく candidate gather が空 → trickle ICE が動かず client に candidate を送れない問題が判明。 link-local (169.254/16) のみ excludes に残し、 VPC Private IP を host candidate に残すことで NAT1To1 が機能して Public IP が client に配信される。 **2026-06-21 stage-web 入室成功で R12 完了 ✅** |
| **R12-followup-23** | S5    | Egress 映像真っ黒 / Chrome process hung 対策 (ADR 0010 D-7)                         | `claude/r12-youtube-rtmp-e2e` (PR #119 マージ) **R12 完全完了** | 2026-06-21 R12 残作業の YouTube Live RTMP 送出 E2E 検証で、 Egress 起動 → `pipeline playing` → `egress_active` まで到達し RTMP 信号も届く (YouTube stream status ACTIVE) が **映像真っ黒** + `pipeline playing` 以降 9 分以上 Egress ログ完全停止の症状を観測。 **根本原因**: LiveKit Egress のデフォルトテンプレート (`http://localhost:7980/`) から `ws://localhost:7880` 接続が Chrome 147+ の LNA WebSocket 制限で拒否されていた。 **対策**: Egress config に `insecure: true` を追加して `--disable-web-security` + `--allow-running-insecure-content` を付与。 **2026-06-21 実機検証で映像受信成功 → R12 完全完了 ✅**。 詳細は ADR 0010 D-7 |
| **R14**             | S5    | Egress fileOutputs (S3 録画ファイル) 追加                                            | (未起票)                                                | control-api `services/control-api/src/lambda.ts:178-187` の `startRoomCompositeEgress` 呼び出しに `file: new sdk.EncodedFileOutput({...})` を追加し、 ControlPlane の AssetsBucket 配下 `recordings/{eventId}/` プレフィックスに mp4 出力する。 SFU TaskRole は既に S3 PutObject 権限あり (ADR 0010 D-5)。 完了基準: 配信終了で `recordings/{eventId}/{egressId}.mp4` が S3 に保存 + admin-web の「成果物」一覧に表示 (artifact-download.ts は既存) |
| **R15**             | -     | カスタム Egress テンプレート (ADR 0012 D-1/D-2/D-3/D-5)                              | `claude/r15-composer-template-base` (未起票)             | `apps/composer-template/` を React+Vite+livekit-client で新規作成。 ControlPlane の AssetsBucket に `assets/composer/` プレフィックスで upload、 admin-web CloudFront に `/composer/*` cache behavior 追加。 Egress config の `template_base` をカスタムテンプレート URL に切替。 待機画面 (publishing participant 0 人時) も含む。 grid layout のみ。 完了基準: ADR 0012 受け入れ基準 1, 2, 4 |
| **R16**             | -     | admin-web からの layout 切替 UI + spotlight/pip layouts (ADR 0012 D-4)               | `claude/r16-layout-control` (未起票)                     | admin-web に livekit-client 組込み + admin role token 取得 (control-api `/admin-token` 新規 endpoint) → room に join → data channel で layout JSON を broadcast。 テンプレート側で受信して React state 更新 → layout 切替 (sub-second)。 layout 種類: grid / spotlight / pip / 画面共有メイン の 4 種。 完了基準: ADR 0012 受け入れ基準 3 |
| **R17**             | -     | admin-web / stage-web の iframe プレビュー埋め込み (ADR 0012 D-6)                    | `claude/r17-live-preview` (未起票)                       | admin-web EventDetail に "ライブプレビュー" section + stage-web 登壇者ビュー右下に "現在の配信" 小窓。 iframe src は subscriber-only token を control-api で発行 (publish 権限なし、 layout 操作不可)。 完了基準: ADR 0012 受け入れ基準 5, 6 |
| **R18** (将来)     | -     | 365 日 24h 配信 (常時 fallback 配信)                                                  | TBD (別 ADR 起票)                                       | イベント外も「ロゴ + BGM + 次回開催情報」を YouTube に流し続ける機能。 DESIGN.md N-1 (常時稼働リソースなし) と矛盾するため設計検討要。 候補: 常時 ffmpeg loop + S3 mp4、 LiveKit Standby Room、 EventBridge Schedule 等。 別 ADR 起票後に着手 |

> **R12-followup-4 〜 9 の意思決定は [ADR 0011](./decisions/0011-livekit-ice-fargate-config.md) に集約済み**。
> 「Fargate + NLB 上の LiveKit Server で WebRTC ICE を確立するための設定群」として 6 つの決定 (D-1〜D-6) と
> 受け入れ基準・フォールバック方針 (案 B/C/D) を一箇所にまとめた。実機検証時はこの ADR の受け入れ基準を満たすかをチェック。

### R12-followup-7〜9 マージ後の実機検証手順 (次セッションの一手目)

> 前提: PR #90〜#98 が main にマージ済 (2026-06-20)。yaml 設定 + CDK で打てる対策は全て入った。
> 残るは ControlPlane を再デプロイして実機 ICE pair が succeeded になるかの検証のみ。

**手順** (所要 ~30 分):

1. **再デプロイ**: `vp run --filter @stagecast/infra cdk -- deploy StagecastControlPlane`
   - SharedMediaVpc 配下なので EventMediaStack 自体は新規イベント作成時に reconcile が立ち上げる
2. **新規イベント作成 → live 遷移**: admin-web で配信用イベントを作って status を `live` に
3. **SFU 起動ログを確認** (CloudWatch Logs / log group `/aws/ecs/stagecast-event-XXX/sfu`):
   - `Resolved NODE_IP=<Public IP>` (R12-followup-6)
   - config 反映確認 — 以下が yaml に含まれているか:
     - `udp_port: 7882` のみで `port_range_*` が無い (R12-followup-7)
     - `skip_external_ip_validation: true` (R12-followup-8)
     - `ips.excludes:` に `169.254.0.0/16` と VPC CIDR の 2 行 (R12-followup-8/9)
4. **stage-web で /join**: 招待 URL を発行してブラウザで開く → カメラ/マイク publish
5. **ICE pair 状態確認**:
   - Chrome `chrome://webrtc-internals` で当該 RTCPeerConnection を開く
   - `iceConnectionState: connected` / `selectedCandidatePair.state: succeeded` を確認
   - host candidate に `169.254.x.x` も VPC Private IP も流れていないこと
   - `responsesReceived` がインクリメントしていること (R12-followup-6 で 0 のままだった)

**全部 OK なら**: R12 完了。NEXT_WORK.md の R12 行を ✅ 化。R7 (YouTube 統合テスト) に進む。

**ICE pair がまだ `failed` なら**: [ADR 0011](./decisions/0011-livekit-ice-fargate-config.md) のフォールバックに従う:

1. **案 B**: `turn.enabled: true` で LiveKit 内蔵 TURN を有効化、relay_range を 50300-50400 程度に絞り NLB or SG で開放
2. **案 C**: coturn sidecar (ADR 0010 と同型に新規 ADR 0012 を起票)
3. **案 D**: LiveKit Server v1.10.x にダウングレード

参考:

- ADR 0011 (Fargate ICE 設定の正本) … 6 つの決定 D-1〜D-6 と受け入れ基準
- memory `r12-livekit-fargate-gotchas.md` … 踏破済みの 6 罠
- LiveKit Issue [#3508](https://github.com/livekit/livekit/issues/3508) (Dual NIC) / [#4049](https://github.com/livekit/livekit/issues/4049) (--node-ip 無視) / [#4095](https://github.com/livekit/livekit/issues/4095) (TURN 経由 NAT GW 漏れ)

| **R13**            | S3+   | 将来の SFU 冗長化時に NLB UDP も検討 (ADR 0009 D-5)                          |                                                    | 1 イベント 1000 人以上のキャパや TURN over TLS が必要になったタイミングで、シグナリングとメディアの両方を NLB 経由にする案を別 ADR で評価する                                                                                                                                                                                                                                                                                               |

---

## V: 実機検証で判明した修正 (2026-06-17〜18 のデプロイ検証)

> EventMediaStack の初回起動で発見・修正した問題。将来同種の問題を防ぐための記録。

| PR     | 問題                                             | 修正                                                  | 教訓                                                    |
| ------ | ------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------- |
| #64    | CORS preflight OPTIONS → 401                     | allowMethods に PUT 追加                              | 新しい HTTP メソッドを使うときは CORS も更新            |
| #65    | $default JWT が OPTIONS を吸い込む               | OPTIONS /{proxy+} を NONE で登録 + Lambda で 204 返却 | API GW HTTP API の $default は全メソッドにマッチ        |
| #66    | CFN ロールに ssm:GetParameters がない            | EventMediaCfnExecRole に SSM 権限追加                 | CDK テンプレートは bootstrap パラメータを SSM から読む  |
| #67    | SEARCH 式がアラームで使えない                    | 固定ディメンション Metric に変更                      | SEARCH はダッシュボード専用                             |
| #68    | MetricFilter で dimensions が anyTerm と併用不可 | per-event メトリクス名に変更                          | MetricFilter の制約を事前に把握                         |
| #69    | ログがロールバックで消える + NAT Gateway 不要    | RETAIN + natGateways:0                                | ephemeral スタックでもログは RETAIN                     |
| #70-72 | LIVEKIT_KEYS の組み立て (sh -c)                  | entryPoint/command の試行錯誤                         | Docker image の ENTRYPOINT と ECS の挙動差              |
| #73    | LIVEKIT_KEYS を Secret から直接注入              | livekitKeys フィールド追加、シェル不要に              | ECS Secret で "key: secret" 形式を直接渡すのが最も確実  |
| #74    | CaptionWorker プレースホルダが即終了             | command: ["sleep", "infinity"]                        | node:24-alpine は引数なしで即終了する                   |
| #75    | ECR 未 push のイメージ参照                       | CAPTION_WORKER_IMAGE を一時コメントアウト             | イメージが存在しない ECR URI を参照するとタスク起動失敗 |

### 2026-06-19 R9/R10/R11 検証で判明した修正

| 問題                                         | 修正                                                       | 教訓                                                                        |
| -------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| 招待 URL が `app.stagecast.local` で発行     | `INVITE_BASE_URL` を stage-web CloudFront URL に設定       | フォールバックURLは開発用なので CDK で必ず上書きする                        |
| caption-worker イメージが arm64 のみ         | `runtimePlatform: ARM64` を Fargate Task Definition に追加 | local docker build が arm64 → Fargate デフォルト x86_64 と不整合            |
| caption-worker が `LIVEKIT_URL` 無しで即終了 | `CAPTION_BUS=valkey` + Valkey 接続でイベントループ維持     | Node.js は待機ハンドルが無いと即終了する                                    |
| caption-pipeline に `ioredis` 未宣言         | `dependencies` に `ioredis` を追加                         | dynamic import でも prod bundle に必要なものは dependencies へ              |
| `wss://` 接続が `ERR_SSL_PROTOCOL_ERROR`     | ADR 0009: NLB + ACM + Route53 で TLS 終端                  | LiveKit は config に TLS 直接サポートなし、`dev_mode` も TLS は有効化しない |

### 2026-06-20 UX 改善

| 問題                                            | 修正                                                | 教訓                                                              |
| ----------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| 配信中に Cognito ID Token (1h) が期限切れになる | `accessTokenValidity` / `idTokenValidity` を 6h に  | 1 イベント運営は 1〜2h 続くので、トークン寿命を運用に合わせる     |
| 管理 UI / stage UI に UX 不足                   | admin-web 一覧スケルトン + stage-web カメラプレビュー | 入室前に「映っている」確認できると主催者の不安が大幅に下がる (N7) |

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
- [x] **AWS Budgets でアカウント全体に月額アラート設定済み (2026-06-20)** — CDK で実装 (デフォルト 30 USD、80% で WARN・100% 予測で CRITICAL、専用 SNS Topic `CostAlarmTopic`)。`-c budgetEmail=foo@example.com -c budgetMonthlyUsd=50` で変更可能

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

### D8. 配信経路のレジリエンス (一過性エラー耐性)

- ✅ 共通 `withRetry` (指数バックオフ, `@stagecast/shared`) を追加。字幕 Sink 配信を
  バックオフ再試行し、全滅しても **パイプラインを止めず計測+ログのみ** (best-effort, N-2)
- ✅ reconcile の `describeStacks` (CFN ポーリング読取) も `withRetry` でラップ。一過性スロットリングで
  1 tick を諦めない。`createStack` は非冪等なので意図的に対象外
- 残: エンジン側 (Transcribe/Translate/Bedrock) の一過性エラー再試行は二重字幕回避を考慮しつつ別途。
  YouTube ingest など他の外部呼び出しにも `withRetry` を横展開

---

## N: Nice-to-have (UX / DX 改善・遠い未来)

### N1. 配信後の成果物 UI ✅ 対応済み

- control-api: `GET /events/{id}/artifacts` を追加。`S3ArtifactStore` が `recordings/{id}/` と
  `captions/{id}/` を列挙し presigned GET URL を返す (`createArtifactDownloadService`)
- admin-web: `EventDetail` に「成果物 (録画 / 字幕)」セクション + ダウンロードリンク
  (`ArtifactService` 抽象 + `HttpArtifactService` / `InMemoryArtifactService`)
- 実 DL 確認は配信終了後 (S3 に成果物が出てから)。S3 未設定時は 503 → UI は空表示

### N2. ローカル開発用 docker-compose

- LiveKit Server + Valkey + 字幕ワーカーをローカルで立ち上げる `docker-compose.yml`
- `USE_FAKE_ADAPTERS=true` で外部接続なしに動かす経路は既にあるが、**実プロトコルで
  鳴らしたい時** に欲しい

### N3. 観測性の強化

- ✅ **AWS X-Ray の Lambda 有効化 (2026-06-20)**: control-api / render-template / reconcile /
  admin-bootstrap の 4 つに `tracing: ACTIVE` を設定。CloudWatch ServiceLens でリクエストフロー
  (Lambda → DynamoDB → Secrets Manager → LiveKit API) が可視化される。Fargate は未対応
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

- ✅ 招待 URL アクセス時の **デバイス事前テスト** (カメラ/マイク選択 + マイク音量メーター)。
  `lib/devices.ts` (純ロジック + `MediaDevicesProvider` 抽象 + Fake) / `browser-devices.ts`
  (navigator + AudioContext 実装) / `components/DeviceCheck.tsx`。選択は localStorage に保存し、
  `RoomConnector.setPreferredDevices` 経由で publish 時の capture device に反映
- ✅ SFU 切断の検知 → 入室画面へ戻し再入室を促す (`RoomConnector.onDisconnected`)
- 接続失敗時のフォールバック (Audio only モード) (未)
- カメラのライブプレビュー / セッション中のデバイス切替 / 自動再接続 (未)

---

## L: 法的・運用 (公開前に決めるべき事項)

### L1. 利用規約 / プライバシーポリシー

- ✅ **テンプレート作成済み (2026-06-20)**: [`docs/legal/terms-template.md`](./legal/terms-template.md) と
  [`docs/legal/privacy-template.md`](./legal/privacy-template.md)。公開配信前に運用者が編集し弁護士レビューを推奨
- 配信中に取得する情報 (音声・映像・表示名)、YouTube Live への送出、S3 録画保管 (30日)、
  Cognito 招待、字幕の AWS 送信 (Transcribe/Translate/Bedrock) を網羅
- Cognito 招待でも consent (利用同意) の UI を入れるかどうか決定 (未)

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

---

## 継続改善ループの完了ログ (2026-06-15)

`/loop` による継続改善で、デプロイ検証が不要な範囲を中心に以下をマージ済み。

### レジリエンス

- **D8** 汎用 `withRetry` (指数バックオフ) を `@stagecast/shared` に追加
- 字幕 Sink 配信を `withRetry` でラップ + 全滅は計測/ログのみで握る (字幕 best-effort)
- reconcile の `describeStacks` を `withRetry` で耐スロットリング化 (createStack は非冪等で対象外)
- `StageController.join` を冪等化 (連打/入室済みで二重接続しない)

### 入力検証 / セキュリティ

- control-api イベント入力の型/長さ/日時バリデーション (400 応答, 500 回避)
- 招待発行の role 値域 / ttl 範囲 (60s〜7d) / eventId 検証

### 可観測性

- `createLogger` (構造化 1 行 JSON ログ) を導入し backend の `console` を置換 (N3)
- `SinkDeliveryRetries` メトリクス + EventMediaStack に Sink エラーアラーム/ダッシュボード

### UX / フロント (N1/N7)

- 配信成果物 (録画/字幕) のダウンロード API + admin-web UI (N1)
- stage-web 入室前デバイステスト (マイク/カメラ選択 + 音量メーター) (N7)
- stage-web SFU 切断検知 → 再入室導線 (N7)
- admin-web / EventDetail の API エラー surface + 処理中表示

### 字幕品質 / リファクタ

- SRT/VTT キュー本文サニタイズ (VTT エスケープ + 空行除去)
- 字幕 Sink 種別を `CAPTION_SINK_KINDS` / `CaptionSinkKind` に集約 (重複解消)

> 字幕パイプラインの呼び出しレジリエンス方針 (best-effort 配信 / リトライ / タイムアウト / 計測) は
> [ADR 0007](./decisions/0007-caption-resilience.md) に集約。

### 継続改善ループ 第 2 弾 (#40〜#50)

- **#40** admin-web の作成/操作ボタンを処理中 disabled (連打防止)
- **#41** stage-web 再接続中バナー (livekit-client `Reconnecting`/`Reconnected` を反映, N7)
- **#42** 字幕メトリクスを runtime に配線 (本番でデッドコードだった collector を実体化) +
  翻訳失敗メトリクス `TranslateErrors` + EventMediaStack アラーム/ダッシュボード (T9, N-2)
- **#43** 共通 `withTimeout` を追加し Sink 配信をタイムアウト化 (固まった Sink が drain/音声取り込みを
  止めるのを防ぐ, N-2)
- **#44** エンジン翻訳呼び出しを `withTimeout` 化 (transcribe 8s / llm 20s 既定)。固まった翻訳が
  pushAudio を止めるのを防ぐ。`onTranslateError` も発火し計測 (N-2)
- **#46** [ADR 0007](./decisions/0007-caption-resilience.md) 字幕レジリエンス方針を明文化
- **#47** `withRetry` に `retryable` マーカー (恒久エラーは即断念)。YouTube ingest の 4xx を
  `CaptionIngestionError` で非再試行に分類 (ADR 0007 D-2)
- **#48** スライド無しグリッド (`gridTiles`) のタイルも多人数で負値にならないようクランプ (#39 の対)
- **#45** 存在しない招待の再発行を 404 に (500 回避)
- **#49** 発表者状態/スライド入力を検証し不正値を 400 に (合成を壊さない)
- **#50** 公開 /join の表示名を無害化 (制御文字除去・最大長 64)

### レビュー済み・対応不要と判断 (再調査の無駄を避けるメモ)

- `events.ts` … create/update とも検証済み、遷移ガード・live 削除ガードあり。良好
- `caption-hub.ts` … バックログは言語ごと `backlogSize` (既定 20) で有界。リーク無し
- `asset-upload.ts` … filename を `[^\w.-]→_` でサニタイズ済み (S3 キー traversal 不可)
- `main.ts` … SIGTERM/SIGINT → `service.stop()` で S3 フラッシュ。グレースフル停止済み

## 次の改善候補 (deploy 不要で着手可能)

- ✅ **stage-web の操作ボタン連打防止 (済み, App.tsx の `wrap()` で busy 共有)**
- ✅ **stage-web カメラのライブプレビュー (済み, 2026-06-20)**: 入室前に選択中のカメラ映像を確認できる
- stage-web セッション中のデバイス切替 / Audio only フォールバック (未)
- ✅ **admin-web 一覧取得中の skeleton 表示 (済み, 2026-06-20)**
- エンジン ASR 経路 (Transcribe streaming) の一過性エラー再試行 (二重字幕回避を設計)
- 招待レート制限 (発行回数の上限・スロットリング) ※ /invites は admin 認可済みで優先度低
- ~~`reconcile` の stale stack 検知/通知 (L3)~~ ✅ #54 検知+警告ログ / #55 制御層に
  メトリクスフィルタ + アラーム + SNS Topic (通知先 subscribe はデプロイ後)

## デプロイ/外部依存が必要 (ループ対象外)

- R3 Playwright 実装 (要 LiveKit) / R7 (要 AWS+YouTube) / R6 ACM 独自ドメイン (要ドメイン)
- N3 残り: X-Ray 有効化 / SNS Slack subscribe
- O1/O2 (AWS アカウント・OIDC Role)・S1/S2 デプロイ
