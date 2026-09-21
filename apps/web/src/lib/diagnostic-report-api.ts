import {
  DiagnosticReportSchema,
  DiagnosticReportListSchema,
  type DiagnosticReport,
  type DiagnosticReportListItem
} from "@cortex-eval/contracts/src/diagnostic-report-contracts.ts";
import { apiRequestJson } from "./api-client.ts";
const base = (runId: string): string =>
  `/api/v1/runs/${encodeURIComponent(runId)}/diagnostic-reports`;
export const diagnosticReportApi = {
  list: (runId: string, signal: AbortSignal): Promise<DiagnosticReportListItem[]> =>
    apiRequestJson(base(runId), DiagnosticReportListSchema, { signal }, undefined, (values) =>
      values.every((v) => v.runId === runId)
    ),
  get: (runId: string, id: string, signal: AbortSignal): Promise<DiagnosticReport> =>
    apiRequestJson(
      `${base(runId)}/${encodeURIComponent(id)}`,
      DiagnosticReportSchema,
      { signal },
      undefined,
      (v) => v.runId === runId && v.id === id
    ),
  start: (runId: string, modelConfigId: string): Promise<DiagnosticReport> =>
    apiRequestJson(
      base(runId),
      DiagnosticReportSchema,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelConfigId })
      },
      undefined,
      (v) => v.runId === runId && v.model.configId === modelConfigId
    ),
  cancel: (runId: string, id: string): Promise<DiagnosticReport> =>
    apiRequestJson(
      `${base(runId)}/${encodeURIComponent(id)}/cancel`,
      DiagnosticReportSchema,
      { method: "POST" },
      undefined,
      (v) => v.runId === runId && v.id === id
    ),
  exportUrl: (runId: string, id: string, format: "md" | "html"): string =>
    `${base(runId)}/${encodeURIComponent(id)}/export?format=${format}`
};
export type DiagnosticReportApi = typeof diagnosticReportApi;
