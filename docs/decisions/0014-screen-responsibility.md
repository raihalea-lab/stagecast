# ADR 0014: 画面責務の再配置 (admin-web → stage-web)

- ステータス: **Accepted**
- 日付: 2026-06-24
- 関連: `DESIGN.md` 4 章、[ADR 0012](./0012-custom-egress-template.md)、[ADR 0013](./0013-design-system.md)

## コンテキスト

配信中操作（LayoutControl / LivePreview / Egress 制御 / ライフサイクル管理）が管理画面 (admin-web) に混在しており、画面の責務境界が曖昧だった。ユーザー要望:

> 管理画面は URL の払い出しなど、イベントそのものを管理するために使い、配信で使うレイアウトなどは管理者及びモデレーターが配信画面から操作できる様にしたい

## 決定

### D-1: admin-web はイベントメタデータ管理に専念

admin-web の責務: イベント CRUD / 招待 URL 発行 / 素材アップロード / LiveKit・YouTube 設定 / 成果物ダウンロード / 「配信画面を開く」リンクの提供。配信中の操作 UI は持たない。

### D-2: 配信中操作は stage-web に完全移管

LayoutControl / LivePreview / Egress 制御 / ライフサイクル管理はすべて stage-web の Admin サブビューに移管。D5 で admin-web から UI 削除、D9 で stage-web に実装。

### D-3: stage-web はロール別サブビュー

token の `role` claim で 3 つのサブビューに分岐:
- **Speaker**: PreviewWindow + ControlBar (メディア制御 + スライド送り)
- **Moderator**: Speaker + ParticipantList + LayoutPicker + ミュート要請
- **Admin**: LivePreview + LifecycleControl + EgressControl + LiveStats + RoleSwitcher + Moderator 同等の操作

### D-4: admin は Cognito JWT → stage-token で stage-web に入る

`POST /admin/events/:id/stage-token` (D7-backend) で admin 用 LiveKit token を発行。OpenStageButton が `?token=<lk>&url=<lk-url>&eventId=<id>` で stage-web を新タブで開き、`StageController.connectAdmin()` で /join をバイパスして直接接続。

### D-5: 既存招待 URL は不変

Speaker / Moderator の招待 URL (`POST /events/:id/invites`) は変更しない。

### D-6: 却下案

- **admin 操作を admin-web に残す**: 画面切り替え頻度が高い配信運用で 2 画面を行き来する UX が悪く、責務の曖昧化が大きいため却下

## 影響・トレードオフ

- admin-web が大幅に簡素化し、保守コストが低下
- stage-web が複雑化するが、配信中の全操作が 1 画面で完結する
- admin token 経路の追加により backend に新 endpoint が増えるが、既存 API は不変
