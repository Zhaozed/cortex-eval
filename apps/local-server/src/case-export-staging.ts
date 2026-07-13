import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type {
  CaseImportWorkspaceManager,
  OwnedCaseImportWorkspace
} from "@cortex-eval/storage-sqlite/src/case-import-workspace.ts";

/** Bounded pre-response Case export staging boundary. */
export interface CaseExportBodyPreparer {
  /** Fully validate and stage one JSON body before the HTTP success response opens. */
  prepare(chunks: AsyncIterable<string>): Promise<Readable>;
}

/** Backpressure-aware prepared file body that waits for owner-safe cleanup on every destroy path. */
class OwnedCaseExportReadable extends PassThrough {
  /** Underlying owner-only prepared file stream. */
  readonly #source: ReadStream;
  /** Owned workspace removed exactly once. */
  readonly #workspace: OwnedCaseImportWorkspace;
  /** Owner-aware cleanup boundary. */
  readonly #workspaceManager: CaseImportWorkspaceManager;
  /** Shared completion of the one cleanup attempt. */
  #cleanupPromise: Promise<void> | null = null;

  /** Start bounded file streaming into this response body. */
  public constructor(
    path: string,
    workspace: OwnedCaseImportWorkspace,
    workspaceManager: CaseImportWorkspaceManager
  ) {
    super();
    this.#workspace = workspace;
    this.#workspaceManager = workspaceManager;
    this.#source = createReadStream(path);
    this.#source.once("error", (error): void => {
      this.destroy(error);
    });
    this.#source.pipe(this);
  }

  /** Stop file IO and finish owner-safe cleanup before the response body closes. */
  public override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#source.destroy();
    void this.#cleanup().then(
      (): void => callback(error),
      (): void => callback(error)
    );
  }

  /** Remove the completed file before exposing response EOF to the caller. */
  public override _final(callback: (error?: Error | null) => void): void {
    void this.#cleanup().then(
      (): void => callback(),
      (): void => callback()
    );
  }

  // Run cleanup once; the workspace manager already emits a safe event when deletion fails.
  #cleanup(): Promise<void> {
    this.#cleanupPromise ??= this.#workspaceManager
      .cleanupOwned(this.#workspace)
      .catch(() => undefined);
    return this.#cleanupPromise;
  }
}

/** Owner-isolated disk-backed exporter that never retains the complete Suite in memory. */
export class FileCaseExportBodyPreparer implements CaseExportBodyPreparer {
  readonly #workspaceManager: CaseImportWorkspaceManager;

  /** Bind export files to one explicit owner-aware workspace manager. */
  public constructor(workspaceManager: CaseImportWorkspaceManager) {
    this.#workspaceManager = workspaceManager;
  }

  /** Remove only stale export workspaces during composition startup. */
  public cleanupStale(): Promise<void> {
    return this.#workspaceManager.cleanupStale();
  }

  /** Write all revision-validated chunks before returning a lazy cleanup-aware file stream. */
  public async prepare(chunks: AsyncIterable<string>): Promise<Readable> {
    const workspace = await this.#workspaceManager.create();
    const path = join(workspace.path, "cases.json");
    try {
      await pipeline(
        Readable.from(chunks, { objectMode: false }),
        createWriteStream(path, { flags: "wx", mode: 0o600 })
      );
      await chmod(path, 0o600);
      return new OwnedCaseExportReadable(path, workspace, this.#workspaceManager);
    } catch (error) {
      await this.#workspaceManager.cleanupOwned(workspace).catch(() => undefined);
      throw error;
    }
  }
}
