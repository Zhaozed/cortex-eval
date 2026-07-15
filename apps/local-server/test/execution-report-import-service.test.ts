import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeSqliteStorage } from "@cortex-eval/storage-sqlite/src/sqlite-database.ts";
import {
  SecureWorkPackageDirectory,
  type WorkPackageLockOwner
} from "@cortex-eval/work-package/src/secure-work-package-directory.ts";
import { encodeWorkPackageExport } from "@cortex-eval/work-package/src/work-package-export-encoder.ts";
import { workPackageCaseDefinitionHasher } from "@cortex-eval/work-package/src/work-package-domain-hashing.ts";
import { validateWorkPackageDirectory } from "@cortex-eval/work-package/src/work-package-validator.ts";
import { materializeWorkPackageFixture } from "@cortex-eval/work-package/test-support/work-package-fixture.ts";
import { afterEach, describe, expect, it } from "vitest";

import { materializeCompletedOfflineReport } from "../../web/test-support/offline-report-e2e-fixture.ts";
import { ExecutionReportImportService } from "../src/execution-report-import-service.ts";

const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const RUN_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff2";
const PROCESS_STARTED_AT = "Wed Jul 15 08:00:00 2026";
const roots: string[] = [];

function owner(): WorkPackageLockOwner {
  return {
    pid: process.pid,
    processStartedAt: PROCESS_STARTED_AT,
    executionId: null,
    acquiredAt: "2026-07-15T00:00:00.000Z"
  };
}

async function exportBytes(sourcePath: string): Promise<Uint8Array> {
  const directory = await SecureWorkPackageDirectory.open(sourcePath);
  try {
    const validated = await validateWorkPackageDirectory(directory, owner());
    const chunks = [];
    for await (const chunk of encodeWorkPackageExport(directory, validated)) chunks.push(chunk);
    return Buffer.concat(chunks);
  } finally {
    directory.close();
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Execution Report Import Service", () => {
  it("双遍读取完整离线报告并以 Execution 版本幂等导入平台", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cortex-report-import-service-"));
    const source = await mkdtemp(join(tmpdir(), "cortex-report-import-source-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-report-import-platform-"));
    roots.push(parent, source, projectRoot);
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
    await materializeWorkPackageFixture(source, {
      baseDefinitionHash: workPackageCaseDefinitionHasher.hash({
        contractVersion: "cortex.case-definition.v1",
        caseKey: definition.caseKey,
        definition
      })
    });
    const packagePath = join(parent, "package");
    await materializeCompletedOfflineReport({
      exportBody: await exportBytes(source),
      packagePath,
      executionId: EXECUTION_ID
    });
    const storage = await initializeSqliteStorage({ projectRoot });
    try {
      let nonce = 0;
      const service = new ExecutionReportImportService({
        transactionManager: storage.createTransactionManager(),
        idGenerator: { nextId: (): string => RUN_ID },
        clock: { now: (): string => "2026-07-15T00:10:00.000Z" },
        processIdentity: {
          processStartedAt: (): Promise<string> => Promise.resolve(PROCESS_STARTED_AT)
        },
        nonce: (): string => `import_service_${String(++nonce).padStart(2, "0")}_${randomUUID()}`
      });
      const request = {
        contractVersion: "cortex.execution-report-import-request.v1" as const,
        packagePath,
        executionId: EXECUTION_ID
      };

      await expect(
        service.importReport(request, new AbortController().signal)
      ).resolves.toMatchObject({
        ok: true,
        value: {
          runId: RUN_ID,
          executionId: EXECUTION_ID,
          idempotent: false,
          status: "COMPLETED"
        }
      });
      await expect(
        service.importReport(request, new AbortController().signal)
      ).resolves.toMatchObject({
        ok: true,
        value: { runId: RUN_ID, executionId: EXECUTION_ID, idempotent: true }
      });
    } finally {
      await storage.close();
    }
  }, 20_000);

  it("无法确认当前进程身份时在打开工作包前拒绝", async () => {
    const service = new ExecutionReportImportService({
      transactionManager: {} as never,
      idGenerator: { nextId: (): string => RUN_ID },
      clock: { now: (): string => "2026-07-15T00:10:00.000Z" },
      processIdentity: { processStartedAt: (): Promise<null> => Promise.resolve(null) },
      nonce: (): string => "unused"
    });

    await expect(
      service.importReport(
        {
          contractVersion: "cortex.execution-report-import-request.v1",
          packagePath: "/does/not/open",
          executionId: EXECUTION_ID
        },
        new AbortController().signal
      )
    ).rejects.toThrow("WORK_PACKAGE_LOCKED");
  });
});
