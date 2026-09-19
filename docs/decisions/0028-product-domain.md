# 0028. 公開ホスト名を製品サブドメインに揃える

- ステータス: 採用
- 日付: 2026-09-19
- 関連: ADR 0016 D-1/D-3/D-6 (Caddy TLS・Route53) / ADR 0001 D-10 (公開ルート) / DESIGN.md 3.1
- 後方互換: **不要** (本稼働前)

## コンテキスト

ドメインが層ごとにバラバラだった。

| 層                                      | ホスト名                          | 証明書          |
| --------------------------------------- | --------------------------------- | --------------- |
| メディア (SFU)                          | `event-xxx.media.aws.example.com` | Let's Encrypt   |
| Web 4 本 (admin/stage/composer/request) | `dXXXXXXXX.cloudfront.net` 等     | CloudFront 既定 |

Web 側は CloudFront が払い出す名前をそのまま使っていた。結果として:

- **利用者に見せる URL がランダム文字列**になる。招待リンク (`INVITE_BASE_URL`) も
  `https://dXXXXXXXX.cloudfront.net/join` という形で配られる。
- CloudFront の払い出し名は**スタックを作り直すと変わる**。Cognito のコールバック URL・
  CORS 許可オリジン・`config.json` の 4 本の URL が全部それに追随する必要がある。
- コード上、`distribution.domainName` の参照が **17 箇所**に散っている。ここに
  カスタムドメインを後付けすると、必ずどこかが取り残される。

## 決定

### D-1: 製品サブドメイン `stagecast.<zone>` の下に全部を置く

```
admin.stagecast.aws.example.com
stage.stagecast.aws.example.com
composer.stagecast.aws.example.com
request.stagecast.aws.example.com
media.stagecast.aws.example.com        (per-event: event-xxxx.media.stagecast.…)
```

`admin.<zone>` のようにゾーン直下へ並べる案は採らない。ゾーン (`aws.example.com`) は
用途別の階層で、他の用途も同居しうる。**製品名で 1 段区切ると、ワイルドカード証明書 1 枚が
その名前空間にだけ効く**ようになり、他の用途を巻き込まない。

`stagecast.<zone>` 用のホストゾーンは作らない。既存ゾーンにレコードを置けば足りる。

### D-2: Web の証明書は us-east-1 のワイルドカード ACM 1 枚

CloudFront は us-east-1 の証明書しか受け付けない。制御層スタックは ap-northeast-1 なので、
us-east-1 に証明書専用スタックを分け、`crossRegionReferences` で ARN を渡す。
非推奨の `DnsValidatedCertificate` は使わない。

`*.stagecast.<zone>` のワイルドカードにする。アプリが増えても証明書を触らずに済む。

### D-3: 公開オリジンを決める場所を 1 つにする

`webOrigin("admin" | "stage" | "composer" | "request")` を 1 つ用意し、17 箇所すべてを
そこ経由にする。ホストゾーン未設定の環境では CloudFront の払い出し名を返す
(= 自前ドメインを持たないアカウントでもデプロイできる。`mediaHostedZoneName` と同じ条件分岐)。

**これが本 ADR の本体。** ホスト名を変えること自体より、「オリジンを決める場所が 1 つである」
状態にすることに価値がある。今回の 17 箇所は、次に何かを変えるときも同じだけ散らばる。

### D-4: メディア層も同時に移す

`media.<zone>` → `media.stagecast.<zone>`。per-event の名前も追随する。

**ただし新しい名前の証明書を Let's Encrypt から取り直すことになる。** その経路は
NEXT_WORK O0 (ACME アカウントのメールが未設定で更新に失敗し続けている) で壊れているので、
**本 ADR の実装と同じ PR で `acmeEmail` を設定する**。片方だけ入れると、旧名の証明書
(残り数日) を捨てて新名の証明書が取れない状態になる。

### D-5: 旧 CloudFront ドメインは残さない

本稼働前なので後方互換は不要 (2026-09-19 に確認)。Cognito のコールバック・CORS 許可
オリジンから旧名を外し、新ホスト名だけにする。

### D-6: 設定は環境変数でも渡せるようにする

`infra/user-config.ts` は `.gitignore` にあり **CI には存在しない**。CI から `cdk deploy` すると
`mediaHostedZoneName` が undefined になり、CloudFront の Aliases と Route53 レコードが消え、
Cognito のコールバックが払い出しドメインに戻る = **管理画面にログインできなくなる**。

`STAGECAST_MEDIA_HOSTED_ZONE_NAME` / `STAGECAST_ACME_EMAIL` で上書きできるようにし、
GitHub Actions からは repository vars で渡す。

## 影響・トレードオフ

- 利用者に見せる URL が読める名前になる。招待リンクも `https://stage.stagecast.…/join`。
- CloudFront を作り直しても公開 URL が変わらなくなる。
- **デプロイ直後は DNS 反映と ACM 検証を待つ時間がある。** その間 admin-web に入れない。
  本稼働前なので許容するが、以後は変更のたびに同じ待ちが発生する。
- ACM は無料、Route53 のクエリ課金は無視できる。常時稼働リソースは増えない (N-1)。
- メディアの証明書は取り直しになる。O0 が直っていることが前提 (D-4)。
- **us-east-1 の `cdk bootstrap` が必須になる** (証明書スタックの置き場所)。未 bootstrap だと
  `cdk deploy StagecastControlPlane` が上流スタックを解決できず失敗する。
- リポジトリ vars (`STAGECAST_MEDIA_HOSTED_ZONE_NAME`) を設定するまで、CI デプロイは
  自前ドメイン無しの構成になる (D-6)。
