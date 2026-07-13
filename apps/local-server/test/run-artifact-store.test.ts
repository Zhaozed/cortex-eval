import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlatformRestArtifactInput } from "@cortex-eval/application/src/features/runs/run-artifact-port.ts";
import type { StoredRestCaseResult } from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import { hashRestResultSet } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { afterEach, describe, expect, it } from "vitest";

import { LocalRunArtifactStore } from "../src/run-artifact-store.ts";

const roots: string[] = [];
const RUN_ID = "01900000-0000-7000-8000-000000000001";
const NOW = "2026-07-13T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const CASE_RESULT: StoredRestCaseResult = {
  runId: RUN_ID,
  caseKey: "case-1",
  ordinal: 0,
  definition: {
    caseKey: "case-1",
    description: "Case",
    threshold: 1,
    task: "route",
    requestBody: { input: "hello" },
    metadata: {
      requestId: "request-1",
      taskId: "task-1",
      businessModule: "chat",
      scenarioTag: "smoke"
    },
    assertions: [{ type: "equals", metric: "quality", weight: 1 }]
  },
  caseDefinitionHash: "b".repeat(64),
  status: "SUCCEEDED",
  httpStatus: 200,
  providerOutput: { ok: false, errorMessage: "business" },
  errorType: null,
  errorMessage: null,
  durationMs: 12,
  completedAt: NOW,
  resultHash: "c".repeat(64)
};

// Create one single-use async result stream.
async function* streamCases(
  values: readonly StoredRestCaseResult[]
): AsyncGenerator<StoredRestCaseResult> {
  for (const value of values) yield await Promise.resolve(value);
}

function artifactInput(): PlatformRestArtifactInput {
  return {
    runId: RUN_ID,
    runContextHash: "a".repeat(64),
    completedAt: NOW,
    expectedTotal: 1,
    cases: streamCases([CASE_RESULT])
  };
}

describe("LocalRunArtifactStore", () => {
  it("逐 Case 流式写入并在同一遍生成结果集 Hash，不要求完整结果数组驻留内存", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifacts-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot });
    let yielded = 0;
    const cases = async function* (): AsyncGenerator<StoredRestCaseResult> {
      for (const item of [CASE_RESULT]) {
        yielded += 1;
        yield await Promise.resolve(item);
      }
    };

    const written = await store.writeRestResults({
      runId: RUN_ID,
      runContextHash: "a".repeat(64),
      completedAt: NOW,
      expectedTotal: 1,
      cases: cases()
    });

    expect(yielded).toBe(1);
    expect(written.resultSetHash).toBe(
      hashRestResultSet({
        contractVersion: "cortex.rest-result-set.v1",
        cases: [
          {
            caseKey: CASE_RESULT.caseKey,
            ordinal: CASE_RESULT.ordinal,
            resultHash: CASE_RESULT.resultHash
          }
        ]
      })
    );
    const bytes = await readFile(
      join(projectRoot, ".cortex-eval", "artifacts", written.descriptor.path),
      "utf8"
    );
    expect(JSON.parse(bytes)).toMatchObject({
      resultSetHash: written.resultSetHash,
      cases: [{ caseKey: "case-1", ordinal: 0 }]
    });
  });

  it("拒绝结果流少项、多项、跨 Run 或单项契约损坏并清理临时文件", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifacts-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot, nonce: () => "invalid" });
    const wrongRun = { ...CASE_RESULT, runId: "01900000-0000-7000-8000-000000000002" };
    const invalidResult = { ...CASE_RESULT, resultHash: "invalid" };
    const inputs: PlatformRestArtifactInput[] = [
      { ...artifactInput(), cases: streamCases([]) },
      { ...artifactInput(), cases: streamCases([CASE_RESULT, CASE_RESULT]) },
      { ...artifactInput(), cases: streamCases([wrongRun]) },
      { ...artifactInput(), cases: streamCases([invalidResult]) }
    ];

    for (const input of inputs) {
      await expect(store.writeRestResults(input)).rejects.toMatchObject({
        code: "ARTIFACT_WRITE_FAILED"
      });
      const runRoot = join(projectRoot, ".cortex-eval", "artifacts", "runs", RUN_ID);
      await expect(lstat(join(runRoot, ".rest-results.invalid.tmp"))).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
  });

  it("在创建文件前拒绝无效 Owner、Hash、时间与结果总数", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifacts-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot });
    const inputs: PlatformRestArtifactInput[] = [
      { ...artifactInput(), runId: "invalid" },
      { ...artifactInput(), runContextHash: "invalid" },
      { ...artifactInput(), completedAt: "2026-07-13" },
      { ...artifactInput(), expectedTotal: 0 },
      { ...artifactInput(), expectedTotal: 1.5 }
    ];

    for (const input of inputs) {
      await expect(store.writeRestResults(input)).rejects.toMatchObject({
        code: "ARTIFACT_WRITE_FAILED"
      });
    }
  });

  it("以 canonical JSON、单个 LF 和 owner-only 权限原子提交且拒绝覆盖", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifacts-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({
      projectRoot,
      nonce: () => "nonce-1"
    });
    const { descriptor } = await store.writeRestResults(artifactInput());
    const path = join(projectRoot, ".cortex-eval", "artifacts", descriptor.path);
    const bytes = await readFile(path);
    expect(bytes.toString("utf8")).toMatch(/^\{"cases":.+\}\n$/);
    expect(bytes.toString("utf8").endsWith("\n\n")).toBe(false);
    expect(descriptor).toMatchObject({
      kind: "REST_RESULTS",
      path: `runs/${RUN_ID}/rest-results.json`,
      expectedSizeBytes: bytes.byteLength,
      contractVersion: "cortex.platform-rest-results.v1"
    });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(
      (await lstat(join(projectRoot, ".cortex-eval", "artifacts", "runs", RUN_ID))).mode & 0o777
    ).toBe(0o700);
    await expect(store.writeRestResults(artifactInput())).rejects.toMatchObject({
      code: "ARTIFACT_WRITE_FAILED"
    });
  });

  it("区分 PRESENT、CORRUPTED、MISSING，不改变 Manifest 事实", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifacts-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot });
    const { descriptor } = await store.writeRestResults(artifactInput());
    const manifest = {
      contractVersion: "cortex.artifact-manifest.v1" as const,
      owner: { kind: "RUN" as const, id: RUN_ID },
      artifacts: [descriptor]
    };
    await expect(store.inspect(manifest)).resolves.toMatchObject([{ status: "PRESENT" }]);
    const path = join(projectRoot, ".cortex-eval", "artifacts", descriptor.path);
    await chmod(path, 0o600);
    await writeFile(path, "corrupted\n", { encoding: "utf8", mode: 0o600 });
    await expect(store.inspect(manifest)).resolves.toMatchObject([{ status: "CORRUPTED" }]);
    await store.removeUncommitted(descriptor);
    await expect(store.inspect(manifest)).resolves.toMatchObject([{ status: "MISSING" }]);
  });

  it("启动清理只删除未被任何 durable Manifest 引用的受控 Artifact", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifacts-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot });
    const { descriptor } = await store.writeRestResults(artifactInput());
    await store.cleanupOrphans([]);
    const path = join(projectRoot, ".cortex-eval", "artifacts", descriptor.path);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
