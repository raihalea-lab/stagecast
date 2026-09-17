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
レスポンスは `{ token, livekitUrl, expiresAt, stageUrl, previewToken }`。`stageUrl` (stage-web の origin) はサーバが `INVITE_BASE_URL` から返す — admin-web は別 CloudFront ディストリビューションなので、クライアント側の origin では開けない。
identity は `admin-{userId}-{uuid}`。userId 固定にすると、管理者がボタンから 2 枚目のタブを開いた瞬間に 1 枚目が切断される (LiveKit は identity 重複で先客を切る)。管理者はマルチウィンドウで開き、カメラ/マイクを publish することもある。ただし identity は URL に焼き込まれるので、**同じ URL をコピー/タブ複製/セッション復元で開いた場合は従来どおり衝突する**。ウィンドウを増やすときはボタンから開き直す。
`previewToken` は配信プレビュー iframe (composer-template) 用の viewer token。親ページと同じ token を iframe に渡すと identity が重複し、LiveKit が先に繋いだ親ページを切断する。

### D-5: 既存招待 URL は不変

Speaker / Moderator の招待 URL (`POST /events/:id/invites`) は変更しない。

### D-6: 却下案

- **admin 操作を admin-web に残す**: 画面切り替え頻度が高い配信運用で 2 画面を行き来する UX が悪く、責務の曖昧化が大きいため却下

## 影響・トレードオフ

- admin-web が大幅に簡素化し、保守コストが低下
- stage-web が複雑化するが、配信中の全操作が 1 画面で完結する
- admin token 経路の追加により backend に新 endpoint が増えるが、既存 API は不変
