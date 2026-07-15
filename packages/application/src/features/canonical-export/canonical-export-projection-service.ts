import {
  canonicalJson,
  sha256CanonicalJson,
  type DomainJsonObject
} from "@cortex-eval/domain/src/domain-canonical-hash.ts";

/** Closed Canonical Export entity set in byte-stable file order. */
export const CANONICAL_ENTITY_FILE_ORDER = [
  { entityType: "TEST_SUITE", path: "entities/test-suites.jsonl" },
  { entityType: "TEST_CASE", path: "entities/test-cases.jsonl" },
  { entityType: "ENDPOINT_CONFIG", path: "entities/endpoint-configs.jsonl" },
  { entityType: "LLM_CONFIG", path: "entities/llm-configs.jsonl" },
  { entityType: "RUBRIC_PROMPT", path: "entities/rubric-prompts.jsonl" },
  { entityType: "ANALYSIS_PROMPT", path: "entities/analysis-prompts.jsonl" },
  { entityType: "RUN", path: "entities/runs.jsonl" },
  { entityType: "CASE_RESULT", path: "entities/case-results.jsonl" },
  { entityType: "EVAL_RESULT", path: "entities/eval-results.jsonl" },
  { entityType: "CASE_ANALYSIS", path: "entities/case-analyses.jsonl" }
] as const;

/** One closed Canonical Export entity discriminator. */
export type CanonicalEntityType = (typeof CANONICAL_ENTITY_FILE_ORDER)[number]["entityType"];

/** Stable UUID identity used by current resources, Runs and Analysis. */
export interface CanonicalUuidEntityKey {
  /** Persisted UUIDv7 identity. */
  readonly id: string;
}

/** Stable compound identity used by Case and Evaluation results. */
export interface CanonicalResultEntityKey {
  /** Owning immutable Run version. */
  readonly runId: string;
  /** Frozen Suite-local Case key. */
  readonly caseKey: string;
}

/** Explicit natural key without synthetic UUID generation. */
export type CanonicalEntityKey = CanonicalUuidEntityKey | CanonicalResultEntityKey;

/** One strong reference that must resolve inside the same snapshot. */
export interface CanonicalEntityReference {
  /** Referenced entity kind. */
  readonly entityType: CanonicalEntityType;
  /** Referenced natural key. */
  readonly entityKey: CanonicalEntityKey;
}

/** Validated source entity projected by a snapshot adapter. */
export interface CanonicalSourceEntity {
  /** Entity kind and target file. */
  readonly entityType: CanonicalEntityType;
  /** Stable natural key. */
  readonly entityKey: CanonicalEntityKey;
  /** Database-neutral migration payload. */
  readonly payload: DomainJsonObject;
  /** Closed set of strong in-export references. */
  readonly references: readonly CanonicalEntityReference[];
}

/** Immutable snapshot reader isolated from later primary-database writes. */
export interface CanonicalSnapshotReader {
  /** Stream one entity kind in strict binary key order. */
  readonly stream: (entityType: CanonicalEntityType) => AsyncIterable<CanonicalSourceEntity>;
}

/** One expected source Artifact retained as migration metadata. */
export interface CanonicalExpectedArtifact {
  /** Canonical Run that owns the historical fact. */
  readonly owner: { readonly type: "RUN"; readonly key: CanonicalUuidEntityKey };
  /** Closed persisted Artifact kind. */
  readonly kind: string;
  /** Original project-relative Artifact path. */
  readonly sourcePath: string;
  /** Persisted expected file hash. */
  readonly expectedSha256: string;
  /** Persisted expected file size. */
  readonly expectedSizeBytes: number;
}

/** Artifact metadata reader over the same immutable SQLite snapshot. */
export interface CanonicalArtifactSnapshotReader {
  /** Stream descriptors in owner ID then kind binary order. */
  readonly streamArtifacts: () => AsyncIterable<CanonicalExpectedArtifact>;
}

/** File hash and size returned after every line has been durably consumed. */
export interface CanonicalWrittenFileFacts {
  /** SHA-256 of exact file bytes. */
  readonly sha256: string;
  /** Exact file byte length. */
  readonly sizeBytes: number;
}

/** Side-effect boundary for one Canonical entity file. */
export interface CanonicalEntityFileSink {
  /** Consume all canonical lines for one entity kind. */
  readonly write: (
    entityType: CanonicalEntityType,
    lines: AsyncIterable<string>
  ) => Promise<CanonicalWrittenFileFacts>;
}

/** One completed entity file descriptor. */
export interface ProjectedCanonicalEntityFile extends CanonicalWrittenFileFacts {
  /** Entity kind. */
  readonly entityType: CanonicalEntityType;
  /** Fixed export-relative path. */
  readonly path: string;
  /** Exact record count. */
  readonly count: number;
}

/** Pure projection and reference reconciliation result. */
export interface CanonicalProjectionResult {
  /** All ten entity files, including empty files. */
  readonly entityFiles: readonly ProjectedCanonicalEntityFile[];
  /** Total source entities consumed. */
  readonly countsChecked: number;
  /** Total strong references resolved. */
  readonly referencesChecked: number;
}

interface CanonicalProjectedRecord extends DomainJsonObject {
  /** Record protocol identity. */
  readonly contractVersion: "cortex.canonical-entity-record.v1";
  /** Entity discriminator. */
  readonly entityType: CanonicalEntityType;
  /** Natural entity identity. */
  readonly entityKey: DomainJsonObject;
  /** Hash of entity type, key and payload. */
  readonly entityHash: string;
  /** Database-neutral entity facts. */
  readonly payload: DomainJsonObject;
  /** Strong relationships included in read-back reconciliation. */
  readonly references: DomainJsonObject[];
}

// Build an ASCII-safe type-qualified key used for duplicate and reference checks.
function qualifiedKey(entityType: CanonicalEntityType, entityKey: CanonicalEntityKey): string {
  const key =
    "id" in entityKey
      ? `id\u0000${entityKey.id}`
      : `result\u0000${entityKey.runId}\u0000${entityKey.caseKey}`;
  return `${entityType}\u0000${key}`;
}

// Build the per-type binary sorting token without locale-sensitive comparison.
function sortingKey(entityKey: CanonicalEntityKey): string {
  return "id" in entityKey ? entityKey.id : `${entityKey.runId}\u0000${entityKey.caseKey}`;
}

// Copy a strongly typed key into the canonical JSON object boundary.
function jsonEntityKey(entityKey: CanonicalEntityKey): DomainJsonObject {
  return "id" in entityKey
    ? { id: entityKey.id }
    : { runId: entityKey.runId, caseKey: entityKey.caseKey };
}

// Sort and copy explicit references into a deterministic JSON array.
function jsonReferences(references: readonly CanonicalEntityReference[]): DomainJsonObject[] {
  const sorted = [...references].sort((left, right) => {
    const leftKey = qualifiedKey(left.entityType, left.entityKey);
    const rightKey = qualifiedKey(right.entityType, right.entityKey);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      qualifiedKey(previous.entityType, previous.entityKey) ===
        qualifiedKey(current.entityType, current.entityKey)
    ) {
      throw new Error("CANONICAL_REFERENCE_DUPLICATE");
    }
  }
  return sorted.map((reference) => ({
    entityType: reference.entityType,
    entityKey: jsonEntityKey(reference.entityKey)
  }));
}

// Project one validated source entity and bind its key into the semantic hash.
function projectEntity(source: CanonicalSourceEntity): CanonicalProjectedRecord {
  const entityKey = jsonEntityKey(source.entityKey);
  const references = jsonReferences(source.references);
  const hashInput: DomainJsonObject = {
    entityType: source.entityType,
    entityKey,
    payload: source.payload,
    references: [...references]
  };
  return {
    contractVersion: "cortex.canonical-entity-record.v1",
    entityType: source.entityType,
    entityKey,
    entityHash: sha256CanonicalJson(hashInput),
    payload: source.payload,
    references
  };
}

/** Project a validated immutable snapshot into deterministic Canonical JSONL. */
export class CanonicalExportProjectionService {
  /** Write every fixed entity file and reject ordering or reference drift. */
  public async project(
    snapshot: CanonicalSnapshotReader,
    sink: CanonicalEntityFileSink
  ): Promise<CanonicalProjectionResult> {
    const availableKeys = new Set<string>();
    const references: CanonicalEntityReference[] = [];
    const entityFiles: ProjectedCanonicalEntityFile[] = [];
    let countsChecked = 0;

    for (const file of CANONICAL_ENTITY_FILE_ORDER) {
      let count = 0;
      let previousKey: string | null = null;
      const lines = async function* (): AsyncGenerator<string> {
        for await (const source of snapshot.stream(file.entityType)) {
          if (source.entityType !== file.entityType)
            throw new Error("CANONICAL_ENTITY_TYPE_INVALID");
          const currentKey = sortingKey(source.entityKey);
          if (previousKey !== null && currentKey <= previousKey) {
            throw new Error("CANONICAL_ENTITY_ORDER_INVALID");
          }
          previousKey = currentKey;
          availableKeys.add(qualifiedKey(source.entityType, source.entityKey));
          references.push(...source.references);
          count += 1;
          yield `${canonicalJson(projectEntity(source))}\n`;
        }
      };
      const facts = await sink.write(file.entityType, lines());
      countsChecked += count;
      entityFiles.push({ ...file, count, ...facts });
    }

    for (const reference of references) {
      if (!availableKeys.has(qualifiedKey(reference.entityType, reference.entityKey))) {
        throw new Error("CANONICAL_REFERENCE_MISSING");
      }
    }
    return { entityFiles, countsChecked, referencesChecked: references.length };
  }
}
