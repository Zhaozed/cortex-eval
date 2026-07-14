import { Transform, type TransformCallback } from "node:stream";
import type { Readable } from "node:stream";

import { pick } from "stream-json/filters/pick.js";
import { parser, type Token } from "stream-json/parser.js";
import { streamArray } from "stream-json/streamers/stream-array.js";

interface ObjectFrame {
  /** Container discriminator. */
  readonly kind: "OBJECT";
  /** Stable property path to this container. */
  readonly path: readonly string[];
  /** Last packed key awaiting its value. */
  pendingKey: string | null;
}

interface ArrayFrame {
  /** Container discriminator. */
  readonly kind: "ARRAY";
  /** Stable property path to this container. */
  readonly path: readonly string[];
}

type Frame = ObjectFrame | ArrayFrame;

function invalid(cause?: unknown): Error {
  return cause === undefined
    ? new Error("PROMPTFOO_PROCESS_OUTPUT_INVALID")
    : new Error("PROMPTFOO_PROCESS_OUTPUT_INVALID", { cause });
}

function streamItem(value: unknown): { readonly key: number; readonly value: unknown } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Readonly<Record<string, unknown>>;
  return Number.isInteger(item.key) ? { key: item.key as number, value: item.value } : null;
}

// Pass tokens through while checking the fixed version without assembling result Rows.
class PromptfooVersionTokenValidator extends Transform {
  /** Current JSON container path. */
  readonly #frames: Frame[] = [];
  #versionFound = false;

  /** Construct one object-mode token validator. */
  public constructor() {
    super({ objectMode: true });
  }

  // Return the path of the next value and consume its pending object key.
  #consumeValuePath(): readonly string[] {
    const parent = this.#frames.at(-1);
    if (parent === undefined) return [];
    if (parent.kind === "ARRAY") return parent.path;
    if (parent.pendingKey === null) throw invalid();
    const path = [...parent.path, parent.pendingKey];
    parent.pendingKey = null;
    return path;
  }

  /** Validate one parser token and preserve it for the row selector. */
  public override _transform(
    token: Token,
    _encoding: BufferEncoding,
    done: TransformCallback
  ): void {
    try {
      if (token.name === "keyValue") {
        const frame = this.#frames.at(-1);
        if (frame?.kind !== "OBJECT" || frame.pendingKey !== null) throw invalid();
        frame.pendingKey = token.value;
      } else if (token.name === "startObject") {
        this.#frames.push({ kind: "OBJECT", path: this.#consumeValuePath(), pendingKey: null });
      } else if (token.name === "startArray") {
        this.#frames.push({ kind: "ARRAY", path: this.#consumeValuePath() });
      } else if (token.name === "endObject" || token.name === "endArray") {
        const frame = this.#frames.pop();
        if (
          frame === undefined ||
          (token.name === "endObject" && frame.kind !== "OBJECT") ||
          (token.name === "endArray" && frame.kind !== "ARRAY")
        ) {
          throw invalid();
        }
      } else if (
        token.name === "numberValue" ||
        token.name === "stringValue" ||
        token.name === "nullValue" ||
        token.name === "trueValue" ||
        token.name === "falseValue"
      ) {
        const path = this.#consumeValuePath();
        if (path.length === 2 && path[0] === "results" && path[1] === "version") {
          if (this.#versionFound || token.name !== "numberValue" || token.value !== "3") {
            throw invalid();
          }
          this.#versionFound = true;
        }
      }
      done(null, token);
    } catch (error) {
      done(error instanceof Error ? error : invalid(error));
    }
  }

  /** Reject a document that omitted the fixed version field. */
  public override _flush(done: TransformCallback): void {
    done(this.#versionFound ? undefined : invalid());
  }
}

/** Parse fixed-version Promptfoo Rows with per-item backpressure and no aggregate materialization. */
export async function* streamPromptfooResultRows(source: Readable): AsyncGenerator {
  const tokenizer = parser.asStream({ streamValues: false, packValues: true });
  const version = new PromptfooVersionTokenValidator();
  const selector = pick.asStream({ filter: "results.results", once: true });
  const rows = streamArray.asStream();
  const forwardError = (error: Error): void => {
    rows.destroy(error);
  };
  source.on("error", forwardError);
  tokenizer.on("error", forwardError);
  version.on("error", forwardError);
  selector.on("error", forwardError);
  source.pipe(tokenizer).pipe(version).pipe(selector).pipe(rows);
  try {
    let expectedIndex = 0;
    for await (const dirtyItem of rows) {
      const item = streamItem(dirtyItem);
      if (item?.key !== expectedIndex) throw invalid();
      expectedIndex += 1;
      yield item.value;
    }
  } catch (error) {
    throw error instanceof Error && error.message === "PROMPTFOO_PROCESS_OUTPUT_INVALID"
      ? error
      : invalid(error);
  } finally {
    source.unpipe(tokenizer);
    tokenizer.destroy();
    version.destroy();
    selector.destroy();
    rows.destroy();
    source.destroy();
  }
}
