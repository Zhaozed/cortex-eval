import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildLocalServer } from "../src/local-server.ts";
import { A2uiReviewStore } from "../src/a2ui-review-store.ts";
import { A2uiReviewSchema } from "@cortex-eval/contracts/src/a2ui-review-contracts.ts";
import { reviewFixture } from "./a2ui-review-fixture.ts";

it("preserves historical evidence and rejects retired mutations without changing history", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-api-"));
  const store = new A2uiReviewStore(root, () => Promise.resolve(false));
  const input = reviewFixture();
  const imported = await store.importBatch(input);
  const review = await store.decide(imported.id, {
    caseId: "case",
    expectedRevision: 0,
    verdict: "approved",
    reviewer: "历史审核人",
    note: "历史记录"
  });
  const before = await store.list();
  const server = buildLocalServer({
    requestIdGenerator: { nextId: () => "018f0f4e-7b7a-7cc0-8000-000000000001" },
    resourceHandlers: {
      listTestSuites: () =>
        Promise.resolve({ statusCode: 200, body: { items: [], nextCursor: null } })
    },
    a2uiReviewStore: store
  });
  const headers = { host: "127.0.0.1:4310", origin: "http://127.0.0.1:4310" };
  try {
    const rejected = await server.inject({
      method: "POST",
      url: "/api/v1/a2ui-reviews",
      headers: { ...headers, origin: "http://attacker.example" },
      payload: input
    });
    expect(rejected.statusCode).toBe(403);
    const retiredImport = await server.inject({
      method: "POST",
      url: "/api/v1/a2ui-reviews",
      headers,
      payload: input
    });
    expect(retiredImport.statusCode, retiredImport.body).toBe(410);
    expect(retiredImport.json<{ error: { message: string } }>().error.message).toContain(
      "固定模板回归已停用"
    );
    const image = await server.inject({
      url: `/api/v1/a2ui-reviews/${review.id}/images/case-group-0.png`,
      headers
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.rawPayload.toString("base64")).toBe(input.images[0]?.base64);
    const payload = {
      caseId: "case",
      expectedRevision: 0,
      verdict: "approved",
      reviewer: "测试",
      note: ""
    };
    const decision = await server.inject({
      method: "POST",
      url: `/api/v1/a2ui-reviews/${review.id}/decisions`,
      headers,
      payload
    });
    expect(decision.statusCode, decision.body).toBe(410);
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/v1/a2ui-reviews/${review.id}/decisions`,
          headers,
          payload
        })
      ).statusCode
    ).toBe(410);
    const doc = await server.inject({ url: "/api/v1/openapi.json", headers });
    const paths = doc.json<{ paths: Record<string, { post: { deprecated: boolean } }> }>().paths;
    expect(paths["/api/v1/a2ui-reviews"]?.post.deprecated).toBe(true);
    expect(paths["/api/v1/a2ui-reviews/{id}/decisions"]?.post.deprecated).toBe(true);
    const detail = await server.inject({ url: `/api/v1/a2ui-reviews/${review.id}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(A2uiReviewSchema.parse(detail.json())).toEqual(review);
    const list = await server.inject({ url: "/api/v1/a2ui-reviews", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual(before);
    expect(await store.get(review.id)).toEqual(review);
    const original = await server.inject({
      url: `/api/v1/a2ui-reviews/${review.id}/evidence/report`,
      headers
    });
    expect(original.body).toBe(input.report);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
