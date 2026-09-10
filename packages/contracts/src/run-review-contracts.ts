import { z } from "zod";
import { BusinessKeySchema, Sha256Schema } from "./contracts-primitives.ts";

export const RunReviewDecisionSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  evidenceHash: Sha256Schema,
  verdict: z.enum(["PASS", "FAIL", "PENDING"]),
  rendererVersion: Sha256Schema.optional(),
  rootCause: z.enum(["UNCLASSIFIED", "PRODUCT", "CASE", "ENVIRONMENT", "EVALUATOR", "EVIDENCE"]),
  note: z.string().trim().max(4000),
  reviewer: z.string().trim().min(1).max(100)
});
export const RunCaptureInputSchema = z
  .strictObject({
    expectedRevision: z.number().int().nonnegative(),
    evidenceHash: Sha256Schema,
    state: z.enum(["CAPTURED", "RENDER_FAILED", "NOT_APPLICABLE"]),
    note: z.string().trim().max(1000),
    images: z
      .array(
        z.strictObject({
          label: z.string().trim().min(1).max(100),
          base64: z.string().min(1).max(8_000_000)
        })
      )
      .max(10)
  })
  .superRefine((v, c) => {
    if ((v.state === "CAPTURED") !== v.images.length > 0)
      c.addIssue({ code: "custom", message: "CAPTURE_IMAGES_REQUIRED" });
  });
const ReviewImageSchema = z.strictObject({
  file: z.string().regex(/^[a-f0-9]{64}\.png$/),
  label: z.string(),
  sha256: Sha256Schema
});
export const RunReviewSchema = z.strictObject({
  runId: z.uuid(),
  caseKey: BusinessKeySchema,
  evidenceHash: Sha256Schema,
  revision: z.number().int().nonnegative(),
  capture: z.enum(["NOT_COLLECTED", "CAPTURED", "RENDER_FAILED", "NOT_APPLICABLE"]),
  captureNote: z.string(),
  images: z.array(ReviewImageSchema),
  live: z
    .strictObject({
      required: z.boolean(),
      available: z.boolean(),
      rendererVersion: Sha256Schema.nullable()
    })
    .optional(),
  history: z.array(
    z.strictObject({
      revision: z.number().int().positive(),
      at: z.iso.datetime(),
      kind: z.enum(["DECISION", "CAPTURE"]),
      verdict: z.enum(["PASS", "FAIL", "PENDING"]),
      reviewer: z.string(),
      rootCause: z.string(),
      note: z.string(),
      evidenceHash: Sha256Schema.optional(),
      rendererVersion: Sha256Schema.optional(),
      images: z.array(ReviewImageSchema).optional(),
      capture: z.enum(["NOT_COLLECTED", "CAPTURED", "RENDER_FAILED", "NOT_APPLICABLE"]).optional()
    })
  )
});
export const RunReviewListSchema = z.array(RunReviewSchema);
export type RunReview = z.infer<typeof RunReviewSchema>;

/** Read-only renderer descriptor; payloads come from this exact saved execution. */
export const RunLivePreviewSchema = z.strictObject({
  runId: z.uuid(),
  caseKey: BusinessKeySchema,
  evidenceHash: Sha256Schema,
  origin: z.url().nullable(),
  previewPath: z
    .string()
    .regex(/^\/renderers\/[a-f0-9]{64}\/preview$/)
    .optional(),
  rendererSource: z.string().optional(),
  rendererVersion: Sha256Schema.nullable(),
  payloads: z.array(z.record(z.string(), z.unknown())),
  error: z.string().nullable()
});
export type RunLivePreview = z.infer<typeof RunLivePreviewSchema>;
