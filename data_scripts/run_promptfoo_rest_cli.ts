/** Command-line adapter for the promptfoo REST runner. */

import { formatRunnerMessage, loadRunnerMessages } from "./run_promptfoo_rest_message.ts";
import { runPromptfooRestSuite } from "./run_promptfoo_rest.ts";
import type { RunPromptfooRestSuiteOptions } from "./run_promptfoo_rest_types.ts";

/** Parsed command-line arguments. */
interface CliArguments extends RunPromptfooRestSuiteOptions {
  /** Whether help text was requested. */
  help: boolean;
}

const CLI_VALUE_ARGUMENTS = new Set([
  "--input",
  "--provider",
  "--output",
  "--max-concurrency",
  "--timeout-ms"
]);

/** Configured message map used by the CLI adapter. */
type Messages = Awaited<ReturnType<typeof loadRunnerMessages>>;

// Read a required value following one CLI argument.
function readArgumentValue(
  argv: string[],
  index: number,
  argument: string,
  messages: Messages
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(formatRunnerMessage(messages, "missing_argument_value", { argument }));
  }
  return value;
}

// Parse one positive integer from the command line.
function parseCliInteger(value: string, argument: string, messages: Messages): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(formatRunnerMessage(messages, "invalid_positive_integer", { argument, value }));
  }
  return parsed;
}

// Parse supported CLI options without adding runtime dependencies.
function parseCliArguments(argv: string[], messages: Messages): CliArguments {
  const parsed: CliArguments = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      throw new Error(formatRunnerMessage(messages, "unknown_argument", { argument: "" }));
    }
    if (argument === "--help") {
      parsed.help = true;
      continue;
    }
    if (argument === "--force") {
      parsed.force = true;
      continue;
    }
    if (!CLI_VALUE_ARGUMENTS.has(argument)) {
      throw new Error(formatRunnerMessage(messages, "unknown_argument", { argument }));
    }
    const value = readArgumentValue(argv, index, argument, messages);
    index += 1;
    if (argument === "--input") parsed.inputPath = value;
    else if (argument === "--provider") parsed.providerPath = value;
    else if (argument === "--output") parsed.outputPath = value;
    else if (argument === "--max-concurrency") {
      parsed.maxConcurrency = parseCliInteger(value, argument, messages);
    } else if (argument === "--timeout-ms") {
      parsed.timeoutMs = parseCliInteger(value, argument, messages);
    }
  }
  return parsed;
}

// Execute the command-line adapter and set a nonzero exit code for failed cases.
export async function runPromptfooRestCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const messages = await loadRunnerMessages();
  const options = parseCliArguments(argv, messages);
  if (options.help) {
    console.log(formatRunnerMessage(messages, "usage"));
    return;
  }
  const result = await runPromptfooRestSuite(options);
  console.log(formatRunnerMessage(messages, "summary", { ...result }));
  if (result.failed > 0) {
    process.exitCode = 1;
  }
}
