# 0022. 投影状態の正を PresentationState に置く

- ステータス: 一部採用 (D-1 / D-2 実装済み。composer 側は未着手 — 下記「実装状況」)
- 日付: 2026-09-16
- 関連: DESIGN.md 5.1 / 5.2 / 5.3 / F-3 / F-4 / ADR 0021 (翻訳参考資料)
- 影響を受ける実装: PR #215, #218 (本 ADR の採用で一部が不要になる)
- 後方互換: **不要**

## コンテキスト

### 今どうなっているか

F-3 (事前アップロードスライド) のデッキ状態は、**デッキを投入したブラウザの `useState` にしか
存在しない**。他のクライアントへは DataChannel の `slide-deck` / `slide-page` を撒いて伝えており、
後から room に入った参加者のために **15 秒ごとに同じ内容を再ブロードキャスト**している。

### 正しい形は既にこのリポジトリにある

`packages/shared/src/presentation.ts` の `PresentationState` は、コメントにこう書いている:

> 1 イベントの発表状態スナップショット。**合成処理はこれを読み**、登壇者映像とスライドの
> レイアウトを決定する (5.1)。

`slideSource: "screen-share" | "uploaded"` と `slidePage` を持ち、control-api には
`getState` / `setSlide` / `setSpeakerVisibility` が実装済みで HTTP ルートも生えている。
永続化は `DynamoPresentationRepository` (制御層の DynamoDB)。

**登壇者の表示状態 (F-4) はこの経路に乗っている** — control-api に永続化してから DataChannel で
通知する形になっている。**デッキだけがこの経路をバイパスしている。** `slideSource` / `slidePage`
は定義されているのに F-3 の実装からは一度も書かれていない。

### バイパスの代償

| 現在ある回避策                                     | 正をサーバーに置けば                    |
| -------------------------------------------------- | --------------------------------------- |
| 15 秒ハートビートによる再ブロードキャスト          | 後から来たクライアントは状態を**読む**  |
| 参加者の入室を検知して即時再配布 (PR #215)         | 同上                                    |
| `isSameDeck` による再配布の重複無視                | 再配布しないので不要                    |
| `SlideDeckMessage.totalPages` (PR #218)            | デッキ資源の属性。メッセージに載せない  |
| `applyRemotePage` で受信側もページを同期 (PR #218) | 正は 1 箇所。クライアントは反映するだけ |
| 署名付き URL の 10 分ごとの再発行と配り直し        | 状態を読むときに都度発行すればよい      |

## 決定

### D-1. 投影状態の正は control-api (`PresentationState`) に置く

```
PresentationState {
  speakers: SpeakerState[]
  slideSource?: "screen-share" | "uploaded"
  slidePage?: number
  deck?: { assetId: string; pageCount: number }   // 追加。実体は ADR 0021 の materials
}
```

デッキ投入時に control-api へ登録し、ページ送りは `setSlide` で永続化する。composer・登壇者は
入室したときに状態を読めば現在の投影が分かる。デッキの実体 (PDF) は ADR 0021 の
`assets/materials/` にあり、ここでは参照だけを持つ。

### D-2. DataChannel は「変わった」という通知だけを運ぶ。状態は運ばない

ページ送りの体感を落とさないため、**DataChannel の通知は永続化を待たずに先に出す**。永続化は
並行して行い、失敗しても通知済みのクライアントには影響しない。後から入るクライアントだけが
一時的に古い状態を読むことになるが、次の操作で収束する。競合したときは `updatedAtMs` が
新しい方を採る (F-4 と同じ扱い)。

### D-3. サーバー側でのラスタライズ (PDF→画像) は行わない

配信映像は Fargate 上の headless Chrome (`livekit/egress:latest`) が composer-template を描画して
作っている。**合成は既にサーバー側で行われている。** PDF→画像の変換 Lambda を足すことは、
同じ PDF を 2 回レンダリングすることを意味する。

画像化で得られるのは初動レイテンシだけだが、実測 (2026-09-16) では支配的なのは composer の
SFU 接続 2〜7 秒で、PDF 取得はその次だった。

統合漢字の字形問題 (日本語の漢字が中国語字形で描かれる) は、フォントが埋め込まれていない PDF に
限られる。検証に使った `docswell-5QR21Y.pdf` は `/FontFile2` を 7 件持ち埋め込み済みだった。
Keynote / PowerPoint / Google スライド / LaTeX はいずれも既定で埋め込む。埋め込み無しの PDF が
常用されるようになった場合も、変換パイプラインではなく **egress コンテナに Noto Sans JP を
入れる**方が小さい (Caddy のカスタムイメージをビルドしている前例がある)。

再検討する条件: (a) 埋め込み無しの PDF が常用される、または (b) 計測で PDF 取得が
レイテンシの支配項になる。

### D-4. 「今映しているページ」の翻訳への反映は本 ADR の後で

ADR 0021 の翻訳は資料全体を文脈にするので投影状態に依存しない。本 ADR で状態が読めるように
なった後、字幕ワーカーが現在ページを強調する拡張を足せる (0021 の Phase 3)。

## 変更範囲

| パッケージ               | 変更                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`        | `PresentationState.deck` を追加。`SlideDeckMessage` から `totalPages` を削除。slide 系メッセージは通知だけを運ぶ形に縮める                                                   |
| `services/control-api`   | デッキ登録 (materials への投入と同時に `setSlide` を呼ぶ)。`getState` の応答でデッキの署名付き URL を都度発行。`setSlide` を招待トークン経路にも公開 (現在は admin 経路のみ) |
| `apps/stage-web`         | 入室時に `getState` を読む。**ハートビートと入室検知による再配布を削除**。`applyRemotePage` を削除                                                                           |
| `apps/composer-template` | 入室時に投影状態を読む経路を追加 (現在は DataChannel を待つだけ)。`isSameDeck` を削除                                                                                        |

## 影響・トレードオフ

**得**

- 上の表の回避策がすべて消える。デッキ投影まわりの正味のコードは減る
- 「サーバー側で投影状態を持っている」と言える状態になる。今はブラウザが言い続けているだけ
- 新しい常時稼働リソースは増えない (DynamoDB は制御層に既存, N-1 に抵触しない)

**損・リスク**

- ページ送りに control-api への書き込みが増える。D-2 で体感は落とさないが、永続化が失敗すると
  後から入るクライアントが古いページを読む
- PR #215 / #218 の一部を捨てる。#218 の「登壇者もめくれる」という価値は残るが、
  `applyRemotePage` と `totalPages` の配布は不要になる
- composer が制御層 API に依存するようになる (現在は LiveKit しか見ていない)

## 実装状況 (2026-09-16)

### 済

- **D-1**: `PresentationState.deck` (`DeckRef`) と `slideUpdatedAtMs` を追加。
  `setSlide` がデッキ参照ごと永続化する。署名付き URL は**保存せず** `getState` が都度発行する
- **D-1**: `POST /stage/presentation/state` (取得) と `POST /stage/presentation/slide` (更新) を
  招待トークン経路に公開。取得は speaker にも許す (自分がめくるのに現在ページが要る)。
  更新は moderator と speaker の両方 (PR #218 の「登壇者もめくれる」を残す)
- **D-1**: ただし**デッキの署名付き URL は moderator にだけ返す**。
  `/stage/materials/download-url` が moderator 限定なので、ここで speaker に渡すと
  その制限を迂回できてしまう。speaker がページを送るのに要るのは `deck.pageCount` と
  `slidePage` だけで、**stage-web は PDF を描画しない** (pdf.js はアップロード時の
  ページ数カウントにしか使っていない)
- **D-2**: `applySlide` が `slideUpdatedAtMs` の古い更新を捨てる。モデレーターと登壇者が
  同時にめくると書き込みが前後しうるので、最後に書いた方ではなく新しい方を残す
- **D-2**: stage-web がデッキ投入・ページ送り・投影解除をサーバーへ書く。DataChannel の通知を
  先に出し、永続化は待たない
- **D-1**: stage-web が**入室時に状態を読んで復元する**。これにより
  「モデレーターが再読み込みするとデッキが手元から消え、投影中なのにページを送れない」
  という既存の不具合が直った

`deck.assetId` / `deck.filename` はそのまま S3 キーに組み立てられるので、区切り文字と `..` を
弾いている (通すと他イベントの資料を指す参照を保存できる)。

### 未

- **composer が状態を読む経路**。したがって **15 秒の配り直しはまだ消せない**
  (下記「確認した結果」)。`isSameDeck` / `applyRemotePage` / `SlideDeckMessage.totalPages` も
  composer が読めるようになるまで残す

## 実装前に確認すること (結果)

1. **composer が制御層 API を叩けるか** → **叩けない (現状)**。composer が受け取るのは
   LiveKit の `token` と `url` だけで (`apps/composer-template/src/main.tsx`)、制御 API の
   URL も資格情報も持たない。`template_base` は egress config の静的な URL なので、
   イベントごとの値を載せるには LiveKit がクエリを追記する挙動に依存することになる。

   **代案: LiveKit の room metadata に載せる方が小さい。** composer は接続時に
   `room.metadata` を受け取り、`RoomMetadataChanged` で更新も拾える。CORS も追加の認証も
   要らず、後から入っても必ず届く。control-api は既に `LIVEKIT_API_KEY` /
   `LIVEKIT_API_SECRET` を持ち `livekit-server-sdk` を読み込んでいる
   (`services/control-api/src/lambda.ts`) ので、`RoomServiceClient.updateRoomMetadata` を
   足すだけで書ける。**次の PR でこちらを採る。**

2. `setSlide` の権限 → **moderator と speaker の両方に許した**。取得は speaker も可。
3. テストは外部接続なしで完結 → 済 (`control-api.test.ts` の in-memory 経路)

## 補足: コードとコメントの乖離 (解消済み)

`services/control-api/src/usecases/presentation.ts` と `packages/shared/src/presentation.ts` の
冒頭コメントは「状態は Valkey に保持され (DESIGN.md 3.2)」と書いていたが、実装は
`DynamoPresentationRepository` (制御層の DynamoDB)。本 ADR の実装で実態に合わせた。
