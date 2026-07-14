import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import {
  hashCaseDefinition,
  hashExecutionContext,
  hashRestResult,
  OrderedRestResultSetHasher
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import {
  openWorkPackageExecutionSession,
  type WorkPackageExecutionContextHashInput
} from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { WorkPackageCaseDefinitionHashInput } from "@cortex-eval/work-package/src/work-package-input-reader.ts";
import { materializeWorkPackageFixture } from "@cortex-eval/work-package/test-support/work-package-fixture.ts";
import { afterEach, describe, expect, it } from "vitest";

import { LocalRestCommandService } from "../src/rest-command-service.ts";

const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
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

async function packageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cortex-rest-command-service-"));
  roots.push(root);
  const definition = {
    caseKey: "case-1",
    description: "fixture",
    threshold: 1,
    task: "reply",
    requestBody: { text: "hello" },
    metadata: {
      requestId: "req-1",
      taskId: "task-1",
      businessModule: "fixture",
      scenarioTag: "fixture"
    },
    assertions: [{ type: "equals", metric: "exact", weight: 1, value: "hello" }]
  } as const;
  await materializeWorkPackageFixture(root, {
    baseDefinitionHash: hashCaseDefinition({
      contractVersion: "cortex.case-definition.v1",
      caseKey: definition.caseKey,
      definition: caseDefinitionJson(definition)
    })
  });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P7 local REST command service", () => {
  it("composes Fetch execution through to one validated completed REST Artifact", async () => {
    const root = await packageRoot();
    let nonce = 0;
    const service = new LocalRestCommandService({
      contextHasher,
      caseHasher: {
        hash: (input: WorkPackageCaseDefinitionHashInput): string =>
          hashCaseDefinition({
            contractVersion: input.contractVersion,
            caseKey: input.caseKey,
            definition: caseDefinitionJson(input.definition)
          })
      },
      restHashing: {
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
      },
      nextId: (): string => EXECUTION_ID,
      nonce: (): string => `rest_command_nonce_${String(++nonce).padStart(2, "0")}`,
      now: (): string => "2026-07-14T07:01:00.000Z",
      message: (code): string => code,
      processIdentity: {
        processStartedAt: (): Promise<string | null> => Promise.resolve("Tue Jul 14 15:00:00 2026")
      },
      inheritedEnvironment: (): Readonly<Record<string, string>> => ({}),
      cleanupFailureSink: { record: (): Promise<void> => Promise.resolve() },
      fetch: (): Promise<Response> =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              task_name: "reply",
              resolved_config: {},
              parsed_output: { text: "hello" }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        )
    });
    const result = await service.run({
      packagePath: root,
      rerun: { mode: "NEW" },
      runLimitOverrides: { restConcurrency: 1 },
      analysisLimitOverrides: {},
      signal: new AbortController().signal
    });
    expect(result).toMatchObject({ executionId: EXECUTION_ID, restErrorCount: 0 });

    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: {
        pid: process.pid,
        processStartedAt: "Tue Jul 14 15:00:00 2026",
        executionId: null,
        acquiredAt: "2026-07-14T07:02:00.000Z"
      },
      contextHasher,
      nonce: (): string => "rest_command_verify_nonce"
    });
    try {
      expect(session.readExecution(EXECUTION_ID)).toMatchObject({
        runExecutionLimits: { restConcurrency: 1, evalConcurrency: 2 },
        stages: { REST: { status: "SUCCEEDED" } }
      });
    } finally {
      await session.close();
    }
  });
});
