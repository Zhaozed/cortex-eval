import {
  isFrozenEvaluationRawSource,
  type FrozenEvaluationEngineResult
} from "@cortex-eval/application/src/features/evaluation/frozen-evaluation-engine.ts";
import { RawPromptfooEvidenceArtifactV1Schema } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import type { JsonValue } from "@cortex-eval/contracts/src/contracts-primitives.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

import type {
  PublishedStageArtifact,
  WorkPackageExecutionSession
} from "./work-package-execution-session.ts";
import { publishedStageArtifact } from "./work-package-execution-session.ts";
import { validateDecodedJsonStringBytes } from "./json-value-runtime-limits.ts";
import { compactJsonByteLength, writeCompactJson } from "./work-package-json-stream-writer.ts";

// Return the fixed Promptfoo v3 rows before any Artifact bytes are published.
function promptfooRows(raw: Readonly<Record<string, JsonValue>>): readonly JsonValue[] {
  const results = raw.results;
  if (results === null || typeof results !== "object" || Array.isArray(results)) {
    throw new Error("PROMPTFOO_PROCESS_ERROR");
  }
  if (results.version !== 3 || !Array.isArray(results.results)) {
    throw new Error("PROMPTFOO_PROCESS_ERROR");
  }
  return results.results;
}

// Check every encoded row independently; no aggregate Raw file limit is introduced.
function validateRawRows(raw: Readonly<Record<string, JsonValue>>): void {
  validateDecodedJsonStringBytes(raw, "PROMPTFOO_PROCESS_ERROR");
  for (const row of promptfooRows(raw)) {
    if (compactJsonByteLength(row) > WORK_PACKAGE_RUNTIME_LIMITS.promptfooRawRowBytes) {
      throw new Error("PROMPTFOO_PROCESS_ERROR");
    }
  }
}

// Re-read mutable cancellation state after Artifact IO.
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** Stream and publish one fixed-version Raw Promptfoo Artifact. */
export async function writeWorkPackageRawPromptfooArtifact(
  session: WorkPackageExecutionSession,
  executionId: string,
  value: FrozenEvaluationEngineResult,
  signal: AbortSignal
): Promise<PublishedStageArtifact> {
  let writer:
    Awaited<ReturnType<WorkPackageExecutionSession["createStageArtifactWriter"]>> | undefined;
  try {
    if (signal.aborted) throw new Error("REQUEST_ABORTED");
    const envelope = {
      contractVersion: "promptfoo.0.121.18",
      packageId: session.packageSummary.packageId,
      executionId,
      evaluationContextHash: value.evaluationContextHash,
      exitCode: value.exitCode,
      durationMs: value.durationMs
    } as const;
    writer = await session.createStageArtifactWriter(
      executionId,
      "RAW_PROMPTFOO_EVIDENCE",
      Number.MAX_SAFE_INTEGER
    );
    if (isFrozenEvaluationRawSource(value.raw)) {
      RawPromptfooEvidenceArtifactV1Schema.parse({
        ...envelope,
        raw: { results: { version: 3, results: [] } }
      });
      const prefix = `${JSON.stringify(envelope).slice(0, -1)},"raw":`;
      await writer.append(Buffer.from(prefix, "utf8"));
      for await (const chunk of value.raw.openBytes()) {
        if (isAborted(signal)) throw new Error("REQUEST_ABORTED");
        await writer.append(chunk);
      }
      if (isAborted(signal)) throw new Error("REQUEST_ABORTED");
      await writer.append(Buffer.from("}", "utf8"));
    } else {
      const clean = RawPromptfooEvidenceArtifactV1Schema.parse({ ...envelope, raw: value.raw });
      validateRawRows(clean.raw);
      await writeCompactJson(writer, clean);
    }
    if (isAborted(signal)) throw new Error("REQUEST_ABORTED");
    await writer.append(Buffer.from("\n", "utf8"));
    if (isAborted(signal)) throw new Error("REQUEST_ABORTED");
    const published = await writer.commit();
    return publishedStageArtifact(published, "RAW_PROMPTFOO_EVIDENCE", "promptfoo.0.121.18");
  } catch (error) {
    await writer?.abort();
    if (error instanceof Error && error.message === "REQUEST_ABORTED") throw error;
    if (error instanceof Error && error.message === "PROMPTFOO_PROCESS_ERROR") throw error;
    throw new Error("PROMPTFOO_PROCESS_ERROR", { cause: error });
  }
}
