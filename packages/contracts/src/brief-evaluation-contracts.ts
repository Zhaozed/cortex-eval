import { z } from "zod";
import { JsonObjectSchema } from "./contracts-primitives.ts";

/** Default instruction is copied into calibration Run snapshots; transport protocol stays fixed. */
export const DEFAULT_BRIEF_JUDGE_PROMPT = [
  "你是严格的 Brief 质量裁判，reference-free：只依据提供的冻结材料与最终生成内容评分。",
  "逐维度打 0/1/2 整数分：0=实质性错误、缺失或不安全；1=基本正确但不完整、含糊或顺序弱；2=在输入事实范围内正确、具体、完整且顺序合理。"
].join("\n");

/** Frozen replay input, not an exhaustive dump of the user's memory store. */
export const BriefBundleV1Schema = z.strictObject({
  version: z.literal(1),
  brief_type: z.enum(["daily", "meeting"]),
  context: JsonObjectSchema,
  material: JsonObjectSchema
});
export const BriefReplayRequestSchema = z.strictObject({
  bundle: BriefBundleV1Schema,
  timeout_seconds: z.number().int().positive().max(600).optional()
});

const BriefSourceRefsSchema = z.array(z.string().regex(/^\/(?:[^~]|~[01])*$/)).min(1);
const BriefAtomicIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

export const BriefEvaluationProfileSchema = z
  .strictObject({
    briefType: z.enum(["daily", "meeting"]),
    /** Legacy Cases use JEV; LLM uses the Run’s frozen Evaluator configuration. */
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
    /** Reference-free 0-2 scoring rubric; takes precedence over checklist when present. */
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
export type BriefEvaluationProfile = z.infer<typeof BriefEvaluationProfileSchema>;

/** Resolve an own-property JSON pointer without prototype traversal. */
export function briefPointerExists(root: unknown, pointer: string): boolean {
  let value: unknown = root;
  for (const token of pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, token)) return false;
    value = (value as Record<string, unknown>)[token];
  }
  return true;
}

/** Cross-field validation shared by authoring and replay evaluation. Never transmit the checklist. */
export function validateBriefInput(
  profile: BriefEvaluationProfile,
  request: unknown
): string | null {
  const parsed = BriefReplayRequestSchema.safeParse(request);
  if (!parsed.success) return "BRIEF_REPLAY_REQUEST_INVALID";
  if (parsed.data.bundle.brief_type !== profile.briefType) return "BRIEF_TYPE_MISMATCH";
  if (
    profile.checklist?.some((item) =>
      item.sourceRefs.some((ref) => !briefPointerExists(parsed.data.bundle, ref))
    )
  )
    return "BRIEF_SOURCE_REF_MISSING";
  if (
    profile.rubric?.dimensions.some((item) =>
      item.sourceRefs.some((ref) => !briefPointerExists(parsed.data.bundle, ref))
    )
  )
    return "BRIEF_SOURCE_REF_MISSING";
  return null;
}

/** Read only public generation artifacts; model_input is diagnostic evidence, never final content. */
export const BriefReplayOutputSchema = z.object({
  brief_type: z.enum(["daily", "meeting"]),
  generation_status: z.enum(["generated", "empty", "fact_only_fallback"]),
  presentation_status: z.enum(["cards", "plain_text"]),
  llm_called: z.boolean(),
  delivered: z.literal(false),
  output: z.object({ text: z.string(), cards: z.array(JsonObjectSchema) })
});

/** Strict LLM judge response; common scoring validates exact IDs and output evidence. */
export const BriefLlmAnswersSchema = z.strictObject({
  answers: z.array(
    z.strictObject({
      questionId: z.string().min(1),
      value: z.enum(["PASS", "FAIL", "UNKNOWN"]),
      reason: z.string().trim().min(1),
      evidence: z.array(z.string().min(1))
    })
  )
});

/** Strict LLM judge response for the 0-2 rubric mode; IDs must match the plan exactly. */
export const BriefRubricAnswersSchema = z.strictObject({
  scores: z.array(
    z.strictObject({
      questionId: z.string().min(1),
      score: z.union([z.literal(0), z.literal(1), z.literal(2)]),
      reason: z.string().trim().min(1),
      evidence: z.array(z.string())
    })
  ),
  hard_fail_reasons: z.array(z.string())
});
