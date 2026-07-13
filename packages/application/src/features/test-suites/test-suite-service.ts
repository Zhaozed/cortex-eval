import { hashSuite } from "@cortex-eval/domain/src/domain-resource-hashes.ts";

import type { Clock, IdGenerator, TransactionManager } from "../../application-ports.ts";
import type {
  StoredTestCase,
  TestSuite,
  TestSuiteQuery,
  TestSuiteQueryResult
} from "./test-suite-models.ts";
import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";
import type { CaseQuery, CaseQueryResult } from "./test-suite-models.ts";

/** Test Suite service dependencies. */
export interface TestSuiteServiceDependencies {
  /** Managed database-only transaction boundary. */
  readonly transactionManager: TransactionManager;
  /** Internal identity source. */
  readonly idGenerator: IdGenerator;
  /** Application time source. */
  readonly clock: Clock;
}

/** Stable Suite resource error. */
export type TestSuiteResourceError =
  | { readonly code: "SUITE_NOT_FOUND" }
  | { readonly code: "RESOURCE_IN_ACTIVE_RUN" }
  | { readonly code: "RESOURCE_UNIQUE_CONFLICT"; readonly field: "name" }
  | {
      readonly code: "RESOURCE_REVISION_CONFLICT";
      readonly actualRevision: number;
      readonly expectedRevision: number;
    };

/** Exact Suite mutation result. */
export type TestSuiteMutationResult =
  | { readonly ok: true; readonly suite: TestSuite }
  | { readonly ok: false; readonly error: TestSuiteResourceError };

/** Exact Suite deletion result. */
export type TestSuiteDeleteResult =
  { readonly ok: true } | { readonly ok: false; readonly error: TestSuiteResourceError };

/** Current Suite deletion-impact result. */
export type TestSuiteImpactResult =
  | {
      readonly ok: true;
      readonly impact: { readonly caseCount: number; readonly activeRunReference: boolean };
    }
  | { readonly ok: false; readonly error: { readonly code: "SUITE_NOT_FOUND" } };

/** Create empty Suite command. */
export interface CreateTestSuiteCommand {
  /** Unique display name. */
  readonly name: string;
  /** Display description. */
  readonly description: string;
}

/** Conditional Suite display update. */
export interface UpdateTestSuiteCommand extends CreateTestSuiteCommand {
  /** Target identity. */
  readonly id: string;
  /** Optimistic-concurrency token. */
  readonly expectedRevision: number;
}

/** Conditional Suite deletion. */
export interface DeleteTestSuiteCommand {
  /** Target identity. */
  readonly id: string;
  /** Optimistic-concurrency token. */
  readonly expectedRevision: number;
}

// Return one stable Revision conflict.
function conflict(actualRevision: number, expectedRevision: number): TestSuiteResourceError {
  return { code: "RESOURCE_REVISION_CONFLICT", actualRevision, expectedRevision };
}

/** Internal Test Suite CRUD use cases. */
export class TestSuiteService {
  readonly #dependencies: TestSuiteServiceDependencies;

  /** Create a service with explicit persistence side effects. */
  public constructor(dependencies: TestSuiteServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Read one current Suite or null. */
  public get(suiteId: string): Promise<TestSuite | null> {
    return this.#dependencies.transactionManager.execute(async (transaction) =>
      transaction.testSuites.getSuite(suiteId)
    );
  }

  /** Read the current deletion impact without mutating Suite facts. */
  public impact(suiteId: string): Promise<TestSuiteImpactResult> {
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const suite = await transaction.testSuites.getSuite(suiteId);
      if (suite === null) return { ok: false, error: { code: "SUITE_NOT_FOUND" } };
      return {
        ok: true,
        impact: {
          caseCount: suite.caseCount,
          activeRunReference: await transaction.runs.hasActiveResourceReference(
            "TEST_SUITE",
            suiteId
          )
        }
      };
    });
  }

  /** List all current Suites in stable display order. */
  public list(): Promise<readonly TestSuite[]> {
    return this.#dependencies.transactionManager.execute(async (transaction) =>
      transaction.testSuites.listSuites()
    );
  }

  /** Query one stable small Test Suite page. */
  public query(query: TestSuiteQuery): Promise<TestSuiteQueryResult> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200) {
      return Promise.resolve({
        ok: false,
        error: { code: "TEST_SUITE_QUERY_INVALID", path: "limit" }
      });
    }
    if (query.afterCursor?.name.length === 0) {
      return Promise.resolve({
        ok: false,
        error: { code: "TEST_SUITE_QUERY_INVALID", path: "afterCursor.name" }
      });
    }
    if (query.afterCursor?.id.length === 0) {
      return Promise.resolve({
        ok: false,
        error: { code: "TEST_SUITE_QUERY_INVALID", path: "afterCursor.id" }
      });
    }
    return this.#dependencies.transactionManager.execute(async (transaction) => ({
      ok: true,
      page: await transaction.testSuites.querySuites(query)
    }));
  }

  /** Read one current Case by its exact Suite-local stable key. */
  public getCase(suiteId: string, caseKey: string): Promise<StoredTestCase | null> {
    return this.#dependencies.transactionManager.execute(async (transaction) =>
      transaction.testSuites.getCase(suiteId, caseKey)
    );
  }

  /** Create one empty current Suite. */
  public create(command: CreateTestSuiteCommand): Promise<TestSuiteMutationResult> {
    const timestamp = this.#dependencies.clock.now();
    const suite: TestSuite = {
      id: this.#dependencies.idGenerator.nextId(),
      name: command.name,
      description: command.description,
      caseCount: 0,
      suiteHash: hashSuite({ contractVersion: "cortex.suite.v1", cases: [] }),
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const inserted = await transaction.testSuites.insertSuite(suite);
      return inserted === "INSERTED"
        ? { ok: true, suite }
        : { ok: false, error: { code: "RESOURCE_UNIQUE_CONFLICT", field: "name" } };
    });
  }

  /** Update Suite display fields without changing its semantic Hash. */
  public update(command: UpdateTestSuiteCommand): Promise<TestSuiteMutationResult> {
    const timestamp = this.#dependencies.clock.now();
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const current = await transaction.testSuites.getSuite(command.id);
      if (current === null) return { ok: false, error: { code: "SUITE_NOT_FOUND" } };
      if (current.revision !== command.expectedRevision) {
        return { ok: false, error: conflict(current.revision, command.expectedRevision) };
      }
      const value = {
        ...current,
        name: command.name,
        description: command.description,
        revision: current.revision + 1,
        updatedAt: timestamp
      };
      const updated = await transaction.testSuites.updateSuiteDetails(value, current.revision);
      if (updated === "NAME_CONFLICT") {
        return {
          ok: false,
          error: { code: "RESOURCE_UNIQUE_CONFLICT", field: "name" }
        };
      }
      return updated === null
        ? { ok: false, error: conflict(current.revision + 1, command.expectedRevision) }
        : { ok: true, suite: updated };
    });
  }

  /** Delete one current Suite only when no READY/RUNNING Run references it. */
  public delete(command: DeleteTestSuiteCommand): Promise<TestSuiteDeleteResult> {
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const current = await transaction.testSuites.getSuite(command.id);
      if (current === null) return { ok: false, error: { code: "SUITE_NOT_FOUND" } };
      if (current.revision !== command.expectedRevision) {
        return { ok: false, error: conflict(current.revision, command.expectedRevision) };
      }
      if (await transaction.runs.hasActiveResourceReference("TEST_SUITE", command.id)) {
        return { ok: false, error: { code: "RESOURCE_IN_ACTIVE_RUN" } };
      }
      const deleted = await transaction.testSuites.deleteSuite(
        command.id,
        command.expectedRevision
      );
      return deleted
        ? { ok: true }
        : { ok: false, error: conflict(current.revision + 1, command.expectedRevision) };
    });
  }

  /** Query one stable current Case page with exact filters. */
  public queryCases(query: CaseQuery): Promise<CaseQueryResult> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200) {
      return Promise.resolve({ ok: false, error: { code: "CASE_QUERY_INVALID", path: "limit" } });
    }
    if (
      query.afterCursor !== undefined &&
      (!Number.isInteger(query.afterCursor.ordinal) || query.afterCursor.ordinal < 0)
    ) {
      return Promise.resolve({
        ok: false,
        error: { code: "CASE_QUERY_INVALID", path: "afterCursor.ordinal" }
      });
    }
    if (query.afterCursor?.id.length === 0) {
      return Promise.resolve({
        ok: false,
        error: { code: "CASE_QUERY_INVALID", path: "afterCursor.id" }
      });
    }
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const suite = await transaction.testSuites.getSuite(query.suiteId);
      if (suite === null) return { ok: false, error: { code: "SUITE_NOT_FOUND" } };
      return { ok: true, page: await transaction.testSuites.queryCases(query) };
    });
  }

  /** Export complete current Case Definitions in frozen Ordinal order. */
  public exportCaseDefinitions(suiteId: string): Promise<readonly CaseDefinition[]> {
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const cases = await transaction.testSuites.listCases(suiteId);
      return cases.map((item) => item.definition);
    });
  }
}
