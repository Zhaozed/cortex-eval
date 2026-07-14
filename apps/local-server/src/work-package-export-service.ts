import { createWriteStream } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { Readable as NodeReadable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { WorkPackageExportRequestV1 } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";
import type {
  WorkPackageExportSnapshotService,
  WorkPackageExportSnapshotSession
} from "@cortex-eval/application/src/features/work-packages/work-package-export-snapshot-service.ts";
import { hashRubricPromptSet } from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import type {
  CaseImportWorkspaceManager,
  OwnedCaseImportWorkspace
} from "@cortex-eval/storage-sqlite/src/case-import-workspace.ts";
import { SecureWorkPackageDirectory } from "@cortex-eval/work-package/src/secure-work-package-directory.ts";
import { WorkPackageDirectoryPublisher } from "@cortex-eval/work-package/src/work-package-directory-publisher.ts";
import { encodeWorkPackageExport } from "@cortex-eval/work-package/src/work-package-export-encoder.ts";
import {
  assembleWorkPackageInputs,
  type WorkPackageExportCase,
  type WorkPackageInputAssembly
} from "@cortex-eval/work-package/src/work-package-input-assembler.ts";
import { validateWorkPackageDirectory } from "@cortex-eval/work-package/src/work-package-validator.ts";

import { OwnedWorkspaceFileReadable } from "./case-export-staging.ts";
import {
  mapCaseDefinitionToV1,
  mapAnalysisPromptDefinitionToV1,
  mapEndpointDefinitionToV1,
  mapLlmDefinitionToV1,
  mapPromptDefinitionToV1
} from "./resource-dto-mappers.ts";

/** Platform Work Package export dependencies. */
export interface WorkPackageExportServiceDependencies {
  /** Revision-consistent current-resource snapshot reader. */
  readonly snapshots: WorkPackageExportSnapshotService;
  /** Owner-aware bounded temporary workspace manager. */
  readonly workspaces: CaseImportWorkspaceManager;
  /** New UUIDv7 Package identity. */
  readonly nextId: () => string;
  /** Current UTC timestamp. */
  readonly now: () => string;
}

function promptCandidates(
  session: WorkPackageExportSnapshotSession
): WorkPackageInputAssembly["rubricPrompts"] {
  return [...session.rubricPromptsByKey.values()].map((prompt) => ({
    semanticHash: prompt.semanticHash,
    definition: mapPromptDefinitionToV1(prompt.definition)
  }));
}

/** Prepare a fully reconciled NDJSON body before opening an HTTP success response. */
export class WorkPackageExportService {
  readonly #dependencies: WorkPackageExportServiceDependencies;

  /** Bind snapshot, secure package storage and response staging. */
  public constructor(dependencies: WorkPackageExportServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Build and reconcile one immutable package export into an owner-cleaned response file. */
  public async prepare(
    request: WorkPackageExportRequestV1,
    signal: AbortSignal
  ): Promise<Readable> {
    const workspace = await this.#dependencies.workspaces.create();
    let publisher: WorkPackageDirectoryPublisher | undefined;
    try {
      const createdAt = this.#dependencies.now();
      const session = await this.#dependencies.snapshots.begin(request);
      publisher = await WorkPackageDirectoryPublisher.create(
        join(workspace.path, "package"),
        workspace.owner.nonce,
        {
          pid: workspace.owner.pid,
          processStartedAt: workspace.owner.processStartedAt,
          executionId: null,
          acquiredAt: createdAt
        }
      );
      const manifest = await assembleWorkPackageInputs(
        publisher.directory,
        {
          packageId: this.#dependencies.nextId(),
          createdAt,
          sourceSuite: {
            suiteId: session.suite.id,
            suiteHash: session.suite.suiteHash,
            caseCount: session.suite.caseCount
          },
          cases: this.#cases(session),
          endpoint: {
            semanticHash: session.endpoint.semanticHash,
            definition: mapEndpointDefinitionToV1(session.endpoint.definition)
          },
          evaluator: {
            semanticHash: session.evaluator.semanticHash,
            definition: mapLlmDefinitionToV1(session.evaluator.definition)
          },
          analyzer: {
            semanticHash: session.analyzer.semanticHash,
            definition: mapLlmDefinitionToV1(session.analyzer.definition)
          },
          rubricPrompts: promptCandidates(session),
          rubricPromptSetHasher: {
            hash: (prompts): string =>
              hashRubricPromptSet({
                contractVersion: "cortex.rubric-prompt-set.v1",
                prompts
              })
          },
          analysisPrompt: {
            semanticHash: session.analysisPrompt.semanticHash,
            definition: mapAnalysisPromptDefinitionToV1(session.analysisPrompt.definition)
          },
          signal
        },
        workspace.owner.nonce
      );
      const selectedPrompts = this.#dependencies.snapshots.resolveRubricPrompts(
        session,
        manifest.inputs.rubricPrompts.map((prompt) => prompt.promptKey)
      );
      await this.#dependencies.snapshots.revalidate(session, selectedPrompts);
      await publisher.prepareForValidation();
      const validated = await validateWorkPackageDirectory(publisher.directory, {
        pid: workspace.owner.pid,
        processStartedAt: workspace.owner.processStartedAt,
        executionId: null,
        acquiredAt: createdAt
      });
      await publisher.publish();
      const packageDirectory = await SecureWorkPackageDirectory.open(
        join(workspace.path, "package")
      );
      const bodyPath = join(workspace.path, "work-package.ndjson");
      try {
        await pipeline(
          NodeReadable.from(encodeWorkPackageExport(packageDirectory, validated, signal)),
          createWriteStream(bodyPath, { flags: "wx", mode: 0o600 })
        );
        await chmod(bodyPath, 0o600);
      } finally {
        packageDirectory.close();
      }
      return new OwnedWorkspaceFileReadable(bodyPath, workspace, this.#dependencies.workspaces);
    } catch (error) {
      await publisher?.abort().catch(() => undefined);
      await this.#cleanup(workspace);
      throw error;
    }
  }

  async *#cases(session: WorkPackageExportSnapshotSession): AsyncGenerator<WorkPackageExportCase> {
    for await (const item of this.#dependencies.snapshots.streamCases(session)) {
      yield {
        definition: mapCaseDefinitionToV1(item.definition),
        baseDefinitionHash: item.definitionHash
      };
    }
  }

  async #cleanup(workspace: OwnedCaseImportWorkspace): Promise<void> {
    await this.#dependencies.workspaces.cleanupOwned(workspace).catch(() => undefined);
  }
}
