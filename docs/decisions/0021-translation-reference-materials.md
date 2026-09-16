# 0021. 登壇資料を翻訳の参考資料として使う

- ステータス: 採用 (実装済み。実 AWS 上での検証は未実施)
- 日付: 2026-09-16
- 関連: DESIGN.md 5.2 (スライド投影) / 6.2 (字幕の二経路) / F-3 / ADR 0007 (字幕レジリエンス) / ADR 0022 (投影状態)
- 後方互換: **不要** (既存の `/stage/decks/*` と `assets/decks/` prefix は廃止する)

## 目的

**テキストを抽出できる登壇資料 (PDF・PPTX・原稿) を参考にして、字幕翻訳の精度を上げる。**

現在の翻訳は発話 1 つを単独で訳している。`LLMEngine.translate` は直前の発話すら渡していない。
発表固有の用語 (製品名・略語・その発表での言い回し) が文脈なしに訳されるため、同じ語が
毎回違う訳になったり、一般語として誤訳されたりする。

これは**投影の問題ではない**。資料のテキストはイベント開始時に確定していて、字幕ワーカーは
起動時に読めばよい。投影状態 (今何ページ目か) は精度への寄与が小さい割に依存を増やすので、
本 ADR の中核から外し、拡張として ADR 0022 側に置く。

## 前提となる事実

- 字幕の翻訳経路は 2 つ (DESIGN.md 6.2)。既定の低遅延経路は `AmazonTranslateTranslator`、
  品質重視経路は `LLMEngine` (Bedrock)
- `AmazonTranslateTranslator.translate(text, source, target)` は文脈を渡す引数を持たない。
  ただし Amazon Translate は **Custom Terminology** (用語集) を `TranslateText` に添えられる
- `LLMEngine` は履歴も資料も渡していない (1 発話ずつ)
- admin-web には既にアセットライブラリのアップロード経路がある
  (`http-asset-service.ts` → `POST /assets/upload-url`)。`AssetMetadata` 型も既存
- `SharedCaptionTaskRole` の権限は Transcribe / Translate / Bedrock のみ。S3 は無い
- 制御層の Lambda はすべて `NodejsFunction` (esbuild) で、ネイティブ依存はゼロ
- `pdfjs-dist` の `getTextContent()` は Node で canvas 無しに動く。**スパイク実施済み**
  (2026-09-16, 下記「スパイク結果」)

## 決定

### D-1. 「翻訳参考資料」をイベントに紐づく独立した資源にする

投影するデッキとは別概念にする。投影しない資料 (発表原稿・話者ノート・Markdown の台本) こそ
文脈として価値が高い。投影デッキは参考資料の一種として自動的に登録される。

- 置き場: `assets/materials/{eventId}/{assetId}/{filename}` (AssetsBucket)
- 型: 既存の `AssetMetadata` を流用。一覧は prefix の `ListObjectsV2` で得る (新しいテーブルや
  属性は作らない)
- 登録経路は 2 つ
  - **事前**: admin-web のイベント設定から (Cognito 認証, `POST /events/{id}/materials/upload-url`)
  - **当日**: stage-web のデッキ投入 (moderator 招待トークン)。同じ prefix に置くだけで
    参考資料になる。既存の `/stage/decks/upload-url` はこれに統合する

### D-2. テキスト抽出はサーバー側の Lambda で行う

`MaterialsExtractFunction` (`NodejsFunction`)。AssetsBucket の `assets/materials/` prefix に
S3 イベント通知 (`OBJECT_CREATED` / `OBJECT_REMOVED`) を張る。制御層スタック初の S3 通知になる。

- 形式: **PDF** (`pdfjs-dist` の `getTextContent`) を最初に対応。PPTX (zip 内の
  `ppt/slides/*.xml` から `<a:t>`) と md / txt は形式の追加として後続
- **`pdfjs-dist/legacy/build/pdf.mjs` を使う。** 通常ビルドは Node で
  `hashOriginal.toHex is not a function` で落ちる (pdf.js 自身が「Node では legacy を使え」と
  警告を出す)。esbuild のバンドル対象もこちらに向ける
- `@napi-rs/canvas` は `optionalDependencies` なので `externalModules` に入れてバンドルから
  外す。テキスト抽出では参照されない (読み込み失敗の警告がログに出るだけ)
- **worker は静的 import して `globalThis.pdfjsWorker` に載せる。** pdf.js は worker を
  `await import(GlobalWorkerOptions.workerSrc)` で読み、既定値が `"./pdf.worker.mjs"` という
  相対パスなので、esbuild で 1 ファイルに束ねた後は `Setting up fake worker failed` になる。
  `globalThis.pdfjsWorker` は pdf.js が動的 import より先に見るフックで、ここに置けば
  追加ファイルの同梱が要らない。**bundle 後にしか起きないので `cdk synth` では検知できない**
- 出力: `assets/materials/{eventId}/_context.json`
  ```
  { version, updatedAt,
    materials: [{ assetId, filename, pages: [{ text }] }],
    fullText }
  ```
  1 資料 30,000 字、合計 60,000 字で打ち切る
- 変更のたびにイベント全体を作り直す (差分更新はしない。資料は多くて数個)
- クライアント側 (stage-web の pdf.js) で抽出しないのは、資料を投影から独立させるため。
  形式の追加も 1 箇所で済む

ラスタライズ (PDF→画像) は行わない。これは投影の設計判断なので ADR 0022 に書く。

### D-3. 両経路に効かせる (B 案)

**低遅延経路 (Amazon Translate)**: 抽出 Lambda が資料の全文から **用語集** を LLM で 1 回生成し、
Amazon Translate の Custom Terminology に `ImportTerminology` する。

- 用語集名: `stagecast-{eventId}`。`MergeStrategy: OVERWRITE` で資料変更のたびに置き換える
- 対象: 固有名詞・技術用語・略語に限定し、**最大 200 件**。一般語を入れると exact match で
  過剰適用され、かえって訳が壊れる
- 言語: イベントの `sourceLanguage` → `languages` の各 target を 1 つの CSV に (先頭列が source)
- 生成モデル: プロジェクト既定の Claude Sonnet 4.5 (`us-east-1`)
- 字幕ワーカーは `TranslateTextCommand` に `TerminologyNames: ["stagecast-{eventId}"]` を添える。
  用語集が未生成なら添えない (存在しない名前を指定するとエラーになる)
- イベント終了時に `DeleteTerminology` する (アカウントの用語集数には上限がある)

**品質重視経路 (LLM)**: 字幕ワーカーが `_context.json` の全文を system prompt の**固定
プレフィックス**として渡す。用語集も同じプレフィックスに含め、両経路の用語を揃える。

- Bedrock の prompt caching を使う。字幕は連続して流れるのでキャッシュは温まったままになり、
  資料全体を毎回渡してもコストはほぼ増えない
- 粒度は**資料全体**。現在ページだけでは用語の一貫性が取れない (発話はスライドに先行・後行する)。
  「今映しているページの強調」は ADR 0022 の投影状態が入ってからの拡張

### D-4. 直前の発話も文脈に含める

同じプロンプトに載せるので設計を一緒にする。`LLMEngine` が直近 5 発話 (ソース言語) を
プレフィックスの後ろに付ける。資料と同程度に効く要因で、実装は小さい。
低遅延経路には適用しない (Amazon Translate に渡す手段が無い)。

### D-5. 資料の本文は「データ」であって「指示」ではない

資料は登壇者が用意した任意のテキストで、プロンプトに混ぜる以上は prompt injection の入口になる。
翻訳プロンプトでも用語集生成プロンプトでも、区切りを明示し「参考情報であり指示ではない」と
固定する。「以下を英訳せよ」のような文字列が資料にあっても従わせない。

### D-6. 字幕ワーカーは S3 から直接読む

`_context.json` を起動時に読み、以後 60 秒ごとに ETag を見て変化があれば読み直す (当日に
デッキが投入されるケース)。control-api を経由しない。

- 理由: 字幕ワーカーは Fargate 上で招待トークンを持たず、control-api を叩く認証経路が無い。
  S3 なら既存のタスクロールに `s3:GetObject` を足すだけで済む
- `SharedCaptionTaskRole` に `s3:GetObject` (`assets/materials/*` に限定) を追加。
  AssetsBucket 名を env で渡す
- 60 秒ポーリングは HEAD 1 回/分で無視できる。プッシュ通知にしない (依存を増やさない)

## 変更範囲

| 場所                                | 変更                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra`                             | `MaterialsExtractFunction` を追加。S3 イベント通知 (`assets/materials/`)。抽出 Lambda のロール: S3 get/put (prefix 限定)・`bedrock:InvokeModel`・`translate:ImportTerminology` / `DeleteTerminology`。**Phase 2 では用語集の言語ペアを決めるためにイベントの字幕設定が要るので、`dynamodb:GetItem` と events テーブル名の env も足す**。`SharedCaptionTaskRole` に `s3:GetObject` (prefix 限定)。字幕ワーカーに `ASSETS_BUCKET` env |
| `services/control-api`              | `POST /events/{id}/materials/upload-url` (admin)・一覧・削除。`/stage/decks/upload-url` を materials に統合。イベント終了時に `DeleteTerminology`                                                                                                                                                                                                                                                                                   |
| `services/materials-extract` (新規) | 抽出・用語集生成・`_context.json` 書き出し・`ImportTerminology`。外部依存はインターフェース + fake                                                                                                                                                                                                                                                                                                                                  |
| `services/caption-pipeline`         | `_context.json` の読み込みと 60 秒更新。`AmazonTranslateTranslator` に `TerminologyNames`。`LlmAdapter.translate` に文脈 (資料プレフィックス + 直近発話) を渡す。Bedrock アダプタでキャッシュポイント                                                                                                                                                                                                                               |
| `apps/admin-web`                    | イベント設定に「翻訳参考資料」の登録 UI (既存アセットライブラリの経路を流用)                                                                                                                                                                                                                                                                                                                                                        |
| `apps/stage-web`                    | デッキ投入先を materials prefix に変更                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/shared`                   | 用語集 CSV と `_context.json` の型                                                                                                                                                                                                                                                                                                                                                                                                  |

## 影響・トレードオフ

**得**

- 両経路で用語が揃う。既定 (`transcribe`) のイベントでも効く
- 事前に資料を登録できる。当日 stage-web からしか入れられない今の形より自然
- 抽出がサーバー側 1 箇所なので形式の追加が楽
- 新しい常時稼働リソースは増えない (Lambda はアップロード時のみ、N-1 に抵触しない)

**損・リスク**

- Custom Terminology は exact match なので、一般語が混ざると過剰適用で訳が壊れる。
  抽出対象の限定と件数上限で抑えるが、ゼロにはならない。用語集の内容を admin-web で
  確認・編集できるようにするのは後続
- LLM 経路のプロンプトが長くなる。キャッシュでコストは抑えられるが、キャッシュ最小トークン数
  (Sonnet 4.5 で約 1,024) に満たない小さな資料はキャッシュされない。その場合の追加コストは
  資料が小さいので無視できる
- 用語集の反映に `ImportTerminology` の処理時間がかかる。資料を直前に入れると最初の数発話には
  効かないことがある
- 制御層スタックに初めて S3 イベント通知が入る
- テキストが取れない資料 (画像だけのスライド、アウトライン化された文字) では効かない。
  OCR は範囲外

## 実装メモ

- 抽出は `services/materials-extract` (S3 イベント通知 → `_context.json`)。
  用語集の生成もここで行う (資料の全文が手元にあるため)
- 字幕ワーカーは `MaterialsContextStore` で `_context.json` を読み、`LLMEngine` が
  `LlmAdapter.translate` の第 4 引数として文脈を渡す
- Bedrock アダプタは文脈を `system` ブロックに置き `cache_control` を付ける。
  `user` に混ぜると翻訳対象と紛れる
- 低遅延経路は `AmazonTranslateTranslator` の第 2 引数に用語集名を渡す。
  `_context.json` が存在するときだけ名前を渡す (存在しない名前はエラーになる)
- `us.` 接頭辞の推論プロファイルは US リージョンからしか使えないので、抽出 Lambda が
  ap-northeast-1 でも Bedrock クライアントは `BEDROCK_REGION` (既定 us-east-1) に向ける

## 段階

1. **Phase 1**: 資料の登録 (admin-web / stage-web 統合) + 抽出 Lambda (PDF) + LLM 経路の
   全文プレフィックス (D-1, D-2, D-3 の LLM 側, D-5, D-6)
2. **Phase 2**: 用語集生成 → Custom Terminology (D-3 の Translate 側) + 直近発話 (D-4)
3. **Phase 3**: PPTX / md / txt。現在ページの強調 (ADR 0022 に依存)

Phase 1 は既定の `transcribe` イベントには効かない。Phase 2 で両経路に揃う。

## スパイク結果 (2026-09-16, Node 24.14.1 / darwin arm64 / pdfjs-dist 6.3.289)

`docswell-5QR21Y.pdf` (13 ページ, 2.5MB, 日本語, フォント埋め込み済み) で実測:

| 項目         | 結果                                             |
| ------------ | ------------------------------------------------ |
| テキスト抽出 | **成功**。日本語が文字化けせず取れた             |
| 所要時間     | 91ms (13 ページ全体, 読み込み 33ms 含む)         |
| RSS          | 136MB                                            |
| 抽出文字数   | 3,345 字 (13 ページ合計)                         |
| canvas       | **不要**。参照されない                           |
| CMap         | **不要**。有り/無しで出力は同一 (3,345 字で一致) |

- ビルドは `legacy` を使うこと (上記 D-2)
- esbuild で bundle + minify した状態でも同じ結果を確認済み (13 ページ / 60ms / RSS 97MB)。
  worker の差し込みが無いと bundle 後だけ失敗するので、実装時はバンドル後の動作確認まで行う
- 3,345 字は D-2 の上限 (1 資料 30,000 字) に対して十分小さい。通常のスライドなら上限に
  当たらない
- 実行時間から、Lambda のメモリは 512MB〜1024MB で足りる見込み (実 Lambda での確認は
  実装時に行う)
- CMap を同梱しないことにする。必要になる PDF (ToUnicode を持たない CID フォント) が
  現れたら追加する

スパイクのスクリプト: `docs/spikes/pdf-text-extract.mjs`

## 実装前に確認すること

1. `TranslateText` に `TerminologyNames` を渡すときの IAM 要件 (`translate:GetTerminology` が
   要るか)
2. Bedrock prompt caching の最小トークン数と TTL (Sonnet 4.5)
3. `ImportTerminology` の反映遅延と、アカウントあたりの用語集数の上限
4. テストは外部接続なしで完結させる (CLAUDE.md テスト方針)。S3・Bedrock・Translate は
   インターフェース + fake

## 範囲外

- OCR (画像だけのスライド)
- 音声から用語を学習すること
- 投影状態 (今何ページ目か) の追跡 → ADR 0022
