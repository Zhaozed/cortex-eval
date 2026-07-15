import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { caseDefinitionJson } from "../../domain/src/domain-case-projection.ts";
import { hashCaseDefinition, hashExecutionContext } from "../../domain/src/domain-hash-inputs.ts";
import { afterEach, describe, expect, it } from "vitest";

import {
  materializeWorkPackageFixture,
  WORK_PACKAGE_FIXTURE_ID
} from "../test-support/work-package-fixture.ts";
import type { CaseDefinitionV1 } from "../../contracts/src/case-contracts.ts";
import {
  WorkPackageInputReader,
  type WorkPackageCaseDefinitionHashInput
} from "../src/work-package-input-reader.ts";
import {
  SecureWorkPackageDirectory,
  type WorkPackageLockOwner
} from "../src/secure-work-package-directory.ts";
import {
  openWorkPackageExecutionSession,
  type WorkPackageExecutionContextHashInput
} from "../src/work-package-execution-session.ts";

const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
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

const fixtureDefinition = {
  caseKey: "case-1",
  description: "fixture",
  threshold: 1,
  task: "reply",
  requestBody: { text: "hello" },
  metadata: {
    requestId: "req-1",
    taskId: "task-1",
    businessModule: "fixture",
    scenarioTag: "fixture"
  },
  assertions: [{ type: "equals", metric: "exact", weight: 1, value: "hello" }]
} as const;

function owner(): WorkPackageLockOwner {
  return {
    pid: process.pid,
    processStartedAt: "Tue Jul 14 15:00:00 2026",
    executionId: EXECUTION_ID,
    acquiredAt: "2026-07-14T07:00:00.000Z"
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Work Package input reader", () => {
  it("revalidates each consumed configuration against its frozen Manifest hash", async () => {
    const cases = ["endpoint", "evaluator", "rubric", "analyzer", "analysis-prompt"] as const;
    for (const kind of cases) {
      const root = await mkdtemp(join(tmpdir(), `cortex-package-input-integrity-${kind}-`));
      roots.push(root);
      const manifest = await materializeWorkPackageFixture(root);
      const session = await openWorkPackageExecutionSession({
        rootPath: root,
        owner: owner(),
        contextHasher,
        nonce: (): string => `input_integrity_${kind}`
      });
      try {
        const relativePath =
          kind === "endpoint"
            ? manifest.inputs.endpoint.path
            : kind === "evaluator"
              ? manifest.inputs.evaluator.path
              : kind === "rubric"
                ? manifest.inputs.rubricPrompts[0]?.path
                : kind === "analyzer"
                  ? manifest.inputs.analyzer.path
                  : manifest.inputs.analysisPrompt.path;
        if (relativePath === undefined) throw new Error("TEST_RUBRIC_PATH_MISSING");
        const absolutePath = join(root, relativePath);
        const original = await readFile(absolutePath, "utf8");
        const mutated =
          kind === "endpoint"
            ? original.replace('"defaultConcurrency":4', '"defaultConcurrency":5')
            : kind === "evaluator"
              ? original.replace('"temperature":0', '"temperature":1')
              : kind === "rubric"
                ? original.replace("exactness.", "relevance.")
                : kind === "analyzer"
                  ? original.replace('"temperature":0', '"temperature":1')
                  : original.replace("Analyze failures.", "Review  failures.");
        if (mutated === original || Buffer.byteLength(mutated) !== Buffer.byteLength(original)) {
          throw new Error("TEST_MUTATION_MUST_PRESERVE_SIZE");
        }
        const before = await stat(absolutePath);
        await writeFile(absolutePath, mutated);
        const after = await stat(absolutePath);
        expect(after.ino).toBe(before.ino);
        expect(after.size).toBe(before.size);
        const consumed =
          kind === "endpoint"
            ? session.inputs.readEndpoint()
            : kind === "evaluator" || kind === "rubric"
              ? session.inputs.readEvaluationInputs()
              : session.inputs.readAnalysisInputs();
        await expect(consumed).rejects.toThrow("WORK_PACKAGE_HASH_MISMATCH");
      } finally {
        await session.close();
      }
    }
  });

  it("streams Canonical Cases and maps the frozen Endpoint without retaining transport fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-package-input-reader-"));
    roots.push(root);
    const manifest = await materializeWorkPackageFixture(root, {
      baseDefinitionHash: hashCaseDefinition({
        contractVersion: "cortex.case-definition.v1",
        caseKey: fixtureDefinition.caseKey,
        definition: caseDefinitionJson(fixtureDefinition)
      })
    });
    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: owner(),
      contextHasher,
      nonce: (): string => "input_reader_nonce_01"
    });
    try {
      const cases = [];
      for await (const item of session.inputs.streamCases(caseHasher)) cases.push(item);
      expect(cases).toHaveLength(1);
      expect(cases[0]).toMatchObject({
        caseKey: "case-1",
        ordinal: 0,
        definition: { task: "reply", requestBody: { text: "hello" } }
      });
      expect(session.inputs.expectedCaseCount).toBe(1);
      await expect(session.inputs.readEndpoint()).resolves.toMatchObject({
        method: "POST",
        defaultConcurrency: 4
      });
      const evaluationInputs = await session.inputs.readEvaluationInputs(cases);
      expect(evaluationInputs).toMatchObject({
        evaluator: {
          definition: { providerType: "GOOGLE_GEMINI", structuredOutput: "JSON_SCHEMA" }
        },
        rubricPrompts: [
          {
            definition: { promptKey: "quality", kind: "LLM_RUBRIC" }
          }
        ]
      });
      expect(evaluationInputs.evaluator.configHash).toMatch(/^[a-f0-9]{64}$/);
      expect(evaluationInputs.rubricPrompts[0]?.promptHash).toMatch(/^[a-f0-9]{64}$/);
      const analysisInputs = await session.inputs.readAnalysisInputs();
      expect(analysisInputs).toMatchObject({
        analyzer: {
          definition: { providerType: "GOOGLE_GEMINI", structuredOutput: "JSON_SCHEMA" }
        },
        prompt: {
          definition: { kind: "CASE_ANALYSIS", promptKey: "analysis" }
        }
      });
      expect(analysisInputs.analyzer.configHash).toBe(manifest.configurationHashes.analyzer);
      expect(analysisInputs.prompt.promptHash).toBe(manifest.configurationHashes.analysisPrompt);
      const sourceCase = cases[0];
      if (sourceCase === undefined) throw new Error("TEST_CASE_MISSING");
      await expect(
        session.inputs.readEvaluationInputs([
          {
            ...sourceCase,
            definition: {
              ...sourceCase.definition,
              assertions: [
                {
                  type: "llm-rubric",
                  metric: "quality",
                  weight: 1,
                  rubricPrompt: "prompt://missing"
                }
              ]
            }
          }
        ])
      ).rejects.toThrow("WORK_PACKAGE_INVALID");
      expect(session.packageSummary.packageId).toBe(WORK_PACKAGE_FIXTURE_ID);
    } finally {
      await session.close();
    }
  });

  it("maps every optional recursive Assertion field and default weight", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-package-input-reader-fields-"));
    roots.push(root);
    const manifest = await materializeWorkPackageFixture(root, {
      baseDefinitionHash: hashCaseDefinition({
        contractVersion: "cortex.case-definition.v1",
        caseKey: fixtureDefinition.caseKey,
        definition: caseDefinitionJson(fixtureDefinition)
      })
    });
    const transport: CaseDefinitionV1 = {
      contractVersion: "cortex.case-definition.v1",
      description: "all assertion fields",
      threshold: 0.5,
      vars: { task: "reply", request_body: { text: "hello" } },
      metadata: {
        case_id: "case-all-fields",
        req_id: "req-all",
        task_id: "task-all",
        business_module: "fixture",
        scenario_tag: "all-fields"
      },
      assert: [
        {
          type: "assert-set",
          metric: "combined",
          threshold: 0.5,
          config: { strategy: "all" },
          rubricPrompt: "prompt://quality",
          transform: "output",
          contextTransform: "context",
          assert: [{ type: "equals", metric: "nested", value: "hello" }]
        }
      ]
    };
    const definition = {
      caseKey: "case-all-fields",
      description: "all assertion fields",
      threshold: 0.5,
      task: "reply",
      requestBody: { text: "hello" },
      metadata: {
        requestId: "req-all",
        taskId: "task-all",
        businessModule: "fixture",
        scenarioTag: "all-fields"
      },
      assertions: [
        {
          type: "assert-set",
          metric: "combined",
          weight: 1,
          threshold: 0.5,
          config: { strategy: "all" },
          rubricPrompt: "prompt://quality",
          transform: "output",
          contextTransform: "context",
          assertions: [{ type: "equals", metric: "nested", weight: 1, value: "hello" }]
        }
      ]
    } as const;
    await writeFile(join(root, manifest.inputs.tests.path), `${JSON.stringify([transport])}\n`);
    const directory = await SecureWorkPackageDirectory.open(root);
    try {
      const reader = new WorkPackageInputReader(directory, {
        ...manifest,
        cases: [
          {
            caseKey: definition.caseKey,
            ordinal: 0,
            baseDefinitionHash: hashCaseDefinition({
              contractVersion: "cortex.case-definition.v1",
              caseKey: definition.caseKey,
              definition: caseDefinitionJson(definition)
            })
          }
        ]
      });
      const values = [];
      for await (const value of reader.streamCases(caseHasher)) values.push(value);
      expect(values[0]?.definition).toEqual(definition);
      expect(reader.requiredEnvKeys("REST")).toEqual([]);
      expect(reader.requiredEnvKeys("EVALUATION")).toEqual(["GEMINI_API_KEY"]);
    } finally {
      directory.close();
    }
  });

  it("rejects Case alignment, count, hash and dirty configuration inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-package-input-reader-errors-"));
    roots.push(root);
    const manifest = await materializeWorkPackageFixture(root, {
      baseDefinitionHash: hashCaseDefinition({
        contractVersion: "cortex.case-definition.v1",
        caseKey: fixtureDefinition.caseKey,
        definition: caseDefinitionJson(fixtureDefinition)
      })
    });
    const directory = await SecureWorkPackageDirectory.open(root);
    const collect = async (reader: WorkPackageInputReader): Promise<void> => {
      for await (const value of reader.streamCases(caseHasher)) void value;
    };
    try {
      const firstCase = manifest.cases[0];
      if (firstCase === undefined) throw new Error("Fixture manifest must contain one Case");
      await expect(
        collect(
          new WorkPackageInputReader(directory, {
            ...manifest,
            cases: [{ ...firstCase, caseKey: "wrong-case" }]
          })
        )
      ).rejects.toThrow("WORK_PACKAGE_INVALID");
      await expect(
        collect(
          new WorkPackageInputReader(directory, {
            ...manifest,
            cases: [{ ...firstCase, baseDefinitionHash: sha256(Buffer.from("wrong")) }]
          })
        )
      ).rejects.toThrow("WORK_PACKAGE_HASH_MISMATCH");
      await expect(
        collect(
          new WorkPackageInputReader(directory, {
            ...manifest,
            cases: [firstCase, { ...firstCase, ordinal: 1 }]
          })
        )
      ).rejects.toThrow("WORK_PACKAGE_INVALID");

      const invalidJson = Buffer.from("{");
      await writeFile(join(root, manifest.inputs.endpoint.path), invalidJson);
      const invalidEndpointManifest = {
        ...manifest,
        inputs: {
          ...manifest.inputs,
          endpoint: {
            ...manifest.inputs.endpoint,
            sha256: sha256(invalidJson),
            sizeBytes: invalidJson.byteLength
          }
        }
      };
      await expect(
        new WorkPackageInputReader(directory, invalidEndpointManifest).readEndpoint()
      ).rejects.toThrow("WORK_PACKAGE_INVALID");
      const emptyObject = Buffer.from("{}");
      await writeFile(join(root, manifest.inputs.endpoint.path), emptyObject);
      const emptyEndpointManifest = {
        ...manifest,
        inputs: {
          ...manifest.inputs,
          endpoint: {
            ...manifest.inputs.endpoint,
            sha256: sha256(emptyObject),
            sizeBytes: emptyObject.byteLength
          }
        }
      };
      await expect(
        new WorkPackageInputReader(directory, emptyEndpointManifest).readEndpoint()
      ).rejects.toThrow("WORK_PACKAGE_INVALID");
      await writeFile(join(root, manifest.inputs.evaluator.path), invalidJson);
      const invalidEvaluatorManifest = {
        ...manifest,
        inputs: {
          ...manifest.inputs,
          evaluator: {
            ...manifest.inputs.evaluator,
            sha256: sha256(invalidJson),
            sizeBytes: invalidJson.byteLength
          }
        }
      };
      await expect(
        new WorkPackageInputReader(directory, invalidEvaluatorManifest).readEvaluationInputs()
      ).rejects.toThrow("WORK_PACKAGE_INVALID");
      await writeFile(join(root, manifest.inputs.evaluator.path), emptyObject);
      const emptyEvaluatorManifest = {
        ...manifest,
        inputs: {
          ...manifest.inputs,
          evaluator: {
            ...manifest.inputs.evaluator,
            sha256: sha256(emptyObject),
            sizeBytes: emptyObject.byteLength
          }
        }
      };
      await expect(
        new WorkPackageInputReader(directory, emptyEvaluatorManifest).readEvaluationInputs()
      ).rejects.toThrow("WORK_PACKAGE_INVALID");
    } finally {
      directory.close();
    }
  });
});
