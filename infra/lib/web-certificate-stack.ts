/**
 * Web SPA 用の ACM 証明書スタック (ADR 0028 D-2)。
 *
 * **CloudFront は us-east-1 の証明書しか受け付けない。** 制御層スタックは ap-northeast-1 に
 * あるので、証明書だけを us-east-1 に分けて `crossRegionReferences` で ARN を渡す。
 * 非推奨の `DnsValidatedCertificate` は使わない。
 *
 * ワイルドカード (`*.stagecast.<zone>`) にしてあるので、アプリが増えても証明書は触らずに済む。
 * 製品サブドメインで区切ってあるため、ゾーンの他の用途は覆わない (ADR 0028 D-1)。
 */
import { Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";

export interface WebCertificateStackProps extends StackProps {
  /** 運用者が事前に作った親ホストゾーン名 (例: `aws.example.com`)。 */
  hostedZoneName: string;
  /** 証明書を出すドメイン (例: `stagecast.aws.example.com`)。 */
  appDomainName: string;
}

export class WebCertificateStack extends Stack {
  readonly certificateArn: string;

  constructor(scope: Construct, id: string, props: WebCertificateStackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromLookup(this, "AppHostedZone", {
      domainName: props.hostedZoneName,
    });

    const certificate = new acm.Certificate(this, "WebCertificate", {
      domainName: `*.${props.appDomainName}`,
      // apex (`stagecast.<zone>`) 自体は使わないが、後で置くときに証明書を作り直さずに済む。
      subjectAlternativeNames: [props.appDomainName],
      validation: acm.CertificateValidation.fromDns(zone),
    });

    this.certificateArn = certificate.certificateArn;
  }
}
