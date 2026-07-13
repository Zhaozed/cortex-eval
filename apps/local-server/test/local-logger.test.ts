import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ResilientBusinessLogger,
  RotatingTextLogSink,
  formatBusinessLogLine,
  type TextLogSink
} from "../src/local-logger.ts";

describe("P3 中文安全日志", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))
    );
  });

  it("只格式化安全字段，控制字符收敛为单行且忽略秘密正文", () => {
    const line = formatBusinessLogLine({
      event: "REQUEST_COMPLETED",
      timestamp: "2026-07-13T00:00:00.000Z",
      requestId: "request-1",
      resourceId: "resource-1",
      caseKey: "case\nkey",
      errorCode: "VALIDATION_FAILED",
      durationMs: 12,
      authorization: "Bearer expanded-secret",
      prompt: "secret prompt"
    } as never);

    expect(line).toContain("请求处理完成");
    expect(line).toContain("case key");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(line).not.toMatch(/expanded-secret|secret prompt|authorization|prompt/i);
  });

  it("外化 P5 Run 冻结、执行、取消和完成业务事件", () => {
    const expected = new Map([
      ["RUN_INPUT_FROZEN", "运行输入已冻结"],
      ["RUN_REST_STARTED", "REST 阶段已开始"],
      ["RUN_REST_COMPLETED", "REST 阶段已完成"],
      ["RUN_CANCEL_REQUESTED", "运行取消已请求"],
      ["RUN_CANCELLED", "运行取消已完成"]
    ] as const);
    for (const [event, text] of expected) {
      expect(
        formatBusinessLogLine({ event, timestamp: "2026-07-13T00:00:00.000Z", resourceId: "run-1" })
      ).toContain(text);
    }
  });

  it("达到阈值前轮转并只保留受控数量", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-log-"));
    roots.push(root);
    const path = join(root, "server.log");
    const sink = new RotatingTextLogSink({ path, maximumBytes: 80, retainedFiles: 2 });
    for (let index = 0; index < 8; index += 1) {
      await sink.write(`line-${index}-${"x".repeat(30)}\n`);
    }
    const names = (await readdir(root)).sort();
    expect(names).toEqual(["server.log", "server.log.1", "server.log.2"]);
    expect(await readFile(path, "utf8")).toContain("line-7");
  });

  it("主日志写失败只输出脱敏 stderr 降级提示且不抛错", async () => {
    const failing: TextLogSink = { write: () => Promise.reject(new Error("secret stack")) };
    const stderr: string[] = [];
    const logger = new ResilientBusinessLogger({
      sink: failing,
      stderr: {
        write: (line): void => {
          stderr.push(line);
        }
      }
    });

    await expect(
      logger.record({
        event: "REQUEST_COMPLETED",
        timestamp: "2026-07-13T00:00:00.000Z",
        requestId: "request-1",
        durationMs: 1
      })
    ).resolves.toBeUndefined();
    expect(stderr).toEqual(["日志写入失败，已降级到标准错误\n"]);
    expect(stderr.join("")).not.toContain("secret stack");
  });
});
