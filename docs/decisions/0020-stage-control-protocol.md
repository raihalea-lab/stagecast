# ADR 0020: 舞台制御プロトコルと演出機能 (ステージ管理・チャット・バナー・オーバーレイ・強制ミュート・永続プリセット)

- **ステータス**: 採用
- **日付**: 2026-09-08
- **関連**: [ADR 0012 D-4](./0012-custom-egress-template.md) (data channel プロトコルの起源), [ADR 0014](./0014-screen-responsibility.md) (stage-web への操作移管), [ADR 0018](./0018-global-asset-library.md) (アセット参照), DESIGN.md 5.1 / F-4 / F-5

## コンテキスト

ADR 0012 D-4 で「admin-web の LayoutControl が LiveKit data channel で layout JSON を broadcast して composer-template が受信する」という
最小の制御経路を確立した。ADT 0014 で配信中の操作 UI を stage-web へ完全移管したことで、配信スタッフ (admin/moderator) は
stage-web から演出を操作するようになった。

その後の PR #207 (stage-control-features) で、配信運用に必要な次の機能が一括追加された:

- **ステージ管理 (F-4)**: 発表中/待機の登壇者表示の出し入れ (`visibility-change`)
- **強制ミュート**: 特定参加者のマイクを即座にオフ (`force-mute`)
- **バックステージチャット**: 配信スタッフ間の内部通信 (視聴者には見えない)
- **バナー**: 下部/上部のテロップ表示 (`banner-show/hide`)
- **オーバーレイ**: QR コード / 画像 / 動画を画面の四隅に表示 (`overlay-show/hide`)
- **永続プリセット**: 上記の演出 (EffectConfig) をイベント単位で保存・再利用

これらは DESIGN.md 5.1 で「(将来カスタムテンプレートに組み込み予定)」としていた QR/タイトルのオーバーレイを実体化するものであり、
同時に DESIGN.md の機能要件 (F-4 / F-5) を超えてチャット・強制ミュート・永続プリセットまで拡張した。
data channel のメッセージ種類が増えたため、形式を統一したプロトコルとして明文化する必要が生じた。

## 決定

### D-1: 舞台制御メッセージは `StageMessage` (discriminated union) に統一する

`@stagecast/shared` の `layout-protocol.ts` に全メッセージ型を集約し、`encodeStageMessage` / `decodeStageMessage` で
Uint8Array (LiveKit `publishData` の引数型) との相互変換を行う。未知の形式は `decodeStageMessage` が `null` を返し
(data channel には他種別も流れるため防御的に判定)、呼び出し側は無視する。

対象メッセージ: `layout-change` / `mute-request` / `force-mute` / `visibility-change` / `chat` / `banner-show` / `banner-hide` / `overlay-show` / `overlay-hide`。

### D-2: 演出プロトコルの伝搬経路は LiveKit data channel を原則とし、composer-template には postMessage ブリッジを併用する

- admin/moderator の `StageController` は `room.publishData(encodeStageMessage(...))` で broadcast する。
- stage-web の `RoomConnector` は data channel の `onDataReceived` を抽象化し、UI 非依存でテスト可能な `StageController` に集約する。
- **postMessage ブリッジ (Composer.tsx)**: composer-template 自身が同一 room の participant として join するため、
  自身が broadcast した data channel メッセージを自分で受信してしまうエコー問題が生じる (ADR 0012 D-6 のプレビュー iframe でも同型)。
  これを回避するため、composer-template は `window.addEventListener("message", ...)` で親からの postMessage も処理し、
  data channel と postMessage の 2 経路で同じ state を更新する。Identity が同一の場合に data channel 受信を無視するのではなく、
  両方を受けて冪等に上書きする設計 (更新は deterministic なので二重適用しても安全)。

### D-3: 強制ミュートとミュート要請は宛先を限定する (`destinationIdentities`)

`force-mute` / `mute-request` は broadcast すると **全参加者が自分自身をミュートしてしまう** ため、
`publishData(msg, { destinationIdentities: [targetIdentity] })` で宛先 participants を限定する。受信側は
stage-web の `onDataReceived` で `force-mute` を受信したら自動的に `toggleMic(false)` を実行し、通知を表示する。
`mute-request` は自動ミュートせず通知のみ表示し、speaker が任意でミュートする (強制との区別)。

### D-4: バックステージチャットは dedup ID で重複受信を排除し、role を identity prefix から推定する

- 送信側は `id: crypto.randomUUID()` を付与し、受信側 (`stage-web` の `setChatMessages`) は
  `prev.some((m) => m.id === msg.id)` で既存 ID を弾いて重複表示を防ぐ (data channel の再送や postMessage エコー対策)。
- 表示上の sender role は `senderIdentity` の prefix (`admin-` / `moderator-`) から推定する。
- チャットは配信スタッフ間の内部通信であり、視聴者には出力されない (composer-template は `chat` を合成しない)。

### D-5: 演出は `EffectConfig` (discriminated union) でモデル化し、`Preset` として永続化する

- `EffectConfig` は `banner` / `qr` / `image` / `video` の 4 種を union で表現し、各演出のパラメータ
  (`text`, `position`, `autoHideMs`, `assetKey`, `sizePercent` 等) を型安全に持つ。
- 画像・動画は S3 の `assetKey` を参照する (ADR 0018 のグローバルアセットライブラリ)。
- `Preset` は `eventId` / `config` / `label` / `sortOrder` を持つ。`POST /stage/presets` で保存・`POST /stage/presets/list` で一覧・
  `DELETE /stage/presets/:id` で削除する (GET + query は Lambda adapter が rawPath を渡さないため使えないので POST/list に分離)。
- プリセットの一覧・取得は招待トークン (moderator) でも可能、作成・削除は moderator 以上に限定する。

### D-6: `overlay-show` の URL は presign 済み URL ではなく `assetKey`/参照キーで渡す

composer-template が描画する画像・動画の URL は、stage-web が制御層 API から発行した署名付き URL (presigned S3 URL) を
そのまま data channel に載せて渡す。ライブラリ登録済みキー (`assets/library/...`) のみ presign を許可し、
任意キーの presign を禁止する (ADR 0018)。

### D-7: 却下案

- **チャットを DynamoDB に永続化する**: 配信スタッフ間の一時的な内部通信であり、events 履歴として残す要件がないため却下
  (メモリ上のみ。視聴者向け Q&A は将来 F-11 の字幕配信 API と別途検討)。
- **オーバーレイ/バナーを composer-template 側にハードコードする**: 演出は配信中に動的に変わるため data channel で制御する
  (ハードコードだと配信中の切替・非表示ができない)。
- **admin-web に演出 UI を残す**: ADR 0014 D-1/D-2 で配信操作は stage-web に移管済み。admin-web はイベントメタデータ管理に専念する。

## 影響・トレードオフ

| 項目             | 変更前                               | 変更後                                                      |
| ---------------- | ------------------------------------ | ----------------------------------------------------------- |
| 制御プロトコル   | layout のみ (ADR 0012 D-4)           | 9 種の `StageMessage` に統一                                |
| 演出操作の場所   | admin-web (layout 切替のみ)          | stage-web に集約 (ADR 0014 に整合)                          |
| 登壇者の出し入れ | 未実装 (DESIGN.md 5.3 に記述のみ)    | `visibility-change` で実現 (F-4 達成)                       |
| QR/タイトル      | 「将来組み込み予定」 (DESIGN.md 5.1) | overlay/banner で実現 (F-5 達成)                            |
| ミュート制御     | mute-request (任意), ADR 0012 D-8    | force-mute (強制, 宛先限定) を追加                          |
| チャット         | なし                                 | スタッフ間内部通信 (メモリ上・視聴者非公開)                 |
| プリセット       | なし                                 | `EffectConfig` + `Preset` で永続化・再利用                  |
| 複雑性           | 低 (layout のみ)                     | メッセージ種別・状態が増え、デコード/エコー対策の考慮が必要 |

- data channel は全 participant に broadcast されるため、チャット本文や演出データは room 参加者全員に届く
  (視聴者には公開されないが、SFU 参加者は閲覧可能)。秘匿性が必要な通信は本経路を使わない。
- postMessage ブリッジと data channel の 2 経路は状態更新が冪等になるよう設計しているが、
  将来メッセージ種別を増やす際は「受信側で重複排除が必要か」を各メッセージで検討する。
