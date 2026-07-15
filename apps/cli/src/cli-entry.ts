#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import contractMessages from "@cortex-eval/contracts/messages/zh-CN.json" with { type: "json" };
import { v7 as uuidV7 } from "uuid";

import cliMessages from "../messages/zh-CN.json" with { type: "json" };

import {
  cliCaseDefinitionHasher,
  cliEvalSemanticHashing,
  cliExecutionContextHasher,
  cliRestSemanticHashing
} from "./cli-hashing.ts";
import { runCli } from "./cli-program.ts";
import { LocalEvaluationCommandService } from "./evaluation-command-service.ts";
import { LocalAnalysisCommandService } from "./analysis-command-service.ts";
import { HttpPackageCommandService, MacOsCliProcessIdentity } from "./package-command-service.ts";
import { LocalPipelineCommandService } from "./pipeline-command-service.ts";
import { LocalRestCommandService } from "./rest-command-service.ts";
import { HttpResultImportCommandService } from "./result-import-command-service.ts";
import { WorkPackageReportRunService } from "./work-package-report-run-service.ts";

const signalController = new AbortController();
const cancel = (): void => signalController.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

const processIdentity = new MacOsCliProcessIdentity();
const now = (): string => new Date().toISOString();
const packageCommands = new HttpPackageCommandService({
  contextHasher: cliExecutionContextHasher,
  processIdentity,
  now,
  cleanupFailureSink: {
    record: (): Promise<void> => {
      process.stderr.write(`${cliMessages.WORK_PACKAGE_TEMP_CLEANUP_FAILED}\n`);
      return Promise.resolve();
    }
  }
});
const restCommands = new LocalRestCommandService({
  contextHasher: cliExecutionContextHasher,
  caseHasher: cliCaseDefinitionHasher,
  restHashing: cliRestSemanticHashing,
  nextId: uuidV7,
  nonce: randomUUID,
  now,
  message: (code): string => contractMessages[code],
  processIdentity,
  inheritedEnvironment: (): NodeJS.ProcessEnv => process.env,
  cleanupFailureSink: {
    record: (): Promise<void> => {
      process.stderr.write(`${cliMessages.WORK_PACKAGE_TEMP_CLEANUP_FAILED}\n`);
      return Promise.resolve();
    }
  }
});
const evaluationCommands = new LocalEvaluationCommandService({
  contextHasher: cliExecutionContextHasher,
  caseHasher: cliCaseDefinitionHasher,
  restHashing: cliRestSemanticHashing,
  evalHashing: cliEvalSemanticHashing,
  promptfooBinary: join(process.cwd(), "node_modules", ".bin", "promptfoo"),
  temporaryContainmentRoot: process.cwd(),
  temporaryParent: join(process.cwd(), ".cortex-eval", "tmp", "promptfoo-cli"),
  promptfooTimeoutMs: 10 * 60 * 1_000,
  runtimePreflightTimeoutMs: 30_000,
  nextId: uuidV7,
  nonce: randomUUID,
  now,
  processIdentity,
  inheritedEnvironment: (): NodeJS.ProcessEnv => process.env,
  cleanupFailureSink: {
    record: (): Promise<void> => {
      process.stderr.write(`${cliMessages.EVALUATION_RAW_CLEANUP_FAILED}\n`);
      return Promise.resolve();
    }
  }
});
const reportCommands = new WorkPackageReportRunService({
  contextHasher: cliExecutionContextHasher,
  caseHasher: cliCaseDefinitionHasher,
  restHashing: cliRestSemanticHashing,
  evalHashing: cliEvalSemanticHashing,
  processIdentity,
  nonce: randomUUID,
  now,
  cleanupFailureSink: {
    record: (): Promise<void> => {
      process.stderr.write(`${cliMessages.REPORT_ARTIFACT_CLEANUP_FAILED}\n`);
      return Promise.resolve();
    }
  }
});
const analysisCommands = new LocalAnalysisCommandService({
  contextHasher: cliExecutionContextHasher,
  caseHasher: cliCaseDefinitionHasher,
  restHashing: cliRestSemanticHashing,
  evalHashing: cliEvalSemanticHashing,
  nonce: randomUUID,
  now,
  processIdentity,
  inheritedEnvironment: (): NodeJS.ProcessEnv => process.env,
  errorMessage: (code): string =>
    code in contractMessages
      ? contractMessages[code as keyof typeof contractMessages]
      : contractMessages.ANALYSIS_STAGE_FAILED
});
const pipelineCommands = new LocalPipelineCommandService({
  contextHasher: cliExecutionContextHasher,
  nonce: randomUUID,
  now,
  processIdentity,
  inheritedEnvironment: (): NodeJS.ProcessEnv => process.env,
  restCommands,
  evaluationCommands,
  reportCommands,
  analysisCommands
});
const resultCommands = new HttpResultImportCommandService();
const processArguments = process.argv.slice(2);
const commandArguments =
  processArguments[0] === "--" ? processArguments.slice(1) : processArguments;

try {
  process.exitCode = await runCli(commandArguments, {
    packageCommands,
    restCommands,
    evaluationCommands,
    reportCommands,
    analysisCommands,
    pipelineCommands,
    resultCommands,
    output: {
      stdout: (value): boolean => process.stdout.write(value),
      stderr: (value): boolean => process.stderr.write(value)
    },
    signal: signalController.signal
  });
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
