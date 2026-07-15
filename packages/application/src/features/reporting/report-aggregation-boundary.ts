/**
 * Application-owned pure Report aggregation boundary used by outer persistence adapters.
 * The implementation remains in the dedicated Reporting package.
 */
export {
  createReportAccumulator,
  type ReportAggregationResult
} from "@cortex-eval/reporting/src/report-aggregation.ts";
