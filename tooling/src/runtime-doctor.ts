import { spawnSync } from "node:child_process";

import { runPromptfooProcessProbe, type PromptfooCaseProbe } from "./promptfoo-process-probe.ts";

/** Runtime command environment used by the doctor. */
export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

/** Successful runtime identity. */
export interface RuntimeIdentity {
  /** Resolved executable used for the runtime. */
  executable: string;
  /** Normalized semantic version. */
  version: string;
}

/** Runtime Doctor result for the release environment. */
export interface RuntimeDoctorReport {
  /** Node.js identity. */
  node: RuntimeIdentity;
  /** Python identity. */
  python: RuntimeIdentity;
  /** Ruby identity. */
  ruby: RuntimeIdentity;
}

/** Runtime Doctor report including executable interpreter compatibility smokes. */
export interface RuntimeDoctorSmokeReport {
  /** Resolved runtime identities. */
  runtimes: RuntimeDoctorReport;
  /** Exact Promptfoo version used by both smoke assertions. */
  promptfooVersion: string;
  /** Python inline Assertion process fact. */
  pythonInlineAssertion: PromptfooCaseProbe;
  /** Ruby inline Assertion process fact. */
  rubyInlineAssertion: PromptfooCaseProbe;
}

// Parse the first semantic version in one runtime version string.
export function parseRuntimeVersion(
  output: string,
  runtime: "node" | "python" | "ruby"
): readonly [number, number, number] {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) {
    throw new Error(`RUNTIME_VERSION_PARSE:${runtime}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Resolve an interpreter command without mutating the process environment.
export function resolveInterpreterCommand(
  environmentKey: "PROMPTFOO_PYTHON" | "PROMPTFOO_RUBY",
  fallback: "python3" | "ruby",
  environment: RuntimeEnvironment
): string {
  const configured = environment[environmentKey]?.trim();
  return configured && configured !== "" ? configured : fallback;
}

// Validate the exact Node major used by all project commands.
export function validateNodeRuntime(versionOutput: string, executable: string): RuntimeIdentity {
  const [major, minor, patch] = parseRuntimeVersion(versionOutput, "node");
  if (major !== 24) {
    throw new Error(`RUNTIME_NODE_VERSION:${major}`);
  }
  return { executable, version: `${major}.${minor}.${patch}` };
}

// Inspect one command and normalize its executable and semantic version.
function inspectCommand(
  command: string,
  versionArguments: readonly string[],
  runtime: "python" | "ruby"
): RuntimeIdentity {
  const result = spawnSync(command, versionArguments, { encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) {
    throw new Error(`RUNTIME_COMMAND_UNAVAILABLE:${runtime}`);
  }
  const output = `${result.stdout}${result.stderr}`.trim();
  const [major, minor, patch] = parseRuntimeVersion(output, runtime);
  if (runtime === "python" && (major < 3 || (major === 3 && minor < 7))) {
    throw new Error(`RUNTIME_PYTHON_VERSION:${major}.${minor}.${patch}`);
  }
  const resolved = spawnSync("/usr/bin/env", ["which", command], {
    encoding: "utf8",
    shell: false
  });
  const executable = resolved.status === 0 ? resolved.stdout.trim() : command;
  return { executable, version: `${major}.${minor}.${patch}` };
}

// Run the deterministic portion of Runtime Doctor.
export function runRuntimeDoctor(
  environment: RuntimeEnvironment = process.env
): RuntimeDoctorReport {
  const node = validateNodeRuntime(process.version, process.execPath);
  const pythonCommand = resolveInterpreterCommand("PROMPTFOO_PYTHON", "python3", environment);
  const rubyCommand = resolveInterpreterCommand("PROMPTFOO_RUBY", "ruby", environment);
  return {
    node,
    python: inspectCommand(pythonCommand, ["--version"], "python"),
    ruby: inspectCommand(rubyCommand, ["--version"], "ruby")
  };
}

// Verify interpreter versions and execute the exact Promptfoo inline language paths.
export async function runRuntimeDoctorWithSmoke(
  root: string,
  environment: RuntimeEnvironment = process.env
): Promise<RuntimeDoctorSmokeReport> {
  const runtimes = runRuntimeDoctor(environment);
  const processProbe = await runPromptfooProcessProbe(root, { ...process.env, ...environment });
  if (processProbe.python.exitCode !== 0) {
    throw new Error(`RUNTIME_PYTHON_SMOKE:${processProbe.python.exitCode}`);
  }
  if (processProbe.ruby.exitCode !== 0) {
    throw new Error(`RUNTIME_RUBY_SMOKE:${processProbe.ruby.exitCode}`);
  }
  return {
    runtimes,
    promptfooVersion: processProbe.version,
    pythonInlineAssertion: processProbe.python,
    rubyInlineAssertion: processProbe.ruby
  };
}
