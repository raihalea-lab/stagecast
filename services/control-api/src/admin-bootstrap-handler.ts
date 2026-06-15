/**
 * Cognito 管理者初期投入の Custom Resource ハンドラ (R6, ADR 0005 D-4 案 A)。
 *
 * デプロイ時に `-c initialAdmins=a@x.com,b@y.com` で渡した初期管理者を AdminCreateUser で
 * 作成する。初回招待メールは Cognito 標準フローに任せる。**冪等**にし、既存ユーザーは
 * スキップする (スタック更新で再実行されても安全)。Delete では何もしない (ユーザーは残す)。
 *
 * SDK 呼び出しは `CognitoAdminApi` で抽象化し、外部接続なしの単体テストを可能にする
 * (CLAUDE.md テスト方針)。
 */
import {
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import type { CloudFormationCustomResourceEvent } from "aws-lambda";

export interface CognitoAdminApi {
  adminCreateUser(input: { userPoolId: string; email: string }): Promise<void>;
}

export interface BootstrapResult {
  created: string[];
  skipped: string[];
}

/** 初期管理者を冪等に作成する (既存はスキップ)。 */
export async function bootstrapAdmins(
  api: CognitoAdminApi,
  userPoolId: string,
  admins: readonly string[],
): Promise<BootstrapResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const raw of admins) {
    const email = raw.trim();
    if (!email) continue;
    try {
      await api.adminCreateUser({ userPoolId, email });
      created.push(email);
    } catch (err) {
      if (isUserExists(err)) skipped.push(email);
      else throw err;
    }
  }
  return { created, skipped };
}

function isUserExists(err: unknown): boolean {
  if (err instanceof UsernameExistsException) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "UsernameExistsException"
  );
}

/** 実 SDK 実装の CognitoAdminApi。 */
export function awsCognitoAdminApi(
  client: CognitoIdentityProviderClient = new CognitoIdentityProviderClient({}),
): CognitoAdminApi {
  return {
    async adminCreateUser({ userPoolId, email }) {
      await client.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: email,
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
          ],
          DesiredDeliveryMediums: ["EMAIL"],
        }),
      );
    },
  };
}

/** Custom Resource ハンドラ。Create/Update で作成、Delete は no-op。 */
export async function handler(event: CloudFormationCustomResourceEvent): Promise<void> {
  if (event.RequestType === "Delete") return;
  const props = event.ResourceProperties as { UserPoolId?: string; InitialAdmins?: string[] };
  if (!props.UserPoolId) throw new Error("UserPoolId is required");
  await bootstrapAdmins(awsCognitoAdminApi(), props.UserPoolId, props.InitialAdmins ?? []);
}
