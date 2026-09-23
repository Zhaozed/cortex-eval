import {
  AgentTraceV1Schema,
  JevDecisionPlanV1Schema,
  JevDecisionResultV1Schema,
  JevEvaluationRequestV1Schema,
  JevEvaluationResultV1Schema,
  SemanticEvaluationContractV1Schema,
  type AgentTraceV1,
  type JevDecisionPlanV1,
  type JevDecisionResultV1,
  type JevEvaluationRequestV1,
  type JevEvaluationResultV1,
  type SemanticEvaluationContractV1
} from "@cortex-eval/contracts/src/semantic-evaluation-contracts.ts";

import { explainJevDecision } from "./jev-decision-explainer.ts";

export type JevProviderDecision = Omit<
  JevDecisionResultV1,
  "applicable" | "evidence" | "evidenceRefs"
> & {
  readonly evidence?: readonly string[];
};

export interface JevRequestUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface JevProvider {
  readonly id: string;
  readonly model?: string;
  evaluate(
    input: JevEvaluationRequestV1,
    signal?: AbortSignal,
    onUsage?: (usage: JevRequestUsage) => void
  ): Promise<readonly JevProviderDecision[]>;
}

export class JevEvaluationError extends Error {
  constructor(
    code:
      "JEV_REQUEST_INVALID" | "JEV_RESULT_INVALID" | "JEV_DECISION_MISSING" | "JEV_PROVIDER_FAILED",
    options: { readonly cause?: unknown } = {}
  ) {
    super(code, options);
    this.name = "JevEvaluationError";
  }
}

function normalizedScore(
  question: JevDecisionPlanV1["questions"][number],
  decision: JevDecisionResultV1
): number {
  if (question.kind === "BOOLEAN") return decision.value === true ? 1 : 0;
  if (question.kind === "CHOICE") {
    return typeof decision.value === "string" && question.choices?.includes(decision.value) ? 1 : 0;
  }
  if (typeof decision.value !== "number" || question.scale === undefined) return 0;
  const range = question.scale.max - question.scale.min;
  if (range <= 0) return 0;
  return Math.max(0, Math.min(1, (decision.value - question.scale.min) / range));
}

function blockingPass(
  question: JevDecisionPlanV1["questions"][number],
  decision: JevDecisionResultV1,
  threshold: number
): boolean {
  if (question.kind === "BOOLEAN") return decision.value === true;
  return normalizedScore(question, decision) >= threshold;
}

/** Aggregate typed JEV decisions into the platform's release-neutral result. */
export function aggregateJevDecisions(
  contract: SemanticEvaluationContractV1,
  plan: JevDecisionPlanV1,
  decisions: readonly JevDecisionResultV1[],
  trace?: AgentTraceV1
): JevEvaluationResultV1 {
  const byId = new Map(decisions.map((decision) => [decision.questionId, decision]));
  const blockingFailures: string[] = [];
  const scorePassThreshold = contract.scorePassThreshold ?? 0.6;
  const warnings: string[] = [];
  let total = 0;
  let applicableCount = 0;
  const explainedDecisions = decisions.map((decision) => {
    const question = plan.questions.find((item) => item.id === decision.questionId);
    if (question === undefined) return decision;
    const explanation =
      trace === undefined
        ? {
            applicable: decision.applicable,
            reason: decision.reason,
            evidence: [],
            evidenceRefs: []
          }
        : explainJevDecision({ contract, question, decision, trace });
    if (!explanation.applicable) {
      warnings.push(`${question.id}: ${explanation.reason}`);
    }
    const evidenceRefs = [...new Set([...decision.evidenceRefs, ...explanation.evidenceRefs])];
    return {
      ...decision,
      question: question.question,
      blocking: question.blocking,
      verdict: !explanation.applicable
        ? ("NA" as const)
        : blockingPass(question, decision, scorePassThreshold)
          ? ("PASS" as const)
          : ("FAIL" as const),
      passThreshold: question.kind === "BOOLEAN" ? 0.5 : scorePassThreshold,
      applicable: explanation.applicable,
      // The platform explanation is the auditable, contract-based reason. The model's own
      // explanation is retained separately so a vague JEV reason cannot hide a concrete fact.
      reason: explanation.reason,
      platformReason: explanation.reason,
      evidence: [...decision.evidence, ...explanation.evidence],
      evidenceRefs,
      ...(decision.providerReason === undefined && decision.reason !== undefined
        ? { providerReason: decision.reason }
        : {})
    };
  });
  const explainedById = new Map(
    explainedDecisions.map((decision) => [decision.questionId, decision])
  );

  for (const question of plan.questions) {
    const decision = explainedById.get(question.id) ?? byId.get(question.id);
    if (decision === undefined) {
      blockingFailures.push(`${question.id}: JEV 未返回决策`);
      continue;
    }
    if (!decision.applicable) continue;
    const value = normalizedScore(question, decision);
    total += value;
    applicableCount += 1;
    if (question.blocking && !blockingPass(question, decision, scorePassThreshold)) {
      const failureReason =
        decision.platformReason ??
        decision.reason ??
        decision.providerReason ??
        "JEV 未返回可读原因，平台也无法从当前 Trace 归因";
      blockingFailures.push(`${question.id}: ${failureReason}`);
    }
  }

  for (const decision of decisions) {
    if (!plan.questions.some((question) => question.id === decision.questionId)) {
      warnings.push(`${decision.questionId}: JEV 返回了未在计划中的额外决策`);
    }
  }

  const score = applicableCount === 0 ? 0 : total / applicableCount;
  return JevEvaluationResultV1Schema.parse({
    contractVersion: contract.contractVersion,
    passed: blockingFailures.length === 0,
    score,
    decisions: explainedDecisions,
    blockingFailures,
    warnings
  });
}

/** Validate and execute one provider-neutral JEV evaluation. */
export async function evaluateWithJev(input: {
  readonly contract: SemanticEvaluationContractV1;
  readonly plan: JevDecisionPlanV1;
  readonly trace: AgentTraceV1;
  readonly provider: JevProvider;
  readonly signal?: AbortSignal;
}): Promise<JevEvaluationResultV1> {
  const request = JevEvaluationRequestV1Schema.safeParse({
    contract: input.contract,
    plan: input.plan,
    trace: input.trace
  });
  if (!request.success) throw new JevEvaluationError("JEV_REQUEST_INVALID");

  let raw: readonly JevProviderDecision[];
  try {
    raw = await input.provider.evaluate(request.data, input.signal);
  } catch (error) {
    if (error instanceof JevEvaluationError) throw error;
    throw new JevEvaluationError("JEV_PROVIDER_FAILED", { cause: error });
  }
  const parsed = raw.map((item) => JevDecisionResultV1Schema.safeParse(item));
  if (parsed.some((item) => !item.success)) throw new JevEvaluationError("JEV_RESULT_INVALID");
  const decisions = parsed.map((item) => item.data) as JevDecisionResultV1[];
  const expectedIds = new Set(input.plan.questions.map((question) => question.id));
  const missing = input.plan.questions.some(
    (question) => !decisions.some((item) => item.questionId === question.id)
  );
  if (missing) throw new JevEvaluationError("JEV_DECISION_MISSING");
  if (decisions.some((item) => !expectedIds.has(item.questionId))) {
    // Extra decisions are preserved as warnings by the aggregator.
  }
  return aggregateJevDecisions(input.contract, input.plan, decisions, input.trace);
}

/** Small helper for callers that receive untrusted JSON at the application boundary. */
export function parseJevEvaluationInput(input: unknown): JevEvaluationRequestV1 {
  const candidate =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const contract = SemanticEvaluationContractV1Schema.safeParse(candidate.contract);
  const plan = JevDecisionPlanV1Schema.safeParse(candidate.plan);
  const trace = AgentTraceV1Schema.safeParse(candidate.trace);
  if (!contract.success || !plan.success || !trace.success) {
    throw new JevEvaluationError("JEV_REQUEST_INVALID");
  }
  return { contract: contract.data, plan: plan.data, trace: trace.data };
}
