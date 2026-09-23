import { z } from "zod";

export const BriefEvaluationProfileSchema = z.strictObject({
  briefType: z.enum(["daily", "meeting"]),
  checklist: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
        tier: z.enum(["P0", "P1", "P2"]),
        assertion: z.string().trim().min(1),
        /** JSON pointers relative to bundle, not to request_body. P2 states content to exclude. */
        sourceRefs: z.array(z.string().regex(/^\/(?:[^~]|~[01])*$/)).min(1)
      })
    )
    .min(1)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      "BRIEF_ATOMIC_ID_DUPLICATED"
    ),
  constraints: z
    .strictObject({
      minCards: z.number().int().nonnegative().optional(),
      maxCards: z.number().int().nonnegative().optional(),
      /** Unicode code points of string leaves in each final card; keys are excluded. */
      maxCardChars: z.number().int().positive().optional(),
      maxTextChars: z.number().int().positive().optional(),
      allowedGenerationStatuses: z
        .array(z.enum(["generated", "empty", "fact_only_fallback"]))
        .min(1)
    })
    .refine(
      (v) => v.minCards === undefined || v.maxCards === undefined || v.minCards <= v.maxCards,
      "BRIEF_CARD_RANGE_INVALID"
    )
});
