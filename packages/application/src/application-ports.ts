import type {
  StoredTestCase,
  TestSuite,
  TestSuiteQuery,
  TestSuiteQueryPage,
  CaseQuery,
  CaseQueryPage
} from "./features/test-suites/test-suite-models.ts";
import type {
  ConfigurationQuery,
  ConfigurationQueryPage,
  ConfigurationResource,
  ConfigurationResourceKind,
  RubricPromptReference
} from "./features/configurations/configuration-models.ts";
import type {
  ExistingImportedExecution,
  ImportedExecutionRecord
} from "./features/execution-imports/execution-import-models.ts";

/** Test Suite persistence operations available inside one transaction. */
export interface TestSuiteRepository {
  /** Insert one empty current Suite aggregate. */
  insertSuite(value: TestSuite): Promise<"INSERTED" | "NAME_CONFLICT">;
  /** Read one current Suite. */
  getSuite(suiteId: string): Promise<TestSuite | null>;
  /** List all current Suites in stable display order. */
  listSuites(): Promise<readonly TestSuite[]>;
  /** Query one small current Suite page without loading Case definitions. */
  querySuites(query: TestSuiteQuery): Promise<TestSuiteQueryPage>;
  /** Read one current Case by stable key. */
  getCase(suiteId: string, caseKey: string): Promise<StoredTestCase | null>;
  /** Read all current Cases in Ordinal order. */
  listCases(suiteId: string): Promise<readonly StoredTestCase[]>;
  /** Query current Cases with stable cursor and exact combination filters. */
  queryCases(query: CaseQuery): Promise<CaseQueryPage>;
  /** Insert one prepared current Case. */
  insertCase(value: StoredTestCase): Promise<void>;
  /** Conditionally update one current Case. */
  updateCase(value: StoredTestCase, expectedRevision: number): Promise<boolean>;
  /** Conditionally delete one current Case. */
  deleteCase(suiteId: string, caseKey: string, expectedRevision: number): Promise<boolean>;
  /** Atomically replace all current Cases for one Suite. */
  replaceCases(suiteId: string, values: readonly StoredTestCase[]): Promise<void>;
  /** Update aggregate facts only when the current Revision matches. */
  updateSuiteAggregate(input: UpdateSuiteAggregate): Promise<TestSuite | null>;
  /** Conditionally update Suite display fields and Revision. */
  updateSuiteDetails(
    value: TestSuite,
    expectedRevision: number
  ): Promise<TestSuite | "NAME_CONFLICT" | null>;
  /** Conditionally delete one current Suite and cascade current Cases. */
  deleteSuite(suiteId: string, expectedRevision: number): Promise<boolean>;
}

/** Current-resource types that can be protected by an active Run reference. */
export type ActiveRunResourceKind = "TEST_SUITE" | "ENDPOINT" | "LLM";

/** Narrow Run lookup used by resource deletion transactions. */
export interface RunReferenceRepository {
  /** Check READY/RUNNING references without exposing Run orchestration. */
  hasActiveResourceReference(kind: ActiveRunResourceKind, resourceId: string): Promise<boolean>;
  /** Read an already imported offline Execution identity. */
  getImportedExecution(executionId: string): Promise<ExistingImportedExecution | null>;
  /** Insert one already-validated minimal imported Run fact. */
  insertImportedExecution(value: ImportedExecutionRecord): Promise<void>;
}

/** Conditional Suite aggregate update. */
export interface UpdateSuiteAggregate {
  /** Target Suite. */
  readonly suiteId: string;
  /** Caller Revision token. */
  readonly expectedRevision: number;
  /** Recomputed Case count. */
  readonly caseCount: number;
  /** Recomputed semantic Suite hash. */
  readonly suiteHash: string;
  /** Update timestamp. */
  readonly updatedAt: string;
}

/** Configuration persistence facts required by resource transactions. */
export interface ConfigurationRepository {
  /** Return the first missing Rubric Prompt key in supplied stable order. */
  findMissingRubricPromptKey(keys: readonly string[]): Promise<string | null>;
  /** Read one current Configuration resource. */
  getResource(kind: ConfigurationResourceKind, id: string): Promise<ConfigurationResource | null>;
  /** List one current Configuration resource family. */
  listResources(kind: ConfigurationResourceKind): Promise<readonly ConfigurationResource[]>;
  /** Query one small current Configuration page without loading definitions. */
  queryResources(query: ConfigurationQuery): Promise<ConfigurationQueryPage>;
  /** Insert one prepared current Configuration resource. */
  insertResource(
    value: ConfigurationResource
  ): Promise<"INSERTED" | "NAME_CONFLICT" | "PROMPT_KEY_CONFLICT">;
  /** Conditionally replace one current resource and increment its Revision. */
  updateResource(
    value: ConfigurationResource,
    expectedRevision: number
  ): Promise<ConfigurationResource | "NAME_CONFLICT" | "PROMPT_KEY_CONFLICT" | null>;
  /** Conditionally delete one current resource. */
  deleteResource(
    kind: ConfigurationResourceKind,
    id: string,
    expectedRevision: number
  ): Promise<boolean>;
  /** Check whether a current Case references one Rubric Prompt key. */
  isRubricPromptReferenced(promptKey: string): Promise<boolean>;
  /** List current Case references to one Rubric Prompt key. */
  listRubricPromptReferences(promptKey: string): Promise<readonly RubricPromptReference[]>;
}

/** Repository set exposed to a managed short transaction callback. */
export interface ApplicationTransaction {
  /** Transaction-bound Suite repository. */
  readonly testSuites: TestSuiteRepository;
  /** Transaction-bound Configuration repository. */
  readonly configurations: ConfigurationRepository;
  /** Transaction-bound narrow Run reference lookup. */
  readonly runs: RunReferenceRepository;
}

/** Managed transaction boundary that exposes repositories but no external Port. */
export interface TransactionManager {
  /** Execute only database operations in one managed transaction. */
  execute<T>(work: (transaction: ApplicationTransaction) => Promise<T>): Promise<T>;
}

/** Side-effect-free application time source called outside transactions. */
export interface Clock {
  /** Return the current UTC ISO timestamp. */
  now(): string;
}

/** Application identity source called outside transactions. */
export interface IdGenerator {
  /** Return one new internal identity. */
  nextId(): string;
}

/** Transaction-bound access to one external Case import staging database. */
export interface StagedCaseRepository {
  /** Return the first Case whose Rubric Prompt key is absent from current resources. */
  findFirstMissingRubricPrompt(): Promise<{
    readonly index: number;
    readonly caseKey: string;
    readonly promptKey: string;
  } | null>;
  /** Atomically replace one Suite's current Cases from staging. */
  replaceCases(suiteId: string): Promise<void>;
}

/** One bounded external staging workspace. */
export interface CaseImportStagingSession {
  /** Persist one already-prepared Case or reject a duplicate Suite-local key. */
  stage(value: StoredTestCase): Promise<"STAGED" | "CASE_ID_DUPLICATE">;
  /** Lease one main connection, attach staging read-only and execute one transaction. */
  withStagedTransaction<T>(
    work: (transaction: ApplicationTransaction, stagedCases: StagedCaseRepository) => Promise<T>
  ): Promise<T>;
  /** Close handles and remove only this owned workspace. */
  cleanup(): Promise<void>;
}

/** Factory for isolated Case import staging sessions. */
export interface CaseImportStagingFactory {
  /** Create one owner-identified staging workspace. */
  open(): Promise<CaseImportStagingSession>;
}
