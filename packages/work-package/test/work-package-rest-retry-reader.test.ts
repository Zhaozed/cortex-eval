import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OfflineRestCaseResult } from "@cortex-eval/application/src/features/runs/offline-rest-execution-service.ts";
import {
  hashExecutionContext,
  hashRestResult,
  OrderedRestResultSetHasher
} from "../../domain/src/domain-hash-inputs.ts";
import { afterEach, describe, expect, it } from "vitest";

import {
  openWorkPackageExecutionSession,
  type WorkPackageExecutionContextHashInput
} from "../src/work-package-execution-session.ts";
import { type WorkPackageRestSemanticHashing } from "../src/work-package-rest-retry-reader.ts";
import { WorkPackageRestArtifactWriter } from "../src/work-package-rest-artifact-writer.ts";
import { materializeWorkPackageFixture } from "../test-support/work-package-fixture.ts";

const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const HASH = "a".repeat(64);
const roots: string[] = [];

const contextHasher = {
  hash: (input: WorkPackageExecutionContextHashInput): string =>
    hashExecutionContext({
      contractVersion: input.contractVersion,
      packageId: input.packageId,
      manifestHash: input.manifestHash,
      runExecutionLimits: input.runExecutionLimits,
      analysisExecutionLimits: input.analysisExecutionLimits
    })
};

const semanticHashing: WorkPackageRestSemanticHashing = {
  hashResult: (value): string =>
    hashRestResult({
      contractVersion: "cortex.rest-result.v1",
      caseKey: value.caseKey,
      caseDefinitionHash: value.caseDefinitionHash,
      result:
        value.status === "SUCCEEDED"
          ? {
              status: value.status,
              httpStatus: value.httpStatus,
              providerOutput: value.providerOutput
            }
          : {
              status: value.status,
              httpStatus: value.httpStatus,
              errorType: value.errorType
            }
    }),
  createResultSetHasher: (): OrderedRestResultSetHasher => new OrderedRestResultSetHasher()
};

async function packageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cortex-rest-retry-reader-"));
  roots.push(root);
  await materializeWorkPackageFixture(root, { baseDefinitionHash: HASH });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P7 Work Package REST retry reader", () => {
  it("preflights the source Result Set and exposes a success with new Execution provenance", async () => {
    const root = await packageRoot();
    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: {
        pid: process.pid,
        processStartedAt: "Tue Jul 14 15:00:00 2026",
        executionId: EXECUTION_ID,
        acquiredAt: "2026-07-14T07:00:00.000Z"
      },
      contextHasher,
      nonce: (() => {
        let value = 0;
        return (): string => `retry_reader_nonce_${String(++value).padStart(2, "0")}`;
      })()
    });
    try {
      await session.createExecution({
        executionId: EXECUTION_ID,
        createdAt: "2026-07-14T07:00:00.000Z",
        rerun: { mode: "NEW" }
      });
      await session.startStage(EXECUTION_ID, "REST", "2026-07-14T07:00:00.000Z");
      const result: OfflineRestCaseResult = {
        caseKey: "case-1",
        ordinal: 0,
        caseDefinitionHash: HASH,
        status: "SUCCEEDED",
        httpStatus: 200,
        providerOutput: {
          ok: true,
          taskName: "reply",
          resolvedConfig: {},
          parsedOutput: { text: "hello" }
        },
        errorType: null,
        errorMessage: null,
        durationMs: 10,
        completedAt: "2026-07-14T07:01:00.000Z",
        resultHash: "",
        provenance: null
      };
      const resultHash = semanticHashing.hashResult(result);
      const cleanResult = { ...result, resultHash };
      const resultSetHasher = semanticHashing.createResultSetHasher();
      resultSetHasher.add({ caseKey: "case-1", ordinal: 0, resultHash });
      const writer = await WorkPackageRestArtifactWriter.create(session, EXECUTION_ID);
      await writer.append(cleanResult);
      const artifact = await writer.commit("2026-07-14T07:01:00.000Z", resultSetHasher.finish());
      await session.completeStage(EXECUTION_ID, "REST", "2026-07-14T07:01:00.000Z", [artifact]);

      const reusable = await session.prepareRestRetryResults(
        EXECUTION_ID,
        semanticHashing,
        new AbortController().signal
      );
      const values: OfflineRestCaseResult[] = [];
      for await (const value of reusable) values.push(value);
      expect(values).toHaveLength(1);
      expect(values[0]).toMatchObject({
        status: "SUCCEEDED",
        resultHash,
        provenance: {
          sourceKind: "EXECUTION",
          sourceId: EXECUTION_ID,
          sourceResultHash: resultHash
        }
      });
    } finally {
      await session.close();
    }
  });
});
