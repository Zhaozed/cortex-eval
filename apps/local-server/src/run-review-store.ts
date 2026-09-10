import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  RunCaptureInputSchema,
  RunReviewDecisionSchema,
  RunReviewSchema,
  type RunReview
} from "@cortex-eval/contracts/src/run-review-contracts.ts";
const hash = (v: string | Buffer): string => createHash("sha256").update(v).digest("hex");
/** Append-only decisions tied to immutable execution evidence. No mutation of automatic results. */
export class RunReviewStore {
  constructor(
    readonly root: string,
    readonly evidence: (runId: string, caseKey: string) => Promise<string | null>,
    readonly liveContext?: (
      runId: string,
      caseKey: string
    ) => Promise<NonNullable<RunReview["live"]>>
  ) {}
  directory(runId: string, key: string): string {
    return join(this.root, z.uuid().parse(runId), hash(key));
  }
  async get(runId: string, key: string): Promise<RunReview> {
    const evidenceHash = await this.evidence(runId, key);
    if (!evidenceHash) throw new Error("REVIEW_NOT_FOUND");
    const live = await this.liveContext?.(runId, key);
    try {
      const v = RunReviewSchema.parse(
        JSON.parse(await readFile(join(this.directory(runId, key), "review.json"), "utf8"))
      );
      if (v.runId !== runId || v.caseKey !== key || v.evidenceHash !== evidenceHash)
        throw new Error("REVIEW_STALE");
      return live ? { ...v, live } : v;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return {
        runId,
        caseKey: key,
        evidenceHash,
        revision: 0,
        capture: "NOT_COLLECTED",
        captureNote: "",
        images: [],
        history: [],
        ...(live ? { live } : {})
      };
    }
  }
  async list(runId: string): Promise<RunReview[]> {
    const directory = join(this.root, z.uuid().parse(runId));
    let dirs: string[];
    try {
      dirs = await readdir(directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const items: RunReview[] = [];
    for (const dir of dirs.filter((v) => /^[a-f0-9]{64}$/.test(v))) {
      try {
        const v = RunReviewSchema.parse(
          JSON.parse(await readFile(join(directory, dir, "review.json"), "utf8"))
        );
        items.push(await this.get(runId, v.caseKey));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    return items;
  }
  async change(
    runId: string,
    key: string,
    raw: unknown,
    kind: "DECISION" | "CAPTURE"
  ): Promise<RunReview> {
    const input =
      kind === "DECISION" ? RunReviewDecisionSchema.parse(raw) : RunCaptureInputSchema.parse(raw);
    const directory = this.directory(runId, key);
    await mkdir(directory, { recursive: true });
    const lock = join(directory, ".lock");
    try {
      await mkdir(lock);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("REVIEW_STALE", { cause: e });
      throw e;
    }
    try {
      const current = await this.get(runId, key);
      if (
        current.revision !== input.expectedRevision ||
        current.evidenceHash !== input.evidenceHash
      )
        throw new Error("REVIEW_STALE");
      const revision = current.revision + 1;
      let next: RunReview;
      if ("verdict" in input) {
        // Manual approval attests to the displayed renderer revision, not to PNG existence.
        if (
          input.verdict === "PASS" &&
          current.live?.required &&
          (!current.live.available ||
            !input.rendererVersion ||
            input.rendererVersion !== current.live.rendererVersion)
        )
          throw new Error("REVIEW_RENDER_REQUIRED");
        if (!current.live)
          for (const image of current.images) await this.image(runId, key, image.file);
        next = {
          ...current,
          revision,
          history: [
            ...current.history,
            {
              revision,
              kind,
              evidenceHash: current.evidenceHash,
              images: current.images,
              capture: current.capture,
              at: new Date().toISOString(),
              verdict: input.verdict,
              reviewer: input.reviewer,
              // A failure classification never carries into a non-failing decision.
              rootCause: input.verdict === "FAIL" ? input.rootCause : "UNCLASSIFIED",
              note: input.note,
              ...(input.rendererVersion ? { rendererVersion: input.rendererVersion } : {})
            }
          ]
        };
      } else {
        const images = [];
        for (const image of input.images) {
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64)) throw new Error("REVIEW_IMAGE_INVALID");
          const bytes = Buffer.from(image.base64, "base64");
          if (
            bytes.length > 6_000_000 ||
            bytes.length < 24 ||
            bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
            bytes.toString("ascii", 12, 16) !== "IHDR" ||
            bytes.readUInt32BE(16) === 0 ||
            bytes.readUInt32BE(20) === 0 ||
            bytes.readUInt32BE(16) > 20000 ||
            bytes.readUInt32BE(20) > 20000
          )
            throw new Error("REVIEW_IMAGE_INVALID");
          const sha256 = hash(bytes),
            file = `${sha256}.png`;
          await writeFile(join(directory, file), bytes);
          images.push({ file, label: image.label, sha256 });
        }
        // Replacing capture evidence invalidates any old approval, keeping history intact.
        next = {
          ...current,
          revision,
          capture: input.state,
          captureNote: input.note,
          images,
          history: [
            ...current.history,
            {
              revision,
              kind,
              evidenceHash: current.evidenceHash,
              images,
              capture: input.state,
              at: new Date().toISOString(),
              verdict: "PENDING",
              reviewer: "",
              rootCause: "UNCLASSIFIED",
              note: input.note
            }
          ]
        };
      }
      const temp = join(directory, `${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify(RunReviewSchema.parse(next)));
        await rename(temp, join(directory, "review.json"));
      } finally {
        await rm(temp, { force: true });
      }
      return next;
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
  async image(runId: string, key: string, file: string): Promise<Buffer> {
    const review = await this.get(runId, key),
      image = [...review.images, ...review.history.flatMap((entry) => entry.images ?? [])].find(
        (v) => v.file === file
      );
    if (!image) throw new Error("REVIEW_NOT_FOUND");
    const bytes = await readFile(join(this.directory(runId, key), image.file));
    if (hash(bytes) !== image.sha256) throw new Error("REVIEW_STALE");
    return bytes;
  }
}
