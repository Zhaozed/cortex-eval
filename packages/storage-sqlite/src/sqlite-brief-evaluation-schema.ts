import { z } from "zod";

const BriefSourceRefsSchema = z.array(z.string().regex(/^\/(?:[^~]|~[01])*$/)).min(1);
const BriefAtomicIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

export const BriefEvaluationProfileSchema = z
  .strictObject({
    briefType: z.enum(["daily", "meeting"]),
    /** Must match the public Brief profile; absent remains legacy JEV. */
    judge: z.enum(["JEV", "LLM"]).optional(),
    judgePrompt: z.string().trim().min(1).max(30000).optional(),
    checklist: z
      .array(
        z.strictObject({
          id: BriefAtomicIdSchema,
          tier: z.enum(["P0", "P1", "P2"]),
          assertion: z.string().trim().min(1),
          /** JSON pointers relative to bundle, not to request_body. P2 states content to exclude. */
          sourceRefs: BriefSourceRefsSchema
        })
      )
      .min(1)
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
        "BRIEF_ATOMIC_ID_DUPLICATED"
      )
      .optional(),
    /** Reference-free 0-2 scoring rubric; must mirror the public Brief profile. */
    rubric: z
      .strictObject({
        dimensions: z
          .array(
            z.strictObject({
              id: BriefAtomicIdSchema,
              assertion: z.string().trim().min(1),
              /** JSON pointers relative to bundle. */
              sourceRefs: BriefSourceRefsSchema
            })
          )
          .min(1)
          .refine(
            (items) => new Set(items.map((item) => item.id)).size === items.length,
            "BRIEF_ATOMIC_ID_DUPLICATED"
          ),
        minTotalScore: z.number().int().nonnegative(),
        /** Absent behaves as true; no zod default so Fastify JSON-schema conversion stays strict-safe. */
        failOnZeroDimension: z.boolean().optional(),
        hardFailRules: z.array(z.string().trim().min(1)).min(1)
      })
      .optional(),
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
  })
  .superRefine((profile, context) => {
    if (profile.checklist === undefined && profile.rubric === undefined) {
      context.addIssue({ code: "custom", message: "BRIEF_PROFILE_EMPTY" });
    }
  });
