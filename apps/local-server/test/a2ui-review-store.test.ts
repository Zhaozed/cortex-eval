import { a2uiHash } from "../src/a2ui-review-evidence.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { A2uiReviewStore } from "../src/a2ui-review-store.ts";
import { reviewFixture } from "./a2ui-review-fixture.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function store(): Promise<{ root: string; store: A2uiReviewStore }> {
  const root = await mkdtemp(join(tmpdir(), "a2ui-review-"));
  roots.push(root);
  return { root, store: new A2uiReviewStore(root, () => Promise.resolve(false)) };
}
const decision = {
  caseId: "case",
  expectedRevision: 0,
  verdict: "approved" as const,
  reviewer: "tester",
  note: ""
};
describe("manual review sidecar", () => {
  it("persists history and does not inherit approval on reimport", async () => {
    const { root, store: s } = await store();
    const input = reviewFixture();
    const a = await s.importBatch(input);
    expect(a.overall).toBe("pending");
    expect(await s.image(a.id, first(input.images).file)).toBeInstanceOf(Buffer);
    const b = await s.decide(a.id, decision);
    expect(b.overall).toBe("passed");
    expect(b.history[0]?.imageHashes).toEqual([first(input.images).sha256]);
    expect(await new A2uiReviewStore(root, () => Promise.resolve(false)).get(a.id)).toEqual(b);
    expect((await s.importBatch(input)).overall).toBe("pending");
    expect(await readFile(join(root, a.id, "source-report.json"), "utf8")).toBe(input.report);
  });
  it("manual pass never masks automatic failure", async () => {
    const { store: s } = await store();
    const a = await s.importBatch(reviewFixture(true));
    expect((await s.decide(a.id, decision)).overall).toBe("failed");
  });
  it("rejects stale revisions and keeps audit history", async () => {
    const { store: s } = await store();
    const a = await s.importBatch(reviewFixture());
    await s.decide(a.id, decision);
    await expect(s.decide(a.id, decision)).rejects.toThrow("REVISION");
    const b = await s.decide(a.id, {
      ...decision,
      expectedRevision: 1,
      verdict: "rejected",
      note: "裁切"
    });
    expect(b.history).toHaveLength(2);
    expect(b.overall).toBe("failed");
  });
  it("serializes concurrent decisions across store instances", async () => {
    const { root, store: s } = await store();
    const a = await s.importBatch(reviewFixture());
    const other = new A2uiReviewStore(root, () => Promise.resolve(false));
    const results = await Promise.allSettled([
      s.decide(a.id, decision),
      other.decide(a.id, decision)
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await s.get(a.id)).history).toHaveLength(1);
  });
  it.each(["hash", "path", "missing", "duplicate", "extra", "source", "run"])(
    "rejects invalid %s without publication",
    async (kind) => {
      const { store: s } = await store();
      const input = reviewFixture();
      if (kind === "hash") first(input.images).sha256 = "0".repeat(64);
      if (kind === "path") first(input.images).file = "../x.png";
      if (kind === "missing") input.images = [];
      if (kind === "duplicate") input.images.push(first(input.images));
      if (kind === "extra") input.images.push({ ...first(input.images), file: "extra.png" });
      if (kind === "source") input.report += " ";
      if (kind === "run") input.runId = "018f0c8e-9f79-7abc-8def-0123456789ab";
      await expect(s.importBatch(input)).rejects.toThrow();
      expect(await s.list()).toEqual([]);
    }
  );
  it("rejects tampered image on read and decision", async () => {
    const { root, store: s } = await store();
    const a = await s.importBatch(reviewFixture());
    await writeFile(join(root, a.id, first(first(a.cases).images).file), "changed");
    await expect(s.decide(a.id, decision)).rejects.toThrow("CHANGED");
    expect((await s.get(a.id)).revision).toBe(0);
  });
});

function first<T>(items: readonly T[]): T {
  const value = items[0];
  if (value === undefined) throw new Error("EMPTY_FIXTURE");
  return value;
}

it("accepts real null payload hash for empty capture and makes it non-reviewable", async () => {
  const { store: s } = await store();
  const cases = JSON.stringify([{ case_id: "empty", synthetic: true, expected_groups: [] }]);
  const report = JSON.stringify({
    scope: "offline_web_payload",
    cases_sha256: a2uiHash(cases),
    results: [{ case_id: "empty", title: "Empty", status: "passed", counts: { groups: 0 } }]
  });
  const capture = JSON.stringify({
    scope: "web_template_capture",
    report_sha256: a2uiHash(report),
    cases_sha256: a2uiHash(cases),
    results: [
      {
        case_id: "empty",
        payload_status: "passed",
        payload_sha256: null,
        status: "empty_verified",
        screenshots: []
      }
    ]
  });
  const review = await s.importBatch({ ...reviewFixture(), report, cases, capture, images: [] });
  expect(review.cases[0]?.manual).toBe("not_applicable");
  await expect(s.decide(review.id, { ...decision, caseId: "empty" })).rejects.toThrow(
    "NOT_REVIEWABLE"
  );
});
