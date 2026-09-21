import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  DiagnosticReportSchema,
  DiagnosticReportListSchema,
  StartDiagnosticReportSchema
} from "@cortex-eval/contracts/src/diagnostic-report-contracts.ts";
import { ApiErrorResponseV1Schema } from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import type { DiagnosticReportService } from "./diagnostic-report-service.ts";
import { projectRuntimeSchema } from "./contract-schema-projections.ts";
import { diagnosticReportHtml, diagnosticReportMarkdown } from "./diagnostic-report-render.ts";

export function registerDiagnosticReportRoutes(
  server: FastifyInstance,
  service: DiagnosticReportService
): void {
  const base = "/api/v1/runs/:runId/diagnostic-reports";
  const owner = z.strictObject({ runId: z.uuid() });
  const identity = owner.extend({ reportId: z.uuid() });
  const errors = Object.fromEntries(
    [400, 403, 404, 409, 500].map((code) => [code, projectRuntimeSchema(ApiErrorResponseV1Schema)])
  );
  const guard =
    (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      try {
        return await fn(req, reply);
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (error instanceof z.ZodError || code.startsWith("DIAG_")) {
          const status =
            code === "DIAG_NOT_FOUND" || code === "DIAG_MODEL_NOT_FOUND"
              ? 404
              : code === "DIAG_BUSY" || code === "DIAG_NOT_READY" || code === "DIAG_UNAVAILABLE"
                ? 409
                : 400;
          return reply.code(status).send({
            error: {
              code: "VALIDATION_FAILED",
              path: "diagnosticReport",
              requestId: req.id,
              message:
                code === "DIAG_NOT_READY"
                  ? "完整评测结果尚未就绪。"
                  : code === "DIAG_BUSY"
                    ? "报告任务正在运行，请稍后再试。"
                    : "报告或模型配置不可用，请刷新后重试。"
            }
          });
        }
        throw error;
      }
    };
  server.get(
    base,
    {
      schema: {
        operationId: "listDiagnosticReports",
        params: projectRuntimeSchema(owner),
        response: { ...errors, 200: projectRuntimeSchema(DiagnosticReportListSchema) }
      }
    },
    guard(async (req) => service.store.list(owner.parse(req.params).runId))
  );
  server.post(
    base,
    {
      schema: {
        operationId: "createDiagnosticReport",
        params: projectRuntimeSchema(owner),
        body: projectRuntimeSchema(StartDiagnosticReportSchema),
        response: { ...errors, 202: projectRuntimeSchema(DiagnosticReportSchema) }
      }
    },
    guard(async (req, reply) => {
      const report = await service.start(
        owner.parse(req.params).runId,
        StartDiagnosticReportSchema.parse(req.body).modelConfigId
      );
      return reply.code(202).send(report);
    })
  );
  server.get(
    `${base}/:reportId`,
    {
      schema: {
        operationId: "getDiagnosticReport",
        params: projectRuntimeSchema(identity),
        response: { ...errors, 200: projectRuntimeSchema(DiagnosticReportSchema) }
      }
    },
    guard(async (req) => {
      const p = identity.parse(req.params);
      return service.store.get(p.runId, p.reportId);
    })
  );
  server.post(
    `${base}/:reportId/cancel`,
    {
      schema: {
        operationId: "cancelDiagnosticReport",
        params: projectRuntimeSchema(identity),
        response: { ...errors, 200: projectRuntimeSchema(DiagnosticReportSchema) }
      }
    },
    guard(async (req) => {
      const p = identity.parse(req.params);
      return service.cancel(p.runId, p.reportId);
    })
  );
  const query = z.strictObject({ format: z.enum(["md", "html"]).default("md") });
  server.get(
    `${base}/:reportId/export`,
    {
      schema: {
        operationId: "exportDiagnosticReport",
        params: projectRuntimeSchema(identity),
        querystring: projectRuntimeSchema(query)
      }
    },
    guard(async (req, reply) => {
      const p = identity.parse(req.params);
      const { format } = query.parse(req.query);
      const report = await service.store.get(p.runId, p.reportId);
      reply.header("cache-control", "no-store");
      reply.header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; sandbox"
      );
      reply.header(
        "content-disposition",
        `${format === "html" ? "inline" : "attachment"}; filename="diagnostic-${report.runId}-v${report.version}.${format}"`
      );
      return reply
        .type(format === "md" ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8")
        .send(format === "md" ? diagnosticReportMarkdown(report) : diagnosticReportHtml(report));
    })
  );
  server.addHook("onClose", async () => service.shutdown());
}
