import type { TransactionManager } from "../../application-ports.ts";
import type {
  AnalysisPromptResource,
  ConfigurationResource,
  EndpointConfigurationResource,
  LlmConfigurationResource,
  RubricPromptResource
} from "../configurations/configuration-models.ts";
import type {
  CasePageCursor,
  StoredTestCase,
  TestSuite
} from "../test-suites/test-suite-models.ts";

const CASE_PAGE_SIZE = 100;

/** Current-resource selection cleaned by the entrypoint contract. */
export interface WorkPackageExportSelection {
  /** Source Suite identity. */
  readonly suiteId: string;
  /** Endpoint configuration identity. */
  readonly endpointConfigId: string;
  /** Evaluator LLM configuration identity. */
  readonly evaluatorConfigId: string;
  /** Analyzer LLM configuration identity. */
  readonly analyzerConfigId: string;
  /** Case Analysis Prompt configuration identity. */
  readonly analysisPromptId: string;
}

/** Immutable current-resource facts captured before export streaming begins. */
export interface WorkPackageExportSnapshotSession {
  /** Original validated resource selection. */
  readonly request: WorkPackageExportSelection;
  /** Frozen Suite aggregate identity and Revision. */
  readonly suite: TestSuite;
  /** Frozen current Endpoint. */
  readonly endpoint: EndpointConfigurationResource;
  /** Frozen current Evaluator. */
  readonly evaluator: LlmConfigurationResource;
  /** Frozen current Analyzer. */
  readonly analyzer: LlmConfigurationResource;
  /** Frozen current Analysis Prompt. */
  readonly analysisPrompt: AnalysisPromptResource;
  /** All Rubric Prompts visible at snapshot start, keyed by Prompt Key. */
  readonly rubricPromptsByKey: ReadonlyMap<string, RubricPromptResource>;
}

/** Snapshot service dependencies. */
export interface WorkPackageExportSnapshotServiceDependencies {
  /** Short managed database transaction boundary. */
  readonly transactionManager: TransactionManager;
}

function requireConfiguration<Kind extends ConfigurationResource["kind"]>(
  value: ConfigurationResource | null,
  kind: Kind
): Extract<ConfigurationResource, { readonly kind: Kind }> {
  if (value === null) throw new Error("CONFIGURATION_NOT_FOUND");
  if (value.kind !== kind) throw new Error("CONFIGURATION_KIND_CONFLICT");
  return value as Extract<ConfigurationResource, { readonly kind: Kind }>;
}

function sameSuite(left: TestSuite | null, right: TestSuite): boolean {
  return (
    left !== null &&
    left.id === right.id &&
    left.revision === right.revision &&
    left.suiteHash === right.suiteHash &&
    left.caseCount === right.caseCount
  );
}

function sameResource(left: ConfigurationResource | null, right: ConfigurationResource): boolean {
  return (
    left !== null &&
    left.kind === right.kind &&
    left.id === right.id &&
    left.revision === right.revision &&
    left.semanticHash === right.semanticHash
  );
}

/** Freeze, page and revalidate one current Work Package export selection. */
export class WorkPackageExportSnapshotService {
  readonly #dependencies: WorkPackageExportSnapshotServiceDependencies;

  /** Bind current-resource reads to explicit short transactions. */
  public constructor(dependencies: WorkPackageExportSnapshotServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Capture the exact resource identities before any external bytes are generated. */
  public begin(request: WorkPackageExportSelection): Promise<WorkPackageExportSnapshotSession> {
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const suite = await transaction.testSuites.getSuite(request.suiteId);
      if (suite === null) throw new Error("SUITE_NOT_FOUND");
      if (suite.caseCount === 0) throw new Error("RUN_SUITE_EMPTY");
      const [endpointValue, evaluatorValue, analyzerValue, analysisPromptValue, promptValues] =
        await Promise.all([
          transaction.configurations.getResource("ENDPOINT", request.endpointConfigId),
          transaction.configurations.getResource("LLM", request.evaluatorConfigId),
          transaction.configurations.getResource("LLM", request.analyzerConfigId),
          transaction.configurations.getResource("CASE_ANALYSIS_PROMPT", request.analysisPromptId),
          transaction.configurations.listResources("LLM_RUBRIC_PROMPT")
        ]);
      const rubricPromptsByKey = new Map<string, RubricPromptResource>();
      for (const value of promptValues) {
        const prompt = requireConfiguration(value, "LLM_RUBRIC_PROMPT");
        rubricPromptsByKey.set(prompt.definition.promptKey, prompt);
      }
      return {
        request,
        suite,
        endpoint: requireConfiguration(endpointValue, "ENDPOINT"),
        evaluator: requireConfiguration(evaluatorValue, "LLM"),
        analyzer: requireConfiguration(analyzerValue, "LLM"),
        analysisPrompt: requireConfiguration(analysisPromptValue, "CASE_ANALYSIS_PROMPT"),
        rubricPromptsByKey
      };
    });
  }

  /** Page complete Cases outside a long transaction while guarding the Suite Revision. */
  public async *streamCases(
    session: WorkPackageExportSnapshotSession
  ): AsyncGenerator<StoredTestCase> {
    let afterCursor: CasePageCursor | undefined;
    let count = 0;
    let complete = false;
    while (!complete) {
      const snapshot = await this.#dependencies.transactionManager.execute(async (transaction) => {
        const currentSuite = await transaction.testSuites.getSuite(session.suite.id);
        const page = await transaction.testSuites.queryCases({
          suiteId: session.suite.id,
          limit: CASE_PAGE_SIZE,
          ...(afterCursor === undefined ? {} : { afterCursor })
        });
        return { currentSuite, page };
      });
      if (!sameSuite(snapshot.currentSuite, session.suite)) {
        throw new Error("EXPORT_REVISION_CONFLICT");
      }
      for (const item of snapshot.page.items) {
        if (item.ordinal !== count) throw new Error("EXPORT_REVISION_CONFLICT");
        count += 1;
        yield item;
      }
      complete = snapshot.page.nextCursor === null;
      if (!complete) afterCursor = snapshot.page.nextCursor ?? undefined;
    }
    if (count !== session.suite.caseCount) throw new Error("EXPORT_REVISION_CONFLICT");
  }

  /** Resolve exactly the sorted Prompt set referenced by the streamed Cases. */
  public resolveRubricPrompts(
    session: WorkPackageExportSnapshotSession,
    promptKeys: Iterable<string>
  ): readonly RubricPromptResource[] {
    const keys = [...new Set(promptKeys)].sort((left, right) => left.localeCompare(right));
    return keys.map((key) => {
      const prompt = session.rubricPromptsByKey.get(key);
      if (prompt === undefined) throw new Error("RUBRIC_PROMPT_NOT_FOUND");
      return prompt;
    });
  }

  /** Revalidate all exported resource revisions before a prepared response can open. */
  public revalidate(
    session: WorkPackageExportSnapshotSession,
    rubricPrompts: readonly RubricPromptResource[]
  ): Promise<void> {
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const [suite, endpoint, evaluator, analyzer, analysisPrompt, ...prompts] = await Promise.all([
        transaction.testSuites.getSuite(session.suite.id),
        transaction.configurations.getResource("ENDPOINT", session.endpoint.id),
        transaction.configurations.getResource("LLM", session.evaluator.id),
        transaction.configurations.getResource("LLM", session.analyzer.id),
        transaction.configurations.getResource("CASE_ANALYSIS_PROMPT", session.analysisPrompt.id),
        ...rubricPrompts.map((prompt) =>
          transaction.configurations.getResource("LLM_RUBRIC_PROMPT", prompt.id)
        )
      ]);
      const stable =
        sameSuite(suite, session.suite) &&
        sameResource(endpoint, session.endpoint) &&
        sameResource(evaluator, session.evaluator) &&
        sameResource(analyzer, session.analyzer) &&
        sameResource(analysisPrompt, session.analysisPrompt) &&
        prompts.every((prompt, index) => {
          const expected = rubricPrompts[index];
          return expected !== undefined && sameResource(prompt, expected);
        });
      if (!stable) throw new Error("EXPORT_REVISION_CONFLICT");
    });
  }
}
