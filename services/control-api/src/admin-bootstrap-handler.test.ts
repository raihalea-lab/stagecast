import { describe, expect, it } from "vitest";
import { bootstrapAdmins, handler, type CognitoAdminApi } from "./admin-bootstrap-handler.js";

class FakeCognito implements CognitoAdminApi {
  readonly created: string[] = [];
  constructor(private readonly existing: Set<string> = new Set()) {}
  async adminCreateUser({ email }: { userPoolId: string; email: string }): Promise<void> {
    if (this.existing.has(email)) {
      const err = new Error("exists") as Error & { name: string };
      err.name = "UsernameExistsException";
      throw err;
    }
    this.created.push(email);
  }
}

describe("bootstrapAdmins (R6, ADR 0005 D-4)", () => {
  it("初期管理者を作成し空文字はスキップする", async () => {
    const cognito = new FakeCognito();
    const res = await bootstrapAdmins(cognito, "pool-1", ["a@x.com", "  ", "b@y.com"]);
    expect(res.created).toEqual(["a@x.com", "b@y.com"]);
    expect(cognito.created).toEqual(["a@x.com", "b@y.com"]);
  });

  it("既存ユーザー (UsernameExistsException) は冪等にスキップする", async () => {
    const cognito = new FakeCognito(new Set(["a@x.com"]));
    const res = await bootstrapAdmins(cognito, "pool-1", ["a@x.com", "b@y.com"]);
    expect(res.created).toEqual(["b@y.com"]);
    expect(res.skipped).toEqual(["a@x.com"]);
  });

  it("想定外エラーは再 throw する", async () => {
    const cognito: CognitoAdminApi = {
      async adminCreateUser() {
        throw new Error("AccessDenied");
      },
    };
    await expect(bootstrapAdmins(cognito, "pool-1", ["a@x.com"])).rejects.toThrow("AccessDenied");
  });
});

describe("admin-bootstrap handler", () => {
  it("Delete では何もしない", async () => {
    await expect(
      handler({
        RequestType: "Delete",
        ResourceProperties: { UserPoolId: "pool-1", InitialAdmins: ["a@x.com"] },
      } as never),
    ).resolves.toBeUndefined();
  });

  it("UserPoolId が無ければ throw する", async () => {
    await expect(
      handler({ RequestType: "Create", ResourceProperties: {} } as never),
    ).rejects.toThrow("UserPoolId is required");
  });
});
