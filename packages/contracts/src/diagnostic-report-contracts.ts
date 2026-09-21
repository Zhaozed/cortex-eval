import { z } from "zod";

const text = z.string().trim().min(1).max(6000);

/** The ownership bucket the diagnosis should be routed to. */
export const DiagnosticFaultDomainSchema = z.enum([
  "TOOLHUB",
  "AGENT",
  "A2UI",
  "FRAMEWORK",
  "EVALUATION",
  "ENVIRONMENT",
  "UNKNOWN"
]);
export type DiagnosticFaultDomain = z.infer<typeof DiagnosticFaultDomainSchema>;

/** The most actionable code/config location to inspect first. */
export const DiagnosticFaultLocationSchema = z.enum([
  "PLANNER_PROMPT",
  "ROUTER_PROMPT",
  "TOOLHUB_CONTRACT",
  "TOOLHUB_IMPLEMENTATION",
  "AGENT_ORCHESTRATION",
  "A2UI_PAYLOAD",
  "A2UI_RENDERING",
  "FRAMEWORK_RUNTIME",
  "EVALUATION_RULE",
  "TEST_DATA",
  "ENVIRONMENT_CONFIG",
  "UNKNOWN"
]);
export type DiagnosticFaultLocation = z.infer<typeof DiagnosticFaultLocationSchema>;

export const DiagnosticAttributionSchema = z.strictObject({
  domain: DiagnosticFaultDomainSchema,
  location: DiagnosticFaultLocationSchema,
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  rationale: text
});
export type DiagnosticAttribution = z.infer<typeof DiagnosticAttributionSchema>;

export const DiagnosisOutputSchema = z.strictObject({
  title: text,
  category: z.enum(["PRODUCT", "ASSERTION", "ENVIRONMENT", "UNKNOWN"]),
  evidenceStatus: z.enum(["SUPPORTED", "HYPOTHESIS", "INSUFFICIENT"]),
  attribution: DiagnosticAttributionSchema.default({
    domain: "UNKNOWN",
    location: "UNKNOWN",
    confidence: "LOW",
    rationale: "旧版本报告未记录结构化归因定位；需要重新生成。"
  }),
  observation: text,
  cause: text,
  evidenceIds: z.array(z.string().min(1).max(80)).max(20),
  alternatives: z.array(text).max(8),
  recommendations: z.array(text).min(1).max(8),
  verification: z.array(text).min(1).max(8)
});
export type DiagnosisOutput = z.infer<typeof DiagnosisOutputSchema>;
const { $schema: _dialect, ...outputSchema } = z.toJSONSchema(DiagnosisOutputSchema);
void _dialect;
export const DiagnosisOutputJsonSchema = outputSchema;

/** 报告正文（聚合后的可读 Markdown），由模型在一次合成调用中生成。 */
const narrativeText = z.string().trim().min(1).max(24000);
export const DiagnosticNarrativeOutputSchema = z.strictObject({ markdown: narrativeText });
export type DiagnosticNarrativeOutput = z.infer<typeof DiagnosticNarrativeOutputSchema>;
const { $schema: _narrativeDialect, ...narrativeOutputSchema } = z.toJSONSchema(
  DiagnosticNarrativeOutputSchema
);
void _narrativeDialect;
export const DiagnosticNarrativeOutputJsonSchema = narrativeOutputSchema;

export const DiagnosticEvidenceSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  source: z.enum(["CASE", "ASSERTIONS", "RESULT", "OUTPUT", "DIFF"]),
  content: z.string().max(32000),
  truncated: z.boolean()
});
export const DiagnosticCaseSchema = z.strictObject({
  caseKey: z.string(),
  ordinal: z.number().int().nonnegative(),
  status: z.enum(["PASS", "FAIL", "EVALUATION_ERROR", "NOT_EVALUATED"]),
  restStatus: z.enum(["SUCCEEDED", "ERROR"]),
  reason: z.string().nullable(),
  resultHash: z.string(),
  assertions: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      metric: z.string(),
      type: z.string(),
      status: z.enum(["FAIL", "ERROR", "SKIPPED"]),
      reason: z.string().nullable()
    })
  ),
  evidence: z.array(DiagnosticEvidenceSchema),
  diagnosis: DiagnosisOutputSchema.nullable(),
  diagnosisError: z.string().nullable()
});
export type DiagnosticCase = z.infer<typeof DiagnosticCaseSchema>;
export const DiagnosticSnapshotSchema = z.strictObject({
  runId: z.uuid(),
  title: z.string(),
  suiteName: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  reportHash: z.string(),
  agentRevision: z.string(),
  summary: z.strictObject({
    total: z.number().int().nonnegative(),
    restError: z.number().int().nonnegative(),
    evalPass: z.number().int().nonnegative(),
    evalFail: z.number().int().nonnegative(),
    evalError: z.number().int().nonnegative(),
    notEvaluated: z.number().int().nonnegative(),
    effectivePassRate: z.number().nullable(),
    evaluatedPassRate: z.number().nullable(),
    coverageRate: z.number().nullable()
  }),
  caseIndex: z.array(z.strictObject({ caseKey: z.string(), status: z.string() })),
  cases: z.array(DiagnosticCaseSchema),
  narrative: z.string().max(24000).nullable().default(null),
  narrativeError: z.string().max(6000).nullable().default(null),
  limitations: z.array(z.string())
});
export type DiagnosticSnapshot = z.infer<typeof DiagnosticSnapshotSchema>;
export const DiagnosticReportSchema = z.strictObject({
  id: z.uuid(),
  runId: z.uuid(),
  version: z.number().int().positive(),
  status: z.enum(["QUEUED", "RUNNING", "COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]),
  phase: z.enum(["SNAPSHOT", "DIAGNOSING", "DONE"]),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  model: z.strictObject({
    configId: z.uuid(),
    name: z.string(),
    provider: z.string(),
    model: z.string(),
    configHash: z.string()
  }),
  promptVersion: z.enum(["diagnostic-report.v1", "diagnostic-report.v2", "diagnostic-report.v3"]),
  completedCases: z.number().int().nonnegative(),
  totalCases: z.number().int().nonnegative(),
  error: z.string().nullable(),
  snapshot: DiagnosticSnapshotSchema.nullable()
});
export type DiagnosticReport = z.infer<typeof DiagnosticReportSchema>;
export const DiagnosticReportListItemSchema = DiagnosticReportSchema.omit({ snapshot: true });
export type DiagnosticReportListItem = z.infer<typeof DiagnosticReportListItemSchema>;
export const DiagnosticReportListSchema = z.array(DiagnosticReportListItemSchema);
export const StartDiagnosticReportSchema = z.strictObject({ modelConfigId: z.uuid() });

export const DIAGNOSTIC_FAULT_DOMAIN_LABELS: Record<DiagnosticFaultDomain, string> = {
  TOOLHUB: "ToolHub 工具 / 契约",
  AGENT: "Agent 决策 / 编排",
  A2UI: "A2UI 卡片链路",
  FRAMEWORK: "框架运行时",
  EVALUATION: "评测规则 / 测试数据",
  ENVIRONMENT: "环境 / 配置",
  UNKNOWN: "暂无法定位"
};
export const DIAGNOSTIC_FAULT_LOCATION_LABELS: Record<DiagnosticFaultLocation, string> = {
  PLANNER_PROMPT: "Planner 提示词",
  ROUTER_PROMPT: "Router 提示词",
  TOOLHUB_CONTRACT: "ToolHub 契约 / Schema",
  TOOLHUB_IMPLEMENTATION: "ToolHub 工具实现",
  AGENT_ORCHESTRATION: "Agent 编排逻辑",
  A2UI_PAYLOAD: "A2UI 出站 Payload",
  A2UI_RENDERING: "A2UI 渲染 / 展示",
  FRAMEWORK_RUNTIME: "评测框架运行时",
  EVALUATION_RULE: "断言规则",
  TEST_DATA: "Case / 测试数据",
  ENVIRONMENT_CONFIG: "环境 / 部署配置",
  UNKNOWN: "暂无法定位"
};
export const DIAGNOSTIC_CONFIDENCE_LABELS = {
  HIGH: "高",
  MEDIUM: "中",
  LOW: "低"
} as const;

export const DIAGNOSTIC_EVIDENCE_LABELS = {
  SUPPORTED: "证据支持（AI 判断，待人工核验）",
  HYPOTHESIS: "推测待验证",
  INSUFFICIENT: "证据不足"
} as const;
export const DIAGNOSTIC_STATUS_LABELS = {
  QUEUED: "整理事实",
  RUNNING: "归因中",
  COMPLETED: "已生成",
  PARTIAL: "部分归因失败",
  FAILED: "生成失败",
  CANCELLED: "已取消"
} as const;
