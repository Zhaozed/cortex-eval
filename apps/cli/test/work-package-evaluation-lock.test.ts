import {
  workPackageCaseDefinitionHasher,
  workPackageEvalSemanticHashing,
  workPackageExecutionContextHasher,
  workPackageRestSemanticHashing
} from "@cortex-eval/work-package/src/work-package-domain-hashing.ts";
import { describe, expect, it } from "vitest";

import {
  WorkPackageEvaluationRunService,
  type WorkPackageEvaluationRunServiceDependencies
} from "../src/work-package-evaluation-run-service.ts";

const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";

function unavailableProcessDependencies(): WorkPackageEvaluationRunServiceDependencies {
  return {
    contextHasher: workPackageExecutionContextHasher,
    caseHasher: workPackageCaseDefinitionHasher,
    restHashing: workPackageRestSemanticHashing,
    evalHashing: workPackageEvalSemanticHashing,
    engine: { execute: (): Promise<never> => Promise.reject(new Error("TEST_ENGINE_UNUSED")) },
    runtimePreflight: {
      check: (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true })
    },
    environment: { require: (): void => undefined },
    processIdentity: { processStartedAt: (): Promise<null> => Promise.resolve(null) },
    nonce: (): string => "unused",
    now: (): string => "2026-07-14T07:03:00.000Z",
    cleanupFailureSink: { record: (): Promise<void> => Promise.resolve() },
    stagingFactory: {
      create: (): Promise<never> => Promise.reject(new Error("TEST_STAGING_UNUSED"))
    }
  };
}

describe("Work Package Evaluation 锁边界", () => {
  it("在打开 Package 前拒绝缺失的进程启动身份", async () => {
    const service = new WorkPackageEvaluationRunService(unavailableProcessDependencies());
    const signal = new AbortController().signal;
    await expect(service.preflight({ packagePath: ".", signal })).rejects.toThrow(
      "WORK_PACKAGE_LOCKED"
    );
    await expect(
      service.run({ packagePath: ".", executionId: EXECUTION_ID, signal })
    ).rejects.toThrow("WORK_PACKAGE_LOCKED");
  });
});
