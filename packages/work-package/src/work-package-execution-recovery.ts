import {
  UtcDateTimeSchema,
  UuidV7Schema
} from "@cortex-eval/contracts/src/contracts-primitives.ts";
import {
  ExecutionV1Schema,
  type ExecutionV1
} from "@cortex-eval/contracts/src/work-package-contracts.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

import type {
  SecureDirectoryEntry,
  SecureWorkPackageDirectory
} from "./secure-work-package-directory.ts";

type RecoverableStage = "REST" | "EVALUATION" | "REPORT" | "ANALYSIS";

const ARTIFACT_STAGE: Readonly<Record<string, RecoverableStage>> = {
  "rest-results.json": "REST",
  "promptfoo-raw.json": "EVALUATION",
  "normalized-eval.json": "EVALUATION",
  "report.json": "REPORT",
  "report.md": "REPORT",
  "analysis-results.json": "ANALYSIS"
};
const TEMPORARY_NAME =
  /^\.(execution\.json|rest-results\.json|promptfoo-raw\.json|normalized-eval\.json|report\.json|report\.md|analysis-results\.json)\.cortex-tmp-[A-Za-z0-9_-]{8,128}$/;

// Parse one previously validated-shape state without exposing parser diagnostics.
async function readExecution(
  directory: SecureWorkPackageDirectory,
  executionId: string
): Promise<ExecutionV1 | null> {
  try {
    const bytes = await directory.readFileBounded(
      `executions/${executionId}/execution.json`,
      WORK_PACKAGE_RUNTIME_LIMITS.executionBytes
    );
    const dirty = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return ExecutionV1Schema.parse(dirty);
  } catch {
    return null;
  }
}

// Serialize one recovered state under the fixed Execution ceiling.
function executionBytes(execution: ExecutionV1): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(ExecutionV1Schema.parse(execution))}\n`, "utf8");
  if (bytes.byteLength > WORK_PACKAGE_RUNTIME_LIMITS.executionBytes) {
    throw new Error("WORK_PACKAGE_INVALID");
  }
  return bytes;
}

// Complete the outer lifecycle only when recovery leaves no pending stage.
function recoveredCompletedAt(stages: ExecutionV1["stages"], recoveredAt: string): string | null {
  const incomplete = Object.values(stages).some((stage) => stage.status === "PENDING");
  return incomplete ? null : recoveredAt;
}

// Return safe direct files owned by one exact Execution directory.
function executionFiles(
  entries: readonly SecureDirectoryEntry[],
  executionId: string
): readonly SecureDirectoryEntry[] {
  const prefix = `executions/${executionId}/`;
  return entries.filter(
    (entry) => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes("/")
  );
}

/** Recover interrupted mutable state only after the caller acquired the package lock. */
export async function recoverInterruptedWorkPackageExecutions(
  directory: SecureWorkPackageDirectory,
  recoveredAt: string,
  nonce: () => string
): Promise<void> {
  const timestamp = UtcDateTimeSchema.parse(recoveredAt);
  const entries = directory.listTree();
  const executionIds = entries
    .filter((entry) => entry.kind === "DIRECTORY" && entry.path.startsWith("executions/"))
    .map((entry) => entry.path.split("/"))
    .filter((parts) => parts.length === 2 && UuidV7Schema.safeParse(parts[1]).success)
    .map((parts) => parts[1])
    .filter((value): value is string => value !== undefined);

  for (const executionId of executionIds) {
    const execution = await readExecution(directory, executionId);
    if (execution?.executionId !== executionId) continue;
    const files = executionFiles(entries, executionId);
    const registered = new Set(
      Object.values(execution.stages).flatMap((stage) => stage.artifacts.map((item) => item.path))
    );
    const unownedPublishedArtifact = files.some((entry) => {
      if (entry.kind !== "FILE") return false;
      const name = entry.path.slice(`executions/${executionId}/`.length);
      const stageName = ARTIFACT_STAGE[name];
      return (
        stageName !== undefined &&
        !registered.has(entry.path) &&
        (execution.stages[stageName].status === "RUNNING" ||
          execution.stages[stageName].status === "ERROR")
      );
    });
    if (unownedPublishedArtifact) throw new Error("TEMP_CLEANUP_FAILED");
    for (const entry of files) {
      if (entry.kind !== "FILE") continue;
      const name = entry.path.slice(`executions/${executionId}/`.length);
      if (TEMPORARY_NAME.test(name)) {
        await directory.removeFile(entry.path);
      }
    }

    const runningEntry = Object.entries(execution.stages).find(
      (entry) => entry[1].status === "RUNNING"
    ) as [RecoverableStage, ExecutionV1["stages"][RecoverableStage]] | undefined;
    if (runningEntry === undefined) continue;
    const [stageName, stage] = runningEntry;
    if (stage.startedAt === null) throw new Error("WORK_PACKAGE_INVALID");
    const stages = {
      ...execution.stages,
      [stageName]: {
        status: "ERROR" as const,
        startedAt: stage.startedAt,
        completedAt: timestamp,
        errorCode: "REQUEST_ABORTED" as const,
        artifacts: []
      }
    };
    const recovered = ExecutionV1Schema.parse({
      ...execution,
      completedAt: recoveredCompletedAt(stages, timestamp),
      stages
    });
    await directory.replaceMutableFile(
      `executions/${executionId}/execution.json`,
      executionBytes(recovered),
      nonce()
    );
  }
}
