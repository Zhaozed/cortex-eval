import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RunReviewStore } from "../src/run-review-store.ts";
const roots: string[] = [];
const run = "018f0f4e-7b7a-7cc0-8000-000000000001",
  hash = "a".repeat(64);
const decision = {
  expectedRevision: 0,
  evidenceHash: hash,
  verdict: "PASS",
  rootCause: "PRODUCT",
  reviewer: "产品",
  note: "已走查"
};
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCusAAAAASUVORK5CYII=";
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
async function store(): Promise<RunReviewStore> {
  const root = await mkdtemp(join(tmpdir(), "run-review-test-"));
  roots.push(root);
  return new RunReviewStore(root, (_run, key) => Promise.resolve(key === "case" ? hash : null));
}
it("persists decisions across instances and never inherits approval in another Run", async () => {
  const s = await store();
  const v = await s.change(run, "case", decision, "DECISION");
  expect(
    (await new RunReviewStore(s.root, () => Promise.resolve(hash)).get(run, "case")).history
  ).toEqual(v.history);
  expect((await s.get("018f0f4e-7b7a-7cc0-8000-000000000002", "case")).history).toHaveLength(0);
  await expect(s.change(run, "case", decision, "DECISION")).rejects.toThrow("STALE");
  await expect(s.change(run, "unknown", decision, "DECISION")).rejects.toThrow("NOT_FOUND");
  expect(await s.list(run)).toHaveLength(1);
});
it("serializes concurrent writes and rejects wrong evidence", async () => {
  const s = await store();
  const other = new RunReviewStore(s.root, () => Promise.resolve(hash));
  const result = await Promise.allSettled([
    s.change(run, "case", decision, "DECISION"),
    other.change(run, "case", decision, "DECISION")
  ]);
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  await expect(
    s.change(
      run,
      "case",
      { ...decision, expectedRevision: 1, evidenceHash: "b".repeat(64) },
      "DECISION"
    )
  ).rejects.toThrow("STALE");
});
it("binds PNG to the Run and Case; new capture resets approval, tampering prevents approval", async () => {
  const s = await store();
  await s.change(run, "case", decision, "DECISION");
  const captured = await s.change(
    run,
    "case",
    {
      expectedRevision: 1,
      evidenceHash: hash,
      state: "CAPTURED",
      images: [{ label: "第一步", base64: png }],
      note: "Web 真实输出"
    },
    "CAPTURE"
  );
  expect(captured.history.at(-1)?.verdict).toBe("PENDING");
  expect(captured.history).toHaveLength(2);
  const image = captured.images[0];
  if (!image) throw new Error("missing image");
  expect(await s.image(run, "case", image.file)).toEqual(Buffer.from(png, "base64"));
  await expect(s.image(run, "case", "../review.json")).rejects.toThrow("NOT_FOUND");
  await writeFile(join(s.directory(run, "case"), image.file), "tampered");
  await expect(
    s.change(run, "case", { ...decision, expectedRevision: 2 }, "DECISION")
  ).rejects.toThrow("STALE");
});
it("rejects invalid capture without publishing a review", async () => {
  const s = await store();
  await expect(
    s.change(
      run,
      "case",
      {
        expectedRevision: 0,
        evidenceHash: hash,
        state: "CAPTURED",
        images: [{ label: "bad", base64: Buffer.from("not png").toString("base64") }],
        note: ""
      },
      "CAPTURE"
    )
  ).rejects.toThrow("IMAGE_INVALID");
  expect((await s.get(run, "case")).revision).toBe(0);
});

it("clears cause on non-failing decisions without rewriting earlier failure evidence", async () => {
  const s = await store();
  await s.change(run, "case", { ...decision, verdict: "FAIL" }, "DECISION");
  await s.change(run, "case", { ...decision, expectedRevision: 1 }, "DECISION");
  const result = await s.change(
    run,
    "case",
    { ...decision, expectedRevision: 2, verdict: "PENDING", rootCause: "EVIDENCE" },
    "DECISION"
  );
  expect(result.history.map((event) => [event.verdict, event.rootCause])).toEqual([
    ["FAIL", "PRODUCT"],
    ["PASS", "UNCLASSIFIED"],
    ["PENDING", "UNCLASSIFIED"]
  ]);
  expect(result.history[0]?.note).toBe(decision.note);
});
