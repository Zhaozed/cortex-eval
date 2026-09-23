import {
  BriefReplayOutputSchema,
  BriefReplayRequestSchema,
  validateBriefInput
} from "@cortex-eval/contracts/src/brief-evaluation-contracts.ts";
import {
  AgentTraceV1Schema,
  JevDecisionResultV1Schema,
  JevEvaluationResultV1Schema,
  type JevEvaluationResultV1,
  type JevDecisionPlanV1,
  type JevDecisionResultV1,
  type SemanticEvaluationContractV1
} from "@cortex-eval/contracts/src/semantic-evaluation-contracts.ts";
import type { JevProvider } from "./jev-evaluator.ts";

/** Count string leaves in final cards, without counting serialization syntax or keys. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}
const length = (value: string): number => Array.from(value).length;

/** Replay-only evaluator: consumes frozen inputs; never reads live memory or executes Agent tools. */
export async function evaluateBrief(input: {
  contract: SemanticEvaluationContractV1;
  plan: JevDecisionPlanV1;
  requestBody: unknown;
  parsedOutput: unknown;
  provider: JevProvider;
  signal?: AbortSignal | undefined;
}): Promise<JevEvaluationResultV1> {
  const { contract, plan } = input;
  const profile = contract.brief;
  if (!profile) throw new Error("BRIEF_PROFILE_REQUIRED");
  const error = validateBriefInput(profile, input.requestBody);
  if (error) throw new Error(error);
  const request = BriefReplayRequestSchema.parse(input.requestBody);
  const output = BriefReplayOutputSchema.parse(input.parsedOutput);
  if (output.brief_type !== profile.briefType) throw new Error("BRIEF_OUTPUT_TYPE_MISMATCH");
  const trace = AgentTraceV1Schema.parse({
    contractVersion: "cortex.agent-trace.v1",
    task: contract.goal,
    finalAnswer: output.output.text,
    raw: { bundle: request.bundle, generated: output.output }
  });
  input.signal?.throwIfAborted();
  const answers = await input.provider.evaluate({ contract, plan, trace }, input.signal);
  input.signal?.throwIfAborted();
  if (
    answers.length !== plan.questions.length ||
    new Set(answers.map((a) => a.questionId)).size !== answers.length
  )
    throw new Error("BRIEF_JUDGE_DECISION_INVALID");
  const decisions: JevDecisionResultV1[] = [];
  const warnings: string[] = [];
  for (const question of plan.questions) {
    const answer = answers.find((a) => a.questionId === question.id);
    if (answer?.kind !== "CHOICE" || !["PASS", "FAIL", "UNKNOWN"].includes(String(answer.value)))
      throw new Error("BRIEF_JUDGE_DECISION_INVALID");
    if (answer.value === "UNKNOWN") throw new Error(`BRIEF_JUDGE_REVIEW_REQUIRED:${question.id}`);
    const evidence = [...(answer.evidence ?? [])];
    const reason = answer.providerReason ?? answer.reason;
    // HTTP metadata (probabilities/reason labels) is not substantive content evidence.
    const quotes =
      answer.providerResponse === undefined
        ? evidence
            .filter((e) => !/^JEV (?:probabilities|reason): /.test(e))
            .map((e) => e.replace(/^JEV evidence: /, ""))
        : strings(answer.providerResponse.evidence);
    if (!quotes.some((quote) => quote.trim().length > 0) && !reason?.trim())
      throw new Error(`BRIEF_JUDGE_EVIDENCE_MISSING:${question.id}`);
    // A hallucination veto requires an actual output quote, not only a model's unsupported verdict.
    const needsQuote =
      ((question.id.startsWith("brief.P0.") || question.id.startsWith("brief.P1.")) &&
        answer.value === "PASS") ||
      ((question.id.startsWith("brief.P2.") ||
        question.id === "brief.noise" ||
        question.id === "brief.grounded") &&
        answer.value === "FAIL");
    if (needsQuote) {
      const leaves = strings(output.output);
      if (!quotes.some((q) => q.trim().length > 0 && leaves.some((text) => text.includes(q))))
        throw new Error(
          question.id === "brief.grounded"
            ? "BRIEF_HALLUCINATION_QUOTE_MISSING"
            : "BRIEF_JUDGE_EVIDENCE_MISSING"
        );
    }
    const atomic = profile.checklist.find(
      (item) => question.id === `brief.${item.tier}.${item.id}`
    );
    decisions.push(
      JevDecisionResultV1Schema.parse({
        ...answer,
        kind: "BOOLEAN",
        value: answer.value === "PASS",
        evidence,
        reason: reason ?? "见裁判证据",
        applicable: true,
        evidenceRefs: atomic?.sourceRefs.map((ref) => `bundle${ref}`) ?? ["bundle", "generated"],
        platformReason: atomic
          ? `${atomic.tier}：${atomic.assertion}`
          : question.id === "brief.grounded"
            ? "全部材料事实核对；FAIL触发零分门禁"
            : "全局无关信息检查"
      })
    );
  }
  const add = (questionId: string, value: boolean, reason: string): void => {
    decisions.push(
      JevDecisionResultV1Schema.parse({
        questionId,
        kind: "BOOLEAN",
        value,
        reason,
        platformReason: reason,
        evidenceRefs: ["generated"]
      })
    );
  };
  const c = profile.constraints;
  const count = output.output.cards.length;
  const maxCardChars = c.maxCardChars;
  const structure =
    (c.minCards === undefined || count >= c.minCards) &&
    (c.maxCards === undefined || count <= c.maxCards) &&
    (c.maxTextChars === undefined || length(output.output.text) <= c.maxTextChars) &&
    (maxCardChars === undefined ||
      output.output.cards.every(
        (card) => strings(card).reduce((n, text) => n + length(text), 0) <= maxCardChars
      ));
  add(
    "brief.structure",
    structure,
    `卡片数 ${count}；文本字符数 ${length(output.output.text)}；按本Case配置检查，不套用通用1–3张限制`
  );
  const generation = c.allowedGenerationStatuses.includes(output.generation_status);
  add("brief.generation", generation, `生成状态 ${output.generation_status}；未向用户交付`);
  const ratio = (prefix: string): number | null => {
    const items = decisions.filter((d) => d.questionId.startsWith(prefix));
    return items.length === 0 ? null : items.filter((d) => d.value === true).length / items.length;
  };
  const p0 = ratio("brief.P0.");
  const p1 = ratio("brief.P1.");
  const noiseItems = decisions.filter(
    (d) => d.questionId.startsWith("brief.P2.") || d.questionId === "brief.noise"
  );
  const noise = noiseItems.filter((d) => d.value === true).length / noiseItems.length;
  const grounded = decisions.find((d) => d.questionId === "brief.grounded")?.value === true;
  const weight = (p0 === null ? 0 : 0.5) + (p1 === null ? 0 : 0.2) + 0.3;
  const score = grounded ? ((p0 ?? 0) * 0.5 + (p1 ?? 0) * 0.2 + noise * 0.3) / weight : 0;
  for (const [name, value] of [
    ["P0", p0],
    ["P1", p1],
    ["noise", noise]
  ] as const) {
    decisions.push(
      JevDecisionResultV1Schema.parse({
        questionId: `brief.metric.${name}`,
        kind: "SCORE",
        value: value ?? 0,
        applicable: value !== null,
        reason: value === null ? "无该层断言，权重按剩余项归一化" : "代码确定性计算"
      })
    );
  }
  if (p0 === null || p1 === null) warnings.push("空层级不送分，权重在适用层级间归一化");
  const blockingFailures: string[] = [];
  if (!grounded) blockingFailures.push("brief.grounded:事实性捏造，质量得分置零");
  if (!structure) blockingFailures.push("brief.structure:容量约束不符合");
  if (!generation) blockingFailures.push("brief.generation:生成状态不符合Case要求");
  if (score < (contract.scorePassThreshold ?? 0.85))
    blockingFailures.push("brief.score:质量得分低于准入阈值");
  return JevEvaluationResultV1Schema.parse({
    contractVersion: contract.contractVersion,
    passed: blockingFailures.length === 0,
    score,
    decisions,
    blockingFailures,
    warnings
  });
}
