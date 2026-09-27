import type {
  LiveMemoryEntityDirectoryV1,
  LiveMemoryObservationV1
} from "@cortex-eval/contracts/src/live-memory-evaluation-contracts.ts";
import type {
  LiveMemoryMemoryDirectoryItemV1,
  MemoryEvaluationExpectedConsolidationV1,
  MemoryEvaluationExpectedMemoryV1,
  MemoryEvaluationExpectedObservationV1,
  MemoryEvaluationExpectedPersonLinkV1,
  MemoryEvaluationExpectedProjectLinkV1,
  MemoryEvaluationInputV1
} from "@cortex-eval/contracts/src/memory-evaluation-contracts.ts";

export interface MemoryEvaluationMetric {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly expected: number;
  readonly actual: number;
  readonly matched: number;
}

export interface MemoryEvaluationScore {
  readonly observationExtraction: MemoryEvaluationMetric;
  readonly personResolution: MemoryEvaluationMetric;
  readonly projectResolution: MemoryEvaluationMetric;
  readonly consolidation: MemoryEvaluationMetric;
  readonly memoryState: MemoryEvaluationMetric;
  readonly retrieval: MemoryEvaluationMetric;
  readonly consumption: MemoryEvaluationMetric;
  readonly safety: {
    readonly passed: boolean;
    readonly violations: readonly string[];
  };
}

const normalize = (value: string): string =>
  value.trim().toLocaleLowerCase().replace(/\s+/g, " ");

const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : "";
  } catch {
    return "";
  }
};

function metric(expected: number, actual: number, matched: number): MemoryEvaluationMetric {
  const precision = actual === 0 ? (expected === 0 ? 1 : 0) : matched / actual;
  const recall = expected === 0 ? 1 : matched / expected;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, expected, actual, matched };
}

function sameObservation(expected: MemoryEvaluationExpectedObservationV1, actual: LiveMemoryObservationV1): boolean {
  return (
    expected.domain === actual.domain &&
    normalize(expected.fact) === normalize(actual.fact) &&
    (expected.memoryKind === undefined || normalize(expected.memoryKind) === normalize(actual.memory_kind))
  );
}

function uniqueMatch<TExpected, TActual>(
  expected: readonly TExpected[],
  actual: readonly TActual[],
  matches: (left: TExpected, right: TActual) => boolean
): number {
  const consumed = new Set<number>();
  let matched = 0;
  for (const left of expected) {
    const index = actual.findIndex((right, candidateIndex) => !consumed.has(candidateIndex) && matches(left, right));
    if (index >= 0) {
      consumed.add(index);
      matched += 1;
    }
  }
  return matched;
}

function actualPersonRefs(
  link: MemoryEvaluationExpectedPersonLinkV1,
  observations: readonly LiveMemoryObservationV1[],
  memories: readonly LiveMemoryMemoryDirectoryItemV1[]
): string[] {
  const emails = new Set(link.emails.map(normalize));
  const hasObservation = observations.some(
    (item) => item.person_emails.some((email) => emails.has(normalize(email)))
  );
  if (!hasObservation) return [];
  return memories
    .filter(
      (item) =>
        item.domain === "PERSON" &&
        item.subject_ref !== null &&
        item.person_emails.some((email) => emails.has(normalize(email)))
    )
    .map((item) => item.subject_ref as string);
}

function observationExtractionScore(
  expected: readonly MemoryEvaluationExpectedObservationV1[],
  actual: readonly LiveMemoryObservationV1[]
): MemoryEvaluationMetric {
  const matched = uniqueMatch(expected, actual, sameObservation);
  return metric(expected.length, actual.length, matched);
}

function personResolutionScore(
  expected: readonly MemoryEvaluationExpectedPersonLinkV1[],
  observations: readonly LiveMemoryObservationV1[],
  memories: readonly LiveMemoryMemoryDirectoryItemV1[]
): MemoryEvaluationMetric {
  const resolved = expected.filter((item) => {
    const refs = actualPersonRefs(item, observations, memories);
    if (!item.shouldResolve) return refs.length === 0;
    return refs.length > 0 && (item.personRef === undefined || refs.includes(item.personRef));
  });
  const actual = new Set(
    observations.flatMap((observation) =>
      observation.person_emails.flatMap((email) =>
        memories
          .filter(
            (memory) =>
              memory.domain === "PERSON" &&
              memory.subject_ref !== null &&
              memory.person_emails.some((candidate) => normalize(candidate) === normalize(email))
          )
          .map((memory) => memory.subject_ref as string)
      )
    )
  ).size;
  return metric(expected.length, actual, resolved.length);
}

function projectResolutionScore(
  expected: readonly MemoryEvaluationExpectedProjectLinkV1[],
  observations: readonly LiveMemoryObservationV1[],
  entities: LiveMemoryEntityDirectoryV1 | null
): MemoryEvaluationMetric {
  const projects = entities?.projects ?? [];
  const matched = expected.filter((item) => {
    const clue = normalize(item.projectClue);
    const observed = observations.some(
      (observation) => observation.domain === "PROJECT" && normalize(observation.fact).includes(clue)
    );
    if (!item.shouldResolve) return !observed;
    return (
      observed &&
      (item.projectRef === undefined || projects.some((project) => project.project_ref === item.projectRef))
    );
  }).length;
  const actual = projects.filter((project) =>
    observations.some(
      (observation) =>
        observation.domain === "PROJECT" &&
        normalize(observation.fact).includes(normalize(project.title))
    )
  ).length;
  return metric(expected.length, actual, matched);
}

function valuesFromReplay(result: unknown): readonly Record<string, unknown>[] {
  if (result === null || typeof result !== "object") return [];
  const record = result as Record<string, unknown>;
  const mutations = record.mutations;
  if (!Array.isArray(mutations)) return [];
  return mutations.filter(
    (item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item)
  );
}

function consolidationMatches(
  expected: MemoryEvaluationExpectedConsolidationV1,
  actual: Record<string, unknown>
): boolean {
  const actualDomain = actual.domain ?? actual.memory_domain;
  const actualKind = actual.memory_kind ?? actual.memoryKind ?? actual.kind;
  const actualDisposition = actual.disposition ?? actual.action;
  const actualMutationType = actual.mutation_type ?? actual.mutationType ?? actual.type;
  const actualRef = actual.memory_ref ?? actual.memoryRef ?? actual.target_memory_ref;
  const actualContent = actual.content ?? actual.new_content;
  return (
    (actualDomain === undefined || actualDomain === expected.domain) &&
    (expected.memoryKind === undefined || normalize(textOf(actualKind)) === normalize(expected.memoryKind)) &&
    (expected.disposition === undefined || actualDisposition === expected.disposition) &&
    (expected.mutationType === undefined || actualMutationType === expected.mutationType) &&
    (expected.memoryRef === undefined || actualRef === expected.memoryRef) &&
    (expected.content === undefined || normalize(textOf(actualContent)) === normalize(expected.content))
  );
}

function consolidationScore(
  expected: readonly MemoryEvaluationExpectedConsolidationV1[],
  replayResults: readonly unknown[]
): MemoryEvaluationMetric {
  const actual = replayResults.flatMap(valuesFromReplay);
  const applicable = expected.filter((item) => item.shouldApply);
  const matched = uniqueMatch(applicable, actual, consolidationMatches);
  return metric(applicable.length, actual.length, matched);
}

function memoryStateMatches(expected: MemoryEvaluationExpectedMemoryV1, actual: LiveMemoryMemoryDirectoryItemV1): boolean {
  return (
    expected.domain === actual.domain &&
    normalize(expected.memoryKind) === normalize(actual.memory_kind) &&
    normalize(expected.content) === normalize(actual.content) &&
    expected.status === actual.status &&
    (expected.memoryRef === undefined || expected.memoryRef === actual.memory_ref) &&
    (expected.subjectRef === undefined || expected.subjectRef === actual.subject_ref)
  );
}

function memoryStateScore(
  expected: readonly MemoryEvaluationExpectedMemoryV1[],
  actual: readonly LiveMemoryMemoryDirectoryItemV1[]
): MemoryEvaluationMetric {
  const matched = uniqueMatch(expected, actual, memoryStateMatches);
  return metric(expected.length, actual.length, matched);
}

function retrievalScore(input: MemoryEvaluationInputV1): MemoryEvaluationMetric {
  const expected = input.caseDefinition.expectedRetrieval;
  const available = textOf(input.candidate === null ? null : (input.candidate as { available_memory?: unknown }).available_memory);
  const required = [...expected.requiredMemoryRefs, ...expected.requiredKeywords];
  const forbidden = [...expected.forbiddenMemoryRefs, ...expected.forbiddenKeywords];
  const matched = required.filter((item) => normalize(available).includes(normalize(item))).length;
  const forbiddenHits = forbidden.filter((item) => normalize(available).includes(normalize(item))).length;
  return metric(required.length + forbidden.length, required.length + forbidden.length, matched + (forbidden.length - forbiddenHits));
}

function consumptionScore(input: MemoryEvaluationInputV1): MemoryEvaluationMetric {
  const expected = input.caseDefinition.expectedConsumption;
  const output = normalize(textOf(input.candidate === null ? null : (input.candidate as { final_output?: unknown }).final_output));
  const required = [...expected.requiredClaims, ...expected.requiredMemoryRefs];
  const forbidden = [...expected.forbiddenClaims, ...expected.forbiddenMemoryRefs];
  const matched = required.filter((item) => output.includes(normalize(item))).length;
  const forbiddenHits = forbidden.filter((item) => output.includes(normalize(item))).length;
  return metric(required.length + forbidden.length, required.length + forbidden.length, matched + (forbidden.length - forbiddenHits));
}

function safetyScore(input: MemoryEvaluationInputV1): MemoryEvaluationScore["safety"] {
  const violations: string[] = [];
  const expectedRefs = new Set(input.caseDefinition.expectedPersonLinks.map((item) => item.personRef).filter(Boolean));
  for (const memory of input.memories) {
    if (memory.domain === "PERSON" && memory.subject_ref !== null && expectedRefs.size > 0 && !expectedRefs.has(memory.subject_ref)) {
      violations.push(`UNEXPECTED_PERSON_REF:${memory.subject_ref}`);
    }
  }
  return { passed: violations.length === 0, violations };
}

/** Deterministic first-pass score; no LLM judge and no network side effects. */
export function scoreMemoryEvaluation(input: MemoryEvaluationInputV1): MemoryEvaluationScore {
  const entities = input.entities as LiveMemoryEntityDirectoryV1 | null;
  return {
    observationExtraction: observationExtractionScore(
      input.caseDefinition.expectedObservations,
      input.observations as LiveMemoryObservationV1[]
    ),
    personResolution: personResolutionScore(
      input.caseDefinition.expectedPersonLinks,
      input.observations as LiveMemoryObservationV1[],
      input.memories
    ),
    projectResolution: projectResolutionScore(
      input.caseDefinition.expectedProjectLinks,
      input.observations as LiveMemoryObservationV1[],
      entities
    ),
    consolidation: consolidationScore(input.caseDefinition.expectedConsolidation, input.replayResults),
    memoryState: memoryStateScore(input.caseDefinition.expectedMemoryState, input.memories),
    retrieval: retrievalScore(input),
    consumption: consumptionScore(input),
    safety: safetyScore(input)
  };
}
