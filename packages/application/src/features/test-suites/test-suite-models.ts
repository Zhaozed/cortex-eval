import type { DomainJsonObject } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";
import type { RunStage, RunStatus } from "@cortex-eval/domain/src/domain-run-state.ts";

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

/** Small current Test Suite list projection. */
export interface TestSuiteSummary {
  /** Internal identity. */
  readonly id: string;
  /** Unique display name. */
  readonly name: string;
  /** Display description. */
  readonly description: string;
  /** Current Case count. */
  readonly caseCount: number;
  /** Optimistic-concurrency token. */
  readonly revision: number;
  /** Last update time. */
  readonly updatedAt: string;
  /** Latest reportable platform or complete offline-import Run for this Suite. */
  readonly latestRun: LatestRunReference | null;
}

/** Small latest reportable Run reference embedded in one Suite summary. */
export interface LatestRunReference {
  /** Internal Run identity. */
  readonly id: string;
  /** Strict source discriminator. */
  readonly sourceType: "PLATFORM" | "OFFLINE_IMPORT";
  /** Current lifecycle status. */
  readonly status: RunStatus;
  /** Current or terminal pipeline stage. */
  readonly stage: RunStage;
  /** Last durable Run update time. */
  readonly updatedAt: string;
}

/** Stable Test Suite list position. */
export interface TestSuitePageCursor {
  /** Last display name. */
  readonly name: string;
  /** Last internal ID tie-breaker. */
  readonly id: string;
}

/** Current Test Suite list query. */
export interface TestSuiteQuery {
  /** Maximum page size. */
  readonly limit: number;
  /** Return Suites strictly after this stable sort tuple. */
  readonly afterCursor?: TestSuitePageCursor | undefined;
}

/** Stable current Test Suite page. */
export interface TestSuiteQueryPage {
  /** Small ordered Suite projections. */
  readonly items: readonly TestSuiteSummary[];
  /** Next stable cursor when another page exists. */
  readonly nextCursor: TestSuitePageCursor | null;
}

/** Validated Test Suite list result. */
export type TestSuiteQueryResult =
  | { readonly ok: true; readonly page: TestSuiteQueryPage }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "TEST_SUITE_QUERY_INVALID";
        readonly path: "limit" | "afterCursor.name" | "afterCursor.id";
      };
    };

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
  /** Return items strictly after this stable sort tuple. */
  readonly afterCursor?: CasePageCursor | undefined;
  /** Maximum page size. */
  readonly limit: number;
  /** Case-insensitive literal stable Case-key substring. */
  readonly caseKeyContains?: string | undefined;
  /** Exact business modules combined with OR. */
  readonly businessModules?: readonly string[] | undefined;
  /** Literal description substring. */
  readonly descriptionContains?: string | undefined;
  /** Exact scenario tags combined with OR. */
  readonly scenarioTags?: readonly string[] | undefined;
  /** Exact recursive Assertion type members combined with OR. */
  readonly assertionTypes?: readonly string[] | undefined;
  /** Exact recursive Metric members combined with OR. */
  readonly metrics?: readonly string[] | undefined;
}

/** Stable Case page position ordered by Ordinal and internal ID. */
export interface CasePageCursor {
  /** Last Case Ordinal. */
  readonly ordinal: number;
  /** Last internal ID tie-breaker. */
  readonly id: string;
}

/** Stable current Case page. */
export interface CaseQueryPage {
  /** Ordered current Case facts. */
  readonly items: readonly StoredTestCase[];
  /** Next stable cursor when another page exists. */
  readonly nextCursor: CasePageCursor | null;
}

/** Validated Case query result returned by Application. */
export type CaseQueryResult =
  | { readonly ok: true; readonly page: CaseQueryPage }
  | {
      readonly ok: false;
      readonly error:
        | {
            readonly code: "CASE_QUERY_INVALID";
            readonly path: "limit" | "afterCursor.ordinal" | "afterCursor.id";
          }
        | { readonly code: "SUITE_NOT_FOUND" };
    };
