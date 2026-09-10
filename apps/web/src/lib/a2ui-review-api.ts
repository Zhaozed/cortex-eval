import {
  A2uiReviewListSchema,
  A2uiReviewSchema,
  type A2uiReview
} from "@cortex-eval/contracts/src/a2ui-review-contracts.ts";
import { apiRequestJson } from "./api-client.ts";

/** Strict sidecar API; never rewrites the standard Run report. */
export const a2uiReviewApi = {
  list: (): Promise<A2uiReview[]> => apiRequestJson("/api/v1/a2ui-reviews", A2uiReviewListSchema),
  get: (id: string): Promise<A2uiReview> =>
    apiRequestJson(`/api/v1/a2ui-reviews/${encodeURIComponent(id)}`, A2uiReviewSchema)
};
