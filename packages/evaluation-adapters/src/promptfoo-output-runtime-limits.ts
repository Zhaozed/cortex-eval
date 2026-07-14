import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

interface ObjectFrame {
  /** Object container discriminator. */
  readonly kind: "OBJECT";
  /** Property path leading to this container. */
  readonly path: readonly string[];
  /** Whether the next string token is a property key. */
  expectingKey: boolean;
  /** Last parsed property key awaiting its value. */
  pendingKey: string | null;
}

interface ArrayFrame {
  /** Array container discriminator. */
  readonly kind: "ARRAY";
  /** Property path leading to this container. */
  readonly path: readonly string[];
}

type ContainerFrame = ObjectFrame | ArrayFrame;

const MAXIMUM_ENCODED_STRING_BYTES = WORK_PACKAGE_RUNTIME_LIMITS.decodedJsonStringBytes * 6 + 2;

function invalid(): Error {
  return new Error("PROMPTFOO_PROCESS_OUTPUT_INVALID");
}

// Return the property path of a container beginning at the current value position.
function nextValuePath(stack: readonly ContainerFrame[]): readonly string[] {
  const parent = stack.at(-1);
  if (parent === undefined) return [];
  if (parent.kind === "ARRAY") return parent.path;
  if (parent.pendingKey === null) throw invalid();
  return [...parent.path, parent.pendingKey];
}

// Decode one bounded JSON string token and enforce its post-unescape UTF-8 size.
function decodedString(parts: readonly Uint8Array[], sizeBytes: number): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, sizeBytes));
    const value = JSON.parse(text) as unknown;
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > WORK_PACKAGE_RUNTIME_LIMITS.decodedJsonStringBytes
    ) {
      throw new Error("PROMPTFOO_PROCESS_ERROR");
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === "PROMPTFOO_PROCESS_ERROR") throw error;
    throw invalid();
  }
}

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function isPromptfooRowsPath(path: readonly string[]): boolean {
  return path.length === 2 && path[0] === "results" && path[1] === "results";
}

/** Enforce decoded String and per-Raw-Row limits before whole-document JSON parsing. */
export async function validatePromptfooOutputRuntimeLimits(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  forbiddenText?: string
): Promise<void> {
  const stack: ContainerFrame[] = [];
  let inString = false;
  let escaped = false;
  let stringParts: Uint8Array[] = [];
  let stringBytes = 0;
  let targetArrayDepth: number | null = null;
  let targetExpectsRow = false;
  let activeRowBytes: number | null = null;
  let targetFound = false;
  let targetClosed = false;

  for await (const chunk of input) {
    let stringSegmentStart = inString ? 0 : -1;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      const byte = chunk[index];
      if (byte === undefined) throw invalid();
      if (activeRowBytes !== null) {
        activeRowBytes += 1;
        if (activeRowBytes > WORK_PACKAGE_RUNTIME_LIMITS.promptfooRawRowBytes) {
          throw new Error("PROMPTFOO_PROCESS_ERROR");
        }
      }
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (byte === 0x5c) {
          escaped = true;
          continue;
        }
        if (byte !== 0x22) continue;
        if (stringSegmentStart < 0) throw invalid();
        const part = chunk.subarray(stringSegmentStart, index + 1);
        stringBytes += part.byteLength;
        if (stringBytes > MAXIMUM_ENCODED_STRING_BYTES) {
          throw new Error("PROMPTFOO_PROCESS_ERROR");
        }
        stringParts.push(part);
        const value = decodedString(stringParts, stringBytes);
        if (forbiddenText !== undefined && value.includes(forbiddenText)) {
          throw new Error("PROMPTFOO_CAPABILITY_EXPOSED");
        }
        const frame = stack.at(-1);
        if (frame?.kind === "OBJECT" && frame.expectingKey) {
          frame.pendingKey = value;
          frame.expectingKey = false;
        }
        inString = false;
        stringSegmentStart = -1;
        stringParts = [];
        stringBytes = 0;
        continue;
      }

      const targetFrame = targetArrayDepth === null ? undefined : stack[targetArrayDepth - 1];
      const atTargetArray =
        targetArrayDepth !== null &&
        stack.length === targetArrayDepth &&
        targetFrame?.kind === "ARRAY";
      if (atTargetArray && targetExpectsRow && !isWhitespace(byte)) {
        if (byte === 0x5d) {
          targetExpectsRow = false;
        } else {
          if (byte !== 0x7b) throw invalid();
          activeRowBytes = 1;
          targetExpectsRow = false;
        }
      }

      if (byte === 0x22) {
        inString = true;
        escaped = false;
        stringSegmentStart = index;
        continue;
      }
      if (byte === 0x7b) {
        stack.push({
          kind: "OBJECT",
          path: nextValuePath(stack),
          expectingKey: true,
          pendingKey: null
        });
        continue;
      }
      if (byte === 0x5b) {
        const path = nextValuePath(stack);
        stack.push({ kind: "ARRAY", path });
        if (isPromptfooRowsPath(path)) {
          if (targetFound) throw invalid();
          targetFound = true;
          targetArrayDepth = stack.length;
          targetExpectsRow = true;
        }
        continue;
      }
      if (byte === 0x7d) {
        const frame = stack.pop();
        if (frame?.kind !== "OBJECT") throw invalid();
        if (
          activeRowBytes !== null &&
          targetArrayDepth !== null &&
          stack.length === targetArrayDepth
        ) {
          activeRowBytes = null;
        }
        continue;
      }
      if (byte === 0x5d) {
        const frame = stack.pop();
        if (frame?.kind !== "ARRAY") throw invalid();
        if (targetArrayDepth !== null && stack.length === targetArrayDepth - 1) {
          if (activeRowBytes !== null) throw invalid();
          targetArrayDepth = null;
          targetClosed = true;
        }
        continue;
      }
      if (byte !== 0x2c) continue;
      const frame = stack.at(-1);
      if (frame?.kind === "OBJECT") {
        frame.expectingKey = true;
        frame.pendingKey = null;
      } else if (
        frame?.kind === "ARRAY" &&
        targetArrayDepth !== null &&
        stack.length === targetArrayDepth
      ) {
        targetExpectsRow = true;
      }
    }
    if (inString && stringSegmentStart >= 0) {
      const part = chunk.subarray(stringSegmentStart);
      stringBytes += part.byteLength;
      if (stringBytes > MAXIMUM_ENCODED_STRING_BYTES) {
        throw new Error("PROMPTFOO_PROCESS_ERROR");
      }
      stringParts.push(part);
    }
  }
  if (inString || stack.length !== 0 || !targetFound || !targetClosed) throw invalid();
}
