import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";

import type { FrozenEvaluationRawSource } from "@cortex-eval/application/src/features/evaluation/frozen-evaluation-engine.ts";

import { streamPromptfooResultRows } from "./promptfoo-raw-result-stream.ts";

/** Private replayable Promptfoo output owned until the Application disposes it. */
export class PromptfooRawFileSource implements FrozenEvaluationRawSource {
  /** Stable runtime discriminator. */
  public readonly kind = "PROMPTFOO_RAW_SOURCE" as const;
  /** Private disposable process directory. */
  readonly #directory: string;
  /** Private validated Raw JSON file. */
  readonly #path: string;
  #disposed = false;

  /** Bind one successfully validated private process output. */
  public constructor(directory: string, path: string) {
    this.#directory = directory;
    this.#path = path;
  }

  /** Open a fresh byte stream without exposing a filesystem path. */
  public openBytes(): AsyncIterable<Uint8Array> {
    this.#requireOpen();
    return createReadStream(this.#path);
  }

  /** Open a fresh fixed-version Row stream with per-item backpressure. */
  public openRows(): AsyncIterable<unknown> {
    this.#requireOpen();
    return streamPromptfooResultRows(createReadStream(this.#path));
  }

  /** Idempotently reclaim the complete private directory. */
  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await rm(this.#directory, { force: true, recursive: true });
  }

  // Reject every use after ownership has ended.
  #requireOpen(): void {
    if (this.#disposed) throw new Error("PROMPTFOO_RAW_SOURCE_DISPOSED");
  }
}
