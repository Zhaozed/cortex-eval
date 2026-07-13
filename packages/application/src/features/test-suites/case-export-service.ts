import type { TransactionManager } from "../../application-ports.ts";
import type { CasePageCursor, StoredTestCase } from "./test-suite-models.ts";
import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";

/** Case export dependencies. */
export interface CaseExportServiceDependencies {
  /** Managed short transaction boundary. */
  readonly transactionManager: TransactionManager;
}

/** Frozen current Suite export identity. */
export interface CaseExportSession {
  /** Source Suite identity. */
  readonly suiteId: string;
  /** Frozen current Suite Revision. */
  readonly suiteRevision: number;
}

/** Stable whole-Suite export failure. */
export class CaseExportError extends Error {
  /** Stable export failure code. */
  public readonly code: "SUITE_NOT_FOUND" | "EXPORT_REVISION_CONFLICT";

  /** Create one path-safe export failure. */
  public constructor(code: "SUITE_NOT_FOUND" | "EXPORT_REVISION_CONFLICT") {
    super(code);
    this.name = "CaseExportError";
    this.code = code;
  }
}

/** Backpressure-aware current Case exporter with Suite Revision consistency. */
export class CaseExportService {
  readonly #dependencies: CaseExportServiceDependencies;

  /** Create an exporter over an explicit transaction boundary. */
  public constructor(dependencies: CaseExportServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Freeze one current Suite Revision before an HTTP response is opened. */
  public begin(suiteId: string): Promise<CaseExportSession> {
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const suite = await transaction.testSuites.getSuite(suiteId);
      if (suite === null) throw new CaseExportError("SUITE_NOT_FOUND");
      return { suiteId, suiteRevision: suite.revision };
    });
  }

  /** Stream one frozen Suite revision without retaining a complete Case array. */
  public async *stream(suiteId: string): AsyncGenerator<CaseDefinition, void, void> {
    const session = await this.begin(suiteId);
    yield* this.streamSession(session);
  }

  /** Stream a previously frozen Suite session one current Case at a time. */
  public async *streamSession(
    session: CaseExportSession
  ): AsyncGenerator<CaseDefinition, void, void> {
    let cursor: CasePageCursor | undefined;
    const readNextCase = (): Promise<StoredTestCase | null> =>
      this.#dependencies.transactionManager.execute(async (transaction) => {
        const suite = await transaction.testSuites.getSuite(session.suiteId);
        if (suite === null) throw new CaseExportError("SUITE_NOT_FOUND");
        if (suite.revision !== session.suiteRevision) {
          throw new CaseExportError("EXPORT_REVISION_CONFLICT");
        }
        const page = await transaction.testSuites.queryCases({
          suiteId: session.suiteId,
          limit: 1,
          ...(cursor === undefined ? {} : { afterCursor: cursor })
        });
        return page.items[0] ?? null;
      });

    let item = await readNextCase();
    while (item !== null) {
      cursor = { ordinal: item.ordinal, id: item.id };
      yield item.definition;
      item = await readNextCase();
    }
  }
}
