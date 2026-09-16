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
}
