import type { PlatformEvaluationRuntimePreflight } from "@cortex-eval/application/src/features/evaluation/platform-evaluation-engine.ts";
import type { FrozenRunCase } from "@cortex-eval/application/src/features/runs/run-rest-models.ts";

import {
  promptfooAssertionRuntimeDependency,
  type PromptfooAssertionRuntimeDependency
} from "./promptfoo-capability-projection.ts";
import type { MaterializedPromptfooConfigV1 } from "./promptfoo-config-materializer.ts";
import { runPromptfooEvaluationProcess } from "./promptfoo-evaluation-process.ts";

/** Explicit runtime preflight process dependencies. */
export interface PromptfooRuntimePreflightDependencies {
  /** Absolute fixed-version Promptfoo binary path. */
  readonly promptfooBinary: string;
  /** Owner-controlled disposable process parent. */
  readonly temporaryParent: string;
  /** Explicit project root containing the disposable parent. */
  readonly temporaryContainmentRoot: string;
  /** Bounded timeout for each interpreter smoke. */
  readonly timeoutMs: number;
}

// Collect runtime dependencies recursively without treating the projection as a whitelist.
function collectAssertionRuntimes(
  assertions: FrozenRunCase["definition"]["assertions"],
  runtimes: Set<Exclude<PromptfooAssertionRuntimeDependency, null>>
): void {
  for (const assertion of assertions) {
    const runtime = promptfooAssertionRuntimeDependency(assertion.type);
    if (runtime !== null) runtimes.add(runtime);
    if (assertion.assertions !== undefined)
      collectAssertionRuntimes(assertion.assertions, runtimes);
  }
}

/** Return only interpreter dependencies required by frozen Assertions. */
export function requiredPromptfooAssertionRuntimes(
  cases: readonly FrozenRunCase[]
): readonly Exclude<PromptfooAssertionRuntimeDependency, null>[] {
  const runtimes = new Set<Exclude<PromptfooAssertionRuntimeDependency, null>>();
  for (const testCase of cases) collectAssertionRuntimes(testCase.definition.assertions, runtimes);
  const ordered: ("PYTHON" | "RUBY")[] = [];
  if (runtimes.has("PYTHON")) ordered.push("PYTHON");
  if (runtimes.has("RUBY")) ordered.push("RUBY");
  return ordered;
}

// Build one evaluator-free Promptfoo process smoke for the selected inline language handler.
function runtimeSmokeConfig(runtime: "PYTHON" | "RUBY"): MaterializedPromptfooConfigV1 {
  const type = runtime === "PYTHON" ? "python" : "ruby";
  return {
    prompts: ["{{ task }}"],
    providers: [{ id: "echo" }],
    defaultTest: {
      options: {
        provider: {
          id: "http",
          config: {
            url: "http://127.0.0.1:1/runtime-preflight-not-called",
            method: "POST",
            headers: {
              authorization: "Bearer {{ env.CORTEX_RUNTIME_PREFLIGHT_CAPABILITY }}"
            }
          }
        }
      }
    },
    tests: [
      {
        description: `${type} inline assertion runtime preflight`,
        vars: { task: "runtime-preflight" },
        metadata: {
          case_id: `runtime-${type}`,
          req_id: `runtime-${type}`,
          task_id: `runtime-${type}`,
          business_module: "runtime",
          scenario_tag: "preflight"
        },
        providerOutput: { ok: false, errorMessage: "runtime-preflight" },
        assert: [{ type, metric: `runtime-${type}`, weight: 1, value: "output != ''" }],
        threshold: 1
      }
    ]
  };
}

/** Run only required Promptfoo inline interpreter smokes before stage claim. */
export class PromptfooRuntimePreflight implements PlatformEvaluationRuntimePreflight {
  /** Fixed-version Promptfoo binary. */
  readonly #binary: string;
  /** Disposable process parent. */
  readonly #temporaryParent: string;
  /** Project containment boundary. */
  readonly #temporaryContainmentRoot: string;
  /** Per-runtime smoke timeout. */
  readonly #timeoutMs: number;

  /** Bind the controlled runtime probe boundary. */
  public constructor(dependencies: PromptfooRuntimePreflightDependencies) {
    this.#binary = dependencies.promptfooBinary;
    this.#temporaryParent = dependencies.temporaryParent;
    this.#temporaryContainmentRoot = dependencies.temporaryContainmentRoot;
    this.#timeoutMs = dependencies.timeoutMs;
  }

  /** Execute each frozen interpreter dependency before Run state changes. */
  public async check(
    cases: readonly FrozenRunCase[]
  ): Promise<
    { readonly ok: true } | { readonly ok: false; readonly path: "runtime.python" | "runtime.ruby" }
  > {
    const runtimes = requiredPromptfooAssertionRuntimes(cases);
    for (const runtime of runtimes) {
      const path = runtime === "PYTHON" ? "runtime.python" : "runtime.ruby";
      try {
        const result = await runPromptfooEvaluationProcess({
          promptfooBinary: this.#binary,
          config: runtimeSmokeConfig(runtime),
          capabilityEnvKey: "CORTEX_RUNTIME_PREFLIGHT_CAPABILITY",
          rawCapability: "runtime-preflight-capability",
          temporaryContainmentRoot: this.#temporaryContainmentRoot,
          temporaryParent: this.#temporaryParent,
          timeoutMs: this.#timeoutMs,
          signal: new AbortController().signal
        });
        if (result.exitCode !== 0) return { ok: false, path };
      } catch {
        return { ok: false, path };
      }
    }
    return { ok: true };
  }
}
