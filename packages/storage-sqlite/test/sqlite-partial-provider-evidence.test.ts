import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hashRestResult } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import type { StoredRestCaseResult } from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import { initializeSqliteStorage } from "../src/sqlite-database.ts";
import { providerOutputToV1, providerOutputFromV1 } from "../src/sqlite-platform-run-mappers.ts";
import {
  platformRun,
  seedCurrentResources,
  successResult,
  RUN_A,
  SECOND_TIME
} from "../test-support/sqlite-platform-run-repository-setup.ts";

it("失败信封 partial 在 SQLite/传输往返不丢失，ok=false 不变，旧空信封不添加 null", async () => {
  const legacy = { ok: false as const, errorMessage: "EVAL_E2E_TIMEOUT" };
  expect(providerOutputToV1(legacy)).toEqual({ ok: false, err_msg: "EVAL_E2E_TIMEOUT" });
  expect(providerOutputFromV1({ ok: false, err_msg: "EVAL_E2E_TIMEOUT" })).toEqual(legacy);
  const parsedOutput = {
    turns: [{ req_id: "first", parsed_output: { timeline: [{ step_idx: 1 }], a2ui: [] } }],
    conversation_execution: { complete: false }
  };
  const providerOutput = { ...legacy, parsedOutput };
  const original = successResult(RUN_A);
  const hash = (output: typeof legacy | typeof providerOutput): string =>
    hashRestResult({
      contractVersion: "cortex.rest-result.v1",
      caseKey: original.caseKey,
      caseDefinitionHash: original.caseDefinitionHash,
      result: { status: "SUCCEEDED", httpStatus: 200, providerOutput: output }
    });
  expect(hash(providerOutput)).not.toBe(hash(legacy));
  expect(
    hash({
      ...legacy,
      parsedOutput: { ...parsedOutput, conversation_execution: { complete: true } }
    })
  ).not.toBe(hash(providerOutput));
  const result: StoredRestCaseResult = {
    ...original,
    status: "SUCCEEDED",
    httpStatus: 200,
    providerOutput,
    errorType: null,
    errorMessage: null,
    resultHash: hash(providerOutput)
  };
  const storage = await initializeSqliteStorage({
    projectRoot: await mkdtemp(join(tmpdir(), "partial-provider-"))
  });
  try {
    seedCurrentResources(storage.databasePath);
    const tx = storage.createRunTransactionManager();
    await tx.execute(async ({ runs }) => {
      await runs.insertPlatformRun(platformRun(RUN_A));
      await runs.claimStage(RUN_A, 0, SECOND_TIME);
      expect(await runs.recordRestResult(result, SECOND_TIME)).not.toBeNull();
    });
    expect(await tx.execute(({ runs }) => runs.getRestResult(RUN_A, original.caseKey))).toEqual(
      result
    );
    expect(providerOutputToV1(providerOutput)).toEqual({
      ok: false,
      err_msg: legacy.errorMessage,
      parsed_output: parsedOutput
    });
  } finally {
    await storage.close();
  }
});
