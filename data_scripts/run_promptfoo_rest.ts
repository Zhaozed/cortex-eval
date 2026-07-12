#!/usr/bin/env -S npx tsx
/** Run promptfoo test cases against a JSON-configured REST provider. */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatRunnerMessage,
  loadRunnerMessages,
  type RunnerMessages
} from "./run_promptfoo_rest_message.ts";
import type {
  PromptfooTestCase,
  RestProviderConfig,
  RunPromptfooRestSuiteOptions,
  RunPromptfooRestSuiteResult
} from "./run_promptfoo_rest_types.ts";

export type {
  JsonPrimitive,
  JsonValue,
  PromptfooMetadata,
  PromptfooTestCase,
  RestProviderConfig,
  RestRunErrorMetadata,
  RestRunMetadata,
  RunPromptfooRestSuiteOptions,
  RunPromptfooRestSuiteResult
} from "./run_promptfoo_rest_types.ts";

/** Successful HTTP result before it is merged into a test case. */
interface RequestSuccess {
  /** Parsed JSON value or raw response text. */
  output: unknown;
  /** HTTP response status. */
  status: number;
  /** Request duration in milliseconds. */
  durationMs: number;
}

/** Error carrying an optional HTTP status. */
class RequestCaseError extends Error {
  /** HTTP response status when available. */
  readonly status: number | undefined;

  // Create one case-scoped request error.
  constructor(message: string, status?: number) {
    super(message);
    this.name = "RequestCaseError";
    this.status = status;
  }
}

const DEFAULT_INPUT = "test_suite/current/cases/loona_promptfoo_tests.json";
const DEFAULT_PROVIDER = "test_suite/current/provider.json";
const DEFAULT_OUTPUT = "test_suite/current/run_result/loona_promptfoo_tests.json";
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 60_000;
const TEMPLATE_PATTERN = /{{\s*([^}]+?)\s*}}/g;
const VARIABLE_REFERENCE_PATTERN = /^vars(?:\.[A-Za-z_$][\w$]*)+$/;
// Return whether a boundary value is a non-array object.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Load and parse JSON while preserving the source path in errors.
async function readJson(path: string, messages: RunnerMessages): Promise<unknown> {
  const content = await readFile(path, "utf8");
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(formatRunnerMessage(messages, "invalid_json", { path, error }), {
      cause: error
    });
  }
}

// Resolve a relative path against the configured working directory.
function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

// Validate promptfoo input at the filesystem boundary.
function parseTestCases(
  value: unknown,
  path: string,
  messages: RunnerMessages
): PromptfooTestCase[] {
  if (!Array.isArray(value)) {
    throw new Error(formatRunnerMessage(messages, "invalid_test_array", { path }));
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(formatRunnerMessage(messages, "invalid_test_case", { path, index }));
    }
    return item;
  });
}

// Validate the supported provider contract at the filesystem boundary.
function parseProvider(value: unknown, path: string, messages: RunnerMessages): RestProviderConfig {
  if (!isRecord(value)) {
    throw new Error(formatRunnerMessage(messages, "invalid_provider", { path }));
  }
  if (typeof value.url !== "string" || value.url.trim() === "") {
    throw new Error(formatRunnerMessage(messages, "invalid_provider_url"));
  }
  if (typeof value.method !== "string" || value.method.trim() === "") {
    throw new Error(formatRunnerMessage(messages, "invalid_provider_method"));
  }
  const rawHeaders = value.headers ?? {};
  if (
    !isRecord(rawHeaders) ||
    Object.values(rawHeaders).some((header) => typeof header !== "string")
  ) {
    throw new Error(formatRunnerMessage(messages, "invalid_provider_headers"));
  }
  return {
    url: value.url,
    method: value.method.toUpperCase(),
    headers: rawHeaders as Record<string, string>,
    body: value.body
  };
}

// Create the stable identity used to merge an existing providerOutput.
function getCaseKey(testCase: PromptfooTestCase, index: number): string {
  const caseId = testCase.metadata?.case_id;
  if (typeof caseId === "string" && caseId !== "") {
    return `case_id:${caseId}`;
  }
  if (typeof testCase.description === "string" && testCase.description !== "") {
    return `description:${testCase.description}`;
  }
  return `index:${index}`;
}

// Reject ambiguous case identities before existing results are merged.
function validateUniqueCaseKeys(testCases: PromptfooTestCase[], messages: RunnerMessages): void {
  const keys = new Set<string>();
  testCases.forEach((testCase, index) => {
    const key = getCaseKey(testCase, index);
    if (keys.has(key)) {
      throw new Error(formatRunnerMessage(messages, "duplicate_case_key", { key }));
    }
    keys.add(key);
  });
}

// Resolve a dot-separated expression against test vars.
function resolveVariable(
  expression: string,
  vars: Record<string, unknown>,
  messages: RunnerMessages
): unknown {
  const normalized = expression.trim().replace(/^vars\./, "");
  const segments = normalized.split(".");
  let current: unknown = vars;
  for (const segment of segments) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      throw new RequestCaseError(
        formatRunnerMessage(messages, "missing_template_variable", { expression })
      );
    }
    current = current[segment];
  }
  return current;
}

// Replace promptfoo-style variable templates in a string.
function interpolateTemplate(
  template: string,
  vars: Record<string, unknown>,
  messages: RunnerMessages
): string {
  return template.replace(TEMPLATE_PATTERN, (_match, expression: string) => {
    const value = resolveVariable(expression, vars, messages);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (value === null) {
      return "null";
    }
    throw new RequestCaseError(
      formatRunnerMessage(messages, "unsupported_template_value", { expression })
    );
  });
}

// Resolve the configured body and serialize structured values as JSON.
function buildRequestBody(
  configuredBody: unknown,
  vars: Record<string, unknown>,
  headers: Headers,
  messages: RunnerMessages
): BodyInit | undefined {
  let body = configuredBody;
  if (
    typeof configuredBody === "string" &&
    VARIABLE_REFERENCE_PATTERN.test(configuredBody.trim())
  ) {
    body = resolveVariable(configuredBody, vars, messages);
  } else if (typeof configuredBody === "string") {
    body = interpolateTemplate(configuredBody, vars, messages);
  }
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (!headers.has("content-type")) {
    headers.set("Content-Type", "application/json");
  }
  return JSON.stringify(body);
}

// Parse JSON responses while retaining non-JSON response text.
function parseResponseOutput(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// Execute one REST request with timeout and normalized errors.
async function executeRequest(
  testCase: PromptfooTestCase,
  provider: RestProviderConfig,
  timeoutMs: number,
  messages: RunnerMessages
): Promise<RequestSuccess> {
  const vars = testCase.vars ?? {};
  const url = interpolateTemplate(provider.url, vars, messages);
  const headers = new Headers();
  for (const [name, value] of Object.entries(provider.headers)) {
    headers.set(name, interpolateTemplate(value, vars, messages));
  }
  const body =
    provider.method === "GET" || provider.method === "HEAD"
      ? undefined
      : buildRequestBody(provider.body, vars, headers, messages);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    const request: RequestInit = {
      method: provider.method,
      headers,
      signal: controller.signal
    };
    if (body !== undefined) {
      request.body = body;
    }
    const response = await fetch(url, request);
    const responseText = await response.text();
    if (!response.ok) {
      throw new RequestCaseError(
        formatRunnerMessage(messages, "http_failure", {
          status: response.status,
          body: responseText.slice(0, 500)
        }),
        response.status
      );
    }
    return {
      output: parseResponseOutput(responseText),
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt)
    };
  } catch (error) {
    if (error instanceof RequestCaseError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new RequestCaseError(formatRunnerMessage(messages, "request_timeout", { timeoutMs }));
    }
    throw new RequestCaseError(formatRunnerMessage(messages, "request_failure", { error }));
  } finally {
    clearTimeout(timer);
  }
}

// Write one file through a sibling temporary file and atomic rename.
async function writeJsonAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

// Create a serialized writer so concurrent workers cannot overwrite newer state.
function createResultWriter(path: string, testCases: PromptfooTestCase[]): () => Promise<void> {
  let writeQueue: Promise<void> = Promise.resolve();
  return (): Promise<void> => {
    const content = `${JSON.stringify(testCases, null, 2)}\n`;
    const currentWrite = writeQueue.then(() => writeJsonAtomically(path, content));
    writeQueue = currentWrite.catch(() => undefined);
    return currentWrite;
  };
}

// Run asynchronous work through a fixed-size worker pool.
async function runWithConcurrency(
  indexes: number[],
  maxConcurrency: number,
  worker: (index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runWorker = async (): Promise<void> => {
    while (cursor < indexes.length) {
      const current = indexes[cursor];
      cursor += 1;
      if (current === undefined) {
        break;
      }
      await worker(current);
    }
  };
  const workerCount = Math.min(maxConcurrency, indexes.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

// Merge only successful provider outputs into current input definitions.
function mergeExistingOutputs(
  current: PromptfooTestCase[],
  existing: PromptfooTestCase[],
  force: boolean
): { cases: PromptfooTestCase[]; pending: number[]; skipped: number } {
  const existingByKey = new Map(
    existing.map((testCase, index) => [getCaseKey(testCase, index), testCase])
  );
  const pending: number[] = [];
  let skipped = 0;
  const cases = current.map((testCase, index) => {
    const merged = { ...testCase, metadata: { ...(testCase.metadata ?? {}) } };
    const previous = existingByKey.get(getCaseKey(testCase, index));
    if (!force && previous && Object.hasOwn(previous, "providerOutput")) {
      merged.providerOutput = previous.providerOutput;
      if (previous.metadata?.rest_run) {
        merged.metadata = { ...merged.metadata, rest_run: previous.metadata.rest_run };
      }
      skipped += 1;
      return merged;
    }
    delete merged.providerOutput;
    delete merged.metadata.rest_run;
    delete merged.metadata.rest_run_error;
    pending.push(index);
    return merged;
  });
  return { cases, pending, skipped };
}

// Load an existing output array when present; a missing file starts a fresh run.
async function loadExistingOutput(
  path: string,
  messages: RunnerMessages
): Promise<PromptfooTestCase[]> {
  try {
    return parseTestCases(await readJson(path, messages), path, messages);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

// Run the REST suite and emit promptfoo tests with providerOutput values.
export async function runPromptfooRestSuite(
  options: RunPromptfooRestSuiteOptions = {}
): Promise<RunPromptfooRestSuiteResult> {
  const messages = await loadRunnerMessages();
  const cwd = resolve(options.cwd ?? process.cwd());
  const inputPath = resolvePath(cwd, options.inputPath ?? DEFAULT_INPUT);
  const providerPath = resolvePath(cwd, options.providerPath ?? DEFAULT_PROVIDER);
  const outputPath = resolvePath(cwd, options.outputPath ?? DEFAULT_OUTPUT);
  const maxConcurrency = parsePositiveInteger(
    options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    "maxConcurrency",
    messages
  );
  const timeoutMs = parsePositiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
    messages
  );
  const current = parseTestCases(await readJson(inputPath, messages), inputPath, messages);
  const provider = parseProvider(await readJson(providerPath, messages), providerPath, messages);
  const existing = await loadExistingOutput(outputPath, messages);
  validateUniqueCaseKeys(current, messages);
  const merged = mergeExistingOutputs(current, existing, options.force ?? false);
  const writeResult = createResultWriter(outputPath, merged.cases);
  let succeeded = 0;
  let failed = 0;

  await writeResult();
  await runWithConcurrency(merged.pending, maxConcurrency, async (index) => {
    const testCase = merged.cases[index];
    if (!testCase) {
      throw new Error(
        formatRunnerMessage(messages, "invalid_test_case", { path: inputPath, index })
      );
    }
    try {
      const result = await executeRequest(testCase, provider, timeoutMs, messages);
      testCase.providerOutput = result.output;
      testCase.metadata = {
        ...(testCase.metadata ?? {}),
        rest_run: {
          status: result.status,
          duration_ms: result.durationMs,
          completed_at: new Date().toISOString()
        }
      };
      delete testCase.metadata.rest_run_error;
      succeeded += 1;
    } catch (error) {
      const requestError =
        error instanceof RequestCaseError
          ? error
          : new RequestCaseError(formatRunnerMessage(messages, "request_failure", { error }));
      delete testCase.providerOutput;
      const restRunError = {
        message: requestError.message,
        occurred_at: new Date().toISOString(),
        ...(requestError.status === undefined ? {} : { status: requestError.status })
      };
      testCase.metadata = {
        ...(testCase.metadata ?? {}),
        rest_run_error: restRunError
      };
      delete testCase.metadata.rest_run;
      failed += 1;
    }
    await writeResult();
  });

  return { total: merged.cases.length, skipped: merged.skipped, succeeded, failed, outputPath };
}

// Validate programmatic numeric options.
function parsePositiveInteger(value: number, name: string, messages: RunnerMessages): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(
      formatRunnerMessage(messages, "invalid_positive_integer", { argument: name, value })
    );
  }
  return value;
}

const isDirectExecution = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;
if (isDirectExecution) {
  import("./run_promptfoo_rest_cli.ts")
    .then(({ runPromptfooRestCli }) => runPromptfooRestCli())
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
