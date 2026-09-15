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
it("requires review only for real outbound cards, never for the capture opt-in flag", async () => {
  const renderer = new RunLivePreviewService(undefined);
  const base = captureResult(false);
  const empty = { ...base, providerOutput: { ...base.providerOutput, parsedOutput: { a2ui: [] } } };
  expect((await livePreviewContext(empty, renderer)).live).toMatchObject({
    required: false,
    available: false
  });
  const optedIn = {
    ...empty,
    definition: {
      ...empty.definition,
      metadata: { ...empty.definition.metadata, a2uiCapture: true }
    }
  };
  const flagged = await livePreviewContext(optedIn, renderer);
  expect(flagged.live).toMatchObject({ required: false, available: false });
  expect(flagged.preview.error).toContain("未记录 A2UI 卡片");
  const real = await livePreviewContext(captureResult(false), renderer);
  expect(real.live).toMatchObject({ required: true, available: false });
  expect(real.preview.payloads).toHaveLength(1);
  expect(real.preview.error).toContain("资源不可用");
});
it("records the renderer revision for provenance without gating any human verdict", async () => {
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
    // Cards are renderable but not yet attested: loading state never blocks the reviewer.
    const unattested = await store.change(captureRunId, "capture", input, "DECISION");
    expect(unattested.history.at(-1)).toMatchObject({ verdict: "PASS" });
    expect(unattested.history.at(-1)?.rendererVersion).toBeUndefined();
    available = false;
    // Nothing to render: the human verdict is final and still bound to this evidence hash.
    const unrendered = await store.change(
      captureRunId,
      "capture",
      { ...input, expectedRevision: 1 },
      "DECISION"
    );
    expect(unrendered.history.at(-1)?.verdict).toBe("PASS");
    available = true;
    await expect(
      store.change(
        captureRunId,
        "capture",
        {
          ...input,
          expectedRevision: 2,
          rendererVersion: version,
          rootCause: "EVALUATOR",
          note: "   "
        },
        "DECISION"
      )
    ).rejects.toThrow("REVIEW_NOTE_REQUIRED");
    const review = await store.change(
      captureRunId,
      "capture",
      {
        ...input,
        expectedRevision: 2,
        rendererVersion: version,
        rootCause: "EVALUATOR",
        note: "判定规则误判，链路正确"
      },
      "DECISION"
    );
    expect(review.history.at(-1)).toMatchObject({
      verdict: "PASS",
      rendererVersion: version,
      rootCause: "EVALUATOR"
    });
    expect(review.images).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
