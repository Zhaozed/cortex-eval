import { Readable } from "node:stream";

import type { ImportedReportRun } from "@cortex-eval/application/src/features/execution-imports/execution-import-models.ts";
import type { PlatformReportArtifactCaseInput } from "@cortex-eval/application/src/features/runs/run-artifact-port.ts";
import {
  MetricSummaryV1Schema,
  ReportSummaryV1Schema
} from "@cortex-eval/contracts/src/artifact-contracts.ts";

import { mapAlignedPlatformReportCaseToV1, mapRunReportContextToV1 } from "./report-dto-mappers.ts";

/** Fully reconciled inputs for one imported normalized Report export. */
export interface ImportedReportExportInput {
  /** Imported immutable Report context and identities. */
  readonly run: ImportedReportRun;
  /** Complete aligned normalized Case source. */
  readonly cases: AsyncIterable<PlatformReportArtifactCaseInput>;
  /** Request cancellation propagated to stream production. */
  readonly signal: AbortSignal;
}

// Re-read mutable cancellation state at each streaming boundary.
function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("REQUEST_ABORTED");
}

// Produce the array-bearing Report envelope without retaining Case DTOs in memory.
async function* encodeImportedReport(input: ImportedReportExportInput): AsyncGenerator<Uint8Array> {
  requireActive(input.signal);
  const encoder = new TextEncoder();
  const header = {
    contractVersion: "cortex.report.v1" as const,
    owner: { kind: "EXECUTION" as const, id: input.run.executionId },
    packageId: input.run.packageId,
    completedAt: input.run.completedAt,
    context: mapRunReportContextToV1(input.run),
    evaluationContextHash: input.run.evaluationContextHash,
    evaluationResultSetHash: input.run.evaluationResultSetHash,
    summary: ReportSummaryV1Schema.parse(input.run.reportSummary.summary),
    byMetric: input.run.reportSummary.byMetric.map((item) => MetricSummaryV1Schema.parse(item))
  };
  const serializedHeader = JSON.stringify(header);
  yield encoder.encode(`${serializedHeader.slice(0, -1)},"cases":[`);
  let count = 0;
  for await (const item of input.cases) {
    requireActive(input.signal);
    const reportCase = mapAlignedPlatformReportCaseToV1(item);
    yield encoder.encode(`${count === 0 ? "" : ","}${JSON.stringify(reportCase)}`);
    count += 1;
  }
  requireActive(input.signal);
  if (count !== input.run.reportSummary.summary.total) {
    throw new Error("REPORT_RECONCILIATION_FAILED");
  }
  yield encoder.encode(
    `],"reportResultSetHash":${JSON.stringify(input.run.reportResultSetHash)}}\n`
  );
}

/** Open one bounded-memory normalized Report stream reconstructed from imported facts. */
export function openImportedReportExport(input: ImportedReportExportInput): Readable {
  return Readable.from(encodeImportedReport(input), { objectMode: false });
}
