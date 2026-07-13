import type { DomainJsonObject } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";

/** Current Test Suite aggregate root. */
export interface TestSuite {
  /** Internal identity. */
  readonly id: string;
  /** Unique display name. */
  readonly name: string;
  /** Display description. */
  readonly description: string;
  /** Current Case count. */
  readonly caseCount: number;
  /** Current semantic Suite hash. */
  readonly suiteHash: string;
  /** Optimistic-concurrency token. */
  readonly revision: number;
  /** Creation time. */
  readonly createdAt: string;
  /** Last update time. */
  readonly updatedAt: string;
}

/** Current stored Case with all derived facts. */
export interface StoredTestCase {
  /** Internal identity. */
  readonly id: string;
  /** Owning Suite identity. */
  readonly suiteId: string;
  /** Suite-local stable Case key. */
  readonly caseKey: string;
  /** Zero-based current order. */
  readonly ordinal: number;
  /** Human-readable purpose. */
  readonly description: string;
  /** Derived business module. */
  readonly businessModule: string;
  /** Derived scenario tag. */
  readonly scenarioTag: string;
  /** Derived recursive Assertion types. */
  readonly assertionTypes: readonly string[];
  /** Derived recursive Metric names. */
  readonly metrics: readonly string[];
  /** Complete clean Case Definition. */
  readonly definition: CaseDefinition;
  /** Stable persisted v1 JSON projection. */
  readonly definitionJson: DomainJsonObject;
  /** Sorted referenced Rubric Prompt keys. */
  readonly rubricPromptKeys: readonly string[];
  /** Semantic Case Definition hash. */
  readonly definitionHash: string;
  /** Optimistic-concurrency token. */
  readonly revision: number;
  /** Creation time. */
  readonly createdAt: string;
  /** Last update time. */
  readonly updatedAt: string;
}

/** Stable resource write failure. */
export type CaseWriteError =
  | { readonly code: "SUITE_NOT_FOUND" }
  | { readonly code: "CASE_NOT_FOUND"; readonly caseKey: string }
  | { readonly code: "CASE_IDENTITY_CONFLICT"; readonly caseKey: string }
  | { readonly code: "CASE_DEFINITION_INVALID"; readonly path: string }
  | { readonly code: "CASE_ID_DUPLICATE"; readonly caseKey: string }
  | { readonly code: "RUBRIC_PROMPT_NOT_FOUND"; readonly promptKey: string }
  | {
      readonly code: "RESOURCE_REVISION_CONFLICT";
      readonly actualRevision: number;
      readonly expectedRevision: number;
    };

/** Full-import error with stable item identity and the underlying write fact. */
export interface BatchCaseWriteError {
  /** Batch error discriminator. */
  readonly code: "CASE_IMPORT_ITEM_INVALID";
  /** Zero-based input order. */
  readonly index: number;
  /** Stable Case key from the rejected input. */
  readonly caseKey: string;
  /** Original validation, identity or reference error. */
  readonly cause: CaseWriteError;
}

/** Successful single-Case aggregate write. */
export interface SingleCaseWriteSuccess {
  /** Success discriminator. */
  readonly ok: true;
  /** Stored Case. */
  readonly case: StoredTestCase;
  /** Updated aggregate root. */
  readonly suite: TestSuite;
}

/** Exact single-Case write result. */
export type SingleCaseWriteResult =
  SingleCaseWriteSuccess | { readonly ok: false; readonly error: CaseWriteError };

/** Exact full replacement result. */
export type ReplaceCasesResult =
  | { readonly ok: true; readonly cases: readonly StoredTestCase[]; readonly suite: TestSuite }
  | { readonly ok: false; readonly error: CaseWriteError | BatchCaseWriteError };

/** Exact current Case deletion result. */
export type DeleteCaseResult =
  | { readonly ok: true; readonly suite: TestSuite }
  | { readonly ok: false; readonly error: CaseWriteError };

/** Current Case combination query. */
export interface CaseQuery {
  /** Owning Suite. */
  readonly suiteId: string;
  /** Return items strictly after this Ordinal. */
  readonly afterOrdinal?: number | undefined;
  /** Maximum page size. */
  readonly limit: number;
  /** Case-insensitive literal stable Case-key substring. */
  readonly caseKeyContains?: string | undefined;
  /** Exact business module. */
  readonly businessModule?: string | undefined;
  /** Literal description substring. */
  readonly descriptionContains?: string | undefined;
  /** Exact scenario tag. */
  readonly scenarioTag?: string | undefined;
  /** Exact recursive Assertion type member. */
  readonly assertionType?: string | undefined;
  /** Exact recursive Metric member. */
  readonly metric?: string | undefined;
}

/** Stable current Case page. */
export interface CaseQueryPage {
  /** Ordered current Case facts. */
  readonly items: readonly StoredTestCase[];
  /** Next cursor Ordinal when another page exists. */
  readonly nextAfterOrdinal: number | null;
}

/** Validated Case query result returned by Application. */
export type CaseQueryResult =
  | { readonly ok: true; readonly page: CaseQueryPage }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "CASE_QUERY_INVALID";
        readonly path: "limit" | "afterOrdinal";
      };
    };
