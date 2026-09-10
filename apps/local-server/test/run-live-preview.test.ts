import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RunLivePreviewService } from "../src/run-live-preview-service.ts";
import { livePreviewContext } from "../src/run-live-preview-context.ts";
import { RunReviewStore } from "../src/run-review-store.ts";
import { captureResult, captureRunId, captureHash } from "./run-auto-capture-fixture.ts";

it("serves only read-only renderer resources on an isolated origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-assets-"));
  const service = new RunLivePreviewService(root);
  try {
    await mkdir(join(root, "a2ui_runtime/icons"), { recursive: true });
    await mkdir(join(root, "a2ui_runtime/rives"));
    for (const file of [
      "a2ui_viewer.js",
      "a2ui_viewer.css",
      "a2ui_catalog.css",
      "a2ui_runtime/loona.html"
    ])
      await writeFile(join(root, file), "");
    await writeFile(
      join(root, "a2ui_runtime/resource-catalog.json"),
      JSON.stringify({ source: "test", i18n_keys: [] })
    );
    const info = await service.info();
    expect(info.rendererVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(await service.info()).toEqual(info);
    expect((await fetch(`${info.origin}${info.previewPath}`)).status).toBe(200);
    expect(
      (
        await fetch(
          `${info.origin}${info.previewPath.replace("/preview", "/static/a2ui_viewer.js")}`
        )
      ).status
    ).toBe(200);
    expect((await fetch(`${info.origin}/api/v1/runs`)).status).toBe(404);
    expect((await fetch(`${info.origin}${info.previewPath}`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${info.origin}/%zz`)).status).toBe(400);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("requires real outbound evidence but never starts rendering for a no-card Case", async () => {
  const renderer = new RunLivePreviewService(undefined);
  const base = captureResult(false);
  const empty = { ...base, providerOutput: { ...base.providerOutput, parsedOutput: { a2ui: [] } } };
  expect((await livePreviewContext(empty, renderer)).live).toMatchObject({
    required: false,
    available: false
  });
  const required = {
    ...empty,
    definition: {
      ...empty.definition,
      metadata: { ...empty.definition.metadata, a2uiCapture: true }
    }
  };
  expect((await livePreviewContext(required, renderer)).preview.error).toContain("未保存");
  const real = await livePreviewContext(captureResult(false), renderer);
  expect(real.live).toMatchObject({ required: true, available: false });
  expect(real.preview.payloads).toHaveLength(1);
  expect(real.preview.error).toContain("资源不可用");
});
it("binds manual approval to current execution evidence and renderer revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-review-"));
  let available = true;
  const version = "b".repeat(64);
  const store = new RunReviewStore(
    root,
    () => Promise.resolve(captureHash),
    () => Promise.resolve({ required: true, available, rendererVersion: version })
  );
  const input = {
    expectedRevision: 0,
    evidenceHash: captureHash,
    verdict: "PASS",
    reviewer: "产品",
    rootCause: "UNCLASSIFIED",
    note: "人工检查"
  };
  try {
    await expect(store.change(captureRunId, "capture", input, "DECISION")).rejects.toThrow(
      "REVIEW_RENDER_REQUIRED"
    );
    await expect(
      store.change(captureRunId, "capture", { ...input, rendererVersion: captureHash }, "DECISION")
    ).rejects.toThrow("REVIEW_RENDER_REQUIRED");
    available = false;
    await expect(
      store.change(captureRunId, "capture", { ...input, rendererVersion: version }, "DECISION")
    ).rejects.toThrow("REVIEW_RENDER_REQUIRED");
    available = true;
    const review = await store.change(
      captureRunId,
      "capture",
      { ...input, rendererVersion: version },
      "DECISION"
    );
    expect(review.history[0]?.rendererVersion).toBe(version);
    expect(review.images).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
