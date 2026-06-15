import { describe, expect, it } from "vitest";
import { isRetryableAwsError, tagAwsRetryable } from "./aws-errors.js";

describe("isRetryableAwsError (ADR 0007 D-2)", () => {
  it("SDK が $retryable を付けたエラーは再試行", () => {
    expect(isRetryableAwsError({ name: "ThrottlingException", $retryable: {} })).toBe(true);
  });

  it("5xx / 429 / 408 は再試行", () => {
    expect(isRetryableAwsError({ $metadata: { httpStatusCode: 500 } })).toBe(true);
    expect(isRetryableAwsError({ $metadata: { httpStatusCode: 429 } })).toBe(true);
    expect(isRetryableAwsError({ $metadata: { httpStatusCode: 408 } })).toBe(true);
  });

  it("その他 4xx は恒久 (再試行しない)", () => {
    expect(isRetryableAwsError({ $metadata: { httpStatusCode: 400 } })).toBe(false);
    expect(isRetryableAwsError({ $metadata: { httpStatusCode: 403 } })).toBe(false);
  });

  it("代表的な恒久エラー名は再試行しない", () => {
    expect(isRetryableAwsError({ name: "ValidationException" })).toBe(false);
    expect(isRetryableAwsError({ name: "AccessDeniedException" })).toBe(false);
    expect(isRetryableAwsError({ name: "UnsupportedLanguagePairException" })).toBe(false);
  });

  it("不明な形のエラーは再試行寄り (既定維持)", () => {
    expect(isRetryableAwsError(new Error("network blip"))).toBe(true);
    expect(isRetryableAwsError("boom")).toBe(true);
    expect(isRetryableAwsError(null)).toBe(true);
  });
});

describe("tagAwsRetryable", () => {
  it("オブジェクトに retryable を付与する", () => {
    const err = tagAwsRetryable({ name: "ValidationException" }) as { retryable: boolean };
    expect(err.retryable).toBe(false);
    const ok = tagAwsRetryable({ $metadata: { httpStatusCode: 503 } }) as { retryable: boolean };
    expect(ok.retryable).toBe(true);
  });

  it("非オブジェクトはそのまま返す", () => {
    expect(tagAwsRetryable("x")).toBe("x");
  });
});
