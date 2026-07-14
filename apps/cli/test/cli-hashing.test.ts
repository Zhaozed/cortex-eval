import { describe, expect, it } from "vitest";

import {
  cliCaseDefinitionHasher,
  cliEvalSemanticHashing,
  cliExecutionContextHasher,
  cliRestSemanticHashing
} from "../src/cli-hashing.ts";

const ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const HASH = "a".repeat(64);

describe("P7 CLI production semantic hashing", () => {
  it("hashes Execution context and clean Case Definitions", () => {
    expect(
      cliExecutionContextHasher.hash({
        contractVersion: "cortex.execution-context.v1",
        packageId: ID,
        manifestHash: HASH,
        runExecutionLimits: {
          contractVersion: "cortex.run-execution-limits.v1",
          restConcurrency: 4,
          evalConcurrency: 2
        },
        analysisExecutionLimits: {
          contractVersion: "cortex.analysis-execution-limits.v1",
          analysisConcurrency: 1
        }
      })
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(
      cliCaseDefinitionHasher.hash({
        contractVersion: "cortex.case-definition.v1",
        caseKey: "case-1",
        definition: {
          caseKey: "case-1",
          description: "hash",
          threshold: 1,
          task: "reply",
          requestBody: { text: "hello" },
          metadata: {
            requestId: "req-1",
            taskId: "task-1",
            businessModule: "fixture",
            scenarioTag: "hash"
          },
          assertions: [{ type: "equals", metric: "exact", weight: 1, value: "hello" }]
        }
      })
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashes both REST success and error facts", () => {
    const common = {
      caseKey: "case-1",
      ordinal: 0,
      caseDefinitionHash: HASH,
      httpStatus: 200,
      durationMs: 1,
      completedAt: "2026-07-14T07:00:00.000Z",
      resultHash: HASH,
      provenance: null
    } as const;
    expect(
      cliRestSemanticHashing.hashResult({
        ...common,
        status: "SUCCEEDED",
        providerOutput: {
          ok: true,
          taskName: "reply",
          resolvedConfig: {},
          parsedOutput: { text: "hello" }
        },
        errorType: null,
        errorMessage: null
      })
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(
      cliRestSemanticHashing.hashResult({
        ...common,
        status: "ERROR",
        providerOutput: null,
        errorType: "NETWORK",
        errorMessage: "network"
      })
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(cliRestSemanticHashing.createResultSetHasher()).toBeDefined();
  });

  it("hashes Eval, Final Case and creates ordered set hashers", () => {
    const evalHash = cliEvalSemanticHashing.hashResult({
      caseKey: "case-1",
      ordinal: 0,
      status: "NOT_EVALUATED",
      promptfooSuccess: null,
      score: null,
      reason: null,
      evaluationError: null,
      assertions: [],
      diffs: [],
      metrics: [{ metric: "exact", status: "NOT_EVALUATED" }],
      latencyMs: null,
      tokenUsage: null,
      cost: null,
      rawEvidence: null,
      evalResultHash: HASH,
      finalCaseResultHash: HASH,
      provenance: null
    });
    expect(evalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      cliEvalSemanticHashing.hashFinalResult({
        caseDefinitionHash: HASH,
        restResultHash: HASH,
        evalResultHash: evalHash
      })
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(cliEvalSemanticHashing.createResultSetHasher(() => "case-1")).toBeDefined();
  });
});
