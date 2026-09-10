import { z } from "zod";

/** Exact source bytes and PNG identities bind reviews to one immutable replay. */
export const A2uiHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const A2uiFileSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+\.png$/)
  .max(200);
/** Import bytes, never arbitrary server-side filesystem paths. */
export const A2uiReviewImportSchema = z.strictObject({
  version: z.literal(1),
  title: z.string().trim().min(1).max(200),
  runId: z.uuid().nullable(),
  report: z.string().max(4_000_000),
  capture: z.string().max(4_000_000),
  cases: z.string().max(4_000_000),
  images: z
    .array(
      z.strictObject({
        file: A2uiFileSchema,
        sha256: A2uiHashSchema,
        base64: z.string().max(8_000_000)
      })
    )
    .max(100)
});
/** A decision covers all images of one Case in this batch only. */
export const A2uiReviewDecisionSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  caseId: z.string().min(1).max(200),
  verdict: z.enum(["approved", "rejected"]),
  reviewer: z.string().trim().min(1).max(100),
  note: z.string().trim().max(2000)
});
const ReviewEventSchema = A2uiReviewDecisionSchema.omit({ expectedRevision: true }).extend({
  at: z.iso.datetime(),
  revision: z.number().int().positive(),
  imageHashes: z.array(A2uiHashSchema).min(1)
});
export const A2uiReviewCaseSchema = z.strictObject({
  caseId: z.string(),
  title: z.string(),
  automatic: z.enum(["passed", "failed", "error"]),
  capture: z.enum(["captured", "empty_verified", "error"]),
  images: z.array(
    z.strictObject({
      file: A2uiFileSchema,
      sha256: A2uiHashSchema,
      groupIndex: z.number().int().nonnegative()
    })
  ),
  manual: z.enum(["pending", "approved", "rejected", "not_applicable", "unavailable"])
});
/** Manual review is independent of immutable platform Run scores. */
export const A2uiReviewSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  title: z.string(),
  runId: z.uuid().nullable(),
  scope: z.literal("offline_web_payload"),
  createdAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(),
  reportHash: A2uiHashSchema,
  captureHash: A2uiHashSchema,
  casesHash: A2uiHashSchema,
  cases: z.array(A2uiReviewCaseSchema),
  history: z.array(ReviewEventSchema),
  overall: z.enum(["passed", "failed", "pending"])
});
export const A2uiReviewListSchema = z.array(A2uiReviewSchema);
export type A2uiReview = z.infer<typeof A2uiReviewSchema>;
export type A2uiReviewImport = z.infer<typeof A2uiReviewImportSchema>;
export type A2uiReviewDecision = z.infer<typeof A2uiReviewDecisionSchema>;
