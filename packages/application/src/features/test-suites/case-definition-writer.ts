import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";
import { hashSuite } from "@cortex-eval/domain/src/domain-resource-hashes.ts";

import type {
  ApplicationTransaction,
  Clock,
  IdGenerator,
  TransactionManager
} from "../../application-ports.ts";
import type {
  CaseWriteError,
  DeleteCaseResult,
  ReplaceCasesResult,
  SingleCaseWriteResult,
  StoredTestCase,
  TestSuite
} from "./test-suite-models.ts";
import {
  materializeStoredCase as storedCase,
  prepareCaseDefinition as prepareCase,
  type PreparedCaseDefinition as PreparedCase
} from "./case-definition-preparer.ts";

/** Dependencies used outside and inside Case write transactions. */
export interface CaseDefinitionWriterDependencies {
  /** Managed short transaction boundary. */
  readonly transactionManager: TransactionManager;
  /** Internal identity source called before entering a transaction. */
  readonly idGenerator: IdGenerator;
  /** Time source called before entering a transaction. */
  readonly clock: Clock;
}

/** Manual or delegated Case creation command. */
export interface CreateCaseCommand {
  /** Owning Suite. */
  readonly suiteId: string;
  /** Aggregate concurrency token. */
  readonly expectedSuiteRevision: number;
  /** Complete clean Case Definition. */
  readonly definition: CaseDefinition;
}

/** Atomic full Case replacement command. */
export interface ReplaceAllCasesCommand {
  /** Owning Suite. */
  readonly suiteId: string;
  /** Aggregate concurrency token. */
  readonly expectedSuiteRevision: number;
  /** Complete replacement definitions in target order. */
  readonly definitions: readonly CaseDefinition[];
}

/** Current Case edit command shared by manual and suggestion paths. */
export interface EditCaseCommand {
  /** Owning Suite. */
  readonly suiteId: string;
  /** Stable target Case key. */
  readonly caseKey: string;
  /** Aggregate concurrency token. */
  readonly expectedSuiteRevision: number;
  /** Current Case concurrency token. */
  readonly expectedCaseRevision: number;
  /** Complete replacement definition with the same Case key. */
  readonly definition: CaseDefinition;
}

/** Conditional current Case deletion command. */
export interface DeleteCaseCommand {
  /** Owning Suite. */
  readonly suiteId: string;
  /** Stable target Case key. */
  readonly caseKey: string;
  /** Aggregate concurrency token. */
  readonly expectedSuiteRevision: number;
  /** Current Case concurrency token. */
  readonly expectedCaseRevision: number;
}

// Return the first duplicate stable Case identity and its rejected order.
function duplicateCase(
  definitions: readonly CaseDefinition[]
): { readonly index: number; readonly caseKey: string } | null {
  const keys = new Set<string>();
  for (const [index, definition] of definitions.entries()) {
    if (keys.has(definition.caseKey)) return { index, caseKey: definition.caseKey };
    keys.add(definition.caseKey);
  }
  return null;
}

// Return a stable Revision conflict from the current aggregate fact.
function revisionConflict(suite: TestSuite, expectedRevision: number): CaseWriteError {
  return {
    code: "RESOURCE_REVISION_CONFLICT",
    actualRevision: suite.revision,
    expectedRevision
  };
}

/** Unified writer for all current Case Definition entry paths. */
export class CaseDefinitionWriter {
  readonly #dependencies: CaseDefinitionWriterDependencies;

  /** Create a writer with explicit side-effect boundaries. */
  public constructor(dependencies: CaseDefinitionWriterDependencies) {
    this.#dependencies = dependencies;
  }

  /** Create one current Case through the aggregate transaction. */
  public async createCase(command: CreateCaseCommand): Promise<SingleCaseWriteResult> {
    const timestamp = this.#dependencies.clock.now();
    const prepared = prepareCase(
      command.definition,
      this.#dependencies.idGenerator.nextId(),
      timestamp
    );
    if ("code" in prepared) return { ok: false, error: prepared };
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const suite = await transaction.testSuites.getSuite(command.suiteId);
      if (suite === null) return { ok: false, error: { code: "SUITE_NOT_FOUND" } };
      if (suite.revision !== command.expectedSuiteRevision) {
        return { ok: false, error: revisionConflict(suite, command.expectedSuiteRevision) };
      }
      const missingPrompt = await transaction.configurations.findMissingRubricPromptKey(
        prepared.rubricPromptKeys
      );
      if (missingPrompt !== null) {
        return {
          ok: false,
          error: { code: "RUBRIC_PROMPT_NOT_FOUND", promptKey: missingPrompt }
        };
      }
      const existing = await transaction.testSuites.listCases(command.suiteId);
      if (existing.some((item) => item.caseKey === prepared.definition.caseKey)) {
        return {
          ok: false,
          error: { code: "CASE_ID_DUPLICATE", caseKey: prepared.definition.caseKey }
        };
      }
      const value = storedCase(prepared, command.suiteId, existing.length);
      const allCases = [...existing, value];
      const suiteHash = hashSuite({
        contractVersion: "cortex.suite.v1",
        cases: allCases.map((item) => ({
          caseKey: item.caseKey,
          ordinal: item.ordinal,
          definitionHash: item.definitionHash
        }))
      });
      const updatedSuite = await transaction.testSuites.updateSuiteAggregate({
        suiteId: command.suiteId,
        expectedRevision: command.expectedSuiteRevision,
        caseCount: allCases.length,
        suiteHash,
        updatedAt: timestamp
      });
      if (updatedSuite === null) {
        const current = await transaction.testSuites.getSuite(command.suiteId);
        if (current === null) return { ok: false, error: { code: "SUITE_NOT_FOUND" } };
        return { ok: false, error: revisionConflict(current, command.expectedSuiteRevision) };
      }
      await transaction.testSuites.insertCase(value);
      return { ok: true, case: value, suite: updatedSuite };
    });
  }

  /** Replace the complete current Case set in one aggregate transaction. */
  public async replaceAllCases(command: ReplaceAllCasesCommand): Promise<ReplaceCasesResult> {
    const duplicate = duplicateCase(command.definitions);
    if (duplicate !== null) {
      return {
        ok: false,
        error: {
          code: "CASE_IMPORT_ITEM_INVALID",
          index: duplicate.index,
          caseKey: duplicate.caseKey,
          cause: { code: "CASE_ID_DUPLICATE", caseKey: duplicate.caseKey }
        }
      };
    }
    const timestamp = this.#dependencies.clock.now();
    const prepared: PreparedCase[] = [];
    for (const [index, definition] of command.definitions.entries()) {
      const item = prepareCase(definition, this.#dependencies.idGenerator.nextId(), timestamp);
      if ("code" in item) {
        return {
          ok: false,
          error: {
            code: "CASE_IMPORT_ITEM_INVALID",
            index,
            caseKey: definition.caseKey,
            cause: item
          }
        };
      }
      prepared.push(item);
    }
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const suite = await transaction.testSuites.getSuite(command.suiteId);
      if (suite === null) return { ok: false, error: { code: "SUITE_NOT_FOUND" } };
      if (suite.revision !== command.expectedSuiteRevision) {
        return { ok: false, error: revisionConflict(suite, command.expectedSuiteRevision) };
      }
      const promptKeys = [...new Set(prepared.flatMap((item) => item.rubricPromptKeys))].sort();
      const missingPrompt = await transaction.configurations.findMissingRubricPromptKey(promptKeys);
      if (missingPrompt !== null) {
        const index = prepared.findIndex((item) => item.rubricPromptKeys.includes(missingPrompt));
        const rejected = prepared[index];
        if (rejected === undefined) throw new Error("CASE_IMPORT_REFERENCE_CONTEXT_MISSING");
        return {
          ok: false,
          error: {
            code: "CASE_IMPORT_ITEM_INVALID",
            index,
            caseKey: rejected.definition.caseKey,
            cause: { code: "RUBRIC_PROMPT_NOT_FOUND", promptKey: missingPrompt }
          }
        };
      }
      const cases = prepared.map((item, ordinal) => storedCase(item, command.suiteId, ordinal));
      const suiteHash = hashSuite({
        contractVersion: "cortex.suite.v1",
        cases: cases.map((item) => ({
          caseKey: item.caseKey,
          ordinal: item.ordinal,
          definitionHash: item.definitionHash
        }))
      });
      const updatedSuite = await transaction.testSuites.updateSuiteAggregate({
        suiteId: command.suiteId,
        expectedRevision: command.expectedSuiteRevision,
        caseCount: cases.length,
        suiteHash,
        updatedAt: timestamp
      });
      if (updatedSuite === null) {
        const current = await transaction.testSuites.getSuite(command.suiteId);
        if (current === null) return { ok: false, error: { code: "SUITE_NOT_FOUND" } };
        return { ok: false, error: revisionConflict(current, command.expectedSuiteRevision) };
      }
      await transaction.testSuites.replaceCases(command.suiteId, cases);
      return { ok: true, cases, suite: updatedSuite };
    });
  }

  /** Edit one current Case while preserving stable identity and order. */
  public async editCase(command: EditCaseCommand): Promise<SingleCaseWriteResult> {
    const timestamp = this.#dependencies.clock.now();
    return this.#dependencies.transactionManager.execute((transaction) =>
      this.editCaseWithinTransaction(transaction, command, timestamp)
    );
  }

  /** Reuse the complete Case edit invariants inside an already-managed short transaction. */
  public async editCaseWithinTransaction(
    transaction: ApplicationTransaction,
    command: EditCaseCommand,
    timestamp: string
  ): Promise<SingleCaseWriteResult> {
    if (command.definition.caseKey !== command.caseKey) {
      return {
        ok: false,
        error: { code: "CASE_IDENTITY_CONFLICT", caseKey: command.caseKey }
      };
    }
    const prepared = prepareCase(command.definition, "", timestamp);
    if ("code" in prepared) return { ok: false, error: prepared };
    const suite = await transaction.testSuites.getSuite(command.suiteId);
    if (suite === null) return { ok: false, error: { code: "SUITE_NOT_FOUND" } };
    if (suite.revision !== command.expectedSuiteRevision) {
      return { ok: false, error: revisionConflict(suite, command.expectedSuiteRevision) };
    }
    const current = await transaction.testSuites.getCase(command.suiteId, command.caseKey);
    if (current === null) {
      return { ok: false, error: { code: "CASE_NOT_FOUND", caseKey: command.caseKey } };
    }
    if (current.revision !== command.expectedCaseRevision) {
      return {
        ok: false,
        error: {
          code: "RESOURCE_REVISION_CONFLICT",
          actualRevision: current.revision,
          expectedRevision: command.expectedCaseRevision
        }
      };
    }
    const missingPrompt = await transaction.configurations.findMissingRubricPromptKey(
      prepared.rubricPromptKeys
    );
    if (missingPrompt !== null) {
      return {
        ok: false,
        error: { code: "RUBRIC_PROMPT_NOT_FOUND", promptKey: missingPrompt }
      };
    }
    const candidate = storedCase(prepared, command.suiteId, current.ordinal);
    const value: StoredTestCase = {
      ...candidate,
      id: current.id,
      revision: current.revision + 1,
      createdAt: current.createdAt
    };
    const allCases = (await transaction.testSuites.listCases(command.suiteId)).map((item) =>
      item.caseKey === command.caseKey ? value : item
    );
    const suiteHash = hashSuite({
      contractVersion: "cortex.suite.v1",
      cases: allCases.map((item) => ({
        caseKey: item.caseKey,
        ordinal: item.ordinal,
        definitionHash: item.definitionHash
      }))
    });
    const updatedSuite = await transaction.testSuites.updateSuiteAggregate({
      suiteId: command.suiteId,
      expectedRevision: command.expectedSuiteRevision,
      caseCount: allCases.length,
      suiteHash,
      updatedAt: timestamp
    });
    if (updatedSuite === null) {
      const latest = await transaction.testSuites.getSuite(command.suiteId);
      return latest === null
        ? { ok: false, error: { code: "SUITE_NOT_FOUND" } }
        : { ok: false, error: revisionConflict(latest, command.expectedSuiteRevision) };
    }
    const updated = await transaction.testSuites.updateCase(value, current.revision);
    if (!updated) {
      throw new Error("CASE_WRITE_CONCURRENT_UPDATE");
    }
    return { ok: true, case: value, suite: updatedSuite };
  }

  /** Copy a Case through the same create path after the caller assigns a new stable key. */
  public copyCase(command: CreateCaseCommand): Promise<SingleCaseWriteResult> {
    return this.createCase(command);
  }

  /** Apply an accepted Proposal through the same edit path. */
  public acceptSuggestion(command: EditCaseCommand): Promise<SingleCaseWriteResult> {
    return this.editCase(command);
  }

  /** Apply an edited Proposal through the same edit path. */
  public editAndAcceptSuggestion(command: EditCaseCommand): Promise<SingleCaseWriteResult> {
    return this.editCase(command);
  }

  /** Delete one current Case, reordering remaining Ordinals atomically. */
  public async deleteCase(command: DeleteCaseCommand): Promise<DeleteCaseResult> {
    const timestamp = this.#dependencies.clock.now();
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const suite = await transaction.testSuites.getSuite(command.suiteId);
      if (suite === null) return { ok: false, error: { code: "SUITE_NOT_FOUND" } };
      if (suite.revision !== command.expectedSuiteRevision) {
        return { ok: false, error: revisionConflict(suite, command.expectedSuiteRevision) };
      }
      const current = await transaction.testSuites.getCase(command.suiteId, command.caseKey);
      if (current === null) {
        return { ok: false, error: { code: "CASE_NOT_FOUND", caseKey: command.caseKey } };
      }
      if (current.revision !== command.expectedCaseRevision) {
        return {
          ok: false,
          error: {
            code: "RESOURCE_REVISION_CONFLICT",
            actualRevision: current.revision,
            expectedRevision: command.expectedCaseRevision
          }
        };
      }
      const cases = (await transaction.testSuites.listCases(command.suiteId))
        .filter((item) => item.caseKey !== command.caseKey)
        .map((item, ordinal) =>
          item.ordinal === ordinal
            ? item
            : { ...item, ordinal, revision: item.revision + 1, updatedAt: timestamp }
        );
      const suiteHash = hashSuite({
        contractVersion: "cortex.suite.v1",
        cases: cases.map((item) => ({
          caseKey: item.caseKey,
          ordinal: item.ordinal,
          definitionHash: item.definitionHash
        }))
      });
      const updatedSuite = await transaction.testSuites.updateSuiteAggregate({
        suiteId: command.suiteId,
        expectedRevision: command.expectedSuiteRevision,
        caseCount: cases.length,
        suiteHash,
        updatedAt: timestamp
      });
      if (updatedSuite === null) {
        const latest = await transaction.testSuites.getSuite(command.suiteId);
        return latest === null
          ? { ok: false, error: { code: "SUITE_NOT_FOUND" } }
          : { ok: false, error: revisionConflict(latest, command.expectedSuiteRevision) };
      }
      const deleted = await transaction.testSuites.deleteCase(
        command.suiteId,
        command.caseKey,
        current.revision
      );
      if (!deleted) throw new Error("CASE_DELETE_CONCURRENT_UPDATE");
      for (const item of cases) {
        const previous = await transaction.testSuites.getCase(command.suiteId, item.caseKey);
        if (previous !== null && previous.ordinal !== item.ordinal) {
          const updated = await transaction.testSuites.updateCase(item, previous.revision);
          if (!updated) throw new Error("CASE_REORDER_CONCURRENT_UPDATE");
        }
      }
      return { ok: true, suite: updatedSuite };
    });
  }
}
