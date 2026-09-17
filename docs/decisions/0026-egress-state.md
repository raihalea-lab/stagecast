# 0026. Egress の状態をサーバに持ち、room metadata で配る

- ステータス: 採用
- 日付: 2026-09-17
- 関連: ADR 0025 (レイアウトの正を PresentationState に置く) / ADR 0022 (投影状態) / ADR 0014 (画面責務) / ADR 0006 D-4 (Egress)
- 後方互換: **不要**

## コンテキスト

「配信開始を押しても、もう 1 枚のウィンドウでステータスが変わらない」という報告から調べたところ、
同期の問題ではなかった。**Egress の開始ボタンはどの画面でも実際には動いていない。**

| 場所                             | 実態                                                                        |
| -------------------------------- | --------------------------------------------------------------------------- |
| stage-web `EgressControl`        | `onStart` / `onStop` が中身空。ローカル state を変えるだけ                  |
| admin-web                        | Egress の UI が無い (ADR 0014 D-2 で stage-web に移管)。client は死にコード |
| control-api `usecases/egress.ts` | `start()` は LiveKit を呼ぶが **`egressId` をどこにも保存しない**           |
| 同上                             | **`stop()` が無い**                                                         |

`egress.ts` の冒頭コメントは「5. `events.media.egressId` を保存して状態を可視化」と書いているが、
`EventMediaInfo` にそのフィールドは無い。**書いてあるだけで実装されていない。**

配る状態が存在しないので、ウィンドウ間で同期しようがなかった。

## 決定

### D-1: Egress の状態は `EventDefinition` に持つ

`EventMediaInfo` に `egress?: { egressId: string; startedAtMs: number }` を足す。
**存在すれば送出中**、無ければ停止中。`start()` が書き、`stop()` が消す。

`PresentationState` ではなく**イベント側**に置く。Egress はインフラのライフサイクルであって
演出状態ではなく、投影状態のリセット (デッキ解除など) とは寿命が違う。

### D-2: 配布は room metadata。`egressActive` を載せる

`RoomPresentationMetadata` に `egressActive?: boolean`。ADR 0025 D-2 と同じ経路なので、
stage-web の全ウィンドウと composer が接続時と `RoomMetadataChanged` で受け取る。新しい配線は要らない。

**`publishRoomMetadata` は自分でイベントを読んで `egressActive` を埋める。** metadata は全文置換なので、
呼び出し側が渡す形にすると、スライドをめくった拍子に egress のフラグが消える。
ADR 0025 で `focusIdentity` をまさにこの形で落としたので、同じ穴を二度開けない。

### D-3: 開始・停止はモデレーターも操作できる

`POST /stage/egress/start` / `POST /stage/egress/stop` を招待トークン経路で開ける (moderator のみ)。
既存の `POST /events/:id/egress/start` (Cognito) は admin-web 用に残す。

モデレーターは既にレイアウトとスライドを握っており、配信の進行そのものを預けている相手なので、
YouTube への送出開始も同じ権限に含める。stage-web の admin は ADR 0025 D-3 の moderator 招待トークンで
入るため、この 1 経路で admin も moderator も通る。

**新しいルートは `packages/shared/public-routes.json` に同じコミットで足す。**
API Gateway の JWT authorizer に弾かれて Lambda に届かない事故を既に 4 回踏んでいる。

### D-4: `stop()` を実装する

`EgressStarter` に `stopRtmpEgress(egressId)` を足す。実体は `lambda.ts` の `EgressClient`
(既に `startRoomCompositeEgress` で使っている) の `stopEgress` を呼ぶだけ。

## 影響・トレードオフ

- 配信中かどうかが**全ウィンドウ・全ロールで見える**ようになる。登壇者にも「ON AIR」を出せる。
- `publishRoomMetadata` がイベントを 1 回読むようになる。metadata の発行はスライド送りと
  レイアウト変更のときだけなので、読み取りコストは無視できる。
- モデレーターが YouTube への送出を開始・停止できる。誤操作の影響は配信の中断で、
  イベントの削除のような不可逆な操作ではない。
- 送出中に Lambda が `egressId` を失う経路 (DynamoDB 書き込み失敗) が残る。その場合は
  LiveKit 側で送出が続き、UI からは停止できない。頻度と影響から、監視の課題として別に扱う。
