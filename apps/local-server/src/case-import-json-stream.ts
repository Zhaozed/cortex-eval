import type { Readable } from "node:stream";

import { CaseDefinitionV1Schema } from "@cortex-eval/contracts/src/case-contracts.ts";
import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";
import { streamArray } from "stream-json/streamers/stream-array.js";

import { mapCaseDefinitionFromV1 } from "./resource-dto-mappers.ts";

/** Stable streamed JSON boundary failure. */
export class CaseImportJsonError extends Error {
  /** Stable import boundary code. */
  public readonly code:
    | "VALIDATION_FAILED"
    | "CASE_IMPORT_ITEM_INVALID"
    | "CASE_IMPORT_CANCELLED"
    | "CASE_IMPORT_TOO_LARGE";
  /** Zero-based item order when an assembled Case is invalid. */
  public readonly index: number | null;
  /** Best-effort stable Case key without other submitted content. */
  public readonly caseKey: string;
  /** Stable invalid field path. */
  public readonly path: string;

  /** Create one safe streamed JSON failure. */
  public constructor(
    code:
      | "VALIDATION_FAILED"
      | "CASE_IMPORT_ITEM_INVALID"
      | "CASE_IMPORT_CANCELLED"
      | "CASE_IMPORT_TOO_LARGE",
    index: number | null = null,
    caseKey = "",
    path = "file"
  ) {
    super(code);
    this.name = "CaseImportJsonError";
    this.code = code;
    this.index = index;
    this.caseKey = caseKey;
    this.path = path;
  }
}

// Extract only the safe Case identity from dirty transport data.
function caseKey(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  const metadata = (value as Readonly<Record<string, unknown>>).metadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return "";
  const key = (metadata as Readonly<Record<string, unknown>>).case_id;
  return typeof key === "string" ? key : "";
}

// Decode one stream-array item shape without trusting library output as business data.
function streamItem(value: unknown): { readonly key: number; readonly value: unknown } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Readonly<Record<string, unknown>>;
  return Number.isInteger(source.key) ? { key: source.key as number, value: source.value } : null;
}

// Re-read the mutable AbortSignal without allowing control-flow narrowing to assume stability.
function throwIfImportAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CaseImportJsonError("CASE_IMPORT_CANCELLED");
}

/** Parse a top-level Case Definition array with backpressure and per-item validation. */
export async function* parseCaseDefinitionStream(
  source: Readable,
  signal: AbortSignal
): AsyncGenerator<CaseDefinition, void, void> {
  if (signal.aborted) {
    source.destroy();
    throw new CaseImportJsonError("CASE_IMPORT_CANCELLED");
  }
  const pipeline = streamArray.withParserAsStream();
  const abort = (): void => {
    source.destroy();
    pipeline.destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  source.pipe(pipeline);
  try {
    for await (const dirtyItem of pipeline) {
      throwIfImportAborted(signal);
      const item = streamItem(dirtyItem);
      if (item === null) throw new CaseImportJsonError("VALIDATION_FAILED");
      const parsed = CaseDefinitionV1Schema.safeParse(item.value);
      if (!parsed.success) {
        const path = parsed.error.issues[0]?.path.join(".") ?? "item";
        throw new CaseImportJsonError(
          "CASE_IMPORT_ITEM_INVALID",
          item.key,
          caseKey(item.value),
          path
        );
      }
      yield mapCaseDefinitionFromV1(parsed.data);
    }
  } catch (error) {
    if (error instanceof CaseImportJsonError) throw error;
    throwIfImportAborted(signal);
    throw new CaseImportJsonError("VALIDATION_FAILED");
  } finally {
    signal.removeEventListener("abort", abort);
    source.unpipe(pipeline);
    pipeline.destroy();
    source.destroy();
  }
}
