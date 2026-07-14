import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { CaseDefinitionV1 } from "@cortex-eval/contracts/src/case-contracts.ts";

import { readCanonicalTests } from "../src/canonical-tests-stream-reader.ts";
import {
  SecureWorkPackageDirectory,
  type WorkPackageLockOwner
} from "../src/secure-work-package-directory.ts";
import {
  assembleWorkPackageInputs,
  type WorkPackageExportCase,
  type WorkPackageInputAssembly
} from "../src/work-package-input-assembler.ts";
import { validateWorkPackageDirectory } from "../src/work-package-validator.ts";

const ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cortex-assembler-"));
  roots.push(root);
  return root;
}

function owner(): WorkPackageLockOwner {
  return {
    pid: process.pid,
    processStartedAt: "Tue Jul 14 14:00:00 2026",
    executionId: null,
    acquiredAt: "2026-07-14T06:00:00.000Z"
  } as const;
}

function caseDefinition(): CaseDefinitionV1 {
  return {
    contractVersion: "cortex.case-definition.v1" as const,
    description: "assembled",
    threshold: 1,
    vars: { task: "evaluate", request_body: { text: "hello" } },
    metadata: {
      case_id: "case-1",
      req_id: "req-1",
      task_id: "task-1",
      business_module: "assembler",
      scenario_tag: "happy"
    },
    assert: [
      {
        type: "llm-rubric",
        metric: "quality",
        weight: 1,
        rubricPrompt: "prompt://quality"
      }
    ]
  };
}

function assembly(
  cases: AsyncIterable<WorkPackageExportCase>,
  overrides: Partial<WorkPackageInputAssembly> = {}
): WorkPackageInputAssembly {
  return {
    packageId: ID,
    createdAt: "2026-07-14T00:00:00.000Z",
    sourceSuite: { suiteId: ID, suiteHash: HASH_B, caseCount: 1 },
    cases,
    endpoint: {
      semanticHash: HASH_A,
      definition: {
        contractVersion: "cortex.endpoint-config.v1",
        urlTemplate: "https://example.com/evaluate",
        method: "POST",
        headers: { Authorization: { kind: "ENV_SECRET", envKey: "SERVICE_TOKEN" } },
        bodySelector: "/request_body",
        timeoutMs: 60_000,
        defaultConcurrency: 4
      }
    },
    evaluator: {
      semanticHash: HASH_A,
      definition: {
        contractVersion: "cortex.llm-config.v1",
        providerType: "GOOGLE_GEMINI",
        model: "gemini-2.5-flash",
        apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" },
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 1024,
        timeoutMs: 60_000,
        structuredOutput: "JSON_SCHEMA"
      }
    },
    analyzer: {
      semanticHash: HASH_B,
      definition: {
        contractVersion: "cortex.llm-config.v1",
        providerType: "OPENAI_COMPATIBLE",
        model: "analyzer",
        baseUrl: "https://llm.example.com/v1",
        auth: {
          kind: "BEARER_ENV",
          secret: { kind: "ENV_SECRET", envKey: "ANALYZER_TOKEN" }
        },
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 1024,
        timeoutMs: 60_000,
        structuredOutput: "JSON_SCHEMA"
      }
    },
    rubricPrompts: [
      {
        semanticHash: HASH_A,
        definition: {
          contractVersion: "cortex.prompt.v1",
          kind: "LLM_RUBRIC",
          promptKey: "quality",
          messages: [{ role: "USER", content: "Judge quality" }]
        }
      }
    ],
    rubricPromptSetHasher: { hash: (): string => HASH_B },
    analysisPrompt: {
      semanticHash: HASH_B,
      definition: {
        contractVersion: "cortex.prompt.v1",
        kind: "CASE_ANALYSIS",
        promptKey: "analysis",
        messages: [{ role: "USER", content: "Analyze {{run_context}}" }]
      }
    },
    ...overrides
  };
}

function emptyCases(): AsyncIterable<WorkPackageExportCase> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<WorkPackageExportCase> => ({
      next: (): Promise<IteratorResult<WorkPackageExportCase>> =>
        Promise.resolve({ done: true, value: undefined })
    })
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Work Package input assembler", () => {
  it("streams complete non-secret inputs and creates a self-validating Manifest", async () => {
    const root = await temporaryRoot();
    const directory = await SecureWorkPackageDirectory.open(root);
    async function* cases(): AsyncGenerator<WorkPackageExportCase> {
      await Promise.resolve();
      yield { definition: caseDefinition(), baseDefinitionHash: HASH_A };
    }
    const manifest = await assembleWorkPackageInputs(
      directory,
      assembly(cases()),
      "assembler-happy"
    );
    await expect(validateWorkPackageDirectory(directory, owner())).resolves.toMatchObject({
      manifest: { packageId: ID }
    });
    directory.close();

    expect(manifest.requiredEnvKeys).toEqual({
      REST: ["SERVICE_TOKEN"],
      EVALUATION: ["GEMINI_API_KEY"],
      REPORT: [],
      ANALYSIS: ["ANALYZER_TOKEN"]
    });
    const env = await readFile(join(root, ".env.example"), "utf8");
    expect(env).toContain("SERVICE_TOKEN=\n");
    expect(env).toContain("GEMINI_API_KEY=\n");
    expect(env).toContain("ANALYZER_TOKEN=\n");
    expect(env).not.toContain("secret");
    const parsed = [];
    for await (const item of readCanonicalTests(
      (async function* (): AsyncGenerator<Buffer> {
        yield await readFile(join(root, "inputs/tests.json"));
      })()
    )) {
      parsed.push(item.metadata.case_id);
    }
    expect(parsed).toEqual(["case-1"]);
  });

  it("rejects duplicate Prompt candidates before creating package files", async () => {
    const root = await temporaryRoot();
    const directory = await SecureWorkPackageDirectory.open(root);
    const base = assembly(emptyCases());
    await expect(
      assembleWorkPackageInputs(
        directory,
        { ...base, rubricPrompts: [...base.rubricPrompts, ...base.rubricPrompts] },
        "duplicate-prompts"
      )
    ).rejects.toThrow("WORK_PACKAGE_INVALID");
    directory.close();
  });

  it("aborts the partial Tests artifact on cancellation and revision conflicts", async () => {
    const cancelledRoot = await temporaryRoot();
    const cancelledDirectory = await SecureWorkPackageDirectory.open(cancelledRoot);
    const controller = new AbortController();
    controller.abort();
    async function* oneCase(): AsyncGenerator<WorkPackageExportCase> {
      await Promise.resolve();
      yield { definition: caseDefinition(), baseDefinitionHash: HASH_A };
    }
    await expect(
      assembleWorkPackageInputs(
        cancelledDirectory,
        assembly(oneCase(), { signal: controller.signal }),
        "cancelled"
      )
    ).rejects.toThrow("REQUEST_ABORTED");
    cancelledDirectory.close();

    const emptyRoot = await temporaryRoot();
    const emptyDirectory = await SecureWorkPackageDirectory.open(emptyRoot);
    await expect(
      assembleWorkPackageInputs(emptyDirectory, assembly(emptyCases()), "revision-conflict")
    ).rejects.toThrow("EXPORT_REVISION_CONFLICT");
    emptyDirectory.close();
  });

  it("rejects duplicate Cases and missing recursively referenced Rubric Prompts", async () => {
    const duplicateRoot = await temporaryRoot();
    const duplicateDirectory = await SecureWorkPackageDirectory.open(duplicateRoot);
    async function* duplicateCases(): AsyncGenerator<WorkPackageExportCase> {
      await Promise.resolve();
      yield { definition: caseDefinition(), baseDefinitionHash: HASH_A };
      yield { definition: caseDefinition(), baseDefinitionHash: HASH_B };
    }
    await expect(
      assembleWorkPackageInputs(
        duplicateDirectory,
        assembly(duplicateCases(), {
          sourceSuite: { suiteId: ID, suiteHash: HASH_B, caseCount: 2 }
        }),
        "duplicate-cases"
      )
    ).rejects.toThrow("WORK_PACKAGE_INVALID");
    duplicateDirectory.close();

    const missingRoot = await temporaryRoot();
    const missingDirectory = await SecureWorkPackageDirectory.open(missingRoot);
    const second = caseDefinition();
    second.metadata.case_id = "case-2";
    second.assert = [
      {
        type: "assert-set",
        metric: "group",
        assert: [
          {
            type: "llm-rubric",
            metric: "missing",
            rubricPrompt: "prompt://missing"
          }
        ]
      }
    ];
    async function* missingPromptCases(): AsyncGenerator<WorkPackageExportCase> {
      await Promise.resolve();
      yield { definition: caseDefinition(), baseDefinitionHash: HASH_A };
      yield { definition: second, baseDefinitionHash: HASH_B };
    }
    await expect(
      assembleWorkPackageInputs(
        missingDirectory,
        assembly(missingPromptCases(), {
          sourceSuite: { suiteId: ID, suiteHash: HASH_B, caseCount: 2 }
        }),
        "missing-prompt"
      )
    ).rejects.toThrow("RUBRIC_PROMPT_NOT_FOUND");
    missingDirectory.close();
  });

  it("supports safe literal REST headers and local no-auth LLM configurations", async () => {
    const root = await temporaryRoot();
    const directory = await SecureWorkPackageDirectory.open(root);
    const definition = caseDefinition();
    definition.assert = [{ type: "equals", metric: "exact", value: "hello" }];
    async function* cases(): AsyncGenerator<WorkPackageExportCase> {
      await Promise.resolve();
      yield { definition, baseDefinitionHash: HASH_A };
    }
    const localLlm = {
      contractVersion: "cortex.llm-config.v1",
      providerType: "OPENAI_COMPATIBLE",
      model: "local",
      baseUrl: "http://localhost:11434/v1",
      auth: { kind: "NONE" },
      thinkingLevel: "OFF",
      temperature: 0,
      topP: 1,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      structuredOutput: "JSON_SCHEMA"
    } as const;
    const manifest = await assembleWorkPackageInputs(
      directory,
      assembly(cases(), {
        endpoint: {
          semanticHash: HASH_A,
          definition: {
            contractVersion: "cortex.endpoint-config.v1",
            urlTemplate: "https://example.com/evaluate",
            method: "POST",
            headers: { "content-type": { kind: "LITERAL", value: "application/json" } },
            bodySelector: "/request_body",
            timeoutMs: 60_000,
            defaultConcurrency: 1
          }
        },
        evaluator: { semanticHash: HASH_A, definition: localLlm },
        analyzer: { semanticHash: HASH_B, definition: localLlm },
        rubricPrompts: []
      }),
      "local-no-auth"
    );
    expect(manifest.requiredEnvKeys).toEqual({
      REST: [],
      EVALUATION: [],
      REPORT: [],
      ANALYSIS: []
    });
    directory.close();
  });
});
