import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { caseDefinitionJson } from "../../domain/src/domain-case-projection.ts";
import { hashCaseDefinition, hashExecutionContext } from "../../domain/src/domain-hash-inputs.ts";
import { afterEach, describe, expect, it } from "vitest";

import {
  openWorkPackageExecutionSession,
  type WorkPackageExecutionContextHashInput
} from "../src/work-package-execution-session.ts";
import type { WorkPackageCaseDefinitionHashInput } from "../src/work-package-input-reader.ts";
import { materializeGoldenWorkPackage } from "../test-support/golden-work-package-fixture.ts";

const GOLDEN_MANIFEST_SHA256 = "9f618b2173cde449b8ecf0d86e117c13732b147dd1257219e3493e44b586c86e";
const roots: string[] = [];

const contextHasher = {
  hash: (input: WorkPackageExecutionContextHashInput): string =>
    hashExecutionContext({
      contractVersion: input.contractVersion,
      packageId: input.packageId,
      manifestHash: input.manifestHash,
      runExecutionLimits: input.runExecutionLimits,
      analysisExecutionLimits: input.analysisExecutionLimits
    })
};

const caseHasher = {
  hash: (input: WorkPackageCaseDefinitionHashInput): string =>
    hashCaseDefinition({
      contractVersion: input.contractVersion,
      caseKey: input.caseKey,
      definition: caseDefinitionJson(input.definition)
    })
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P7 Golden Work Package v2", () => {
  it("freezes complete future stage slots without storing a Secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-golden-package-"));
    roots.push(root);
    const packagePath = join(root, "package");
    await materializeGoldenWorkPackage(packagePath);

    const manifestBytes = await readFile(join(packagePath, "manifest.json"));
    expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(GOLDEN_MANIFEST_SHA256);
    expect(await readFile(join(packagePath, ".env.example"), "utf8")).toBe("GEMINI_API_KEY=\n");
    const packageText = (
      await Promise.all([
        readFile(join(packagePath, "manifest.json"), "utf8"),
        readFile(join(packagePath, "inputs", "evaluator.json"), "utf8"),
        readFile(join(packagePath, "inputs", "analyzer.json"), "utf8")
      ])
    ).join("\n");
    expect(packageText).not.toContain("test-only-not-forwarded");
    expect(packageText).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);

    const session = await openWorkPackageExecutionSession({
      rootPath: packagePath,
      owner: {
        pid: process.pid,
        processStartedAt: "Tue Jul 14 15:00:00 2026",
        executionId: null,
        acquiredAt: "2026-07-14T07:00:00.000Z"
      },
      contextHasher,
      nonce: (): string => "golden_package_nonce"
    });
    try {
      expect(session.packageSummary).toMatchObject({
        packageId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee",
        executionCount: 0
      });
      const cases = [];
      for await (const item of session.inputs.streamCases(
        caseHasher,
        new AbortController().signal
      )) {
        cases.push(item);
      }
      expect(cases).toMatchObject([{ caseKey: "case-1", ordinal: 0 }]);
    } finally {
      await session.close();
    }
  });
});
