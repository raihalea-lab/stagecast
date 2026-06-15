# ADR 0007: 字幕パイプラインの呼び出しレジリエンス (リトライ・タイムアウト・best-effort 配信)

- ステータス: Accepted
- 日付: 2026-06-15
- 関連: `DESIGN.md` 6 章 / N-2、[ADR 0002](./0002-caption-bus.md)（字幕バス・At-least-once）、
  [ADR 0003](./0003-failover.md)（D-4 字幕ワーカー再起動・Sink 冪等）、
  [`docs/NEXT_WORK.md`](../NEXT_WORK.md)（D8 レジリエンス、継続改善ループ第 2 弾 #43/#44）

## コンテキスト

ADR 0003 は **プロセス/タスク障害からの再起動復旧** をインフラ層で扱う。一方、配信中に
発生する **個々の外部呼び出しの一過性失敗・無応答 (ハング)** は別の問題で、これまで方針が
明文化されていなかった。字幕パイプラインは以下の外部呼び出しを持つ:

- エンジンの翻訳 (`Translator.translate` / `LlmAdapter.translate`) … Amazon Translate / Bedrock
- Sink 配信 (`CaptionSink.deliver`) … YouTube ingest の HTTP POST / 独自 API の WebSocket 送出

これらは N-2 (字幕遅延 3 秒目標) を満たしつつ、**1 つの失敗で配信全体を止めない** ことが求められる。
特に `CaptionPipeline.drain()` は配信完了を待ち合わせ、`pushAudio` がそれを待つため、
**固まった呼び出し 1 つが音声取り込み全体を無期限に停止させる** 構造的リスクがあった
(`withRetry` は「無応答」を失敗として観測できない)。

## 決定

### D-1. 字幕は best-effort で配信し、失敗で配信を止めない (N-2)

翻訳・Sink 配信が全リトライ後も失敗した場合、その字幕 (またはその言語) を **諦めて先へ進む**。
ソース言語字幕・他言語・他 Sink・後続の音声処理は継続する。字幕は補助情報であり、欠落より
**遅延・停止のほうが視聴体験を損なう** という N-2 の優先順位に従う。確定字幕の S3 保存
(損失ゼロ要件) はこの best-effort 配信とは別経路で担保する (ADR 0003 D-4)。

### D-2. 一過性失敗は `withRetry` で指数バックオフ再試行する

`@stagecast/shared` の `withRetry` (既定 3 回 / base 50ms / factor 2 / max 2s) で、
スロットリング・瞬断などの一過性失敗を吸収する。`sleep` を注入できるため単体テストは
実時間を待たない。`createStack` のような **非冪等** な操作は対象外 (ADR 0003 D-5 の冪等原則と整合)。

### D-3. 各呼び出しに `withTimeout` を掛け、ハングを失敗に変換する

`@stagecast/shared` の `withTimeout` で各呼び出しに上限時間を設け、超過時は `TimeoutError` を
投げる。これにより無応答が `withRetry` の再試行対象になり、最終的に D-1 の best-effort スキップへ
落ちる。`drain()`/`pushAudio` が固まった呼び出しに引きずられないことを保証する。タイマーは
注入可能でテストは実時間を待たない。タイムアウト後に元処理が遅れて失敗しても unhandled
rejection にしない。

既定タイムアウト (調整可能・0 以下で無効):

| 経路                   | 既定     | 根拠                                                  |
| ---------------------- | -------- | ----------------------------------------------------- |
| Sink 配信 (1 回)       | 10,000ms | YouTube ingest / WebSocket の現実的上限。retry と併用 |
| 翻訳 (transcribe 経路) | 8,000ms  | 低遅延経路。N-2 (3s) に対し再試行込みの余裕           |
| 翻訳 (LLM 経路)        | 20,000ms | 品質重視で本来遅い。打ち切りは異常系のみを狙う        |

### D-4. 失敗・再試行をメトリクス化する (T9, ADR 0003 監視)

best-effort で握る代わりに、握った事実を必ず可観測にする。`CaptionMetricsCollector` が
EMF (stdout) で送出する:

- `SinkDeliveryRetries` (dim: Sink) … 一過性失敗の傾向
- `SinkDeliveryErrors` (dim: Sink) … 全リトライ失敗 (配信断念)
- `TranslateErrors` (dim: Language) … 翻訳の全リトライ失敗 (言語スキップ)

`EventMediaStack` がこれらに CloudWatch アラーム + ダッシュボードを張る。Sink/翻訳の
継続的失敗を運用が検知できる。collector は本番 (`realProvidersFromEnv`) で必ず注入し、
テスト/フェイク経路では注入しない (計測ノイズを出さない)。

## 影響・トレードオフ

- **利点**: 単一の外部呼び出し失敗・ハングが配信全体・音声取り込みを止めない。リトライで
  一過性失敗を吸収し、タイムアウトで無応答を有限時間で打ち切る。握った失敗は必ず計測される。
- **留意**: タイムアウト超過時、最悪 `(1 + retries) × timeout + backoff` の遅延が 1 字幕に
  乗る (例: Sink で約 40s)。これは N-2 の遅延目標を超えるが、**その字幕を諦める前の上限**で
  あり、配信や後続字幕には波及しない。恒久障害が続く場合はアラーム (D-4) で検知し運用対処する。
- **留意**: At-least-once に伴う重複配信は Sink の冪等性で吸収する (ADR 0003 D-4)。リトライは
  この前提を強める。

## 実装メモ

- `withRetry` … `packages/shared/src/retry.ts`、`withTimeout` / `TimeoutError` …
  `packages/shared/src/timeout.ts`。いずれも node/dom 非依存 (globalThis 越しにタイマー参照)。
- Sink 配信の結線 … `services/caption-pipeline/src/pipeline.ts`
  (`sinkRetry` / `sinkTimeoutMs`)。
- 翻訳の結線 … `engines/transcribe-engine.ts` / `engines/llm-engine.ts`
  (`translateRetry` / `translateTimeoutMs` / `onTranslateError`)。
- メトリクス … `services/caption-pipeline/src/metrics.ts`、runtime 結線は
  `runtime.ts` (`CaptionRuntimeProviders.metrics`) と `bootstrap.ts`。

## 未解決 (将来)

- Sink 配信を `drain()` の待ち合わせから外し、配信遅延を音声取り込みから完全に切り離す
  (現在はテストの決定性のため per-`pushAudio` で drain している)。
- `shouldRetry` による恒久エラー (4xx 等) の早期打ち切りで無駄な再試行を減らす。
