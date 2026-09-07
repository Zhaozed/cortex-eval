import { ApiErrorResponseV1Schema } from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import {
  RunProgressV1Schema,
  RunStreamEnvelopeV1Schema
} from "@cortex-eval/contracts/src/run-api-contracts.ts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { LocalRunHandlers } from "./application-run-handlers.ts";
import { registerHandlerRoute, type LocalApiHandlerInput } from "./local-server.ts";
import { projectRuntimeSchema } from "./contract-schema-projections.ts";

// Preserve the closed HTTP error surface before the SSE response is opened.
function streamErrorStatus(statusCode: number): 400 | 403 | 404 | 500 {
  switch (statusCode) {
    case 400:
    case 403:
    case 404:
    case 500:
      return statusCode;
    default:
      return 500;
  }
}

const STREAM_LIFETIME_MS = 5_000;
const STREAM_POLL_MS = 250;
type RunEventName =
  | "REST_STARTED"
  | "REST_PROGRESS"
  | "CANCEL_REQUESTED"
  | "REST_COMPLETED"
  | "EVALUATION_STARTED"
  | "EVALUATION_COMPLETED"
  | "RUN_CANCELLED"
  | "RUN_FAILED"
  | "RUN_INTERRUPTED";

// Read cancellation state without relying on control-flow analysis across event callbacks.
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

// Normalize one Fastify params object without trusting its prototype.
function params(value: unknown): Readonly<Record<string, string | undefined>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, typeof item === "string" ? item : undefined])
  );
}

// Await one poll interval or request cancellation.
function waitForPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, STREAM_POLL_MS);
    signal.addEventListener("abort", finish, { once: true });
  });
}

// Infer every event logically entailed by consecutive durable snapshots.
function eventNamesBetween(
  previous: ReturnType<typeof RunProgressV1Schema.parse>,
  current: ReturnType<typeof RunProgressV1Schema.parse>
): readonly RunEventName[] {
  const events: RunEventName[] = [];
  if (previous.cancelRequestedAt === null && current.cancelRequestedAt !== null) {
    events.push("CANCEL_REQUESTED");
  }
  if (current.status === "CANCELLED") return [...events, "RUN_CANCELLED"];
  if (current.status === "FAILED") return [...events, "RUN_FAILED"];
  if (current.status === "INTERRUPTED") return [...events, "RUN_INTERRUPTED"];

  const leftRest = previous.stage === "REST" && current.stage !== "REST";
  const restStarted =
    previous.stage === "REST" &&
    previous.status !== "RUNNING" &&
    (current.status === "RUNNING" || leftRest);
  if (restStarted) events.push("REST_STARTED");
  if (
    previous.stage === "REST" &&
    (current.rest.completed > previous.rest.completed ||
      (current.stage === "REST" && current.status === "RUNNING" && !restStarted))
  ) {
    events.push("REST_PROGRESS");
  }
  if (leftRest) events.push("REST_COMPLETED");

  const enteredEvaluation = previous.stage === "REST" && current.stage === "EVALUATION";
  const crossedEvaluation = previous.stage === "REST" && current.stage === "REPORT";
  const evaluationStarted =
    crossedEvaluation ||
    (current.stage === "EVALUATION" &&
      current.status === "RUNNING" &&
      (enteredEvaluation || previous.status !== "RUNNING"));
  if (evaluationStarted) events.push("EVALUATION_STARTED");
  if ((previous.stage === "EVALUATION" && current.stage === "REPORT") || crossedEvaluation) {
    events.push("EVALUATION_COMPLETED");
  }
  return events;
}

// Write one validated SSE envelope with an explicit event ID.
function writeEnvelope(
  reply: FastifyReply,
  envelope: ReturnType<typeof RunStreamEnvelopeV1Schema.parse>
): void {
  reply.raw.write(`id: ${envelope.sequence}\n`);
  reply.raw.write(`event: ${envelope.type === "SNAPSHOT" ? "snapshot" : "progress"}\n`);
  reply.raw.write(`data: ${JSON.stringify(envelope)}\n\n`);
}

// Build one handler input with the request-owned Abort signal.
function handlerInput(request: FastifyRequest, signal: AbortSignal): LocalApiHandlerInput {
  return {
    params: params(request.params),
    query: request.query,
    body: request.body,
    requestId: request.id,
    signal
  };
}

// Register one finite snapshot-first SSE stream.
function registerRunEventStream(
  server: FastifyInstance,
  controllers: Set<AbortController>,
  handlers: LocalRunHandlers
): void {
  server.get("/api/v1/runs/:runId/events", {
    schema: {
      operationId: "streamRunEvents",
      params: {
        type: "object",
        additionalProperties: false,
        required: ["runId"],
        properties: { runId: { type: "string", minLength: 1 } }
      },
      response: {
        200: {
          content: { "text/event-stream": { schema: { type: "string" } } }
        },
        400: {
          content: {
            "application/json": { schema: projectRuntimeSchema(ApiErrorResponseV1Schema) }
          }
        },
        403: {
          content: {
            "application/json": { schema: projectRuntimeSchema(ApiErrorResponseV1Schema) }
          }
        },
        404: {
          content: {
            "application/json": { schema: projectRuntimeSchema(ApiErrorResponseV1Schema) }
          }
        },
        500: {
          content: {
            "application/json": { schema: projectRuntimeSchema(ApiErrorResponseV1Schema) }
          }
        }
      }
    },
    handler: async (request, reply): Promise<void> => {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      const failResponse = (): void => {
        controller.abort();
        if (!reply.raw.destroyed) reply.raw.destroy();
      };
      controllers.add(controller);
      request.raw.once("aborted", abort);
      request.raw.once("close", abort);
      reply.raw.once("error", failResponse);
      reply.raw.once("close", abort);
      let streamOpened = false;
      try {
        const initialResponse = await handlers.getRunProgress(
          handlerInput(request, controller.signal)
        );
        if (initialResponse.statusCode !== 200) {
          const statusCode = streamErrorStatus(initialResponse.statusCode);
          await reply.code(statusCode).send(initialResponse.body);
          return;
        }
        let previous = RunProgressV1Schema.parse(initialResponse.body);
        reply.hijack();
        streamOpened = true;
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "close",
          "x-accel-buffering": "no"
        });
        reply.raw.write("retry: 1000\n\n");
        writeEnvelope(
          reply,
          RunStreamEnvelopeV1Schema.parse({
            type: "SNAPSHOT",
            sequence: previous.lockRevision,
            progress: previous
          })
        );
        const deadline = Date.now() + STREAM_LIFETIME_MS;
        while (!controller.signal.aborted && Date.now() < deadline) {
          await waitForPoll(controller.signal);
          if (isAborted(controller.signal)) break;
          const response = await handlers.getRunProgress(handlerInput(request, controller.signal));
          if (response.statusCode !== 200) break;
          const current = RunProgressV1Schema.parse(response.body);
          if (current.lockRevision === previous.lockRevision) continue;
          const events = eventNamesBetween(previous, current);
          previous = current;
          for (const event of events) {
            writeEnvelope(
              reply,
              RunStreamEnvelopeV1Schema.parse({
                type: "EVENT",
                sequence: current.lockRevision,
                event,
                progress: current
              })
            );
          }
        }
      } catch (error) {
        if (!streamOpened) throw error;
        controller.abort();
      } finally {
        if (streamOpened && !reply.raw.writableEnded) {
          try {
            reply.raw.end();
          } catch {
            // A disconnected transport already owns its terminal state.
          }
        }
        request.raw.off("aborted", abort);
        request.raw.off("close", abort);
        reply.raw.off("error", failResponse);
        reply.raw.off("close", abort);
        controllers.delete(controller);
      }
    }
  });
}

/** Register the closed Run, Evaluation and Report HTTP/SSE capabilities. */
export function registerRunRoutes(
  server: FastifyInstance,
  controllers: Set<AbortController>,
  handlers: LocalRunHandlers
): void {
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/execution-results/import",
    "importExecutionReport",
    handlers.importExecutionReport,
    16 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/runs/:runId/analyses",
    "startCaseAnalysis",
    handlers.startCaseAnalysis,
    64 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "GET",
    "/api/v1/runs/:runId/analyses/:caseKey",
    "getCurrentCaseAnalysis",
    handlers.getCurrentCaseAnalysis
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/runs/:runId/analyses/:caseKey/reject",
    "rejectAnalysisProposal",
    handlers.rejectAnalysisProposal,
    16 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/runs/:runId/analyses/:caseKey/accept",
    "acceptAnalysisProposal",
    handlers.acceptAnalysisProposal,
    64 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/runs/:runId/analyses/:caseKey/edit-and-accept",
    "editAndAcceptAnalysisProposal",
    handlers.editAndAcceptAnalysisProposal,
    64 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/execution-results/analysis/import",
    "importExecutionAnalysis",
    handlers.importExecutionAnalysis,
    16 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/runs/preflight",
    "preflightRun",
    handlers.preflightRun,
    64 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/runs",
    "createRun",
    handlers.createRun,
    64 * 1024
  );
  registerHandlerRoute(server, controllers, "GET", "/api/v1/runs", "listRuns", handlers.listRuns);
  registerHandlerRoute(
    server,
    controllers,
    "GET",
    "/api/v1/runs/:runId",
    "getRun",
    handlers.getRun
  );
  registerHandlerRoute(
    server,
    controllers,
    "DELETE",
    "/api/v1/runs/:runId",
    "deleteRun",
    handlers.deleteRun
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/runs/:runId/reruns",
    "createRunRerun",
    handlers.createRunRerun,
    64 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "GET",
    "/api/v1/runs/:runId/cases",
    "listRunCases",
    handlers.listRunCases
  );
  registerHandlerRoute(
    server,
    controllers,
    "GET",
    "/api/v1/runs/:runId/cases/:caseKey",
    "getRunCase",
    handlers.getRunCase
  );
  registerHandlerRoute(
    server,
    controllers,
    "GET",
    "/api/v1/runs/:runId/evaluations",
    "listRunEvaluations",
    handlers.listRunEvaluations
  );
  registerHandlerRoute(
    server,
    controllers,
    "GET",
    "/api/v1/runs/:runId/report",
    "getRunReport",
    handlers.getRunReport
  );
  registerHandlerRoute(
    server,
    controllers,
    "GET",
    "/api/v1/runs/:runId/report/cases",
    "listRunReportCases",
    handlers.listRunReportCases
  );
  registerHandlerRoute(
    server,
    controllers,
    "GET",
    "/api/v1/runs/:runId/report/cases/:caseKey",
    "getRunReportCase",
    handlers.getRunReportCase
  );
  registerHandlerRoute(
    server,
    controllers,
    "GET",
    "/api/v1/runs/:runId/report/export",
    "exportRunReport",
    handlers.exportRunReport
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/runs/:runId/start",
    "startRun",
    handlers.startRun,
    64 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/runs/:runId/cancel",
    "cancelRun",
    handlers.cancelRun,
    64 * 1024
  );
  registerRunEventStream(server, controllers, handlers);
}
