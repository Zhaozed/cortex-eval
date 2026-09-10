import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildLocalServer } from "../src/local-server.ts";
import { RunReviewStore } from "../src/run-review-store.ts";
import { RunReviewSchema } from "@cortex-eval/contracts/src/run-review-contracts.ts";

it("review routes enforce origin, schema, evidence and revision without editing automatic results", async () => {
  const root = await mkdtemp(join(tmpdir(), "case-review-api-"));
  const id = "018f0f4e-7b7a-7cc0-8000-000000000001",
    hash = "a".repeat(64);
  const server = buildLocalServer({
    resourceHandlers: {
      listTestSuites: () =>
        Promise.resolve({ statusCode: 200, body: { items: [], nextCursor: null } })
    },
    requestIdGenerator: { nextId: () => id },
    runReviewStore: new RunReviewStore(root, (run, key) =>
      Promise.resolve(run === id && key === "case" ? hash : null)
    )
  });
  const headers = { host: "127.0.0.1:4310", origin: "http://127.0.0.1:4310" };
  const url = `/api/v1/runs/${id}/cases/case/review`;
  const payload = {
    expectedRevision: 0,
    evidenceHash: hash,
    verdict: "PASS",
    reviewer: "产品",
    rootCause: "UNCLASSIFIED",
    note: "已审核"
  };
  try {
    expect(
      (
        await server.inject({
          method: "POST",
          url,
          headers: { ...headers, origin: "https://other.example" },
          payload
        })
      ).statusCode
    ).toBe(403);
    const initial = await server.inject({ url, headers });
    expect(initial.statusCode).toBe(200);
    expect(RunReviewSchema.parse(initial.json()).revision).toBe(0);
    expect(
      (
        await server.inject({
          method: "POST",
          url,
          headers,
          payload: { ...payload, verdict: "UNKNOWN" }
        })
      ).statusCode
    ).toBe(400);
    expect((await server.inject({ method: "POST", url, headers, payload })).statusCode).toBe(200);
    expect((await server.inject({ method: "POST", url, headers, payload })).statusCode).toBe(409);
    expect(
      (await server.inject({ url: url.replace("/case/", "/unknown/"), headers })).statusCode
    ).toBe(404);
    const last = RunReviewSchema.parse((await server.inject({ url, headers })).json());
    expect(last.history).toHaveLength(1);
    expect(last.history[0]?.evidenceHash).toBe(hash);
    expect((await server.inject({ url: `/api/v1/runs/${id}/reviews`, headers })).statusCode).toBe(
      200
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("serves saved live payloads and removes screenshot endpoints", async () => {
  const { captureHash, captureRunId } = await import("./run-auto-capture-fixture.ts");
  const root = await mkdtemp(join(tmpdir(), "live-preview-api-"));
  const server = buildLocalServer({
    resourceHandlers: {
      listTestSuites: () =>
        Promise.resolve({ statusCode: 200, body: { items: [], nextCursor: null } })
    },
    requestIdGenerator: { nextId: () => captureRunId },
    runReviewStore: new RunReviewStore(root, () => Promise.resolve(captureHash)),
    runPreviewOrigin: () => "http://127.0.0.1:40000",
    runLivePreview: async (_, key) => ({
      runId: captureRunId,
      caseKey: key,
      evidenceHash: captureHash,
      origin: "http://127.0.0.1:40000",
      rendererVersion: captureHash,
      payloads: [{ messages: [] }],
      error: null
    })
  });
  const headers = { host: "127.0.0.1:4310", origin: "http://127.0.0.1:4310" };
  const base = `/api/v1/runs/${captureRunId}/cases/capture`;
  try {
    const preview = await server.inject({ url: `${base}/preview`, headers });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-security-policy"]).toContain(
      "frame-src 'self' http://127.0.0.1:40000"
    );
    expect(preview.json()).toMatchObject({ caseKey: "capture", payloads: [{ messages: [] }] });
    for (const suffix of ["capture", "capture/auto"])
      expect(
        (await server.inject({ method: "POST", url: `${base}/${suffix}`, headers, payload: {} }))
          .statusCode
      ).toBe(404);
    expect((await server.inject({ url: `${base}/capture/old.png`, headers })).statusCode).toBe(404);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
