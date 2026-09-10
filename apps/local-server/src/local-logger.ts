import messages from "../messages/zh-CN.json" with { type: "json" };
import { appendFile, chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** Safe internal business event names with externalized Chinese text. */
export type BusinessEventName =
  | "REQUEST_COMPLETED"
  | "TEMP_OWNER_INVALID"
  | "TEMP_SYMLINK_QUARANTINED"
  | "TEMP_OWNER_CHANGED"
  | "TEMP_CONTAINMENT_REJECTED"
  | "TEMP_CLEANUP_FAILED"
  | "RUN_INPUT_FROZEN"
  | "RUN_REST_STARTED"
  | "RUN_REST_COMPLETED"
  | "RUN_CAPTURE_SAVE_FAILED"
  | "RUN_EVALUATION_STARTED"
  | "RUN_EVALUATION_COMPLETED"
  | "RUN_REPORT_STARTED"
  | "RUN_REPORT_COMPLETED"
  | "RUN_EVALUATION_RAW_CLEANUP_FAILED"
  | "RUN_ARTIFACT_CLEANUP_FAILED"
  | "RUN_CANCEL_REQUESTED"
  | "RUN_CANCELLED";

/** Closed safe log event; no arbitrary body, Prompt, Vars or Provider Output fields. */
export interface BusinessLogEvent {
  /** Internal event discriminator. */
  readonly event: BusinessEventName;
  /** UTC event timestamp. */
  readonly timestamp: string;
  /** Request correlation identity. */
  readonly requestId?: string | undefined;
  /** Safe current resource identity. */
  readonly resourceId?: string | undefined;
  /** Safe Suite-local Case key. */
  readonly caseKey?: string | undefined;
  /** Stable machine-readable error code. */
  readonly errorCode?: string | undefined;
  /** Nonnegative operation duration. */
  readonly durationMs?: number | undefined;
}

/** Text log destination. */
export interface TextLogSink {
  /** Append one already-sanitized line. */
  readonly write: (line: string) => Promise<void>;
}

/** Minimal stderr destination. */
export interface StderrSink {
  /** Write one safe fallback line. */
  readonly write: (line: string) => void;
}

/** Rotating text sink options. */
export interface RotatingTextLogSinkOptions {
  /** Current log file path. */
  readonly path: string;
  /** Rotation threshold in bytes. */
  readonly maximumBytes?: number | undefined;
  /** Number of rotated files retained in addition to the current file. */
  readonly retainedFiles?: number | undefined;
}

interface ResolvedRotatingTextLogSinkOptions {
  /** Current log file path. */
  readonly path: string;
  /** Exact rotation threshold. */
  readonly maximumBytes: number;
  /** Exact retained rotated-file count. */
  readonly retainedFiles: number;
}

// Collapse control characters and bound identifiers before writing one line.
function safeField(value: string): string {
  const sanitized = Array.from(value, (character) => {
    if (character === "\r" || character === "\n" || character === "\t") return " ";
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? "" : character;
  }).join("");
  return sanitized.slice(0, 512);
}

/** Format one closed safe event as Chinese-readable single-line text. */
export function formatBusinessLogLine(event: BusinessLogEvent): string {
  const fields: string[] = [];
  if (event.requestId !== undefined) fields.push(`requestId=${safeField(event.requestId)}`);
  if (event.resourceId !== undefined) fields.push(`resourceId=${safeField(event.resourceId)}`);
  if (event.caseKey !== undefined) fields.push(`caseKey=${safeField(event.caseKey)}`);
  if (event.errorCode !== undefined) fields.push(`errorCode=${safeField(event.errorCode)}`);
  if (event.durationMs !== undefined) {
    const duration = Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs) : 0;
    fields.push(`durationMs=${Math.round(duration)}`);
  }
  const suffix = fields.length === 0 ? "" : ` ${fields.join(" ")}`;
  return `[${safeField(event.timestamp)}] ${messages[event.event]}${suffix}\n`;
}

/** Serialized owner-only rotating file sink. */
export class RotatingTextLogSink implements TextLogSink {
  readonly #options: ResolvedRotatingTextLogSinkOptions;
  #tail: Promise<void> = Promise.resolve();

  /** Create one 10 MiB / 10-total-file sink unless explicit test limits are supplied. */
  public constructor(options: RotatingTextLogSinkOptions) {
    this.#options = {
      path: options.path,
      maximumBytes: options.maximumBytes ?? 10 * 1024 * 1024,
      retainedFiles: options.retainedFiles ?? 9
    };
    if (this.#options.maximumBytes < 1 || this.#options.retainedFiles < 1) {
      throw new Error("LOG_ROTATION_OPTIONS_INVALID");
    }
  }

  /** Serialize one append with pre-write rotation. */
  public write(line: string): Promise<void> {
    const operation = this.#tail.then(async () => this.#write(line));
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  // Append one line after enforcing rotation and owner-only permissions.
  async #write(line: string): Promise<void> {
    const directory = dirname(this.#options.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const current = await stat(this.#options.path).catch(() => null);
    const bytes = Buffer.byteLength(line);
    if (current !== null && current.size > 0 && current.size + bytes > this.#options.maximumBytes) {
      await this.#rotate();
    }
    await appendFile(this.#options.path, line, { encoding: "utf8", mode: 0o600 });
    await chmod(this.#options.path, 0o600);
  }

  // Shift controlled numeric suffixes and discard only the oldest retained file.
  async #rotate(): Promise<void> {
    await rm(`${this.#options.path}.${this.#options.retainedFiles}`, { force: true });
    for (let index = this.#options.retainedFiles - 1; index >= 1; index -= 1) {
      await rename(`${this.#options.path}.${index}`, `${this.#options.path}.${index + 1}`).catch(
        () => undefined
      );
    }
    await rename(this.#options.path, `${this.#options.path}.1`);
  }
}

/** Business logger options with explicit sinks. */
export interface ResilientBusinessLoggerOptions {
  /** Primary rotating or console-composite sink. */
  readonly sink: TextLogSink;
  /** Safe stderr fallback. */
  readonly stderr: StderrSink;
}

/** Logger that never changes business outcomes when its primary sink fails. */
export class ResilientBusinessLogger {
  readonly #options: ResilientBusinessLoggerOptions;
  #tail: Promise<void> = Promise.resolve();

  /** Create one logger with explicit failure degradation. */
  public constructor(options: ResilientBusinessLoggerOptions) {
    this.#options = options;
  }

  /** Record one safe event or emit only the externalized stderr fallback. */
  public record(event: BusinessLogEvent): Promise<void> {
    const operation = this.#record(event);
    this.#tail = Promise.all([this.#tail, operation]).then(() => undefined);
    return operation;
  }

  /** Wait until every accepted log event has reached its sink or fallback. */
  public flush(): Promise<void> {
    return this.#tail;
  }

  // Execute one resilient write without exposing sink failures.
  async #record(event: BusinessLogEvent): Promise<void> {
    try {
      await this.#options.sink.write(formatBusinessLogLine(event));
    } catch {
      this.#options.stderr.write(`${messages.LOG_WRITE_FALLBACK}\n`);
    }
  }
}
