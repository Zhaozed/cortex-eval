import {
  ASSERTION_ISSUES,
  type AssertionIssueCode
} from "@cortex-eval/contracts/src/assertion-rules/authoring-validation.ts";
import { CaseAuthoringV1Schema } from "@cortex-eval/contracts/src/case-authoring-contracts.ts";
import type { Duplex, Readable } from "node:stream";

import { CASE_DEFINITION_V1 } from "@cortex-eval/contracts/src/case-contracts.ts";
import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";
import asStream from "stream-chain/asStream.js";
import { none } from "stream-chain/defs.js";
import gen from "stream-chain/gen.js";
import { jsonlParser } from "stream-chain/jsonl/parser.js";
import fixUtf8Stream from "stream-chain/utils/fixUtf8Stream.js";
import lines from "stream-chain/utils/lines.js";
import { streamArray } from "stream-json/streamers/stream-array.js";

import { mapCaseDefinitionFromV1 } from "./resource-dto-mappers.ts";

/** Supported streamed Case import encodings. */
export enum CaseImportFormat {
  /** One top-level JSON array. */
  JSON_ARRAY = "JSON_ARRAY",
  /** One JSON Case value per non-empty line. */
  JSON_LINES = "JSON_LINES"
}

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
  public readonly issueCode: AssertionIssueCode | null;

  /** Create one safe streamed JSON failure. */
  public constructor(
    code:
      | "VALIDATION_FAILED"
      | "CASE_IMPORT_ITEM_INVALID"
      | "CASE_IMPORT_CANCELLED"
      | "CASE_IMPORT_TOO_LARGE",
    index: number | null = null,
    caseKey = "",
    path = "file",
    issueCode: AssertionIssueCode | null = null
  ) {
    super(code);
    this.name = "CaseImportJsonError";
    this.code = code;
    this.index = index;
    this.caseKey = caseKey;
    this.path = path;
    this.issueCode = issueCode;
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

// Default only an omitted import protocol version; explicit versions remain strictly validated.
function defaultCaseImportContractVersion(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Readonly<Record<string, unknown>>;
  if (Object.hasOwn(source, "contractVersion")) return source;
  return { ...source, contractVersion: CASE_DEFINITION_V1 };
}

// Skip whitespace-only JSONL lines without suppressing malformed non-empty records.
function skipJsonlWhitespaceLine(line: string): string | typeof none {
  return line.trim().length === 0 ? none : line;
}

// Compose UTF-8, line splitting and JSONL stages with strict blank-line handling.
function jsonlCaseParserStream(): Duplex {
  return asStream(gen(fixUtf8Stream(), lines(), skipJsonlWhitespaceLine, jsonlParser()), {
    writableObjectMode: false,
    readableObjectMode: true
  });
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

/** Parse one Case Definition stream with backpressure and per-item validation. */
export async function* parseCaseDefinitionStream(
  source: Readable,
  signal: AbortSignal,
  format: CaseImportFormat = CaseImportFormat.JSON_ARRAY
): AsyncGenerator<CaseDefinition, void, void> {
  if (signal.aborted) {
    source.destroy();
    throw new CaseImportJsonError("CASE_IMPORT_CANCELLED");
  }
  const pipeline =
    format === CaseImportFormat.JSON_LINES
      ? jsonlCaseParserStream()
      : streamArray.withParserAsStream();
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
      const parsed = CaseAuthoringV1Schema.safeParse(defaultCaseImportContractVersion(item.value));
      if (!parsed.success) {
        const path = parsed.error.issues[0]?.path.join(".") ?? "item";
        throw new CaseImportJsonError(
          "CASE_IMPORT_ITEM_INVALID",
          item.key,
          caseKey(item.value),
          path,
          Object.hasOwn(ASSERTION_ISSUES, parsed.error.issues[0]?.message ?? "")
            ? (parsed.error.issues[0]?.message as AssertionIssueCode)
            : null
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
