import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  A2uiReviewDecisionSchema,
  A2uiReviewImportSchema,
  A2uiReviewSchema,
  type A2uiReview
} from "@cortex-eval/contracts/src/a2ui-review-contracts.ts";
import { a2uiHash, a2uiOverall, validateA2uiEvidence } from "./a2ui-review-evidence.ts";

/** Filesystem sidecar; never mutates Run scores or existing artifacts. */
export class A2uiReviewStore {
  readonly #root: string;
  readonly #runExists: (id: string) => Promise<boolean>;
  constructor(root: string, runExists: (id: string) => Promise<boolean>) {
    this.#root = root;
    this.#runExists = runExists;
  }
  #directory(id: string): string {
    return join(this.#root, z.uuid().parse(id));
  }
  async list(): Promise<A2uiReview[]> {
    await mkdir(this.#root, { recursive: true });
    const ids = (await readdir(this.#root)).filter((id) => z.uuid().safeParse(id).success);
    return (await Promise.all(ids.map((id) => this.get(id)))).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }
  async get(id: string): Promise<A2uiReview> {
    return A2uiReviewSchema.parse(
      JSON.parse(await readFile(join(this.#directory(id), "review.json"), "utf8"))
    );
  }
  async importBatch(raw: unknown): Promise<A2uiReview> {
    const input = A2uiReviewImportSchema.parse(raw);
    const cases = validateA2uiEvidence(input);
    if (input.runId !== null && !(await this.#runExists(input.runId)))
      throw new Error("A2UI_RUN_NOT_FOUND");
    const id = randomUUID();
    const staged = join(this.#root, `.import-${id}`);
    const review: A2uiReview = {
      version: 1,
      id,
      title: input.title,
      runId: input.runId,
      scope: "offline_web_payload",
      createdAt: new Date().toISOString(),
      revision: 0,
      reportHash: a2uiHash(input.report),
      captureHash: a2uiHash(input.capture),
      casesHash: a2uiHash(input.cases),
      cases,
      history: [],
      overall: a2uiOverall(cases)
    };
    await mkdir(staged, { recursive: true });
    try {
      await writeFile(join(staged, "source-report.json"), input.report);
      await writeFile(join(staged, "source-capture.json"), input.capture);
      await writeFile(join(staged, "source-cases.json"), input.cases);
      for (const image of input.images)
        await writeFile(join(staged, image.file), Buffer.from(image.base64, "base64"));
      await writeFile(join(staged, "review.json"), JSON.stringify(review, null, 2));
      await rename(staged, this.#directory(id));
      return review;
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  }
  async image(id: string, file: string): Promise<Buffer> {
    const review = await this.get(id);
    const image = review.cases.flatMap((row) => row.images).find((item) => item.file === file);
    if (!image) throw new Error("A2UI_IMAGE_NOT_FOUND");
    const bytes = await readFile(join(this.#directory(id), image.file));
    if (a2uiHash(bytes) !== image.sha256) throw new Error("A2UI_IMAGE_CHANGED");
    return bytes;
  }
  async evidence(id: string, kind: string): Promise<Buffer> {
    const review = await this.get(id);
    const key = z.enum(["report", "capture", "cases"]).parse(kind);
    const bytes = await readFile(join(this.#directory(id), `source-${key}.json`));
    if (a2uiHash(bytes) !== review[`${key}Hash`]) throw new Error("A2UI_EVIDENCE_CHANGED");
    return bytes;
  }
  async decide(id: string, raw: unknown): Promise<A2uiReview> {
    const input = A2uiReviewDecisionSchema.parse(raw);
    const directory = this.#directory(id),
      lock = join(directory, ".review-lock");
    // Atomic mkdir protects read-check-write across processes; crash locks fail closed.
    await mkdir(lock);
    const temporary = join(directory, `.review-${randomUUID()}.json`);
    try {
      const current = await this.get(id);
      if (current.revision !== input.expectedRevision) throw new Error("A2UI_REVISION_CONFLICT");
      const row = current.cases.find((item) => item.caseId === input.caseId);
      if (row?.capture !== "captured") throw new Error("A2UI_CASE_NOT_REVIEWABLE");
      if (input.verdict === "rejected" && input.note.length === 0)
        throw new Error("A2UI_NOTE_REQUIRED");
      for (const kind of ["report", "capture", "cases"]) await this.evidence(id, kind);
      for (const image of row.images) await this.image(id, image.file);
      row.manual = input.verdict;
      current.revision += 1;
      current.history.push({
        caseId: input.caseId,
        verdict: input.verdict,
        reviewer: input.reviewer,
        note: input.note,
        at: new Date().toISOString(),
        revision: current.revision,
        imageHashes: row.images.map((image) => image.sha256)
      });
      current.overall = a2uiOverall(current.cases);
      await writeFile(temporary, JSON.stringify(current, null, 2));
      await rename(temporary, join(directory, "review.json"));
      return current;
    } finally {
      await rm(temporary, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}
