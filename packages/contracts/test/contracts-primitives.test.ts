import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { HashSha256Schema, UtcDateTimeSchema, UuidV7Schema } from "../src/contracts-primitives.ts";
import { decodeCaseCursorV1, encodeCaseCursorV1 } from "../src/cursor-contracts.ts";
import { ERROR_CODES } from "../src/error-contracts.ts";

describe("Contracts 基础值", () => {
  it("只接受 UUIDv7、UTC 时间和小写 SHA-256", () => {
    expect(UuidV7Schema.safeParse("018f47a2-4b6c-7def-8abc-0123456789ab").success).toBe(true);
    expect(UuidV7Schema.safeParse("018f47a2-4b6c-6def-8abc-0123456789ab").success).toBe(false);
    expect(UtcDateTimeSchema.safeParse("2026-07-13T01:02:03.456Z").success).toBe(true);
    expect(UtcDateTimeSchema.safeParse("2026-07-13T09:02:03+08:00").success).toBe(false);
    expect(UtcDateTimeSchema.safeParse("2025-02-30T00:00:00Z").success).toBe(false);
    expect(HashSha256Schema.safeParse("a".repeat(64)).success).toBe(true);
    expect(HashSha256Schema.safeParse("A".repeat(64)).success).toBe(false);
  });

  it("Cursor 往返稳定并拒绝未知版本和篡改内容", () => {
    const payload = {
      version: 1 as const,
      ordinal: 42,
      id: "018f47a2-4b6c-7def-8abc-0123456789ab"
    };
    const cursor = encodeCaseCursorV1(payload);
    expect(cursor.startsWith("cur_v1_")).toBe(true);
    expect(decodeCaseCursorV1(cursor)).toEqual(payload);
    expect(() => decodeCaseCursorV1(cursor.replace("cur_v1_", "cur_v2_"))).toThrow(
      "CURSOR_VERSION_UNSUPPORTED"
    );
    expect(() => decodeCaseCursorV1("cur_v1_%%%")).toThrow("CURSOR_INVALID");
  });

  it("每个稳定 Error Code 都有外置中文消息", async () => {
    const messages = JSON.parse(
      await readFile(new URL("../messages/zh-CN.json", import.meta.url), "utf8")
    ) as Record<string, unknown>;
    expect(Object.keys(messages).sort()).toEqual([...ERROR_CODES].sort());
    expect(
      Object.values(messages).every((message) => typeof message === "string" && message !== "")
    ).toBe(true);
    expect(ERROR_CODES).toEqual(
      expect.arrayContaining([
        "ANALYSIS_STATE_CONFLICT",
        "EVALUATOR_BINDING_MISMATCH",
        "EVALUATOR_TIMEOUT",
        "EVALUATOR_CANCELLED",
        "PROVIDER_REQUEST_FAILED"
      ])
    );
  });
});
