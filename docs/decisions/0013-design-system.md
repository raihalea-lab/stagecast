# ADR 0013: デザインシステム (shadcn/ui + Tailwind + packages/ui 集中管理)

- ステータス: **Accepted**
- 日付: 2026-06-24
- 関連: `DESIGN.md` 3 章、[ADR 0012](./0012-custom-egress-template.md)、`docs/NEXT_WORK.md` N6

## コンテキスト

stagecast の 3 つの React SPA (admin-web / stage-web / composer-template) は手製 `styles.css` で構成されており、CSS 変数・デザイントークン・コンポーネントライブラリがなく、アプリ間で色・スペーシング・語彙がバラバラだった。N6 タスクとしてデザイン刷新を実施。

## 決定

### D-1: shadcn/ui + Tailwind 採用

shadcn/ui を primitives として使い Tailwind CSS でスタイリングする。headless UI ライブラリ (Radix UI) をベースにした shadcn は、a11y が標準対応でカスタマイズ性が高く、放送機材ライクなデザイン方向に合致する。

### D-2: packages/ui 集中管理

shadcn/ui の copy-paste モデルをアプリ別に行う（3 箇所同期）代わりに、`packages/ui` に 1 度だけ vendor し、各 app は `import { Button } from "@stagecast/ui"` で参照する。pnpm workspace の既存流儀に沿う。

### D-3: Inter / JetBrains Mono の self-host

CDN (Google Fonts) に依存せず `@fontsource-variable/*` で self-host する。Vite が WOFF2 を hash 付きで吐いて CloudFront immutable cache に乗る。CDN 障害で表示が崩れるリスクを排除。

### D-4: Tally / Live Tension Bar / Mono Numerics をシグニチャー採用

- **Tally Light**: 放送機材の赤ランプをUI に再解釈。配信中の tile・状態インジケータが `--tally-500: #DC2626` で発光
- **Live Tension Bar**: 画面最上部の 2px インジケータで配信状態を色と脈動で可視化
- **Mono Numerics**: タイムコード・参加者数・音量 dB 等を等幅表示し計測機器感を演出

### D-5: ダーク優先 + admin のみライト両対応

stage-web / composer-template はダーク固定（放送コックピット + Egress Chrome）。admin-web のみ `[data-theme]` で dark/light/system 切替。

### D-6: 既存 styles.css は段階廃止

D6 で admin-web、D10 で stage-web の旧 styles.css を完全削除。composer-template は独自最小 CSS を D11 で刷新。

### D-7: 却下案

- **劇場メタファー**: 「幕が開く」等の演出は配信プラットフォームの操作速度と合わず却下
- **CDN font**: CDN 障害リスクと offline 環境対応で却下
- **アプリ別 copy-paste**: 3 アプリ間の同期コストが事故の温床で却下

## 影響・トレードオフ

- packages/ui が SPOF になるが、3 アプリの一貫性と保守性が大幅に向上
- Tailwind の学習コストは発生するが、token ベースの設計で逸脱しにくい
- composer-template は packages/ui を full import しない（Egress cold-start 軽量化）
