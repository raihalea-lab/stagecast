# E2E テスト (R3 雛形)

ADR 0005 **R3** (`stage-web → 実 LiveKit 接続疎通`) のための置き場所。
本 PR (`claude/livekit-stage3`) では **雛形のみ**で、実 Playwright 駆動は別 PR
(`claude/stage-web-livekit-e2e`) で実装する。

## 現状

- スキップ済みの意図ファイル: `apps/stage-web/src/livekit-join.e2e.test.ts`
  (`describe.skip`)。CI では skip されるため緑のまま。
- このディレクトリ (`e2e/`) は pnpm workspace 外なので、`vp run -r` の
  build/test/typecheck 対象に **含まれない**。Playwright を導入しても CI の
  `build-test` ジョブには影響しない。

## R3 で実装すること

1. `@playwright/test` を devDependency に追加し、`playwright.config.ts` を本ディレクトリに置く。
2. テスト用に control-api をローカル起動 (or デプロイ済み dev 環境を指す) し、
   招待トークン → `/join` → LiveKit access token を発行する。
3. stage-web を `vp preview` で配信し、Playwright で開く。
4. 実 SFU (EventMediaStack の NLB エンドポイント) に接続し、
   publish/subscribe の往復を検証する。
5. CI には **手動 dispatch + environment ガード**の専用 workflow を追加する
   (ADR 0005 D-6 の `integration.yml` に相乗り)。実 AWS コストが出るため
   push トリガには載せない。

## 検証フロー (完了基準)

| 手順 | 期待                                                      |
| ---- | --------------------------------------------------------- |
| join | 招待 URL から LiveKit token が発行される                  |
| 接続 | stage-web が実 SFU に WebRTC 接続する (UDP 7882 主経路)   |
| 配信 | publish したトラックを別ピアが subscribe できる           |
| 退避 | UDP 不通時に TCP 7881 へ ICE fallback する (ADR 0006 D-2) |
