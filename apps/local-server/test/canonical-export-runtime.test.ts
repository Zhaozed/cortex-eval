import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { receiveCanonicalExport } from "@cortex-eval/canonical-export/src/canonical-export-receiver.ts";
import { CanonicalExportManifestV1Schema } from "@cortex-eval/contracts/src/canonical-export-contracts.ts";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalServerRuntime } from "../src/local-server-runtime.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Canonical Export 真实 Runtime", () => {
  it("从 SQLite 快照经 HTTP 传输并由独立接收器发布", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-runtime-"));
    const targetParent = await mkdtemp(join(tmpdir(), "cortex-canonical-runtime-target-"));
    roots.push(projectRoot, targetParent);
    const runtime = await createLocalServerRuntime({ projectRoot });
    try {
      const response = await runtime.server.inject({
        method: "POST",
        url: "/api/v1/data/export",
        headers: { host: "127.0.0.1:4310" },
        payload: {}
      });
      expect(response.statusCode).toBe(200);
      const target = join(targetParent, "canonical-export");
      await expect(
        receiveCanonicalExport(
          (async function* (): AsyncGenerator<Buffer> {
            await Promise.resolve();
            yield response.rawPayload;
          })(),
          target,
          {
            nonce: "runtime-receiver-nonce",
            rawEvidenceIncluded: false,
            owner: {
              pid: process.pid,
              processStartedAt: "process-start",
              executionId: null,
              acquiredAt: "2026-07-15T00:00:00.000Z"
            }
          }
        )
      ).resolves.toMatchObject({ targetPath: target });
      const manifest = CanonicalExportManifestV1Schema.parse(
        JSON.parse(await readFile(join(target, "manifest.json"), "utf8")) as unknown
      );
      expect(manifest.rawEvidenceIncluded).toBe(false);
      expect(
        manifest.entityFiles.some((file) => file.entityType === "TEST_SUITE" && file.count === 0)
      ).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("连续完整导出后不残留快照、响应工作区或未脱敏正文", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-runtime-stress-"));
    roots.push(projectRoot);
    const runtime = await createLocalServerRuntime({ projectRoot });
    try {
      for (let iteration = 0; iteration < 20; iteration += 1) {
        const response = await runtime.server.inject({
          method: "POST",
          url: "/api/v1/data/export",
          headers: { host: "127.0.0.1:4310" },
          payload: {}
        });
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toMatch(/expanded-secret|authorization:\s*bearer/i);
      }
      expect(await readdir(join(projectRoot, ".cortex-eval", "tmp"))).toEqual([]);
    } finally {
      await runtime.close();
    }
  });
});
