import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Result facts for one Promptfoo process. */
export interface PromptfooCaseProbe {
  /** Process exit code. */
  exitCode: number;
  /** Imported component result count. */
  componentResults: number;
}

/** Stable facts established by the P0 process probe. */
export interface PromptfooProcessProbe {
  /** Exact installed Promptfoo version. */
  version: string;
  /** Provider requests observed despite precomputed output. */
  providerRequestCount: number;
  /** Passing assertion process facts. */
  pass: PromptfooCaseProbe;
  /** Failing assertion process facts. */
  fail: PromptfooCaseProbe;
  /** Python inline Assertion smoke facts. */
  python: PromptfooCaseProbe;
  /** Ruby inline Assertion smoke facts. */
  ruby: PromptfooCaseProbe;
  /** Boolean equals payload runtime fact. */
  booleanEquals: PromptfooCaseProbe;
  /** Numeric contains-any array runtime fact. */
  numericContainsAny: PromptfooCaseProbe;
  /** llm-rubric string-list payload runtime fact. */
  llmRubricStringList: PromptfooCaseProbe;
}

/** Completed child process output. */
export interface ProcessResult {
  /** Process exit code. */
  exitCode: number;
  /** Safe stderr retained only for local probe failures. */
  stderr: string;
  /** Safe stdout retained only for local probe failures. */
  stdout: string;
}

/** Environment explicitly inherited by one isolated child process. */
type ProcessEnvironment = Readonly<Record<string, string | undefined>>;

// Spawn one command without a shell and collect bounded diagnostic output.
export async function runBoundedProcess(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  timeoutMs = 15_000,
  killGraceMs = 1_000,
  environment: ProcessEnvironment = process.env
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: {
        ...environment,
        PROMPTFOO_CONFIG_DIR: resolve(cwd, ".promptfoo"),
        PROMPTFOO_DISABLE_TELEMETRY: "1",
        PROMPTFOO_DISABLE_UPDATE: "1"
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    }, timeoutMs);
    const clearTimers = (): void => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 8_192) {
        stdout += chunk;
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8_192) {
        stderr += chunk;
      }
    });
    child.once("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.once("close", (code) => {
      clearTimers();
      if (timedOut) {
        reject(new Error("PROMPTFOO_PROBE_TIMEOUT"));
        return;
      }
      resolvePromise({ exitCode: code ?? 3, stderr, stdout });
    });
  });
}

// Count assertion components from the stable Promptfoo JSON location.
function countComponentResults(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PROMPTFOO_PROBE_OUTPUT");
  }
  const results = (value as { results?: unknown }).results;
  if (typeof results !== "object" || results === null || Array.isArray(results)) {
    throw new Error("PROMPTFOO_PROBE_RESULTS");
  }
  const rows = (results as { results?: unknown }).results;
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("PROMPTFOO_PROBE_ROWS");
  }
  const gradingResult = (rows[0] as { gradingResult?: unknown }).gradingResult;
  if (typeof gradingResult !== "object" || gradingResult === null || Array.isArray(gradingResult)) {
    throw new Error("PROMPTFOO_PROBE_GRADING");
  }
  const components = (gradingResult as { componentResults?: unknown }).componentResults;
  if (!Array.isArray(components)) {
    throw new Error("PROMPTFOO_PROBE_COMPONENTS");
  }
  return components.length;
}

// Execute one passing or failing precomputed-output config in an isolated directory.
async function runCaseProbe(
  binary: string,
  directory: string,
  providerUrl: string,
  assertion: Readonly<Record<string, unknown>>,
  name: string,
  providerOutput: unknown,
  environment: ProcessEnvironment,
  evaluatorProviderUrl?: string
): Promise<PromptfooCaseProbe> {
  const configPath = join(directory, `${name}.config.json`);
  const outputPath = join(directory, `${name}.output.json`);
  const config = {
    prompts: ["{{ input }}"],
    providers: [
      { id: "http", config: { url: providerUrl, method: "POST", body: { prompt: "{{ prompt }}" } } }
    ],
    ...(evaluatorProviderUrl
      ? {
          defaultTest: {
            options: {
              provider: {
                id: "http",
                config: {
                  url: evaluatorProviderUrl,
                  method: "POST",
                  body: { prompt: "{{ prompt }}" },
                  responseParser: "json.output",
                  maxRetries: 0
                }
              }
            }
          }
        }
      : {}),
    tests: [
      {
        description: `${name} precomputed provider output`,
        vars: { input: "provider must not be called" },
        providerOutput,
        assert: [{ ...assertion, metric: "probe" }]
      }
    ]
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  const result = await runBoundedProcess(
    binary,
    [
      "eval",
      "--config",
      configPath,
      "--output",
      outputPath,
      "--no-cache",
      "--no-share",
      "--no-table",
      "--no-progress-bar"
    ],
    directory,
    15_000,
    1_000,
    environment
  );
  if (![0, 100].includes(result.exitCode)) {
    throw new Error(`PROMPTFOO_PROBE_PROCESS:${result.exitCode}:${result.stderr.slice(0, 400)}`);
  }
  let outputContent: string;
  try {
    outputContent = await readFile(outputPath, "utf8");
  } catch {
    throw new Error(
      `PROMPTFOO_PROBE_OUTPUT_MISSING:${result.exitCode}:${result.stdout.slice(-1_500)}:${result.stderr.slice(-1_500)}`
    );
  }
  const output = JSON.parse(outputContent) as unknown;
  return { exitCode: result.exitCode, componentResults: countComponentResults(output) };
}

// Establish the exact version, precomputed output, exit code and component facts.
export async function runPromptfooProcessProbe(
  root: string,
  environment: ProcessEnvironment = process.env
): Promise<PromptfooProcessProbe> {
  const directory = await mkdtemp(join(tmpdir(), "cortex-eval-promptfoo-probe-"));
  let providerRequestCount = 0;
  const server = createServer((request, response) => {
    if (request.url === "/evaluator") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          output: JSON.stringify({ reason: "capability probe", score: 1, pass: true })
        })
      );
      return;
    }
    providerRequestCount += 1;
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end('{"error":"provider should not be called"}');
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("PROMPTFOO_PROBE_SERVER");
    }
    const binary = resolve(root, "node_modules/.bin/promptfoo");
    const versionResult = await runBoundedProcess(
      binary,
      ["--version"],
      directory,
      15_000,
      1_000,
      environment
    );
    if (versionResult.exitCode !== 0) {
      throw new Error(`PROMPTFOO_PROBE_VERSION:${versionResult.exitCode}`);
    }
    const packageJson = JSON.parse(
      await readFile(resolve(root, "node_modules/promptfoo/package.json"), "utf8")
    ) as { version?: unknown };
    const pass = await runCaseProbe(
      binary,
      directory,
      `http://127.0.0.1:${address.port}`,
      { type: "equals", value: "actual" },
      "pass",
      "actual",
      environment
    );
    const fail = await runCaseProbe(
      binary,
      directory,
      `http://127.0.0.1:${address.port}`,
      { type: "equals", value: "different" },
      "fail",
      "actual",
      environment
    );
    const python = await runCaseProbe(
      binary,
      directory,
      `http://127.0.0.1:${address.port}`,
      { type: "python", value: "output == 'actual'" },
      "python",
      "actual",
      environment
    );
    const ruby = await runCaseProbe(
      binary,
      directory,
      `http://127.0.0.1:${address.port}`,
      { type: "ruby", value: "output == 'actual'" },
      "ruby",
      "actual",
      environment
    );
    const booleanEquals = await runCaseProbe(
      binary,
      directory,
      `http://127.0.0.1:${address.port}`,
      { type: "equals", value: true },
      "boolean-equals",
      "true",
      environment
    );
    const numericContainsAny = await runCaseProbe(
      binary,
      directory,
      `http://127.0.0.1:${address.port}`,
      { type: "contains-any", value: [42, 99] },
      "numeric-contains-any",
      "value 42",
      environment
    );
    const llmRubricStringList = await runCaseProbe(
      binary,
      directory,
      `http://127.0.0.1:${address.port}`,
      { type: "llm-rubric", value: ["criterion one", "criterion two"] },
      "llm-rubric-string-list",
      "actual",
      environment,
      `http://127.0.0.1:${address.port}/evaluator`
    );
    return {
      version: String(packageJson.version),
      providerRequestCount,
      pass,
      fail,
      python,
      ruby,
      booleanEquals,
      numericContainsAny,
      llmRubricStringList
    };
  } finally {
    await new Promise<void>((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise()))
    );
    await rm(directory, { force: true, recursive: true });
  }
}

/** Stable facts produced by running the real REST fixture through Promptfoo. */
export interface RealFixtureProcessProbe {
  /** Provider requests observed despite precomputed outputs. */
  providerRequestCount: number;
  /** Evaluator Bridge requests made by the original llm-rubric assertions. */
  evaluatorRequestCount: number;
  /** Real fixture case count. */
  caseCount: number;
  /** Rows whose Case ID stayed aligned with the isolated source fixture. */
  alignedCaseCount: number;
  /** Imported assertion component count. */
  componentResults: number;
  /** Original assertion type sequence returned by Promptfoo components. */
  assertionTypes: string[];
  /** Promptfoo process exit code. */
  exitCode: number;
}

// Read all component result arrays from a Promptfoo JSON export.
function readResultRows(
  value: unknown
): { caseId: string; components: unknown[]; assertionTypes: string[] }[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PROMPTFOO_REAL_OUTPUT");
  }
  const results = (value as { results?: unknown }).results;
  if (typeof results !== "object" || results === null || Array.isArray(results)) {
    throw new Error("PROMPTFOO_REAL_RESULTS");
  }
  const rows = (results as { results?: unknown }).results;
  if (!Array.isArray(rows)) {
    throw new Error("PROMPTFOO_REAL_ROWS");
  }
  return rows.map((row, index) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error(`PROMPTFOO_REAL_ROW:${index}`);
    }
    const gradingResult = (row as { gradingResult?: unknown }).gradingResult;
    if (
      typeof gradingResult !== "object" ||
      gradingResult === null ||
      Array.isArray(gradingResult)
    ) {
      throw new Error(`PROMPTFOO_REAL_GRADING:${index}`);
    }
    const components = (gradingResult as { componentResults?: unknown }).componentResults;
    if (!Array.isArray(components)) {
      throw new Error(`PROMPTFOO_REAL_COMPONENTS:${index}`);
    }
    const metadata = (row as { metadata?: unknown }).metadata;
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      Array.isArray(metadata) ||
      typeof (metadata as { case_id?: unknown }).case_id !== "string"
    ) {
      throw new Error(`PROMPTFOO_REAL_CASE_ID:${index}`);
    }
    const assertionTypes = components.map((component, componentIndex) => {
      if (typeof component !== "object" || component === null || Array.isArray(component)) {
        throw new Error(`PROMPTFOO_REAL_COMPONENT:${index}:${componentIndex}`);
      }
      const assertion = (component as { assertion?: unknown }).assertion;
      if (
        typeof assertion !== "object" ||
        assertion === null ||
        Array.isArray(assertion) ||
        typeof (assertion as { type?: unknown }).type !== "string"
      ) {
        throw new Error(`PROMPTFOO_REAL_ASSERTION:${index}:${componentIndex}`);
      }
      return (assertion as { type: string }).type;
    });
    return { caseId: (metadata as { case_id: string }).case_id, components, assertionTypes };
  });
}

// Run only an isolated copy of the committed real fixture; never mutate source evidence.
export async function runRealFixtureProcessProbe(root: string): Promise<RealFixtureProcessProbe> {
  const sourcePath = resolve(root, "test_suite/current/run_result/loona_promptfoo_tests.json");
  const source = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error("PROMPTFOO_REAL_FIXTURE");
  }
  const directory = await mkdtemp(join(tmpdir(), "cortex-eval-real-fixture-probe-"));
  let providerRequestCount = 0;
  let evaluatorRequestCount = 0;
  const server = createServer((request, response) => {
    if (request.url === "/evaluator") {
      evaluatorRequestCount += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          output: JSON.stringify({ reason: "isolated evaluator probe", score: 1, pass: true })
        })
      );
      return;
    }
    providerRequestCount += 1;
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end('{"error":"provider should not be called"}');
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("PROMPTFOO_REAL_SERVER");
    }
    const sourceCaseIds: string[] = [];
    const sourceAssertionTypes: string[][] = [];
    const tests = source.map((item, index) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(`PROMPTFOO_REAL_CASE:${index}`);
      }
      const record = item as Record<string, unknown>;
      const metadata = record.metadata;
      if (
        typeof metadata !== "object" ||
        metadata === null ||
        Array.isArray(metadata) ||
        typeof (metadata as { case_id?: unknown }).case_id !== "string"
      ) {
        throw new Error(`PROMPTFOO_REAL_CASE_ID:${index}`);
      }
      sourceCaseIds.push((metadata as { case_id: string }).case_id);
      if (!Array.isArray(record.assert)) {
        throw new Error(`PROMPTFOO_REAL_ASSERTIONS:${index}`);
      }
      const assertionTypes = record.assert.map((assertion, assertionIndex) => {
        if (
          typeof assertion !== "object" ||
          assertion === null ||
          Array.isArray(assertion) ||
          typeof (assertion as { type?: unknown }).type !== "string"
        ) {
          throw new Error(`PROMPTFOO_REAL_ASSERTION:${index}:${assertionIndex}`);
        }
        return (assertion as { type: string }).type;
      });
      sourceAssertionTypes.push(assertionTypes);
      return {
        description: record.description,
        vars: record.vars,
        metadata: record.metadata,
        providerOutput: record.providerOutput,
        assert: record.assert
      };
    });
    const rubricDirectory = join(directory, "rubric_prompt");
    await mkdir(rubricDirectory, { recursive: true });
    for (const file of ["reply_text_repetition_rubric.json", "reply_text_transition_rubric.json"]) {
      await copyFile(
        resolve(root, "test_suite/current/rubric_prompt", file),
        join(rubricDirectory, file)
      );
    }
    const configPath = join(directory, "real-fixture.config.json");
    const outputPath = join(directory, "real-fixture.output.json");
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          prompts: ["{{ task }}"],
          providers: [
            {
              id: "http",
              config: {
                url: `http://127.0.0.1:${address.port}`,
                method: "POST",
                body: { prompt: "{{ prompt }}" }
              }
            }
          ],
          defaultTest: {
            options: {
              provider: {
                id: "http",
                config: {
                  url: `http://127.0.0.1:${address.port}/evaluator`,
                  method: "POST",
                  body: { prompt: "{{ prompt }}" },
                  responseParser: "json.output",
                  maxRetries: 0
                }
              }
            }
          },
          tests
        },
        null,
        2
      )}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    const binary = resolve(root, "node_modules/.bin/promptfoo");
    const result = await runBoundedProcess(
      binary,
      [
        "eval",
        "--config",
        configPath,
        "--output",
        outputPath,
        "--no-cache",
        "--no-share",
        "--no-table",
        "--no-progress-bar"
      ],
      directory,
      30_000
    );
    if (![0, 100].includes(result.exitCode)) {
      throw new Error(
        `PROMPTFOO_REAL_PROCESS:${result.exitCode}:${result.stdout.slice(-800)}:${result.stderr.slice(-800)}`
      );
    }
    const output = JSON.parse(await readFile(outputPath, "utf8")) as unknown;
    const rows = readResultRows(output);
    const alignedCaseCount = rows.filter(
      (row, index) => row.caseId === sourceCaseIds[index]
    ).length;
    if (
      rows.length !== source.length ||
      alignedCaseCount !== source.length ||
      rows.some(
        (row, index) =>
          JSON.stringify(row.assertionTypes) !== JSON.stringify(sourceAssertionTypes[index])
      )
    ) {
      throw new Error("PROMPTFOO_REAL_ALIGNMENT");
    }
    return {
      providerRequestCount,
      evaluatorRequestCount,
      caseCount: source.length,
      alignedCaseCount,
      componentResults: rows.reduce((total, row) => total + row.components.length, 0),
      assertionTypes: rows.flatMap((row) => row.assertionTypes),
      exitCode: result.exitCode
    };
  } finally {
    await new Promise<void>((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise()))
    );
    await rm(directory, { force: true, recursive: true });
  }
}
