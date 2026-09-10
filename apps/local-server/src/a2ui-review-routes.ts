import reviewMessages from "@cortex-eval/contracts/messages/a2ui-review.zh-CN.json" with { type: "json" };
import { ApiErrorResponseV1Schema } from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  A2uiReviewDecisionSchema,
  A2uiReviewImportSchema,
  A2uiReviewListSchema,
  A2uiReviewSchema
} from "@cortex-eval/contracts/src/a2ui-review-contracts.ts";
import { projectRuntimeSchema } from "./contract-schema-projections.ts";
import type { A2uiReviewStore } from "./a2ui-review-store.ts";

/** Register sidecar APIs inside the existing Host/Origin/CSP boundary. */
export function registerA2uiReviewRoutes(server: FastifyInstance, store: A2uiReviewStore): void {
  const errors = Object.fromEntries(
    [400, 403, 409, 410, 500].map((code) => [code, projectRuntimeSchema(ApiErrorResponseV1Schema)])
  );
  const base = "/api/v1/a2ui-reviews";
  const params = projectRuntimeSchema(z.strictObject({ id: z.uuid() }));
  const guarded =
    (
      action: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
    ): ((request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      try {
        return await action(request, reply);
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        const fsCode =
          typeof error === "object" && error !== null && "code" in error ? error.code : "";
        if (
          error instanceof z.ZodError ||
          error instanceof SyntaxError ||
          code.startsWith("A2UI_") ||
          fsCode === "ENOENT"
        ) {
          return reply.code(400).send({
            error: {
              code: "VALIDATION_FAILED",
              message: reviewMessages.invalid,
              requestId: request.id,
              path: "a2uiReview"
            }
          });
        }
        throw error;
      }
    };
  // Retain explicit tombstones for old clients rather than silently accepting new replay work.
  const retired = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> =>
    reply.code(410).send({
      error: {
        code: "VALIDATION_FAILED",
        message: reviewMessages.retired,
        requestId: request.id,
        path: "a2uiReview"
      }
    });
  server.get(
    base,
    {
      schema: {
        operationId: "listA2uiReviews",
        response: { ...errors, 200: projectRuntimeSchema(A2uiReviewListSchema) }
      }
    },
    guarded(async () => store.list())
  );
  server.post(
    base,
    {
      bodyLimit: 24 * 1024 * 1024,
      schema: {
        operationId: "importA2uiReview",
        deprecated: true,
        body: projectRuntimeSchema(A2uiReviewImportSchema),
        response: errors
      }
    },
    retired
  );
  server.get(
    `${base}/:id`,
    {
      schema: {
        operationId: "getA2uiReview",
        params,
        response: { ...errors, 200: projectRuntimeSchema(A2uiReviewSchema) }
      }
    },
    guarded(async (req) => store.get(z.object({ id: z.uuid() }).parse(req.params).id))
  );
  server.post(
    `${base}/:id/decisions`,
    {
      schema: {
        operationId: "decideA2uiReview",
        deprecated: true,
        params,
        body: projectRuntimeSchema(A2uiReviewDecisionSchema),
        response: errors
      }
    },
    retired
  );
  server.get(
    `${base}/:id/images/:file`,
    {
      schema: {
        operationId: "getA2uiReviewImage",
        params: projectRuntimeSchema(z.strictObject({ id: z.uuid(), file: z.string() })),
        response: errors
      }
    },
    guarded(async (req, reply) => {
      const { id, file } = z.object({ id: z.uuid(), file: z.string() }).parse(req.params);
      return reply
        .header("cache-control", "no-store")
        .type("image/png")
        .send(await store.image(id, file));
    })
  );
  server.get(
    `${base}/:id/evidence/:kind`,
    {
      schema: {
        operationId: "getA2uiReviewEvidence",
        params: projectRuntimeSchema(
          z.strictObject({ id: z.uuid(), kind: z.enum(["report", "capture", "cases"]) })
        ),
        response: errors
      }
    },
    guarded(async (req, reply) => {
      const { id, kind } = z
        .object({ id: z.uuid(), kind: z.enum(["report", "capture", "cases"]) })
        .parse(req.params);
      return reply
        .header("cache-control", "no-store")
        .type("application/json")
        .send(await store.evidence(id, kind));
    })
  );
}
