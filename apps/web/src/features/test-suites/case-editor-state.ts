import {
  AssertionDefinitionV1Schema,
  CaseDefinitionV1Schema,
  type CaseDefinitionV1
} from "@cortex-eval/contracts/src/case-contracts.ts";
import { JsonObjectSchema } from "@cortex-eval/contracts/src/contracts-primitives.ts";
import type { z } from "zod";

/** Explicit Case editor modes sharing one validated Draft. */
export type CaseEditorMode = "STRUCTURED" | "JSON";

/** Shared Case editor state. */
export interface CaseEditorState {
  /** Active editor mode. */
  readonly mode: CaseEditorMode;
  /** Last fully validated Case definition. */
  readonly draft: CaseDefinitionV1;
  /** Current full JSON text, possibly invalid while typing. */
  readonly jsonText: string;
}

/** Fields deliberately surfaced by the structured editor. */
export interface StructuredCaseFields {
  /** Suite-local Case identity. */
  readonly caseId: string;
  /** Human-readable Case description. */
  readonly description: string;
  /** Aggregate Case threshold. */
  readonly threshold: number;
  /** Provider task text. */
  readonly task: string;
  /** External request identity. */
  readonly reqId: string;
  /** External task identity. */
  readonly taskId: string;
  /** Business module filter value. */
  readonly businessModule: string;
  /** Scenario tag filter value. */
  readonly scenarioTag: string;
  /** Opt-in screenshot collection using the real outbound payload. */
  readonly a2uiCapture?: boolean;
}

/** Successful editor transition. */
export interface CaseEditorSuccess {
  /** Successful discriminator. */
  readonly ok: true;
  /** Updated shared editor state. */
  readonly state: CaseEditorState;
}

/** Rejected editor transition that preserves the previous valid Draft. */
export interface CaseEditorFailure {
  /** Failure discriminator. */
  readonly ok: false;
  /** Preserved editor state. */
  readonly state: CaseEditorState;
  /** Stable JSON or Contract error path. */
  readonly errorPath: string;
}

/** Result of parsing one dirty editor boundary. */
export type CaseEditorResult = CaseEditorSuccess | CaseEditorFailure;

// Serialize the validated Draft consistently for the full JSON editor.
function serialize(value: CaseDefinitionV1): string {
  return JSON.stringify(value, null, 2);
}

// Read JSON without allowing parser exception text to become UI content.
function parseJson(
  text: string
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

// Convert the first Zod issue path into a stable dot path.
function issuePath(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined || issue.path.length === 0 ? "$" : issue.path.join(".");
}

/** Create one structured editor from a Contracts-valid server snapshot. */
export function createCaseEditorState(definition: CaseDefinitionV1): CaseEditorState {
  const draft = CaseDefinitionV1Schema.parse(structuredClone(definition));
  return { mode: "STRUCTURED", draft, jsonText: serialize(draft) };
}

/** Replace only structured fields while retaining whole Request Body and Assertions. */
export function applyStructuredCaseFields(
  state: CaseEditorState,
  fields: StructuredCaseFields
): CaseEditorResult {
  const parsed = CaseDefinitionV1Schema.safeParse({
    ...state.draft,
    description: fields.description,
    threshold: fields.threshold,
    vars: { ...state.draft.vars, task: fields.task },
    metadata: {
      case_id: fields.caseId,
      req_id: fields.reqId,
      task_id: fields.taskId,
      business_module: fields.businessModule,
      scenario_tag: fields.scenarioTag,
      ...(fields.a2uiCapture === undefined ? {} : { a2ui_capture: fields.a2uiCapture })
    }
  });
  if (!parsed.success) return { ok: false, state, errorPath: issuePath(parsed.error) };
  return {
    ok: true,
    state: { mode: "STRUCTURED", draft: parsed.data, jsonText: serialize(parsed.data) }
  };
}

/** Strictly replace the Request Body JSON object. */
export function replaceRequestBodyJson(state: CaseEditorState, text: string): CaseEditorResult {
  const raw = parseJson(text);
  if (!raw.ok) return { ok: false, state, errorPath: "vars.request_body" };
  const parsed = JsonObjectSchema.safeParse(raw.value);
  if (!parsed.success) return { ok: false, state, errorPath: "vars.request_body" };
  const draft = CaseDefinitionV1Schema.parse({
    ...state.draft,
    vars: { ...state.draft.vars, request_body: parsed.data }
  });
  return { ok: true, state: { mode: "STRUCTURED", draft, jsonText: serialize(draft) } };
}

/** Strictly replace one complete Assertion JSON object. */
export function replaceAssertionJson(
  state: CaseEditorState,
  index: number,
  text: string
): CaseEditorResult {
  const raw = parseJson(text);
  if (!raw.ok) return { ok: false, state, errorPath: `assert.${index}` };
  const parsed = AssertionDefinitionV1Schema.safeParse(raw.value);
  if (!parsed.success) {
    return { ok: false, state, errorPath: `assert.${index}.${issuePath(parsed.error)}` };
  }
  if (index < 0 || index >= state.draft.assert.length) {
    return { ok: false, state, errorPath: `assert.${index}` };
  }
  const assertions = [...state.draft.assert];
  assertions[index] = parsed.data;
  const draft = CaseDefinitionV1Schema.parse({ ...state.draft, assert: assertions });
  return { ok: true, state: { mode: "STRUCTURED", draft, jsonText: serialize(draft) } };
}

/** Enter full JSON mode and retain dirty text independently from the valid Draft. */
export function updateFullCaseJson(state: CaseEditorState, jsonText: string): CaseEditorState {
  return { ...state, mode: "JSON", jsonText };
}

/** Switch modes only after dirty full JSON passes the Case Contract. */
export function switchCaseEditorMode(
  state: CaseEditorState,
  mode: CaseEditorMode
): CaseEditorResult {
  if (mode === "JSON") {
    return { ok: true, state: { ...state, mode: "JSON", jsonText: serialize(state.draft) } };
  }
  if (state.mode === "STRUCTURED") return { ok: true, state };
  const raw = parseJson(state.jsonText);
  if (!raw.ok) return { ok: false, state, errorPath: "$" };
  const parsed = CaseDefinitionV1Schema.safeParse(raw.value);
  if (!parsed.success) return { ok: false, state, errorPath: issuePath(parsed.error) };
  return {
    ok: true,
    state: { mode: "STRUCTURED", draft: parsed.data, jsonText: serialize(parsed.data) }
  };
}

/** Map one API Case path to the nearest focusable structured editor field. */
export function caseApiPathToEditorField(path: string): string {
  const normalized = path.startsWith("definition.") ? path.slice("definition.".length) : path;
  if (/^assert\.\d+(?:\.|$)/.test(normalized)) {
    return normalized.split(".").slice(0, 2).join(".");
  }
  if (normalized === "vars.request_body" || normalized.startsWith("vars.request_body.")) {
    return "vars.request_body";
  }
  const known = new Set([
    "description",
    "threshold",
    "vars.task",
    "metadata.case_id",
    "metadata.req_id",
    "metadata.task_id",
    "metadata.business_module",
    "metadata.scenario_tag"
  ]);
  return known.has(normalized) ? normalized : "root";
}

/** Validate a whole edited assertion list, including additions and removals. */
export function replaceAllAssertionsJson(
  state: CaseEditorState,
  texts: readonly string[]
): CaseEditorResult {
  const assertions: unknown[] = [];
  for (const [index, text] of texts.entries()) {
    const raw = parseJson(text);
    if (!raw.ok) return { ok: false, state, errorPath: `assert.${index}` };
    assertions.push(raw.value);
  }
  const parsed = CaseDefinitionV1Schema.safeParse({ ...state.draft, assert: assertions });
  if (!parsed.success) return { ok: false, state, errorPath: issuePath(parsed.error) };
  return {
    ok: true,
    state: { mode: "STRUCTURED", draft: parsed.data, jsonText: serialize(parsed.data) }
  };
}
