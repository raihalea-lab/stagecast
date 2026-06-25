# ADR 0016: NLB → Caddy サイドカー + desiredCount:0 事前スタック作成

- **ステータス**: 採用
- **日付**: 2026-06-25
- **関連**: ADR 0009 (supersede), ADR 0015, DESIGN.md 7.2

## コンテキスト

ADR 0009 で LiveKit シグナリング (port 7880) の TLS 終端に NLB + ACM 証明書を導入した。
しかし NLB は idle でも ~$16/月のコストが発生し、DESIGN.md 7.2 の「常時稼働リソースを増やさない」方針と矛盾する。
また、イベント起動高速化のため CFn スタックを `scheduled` 時点で事前作成 (desiredCount:0) したいが、
NLB が存在すると idle 課金が発生するため事前作成と相性が悪い。

LiveKit port 7880 はネイティブ TLS 非対応 (公式ドキュメントで明言)。
LiveKit 公式デプロイリポジトリ (`livekit/deploy`) は Caddy リバースプロキシを推奨。

## 決定

### D-1: NLB を廃止し、Caddy サイドカーで TLS 終端する

- `caddy:2-alpine` コンテナを SFU タスク定義にサイドカーとして追加
- port 443 で TLS を終端し、`localhost:7880` にリバースプロキシ
- `essential: true` — Caddy 停止 = シグナリング不可 → タスク全体再起動

### D-2: ACM 証明書から Secrets Manager に移行

- ACM 証明書はエクスポ不可 (private key 取得不可) → Caddy で使えない
- `*.media.example.com` ワイルドカード証明書を Secrets Manager に格納
- cert/key を ECS Secrets として Caddy コンテナに注入

### D-3: Route53 A レコードを reconcile Lambda が動的管理

- NLB Alias レコードの代わりに、Fargate Public IP → Route53 A レコード (TTL=60s)
- reconcile Lambda が UPSERT/DELETE を実行
- スタック破棄時に A レコードもクリーンアップ

### D-4: desiredCount:0 でスタック事前作成

- `scheduled` ステータスで CFn スタック作成 (desiredCount=0, 全リソース無料)
- `warmup` 遷移時に ECS `UpdateService` API で desiredCount 0→1 (CFn Update 不要)
- `liveStatus` GSI: `"pending"` (scheduled), `"live"` (warmup/live)

### D-5: CFn exec role から elasticloadbalancing 権限を削除

- NLB 廃止に伴い不要

## 影響・トレードオフ

| 項目        | Before (ADR 0009)             | After (ADR 0016)                  |
| ----------- | ----------------------------- | --------------------------------- |
| TLS 終端    | NLB + ACM                     | Caddy sidecar + Secrets Manager   |
| idle コスト | ~$16/月                       | $0                                |
| DNS 解決    | NLB Alias (即時)              | A レコード TTL=60s (最大60s 遅延) |
| 事前作成    | 不可 (NLB 課金)               | 可 (desiredCount:0, 全無料)       |
| 証明書管理  | ACM 自動更新                  | 手動 or certbot Lambda            |
| 起動時間    | warmup で CFn Create (~2-3分) | warmup で ECS Scale-up (~30-60s)  |
