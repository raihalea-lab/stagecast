# ADR 0012: カスタム Egress テンプレートによるレイアウト操作・待機画面・プレビュー

- ステータス: **Accepted (R15/R16/R17 全達成 2026-06-24 実機検証成功)** - 要件 1-3 完全達成
- 日付: 2026-06-21 (R15/R16/R17 admin-web) / 2026-06-24 (R17 stage-web)
- 関連: `DESIGN.md` 3.2 / 7.2 / 8、
  [ADR 0006](./0006-livekit-deployment.md) (LiveKit デプロイ全般)、
  [ADR 0010](./0010-livekit-egress-sidecar.md) (Egress sidecar、 本 ADR で `template_base` 設定を追加)、
  [`docs/NEXT_WORK.md`](../NEXT_WORK.md) R15-R18

## コンテキスト

R12 完了 (2026-06-21) で YouTube Live RTMP 送出までの E2E は動くようになった。 ただし
現状の Egress は **LiveKit 公式の内蔵テンプレート** (`http://localhost:7980/`、 Egress
プロセス自身が hosting する組み込み React app) を使っており、 以下の制約がある:

| 制約         | 現状                                                                        | 望ましい状態                                                                     |
| ------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| レイアウト   | grid 固定 (Egress preset)                                                   | grid / speaker-spotlight / picture-in-picture / 画面共有メイン から admin が切替 |
| 待機画面     | speaker が誰もいないと黒画面                                                | BGM + ロゴ + 次回開催情報 などのフォールバック表示                               |
| プレビュー   | 配信中の映像を確認する手段なし (YouTube Studio の遅延 10-30 秒経由しかない) | admin-web / stage-web で低遅延 (sub-second) のプレビュー画面                     |
| カスタマイズ | テロップ・スポンサーロゴ・字幕オーバーレイなど追加不能                      | 自由に React コンポーネントで合成                                                |

ユーザー要件:

1. **登壇者・管理者・スピーカー自身が現在の画面を確認できる画面** (要件 1: プレビュー)
2. **管理者がレイアウトを調整できる画面** (要件 2: layout 操作)
3. **誰も投影してなくても何かしらの配信が続いているようにする** (要件 3: 待機画面)

これらは独立した機能ではなく、 すべて **「Egress が描画している HTML/React アプリ」**
を自前で持つことから派生する。 本 ADR で「カスタム Egress テンプレート」の導入を決定し、
段階的に実装する全体方針を定める。

### 既存技術の把握

- LiveKit Egress は `template_base` config で任意の HTML URL を指定でき、 Chrome ヘッドレスが
  そこを開いて room の participant track を描画する (LiveKit Egress `pkg/config/service.go`)。
  渡される URL: `{template_base}?layout={layout}&token={JWT}&url={ws_url}`
- カスタムテンプレートは LiveKit Client SDK (livekit-client) を使い、 token / url を URL
  パラメータから読んで `Room.connect()` する。 公式サンプル:
  https://github.com/livekit/egress-composite
- LiveKit には participant 間で任意 JSON を送れる **data channel** がある
  (`room.localParticipant.publishData(payload, { reliable: true })`)。 admin-web からの
  layout 設定はこれで配る。
- `Room.metadata` でも可だが、 metadata は participant 単位なので room 全体の broadcast には
  data channel の方が素直。
- LiveKit Server は `room.empty_timeout` (デフォルト 300s) で空 room を destroy する。
  Egress 自身が participant として join するため、 Egress 実行中は room が空にならない。
- Egress を停止すると room の参加者がゼロ → 300s 後に room destroy。 これは「イベント終了」
  と一致するので問題ない。

### スコープ

| 含む                                       | 含まない                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| Egress が描画する HTML/React の自作        | 既存の SFU / Valkey / ICE 設定の変更                                      |
| layout 切替 (grid / spotlight / pip 等)    | layout の細かい数値編集 (各 video の x/y/w/h ピクセル指定)                |
| 待機画面 (speaker 0 人 → fallback)         | **365 日 24h の常時配信** (= イベント外も配信維持。 別 ADR で R18 で扱う) |
| admin-web / stage-web の iframe プレビュー | プレビュー用の別 distribution / 認証 (既存 CloudFront を流用)             |
| Egress config の `template_base` 切替      | Egress 自体の cpu/memory 増強 (将来 R19)                                  |

## 選択肢の検討

### カスタムテンプレートのホスティング

| 案                                                                  | 内容                                                     | 評価                                                                   |
| ------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| A. ControlPlane の AssetsBucket (S3) + 既存 CloudFront に path 追加 | `/composer/` path で配信。 admin-web と同じ Distribution | ✅ 採用。 新規リソースなし、 CloudFront キャッシュ流用                 |
| B. 新規 CloudFront Distribution + 新規 S3 bucket                    | 完全分離。 ドメインも分離可能                            | コスト・運用増。 メリット少                                            |
| C. Egress container 内に templates を埋め込み                       | LiveKit 公式同様、 Docker image をカスタム build         | Docker build パイプライン要追加、 Egress 公式 image 更新時に追従が大変 |

→ **採用は A**。 既存の admin-web と同じ CloudFront に `/composer/` path を追加し、
S3 オリジンを共有。 Egress の `template_base` には CloudFront URL を設定する
(例: `https://dXXXXXXXX.cloudfront.net/composer/`)。

### レイアウト操作の通信

| 案                                                   | 内容                                                                               | 評価                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A. LiveKit data channel (publishData / dataReceived) | admin-web が room に participant として join し、 JSON broadcast                   | ✅ 採用。 LiveKit ネイティブ、 低遅延 (sub-second)、 認証は LiveKit token で完結    |
| B. WebSocket via control-api                         | control-api に WS endpoint を追加。 admin-web → control-api → SFU の Egress に転送 | サーバー1 つ余計、 control-api lambda は WS 不向き (代わりに API Gateway WS が必要) |
| C. DynamoDB poll                                     | layout を DynamoDB に保存。 テンプレートが poll                                    | 遅延数秒、 DDB read コスト                                                          |

→ **採用は A**。 admin-web 側に LiveKit Client SDK を組み込む (subscribe-only token で
broadcast 専用 participant として join、 もしくは admin 専用 token で join)。

### 待機画面のトリガー

| 案                                                     | 内容                                                    | 評価                                                               |
| ------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------ |
| A. テンプレート内で `room.numParticipants` を監視      | publishing participant が Egress 1 人のみなら待機モード | ✅ 採用。 テンプレート内完結、 LiveKit Client SDK のイベントで検知 |
| B. control-api が DDB に状態保存 → テンプレートが poll | 状態管理の中心が増える                                  | 複雑、 遅延                                                        |
| C. admin-web から明示的に「待機モード」をトリガー      | manual operation                                        | 自動化したい                                                       |

→ **採用は A**。 テンプレートの React state で「publishing participant 数」を track。
speaker が 1 人もいなければ待機画面、 1 人でも publish したら通常レイアウトに切替。

### プレビュー画面の方式

| 案                                                             | 内容                                                         | 評価                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| A. カスタムテンプレートを iframe で埋め込み                    | admin-web / stage-web の中に `<iframe src="/composer/?...">` | ✅ 採用。 Egress と完全同一の描画、 低遅延           |
| B. admin-web 内で LiveKit Client を直接組み込み (合成は別実装) | admin-web 専用の player を書く                               | レイアウト変更時にプレビューと Egress でズレるリスク |
| C. YouTube Live embed                                          | iframe で YouTube 視聴                                       | 遅延 10-30 秒、 モニタリング不可                     |

→ **採用は A**。 同じテンプレートを iframe で開くだけ。 token は admin-web が
subscriber-only role で別途発行する (publish 権限なし)。

## 決定

### D-1. カスタム Egress テンプレートを React app として `apps/composer-template/` に新規作成

- 技術: React + Vite + livekit-client (既存 stage-web と同等のスタック)
- URL パラメータから `token` / `url` / `layout` を読んで `Room.connect()`
- 全 participant の video/audio track を React コンポーネントで合成して描画
- shadcn/ui や Tailwind は不要 (Egress Chrome 用なので軽量に)
- **重要 (R15-followup-1)**: Room.connect 成功時に `console.log("START_RECORDING")` を発行する。
  LiveKit Egress `pkg/source/web.go` の `startRecordingLog = "START_RECORDING"` 監視で
  GStreamer pipeline を `playing` 状態に遷移させるプロトコル。 発行しないと Egress は
  `awaitStartSignal` で永遠に待機し、 YouTube に何も届かない。 公式テンプレートは
  `framesDecoded > 0` を待つが、 我々は要件 3 (待機画面でも配信継続) のため Room.connect
  成功時点で **無条件に即発行**。 Disconnected 時に `console.log("END_RECORDING")` を発行。
- ファイル構成:
  ```
  apps/composer-template/
    src/
      main.tsx          # URL パラメータ parse + Room.connect
      Composer.tsx      # 全 layout のスイッチハブ
      layouts/
        Grid.tsx        # grid layout
        Spotlight.tsx   # speaker spotlight
        Pip.tsx         # picture-in-picture
      WaitingScreen.tsx # 待機画面 (要件 3)
      hooks/
        useLayoutSettings.ts  # data channel から layout 設定を受信
  ```

### D-2. ホスティング: ControlPlane の AssetsBucket + 既存 admin-web CloudFront に path 追加

- S3: `assets/composer/` プレフィックスにビルド成果物を upload
- CloudFront: 既存の admin-web Distribution に `/composer/*` の cache behavior を追加 (S3 origin)
- ビルド: `vp run --filter @stagecast/composer-template build` で `dist/` 生成 → CDK BucketDeployment
- 認証不要 (Egress / admin-web / stage-web から open でアクセス、 token は URL parameter)

### D-3. Egress config の `template_base` をカスタムテンプレート URL に切替

- `infra/lib/event-media-stack.ts` の `liveKitEgressConfig()` に行追加:
  ```yaml
  template_base: https://dXXXXXXXX.cloudfront.net/composer/
  ```
- ControlPlane の admin-web CloudFront ドメインを CDK Output から取得して env で渡す
- LiveKit Egress は `{template_base}?layout={layout}&token={JWT}&url={ws_url}` を Chrome で開く

### D-4. レイアウト操作: LiveKit data channel で broadcast

- admin-web に LiveKit Client SDK 組込み (新規 dependency: `livekit-client`)
- admin-web が control-api `/admin-token` (新規 endpoint) で admin role token を取得 → room に join
- layout 切替 UI (admin-web の EventDetail 内に section) で操作 → data channel に JSON 送信:
  ```json
  {
    "type": "layout-change",
    "layout": "spotlight",
    "speakerIdentity": "speaker-ae0c..." // spotlight 対象
  }
  ```
- テンプレート側 `useLayoutSettings.ts` が `room.on(RoomEvent.DataReceived, ...)` で受信、 React state 更新
- 設定は ephemeral (room 退出で消える)。 永続化が必要なら DynamoDB 保存 (将来 R16 で検討)

### D-5. 待機画面: テンプレートに `<WaitingScreen />` を組み込み

- テンプレートが `room.numParticipants` と各 participant の `videoTracks.size` を監視
- publishing participant (video track 1 個以上を publish している participant) が 0 人なら `<WaitingScreen />` を表示
- 待機画面の内容:
  - 中央: イベントタイトル + 「まもなく開始します」 / 「準備中」
  - 背景: グラデーション or static image (S3 にアップロード可能、 admin が選択)
  - BGM: HTML `<audio loop>` で静音 (YouTube はミュート配信を拒否するため、 低音量無音 BGM)
- 1 人でも publish 始めたら fade-out (CSS transition 300ms) → 通常 layout
- LiveKit room は Egress 自身が participant として残るので空にならない → empty_timeout 発火せず継続

### D-6. プレビュー画面: admin-web / stage-web に iframe 埋め込み

- admin-web の EventDetail 内に "ライブプレビュー" section 追加 (toggle で表示/非表示)
- stage-web の登壇者ビューにも "現在の配信" として小窓で表示 (右下、 picture-in-picture 風)
- iframe src: `https://.../composer/?token=<subscriber-only-token>&url=<wss>`
- subscriber-only token は control-api で発行 (publish 権限なし、 layout 操作も不可)
- 帯域コスト: 1 視聴者あたり ~1 Mbps (LiveKit から subscriber として受信)

### D-7. 365 日 24h 配信は本 ADR スコープ外 (将来 R18 で別 ADR)

- 要件 3 の「イベント外も配信維持」は別アーキ (常時 ffmpeg loop + S3 mp4 / live-broadcast Lambda 等) で実現
- DESIGN.md N-1 (常時稼働リソースなし) と矛盾するので別途意思決定が必要
- 本 ADR の D-5 は「**イベント中** に publish が一時 0 人になっても待機画面で配信継続」までをカバー

## 影響・トレードオフ

| 観点             | 影響                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cost             | CloudFront 配信費 (composer-template) ~$0.01/月 (admin-web と同等)。 admin-web の iframe 視聴で LiveKit 帯域 ~+1Mbps/視聴者 (subscriber も participant としてカウント) |
| 信頼性           | カスタムテンプレートのバグは即 Egress 黒画面 → ロールバックパスとして `template_base` を空にすればデフォルトテンプレートに戻る                                         |
| 観測性           | テンプレートに Sentry / console.log 仕込みで Chrome の挙動を追える (CloudWatch には自動で出ない、 ECS Exec で `/tmp/chrome.log` 確認、 ADR 0010 D-7 と同様)            |
| Security         | iframe 埋め込み token は subscriber-only に限定。 admin-web の admin token は CanPublishData のみで CanPublish=false                                                   |
| LiveKit サポート | カスタムテンプレートは LiveKit 公式 docs に sample あり、 official サポート範囲内                                                                                      |
| 起動時間         | テンプレートビルドが CI に追加 (Vite build ~30s)、 admin-web deploy に統合される                                                                                       |
| メンテ           | livekit-client SDK の major update 時にテンプレート側も追従要                                                                                                          |

## 受け入れ基準

1. `apps/composer-template/` が ControlPlane deploy で S3 に upload される
2. Egress 起動で `https://.../composer/?layout=grid&token=...&url=...` が Chrome で開かれ、 grid layout で全 participant が描画される
3. admin-web で layout 切替 UI を操作すると、 YouTube Live の映像レイアウトが sub-second で切替わる
4. 全 publishing participant が unpublish or 退室すると、 YouTube Live に待機画面 (タイトル + 「準備中」) が表示される (黒画面にならない)
5. admin-web の "ライブプレビュー" section で配信中の映像が低遅延 (sub-second) で確認できる
6. stage-web の登壇者ビューに自分の映像を含む合成画面が小窓で表示される
7. ロールバック: `template_base` config を削除すると LiveKit 公式テンプレートに戻り、 既存の grid 描画ができる

## 段階分割 (NEXT_WORK.md R15-R18 として登録)

| Stage          | スコープ                                                                                               | PR                                                                                              | 完了基準                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **R15** ✅     | D-1, D-2, D-3, D-5: テンプレート実装 (grid のみ) + S3+CloudFront ホスティング + Egress 接続 + 待機画面 | #122 (基盤) → #123 (START_RECORDING) → #124 (mute/unmute 再 attach) → #125 (画面共有 tile 並列) | **2026-06-21 実機検証成功 ✅**: 受け入れ基準 1, 2, 4 達成 + カメラ/画面共有同時表示                                                  |
| **R16** ✅     | D-4: admin-web からの layout 切替 UI + spotlight / pip / screen-share-main layouts 追加                | #127 (本体) → #128 (Spotlight grid 修正)                                                        | **2026-06-21 実機検証成功 ✅**: 4 layouts 全切替 sub-second で反映                                                                   |
| **R17** ✅     | D-6: admin-web (Phase2) + stage-web (Phase3) の iframe プレビュー埋め込み                              | #130 (admin-web) / #134 (stage-web) / #135 (followup-1 API GW 公開ルート)                       | **2026-06-21 admin-web + 2026-06-24 stage-web 実機検証成功 ✅**: 受け入れ基準 5/6 全達成 + layout 切替が両 iframe に sub-second 反映 |
| **R18** (将来) | 365 日 24h 配信 (D-7 別 ADR で議論)                                                                    | TBD                                                                                             | 別 ADR                                                                                                                               |

### R15 実装中に判明した追加事項 (followup)

- **R15-followup-1 (#123)**: LiveKit Egress プロトコル準拠で `console.log("START_RECORDING")` を Room.connect 成功時に発行する必要あり。 公式テンプレートは framesDecoded > 0 を待つが、 我々は待機画面録画のため Room.connect 直後に無条件発行
- **R15-followup-2 (#124)**: mute/unmute サイクルで track 参照が変わるため、 useEffect dependency に track 参照を含める。 RoomEvent.TrackSubscribed/Unsubscribed の監視追加。 attach 後に `videoRef.current.play()` 明示呼出
- **R15-followup-3 (#125)**: publishers (participant 単位) → tiles (video publication 単位) に変更。 同 participant のカメラ + 画面共有を別 tile として並列表示 (StreamYard 風)

### R16 実装中に判明した追加事項 (followup)

- **R16-followup-1 (#128)**: Spotlight layout の高さ計算を flex column → grid に変更。 flex column での `flex: 0 0 80%` (高さ 80%) と Tile の `height: 100%` が組み合わさると Chrome の一部バージョンで main 高さが 0 になる問題。 `gridTemplateRows: "1fr 200px"` + `minHeight: 0` で確実に展開。 ScreenShareMain は flex row なので無事 (幅 75% / 高さ自動継承)。 将来 R17 のプレビュー埋め込みでも同様の問題が出たら同じく grid 化する

### R17-Phase3 (stage-web プレビュー、 ✅ 2026-06-24 完了)

stage-web の登壇者ビュー右下に「現在の配信」を picture-in-picture 風に表示する機能。

**採用方針**: (A) `POST /preview-token` (body: { inviteToken }) を新規追加 → invite-service.verify で event.id 解決 → 既存 preview-token-service.issue を再利用 (admin-web の `/events/{id}/preview-token` と service 共有)。

**実装** (PR #134):

- control-api `http/app.ts`: 公開エンドポイント (requireAdmin 前) に新規追加
- stage-web `components/PreviewWindow.tsx`: 右下小窓 (240px × 16:9)、 ✕ で閉じる + 再表示ボタン
- runtime config に composerTemplateUrl 追加 + StageWebDeployment の config.json に注入

**R17-Phase3-followup-1 (PR #135)**: API Gateway の `\$default` ルートが JWT authorizer を持つため、 公開ルートリストに `POST /preview-token` を明示登録 (`authorizationType=NONE`) する必要があった。 既存の `POST /invites/verify` / `POST /join` と同じパターン。

2026-06-24 実機検証で stage-web に小窓プレビューが表示されることを確認 → **ADR 0012 D-1〜D-6 全達成 + 要件 1-3 完全達成**。

## ロールバックプラン

- カスタムテンプレートに重大バグ → `template_base` config を Egress yaml から削除して deploy
- ControlPlane stack を 1 つ前の git commit に戻して deploy
- 既存の LiveKit 公式テンプレートが内蔵されているので、 即座に grid 描画に戻る

## 関連 Issue / 参考

- LiveKit Egress カスタムテンプレートのサンプル: https://github.com/livekit/egress-composite
- LiveKit Custom Templates docs: https://docs.livekit.io/home/egress/custom-template/
- ADR 0010 D-7 (Egress LNA / insecure: true) と同じ Chrome LNA 制約を考慮 (template_base が HTTPS なので OK、 wss も TLS なので OK)
