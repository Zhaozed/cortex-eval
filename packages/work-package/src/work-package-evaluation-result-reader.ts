import type { EvalCaseV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import type {
  ExecutionV2,
  WorkPackageManifestV2
} from "@cortex-eval/contracts/src/work-package-contracts.ts";

import type { SecureWorkPackageDirectory } from "./secure-work-package-directory.ts";
import type { WorkPackageEvalSemanticHashing } from "./work-package-evaluation-retry-reader.ts";
import { validateFileIntegrity } from "./work-package-file-integrity.ts";
import { readWorkPackageNormalizedEvalArtifact } from "./work-package-normalized-eval-artifact-reader.ts";
import {
  prepareWorkPackageRestResults,
  type WorkPackageRestSemanticHashing
} from "./work-package-rest-retry-reader.ts";

type EvaluationArtifact = ExecutionV2["stages"]["EVALUATION"]["artifacts"][number];

/** Strictly verified ordinary Execution Evaluation facts for import or retry. */
export interface PreparedWorkPackageEvaluationResults {
  /** Frozen Evaluation context identity. */
  readonly evaluationContextHash: string;
  /** Complete owner-bound Evaluation Result Set identity. */
  readonly resultSetHash: string;
  /** Registered Raw descriptor verified by bytes without reparsing its body. */
  readonly rawArtifact: EvaluationArtifact;
  /** Second-pass semantic stream that distrusts the source again at consumption. */
  readonly results: AsyncIterable<EvalCaseV1>;
}

/** Complete locked input for one ordinary Evaluation Artifact read. */
export interface PrepareWorkPackageEvaluationResultsInput {
  /** Stable package directory owned by the caller's lock session. */
  readonly directory: SecureWorkPackageDirectory;
  /** Frozen package Manifest. */
  readonly manifest: WorkPackageManifestV2;
  /** Validated source Execution. */
  readonly sourceExecution: ExecutionV2;
  /** Read another validated Execution state by identity. */
  readonly readExecution: (executionId: string) => ExecutionV2 | null;
  /** Pure REST semantic hash Ports. */
  readonly restHashing: WorkPackageRestSemanticHashing;
  /** Pure Eval semantic hash Ports. */
  readonly evalHashing: WorkPackageEvalSemanticHashing;
  /** Cancellation signal. */
  readonly signal: AbortSignal;
}

interface EvaluationReadSummary {
  /** Frozen Evaluation context identity. */
  readonly evaluationContextHash: string;
  /** Complete owner-bound Evaluation Result Set identity. */
  readonly resultSetHash: string;
}

interface EvaluationEvidenceFact {
  /** Stable Case key. */
  readonly caseKey: string;
  /** Frozen Case ordinal. */
  readonly ordinal: number;
  /** Normalized status required for Raw presence rules. */
  readonly status: EvalCaseV1["status"];
  /** Semantic Eval result identity. */
  readonly evalResultHash: string;
  /** Exact immutable Raw reference, if evaluated. */
  readonly rawEvidence: EvalCaseV1["rawEvidence"];
  /** Copy chain edge, if this fact was reused. */
  readonly provenance: EvalCaseV1["provenance"];
}

interface VerifiedEvidenceExecution {
  /** Exact registered Raw descriptor for this version. */
  readonly rawArtifact: EvaluationArtifact;
  /** Minimal verified facts indexed without retaining full normalized payloads. */
  readonly cases: ReadonlyMap<string, EvaluationEvidenceFact>;
}

type EvidenceExecutionCache = Map<string, Promise<VerifiedEvidenceExecution>>;

function invalid(cause?: unknown): Error {
  if (cause instanceof Error && cause.message === "REQUEST_ABORTED") return cause;
  return cause === undefined
    ? new Error("WORK_PACKAGE_INVALID")
    : new Error("WORK_PACKAGE_INVALID", { cause });
}

// Compare one immutable Raw evidence reference with one registered descriptor.
function evidenceMatchesArtifact(
  evidence: NonNullable<EvalCaseV1["rawEvidence"]>,
  rawArtifact: EvaluationArtifact
): boolean {
  return (
    evidence.path === rawArtifact.path &&
    evidence.expectedSha256 === rawArtifact.sha256 &&
    evidence.expectedSizeBytes === rawArtifact.sizeBytes
  );
}

// Compare immutable evidence references across copied Evaluation facts.
function sameEvidence(
  left: NonNullable<EvalCaseV1["rawEvidence"]>,
  right: NonNullable<EvalCaseV1["rawEvidence"]>
): boolean {
  return (
    left.path === right.path &&
    left.expectedSha256 === right.expectedSha256 &&
    left.expectedSizeBytes === right.expectedSizeBytes
  );
}

// Validate the local evidence shape before any provenance traversal.
function localEvidenceShapeMatches(result: EvalCaseV1, rawArtifact: EvaluationArtifact): boolean {
  if (result.status === "NOT_EVALUATED") return true;
  const evidence = result.rawEvidence;
  if (!evidence?.present) return false;
  return result.provenance?.sourceKind !== "EXECUTION"
    ? evidenceMatchesArtifact(evidence, rawArtifact)
    : true;
}

// Stream and recompute every Case identity before returning the bounded envelope summary.
async function* verifiedEvaluationStream(
  input: PrepareWorkPackageEvaluationResultsInput,
  rawArtifact: EvaluationArtifact,
  normalizedArtifact: EvaluationArtifact,
  options: {
    readonly verifyEvidenceChain: boolean;
    readonly verifyRawFile: boolean;
  }
): AsyncGenerator<EvalCaseV1, EvaluationReadSummary> {
  try {
    const evidenceCache: EvidenceExecutionCache = new Map();
    const integrityChecks = [validateFileIntegrity(input.directory, normalizedArtifact)];
    if (options.verifyRawFile) {
      integrityChecks.push(validateFileIntegrity(input.directory, rawArtifact));
    }
    await Promise.all(integrityChecks);
    const preparedRest = await prepareWorkPackageRestResults({
      directory: input.directory,
      manifest: input.manifest,
      sourceExecution: input.sourceExecution,
      hashing: input.restHashing,
      signal: input.signal
    });
    const restReader = preparedRest.results[Symbol.asyncIterator]();
    const evalReader = readWorkPackageNormalizedEvalArtifact(
      input.directory.streamFile(normalizedArtifact.path),
      {
        packageId: input.manifest.packageId,
        executionId: input.sourceExecution.executionId,
        expectedCaseCount: input.manifest.cases.length,
        expectedSizeBytes: normalizedArtifact.sizeBytes,
        signal: input.signal
      }
    );
    const resultSetHasher = input.evalHashing.createResultSetHasher(
      (ordinal): string | null => input.manifest.cases[ordinal]?.caseKey ?? null
    );
    for (;;) {
      const [restStep, evalStep] = await Promise.all([restReader.next(), evalReader.next()]);
      if (evalStep.done) {
        if (!restStep.done) throw invalid();
        const resultSetHash = resultSetHasher.finish(
          { kind: "EXECUTION", id: input.sourceExecution.executionId },
          evalStep.value.evaluationContextHash
        );
        if (resultSetHash !== evalStep.value.resultSetHash) throw invalid();
        return {
          evaluationContextHash: evalStep.value.evaluationContextHash,
          resultSetHash
        };
      }
      if (restStep.done) throw invalid();
      const expected = input.manifest.cases[evalStep.value.ordinal];
      if (
        expected?.caseKey !== evalStep.value.caseKey ||
        restStep.value.caseKey !== evalStep.value.caseKey ||
        restStep.value.ordinal !== evalStep.value.ordinal ||
        !localEvidenceShapeMatches(evalStep.value, rawArtifact) ||
        input.evalHashing.hashResult(evalStep.value) !== evalStep.value.evalResultHash ||
        input.evalHashing.hashFinalResult({
          caseDefinitionHash: expected.baseDefinitionHash,
          restResultHash: restStep.value.resultHash,
          evalResultHash: evalStep.value.evalResultHash
        }) !== evalStep.value.finalCaseResultHash
      ) {
        throw invalid();
      }
      resultSetHasher.add({
        caseKey: evalStep.value.caseKey,
        ordinal: evalStep.value.ordinal,
        evalResultHash: evalStep.value.evalResultHash
      });
      if (
        options.verifyEvidenceChain &&
        !(await verifiedEvidenceChain(
          input,
          input.sourceExecution,
          evalStep.value,
          rawArtifact,
          new Set(),
          evidenceCache
        ))
      ) {
        throw invalid();
      }
      yield evalStep.value;
    }
  } catch (error) {
    if (error instanceof Error && error.message === "WORK_PACKAGE_INVALID") throw error;
    throw invalid(error);
  }
}

// Resolve the exact registered artifacts for one completed Evaluation version.
function evaluationArtifacts(execution: ExecutionV2): {
  readonly rawArtifact: EvaluationArtifact;
  readonly normalizedArtifact: EvaluationArtifact;
} {
  const stage = execution.stages.EVALUATION;
  if (stage.status !== "SUCCEEDED" || stage.artifacts.length !== 2) throw invalid();
  const rawArtifact = stage.artifacts.find(
    (artifact) => artifact.kind === "RAW_PROMPTFOO_EVIDENCE"
  );
  const normalizedArtifact = stage.artifacts.find(
    (artifact) => artifact.kind === "NORMALIZED_EVAL_RESULTS"
  );
  if (rawArtifact === undefined || normalizedArtifact === undefined) throw invalid();
  return { rawArtifact, normalizedArtifact };
}

// Fully verify one source version once while retaining only compact identity facts.
function loadVerifiedEvidenceExecution(
  input: PrepareWorkPackageEvaluationResultsInput,
  execution: ExecutionV2,
  cache: EvidenceExecutionCache
): Promise<VerifiedEvidenceExecution> {
  const existing = cache.get(execution.executionId);
  if (existing !== undefined) return existing;
  const pending = (async (): Promise<VerifiedEvidenceExecution> => {
    const artifacts = evaluationArtifacts(execution);
    const stream = verifiedEvaluationStream(
      { ...input, sourceExecution: execution },
      artifacts.rawArtifact,
      artifacts.normalizedArtifact,
      { verifyEvidenceChain: false, verifyRawFile: true }
    );
    const cases = new Map<string, EvaluationEvidenceFact>();
    for (;;) {
      const step = await stream.next();
      if (step.done) break;
      cases.set(step.value.caseKey, {
        caseKey: step.value.caseKey,
        ordinal: step.value.ordinal,
        status: step.value.status,
        evalResultHash: step.value.evalResultHash,
        rawEvidence: step.value.rawEvidence,
        provenance: step.value.provenance
      });
    }
    return { rawArtifact: artifacts.rawArtifact, cases };
  })();
  cache.set(execution.executionId, pending);
  return pending;
}

// Follow copied-result provenance until the exact present ancestor Raw is reached.
async function verifiedEvidenceChain(
  input: PrepareWorkPackageEvaluationResultsInput,
  execution: ExecutionV2,
  result: EvaluationEvidenceFact,
  rawArtifact: EvaluationArtifact,
  visited: ReadonlySet<string>,
  cache: EvidenceExecutionCache
): Promise<boolean> {
  if (result.status === "NOT_EVALUATED") return true;
  const evidence = result.rawEvidence;
  if (!evidence?.present) return false;
  const provenance = result.provenance;
  if (provenance === null) return evidenceMatchesArtifact(evidence, rawArtifact);
  if (provenance.sourceKind !== "EXECUTION") return false;
  const key = `${execution.executionId}:${result.caseKey}:${result.evalResultHash}`;
  if (visited.has(key)) return false;
  const sourceExecution = input.readExecution(provenance.sourceId);
  if (sourceExecution === null) return false;
  const sourceExecutionFacts = await loadVerifiedEvidenceExecution(input, sourceExecution, cache);
  const source = sourceExecutionFacts.cases.get(result.caseKey);
  if (source?.ordinal !== result.ordinal || source.evalResultHash !== provenance.sourceResultHash) {
    return false;
  }
  const sourceEvidence = source.rawEvidence;
  if (sourceEvidence === null) return false;
  if (!sameEvidence(evidence, sourceEvidence)) return false;
  return await verifiedEvidenceChain(
    input,
    sourceExecution,
    source,
    sourceExecutionFacts.rawArtifact,
    new Set([...visited, key]),
    cache
  );
}

async function validateCompleteStream(
  stream: AsyncGenerator<EvalCaseV1, EvaluationReadSummary>
): Promise<EvaluationReadSummary> {
  for (;;) {
    const step = await stream.next();
    if (step.done) return step.value;
  }
}

/** Preflight complete Evaluation evidence, then expose a second verified semantic pass. */
async function prepareEvaluationResults(
  input: PrepareWorkPackageEvaluationResultsInput,
  options: {
    readonly verifyEvidenceChain: boolean;
    readonly verifyRawFile: boolean;
  }
): Promise<PreparedWorkPackageEvaluationResults> {
  try {
    if (input.signal.aborted) throw new Error("REQUEST_ABORTED");
    const { rawArtifact, normalizedArtifact } = evaluationArtifacts(input.sourceExecution);
    const first = await validateCompleteStream(
      verifiedEvaluationStream(input, rawArtifact, normalizedArtifact, options)
    );
    return {
      ...first,
      rawArtifact,
      results: {
        [Symbol.asyncIterator]: async function* (): AsyncGenerator<EvalCaseV1> {
          const stream = verifiedEvaluationStream(input, rawArtifact, normalizedArtifact, options);
          for (;;) {
            const step = await stream.next();
            if (step.done) {
              if (
                step.value.evaluationContextHash !== first.evaluationContextHash ||
                step.value.resultSetHash !== first.resultSetHash
              ) {
                throw invalid();
              }
              return;
            }
            yield step.value;
          }
        }
      }
    };
  } catch (error) {
    if (error instanceof Error && error.message === "WORK_PACKAGE_INVALID") throw error;
    throw invalid(error);
  }
}

/** Preflight complete Evaluation evidence for retry or platform result import. */
export function prepareWorkPackageEvaluationResults(
  input: PrepareWorkPackageEvaluationResultsInput
): Promise<PreparedWorkPackageEvaluationResults> {
  return prepareEvaluationResults(input, {
    verifyEvidenceChain: true,
    verifyRawFile: true
  });
}

/** Read normalized Evaluation facts for Reporting without depending on Raw file availability. */
export function prepareWorkPackageEvaluationResultsForReport(
  input: PrepareWorkPackageEvaluationResultsInput
): Promise<PreparedWorkPackageEvaluationResults> {
  return prepareEvaluationResults(input, {
    verifyEvidenceChain: false,
    verifyRawFile: false
  });
}
