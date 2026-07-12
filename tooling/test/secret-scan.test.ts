import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { scanJsonForSecrets } from "../src/secret-scan.ts";

describe("Secret 扫描", () => {
  it("忽略 Token Usage 与明确脱敏占位符", () => {
    expect(
      scanJsonForSecrets("fixture.json", {
        metrics: { tokenUsage: { total: 4 } },
        provider: { apiKey: "[REDACTED]" }
      })
    ).toEqual([]);
  });

  it("遍历数组、忽略非对象并报告短凭据", () => {
    expect(scanJsonForSecrets("fixture.json", [null, "text", { token: "ordinary" }])).toEqual([
      { file: "fixture.json", path: "[2].token", rule: "CREDENTIAL_VALUE" }
    ]);
    expect(
      scanJsonForSecrets("fixture.json", [{ authorization: "Bearer abcdefghijklmnop" }])
    ).toEqual([{ file: "fixture.json", path: "[0].authorization", rule: "CREDENTIAL_VALUE" }]);
  });

  it("覆盖普通密码、Basic Authorization、AWS Key 和通用 Token", () => {
    const findings = scanJsonForSecrets("fixture.json", {
      password: "correct-horse-battery-staple",
      authorization: "Basic dXNlcjpwYXNz",
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      token: "ordinary-token-value"
    });
    expect(findings.map((finding) => finding.path)).toEqual([
      "password",
      "authorization",
      "accessKey",
      "token"
    ]);
  });

  it("敏感字段不因凭据较短而漏报", () => {
    const findings = scanJsonForSecrets("fixture.json", {
      password: "hunter2!",
      apiKey: "secret123",
      token: "abcd1234"
    });
    expect(findings.map((finding) => finding.path)).toEqual(["password", "apiKey", "token"]);
  });

  it("只返回脱敏路径和规则，不返回秘密值", () => {
    const findings = scanJsonForSecrets("fixture.json", {
      config: { apiKey: "AIza-example-credential-value" }
    });
    expect(findings).toEqual([
      {
        file: "fixture.json",
        path: "config.apiKey",
        rule: "CREDENTIAL_VALUE"
      }
    ]);
    expect(JSON.stringify(findings)).not.toContain("example-credential-value");
  });

  it("拟提交的真实 REST 与 Eval Fixture 不含凭据值", async () => {
    const files = [
      "test_suite/current/run_result/loona_promptfoo_tests.json",
      "test_suite/current/eval_result/result.json"
    ];
    const findings = [];
    for (const file of files) {
      const value = JSON.parse(await readFile(file, "utf8")) as unknown;
      findings.push(...scanJsonForSecrets(file, value));
    }
    expect(findings).toEqual([]);
  });
});
