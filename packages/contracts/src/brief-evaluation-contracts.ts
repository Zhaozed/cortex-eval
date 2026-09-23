import { z } from "zod";
import { JsonObjectSchema } from "./contracts-primitives.ts";

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
    profile.checklist.some((item) =>
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
