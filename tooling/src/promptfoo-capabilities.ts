import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Executable probe identifiers for one Assertion capability. */
export interface AssertionCapabilityProbes {
  /** Positive contract probe identifier. */
  positive: string;
  /** Invalid payload or unavailable capability probe identifier. */
  invalidOrCapabilityError: string;
  /** Importer component alignment probe identifier. */
  importerAlignment: string;
}

/** Declared payload contract for one Assertion type. */
export interface AssertionPayloadContract {
  /** Every legal value shape established from the exact handler implementation. */
  acceptedKinds: AssertionPayloadKind[];
  /** Whether the assertion value is mandatory. */
  valueRequired: boolean;
  /** Whether a numeric threshold is mandatory instead of a value. */
  thresholdRequired: boolean;
}

/** Versioned JSON payload shapes understood by Cortex. */
export type AssertionPayloadKind =
  | "NONE"
  | "STRING"
  | "STRING_LIST"
  | "NUMBER"
  | "BOOLEAN"
  | "NULL"
  | "OBJECT"
  | "ARRAY"
  | "SCRIPT"
  | "URL"
  | "PLUGIN_DEFINED";

/** Stable importer mapping required for every assertion component. */
export interface AssertionImporterAlignment {
  /** Promptfoo result path used by the Importer. */
  resultPath: "gradingResult.componentResults";
  /** Deterministic Cortex identity fields. */
  keys: readonly ["caseKey", "ordinal", "assertionIndex", "definitionHash"];
}

/** One explicit, versioned Promptfoo capability contract. */
export interface AssertionCapability {
  /** Assertion type or versioned wildcard. */
  type: string;
  /** Capability structure kind. */
  kind: "ASSERTION" | "ASSERTION_SET" | "DYNAMIC_PATTERN";
  /** Legal payload shape and requiredness. */
  payload: AssertionPayloadContract;
  /** External execution or protocol dependencies. */
  dependencies: string[];
  /** Boundaries rejected before Promptfoo execution. */
  rejectionBoundaries: string[];
  /** Exact object accepted by Promptfoo 0.121.18 AssertionSchema. */
  schemaProbe: Record<string, unknown>;
  /** Exact source fragment proving handler or special-flow availability. */
  sourceEvidence: string;
  /** Importer alignment contract. */
  importerAlignment: AssertionImporterAlignment;
  /** Named executable probes. */
  probes: AssertionCapabilityProbes;
}

/** Versioned facts stored in source control. */
interface CapabilityFacts {
  /** Exact Promptfoo version. */
  version: string;
  /** Fully expanded capability contracts, including not-* and special types. */
  capabilities: unknown[];
}

// Return whether an untrusted JSON value is a record.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Parse a non-empty string array at the matrix boundary.
function parseStringArray(value: unknown, field: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`PROMPTFOO_MATRIX_${field}`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new Error(`PROMPTFOO_MATRIX_${field}`);
  }
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item === "") {
      throw new Error(`PROMPTFOO_MATRIX_${field}`);
    }
    strings.push(item);
  }
  return strings;
}

// Validate one committed capability without accepting implicit defaults.
function parseCapability(value: unknown, index: number): AssertionCapability {
  if (!isRecord(value)) {
    throw new Error(`PROMPTFOO_MATRIX_CAPABILITY:${index}`);
  }
  const { type, kind, payload, schemaProbe, sourceEvidence, importerAlignment, probes } = value;
  if (typeof type !== "string" || type === "") {
    throw new Error(`PROMPTFOO_MATRIX_TYPE:${index}`);
  }
  if (kind !== "ASSERTION" && kind !== "ASSERTION_SET" && kind !== "DYNAMIC_PATTERN") {
    throw new Error(`PROMPTFOO_MATRIX_KIND:${type}`);
  }
  if (!isRecord(payload)) {
    throw new Error(`PROMPTFOO_MATRIX_PAYLOAD:${type}`);
  }
  const payloadKinds = [
    "NONE",
    "STRING",
    "STRING_LIST",
    "NUMBER",
    "BOOLEAN",
    "NULL",
    "OBJECT",
    "ARRAY",
    "SCRIPT",
    "URL",
    "PLUGIN_DEFINED"
  ];
  if (
    !Array.isArray(payload.acceptedKinds) ||
    payload.acceptedKinds.length === 0 ||
    payload.acceptedKinds.some((item) => !payloadKinds.includes(String(item))) ||
    typeof payload.valueRequired !== "boolean" ||
    typeof payload.thresholdRequired !== "boolean"
  ) {
    throw new Error(`PROMPTFOO_MATRIX_PAYLOAD:${type}`);
  }
  if (!isRecord(schemaProbe) || schemaProbe.type !== type) {
    throw new Error(`PROMPTFOO_MATRIX_SCHEMA_PROBE:${type}`);
  }
  if (typeof sourceEvidence !== "string" || sourceEvidence === "") {
    throw new Error(`PROMPTFOO_MATRIX_SOURCE_EVIDENCE:${type}`);
  }
  if (
    !isRecord(importerAlignment) ||
    importerAlignment.resultPath !== "gradingResult.componentResults" ||
    JSON.stringify(importerAlignment.keys) !==
      JSON.stringify(["caseKey", "ordinal", "assertionIndex", "definitionHash"])
  ) {
    throw new Error(`PROMPTFOO_MATRIX_IMPORTER:${type}`);
  }
  if (
    !isRecord(probes) ||
    typeof probes.positive !== "string" ||
    typeof probes.invalidOrCapabilityError !== "string" ||
    typeof probes.importerAlignment !== "string" ||
    probes.positive === "" ||
    probes.invalidOrCapabilityError === "" ||
    probes.importerAlignment === ""
  ) {
    throw new Error(`PROMPTFOO_MATRIX_PROBES:${type}`);
  }
  return {
    type,
    kind,
    payload: payload as unknown as AssertionPayloadContract,
    dependencies: parseStringArray(value.dependencies, `DEPENDENCIES:${type}`, true),
    rejectionBoundaries: parseStringArray(value.rejectionBoundaries, `REJECTIONS:${type}`, false),
    schemaProbe,
    sourceEvidence,
    importerAlignment: importerAlignment as unknown as AssertionImporterAlignment,
    probes: probes as unknown as AssertionCapabilityProbes
  };
}

// Recursively detect forbidden external references before interpreting payload shape.
function containsString(value: unknown, predicate: (item: string) => boolean): boolean {
  if (typeof value === "string") {
    return predicate(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsString(item, predicate));
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).some((item) => containsString(item, predicate));
}

// Classify one JSON assertion payload without widening unsupported booleans.
function classifyPayload(
  capability: AssertionCapability,
  assertion: Readonly<Record<string, unknown>>
): AssertionPayloadKind | null {
  if (Object.hasOwn(assertion, "value")) {
    const value = assertion.value;
    if (typeof value === "string") {
      if (capability.payload.acceptedKinds.includes("SCRIPT")) {
        return "SCRIPT";
      }
      if (capability.payload.acceptedKinds.includes("URL")) {
        return "URL";
      }
      return "STRING";
    }
    if (typeof value === "number") {
      return "NUMBER";
    }
    if (typeof value === "boolean") {
      return "BOOLEAN";
    }
    if (value === null) {
      return "NULL";
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return "STRING_LIST";
    }
    if (Array.isArray(value)) {
      return "ARRAY";
    }
    if (isRecord(value)) {
      return "OBJECT";
    }
    return null;
  }
  return capability.kind === "ASSERTION_SET" ? "OBJECT" : "NONE";
}

// Enforce the current Cortex Assertion boundary for one explicit capability.
export function validateCapabilityAssertion(
  capability: AssertionCapability,
  assertion: Readonly<Record<string, unknown>>
): string | null {
  if (assertion.type !== capability.type) {
    return "CAPABILITY_TYPE";
  }
  if (Object.hasOwn(assertion, "provider")) {
    return "PROVIDER_OVERRIDE";
  }
  if (containsString(assertion, (item) => item.startsWith("file://"))) {
    return "FILE_REFERENCE";
  }
  if (containsString(assertion, (item) => item.startsWith("package:"))) {
    return "EXTERNAL_MODULE";
  }
  const payloadKind = classifyPayload(capability, assertion);
  if (payloadKind === null) {
    return "CAPABILITY_PAYLOAD_KIND";
  }
  const acceptsPluginPayload = capability.payload.acceptedKinds.includes("PLUGIN_DEFINED");
  const acceptsArrayPayload =
    payloadKind === "STRING_LIST" && capability.payload.acceptedKinds.includes("ARRAY");
  if (
    !acceptsPluginPayload &&
    !acceptsArrayPayload &&
    !capability.payload.acceptedKinds.includes(payloadKind)
  ) {
    return "CAPABILITY_PAYLOAD_KIND";
  }
  if (capability.payload.valueRequired && !Object.hasOwn(assertion, "value")) {
    if (capability.kind !== "ASSERTION_SET") {
      return "CAPABILITY_VALUE_REQUIRED";
    }
  }
  if (capability.payload.thresholdRequired && typeof assertion.threshold !== "number") {
    return "CAPABILITY_THRESHOLD_REQUIRED";
  }
  return null;
}

/** Deterministic identity copied from one component into normalized Importer facts. */
export interface CapabilityComponentIdentity {
  /** Stable Case key. */
  caseKey: string;
  /** Stable assertion ordinal. */
  ordinal: number;
  /** Original assertion index. */
  assertionIndex: number;
  /** Canonical assertion definition hash. */
  definitionHash: string;
}

// Validate component type alignment before accepting deterministic identity fields.
export function mapCapabilityComponentIdentity(
  capability: AssertionCapability,
  component: unknown,
  identity: CapabilityComponentIdentity
): CapabilityComponentIdentity {
  if (!isRecord(component) || !isRecord(component.assertion)) {
    throw new Error(`PROMPTFOO_COMPONENT_SHAPE:${capability.type}`);
  }
  const componentType = component.assertion.type;
  const expectedType = capability.schemaProbe.type;
  if (componentType !== expectedType) {
    throw new Error(`PROMPTFOO_COMPONENT_TYPE:${capability.type}`);
  }
  return { ...identity };
}

// Prove every type against its exact handler registry entry or explicit special flow.
export async function validateCapabilitySourceEvidence(
  root: string,
  matrix: readonly AssertionCapability[]
): Promise<string[]> {
  const [runtimeSource, declarationSource] = await Promise.all([
    readFile(resolve(root, "node_modules/promptfoo/dist/src/index.js"), "utf8"),
    readFile(resolve(root, "node_modules/promptfoo/dist/src/index.d.ts"), "utf8")
  ]);
  const handlerStart = runtimeSource.indexOf("const ASSERTION_HANDLERS = {");
  const handlerEnd = runtimeSource.indexOf("\n};", handlerStart);
  if (handlerStart < 0 || handlerEnd < 0) {
    throw new Error("PROMPTFOO_HANDLER_REGISTRY");
  }
  const handlerBlock = runtimeSource.slice(handlerStart, handlerEnd);
  const handlers = new Map<string, string>();
  for (const match of handlerBlock.matchAll(
    /^\s*(?:"([^"]+)"|([A-Za-z][\w-]*)):\s*(handle[A-Za-z0-9]+)/gm
  )) {
    const type = match[1] ?? match[2];
    const handler = match[3];
    if (type !== undefined && handler !== undefined) {
      handlers.set(type, handler);
    }
  }
  if (handlerBlock.includes("const { handleMeteorAssertion }")) {
    handlers.set("meteor", "handleMeteorAssertion");
  }
  const missing: string[] = [];
  for (const capability of matrix) {
    const baseType = capability.type.startsWith("not-")
      ? capability.type.slice(4)
      : capability.type;
    if (handlers.get(baseType) === capability.sourceEvidence) {
      continue;
    }
    const specialEvidence =
      (baseType === "select-best" &&
        capability.sourceEvidence === "processSelectBestAssertionForTest") ||
      (baseType === "max-score" &&
        capability.sourceEvidence === "processMaxScoreAssertionForTest") ||
      (baseType === "human" && capability.sourceEvidence === 'human: "human";') ||
      (capability.type === "assert-set" &&
        capability.sourceEvidence === 'type: z.ZodLiteral<"assert-set">') ||
      (capability.type === "promptfoo:redteam:*" &&
        capability.sourceEvidence === "`promptfoo:redteam:${string}`");
    const specialSourceExists =
      runtimeSource.includes(capability.sourceEvidence) ||
      declarationSource.includes(capability.sourceEvidence);
    if (!specialEvidence || !specialSourceExists) {
      missing.push(capability.type);
    }
  }
  return missing.sort();
}

// Extract enum values from the exact installed package declaration.
function extractBaseTypes(declaration: string): string[] {
  const block = /declare const BaseAssertionTypesSchema:[\s\S]*?\n}>;/.exec(declaration)?.[0];
  if (!block) {
    throw new Error("PROMPTFOO_ASSERTION_SCHEMA_MISSING");
  }
  return [...block.matchAll(/^\s*(?:"([^"]+)"|([A-Za-z][\w-]*)):\s*"([^"]+)";/gm)].map((match) => {
    const type = match[3];
    if (type === undefined) {
      throw new Error("PROMPTFOO_ASSERTION_TYPE_MISSING");
    }
    return type;
  });
}

// Discover the independent assertion fact set from the installed package types.
export async function discoverPromptfooAssertionTypes(root: string): Promise<string[]> {
  const packageRoot = resolve(root, "node_modules/promptfoo");
  const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (packageJson.version !== "0.121.18") {
    throw new Error(`PROMPTFOO_VERSION:${String(packageJson.version)}`);
  }
  const declaration = await readFile(resolve(packageRoot, "dist/src/index.d.ts"), "utf8");
  const baseTypes = extractBaseTypes(declaration);
  const specialMatch = /type SpecialAssertionTypes = ([^;]+);/.exec(declaration);
  if (!specialMatch || !declaration.includes('type: z.ZodLiteral<"assert-set">')) {
    throw new Error("PROMPTFOO_SPECIAL_SCHEMA_MISSING");
  }
  const specialDeclaration = specialMatch[1];
  if (specialDeclaration === undefined) {
    throw new Error("PROMPTFOO_SPECIAL_SCHEMA_MISSING");
  }
  const specialTypes = [...specialDeclaration.matchAll(/'([^']+)'/g)].map((match) => {
    const type = match[1];
    if (type === undefined) {
      throw new Error("PROMPTFOO_SPECIAL_TYPE_MISSING");
    }
    return type;
  });
  return [
    ...baseTypes,
    ...baseTypes.map((type) => `not-${type}`),
    ...specialTypes,
    "promptfoo:redteam:*",
    "assert-set"
  ].sort();
}

// Load the fully expanded committed matrix without synthesizing capability details.
export async function loadAssertionCapabilityMatrix(root: string): Promise<AssertionCapability[]> {
  const path = resolve(root, "tooling/facts/promptfoo-0.121.18-capabilities.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(raw) || raw.version !== "0.121.18" || !Array.isArray(raw.capabilities)) {
    throw new Error("PROMPTFOO_MATRIX_VERSION");
  }
  const facts = raw as unknown as CapabilityFacts;
  const capabilities = facts.capabilities.map(parseCapability);
  if (new Set(capabilities.map((item) => item.type)).size !== capabilities.length) {
    throw new Error("PROMPTFOO_MATRIX_DUPLICATE_TYPE");
  }
  return capabilities.sort((left, right) => left.type.localeCompare(right.type));
}

// Compare package and committed matrix in both directions.
export function validateCapabilityMatrix(
  sourceTypes: readonly string[],
  matrix: readonly { type: string; kind?: unknown; probes?: unknown }[]
): { missing: string[]; unknown: string[] } {
  const source = new Set(sourceTypes);
  const configured = new Set(matrix.map((item) => item.type));
  return {
    missing: [...source].filter((type) => !configured.has(type)).sort(),
    unknown: [...configured].filter((type) => !source.has(type)).sort()
  };
}
