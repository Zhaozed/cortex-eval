import { z } from "zod";
import { JsonValueSchema } from "./contracts-primitives.ts";
import { LiveMemoryMemoryDirectoryItemV1Schema, LiveMemoryMemoryPageV1Schema } from "./memory-evaluation-contracts.ts";

/** Versioned boundary used by cortex-eval when reading Cortex-Agent LiveMem APIs. */
export const LIVE_MEMORY_EVALUATION_API_V1 = "cortex.live-memory-evaluation-api.v1" as const;

const NonEmptyString = z.string().trim().min(1);
const JsonObject = z.record(z.string(), JsonValueSchema);

export const LiveMemoryEvaluationCandidateV1Schema = z.strictObject({
  candidate_id: NonEmptyString,
  client_request_id: NonEmptyString,
  case_type: z.enum(["MAIL_DRAFT", "DAILY_BRIEF", "MEETING_PRE_BRIEF"]),
  launch_mode: z.enum(["AUTO", "MANUAL"]),
  requested_profile_id: NonEmptyString.nullish(),
  status: NonEmptyString,
  current_run_id: NonEmptyString.nullish(),
  rubric_version: NonEmptyString,
  rubric_sha256: NonEmptyString,
  captured_at: NonEmptyString,
  expires_at: NonEmptyString,
  original_task_input: JsonObject,
  available_memory: JsonValueSchema,
  live_mem_process_output: JsonValueSchema,
  final_output: JsonValueSchema
});
export type LiveMemoryEvaluationCandidateV1 = z.infer<
  typeof LiveMemoryEvaluationCandidateV1Schema
>;

export const LiveMemoryObservationV1Schema = z.strictObject({
  domain: z.enum(["USER", "PERSON", "PROJECT"]),
  memory_kind: NonEmptyString,
  evidence_type: z.enum(["EXPLICIT", "IMPLIED", "PATTERN"]),
  fact: NonEmptyString,
  person_emails: z.array(z.string()),
  observed_at: NonEmptyString,
  resolution_run_id: NonEmptyString.nullish(),
  disposition: z.enum(["CREATE", "UPDATE", "MERGE", "IGNORE"]).nullish(),
  reason: z.string().nullish(),
  target_mutation_type: z
    .enum(["MEMORY_CREATE", "MEMORY_UPDATE", "MEMORY_ARCHIVE"])
    .nullish(),
  target_memory_ref: NonEmptyString.nullish(),
  input_evidence_type: z.enum(["EXPLICIT", "IMPLIED", "PATTERN"]).nullish(),
  input_observed_at: z.string().nullish()
});
export type LiveMemoryObservationV1 = z.infer<typeof LiveMemoryObservationV1Schema>;

export const LiveMemoryObservationPageV1Schema = z.strictObject({
  items: z.array(LiveMemoryObservationV1Schema),
  next_cursor: NonEmptyString.nullish(),
  catalog_marker: NonEmptyString
});
export type LiveMemoryObservationPageV1 = z.infer<typeof LiveMemoryObservationPageV1Schema>;

export const LiveMemoryMemoryV1Schema = z.strictObject({
  memory_ref: NonEmptyString,
  domain: z.enum(["USER", "PERSON", "PROJECT"]),
  memory_kind: NonEmptyString,
  content: NonEmptyString
});
export type LiveMemoryMemoryV1 = z.infer<typeof LiveMemoryMemoryV1Schema>;

export const LiveMemoryEntityDirectoryV1Schema = z.strictObject({
  persons: z.array(
    z.strictObject({
      person_ref: NonEmptyString,
      last_interaction_at: z.string().nullish()
    })
  ),
  memories: z.array(LiveMemoryMemoryV1Schema),
  projects: z.array(
    z.strictObject({
      project_ref: NonEmptyString,
      title: NonEmptyString
    })
  ),
  project_persons: z.array(
    z.strictObject({
      project_ref: NonEmptyString,
      person_ref: NonEmptyString
    })
  )
});
export type LiveMemoryEntityDirectoryV1 = z.infer<typeof LiveMemoryEntityDirectoryV1Schema>;

export const LiveMemoryReplaySnapshotV1Schema = z.strictObject({
  run_id: NonEmptyString,
  snapshot_kind: z.enum(["OBSERVATION_EXTRACT", "GLOBAL_CONSOLIDATE"]),
  work_unit_ref: NonEmptyString.nullish(),
  source_tool_id: NonEmptyString.nullish(),
  provider_id: NonEmptyString.nullish(),
  account_id: NonEmptyString.nullish(),
  authorization_category_id: NonEmptyString.nullish(),
  updated_at: NonEmptyString
});
export type LiveMemoryReplaySnapshotV1 = z.infer<typeof LiveMemoryReplaySnapshotV1Schema>;

export const LiveMemoryReplaySnapshotListV1Schema = z.strictObject({
  items: z.array(LiveMemoryReplaySnapshotV1Schema)
});
export type LiveMemoryReplaySnapshotListV1 = z.infer<typeof LiveMemoryReplaySnapshotListV1Schema>;

export const LiveMemoryExtractResultV1Schema = z.unknown();
export type LiveMemoryExtractResultV1 = z.infer<typeof LiveMemoryExtractResultV1Schema>;

export const LiveMemoryGlobalResultV1Schema = z.unknown();
export type LiveMemoryGlobalResultV1 = z.infer<typeof LiveMemoryGlobalResultV1Schema>;

export { LiveMemoryMemoryDirectoryItemV1Schema, LiveMemoryMemoryPageV1Schema };
export type { LiveMemoryMemoryDirectoryItemV1, LiveMemoryMemoryPageV1 } from "./memory-evaluation-contracts.ts";

export const LiveMemoryEvaluationApiErrorV1Schema = z.strictObject({
  error_code: NonEmptyString
});

export type LiveMemoryEvaluationApiErrorV1 = z.infer<
  typeof LiveMemoryEvaluationApiErrorV1Schema
>;
