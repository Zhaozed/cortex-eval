import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { ImportedEvalCase } from "@cortex-eval/application/src/features/evaluation/promptfoo-result-importer.ts";
import { importPartialPromptfooResultRows } from "@cortex-eval/application/src/features/evaluation/promptfoo-row-stream-importer.ts";
import type { FrozenRunCase } from "@cortex-eval/application/src/features/runs/run-rest-models.ts";

import { startEvaluatorBridgeV2 } from "../src/evaluator-bridge-v2.ts";
import { materializePromptfooConfigV1 } from "../src/promptfoo-config-materializer.ts";
import {
  preflightPromptfooEvaluationProcessVersion,
  runPromptfooEvaluationProcess
} from "../src/promptfoo-evaluation-process.ts";

const ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const HASH = "a".repeat(64);
const TOKEN = "A".repeat(43);

describe("Promptfoo Evaluation 子进程", () => {
  it("只复用精确二进制身份的短期版本证明", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-version-attestation-"));
    const binary = join(root, "fake-promptfoo");
    const counterPath = join(root, "version-calls.txt");
    const source = (suffix: string): string => `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(counterPath)}, "x");
if (process.argv.includes("--version")) {
  process.stdout.write("0.121.18\\n");
  process.exit(0);
}
process.exit(1);
// ${suffix}
`;
    await writeFile(binary, source("first"), { encoding: "utf8", mode: 0o700 });
    await chmod(binary, 0o700);
    const input = {
      promptfooBinary: binary,
      temporaryContainmentRoot: root,
      temporaryParent: join(root, "temporary"),
      timeoutMs: 5_000,
      signal: new AbortController().signal
    };

    try {
      await preflightPromptfooEvaluationProcessVersion(input);
      await preflightPromptfooEvaluationProcessVersion(input);
      expect(await readFile(counterPath, "utf8")).toBe("x");

      await writeFile(binary, source("second-and-different-size"), {
        encoding: "utf8",
        mode: 0o700
      });
      await chmod(binary, 0o700);
      await preflightPromptfooEvaluationProcessVersion(input);
      expect(await readFile(counterPath, "utf8")).toBe("xx");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("在任何目录变更前拒绝临时父目录逃出显式受控根", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-contained-root-"));
    const external = await mkdtemp(join(tmpdir(), "cortex-eval-contained-external-"));
    const generated = materializePromptfooConfigV1({
      binding: { kind: "RUN", runId: ID },
      evaluationContextHash: HASH,
      bridgeUrl: "http://127.0.0.1:43199/v2/evaluate",
      bridgeCapabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
      cases: [],
      rubricPrompts: [],
      requiresEvaluator: () => false
    });

    try {
      await expect(
        runPromptfooEvaluationProcess({
          promptfooBinary: resolve("node_modules/.bin/promptfoo"),
          config: generated.config,
          capabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
          rawCapability: TOKEN,
          temporaryContainmentRoot: root,
          temporaryParent: join(external, "promptfoo"),
          timeoutMs: 10_000,
          signal: new AbortController().signal
        })
      ).rejects.toThrow("PROMPTFOO_TEMPORARY_PATH_INVALID");
      expect(await readdir(external)).toEqual([]);
    } finally {
      await Promise.all([
        rm(root, { force: true, recursive: true }),
        rm(external, { force: true, recursive: true })
      ]);
    }
  });

  it("在任何子进程或临时文件创建前拒绝符号链接临时父目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-symlink-parent-"));
    const external = await mkdtemp(join(tmpdir(), "cortex-eval-symlink-external-"));
    const linkedParent = join(root, "promptfoo");
    await symlink(external, linkedParent, "dir");
    const generated = materializePromptfooConfigV1({
      binding: { kind: "RUN", runId: ID },
      evaluationContextHash: HASH,
      bridgeUrl: "http://127.0.0.1:43199/v2/evaluate",
      bridgeCapabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
      cases: [],
      rubricPrompts: [],
      requiresEvaluator: () => false
    });

    try {
      await expect(
        runPromptfooEvaluationProcess({
          promptfooBinary: resolve("node_modules/.bin/promptfoo"),
          config: generated.config,
          capabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
          rawCapability: TOKEN,
          temporaryContainmentRoot: root,
          temporaryParent: linkedParent,
          timeoutMs: 10_000,
          signal: new AbortController().signal
        })
      ).rejects.toThrow("PROMPTFOO_TEMPORARY_PATH_INVALID");
      expect(await readdir(external)).toEqual([]);
    } finally {
      await Promise.all([
        rm(root, { force: true, recursive: true }),
        rm(external, { force: true, recursive: true })
      ]);
    }
  });

  it("拒绝内联 Assertion 把 Bridge Capability 写入 Raw Evidence", async () => {
    const parent = join(tmpdir(), `cortex-eval-capability-leak-${process.pid}-${Date.now()}`);
    const generated = materializePromptfooConfigV1({
      binding: { kind: "RUN", runId: ID },
      evaluationContextHash: HASH,
      bridgeUrl: "http://127.0.0.1:43199/v2/evaluate",
      bridgeCapabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
      cases: [
        {
          testCase: {
            caseKey: "case-capability-leak",
            ordinal: 0,
            definitionHash: HASH,
            definition: {
              caseKey: "case-capability-leak",
              description: "capability leak boundary",
              threshold: 1,
              task: "planner",
              requestBody: { input: "hello" },
              metadata: {
                requestId: "request-capability-leak",
                taskId: "task-capability-leak",
                businessModule: "module",
                scenarioTag: "security"
              },
              assertions: [
                {
                  type: "javascript",
                  metric: "capability-isolation",
                  weight: 1,
                  value:
                    "({ pass: false, score: 0, reason: process.env.CORTEX_EVAL_BRIDGE_CAPABILITY })"
                }
              ]
            }
          },
          restResult: {
            status: "SUCCEEDED",
            providerOutput: { ok: false, errorMessage: "actual output" }
          }
        }
      ],
      rubricPrompts: [],
      requiresEvaluator: () => false
    });

    await expect(
      runPromptfooEvaluationProcess({
        promptfooBinary: resolve("node_modules/.bin/promptfoo"),
        config: generated.config,
        capabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
        rawCapability: TOKEN,
        temporaryContainmentRoot: tmpdir(),
        temporaryParent: parent,
        timeoutMs: 10_000,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("PROMPTFOO_CAPABILITY_EXPOSED");
    expect(await readdir(parent)).toEqual([]);
  }, 30_000);

  it("真实内联 Assertion 抛错归一化为可重试 Evaluation Error，且不泄露堆栈", async () => {
    const parent = join(tmpdir(), `cortex-eval-assertion-error-${process.pid}-${Date.now()}`);
    const testCase: FrozenRunCase = {
      caseKey: "case-error",
      ordinal: 0,
      definitionHash: HASH,
      definition: {
        caseKey: "case-error",
        description: "assertion execution error",
        threshold: 1,
        task: "planner",
        requestBody: { input: "hello" },
        metadata: {
          requestId: "request-error",
          taskId: "task-error",
          businessModule: "module",
          scenarioTag: "error"
        },
        assertions: [
          {
            type: "javascript",
            metric: "runtime",
            weight: 1,
            value: "(() => { throw new Error('PRIVATE_THROW') })()"
          }
        ]
      }
    };
    const providerOutput = { ok: false as const, errorMessage: "actual output" };
    const generated = materializePromptfooConfigV1({
      binding: { kind: "RUN", runId: ID },
      evaluationContextHash: HASH,
      bridgeUrl: "http://127.0.0.1:43199/v2/evaluate",
      bridgeCapabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
      cases: [{ testCase, restResult: { status: "SUCCEEDED", providerOutput } }],
      rubricPrompts: [],
      requiresEvaluator: () => false
    });

    const processResult = await runPromptfooEvaluationProcess({
      promptfooBinary: resolve("node_modules/.bin/promptfoo"),
      config: generated.config,
      capabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
      rawCapability: TOKEN,
      temporaryContainmentRoot: tmpdir(),
      temporaryParent: parent,
      timeoutMs: 10_000,
      signal: new AbortController().signal
    });
    let normalized: ImportedEvalCase | undefined;
    try {
      [normalized] = await importPartialPromptfooResultRows({
        promptfooVersion: processResult.promptfooVersion,
        rows: processResult.raw.openRows(),
        cases: [
          {
            caseKey: testCase.caseKey,
            ordinal: testCase.ordinal,
            caseDefinitionHash: testCase.definitionHash,
            definition: testCase.definition,
            restResult: { status: "SUCCEEDED", resultHash: HASH, providerOutput }
          }
        ],
        rawEvidence: {
          present: true,
          path: `runs/${ID}/promptfoo-raw.json`,
          expectedSha256: HASH,
          expectedSizeBytes: 1
        },
        rubricPromptMaterializations: {}
      });
    } finally {
      await processResult.raw.dispose();
    }

    expect(normalized).toMatchObject({
      status: "EVALUATION_ERROR",
      promptfooSuccess: null,
      score: null,
      reason: null,
      evaluationError: {
        code: "PROMPTFOO_ASSERTION_EXECUTION_ERROR"
      },
      assertions: [{ metric: "runtime", status: "ERROR", score: null, reason: null }],
      metrics: [{ metric: "runtime", status: "ERROR" }]
    });
    expect(JSON.stringify(normalized)).not.toContain("PRIVATE_THROW");
    expect(JSON.stringify(normalized)).not.toContain(process.cwd());
  }, 30_000);

  it("超时时先终止完整进程组，再强杀忽略 TERM 的解释器后代并回收目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-process-tree-"));
    const binary = join(root, "fake-promptfoo");
    const descendantPidPath = join(root, "descendant.pid");
    let descendantPid: number | null = null;
    const descendantCode = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const source = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf "0.121.18\\n"
  exit 0
fi
${JSON.stringify(process.execPath)} -e ${JSON.stringify(descendantCode)} >/dev/null 2>&1 &
printf "%s" "$!" > ${JSON.stringify(descendantPidPath)}
trap 'exit 0' TERM
while true; do sleep 1; done
`;
    await writeFile(binary, source, { encoding: "utf8", mode: 0o700 });
    await chmod(binary, 0o700);
    const generated = materializePromptfooConfigV1({
      binding: { kind: "RUN", runId: ID },
      evaluationContextHash: HASH,
      bridgeUrl: "http://127.0.0.1:43199/v2/evaluate",
      bridgeCapabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
      cases: [],
      rubricPrompts: [],
      requiresEvaluator: () => false
    });

    try {
      await expect(
        runPromptfooEvaluationProcess({
          promptfooBinary: binary,
          config: generated.config,
          capabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
          rawCapability: TOKEN,
          temporaryContainmentRoot: root,
          temporaryParent: join(root, "temporary"),
          timeoutMs: 5_000,
          signal: new AbortController().signal
        })
      ).rejects.toThrow("PROMPTFOO_PROCESS_TIMEOUT");
      const observedPid = Number.parseInt(await readFile(descendantPidPath, "utf8"), 10);
      descendantPid = observedPid;
      expect(() => process.kill(observedPid, 0)).toThrow();
      expect(await readdir(join(root, "temporary"))).toEqual([]);
    } finally {
      if (descendantPid !== null) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The process-tree cleanup under test already reaped the descendant.
        }
      }
      await rm(root, { force: true, recursive: true });
    }
  }, 15_000);

  it("主进程先退出时仍把剩余 TERM 宽限期留给解释器后代清理", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-process-grace-"));
    const binary = join(root, "fake-promptfoo");
    const descendantPidPath = join(root, "descendant.pid");
    const cleanupMarkerPath = join(root, "descendant-cleanup.txt");
    const descendantReadyPath = join(root, "descendant-ready.txt");
    let descendantPid: number | null = null;
    const descendantCode = `
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {
  setTimeout(() => {
    writeFileSync(${JSON.stringify(cleanupMarkerPath)}, "cleaned");
    process.exit(0);
  }, 200);
});
process.on("SIGHUP", () => {});
writeFileSync(${JSON.stringify(descendantReadyPath)}, "ready");
setInterval(() => {}, 1000);
`;
    const source = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("0.121.18\\n");
  process.exit(0);
}
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], {
  stdio: "ignore"
});
writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;
    await writeFile(binary, source, { encoding: "utf8", mode: 0o700 });
    await chmod(binary, 0o700);
    const generated = materializePromptfooConfigV1({
      binding: { kind: "RUN", runId: ID },
      evaluationContextHash: HASH,
      bridgeUrl: "http://127.0.0.1:43199/v2/evaluate",
      bridgeCapabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
      cases: [],
      rubricPrompts: [],
      requiresEvaluator: () => false
    });

    try {
      await expect(
        runPromptfooEvaluationProcess({
          promptfooBinary: binary,
          config: generated.config,
          capabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
          rawCapability: TOKEN,
          temporaryContainmentRoot: root,
          temporaryParent: join(root, "temporary"),
          timeoutMs: 1_000,
          signal: new AbortController().signal
        })
      ).rejects.toThrow("PROMPTFOO_PROCESS_TIMEOUT");
      const observedPid = Number.parseInt(await readFile(descendantPidPath, "utf8"), 10);
      descendantPid = observedPid;
      expect(await readFile(cleanupMarkerPath, "utf8")).toBe("cleaned");
      expect(() => process.kill(observedPid, 0)).toThrow();
      expect(await readdir(join(root, "temporary"))).toEqual([]);
    } finally {
      if (descendantPid !== null) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The descendant should have completed its TERM cleanup under test.
        }
      }
      await rm(root, { force: true, recursive: true });
    }
  }, 10_000);

  it("版本检查与 Eval 共用同一个整体截止时间", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-whole-deadline-"));
    const binary = join(root, "fake-promptfoo");
    const source = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  setTimeout(() => {
    process.stdout.write("0.121.18\\n");
    process.exit(0);
  }, 250);
} else {
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
}
`;
    await writeFile(binary, source, { encoding: "utf8", mode: 0o700 });
    await chmod(binary, 0o700);
    const generated = materializePromptfooConfigV1({
      binding: { kind: "RUN", runId: ID },
      evaluationContextHash: HASH,
      bridgeUrl: "http://127.0.0.1:43199/v2/evaluate",
      bridgeCapabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
      cases: [],
      rubricPrompts: [],
      requiresEvaluator: () => false
    });
    const startedAt = Date.now();

    try {
      await expect(
        runPromptfooEvaluationProcess({
          promptfooBinary: binary,
          config: generated.config,
          capabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
          rawCapability: TOKEN,
          temporaryContainmentRoot: root,
          temporaryParent: join(root, "temporary"),
          timeoutMs: 300,
          signal: new AbortController().signal
        })
      ).rejects.toThrow("PROMPTFOO_PROCESS_TIMEOUT");
      expect(Date.now() - startedAt).toBeLessThan(450);
      expect(await readdir(join(root, "temporary"))).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 5_000);

  it("诊断输出超过固定上限时终止进程且不暴露部分 Raw", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-diagnostic-limit-"));
    const binary = join(root, "fake-promptfoo");
    const source = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("0.121.18\\n");
  process.exit(0);
} else {
  process.on("SIGTERM", () => process.exit(0));
  process.stdout.write(Buffer.alloc(2 * 1024 * 1024, "x"));
  setInterval(() => process.stdout.write(Buffer.alloc(256 * 1024, "y")), 1);
}
`;
    await writeFile(binary, source, { encoding: "utf8", mode: 0o700 });
    await chmod(binary, 0o700);
    const generated = materializePromptfooConfigV1({
      binding: { kind: "RUN", runId: ID },
      evaluationContextHash: HASH,
      bridgeUrl: "http://127.0.0.1:43199/v2/evaluate",
      bridgeCapabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
      cases: [],
      rubricPrompts: [],
      requiresEvaluator: () => false
    });

    try {
      await expect(
        runPromptfooEvaluationProcess({
          promptfooBinary: binary,
          config: generated.config,
          capabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
          rawCapability: TOKEN,
          temporaryContainmentRoot: root,
          temporaryParent: join(root, "temporary"),
          timeoutMs: 5_000,
          signal: new AbortController().signal
        })
      ).rejects.toThrow("PROMPTFOO_PROCESS_TIMEOUT");
      expect(await readdir(join(root, "temporary"))).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 10_000);

  it("只向可信内联 Assertion 暴露运行所需环境，不继承父进程无关 Secret", async () => {
    const parent = join(tmpdir(), `cortex-eval-process-env-test-${process.pid}-${Date.now()}`);
    const secretKey = "CORTEX_UNRELATED_PROCESS_SECRET";
    const previous = process.env[secretKey];
    process.env[secretKey] = "must-not-reach-promptfoo";
    const generated = materializePromptfooConfigV1({
      binding: { kind: "RUN", runId: ID },
      evaluationContextHash: HASH,
      bridgeUrl: "http://127.0.0.1:43199/v2/evaluate",
      bridgeCapabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
      cases: [
        {
          testCase: {
            caseKey: "case-env",
            ordinal: 0,
            definitionHash: HASH,
            definition: {
              caseKey: "case-env",
              description: "environment boundary",
              threshold: 1,
              task: "planner",
              requestBody: { input: "hello" },
              metadata: {
                requestId: "request-env",
                taskId: "task-env",
                businessModule: "module",
                scenarioTag: "security"
              },
              assertions: [
                {
                  type: "javascript",
                  metric: "environment-isolation",
                  weight: 1,
                  value: `process.env.${secretKey} === undefined`
                }
              ]
            }
          },
          restResult: {
            status: "SUCCEEDED",
            providerOutput: { ok: false, errorMessage: "actual output" }
          }
        }
      ],
      rubricPrompts: [],
      requiresEvaluator: () => false
    });

    try {
      const result = await runPromptfooEvaluationProcess({
        promptfooBinary: resolve("node_modules/.bin/promptfoo"),
        config: generated.config,
        capabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
        rawCapability: TOKEN,
        temporaryContainmentRoot: tmpdir(),
        temporaryParent: parent,
        timeoutMs: 10_000,
        signal: new AbortController().signal
      });

      try {
        expect(result.exitCode).toBe(0);
      } finally {
        await result.raw.dispose();
      }
      expect(await readdir(parent)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.CORTEX_UNRELATED_PROCESS_SECRET;
      else process.env.CORTEX_UNRELATED_PROCESS_SECRET = previous;
    }
  }, 30_000);

  it("以预计算输出和 Bridge v2 运行固定版本，识别 Assertion Fail 退出码并回收临时目录", async () => {
    const { createHash } = await import("node:crypto");
    const parent = join(tmpdir(), `cortex-eval-process-test-${process.pid}-${Date.now()}`);
    const prompts: string[] = [];
    const bridge = await startEvaluatorBridgeV2({
      rawCapability: TOKEN,
      capability: {
        contractVersion: "cortex.evaluator-bridge-capability.v2",
        capabilityHash: createHash("sha256").update(TOKEN).digest("hex"),
        binding: { kind: "RUN", runId: ID },
        evaluationContextHash: HASH,
        evaluatorConfigHash: HASH,
        maxCalls: 1,
        maxConcurrency: 1,
        timeoutMs: 1_000,
        expiresAt: "2099-01-01T00:00:00.000Z"
      },
      createCallId: () => ID,
      evaluator: {
        generate: ({ prompt }) => {
          prompts.push(prompt);
          return Promise.resolve({
            text: JSON.stringify({ reason: "not good enough", score: 0, pass: false }),
            structured: null,
            tokenUsage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 }
          });
        }
      }
    });

    try {
      const generated = materializePromptfooConfigV1({
        binding: { kind: "RUN", runId: ID },
        evaluationContextHash: HASH,
        bridgeUrl: bridge.url,
        bridgeCapabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
        cases: [
          {
            testCase: {
              caseKey: "case-1",
              ordinal: 0,
              definitionHash: HASH,
              definition: {
                caseKey: "case-1",
                description: "grader process",
                threshold: 1,
                task: "planner",
                requestBody: { input: "hello" },
                metadata: {
                  requestId: "request-1",
                  taskId: "task-1",
                  businessModule: "module",
                  scenarioTag: "scenario"
                },
                assertions: [
                  { type: "llm-rubric", metric: "quality", weight: 1, value: "be correct" }
                ]
              }
            },
            restResult: {
              status: "SUCCEEDED",
              providerOutput: { ok: false, errorMessage: "actual output" }
            }
          }
        ],
        rubricPrompts: [],
        requiresEvaluator: (type) => type === "llm-rubric"
      });

      const result = await runPromptfooEvaluationProcess({
        promptfooBinary: resolve("node_modules/.bin/promptfoo"),
        config: generated.config,
        capabilityEnvKey: "CORTEX_EVAL_BRIDGE_CAPABILITY",
        rawCapability: TOKEN,
        temporaryContainmentRoot: tmpdir(),
        temporaryParent: parent,
        timeoutMs: 10_000,
        signal: new AbortController().signal
      });

      const rawRows: unknown[] = [];
      try {
        expect(result.promptfooVersion).toBe("0.121.18");
        expect(result.exitCode).toBe(100);
        for await (const row of result.raw.openRows()) rawRows.push(row);
        expect(prompts).toHaveLength(1);
        expect(rawRows).toMatchObject([
          { gradingResult: { tokensUsed: { prompt: 11, completion: 7, total: 18 } } }
        ]);
      } finally {
        await result.raw.dispose();
      }
      expect((await lstat(parent)).mode & 0o777).toBe(0o700);
      expect(await readdir(parent)).toEqual([]);
    } finally {
      await bridge.close();
    }
  }, 30_000);
});
