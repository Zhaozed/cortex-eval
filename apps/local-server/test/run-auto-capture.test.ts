import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi, type Mock } from "vitest";
import { RunAutoCaptureService } from "../src/run-auto-capture-service.ts";
import { RunReviewStore } from "../src/run-review-store.ts";
import {
  captureOrigin,
  captureResourceAllowed,
  outboundA2ui
} from "../src/run-auto-capture-model.ts";
import {
  captureResult,
  captureRunId,
  captureHash,
  capturePng,
  capturePayload
} from "./run-auto-capture-fixture.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
async function setup(): Promise<{
  store: RunReviewStore;
  render: Mock<() => Promise<{ label: string; base64: string }[]>>;
  service: RunAutoCaptureService;
}> {
  const root = await mkdtemp(join(tmpdir(), "run-auto-capture-"));
  roots.push(root);
  const store = new RunReviewStore(root, () => Promise.resolve(captureHash));
  const render = vi.fn(() => Promise.resolve([{ label: "卡片", base64: capturePng }]));
  const service = new RunAutoCaptureService(store, render);
  return { store, render, service };
}
const signal = (): AbortSignal => new AbortController().signal;
it("defaults off: does not read reviews or launch a browser", async () => {
  const { store, render, service } = await setup();
  const read = vi.spyOn(store, "get");
  await service.collect(captureResult(false), signal());
  expect(render).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});
it("captures immutable evidence once; duplicate calls do not replace images or approvals", async () => {
  const { store, render, service } = await setup();
  await Promise.all([
    service.collect(captureResult(), signal()),
    service.collect(captureResult(), signal())
  ]);
  const review = await store.get(captureRunId, "capture");
  expect(render).toHaveBeenCalledTimes(1);
  expect(review.capture).toBe("CAPTURED");
  expect(review.images).toHaveLength(1);
  expect(review.evidenceHash).toBe(captureHash);
  expect(review.history[0]?.verdict).toBe("PENDING");
  const first = review.images[0];
  if (!first) throw new Error("Missing capture");
  expect(await store.image(captureRunId, "capture", first.file)).toEqual(
    Buffer.from(capturePng, "base64")
  );
});
it.each([undefined, [], [{ present_mode: "task" }], [capturePayload, null]])(
  "missing/invalid cards fail, never a fabricated empty screenshot (%j)",
  async (a2ui) => {
    const { store, render, service } = await setup();
    const result = captureResult();
    await service.collect(
      {
        ...result,
        providerOutput: {
          ...result.providerOutput,
          parsedOutput: a2ui === undefined ? {} : { a2ui }
        }
      },
      signal()
    );
    const review = await store.get(captureRunId, "capture");
    expect(review.capture).toBe("RENDER_FAILED");
    expect(review.images).toEqual([]);
    expect(render).not.toHaveBeenCalled();
  }
);
it.each(["A2UI_CAPTURE_TIMEOUT", "A2UI_RENDER_FAILED", "private bearer token"])(
  "renderer error persists a safe independent capture failure (%s)",
  async (code) => {
    const { store, render, service } = await setup();
    render.mockRejectedValue(new Error(code));
    await service.collect(captureResult(), signal());
    const review = await store.get(captureRunId, "capture");
    expect(review.capture).toBe("RENDER_FAILED");
    expect(review.captureNote).not.toContain("private bearer");
  }
);
it("retry uses saved output, resets approval, retains history and rejects stale revision", async () => {
  const { store, render, service } = await setup();
  const result = captureResult();
  await service.collect(result, signal());
  await store.change(
    captureRunId,
    "capture",
    {
      expectedRevision: 1,
      evidenceHash: captureHash,
      verdict: "PASS",
      reviewer: "产品",
      rootCause: "UNCLASSIFIED",
      note: "走查"
    },
    "DECISION"
  );
  await expect(
    service.retry(result, { revision: 1, evidenceHash: captureHash }, signal())
  ).rejects.toThrow("REVIEW_STALE");
  const review = await service.retry(result, { revision: 2, evidenceHash: captureHash }, signal());
  expect(review.history.map((e) => e.verdict)).toEqual(["PENDING", "PASS", "PENDING"]);
  expect(render).toHaveBeenCalledTimes(2);
});
it("concurrent manual evidence cannot be overwritten by a slow renderer", async () => {
  const { store, service, render } = await setup();
  render.mockImplementation(async () => {
    await store.change(
      captureRunId,
      "capture",
      {
        expectedRevision: 0,
        evidenceHash: captureHash,
        state: "CAPTURED",
        images: [{ label: "manual", base64: capturePng }],
        note: "人工采集"
      },
      "CAPTURE"
    );
    return [{ label: "automatic", base64: capturePng }];
  });
  await expect(service.collect(captureResult(), signal())).rejects.toThrow("REVIEW_STALE");
  expect((await store.get(captureRunId, "capture")).images[0]?.label).toBe("manual");
});
it("new run never inherits approvals; opted-out retry rejected; cancelled capture does not launch", async () => {
  const { service, store, render } = await setup();
  await expect(
    service.retry(captureResult(false), { revision: 0, evidenceHash: captureHash }, signal())
  ).rejects.toThrow("REVIEW_CAPTURE_DISABLED");
  const abort = new AbortController();
  abort.abort();
  await service.collect(captureResult(), abort.signal);
  expect(render).not.toHaveBeenCalled();
  expect((await store.get(captureRunId, "capture")).capture).toBe("RENDER_FAILED");
  const next = { ...captureResult(), runId: "018f0f4e-7b7a-7cc0-8000-000000000002" };
  await service.collect(next, signal());
  expect((await store.get(next.runId, "capture")).history[0]?.verdict).toBe("PENDING");
});
it("only outbound sources qualify, preserves stream order, never fabricates from tools", () => {
  expect(
    outboundA2ui({ a2ui: [capturePayload], delivered_messages: [{ a2ui: capturePayload }] })
  ).toEqual([capturePayload]);
  expect(outboundA2ui({ delivered_messages: [{ a2ui: capturePayload }] })).toEqual([
    capturePayload
  ]);
  expect(outboundA2ui({ final_output: { a2ui: capturePayload } })).toEqual([capturePayload]);
  expect(
    outboundA2ui({ present_mode: "task", tool_executions: [{ a2ui: capturePayload }] })
  ).toEqual([]);
});
it("only local renderer origins and controlled static assets are allowed, including redirects", () => {
  expect(captureOrigin("http://127.0.0.1:8082")).toBe("http://127.0.0.1:8082");
  for (const url of [
    "https://example.com",
    "file:///etc/passwd",
    "http://localhost/api",
    "http://user:pass@localhost"
  ])
    expect(() => captureOrigin(url)).toThrow();
  const origin = captureOrigin("http://localhost:8082");
  expect(captureResourceAllowed(`${origin}/static/a2ui_viewer.js`, origin, "GET")).toBe(true);
  for (const url of [
    `${origin}/api/chat`,
    `${origin}/static/../api/chat`,
    "http://169.254.169.254/static/x",
    "file:///etc/passwd"
  ])
    expect(captureResourceAllowed(url, origin, "GET")).toBe(false);
  expect(captureResourceAllowed(`${origin}/static/a.js`, origin, "POST")).toBe(false);
});
