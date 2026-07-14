import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runBoundedProcess } from "./promptfoo-process-probe.ts";

/** Stable row facts emitted by one locked Promptfoo comparison phase. */
export interface PromptfooComparisonPhaseProbe {
  /** Promptfoo process exit code. */
  readonly exitCode: number;
  /** Component Assertion types for each compared output row. */
  readonly componentTypes: readonly (readonly string[])[];
  /** Final success for each compared output row. */
  readonly successes: readonly boolean[];
  /** Final score for each compared output row. */
  readonly scores: readonly number[];
  /** Final aggregate reason for each compared output row. */
  readonly reasons: readonly string[];
}

/** Stable facts for Promptfoo's two post-evaluation comparison phases. */
export interface PromptfooSpecialAssertionProbe {
  /** Real `select-best` phase facts. */
  readonly selectBest: PromptfooComparisonPhaseProbe;
  /** Real `max-score` phase facts. */
  readonly maxScore: PromptfooComparisonPhaseProbe;
}

// Narrow one untrusted probe value to a record before field access.
function probeRecord(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as Record<string, unknown>;
}

// Read and validate the small stable comparison subset from one Promptfoo output file.
async function readComparisonProbe(
  path: string,
  exitCode: number
): Promise<PromptfooComparisonPhaseProbe> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  const root = probeRecord(parsed, "PROMPTFOO_SPECIAL_PROBE_ROOT");
  const results = probeRecord(root.results, "PROMPTFOO_SPECIAL_PROBE_RESULTS");
  const rows = results.results;
  if (!Array.isArray(rows) || rows.length !== 2) {
    throw new Error("PROMPTFOO_SPECIAL_PROBE_ROWS");
  }
  const componentTypes: string[][] = [];
  const successes: boolean[] = [];
  const scores: number[] = [];
  const reasons: string[] = [];
  for (const [rowIndex, rawRow] of rows.entries()) {
    const row = probeRecord(rawRow, `PROMPTFOO_SPECIAL_PROBE_ROW:${rowIndex}`);
    const grading = probeRecord(row.gradingResult, `PROMPTFOO_SPECIAL_PROBE_GRADING:${rowIndex}`);
    const components = grading.componentResults;
    if (
      typeof row.success !== "boolean" ||
      typeof row.score !== "number" ||
      !Number.isFinite(row.score) ||
      typeof grading.reason !== "string" ||
      !Array.isArray(components)
    ) {
      throw new Error(`PROMPTFOO_SPECIAL_PROBE_ROW:${rowIndex}`);
    }
    const types = components.map((rawComponent: unknown, componentIndex: number) => {
      const component = probeRecord(
        rawComponent,
        `PROMPTFOO_SPECIAL_PROBE_COMPONENT:${rowIndex}:${componentIndex}`
      );
      const assertion = probeRecord(
        component.assertion,
        `PROMPTFOO_SPECIAL_PROBE_ASSERTION:${rowIndex}:${componentIndex}`
      );
      const type = assertion.type;
      if (typeof type !== "string") {
        throw new Error(`PROMPTFOO_SPECIAL_PROBE_COMPONENT:${rowIndex}:${componentIndex}`);
      }
      return type;
    });
    componentTypes.push(types);
    successes.push(row.success);
    scores.push(row.score);
    reasons.push(grading.reason);
  }
  return { exitCode, componentTypes, successes, scores, reasons };
}

// Execute one isolated locked Promptfoo config and import its comparison facts.
async function runComparisonConfig(
  root: string,
  directory: string,
  name: string,
  config: Readonly<Record<string, unknown>>
): Promise<PromptfooComparisonPhaseProbe> {
  const configPath = join(directory, `${name}.config.json`);
  const outputPath = join(directory, `${name}.output.json`);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  const processResult = await runBoundedProcess(
    resolve(root, "node_modules/.bin/promptfoo"),
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
    directory
  );
  if (processResult.exitCode !== 0 && processResult.exitCode !== 100) {
    throw new Error(
      `PROMPTFOO_SPECIAL_PROBE_PROCESS:${name}:${processResult.exitCode}:${processResult.stderr.slice(0, 400)}`
    );
  }
  return await readComparisonProbe(outputPath, processResult.exitCode);
}

/** Run real locked Promptfoo processes that expose comparison component and aggregate semantics. */
export async function runPromptfooSpecialAssertionProbe(
  root: string
): Promise<PromptfooSpecialAssertionProbe> {
  const directory = await mkdtemp(join(tmpdir(), "cortex-eval-special-assertion-probe-"));
  const evaluator = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ output: "0" }));
  });
  await new Promise<void>((resolvePromise) => evaluator.listen(0, "127.0.0.1", resolvePromise));
  try {
    const address = evaluator.address();
    if (!address || typeof address === "string") {
      throw new Error("PROMPTFOO_SPECIAL_PROBE_SERVER");
    }
    const common = {
      prompts: ["preferred output", "other output"],
      providers: [{ id: "echo" }]
    };
    const selectBest = await runComparisonConfig(root, directory, "select-best", {
      ...common,
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
      tests: [
        {
          threshold: 0.75,
          assert: [
            {
              type: "select-best",
              value: "prefer the exact output",
              metric: "selection",
              weight: 1
            },
            { type: "contains", value: "preferred", metric: "quality", weight: 1 }
          ]
        }
      ]
    });
    const maxScore = await runComparisonConfig(root, directory, "max-score", {
      ...common,
      tests: [
        {
          threshold: 0.75,
          assert: [
            {
              type: "max-score",
              value: { method: "average" },
              metric: "selection",
              weight: 1
            },
            { type: "contains", value: "preferred", metric: "quality", weight: 1 }
          ]
        }
      ]
    });
    return { selectBest, maxScore };
  } finally {
    await new Promise<void>((resolvePromise, reject) =>
      evaluator.close((error) => (error ? reject(error) : resolvePromise()))
    );
    await rm(directory, { force: true, recursive: true });
  }
}
