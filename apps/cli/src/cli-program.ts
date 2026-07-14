import cliMessages from "../messages/zh-CN.json" with { type: "json" };
import contractMessages from "@cortex-eval/contracts/messages/zh-CN.json" with { type: "json" };
import {
  CliExecutionEventV1Schema,
  type CliExecutionEventV1,
  CliPackageEventV1Schema,
  type CliPackageEventV1
} from "@cortex-eval/contracts/src/cli-contracts.ts";
import { ERROR_CODES, type ErrorCode } from "@cortex-eval/contracts/src/error-contracts.ts";
import { UuidV7Schema } from "@cortex-eval/contracts/src/contracts-primitives.ts";
import {
  WorkPackageExportRequestV1Schema,
  type WorkPackageExportRequestV1
} from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";
import type { WorkPackageValidationSummary } from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { ReceivedWorkPackage } from "@cortex-eval/work-package/src/work-package-export-receiver.ts";
import type { WorkPackageRestRunResult } from "./work-package-rest-run-service.ts";
import type { WorkPackageEvaluationRunResult } from "./work-package-evaluation-run-service.ts";
import type { WorkPackagePipelineRunResult } from "./pipeline-command-service.ts";
import { Command, CommanderError } from "commander";

/** Controlled CLI output sinks. */
export interface CliOutput {
  /** Machine protocol or ordinary success output. */
  readonly stdout: (value: string) => void;
  /** Human diagnostics only. */
  readonly stderr: (value: string) => void;
}

/** Closed package command use cases, independent of Commander and transport details. */
export interface PackageCommandService {
  /** Export and atomically publish one platform Work Package. */
  readonly exportPackage: (
    request: WorkPackageExportRequestV1,
    targetPath: string,
    signal: AbortSignal
  ) => Promise<ReceivedWorkPackage>;
  /** Validate one local package including all existing Execution contexts. */
  readonly validatePackage: (
    packagePath: string,
    signal: AbortSignal
  ) => Promise<WorkPackageValidationSummary>;
}

/** Cleaned `rest run` use-case input independent of Commander. */
export interface RestRunCommandInput {
  /** Existing Work Package directory. */
  readonly packagePath: string;
  /** Optional external Secret file. */
  readonly envFile?: string | undefined;
  /** New, retry-failed or force provenance. */
  readonly rerun:
    | { readonly mode: "NEW" }
    | { readonly mode: "RETRY_FAILED"; readonly sourceExecutionId: string }
    | { readonly mode: "FORCE"; readonly sourceExecutionId: string };
  /** Optional Run limit overrides merged with Manifest defaults. */
  readonly runLimitOverrides: {
    readonly restConcurrency?: number | undefined;
    readonly evalConcurrency?: number | undefined;
  };
  /** Optional Analysis limit override merged with Manifest defaults. */
  readonly analysisLimitOverrides: {
    readonly analysisConcurrency?: number | undefined;
  };
  /** Command cancellation signal. */
  readonly signal: AbortSignal;
}

/** Closed offline REST command use case. */
export interface RestCommandService {
  /** Create and execute one immutable REST stage version. */
  readonly run: (input: RestRunCommandInput) => Promise<WorkPackageRestRunResult>;
}

/** Cleaned `eval run` use-case input independent of Commander. */
export interface EvaluationRunCommandInput {
  /** Existing Work Package directory. */
  readonly packagePath: string;
  /** Existing Execution whose REST stage already succeeded. */
  readonly executionId: string;
  /** Optional external Secret file. */
  readonly envFile?: string | undefined;
  /** Command cancellation signal. */
  readonly signal: AbortSignal;
}

/** Closed offline Evaluation command use case. */
export interface EvaluationCommandService {
  /** Execute Evaluation on one immutable existing Execution. */
  readonly run: (input: EvaluationRunCommandInput) => Promise<WorkPackageEvaluationRunResult>;
}

/** Cleaned current REST to Evaluation Pipeline input. */
export type PipelineRunCommandInput = RestRunCommandInput;

/** Closed current REST to Evaluation Pipeline use case. */
export interface PipelineCommandService {
  /** Create one Execution and execute REST followed by Evaluation. */
  readonly run: (input: PipelineRunCommandInput) => Promise<WorkPackagePipelineRunResult>;
}

/** Runtime dependencies for one isolated CLI invocation. */
export interface CliDependencies {
  /** Currently closed package capabilities. */
  readonly packageCommands: PackageCommandService;
  /** Closed offline REST capability. */
  readonly restCommands: RestCommandService;
  /** Closed offline Evaluation capability. */
  readonly evaluationCommands: EvaluationCommandService;
  /** Closed current REST to Evaluation Pipeline capability. */
  readonly pipelineCommands: PipelineCommandService;
  /** Explicit output sinks. */
  readonly output: CliOutput;
  /** Optional process cancellation signal. */
  readonly signal?: AbortSignal | undefined;
}

interface ExportOptions {
  /** Source Suite identity. */
  readonly suiteId: string;
  /** Endpoint Configuration identity. */
  readonly endpointConfigId: string;
  /** Evaluator Configuration identity. */
  readonly evaluatorConfigId: string;
  /** Analyzer Configuration identity. */
  readonly analyzerConfigId: string;
  /** Analysis Prompt identity. */
  readonly analysisPromptId: string;
  /** Destination package path. */
  readonly output: string;
}

type CliCommand = "package export" | "package validate" | "rest run" | "eval run" | "pipeline run";

const ERROR_CODE_SET = new Set<string>(ERROR_CODES);
const HELP_TITLES: Readonly<Record<string, string>> = cliMessages.CLI_HELP_TITLES;
const WORK_PACKAGE_ERROR_MAP: Readonly<Record<string, ErrorCode>> = {
  WORK_PACKAGE_UNKNOWN_FILE: "WORK_PACKAGE_INVALID",
  WORK_PACKAGE_ARTIFACT_ORPHAN: "WORK_PACKAGE_INVALID",
  WORK_PACKAGE_INPUT_TOO_LARGE: "WORK_PACKAGE_INVALID",
  WORK_PACKAGE_LAYOUT_INVALID: "WORK_PACKAGE_INVALID",
  WORK_PACKAGE_FILE_TOO_LARGE: "WORK_PACKAGE_INVALID",
  WORK_PACKAGE_FILE_CHANGED: "WORK_PACKAGE_HASH_MISMATCH",
  WORK_PACKAGE_PATH_COLLISION: "WORK_PACKAGE_PATH_INVALID",
  WORK_PACKAGE_TARGET_INVALID: "WORK_PACKAGE_PATH_INVALID",
  WORK_PACKAGE_FILE_INVALID: "WORK_PACKAGE_INVALID",
  WORK_PACKAGE_LOCK_INVALID: "WORK_PACKAGE_INVALID",
  WORK_PACKAGE_TARGET_EXISTS: "EXPORT_REVISION_CONFLICT",
  WORK_PACKAGE_STAGING_EXISTS: "EXPORT_REVISION_CONFLICT",
  EXPORT_EVENT_INVALID: "PROVIDER_REQUEST_FAILED",
  EXPORT_STREAM_TRUNCATED: "PROVIDER_REQUEST_FAILED",
  EXPORT_LINE_TOO_LARGE: "PROVIDER_REQUEST_FAILED",
  EXPORT_UTF8_INVALID: "PROVIDER_REQUEST_FAILED",
  TEMP_CONTAINMENT_REJECTED: "WORK_PACKAGE_PATH_INVALID",
  ARTIFACT_EXPECTATION_INVALID: "INTERNAL_ERROR",
  ARTIFACT_WRITER_CLOSED: "INTERNAL_ERROR",
  TEMP_CLEANUP_FAILED: "INTERNAL_ERROR",
  WORK_PACKAGE_DIRECTORY_CLOSED: "INTERNAL_ERROR",
  WORK_PACKAGE_FILE_LIMIT_INVALID: "INTERNAL_ERROR",
  WORK_PACKAGE_LOCK_OWNER_INVALID: "INTERNAL_ERROR",
  WORK_PACKAGE_NATIVE_UNSUPPORTED: "INTERNAL_ERROR",
  WORK_PACKAGE_NONCE_INVALID: "INTERNAL_ERROR",
  WORK_PACKAGE_PUBLISHER_CLOSED: "INTERNAL_ERROR",
  WORK_PACKAGE_RECOVERY_POLICY_INVALID: "INTERNAL_ERROR"
};

// Clean Commander option objects before they enter a command use case.
function exportOptions(value: unknown): ExportOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("VALIDATION_FAILED");
  }
  const source = value as Readonly<Record<string, unknown>>;
  const request = WorkPackageExportRequestV1Schema.safeParse({
    suiteId: source.suiteId,
    endpointConfigId: source.endpointConfigId,
    evaluatorConfigId: source.evaluatorConfigId,
    analyzerConfigId: source.analyzerConfigId,
    analysisPromptId: source.analysisPromptId
  });
  if (!request.success || typeof source.output !== "string" || source.output.length === 0) {
    throw new Error("VALIDATION_FAILED");
  }
  return { ...request.data, output: source.output };
}

// Parse one optional bounded positive integer without JavaScript coercion.
function concurrency(value: unknown, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error("VALIDATION_FAILED");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error("VALIDATION_FAILED");
  }
  return parsed;
}

// Clean one REST command before it enters the offline use case.
function restRunInput(
  packagePath: unknown,
  value: unknown,
  signal: AbortSignal
): RestRunCommandInput {
  if (
    typeof packagePath !== "string" ||
    packagePath.length === 0 ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("VALIDATION_FAILED");
  }
  const source = value as Readonly<Record<string, unknown>>;
  const retryFailed = source.retryFailed;
  const force = source.force;
  if (retryFailed !== undefined && force !== undefined) throw new Error("VALIDATION_FAILED");
  if (
    (retryFailed !== undefined && !UuidV7Schema.safeParse(retryFailed).success) ||
    (force !== undefined && !UuidV7Schema.safeParse(force).success) ||
    (source.envFile !== undefined &&
      (typeof source.envFile !== "string" || source.envFile.length === 0))
  ) {
    throw new Error("VALIDATION_FAILED");
  }
  const rerun =
    typeof retryFailed === "string"
      ? { mode: "RETRY_FAILED" as const, sourceExecutionId: retryFailed }
      : typeof force === "string"
        ? { mode: "FORCE" as const, sourceExecutionId: force }
        : { mode: "NEW" as const };
  const restConcurrency = concurrency(source.restConcurrency, 64);
  const evalConcurrency = concurrency(source.evalConcurrency, 16);
  const analysisConcurrency = concurrency(source.analysisConcurrency, 8);
  return {
    packagePath,
    ...(typeof source.envFile === "string" ? { envFile: source.envFile } : {}),
    rerun,
    runLimitOverrides: {
      ...(restConcurrency === undefined ? {} : { restConcurrency }),
      ...(evalConcurrency === undefined ? {} : { evalConcurrency })
    },
    analysisLimitOverrides: analysisConcurrency === undefined ? {} : { analysisConcurrency },
    signal
  };
}

// Clean one Evaluation command before it enters the offline use case.
function evaluationRunInput(
  packagePath: unknown,
  value: unknown,
  signal: AbortSignal
): EvaluationRunCommandInput {
  if (
    typeof packagePath !== "string" ||
    packagePath.length === 0 ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("VALIDATION_FAILED");
  }
  const source = value as Readonly<Record<string, unknown>>;
  if (
    !UuidV7Schema.safeParse(source.executionId).success ||
    (source.envFile !== undefined &&
      (typeof source.envFile !== "string" || source.envFile.length === 0))
  ) {
    throw new Error("VALIDATION_FAILED");
  }
  return {
    packagePath,
    executionId: source.executionId as string,
    ...(typeof source.envFile === "string" ? { envFile: source.envFile } : {}),
    signal
  };
}

// Read one inherited boolean flag without accepting truthy coercion.
function machineOutput(command: Command): boolean {
  const dirty: unknown = command.optsWithGlobals();
  if (dirty === null || typeof dirty !== "object" || Array.isArray(dirty)) return false;
  const value = (dirty as Readonly<Record<string, unknown>>).json;
  return value === true;
}

// Map only stable public codes; caught implementation prose never crosses the CLI boundary.
function publicError(error: unknown): ErrorCode {
  const code = error instanceof Error ? error.message : null;
  if (code !== null) {
    const mapped = WORK_PACKAGE_ERROR_MAP[code];
    if (mapped !== undefined) return mapped;
  }
  return code !== null && ERROR_CODE_SET.has(code) ? (code as ErrorCode) : "INTERNAL_ERROR";
}

// Identify only a closed command pair before Commander validates its required arguments.
function commandFromArguments(arguments_: readonly string[]): CliCommand | null {
  const tokens = arguments_.filter((value) => value !== "--json");
  const pair = `${tokens[0] ?? ""} ${tokens[1] ?? ""}`;
  if (
    pair === "package export" ||
    pair === "package validate" ||
    pair === "rest run" ||
    pair === "eval run" ||
    pair === "pipeline run"
  ) {
    return pair;
  }
  return null;
}

// Preserve the fixed CLI exit-code contract.
function exitCode(code: ErrorCode): 2 | 3 | 4 | 130 {
  if (code === "REQUEST_ABORTED" || code === "REST_CANCELLED" || code === "EVALUATOR_CANCELLED") {
    return 130;
  }
  if (
    code === "WORK_PACKAGE_LOCKED" ||
    code === "EXECUTION_RESULT_CONFLICT" ||
    code === "ARTIFACT_ALREADY_COMMITTED" ||
    code === "EXPORT_REVISION_CONFLICT" ||
    code === "RUN_STATE_CONFLICT"
  ) {
    return 4;
  }
  if (
    code === "PROVIDER_REQUEST_FAILED" ||
    code === "PROMPTFOO_PROCESS_ERROR" ||
    code === "EVALUATION_STAGE_FAILED" ||
    code === "ARTIFACT_WRITE_FAILED" ||
    code === "INTERNAL_ERROR"
  ) {
    return 3;
  }
  return 2;
}

// A retry may reuse FAIL facts while the target's empty Promptfoo process exits zero.
function evaluationExitCode(result: {
  readonly promptfooExitCode: 0 | 100;
  readonly evalFailCount: number;
}): 0 | 1 {
  return result.promptfooExitCode === 100 || result.evalFailCount > 0 ? 1 : 0;
}

// Emit one schema-cleaned machine event as exactly one NDJSON line.
function emitMachine(output: CliOutput, event: CliPackageEventV1): void {
  const clean = CliPackageEventV1Schema.parse(event);
  output.stdout(`${JSON.stringify(clean)}\n`);
}

// Emit one strict offline execution event as exactly one NDJSON line.
function emitExecutionMachine(output: CliOutput, event: CliExecutionEventV1): void {
  const clean = CliExecutionEventV1Schema.parse(event);
  output.stdout(`${JSON.stringify(clean)}\n`);
}

// Format a public error without third-party stack, submitted value or secret material.
function emitError(
  output: CliOutput,
  json: boolean,
  command: CliCommand,
  code: ErrorCode
): 2 | 3 | 4 | 130 {
  const status = exitCode(code);
  if (json) {
    if (command === "rest run" || command === "eval run" || command === "pipeline run") {
      emitExecutionMachine(output, {
        contractVersion: "cortex.cli-execution-event.v1",
        type: "COMMAND_ERROR",
        command,
        code,
        exitCode: status
      });
    } else {
      emitMachine(output, {
        contractVersion: "cortex.cli-package-event.v1",
        type: "COMMAND_ERROR",
        command,
        code,
        exitCode: status
      });
    }
  }
  output.stderr(`${contractMessages[code]}\n`);
  return status;
}

// Create the exact currently closed Commander surface for one isolated invocation.
function buildProgram(
  dependencies: CliDependencies,
  controller: AbortController,
  state: { command: CliCommand; json: boolean; successExitCode: 0 | 1 }
): Command {
  const program = new Command();
  program
    .name("cortex-eval")
    .description(cliMessages.CLI_DESCRIPTION)
    .option("--json", cliMessages.CLI_JSON)
    .helpOption("-h, --help", cliMessages.CLI_HELP)
    .showHelpAfterError()
    .helpCommand("help [command]", cliMessages.CLI_HELP_COMMAND)
    .configureHelp({
      styleTitle: (title): string => HELP_TITLES[title] ?? title
    })
    .exitOverride()
    .configureOutput({
      writeOut: dependencies.output.stdout,
      writeErr: (): void => undefined
    });

  const packageCommand = program.command("package").description(cliMessages.PACKAGE_DESCRIPTION);
  packageCommand
    .command("export")
    .description(cliMessages.PACKAGE_EXPORT_DESCRIPTION)
    .requiredOption("--suite-id <id>")
    .requiredOption("--endpoint-config-id <id>")
    .requiredOption("--evaluator-config-id <id>")
    .requiredOption("--analyzer-config-id <id>")
    .requiredOption("--analysis-prompt-id <id>")
    .requiredOption("--output <path>")
    .action(async (dirtyOptions: unknown, command: Command): Promise<void> => {
      state.command = "package export";
      state.json = machineOutput(command);
      const options = exportOptions(dirtyOptions);
      const result = await dependencies.packageCommands.exportPackage(
        {
          suiteId: options.suiteId,
          endpointConfigId: options.endpointConfigId,
          evaluatorConfigId: options.evaluatorConfigId,
          analyzerConfigId: options.analyzerConfigId,
          analysisPromptId: options.analysisPromptId
        },
        options.output,
        controller.signal
      );
      if (state.json) {
        emitMachine(dependencies.output, {
          contractVersion: "cortex.cli-package-event.v1",
          type: "PACKAGE_EXPORTED",
          ...result
        });
      } else {
        dependencies.output.stdout(`${cliMessages.PACKAGE_EXPORTED} ${result.targetPath}\n`);
      }
    });

  packageCommand
    .command("validate")
    .description(cliMessages.PACKAGE_VALIDATE_DESCRIPTION)
    .argument("<path>")
    .action(async (packagePath: unknown, _options: unknown, command: Command): Promise<void> => {
      state.command = "package validate";
      state.json = machineOutput(command);
      if (typeof packagePath !== "string" || packagePath.length === 0) {
        throw new Error("VALIDATION_FAILED");
      }
      const result = await dependencies.packageCommands.validatePackage(
        packagePath,
        controller.signal
      );
      if (state.json) {
        emitMachine(dependencies.output, {
          contractVersion: "cortex.cli-package-event.v1",
          type: "PACKAGE_VALIDATED",
          ...result
        });
      } else {
        dependencies.output.stdout(
          `${cliMessages.PACKAGE_VALIDATED} ${result.packageId} ${result.executionCount}\n`
        );
      }
    });

  const restCommand = program.command("rest").description(cliMessages.REST_DESCRIPTION);
  restCommand
    .command("run")
    .description(cliMessages.REST_RUN_DESCRIPTION)
    .argument("<path>")
    .option("--env-file <path>", cliMessages.REST_ENV_FILE)
    .option("--retry-failed <execution-id>", cliMessages.REST_RETRY_FAILED)
    .option("--force <execution-id>", cliMessages.REST_FORCE)
    .option("--rest-concurrency <count>", cliMessages.REST_CONCURRENCY)
    .option("--eval-concurrency <count>", cliMessages.EVAL_CONCURRENCY)
    .option("--analysis-concurrency <count>", cliMessages.ANALYSIS_CONCURRENCY)
    .action(
      async (packagePath: unknown, dirtyOptions: unknown, command: Command): Promise<void> => {
        state.command = "rest run";
        state.json = machineOutput(command);
        const input = restRunInput(packagePath, dirtyOptions, controller.signal);
        const result = await dependencies.restCommands.run(input);
        if (state.json) {
          emitExecutionMachine(dependencies.output, {
            contractVersion: "cortex.cli-execution-event.v1",
            type: "REST_COMPLETED",
            ...result
          });
        } else {
          dependencies.output.stdout(
            `${cliMessages.REST_RUN_COMPLETED} ${result.executionId} ${result.artifactPath}\n`
          );
        }
      }
    );
  const evaluationCommand = program.command("eval").description(cliMessages.EVALUATION_DESCRIPTION);
  evaluationCommand
    .command("run")
    .description(cliMessages.EVALUATION_RUN_DESCRIPTION)
    .argument("<path>")
    .requiredOption("--execution-id <id>", cliMessages.EVALUATION_EXECUTION_ID)
    .option("--env-file <path>", cliMessages.EVALUATION_ENV_FILE)
    .action(
      async (packagePath: unknown, dirtyOptions: unknown, command: Command): Promise<void> => {
        state.command = "eval run";
        state.json = machineOutput(command);
        const input = evaluationRunInput(packagePath, dirtyOptions, controller.signal);
        const result = await dependencies.evaluationCommands.run(input);
        state.successExitCode = evaluationExitCode(result);
        if (state.json) {
          emitExecutionMachine(dependencies.output, {
            contractVersion: "cortex.cli-execution-event.v1",
            type: "EVALUATION_COMPLETED",
            ...result
          });
        } else {
          dependencies.output.stdout(
            `${cliMessages.EVALUATION_RUN_COMPLETED} ${result.executionId} ${result.normalizedArtifactPath}\n`
          );
        }
      }
    );
  const pipelineCommand = program.command("pipeline").description(cliMessages.PIPELINE_DESCRIPTION);
  pipelineCommand
    .command("run")
    .description(cliMessages.PIPELINE_RUN_DESCRIPTION)
    .argument("<path>")
    .option("--env-file <path>", cliMessages.REST_ENV_FILE)
    .option("--retry-failed <execution-id>", cliMessages.REST_RETRY_FAILED)
    .option("--force <execution-id>", cliMessages.REST_FORCE)
    .option("--rest-concurrency <count>", cliMessages.REST_CONCURRENCY)
    .option("--eval-concurrency <count>", cliMessages.EVAL_CONCURRENCY)
    .option("--analysis-concurrency <count>", cliMessages.ANALYSIS_CONCURRENCY)
    .action(
      async (packagePath: unknown, dirtyOptions: unknown, command: Command): Promise<void> => {
        state.command = "pipeline run";
        state.json = machineOutput(command);
        const input = restRunInput(packagePath, dirtyOptions, controller.signal);
        const result = await dependencies.pipelineCommands.run(input);
        state.successExitCode = evaluationExitCode(result);
        if (state.json) {
          emitExecutionMachine(dependencies.output, {
            contractVersion: "cortex.cli-execution-event.v1",
            type: "PIPELINE_COMPLETED",
            ...result
          });
        } else {
          dependencies.output.stdout(
            `${cliMessages.PIPELINE_RUN_COMPLETED} ${result.executionId} ${result.normalizedArtifactPath}\n`
          );
        }
      }
    );
  return program;
}

/** Run one CLI invocation without mutating process exit state or global Commander state. */
export async function runCli(
  arguments_: readonly string[],
  dependencies: CliDependencies
): Promise<0 | 1 | 2 | 3 | 4 | 130> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  dependencies.signal?.addEventListener("abort", abort, { once: true });
  if (dependencies.signal?.aborted === true) abort();
  const parsedCommand = commandFromArguments(arguments_);
  const state: {
    command: CliCommand;
    json: boolean;
    successExitCode: 0 | 1;
  } = {
    command: parsedCommand ?? "package validate",
    json: arguments_.includes("--json"),
    successExitCode: 0
  };
  const program = buildProgram(dependencies, controller, state);
  try {
    await program.parseAsync(["node", "cortex-eval", ...arguments_]);
    return state.successExitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0;
      if (state.json && parsedCommand !== null) {
        return emitError(dependencies.output, true, parsedCommand, "VALIDATION_FAILED");
      }
      dependencies.output.stderr(`${cliMessages.CLI_INPUT_INVALID}\n`);
      return 2;
    }
    const code = publicError(error);
    return emitError(dependencies.output, state.json, state.command, code);
  } finally {
    dependencies.signal?.removeEventListener("abort", abort);
  }
}
