import { describe, expect, it } from "vitest";

import { parseProductionAuditOutput } from "../src/release-gate-production.ts";

describe("P10 production release gate boundaries", () => {
  it("只提取 pnpm 审计的四级计数且不保留 Advisory 正文", () => {
    const result = parseProductionAuditOutput(
      JSON.stringify({
        advisories: { secretAdvisory: { title: "must not persist" } },
        metadata: {
          vulnerabilities: { info: 2, low: 1, moderate: 3, high: 0, critical: 0 }
        }
      })
    );

    expect(result).toEqual({
      command: "pnpm audit --prod --audit-level=high --json --registry=https://registry.npmjs.org",
      vulnerabilities: { low: 1, moderate: 3, high: 0, critical: 0 }
    });
    expect(JSON.stringify(result)).not.toContain("must not persist");
  });

  it("拒绝缺失、负数和非整数审计计数", () => {
    for (const vulnerabilities of [
      { low: 0, moderate: 0, high: 0 },
      { low: -1, moderate: 0, high: 0, critical: 0 },
      { low: 0, moderate: 0.5, high: 0, critical: 0 }
    ]) {
      expect(() =>
        parseProductionAuditOutput(JSON.stringify({ metadata: { vulnerabilities } }))
      ).toThrow("RELEASE_AUDIT_OUTPUT_INVALID");
    }
  });
});
