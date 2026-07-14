import { describe, expect, it } from "vitest";

import { CliExecutionEventV1Schema, CliPackageEventV1Schema } from "../src/cli-contracts.ts";

const ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const HASH = "a".repeat(64);

describe("CLI machine output contracts", () => {
  it("keeps package success and error events strict and versioned", () => {
    expect(
      CliPackageEventV1Schema.parse({
        contractVersion: "cortex.cli-package-event.v1",
        type: "PACKAGE_EXPORTED",
        packageId: ID,
        manifestSha256: HASH,
        targetPath: "/tmp/package"
      })
    ).toMatchObject({ type: "PACKAGE_EXPORTED", packageId: ID });
    expect(
      CliPackageEventV1Schema.parse({
        contractVersion: "cortex.cli-package-event.v1",
        type: "COMMAND_ERROR",
        command: "package validate",
        code: "WORK_PACKAGE_INVALID",
        exitCode: 2
      })
    ).toMatchObject({ type: "COMMAND_ERROR", exitCode: 2 });
    expect(
      CliPackageEventV1Schema.safeParse({
        contractVersion: "cortex.cli-package-event.v1",
        type: "PACKAGE_VALIDATED",
        packageId: ID,
        manifestSha256: HASH,
        executionCount: 0,
        apiKey: "forbidden"
      }).success
    ).toBe(false);
  });

  it("keeps REST completion and command errors in a separate strict versioned protocol", () => {
    expect(
      CliExecutionEventV1Schema.parse({
        contractVersion: "cortex.cli-execution-event.v1",
        type: "REST_COMPLETED",
        packageId: ID,
        executionId: ID,
        restErrorCount: 1,
        resultSetHash: HASH,
        artifactPath: `executions/${ID}/rest-results.json`
      })
    ).toMatchObject({ type: "REST_COMPLETED", restErrorCount: 1 });
    expect(
      CliExecutionEventV1Schema.parse({
        contractVersion: "cortex.cli-execution-event.v1",
        type: "COMMAND_ERROR",
        command: "rest run",
        code: "REST_CANCELLED",
        exitCode: 130
      })
    ).toMatchObject({ command: "rest run", exitCode: 130 });
    expect(
      CliExecutionEventV1Schema.safeParse({
        contractVersion: "cortex.cli-execution-event.v1",
        type: "REST_COMPLETED",
        packageId: ID,
        executionId: ID,
        restErrorCount: 0,
        resultSetHash: HASH,
        artifactPath: "../escape.json"
      }).success
    ).toBe(false);
  });

  it("keeps Evaluation completion owner-bound and exposes both fixed Artifact paths", () => {
    expect(
      CliExecutionEventV1Schema.parse({
        contractVersion: "cortex.cli-execution-event.v1",
        type: "EVALUATION_COMPLETED",
        packageId: ID,
        executionId: ID,
        promptfooExitCode: 100,
        evalFailCount: 1,
        evalErrorCount: 0,
        resultSetHash: HASH,
        rawArtifactPath: `executions/${ID}/promptfoo-raw.json`,
        normalizedArtifactPath: `executions/${ID}/normalized-eval.json`
      })
    ).toMatchObject({ type: "EVALUATION_COMPLETED", promptfooExitCode: 100 });
  });

  it("binds the current Pipeline completion to one REST and Evaluation version", () => {
    expect(
      CliExecutionEventV1Schema.parse({
        contractVersion: "cortex.cli-execution-event.v1",
        type: "PIPELINE_COMPLETED",
        packageId: ID,
        executionId: ID,
        restErrorCount: 0,
        restResultSetHash: HASH,
        restArtifactPath: `executions/${ID}/rest-results.json`,
        promptfooExitCode: 100,
        evalFailCount: 1,
        evalErrorCount: 0,
        evaluationResultSetHash: HASH,
        rawArtifactPath: `executions/${ID}/promptfoo-raw.json`,
        normalizedArtifactPath: `executions/${ID}/normalized-eval.json`
      })
    ).toMatchObject({ type: "PIPELINE_COMPLETED", promptfooExitCode: 100 });
  });
});
