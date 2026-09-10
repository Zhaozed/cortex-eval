import { ApiErrorResponseV1Schema } from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { RunReviewStore } from "./run-review-store.ts";
import { projectRuntimeSchema } from "./contract-schema-projections.ts";
import {
  RunLivePreviewSchema,
  type RunLivePreview,
  RunReviewDecisionSchema,
  RunReviewSchema,
  RunReviewListSchema
} from "@cortex-eval/contracts/src/run-review-contracts.ts";
import { BusinessKeySchema } from "@cortex-eval/contracts/src/contracts-primitives.ts";

/** Local review APIs inherit host/origin guards; every write uses evidence + revision checks. */
export function registerRunReviewRoutes(
  server: FastifyInstance,
  store: RunReviewStore,
  livePreview?: (runId: string, key: string) => Promise<RunLivePreview>
): void {
  const params = z.strictObject({ runId: z.uuid(), caseKey: BusinessKeySchema });
  const errors = Object.fromEntries(
    [400, 403, 404, 409, 500].map((code) => [code, projectRuntimeSchema(ApiErrorResponseV1Schema)])
  );
  const guard =
    (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      try {
        return await fn(req, reply);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (error instanceof z.ZodError || message.startsWith("REVIEW_")) {
          const status =
            message === "REVIEW_NOT_FOUND" ? 404 : message === "REVIEW_STALE" ? 409 : 400;
          return reply.code(status).send({
            error: {
              code: "VALIDATION_FAILED",
              message: status === 409 ? "审核记录已更新，请刷新后重试" : "审核证据或参数无效",
              requestId: req.id,
              path: "review"
            }
          });
        }
        throw error;
      }
    };
  const base = "/api/v1/runs/:runId";
  if (livePreview)
    server.get(
      `${base}/cases/:caseKey/preview`,
      {
        schema: {
          operationId: "getRunLivePreview",
          params: projectRuntimeSchema(params),
          response: { ...errors, 200: projectRuntimeSchema(RunLivePreviewSchema) }
        }
      },
      guard(async (req) => {
        const p = params.parse(req.params);
        return livePreview(p.runId, p.caseKey);
      })
    );
  server.get(
    `${base}/reviews`,
    {
      schema: {
        operationId: "listRunReviews",
        params: projectRuntimeSchema(z.strictObject({ runId: z.uuid() })),
        response: { ...errors, 200: projectRuntimeSchema(RunReviewListSchema) }
      }
    },
    guard(async (req) => store.list(z.object({ runId: z.uuid() }).parse(req.params).runId))
  );
  server.get(
    `${base}/cases/:caseKey/review`,
    {
      schema: {
        operationId: "getRunReview",
        params: projectRuntimeSchema(params),
        response: { ...errors, 200: projectRuntimeSchema(RunReviewSchema) }
      }
    },
    guard(async (req) => {
      const p = params.parse(req.params);
      return store.get(p.runId, p.caseKey);
    })
  );
  server.post(
    `${base}/cases/:caseKey/review`,
    {
      schema: {
        operationId: "saveRunReview",
        params: projectRuntimeSchema(params),
        body: projectRuntimeSchema(RunReviewDecisionSchema),
        response: { ...errors, 200: projectRuntimeSchema(RunReviewSchema) }
      }
    },
    guard(async (req) => {
      const p = params.parse(req.params);
      return store.change(p.runId, p.caseKey, req.body, "DECISION");
    })
  );
}
