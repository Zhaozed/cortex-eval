import type { OfflineRestCaseResult } from "@cortex-eval/application/src/features/runs/offline-rest-execution-service.ts";
import type { RestArtifactCaseV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import type {
  ExecutionV2,
  WorkPackageManifestV2
} from "@cortex-eval/contracts/src/work-package-contracts.ts";

import type { SecureWorkPackageDirectory } from "./secure-work-package-directory.ts";
import { validateFileIntegrity } from "./work-package-file-integrity.ts";
import { readWorkPackageRestArtifact } from "./work-package-rest-artifact-reader.ts";

/** Incremental Domain Result Set hash boundary. */
export interface WorkPackageRestResultSetHasher {
  /** Add one ordered Case result identity. */
  readonly add: (value: {
    /** Stable Case key. */
    readonly caseKey: string;
    /** Frozen Case ordinal. */
    readonly ordinal: number;
    /** Validated semantic result hash. */
    readonly resultHash: string;
  }) => void;
  /** Finalize the nonempty set. */
  readonly finish: () => string;
}

/** Pure Domain hash Ports required to distrust source Artifact hash fields. */
export interface WorkPackageRestSemanticHashing {
  /** Recompute one transport-neutral REST result hash. */
  readonly hashResult: (value: OfflineRestCaseResult) => string;
  /** Create one ordered result-set hasher. */
  readonly createResultSetHasher: () => WorkPackageRestResultSetHasher;
}

/** Complete locked inputs for one source REST retry preflight. */
export interface PrepareWorkPackageRestRetryInput {
  /** Stable package directory owned by the caller's lock session. */
  readonly directory: SecureWorkPackageDirectory;
  /** Frozen package Manifest. */
  readonly manifest: WorkPackageManifestV2;
  /** Fully validated source Execution. */
  readonly sourceExecution: ExecutionV2;
  /** Pure semantic hash Ports. */
  readonly hashing: WorkPackageRestSemanticHashing;
  /** Cancellation signal. */
  readonly signal: AbortSignal;
}

/** Fully preflighted REST version consumed by Evaluation or retry planning. */
export interface PreparedWorkPackageRestResults {
  /** Complete semantic REST Result Set identity. */
  readonly resultSetHash: string;
  /** Second-pass results that revalidate the registered file before consumption. */
  readonly results: AsyncIterable<OfflineRestCaseResult>;
}

// Map strict transport names into the clean Application result model.
export function workPackageRestApplicationResult(value: RestArtifactCaseV1): OfflineRestCaseResult {
  const common = {
    caseKey: value.caseKey,
    ordinal: value.ordinal,
    caseDefinitionHash: value.caseDefinitionHash,
    httpStatus: value.httpStatus,
    durationMs: value.durationMs,
    completedAt: value.completedAt,
    resultHash: value.resultHash,
    provenance:
      value.provenance === null
        ? null
        : {
            sourceKind: "EXECUTION" as const,
            sourceId: value.provenance.sourceId,
            sourceResultHash: value.provenance.sourceResultHash
          }
  };
  if (value.status === "ERROR") {
    return {
      ...common,
      status: value.status,
      providerOutput: null,
      errorType: value.error.type,
      errorMessage: value.error.message
    };
  }
  const providerOutput = value.providerOutput.ok
    ? {
        ok: true as const,
        taskName: value.providerOutput.task_name,
        resolvedConfig: value.providerOutput.resolved_config,
        parsedOutput: value.providerOutput.parsed_output
      }
    : { ok: false as const, errorMessage: value.providerOutput.err_msg };
  return {
    ...common,
    status: value.status,
    httpStatus: value.httpStatus,
    providerOutput,
    errorType: null,
    errorMessage: null
  };
}

// Stream one full pass while aligning Manifest identity and recomputing semantic hashes.
async function* validatedPass(
  input: PrepareWorkPackageRestRetryInput,
  artifact: ExecutionV2["stages"]["REST"]["artifacts"][number]
): AsyncGenerator<OfflineRestCaseResult, string> {
  const reader = readWorkPackageRestArtifact(input.directory.streamFile(artifact.path), {
    packageId: input.manifest.packageId,
    executionId: input.sourceExecution.executionId,
    expectedCaseCount: input.manifest.cases.length,
    expectedSizeBytes: artifact.sizeBytes,
    signal: input.signal
  });
  const resultSetHasher = input.hashing.createResultSetHasher();
  for (;;) {
    const item = await reader.next();
    if (item.done) {
      if (resultSetHasher.finish() !== item.value.resultSetHash) {
        throw new Error("WORK_PACKAGE_HASH_MISMATCH");
      }
      return item.value.resultSetHash;
    }
    const expected = input.manifest.cases[item.value.ordinal];
    if (
      expected?.caseKey !== item.value.caseKey ||
      expected.baseDefinitionHash !== item.value.caseDefinitionHash
    ) {
      throw new Error("WORK_PACKAGE_INVALID");
    }
    const clean = workPackageRestApplicationResult(item.value);
    if (input.hashing.hashResult(clean) !== clean.resultHash) {
      throw new Error("WORK_PACKAGE_HASH_MISMATCH");
    }
    resultSetHasher.add({
      caseKey: clean.caseKey,
      ordinal: clean.ordinal,
      resultHash: clean.resultHash
    });
    yield clean;
  }
}

// Drain one complete validation pass and return its verified semantic set identity.
async function drainValidatedPass(
  pass: AsyncGenerator<OfflineRestCaseResult, string>
): Promise<string> {
  for (;;) {
    const item = await pass.next();
    if (item.done) return item.value;
  }
}

/** Preflight a source REST Artifact, then stream only reusable successful facts. */
export async function prepareWorkPackageRestRetryResults(
  input: PrepareWorkPackageRestRetryInput
): Promise<AsyncIterable<OfflineRestCaseResult>> {
  const prepared = await prepareWorkPackageRestResults(input);
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<OfflineRestCaseResult> {
      for await (const value of prepared.results) {
        if (value.status !== "SUCCEEDED") continue;
        yield {
          ...value,
          provenance: {
            sourceKind: "EXECUTION",
            sourceId: input.sourceExecution.executionId,
            sourceResultHash: value.resultHash
          }
        };
      }
    }
  };
}

/** Preflight one complete registered REST Artifact and expose a verified second pass. */
export async function prepareWorkPackageRestResults(
  input: PrepareWorkPackageRestRetryInput
): Promise<PreparedWorkPackageRestResults> {
  const stage = input.sourceExecution.stages.REST;
  if (stage.status !== "SUCCEEDED" || stage.artifacts.length !== 1) {
    throw new Error("WORK_PACKAGE_INVALID");
  }
  const artifact = stage.artifacts[0];
  if (artifact?.kind !== "REST_RESULTS") throw new Error("WORK_PACKAGE_INVALID");
  await validateFileIntegrity(input.directory, artifact);
  const frozenResultSetHash = await drainValidatedPass(validatedPass(input, artifact));
  return {
    resultSetHash: frozenResultSetHash,
    results: {
      async *[Symbol.asyncIterator](): AsyncGenerator<OfflineRestCaseResult> {
        await validateFileIntegrity(input.directory, artifact);
        const secondPass = validatedPass(input, artifact);
        for (;;) {
          const item = await secondPass.next();
          if (item.done) {
            if (item.value !== frozenResultSetHash) {
              throw new Error("WORK_PACKAGE_HASH_MISMATCH");
            }
            return;
          }
          yield item.value;
        }
      }
    }
  };
}
