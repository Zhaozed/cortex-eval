import {
  RunReviewSchema,
  RunReviewListSchema,
  type RunReviewDecisionSchema,
  RunLivePreviewSchema,
  type RunLivePreview,
  type RunReview
} from "@cortex-eval/contracts/src/run-review-contracts.ts";
import type { z } from "zod";
import { apiRequestJson } from "./api-client.ts";
const path = (runId: string, key: string): string =>
  `/api/v1/runs/${encodeURIComponent(runId)}/cases/${encodeURIComponent(key)}`;
export const runReviewApi = {
  list: (runId: string, signal: AbortSignal): Promise<RunReview[]> =>
    apiRequestJson(
      `/api/v1/runs/${encodeURIComponent(runId)}/reviews`,
      RunReviewListSchema,
      {
        signal
      },
      undefined,
      (values) => values.every((value) => value.runId === runId)
    ),
  get: (runId: string, key: string, signal: AbortSignal): Promise<RunReview> =>
    apiRequestJson(
      `${path(runId, key)}/review`,
      RunReviewSchema,
      { signal },
      undefined,
      (value) => value.runId === runId && value.caseKey === key
    ),
  save: (
    runId: string,
    key: string,
    input: z.infer<typeof RunReviewDecisionSchema>
  ): Promise<RunReview> =>
    apiRequestJson(
      `${path(runId, key)}/review`,
      RunReviewSchema,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input)
      },
      undefined,
      (value) =>
        value.runId === runId &&
        value.caseKey === key &&
        value.evidenceHash === input.evidenceHash &&
        value.revision === input.expectedRevision + 1
    ),
  preview: (runId: string, key: string, signal: AbortSignal): Promise<RunLivePreview> =>
    apiRequestJson(
      `${path(runId, key)}/preview`,
      RunLivePreviewSchema,
      { signal },
      undefined,
      (value) => value.runId === runId && value.caseKey === key
    )
};
