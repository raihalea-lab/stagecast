export interface UserConfig {
  mediaHostedZoneName?: string;
  initialAdmins?: string;
  budgetMonthlyUsd?: number;
  budgetEmail?: string;
  /**
   * 運用アラームの通知先メールアドレス。
   *
   * **未設定だとアラームは誰にも届かない。** CloudWatch アラームは SNS に publish するだけで、
   * 購読者がいなければそこで消える。「スタックが立たない」(D16) のような、配信を始められない
   * 障害が無言で進行することになる。`budgetEmail` (コスト) とは別枠。
   */
  opsEmail?: string;
  /**
   * Caddy が Let's Encrypt に登録する ACME アカウントの連絡先メールアドレス (ADR 0016 D-6)。
   *
   * **未設定だと証明書の更新に失敗し続ける。** certmagic-s3 の storage から既存アカウントを
   * 探すとき、Caddy は `acme/<ca>/users/` の一覧から拾ったディレクトリ名をメールアドレスとして
   * 扱う。S3 backend では `users` 自身が返ってくることがあり、Let's Encrypt に
   * `invalidContact (unable to parse email address)` で蹴られる (2026-09-18 に実際に発生)。
   * 明示すれば一覧ではなくキー直引きになるので、この経路を踏まない。
   *
   * 未設定時は `opsEmail` にフォールバックする。どちらも無ければ `email` 行を出さない
   * (= 従来の挙動。証明書が切れるまで気づけないので、本番運用では必ず設定すること)。
   */
  acmeEmail?: string;
}
