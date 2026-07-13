import type {
  CaseImportStagingFactory,
  CaseImportStagingSession,
  StagedCaseRepository,
  TransactionManager
} from "@cortex-eval/application/src/application-ports.ts";
import type { StoredTestCase } from "@cortex-eval/application/src/features/test-suites/test-suite-models.ts";

/** Bounded in-memory staging substitute for Local Server protocol tests. */
export class InMemoryCaseStagingFactory implements CaseImportStagingFactory {
  readonly #transactionManager: TransactionManager;

  /** Bind staged finalization to the test transaction manager. */
  public constructor(transactionManager: TransactionManager) {
    this.#transactionManager = transactionManager;
  }

  /** Open one isolated staged Case set. */
  public open(): Promise<CaseImportStagingSession> {
    const staged: StoredTestCase[] = [];
    return Promise.resolve({
      stage: (value) => {
        if (staged.some((item) => item.caseKey === value.caseKey)) {
          return Promise.resolve("CASE_ID_DUPLICATE" as const);
        }
        staged.push(value);
        return Promise.resolve("STAGED" as const);
      },
      withStagedTransaction: (work) =>
        this.#transactionManager.execute(async (transaction) => {
          const repository: StagedCaseRepository = {
            findFirstMissingRubricPrompt: async () => {
              for (const [index, item] of staged.entries()) {
                const promptKey = await transaction.configurations.findMissingRubricPromptKey(
                  item.rubricPromptKeys
                );
                if (promptKey !== null) return { index, caseKey: item.caseKey, promptKey };
              }
              return null;
            },
            replaceCases: (suiteId) => transaction.testSuites.replaceCases(suiteId, staged)
          };
          return work(transaction, repository);
        }),
      cleanup: () => Promise.resolve()
    });
  }
}
