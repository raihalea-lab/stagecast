# 0027. 「配信できる」の判定にシグナリング応答を含める

- ステータス: 採用
- 日付: 2026-09-18
- 関連: ADR 0023 D-3 (プロビジョニング進捗の可視化) / ADR 0016 D-1 (Caddy TLS サイドカー) / DESIGN.md 7.1
- 後方互換: **不要**

## コンテキスト

`phase: "ready"` の判定はこれだけだった:

```ts
// services/media-orchestrator/src/provisioning.ts
return tasksRunning(input.services) && input.mediaReady ? "ready" : "starting";
```

- `tasksRunning` … ECS の desired と running が一致している
- `mediaReady` … `events.media.livekitUrl` が書き戻されている

ADR 0023 D-3 のコメントは「タスクが RUNNING かつ LiveKit URL が確定済み = 配信開始できる」と
書いているが、**この等号は成り立たない**。

2026-09-17 に実際に起きたこと: SFU タスクが 15:25 に再起動した。ECS は即 RUNNING を返し、
`media.livekitUrl` は前から埋まったままなので、管理画面は「配信インフラ = ready」を出し続けた。
一方でブラウザからは `wss://` が繋がらず、**管理者もモデレーターも誰も入室できなかった**。
SFU 側のログに接続試行は 1 件も残っておらず、「タスクはあるが配信はできない」状態だった。

ECS の RUNNING は**コンテナが起動したこと**しか意味しない。LiveKit の初期化、Caddy の
証明書ロード、Route53 の DNS 反映はその後に起こる。どれか 1 つでも欠けると配信はできない。

## 決定

### D-1: reconcile が毎 tick シグナリングを実際に叩く

reconcile Lambda は VPC 外で動いており外向き通信ができる。毎 tick (60 秒)、
`events.media.livekitUrl` の `wss://` を `https://` に読み替えて GET する。

```
GET https://event-xxxx.media.aws.example.com/   (タイムアウト 3 秒)
```

LiveKit 自身が返す 200 / 401 は「生きている」。接続拒否・TLS 失敗・タイムアウトに加えて、
**5xx も「配信できない」とみなす**。Caddy と LiveKit は同一タスクの sidecar で起動順の保証が無く、
LiveKit がまだ listen していない窓では Caddy が 502 を返す。ここを「応答あり」にすると、
本 ADR が拾いたい「タスクはあるのに誰も入れない」状態をそのまま取り逃がす。

probe を打つのは**タスクが RUNNING になってから**。`resolveLivekitUrl` は CFN Output があれば
タスク 0 本でも URL を返すので、URL の有無だけで打つと正常な起動中に「配信できない」と
誤判定し、赤帯と無駄な書き戻しを毎 tick 出すことになる。

**ブラウザが最初に叩くのと同じ経路・同じ TLS 検証を通る**ことに意味がある。LiveKit の
管理 API を叩く案 (API キーが要る) は採らない。ここで見たいのは「外から到達できるか」で、
それは HTTPS で足りる。

### D-2: `phase: "ready"` の条件にシグナリング応答を加える

`EventProvisioningInfo` に `signalingReady: boolean` と `signalingError?: string` を足す。
`ready` は **タスク RUNNING かつ media 確定かつシグナリング応答あり**のときだけ。
それ以外は `starting` (= まだ配信できない) として表示する。

事前プロビジョニング (`wantTasks: false`, ADR 0016 D-4) は対象外。タスクを動かしていない
状態でシグナリングが応答しないのは正常なので、従来どおりスタック完成をもって `ready` とする。

## 影響・トレードオフ

- **「タスクはあるが配信できない」が管理画面に出る。** これまでは無言で進行していた。
- **証明書の失効も配信不可として見える** (NEXT_WORK O0)。probe は TLS 検証を通るので、
  証明書が切れれば `signalingReady: false` になる。切れてから人が気づくよりずっと早い。
- 検知は最大 60 秒遅れる (tick 間隔)。秒単位の可用性を狙うものではなく、
  「タスクはあるのに入れない」を運用者が**気づける**ようにするのが目的。
- イベント 1 本あたり毎分 1 リクエスト増える。常時稼働リソースは増えない (N-1)。
- probe 自体が落ちても reconcile 全体は止めない。失敗は `signalingError` に載せる。
