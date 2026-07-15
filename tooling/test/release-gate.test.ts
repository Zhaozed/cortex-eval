import { describe, expect, it } from "vitest";

import { runReleaseGate, type ReleaseGateDependencies } from "../src/release-gate.ts";

function dependencies(overrides: Partial<ReleaseGateDependencies> = {}): ReleaseGateDependencies {
  return {
    environment: () =>
      Promise.resolve({
        platform: "darwin",
        architecture: "arm64",
        osVersion: "15.7.4",
        cpu: "Apple M4 Pro",
        logicalCores: 12,
        totalMemoryBytes: 51_539_607_552,
        freeMemoryBytes: 10_000_000_000,
        nodeVersion: "24.18.0",
        pnpmVersion: "11.3.0",
        sqliteVersion: "3.53.3",
        promptfooVersion: "0.121.18"
      }),
    audit: () =>
      Promise.resolve({
        command:
          "pnpm audit --prod --audit-level=high --json --registry=https://registry.npmjs.org",
        vulnerabilities: { low: 0, moderate: 0, high: 0, critical: 0 }
      }),
    runtimeDoctor: () =>
      Promise.resolve({
        runtimes: {
          node: { executable: "/node", version: "24.18.0" },
          python: { executable: "/python", version: "3.12.12" },
          ruby: { executable: "/ruby", version: "2.6.10" }
        },
        promptfooVersion: "0.121.18",
        pythonInlineAssertion: {
          exitCode: 0,
          componentResults: 1
        },
        rubyInlineAssertion: { exitCode: 0, componentResults: 1 }
      }),
    rubric: () =>
      Promise.resolve({
        provider: "GOOGLE_GEMINI",
        model: "gemini-2.5-flash",
        assertionType: "llm-rubric",
        promptfooVersion: "0.121.18",
        providerAttempts: 1,
        componentResults: 1,
        exitCode: 0
      }),
    analyzer: () =>
      Promise.resolve({
        provider: "GOOGLE_GEMINI",
        model: "gemini-2.5-flash",
        providerAttempts: 1,
        outputContractVersion: "cortex.analysis-output.v1",
        structuredEvidenceCount: 1
      }),
    ...overrides
  };
}

describe("P10 release gate", () => {
  it("在同一调用链顺序执行审计、Runtime Doctor、Rubric 和 Analyzer 并返回脱敏事实", async () => {
    const calls: string[] = [];
    const base = dependencies();
    const report = await runReleaseGate(
      dependencies({
        environment: async () => {
          calls.push("environment");
          return base.environment();
        },
        audit: async () => {
          calls.push("audit");
          return base.audit();
        },
        runtimeDoctor: async () => {
          calls.push("runtime-doctor");
          return base.runtimeDoctor();
        },
        rubric: async () => {
          calls.push("rubric");
          return base.rubric();
        },
        analyzer: async () => {
          calls.push("analyzer");
          return base.analyzer();
        }
      })
    );

    expect(calls).toEqual(["environment", "audit", "runtime-doctor", "rubric", "analyzer"]);
    expect(report).toMatchObject({
      contractVersion: "cortex.release-gate-report.v1",
      environment: { platform: "darwin", architecture: "arm64" },
      audit: { vulnerabilities: { high: 0, critical: 0 } },
      live: {
        rubric: {
          providerAttempts: 1,
          assertionType: "llm-rubric",
          model: "gemini-2.5-flash"
        },
        analyzer: {
          providerAttempts: 1,
          model: "gemini-2.5-flash",
          outputContractVersion: "cortex.analysis-output.v1",
          structuredEvidenceCount: 1
        }
      }
    });
    expect(JSON.stringify(report)).not.toMatch(/api.?key|secret|bearer/i);
  });

  it("拒绝错误平台、生产高危漏洞、重试或非结构化 Live 结果", async () => {
    const base = dependencies();
    await expect(
      runReleaseGate(
        dependencies({
          environment: async () => ({ ...(await base.environment()), architecture: "x64" })
        })
      )
    ).rejects.toThrow("RELEASE_PLATFORM_UNSUPPORTED");
    await expect(
      runReleaseGate(
        dependencies({
          audit: async () => ({
            ...(await base.audit()),
            vulnerabilities: { low: 0, moderate: 0, high: 1, critical: 0 }
          })
        })
      )
    ).rejects.toThrow("RELEASE_AUDIT_FAILED");
    await expect(
      runReleaseGate(
        dependencies({
          rubric: async () => ({ ...(await base.rubric()), providerAttempts: 2 })
        })
      )
    ).rejects.toThrow("RELEASE_RUBRIC_INVALID");
    await expect(
      runReleaseGate(
        dependencies({
          analyzer: async () => ({
            ...(await base.analyzer()),
            structuredEvidenceCount: 0
          })
        })
      )
    ).rejects.toThrow("RELEASE_ANALYZER_INVALID");
    await expect(
      runReleaseGate(
        dependencies({
          rubric: async () => ({ ...(await base.rubric()), model: "" })
        })
      )
    ).rejects.toThrow("RELEASE_RUBRIC_INVALID");
    await expect(
      runReleaseGate(
        dependencies({
          analyzer: async () => ({ ...(await base.analyzer()), model: " " })
        })
      )
    ).rejects.toThrow("RELEASE_ANALYZER_INVALID");
  });
});
