import {
  JevDecisionResultV1Schema,
  JevProviderConfigV1Schema,
  type JevDecisionResultV1,
  type JevEvaluationRequestV1,
  type JevDecisionQuestionV1
} from "@cortex-eval/contracts/src/semantic-evaluation-contracts.ts";
import type { JevProvider, JevRequestUsage } from "./jev-evaluator.ts";

export interface JevHttpProviderDependencies {
  readonly fetchImpl?: typeof fetch;
  readonly readSecret?: (envKey: string) => string | undefined;
}

export class JevHttpProviderError extends Error {
  constructor(
    code: "JEV_CONFIG_INVALID" | "JEV_HTTP_FAILED" | "JEV_RESPONSE_INVALID",
    details: { readonly status?: number; readonly errorType?: string } = {}
  ) {
    const safeErrorType =
      details.errorType !== undefined && /^[A-Z0-9_]{1,64}$/.test(details.errorType)
        ? details.errorType
        : "HTTP_ERROR";
    const message =
      code === "JEV_HTTP_FAILED" &&
      details.status !== undefined &&
      Number.isInteger(details.status) &&
      details.status >= 100 &&
      details.status <= 599
        ? `${code}:${details.status}:${safeErrorType}`
        : code;
    super(message);
    this.name = "JevHttpProviderError";
  }
}

interface OfficialQuestion {
  readonly type: "noul" | "choice" | "score";
  readonly instructions: string;
  readonly criteria?: Record<string, string> | readonly string[];
}

interface OfficialAnswer extends Record<string, unknown> {
  readonly type?: "noul" | "choice" | "score";
  readonly noul?: unknown;
  readonly choice?: unknown;
  readonly score?: unknown;
  readonly confidence?: unknown;
  readonly probabilities?: unknown;
  readonly reason?: unknown;
  readonly evidence?: unknown;
  readonly explanation?: unknown;
  readonly rationale?: unknown;
  readonly message?: unknown;
}

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";

function officialQuestion(question: JevDecisionQuestionV1): OfficialQuestion {
  if (question.kind === "BOOLEAN") {
    return { type: "noul", instructions: question.question };
  }
  if (question.kind === "CHOICE") {
    return {
      type: "choice",
      instructions: question.question,
      criteria: Object.fromEntries((question.choices ?? []).map((choice) => [choice, choice]))
    };
  }
  const scale = question.scale;
  if (scale === undefined) throw new JevHttpProviderError("JEV_CONFIG_INVALID");
  const criteria: string[] = [];
  for (let value = scale.min; value <= scale.max + scale.step / 100; value += scale.step) {
    const rounded = Number(value.toFixed(10));
    criteria.push(scale.labels?.[String(rounded)] ?? String(rounded));
  }
  return { type: "score", instructions: question.question, criteria };
}

function officialRequest(
  input: JevEvaluationRequestV1,
  model: string
): {
  readonly model: string;
  readonly state: Record<string, unknown>;
  readonly questions: Record<string, OfficialQuestion>;
} {
  return {
    model,
    state: {
      task: input.trace.task,
      contract: input.contract,
      decision_plan: input.plan,
      agent_trace: input.trace,
      ...(input.contract.evaluatorPrompt === undefined
        ? {}
        : { evaluator_prompt: input.contract.evaluatorPrompt })
    },
    questions: Object.fromEntries(
      input.plan.questions.map((question) => [question.id, officialQuestion(question)])
    )
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeHttpErrorType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
  return /^[A-Z0-9_]{1,64}$/.test(normalized) ? normalized : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringifyEvidence(value: unknown): string[] {
  if (typeof value === "string" && value.trim() !== "") return [value];
  if (value !== null && typeof value === "object") {
    return [JSON.stringify(value)];
  }
  return [];
}

function textReason(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim();
}

/** Keep the provider's answer auditable without ever persisting request headers or secrets. */
function boundedProviderResponse(answer: OfficialAnswer): Record<string, unknown> {
  const allowedKeys = [
    "type",
    "noul",
    "choice",
    "score",
    "confidence",
    "probabilities",
    "reason",
    "evidence",
    "explanation",
    "rationale",
    "message"
  ];
  return Object.fromEntries(
    allowedKeys.filter((key) => answer[key] !== undefined).map((key) => [key, answer[key]])
  );
}

function normalizeOfficialAnswer(
  question: JevDecisionQuestionV1,
  answer: OfficialAnswer
): JevDecisionResultV1 {
  const confidence = finiteNumber(answer.confidence);
  const providerReason =
    textReason(answer.reason) ??
    textReason(answer.explanation) ??
    textReason(answer.rationale) ??
    textReason(answer.message);
  const providerEvidence = stringifyEvidence(answer.evidence);
  const evidence = [
    ...providerEvidence.map((item) => `JEV evidence: ${item}`),
    ...(answer.probabilities === undefined
      ? []
      : [`JEV probabilities: ${stringifyEvidence(answer.probabilities)[0] ?? ""}`]),
    ...(providerReason === undefined ? [] : [`JEV reason: ${providerReason}`])
  ];
  const providerResponse = boundedProviderResponse(answer);

  if (question.kind === "BOOLEAN") {
    const noul = finiteNumber(answer.noul);
    if (noul === undefined || noul < 0 || noul > 1) {
      throw new JevHttpProviderError("JEV_RESPONSE_INVALID");
    }
    return JevDecisionResultV1Schema.parse({
      questionId: question.id,
      kind: question.kind,
      value: noul >= 0.5,
      probability: noul,
      ...(confidence === undefined ? {} : { confidence }),
      ...(providerReason === undefined ? {} : { providerReason }),
      providerResponse,
      evidence
    });
  }

  if (question.kind === "CHOICE") {
    if (typeof answer.choice !== "string" || !question.choices?.includes(answer.choice)) {
      throw new JevHttpProviderError("JEV_RESPONSE_INVALID");
    }
    return JevDecisionResultV1Schema.parse({
      questionId: question.id,
      kind: question.kind,
      value: answer.choice,
      ...(confidence === undefined ? {} : { confidence }),
      ...(providerReason === undefined ? {} : { providerReason }),
      providerResponse,
      evidence
    });
  }

  const score = finiteNumber(answer.score);
  const scale = question.scale;
  if (score === undefined || scale === undefined) {
    throw new JevHttpProviderError("JEV_RESPONSE_INVALID");
  }
  const value = scale.min + score * scale.step;
  if (value < scale.min || value > scale.max) {
    throw new JevHttpProviderError("JEV_RESPONSE_INVALID");
  }
  return JevDecisionResultV1Schema.parse({
    questionId: question.id,
    kind: question.kind,
    value,
    ...(confidence === undefined ? {} : { confidence }),
    ...(providerReason === undefined ? {} : { providerReason }),
    providerResponse,
    evidence
  });
}

/** HTTP adapter for TypeSafe's official System One API used by Jev. */
export function createJevHttpProvider(
  rawConfig: unknown,
  dependencies: JevHttpProviderDependencies = {}
): JevProvider {
  const config = JevProviderConfigV1Schema.safeParse(rawConfig);
  if (!config.success) throw new JevHttpProviderError("JEV_CONFIG_INVALID");
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const readSecret: (envKey: string) => string | undefined =
    dependencies.readSecret ?? ((key: string): string | undefined => process.env[key]);

  return {
    id: `jev-http:${config.data.model}`,
    model: config.data.model,
    async evaluate(
      input: JevEvaluationRequestV1,
      signal?: AbortSignal,
      onUsage?: (usage: JevRequestUsage) => void
    ): Promise<readonly JevDecisionResultV1[]> {
      const apiKey =
        config.data.apiKeyEnv === undefined ? undefined : readSecret(config.data.apiKeyEnv);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (apiKey !== undefined && apiKey.trim() !== "") headers.authorization = `Bearer ${apiKey}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.data.timeoutMs);
      const onAbort = (): void => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) controller.abort();
      try {
        const response = await fetchImpl(config.data.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(officialRequest(input, input.contract.model ?? config.data.model)),
          signal: controller.signal
        });
        if (!response.ok) {
          const errorBody: unknown = await response.json().catch(() => undefined);
          const detail = isRecord(errorBody) ? errorBody.detail : undefined;
          const errorType = isRecord(detail) ? safeHttpErrorType(detail.error_type) : undefined;
          throw new JevHttpProviderError("JEV_HTTP_FAILED", {
            status: response.status,
            ...(errorType === undefined ? {} : { errorType })
          });
        }
        const body: unknown = await response.json();
        const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
        const validTokens = (value: unknown): value is number =>
          typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
        onUsage?.({
          ...(validTokens(usage.input_tokens) ? { inputTokens: usage.input_tokens } : {}),
          ...(validTokens(usage.output_tokens) ? { outputTokens: usage.output_tokens } : {})
        });
        if (!isRecord(body) || !isRecord(body.answers)) {
          throw new JevHttpProviderError("JEV_RESPONSE_INVALID");
        }
        const answers = body.answers;
        return input.plan.questions.map((question) => {
          const answer = answers[question.id];
          if (!isRecord(answer)) {
            throw new JevHttpProviderError("JEV_RESPONSE_INVALID");
          }
          return normalizeOfficialAnswer(question, answer);
        });
      } catch (error) {
        if (error instanceof JevHttpProviderError) throw error;
        throw new JevHttpProviderError("JEV_HTTP_FAILED");
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
    }
  };
}

export { DEFAULT_ENDPOINT, DEFAULT_MODEL };
