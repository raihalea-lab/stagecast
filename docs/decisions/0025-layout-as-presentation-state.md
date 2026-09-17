# 0025. レイアウトの正を PresentationState に置く

- ステータス: 採用 (D-3 実装済み。D-1 / D-2 は後続)
- 日付: 2026-09-17
- 関連: ADR 0022 (投影状態の正を PresentationState に置く) / ADR 0014 (画面責務) / ADR 0020 (stage 制御プロトコル) / DESIGN.md 5.1, 5.2
- 影響を受ける実装: PR #260 (admin の identity ユニーク化)
- 後方互換: **不要**

## コンテキスト

### 今どうなっているか

レイアウト (`grid` / `spotlight` / `pip` / `screen-share-main`) の状態は、**操作したブラウザの
`useState` にしか存在しない**。変更は DataChannel の `layout-change` で撒くだけで、どこにも
永続化されていない。

その結果:

- **stage-web は `layout-change` を受信していない** (`App.tsx` の `onDataReceived` が処理するのは
  mute / visibility / slide / chat のみ)。読むのは composer だけ。
- したがって管理画面を 2 枚開くと、片方でレイアウトを変えても**もう片方の LayoutPicker は
  古い値のまま**になる。そこから操作すると古い認識で上書きする。
- composer (Egress の headless Chrome) が再接続すると、レイアウトは初期値 `grid` に戻る。
  誰も再送していない。

### 正しい形は ADR 0022 が既に作ってある

ADR 0022 は同じ問題 (デッキ状態がブラウザの `useState` にしかない) を解いて、

1. 正を `PresentationState` (DynamoDB) に置く
2. 配布は LiveKit の **room metadata** に載せる — 接続時に必ず届き、`RoomMetadataChanged` で
   更新も拾える。composer は制御 API を叩けないのでこれが要る

という形を作った。**レイアウトだけがこの経路の外に残っている。**

### admin が control-api を叩けない

stage-web の admin は URL の LiveKit JWT だけを持って入ってくる (ADR 0014 D-4)。Cognito JWT も
招待トークンも無いので、`/stage/*` ルートを一切叩けない。`App.tsx` にも
「管理者資格情報で stage ルートを叩けるようにするのが本来の解」と `ponytail:` コメントが
残っている。マルチウィンドウを使いたいのは admin なので、ここを開けないと本 ADR は成立しない。

## 決定

### D-1: レイアウトを `PresentationState` に持たせる

`PresentationState` に `layout` / `focusIdentity` / `layoutUpdatedAtMs` を足す。
更新は control-api の `presentation.setLayout()` 経由で DynamoDB に書く。
競合時は新しい `layoutUpdatedAtMs` を採る (ADR 0022 D-2 と同じ方針)。

### D-2: 配布は room metadata。`layout-change` の DataChannel は通知として残す

`RoomPresentationMetadata` に `layout` / `focusIdentity` を足し、サーバが書き込み後に
`publishRoomMetadata` で貼る。読み手 (composer / stage-web の全ウィンドウ) は接続時と
`RoomMetadataChanged` で受け取る。**接続時に必ず届くのが metadata の値打ち**で、
composer 再接続でレイアウトが `grid` に戻る問題はこれで消える。

`layout-change` の DataChannel は**残す**。ADR 0022 も slide 系メッセージを消さずに
「通知だけを運ぶ形に縮める」形を採った (0022 変更範囲) 。metadata の往復を待たずに即時反映
できるので、体感が良い。同じ操作から出た同じ値なので二重に届いても発散しない。

stage-web も `layout-change` を受信して自分の LayoutPicker に反映する (現在は composer しか
読んでいない)。これがマルチウィンドウのズレの直接の原因。

### D-3: admin には stage-token 発行時に moderator 相当の招待トークンを同梱する

`issueStageToken` が招待トークン (role `moderator`) も発行し、URL に `&inviteToken=` で載せる (`token` は LiveKit JWT なので名前を分ける)。
stage-web の admin はこれを `inviteToken` として既存の `/stage/*` ルートに使う。

`INVITED_ROLES` に `admin` を足す案は採らない。`verified.role !== "moderator"` の分岐が
control-api 全体に散っており、全部に `admin` を足して回ることになる。admin が stage 上で
できることは moderator の上位集合なので、moderator として振る舞わせれば足りる。

副産物として、admin でもプリセット・アセット・資料が使えるようになる (現在はローカル限定)。

## 影響・トレードオフ

- **マルチウィンドウが構造的に解決する。** 何枚開いても同じ metadata を読むのでズレようがない。
  操作ウィンドウを増やすための専用機構 (`autoSubscribe:false` や BroadcastChannel) は要らない。
- **composer 再接続でレイアウトが戻るバグが消える。** 接続時に metadata から復元する。
- **admin の URL に招待トークンが 1 本増える。** LiveKit JWT が既に載っているので露出の種類は
  変わらないが、TTL は stage-token と揃える (6 時間)。
- **ボタンを押すたびに招待トークンのレコードが 1 件増え、消えない。** `InviteTokenRepository` に
  `delete` は無く、イベント削除 (`usecases/events.ts` の `remove`) も META アイテムしか消さない。
  テーブルに TTL も設定していない。署名側の TTL (6 時間) が切れれば検証は通らなくなるので
  害は無いが、INVITE アイテムは残り続ける。招待トークン全体の掃除は別途 (TTL 属性を足すのが筋)。
- レイアウト変更が HTTP 往復になるので、DataChannel 直送より遅くなる (数十 ms → 百 ms 程度)。
  レイアウト切替はスライド送りほど連打しないので許容する。
