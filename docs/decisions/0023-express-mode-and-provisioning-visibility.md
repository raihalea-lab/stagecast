# ADR 0023: CloudFormation Express モード + 起動進捗の可視化

- **ステータス**: Accepted
- **日付**: 2026-09-15
- **関連**: ADR 0015 (共有 Cluster / warmup), ADR 0016 (desiredCount 事前プロビジョニング), ADR 0017 (Valkey sidecar / CaptionWorker on-demand)

## コンテキスト

配信予定を作成すると reconcile Lambda が `StagecastEventMedia-{eventId}` スタックを
CloudFormation で作成する (DESIGN.md 7.1)。運用上 3 つの課題が出た。

1. **スタック作成が遅い**。標準の CloudFormation は各リソースが「トラフィックを受けられる」
   状態になるまで待ってから次に進む。ECS サービスの安定化待ちが支配的で、
   配信直前にイベントを作ると開始までの待ち時間が読めない。

2. **準備中 → 配信中に切り替えてもタスクが 1 にならない**。
   ADR 0016 D-4 で scheduled は `desiredCount=0` でスタックを作り、live 遷移後に reconcile が
   `ecs:UpdateService` で 1 に引き上げる設計だが、実際には引き上げが起きないケースがあった。
   原因は 2 つ:
   - reconcile が名指しする ECS service 名 (`captionworker` / `captionworker-{eventId}`) に対し、
     CaptionWorker 側は `serviceName` を指定しておらず CloudFormation の自動生成名
     (`StagecastEventMedia-...-CaptionWorkerService...`) になっていた。
     `DescribeServices` は「見つからない」を失敗ではなく `failures` で返すため、
     エラーも出ないまま CaptionWorker が永久に 0 のままだった。
   - 引き上げ対象に ADR 0017 で sidecar 化して消滅した `valkey` サービスが残っていた。
   - さらにスタックが `CREATE_IN_PROGRESS` の間は引き上げ自体を試みておらず、
     作成中に live に切り替えると次の tick (最大 60 秒後) まで何も起きなかった。

3. **進捗が管理画面から見えない**。スタックが出来たのか、ECS タスクが起動し終えたのかが
   CloudFormation コンソールを開かないと分からない。

## 決定

### D-1. EventMediaStack の作成を CloudFormation Express モードにする

- `CreateStack` に `DeploymentConfig: { Mode: "EXPRESS" }` を渡す
  (`CloudFormationMediaStackProvisioner` の `expressMode`)。
- Express はリソースの設定が適用された時点で完了とみなし、安定化を待たない。
  ECS サービスの安定化待ちが消えるのでスタック作成が大幅に短縮される。
- `CFN_EXPRESS_MODE=false` で従来の STANDARD に戻せる (事故時の退避口)。
- **破棄 (`DeleteStack`) には使わない**。削除完了の報告が実際の破棄より先行すると、
  失敗後の作り直し (`destroy → provision`) が「まだ消えていない ECS サービス」と
  名前衝突する。破棄はユーザーの待ち時間に乗らないので速度の利得も小さい。
- Express はロールバックを既定で無効にする。失敗は `CREATE_FAILED` のまま残るが、
  reconcile は `failed` を destroy → 再作成で扱うため (reconcile.ts) 挙動は変わらない。
- **reconcile Lambda は `@aws-sdk/client-cloudformation` だけバンドルする**。他の SDK
  クライアントは従来どおり Lambda ランタイム同梱を使うが、`DeploymentConfig` は
  3.1077.0 以降にしか無く、古い同梱版だとパラメータが黙って落ちて
  「速くならないが成功する」状態になるため、このクライアントだけバージョンを固定する。
- 念のため `DescribeStacks` が返す `DeploymentConfig.Mode` を毎回ログに出し、
  EXPRESS を要求したのに STANDARD で返ってきたら warn を出す (取りこぼしの検知)。

### D-2. スケールアップ対象の ECS サービスを規約名で確定させる

- `EventMediaStack` の CaptionWorker に明示 `serviceName`
  (`captionworker` / 共有 Cluster では `captionworker-{eventId}`) を与え、
  `CaptionWorkerServiceName` を CfnOutput に出す。
- reconcile 側の名前解決を `ecs-services.ts` に集約し、sidecar 化した `valkey` を対象から外す。
- スタックが `CREATE_IN_PROGRESS` でも引き上げを試みる。Express モードでは
  サービスが先に出来上がっているので、多くの場合その tick で 1 に上がる。
  まだ存在しないサービスは `missing` として次の tick に持ち越す。
- 引き上げは「`desiredCount=0` なら一律 1」ではなく**サービスごとの目標値**で行う。
  ADR 0017 D-2 の「字幕不要なイベントで CaptionWorker を起動しない」は意図した 0 なので、
  `captionEnabled=false` のときは CaptionWorker を 0 のまま据え置く。
  ただし `DesiredEvent.captionEnabled` は ADR 0017 で型に足されたきり `toDesiredEvent` が
  埋めておらず (`CaptionSettings` に字幕オフの項目が無い)、**現状は常に有効扱い**になる。
  ここは「一律 1 に上げる」実装で塞いでしまうと後で戻せないので形だけ先に入れてある。
  実際に 0 を選べるようにするのは別タスク (NEXT_WORK D)。
- `failed` / `deleting` なスタックのサービスは引き上げない。同じ tick で既に DeleteStack を
  出しているため、消える直前のサービスに UpdateService を撃つことになる。
- 引き上げはサービス単位で失敗を閉じ込める。1 つの UpdateService 失敗で観測結果ごと
  失うと、管理画面の進捗カードが空になってしまう。
- `DescribeServices` は `status === "ACTIVE"` だけを採用する。破棄直後は同名の
  INACTIVE な残骸が返り、それを「存在する」と扱うと UpdateService が拒否される。

### D-3. 起動進捗を events 行に書き戻し、管理画面に出す

- `EventProvisioningInfo` (phase / stackStatus / services[] / mediaReady / observedAtMs) を
  `EventDefinition.provisioning` に持たせ、reconcile が毎 tick 観測して書き戻す。
- phase は CFN の状態 + ECS の desired/running + LiveKit URL 確定の 3 つから決める:

  | phase      | 意味                                                    |
  | ---------- | ------------------------------------------------------- |
  | `none`     | スタック未作成                                          |
  | `creating` | CloudFormation が作成中                                 |
  | `starting` | スタックは完成、ECS タスク起動 / LiveKit URL 確定待ち   |
  | `ready`    | タスク RUNNING かつ LiveKit URL 確定 (= 配信開始できる) |
  | `failed`   | スタックが FAILED/ROLLBACK (次 tick で作り直し)         |
  | `deleting` | 破棄中                                                  |

  scheduled の事前プロビジョニング (`desiredCount=0`) はタスクが上がらないのが正なので、
  スタック完成をもって `ready` とする。

- 観測値が変わったときだけ書き込む (`observedAtMs` だけの差分は無視) ので、
  DynamoDB の書き込みは 1 イベントあたり数回で収まる (N-1)。比較対象の片方は
  DynamoDB から戻る項目でキー順が保証されないため、フィールドごとに突き合わせる。
- `provisioning` は **DynamoDB の予約語**なので、更新式では `ExpressionAttributeNames`
  経由で参照する (`media` は予約語ではないので既存コードはそのままで動く)。
- admin-web の Setup タブに「配信インフラ」カードを追加。進行中 (`creating`/`starting`/
  `deleting`) は 5 秒、それ以外は 30 秒の間隔で再取得する。`ready` でもポーリングを止めない:
  タスクが落ちれば reconcile は phase を `starting` に戻すので、打ち切ると「準備完了」の
  緑表示のまま実態と乖離する。

## 影響・トレードオフ

| 項目                      | 変更前                   | 変更後                                      |
| ------------------------- | ------------------------ | ------------------------------------------- |
| スタック作成              | ECS 安定化まで待つ       | 設定適用で完了 (Express)                    |
| `CREATE_COMPLETE` の意味  | タスクが動いている       | **動いているとは限らない** → D-3 で別途観測 |
| ロールバック              | 有効                     | Express は既定で無効 (failed → 作り直し)    |
| CaptionWorker の引き上げ  | 起きない (名前不一致)    | 規約名で確実に引き上がる                    |
| 作成中に live 切替        | 最大 60 秒待ち           | 同 tick で引き上げを試行                    |
| reconcile Lambda バンドル | 全 SDK external (~10 KB) | CFN クライアント同梱 (~510 KB)              |
| 管理画面                  | 進捗が見えない           | phase + サービスごとの running/desired 表示 |
| DynamoDB 書き込み         | media 確定時のみ         | + 進捗が変化したときのみ                    |

Express モードは全商用リージョンで追加料金なしで使える。

## 参考

- [Deploy AWS CloudFormation stacks faster with express mode](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cloudformation-express-mode.html)
- [Accelerate your infrastructure deployments by up to 4x with AWS CloudFormation Express mode](https://aws.amazon.com/blogs/aws/accelerate-your-infrastructure-deployments-by-up-to-4x-with-aws-cloudformation-express-mode/)

## 実配信での検証 (2026-09-16, 実 AWS)

イベント `test1` で配信を立てて実測:

| 項目                           | 実測                                                    |
| ------------------------------ | ------------------------------------------------------- |
| スタック作成 (CREATE_COMPLETE) | **89 秒** (07:05:39 → 07:07:08)                         |
| `ready` 到達まで               | **154 秒** (07:05:39 → 07:08:13)                        |
| phase の遷移 (D-3)             | ✅ `none` → `creating` → `ready`                        |
| サービス単位の可視化 (D-3)     | ✅ `sfu: 0/1` / `captionworker: 1/1` が個別に見えた     |
| タスク引き上げ (D-2)           | ✅ CaptionWorker が先に 1/1、SFU を待つ状態が正しく出た |
| スタック破棄                   | ✅ イベント終了後に `DELETE_IN_PROGRESS` へ             |

CaptionWorker がスタック完成前に 1/1 になっており、**D-2 の「CREATE_IN_PROGRESS でも
引き上げる」が効いている**ことが確認できた。stage-web 側もバックオフ再試行で待機し、
`ready` 到達後に入室できた (ADR 0008 D-3)。
