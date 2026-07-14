import type { PlatformRun, RunArtifactDescriptor } from "../runs/platform-run-models.ts";
import type { PlatformRunTransactionManager } from "../runs/platform-run-ports.ts";
import type { RunArtifactStore } from "../runs/run-artifact-port.ts";
import type { PlatformEvalCaseResult } from "./platform-eval-models.ts";
import type { PlatformEvalTransactionManager } from "./platform-eval-ports.ts";

/** Dependencies for reading immutable, provenance-backed Evaluation facts. */
export interface EvaluationReuseReaderDependencies {
  /** Run snapshot reader. */
  readonly runTransactionManager: PlatformRunTransactionManager;
  /** Normalized Evaluation row reader. */
  readonly evalTransactionManager: PlatformEvalTransactionManager;
  /** Actual immutable Artifact verifier. */
  readonly artifactStore: RunArtifactStore;
}

/** One source selection for reusable Evaluation facts. */
export interface EvaluationReuseReaderInput extends EvaluationReuseReaderDependencies {
  /** Immediate source Run identity. */
  readonly sourceRunId: string;
}

interface VerifiedRunEvaluationFacts {
  /** Frozen Run snapshot. */
  readonly run: PlatformRun;
  /** Complete persisted Evaluation rows. */
  readonly results: readonly PlatformEvalCaseResult[];
  /** Present immutable raw descriptors owned by this Run. */
  readonly rawArtifacts: readonly RunArtifactDescriptor[];
}

const PAGE_LIMIT = 200;

// Compare one evidence reference with one exact immutable descriptor.
function sameArtifact(
  evidence: NonNullable<PlatformEvalCaseResult["rawEvidence"]>,
  artifact: RunArtifactDescriptor
): boolean {
  return (
    evidence.path === artifact.path &&
    evidence.expectedSha256 === artifact.expectedSha256 &&
    evidence.expectedSizeBytes === artifact.expectedSizeBytes
  );
}

// Compare two immutable raw evidence references.
function sameEvidence(
  left: NonNullable<PlatformEvalCaseResult["rawEvidence"]>,
  right: NonNullable<PlatformEvalCaseResult["rawEvidence"]>
): boolean {
  return (
    left.path === right.path &&
    left.expectedSha256 === right.expectedSha256 &&
    left.expectedSizeBytes === right.expectedSizeBytes
  );
}

// Compare descriptors without trusting an Artifact Port to echo the requested manifest entry.
function sameDescriptor(left: RunArtifactDescriptor, right: RunArtifactDescriptor): boolean {
  return (
    left.kind === right.kind &&
    left.path === right.path &&
    left.expectedSha256 === right.expectedSha256 &&
    left.expectedSizeBytes === right.expectedSizeBytes &&
    left.contractVersion === right.contractVersion
  );
}

/** Read only PASS/FAIL facts whose normalized set and original raw evidence are present. */
export async function readArtifactBackedEvaluationResults(
  input: EvaluationReuseReaderInput
): Promise<readonly PlatformEvalCaseResult[]> {
  const cache = new Map<string, Promise<VerifiedRunEvaluationFacts | null>>();

  // Read every row through the bounded cursor owned by the repository contract.
  const readResults = async (runId: string): Promise<readonly PlatformEvalCaseResult[]> => {
    const results: PlatformEvalCaseResult[] = [];
    let afterOrdinal: number | undefined;
    for (;;) {
      const page = await input.evalTransactionManager.execute(async (transaction) =>
        transaction.evaluations.queryResults({
          runId,
          limit: PAGE_LIMIT,
          ...(afterOrdinal === undefined ? {} : { afterOrdinal })
        })
      );
      results.push(...page.items);
      if (page.nextCursor === null) return results;
      if (afterOrdinal !== undefined && page.nextCursor <= afterOrdinal) {
        throw new Error("EVALUATION_REUSE_CURSOR_INVALID");
      }
      afterOrdinal = page.nextCursor;
    }
  };

  // Load one Run only when its normalized set is actually present and uncorrupted.
  const load = (runId: string): Promise<VerifiedRunEvaluationFacts | null> => {
    const existing = cache.get(runId);
    if (existing !== undefined) return existing;
    const pending = (async (): Promise<VerifiedRunEvaluationFacts | null> => {
      const run = await input.runTransactionManager.execute(async (transaction) =>
        transaction.runs.getPlatformRun(runId)
      );
      if (run === null) return null;
      const availability = await input.artifactStore.inspect(run.artifactManifest);
      const present = run.artifactManifest.artifacts.filter((expected) =>
        availability.some(
          (actual) => actual.status === "PRESENT" && sameDescriptor(actual.artifact, expected)
        )
      );
      if (!present.some((artifact) => artifact.kind === "NORMALIZED_EVAL_RESULTS")) return null;
      const results = await readResults(runId);
      return {
        run,
        results,
        rawArtifacts: present.filter((artifact) => artifact.kind === "RAW_PROMPTFOO_EVIDENCE")
      };
    })();
    cache.set(runId, pending);
    return pending;
  };

  // Follow copied-result provenance until the referenced original raw file is reached.
  const isBacked = async (
    runId: string,
    result: PlatformEvalCaseResult,
    visited: ReadonlySet<string>
  ): Promise<boolean> => {
    const key = `${runId}:${result.caseKey}:${result.evalResultHash}`;
    if (visited.has(key) || result.runId !== runId || result.rawEvidence === null) return false;
    const evidence = result.rawEvidence;
    const facts = await load(runId);
    if (facts === null) return false;
    if (facts.rawArtifacts.some((artifact) => sameArtifact(evidence, artifact))) {
      return true;
    }
    const provenance = result.provenance;
    if (provenance?.sourceKind !== "RUN") return false;
    const ancestor = await load(provenance.sourceId);
    if (ancestor === null) return false;
    const source = ancestor.results.find(
      (item) =>
        item.caseKey === result.caseKey && item.evalResultHash === provenance.sourceResultHash
    );
    if (source === undefined) return false;
    const sourceEvidence = source.rawEvidence;
    if (sourceEvidence === null || !sameEvidence(evidence, sourceEvidence)) {
      return false;
    }
    return isBacked(provenance.sourceId, source, new Set([...visited, key]));
  };

  const source = await load(input.sourceRunId);
  if (source === null) return [];
  const reusable: PlatformEvalCaseResult[] = [];
  for (const result of source.results) {
    if (result.status !== "PASS" && result.status !== "FAIL") continue;
    if (await isBacked(input.sourceRunId, result, new Set())) reusable.push(result);
  }
  return reusable;
}
