import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CASE_DEFINITION_V1 } from "@cortex-eval/contracts/src/case-contracts.ts";
import { CaseAuthoringV1Schema } from "@cortex-eval/contracts/src/case-authoring-contracts.ts";
import { ASSERTION_ISSUES } from "@cortex-eval/contracts/src/assertion-rules/authoring-validation.ts";

const MAX_BYTES = 32 * 1024 * 1024;
/** Local syntax/contract checks only: no server calls and no evaluation of submitted code. */
export function validateCasesText(
  text: string,
  jsonl = false
): { count: number; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  let count = 0;
  const check = (raw: unknown, position: string): void => {
    const value =
      raw !== null &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      !Object.hasOwn(raw, "contractVersion")
        ? { ...raw, contractVersion: CASE_DEFINITION_V1 }
        : raw;
    const result = CaseAuthoringV1Schema.safeParse(value);
    count += 1;
    if (!result.success) {
      const issue = result.error.issues[0];
      const reason =
        issue && Object.hasOwn(ASSERTION_ISSUES, issue.message)
          ? ASSERTION_ISSUES[issue.message as keyof typeof ASSERTION_ISSUES]
          : "字段缺失、类型或结构不符合 Case 契约。";
      errors.push(`${position} · ${issue?.path.length ? issue.path.join(".") : "$"}：${reason}`);
      return;
    }
    const key = result.data.metadata.case_id;
    if (seen.has(key)) errors.push(`${position} · Case ${key}：Case 编号重复。`);
    seen.add(key);
  };
  if (jsonl) {
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        check(JSON.parse(line), `第 ${index + 1} 行`);
      } catch {
        errors.push(`第 ${index + 1} 行：JSON 语法无效。`);
      }
    }
  } else {
    try {
      const data: unknown = JSON.parse(text);
      if (!Array.isArray(data)) errors.push("顶层必须为 Case 数组，不接受额外包装对象。");
      else data.forEach((value, index) => check(value, `第 ${index + 1} 项`));
    } catch {
      errors.push("JSON 语法无效。");
    }
  }
  return { count, errors };
}

async function main(): Promise<void> {
  const filename = process.argv[2];
  if (!filename || process.argv.length !== 3 || !/\.jsonl?$/i.test(filename)) {
    console.error("用法：pnpm cases:validate <cases.json 或 cases.jsonl>");
    process.exitCode = 1;
    return;
  }
  const file = await open(resolve(filename), "r");
  let text: string;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_BYTES)
      throw new Error("文件不是普通文件或超过 32 MiB；请拆分后预检。");
    // Bound reads even if another process grows the file after stat.
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of file.createReadStream({
      autoClose: false
    }) as AsyncIterable<Uint8Array>) {
      const buffer = Buffer.from(chunk);
      length += buffer.length;
      if (length > MAX_BYTES) throw new Error("文件超过 32 MiB；请拆分后预检。");
      chunks.push(buffer);
    }
    text = Buffer.concat(chunks).toString("utf8");
  } finally {
    await file.close();
  }
  const result = validateCasesText(text, /\.jsonl$/i.test(filename));
  if (result.errors.length) {
    console.error(
      `未通过：${result.errors.length} 处问题\n${result.errors.slice(0, 50).join("\n")}`
    );
    if (result.errors.length > 50) console.error("仅展示前 50 处，请修复后重检。");
    process.exitCode = 1;
    return;
  }
  console.log(`本地预检通过：${result.count} 个 Case。`);
  if (result.count === 0) console.log("注意：导入空集合将移除测试集当前所有 Case。");
  console.log(
    "尚未验证服务端 Rubric 引用、执行环境或业务正确性；请在平台查看导入预检并确认替换影响。"
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    console.error("无法读取或校验文件，请检查路径、权限与 32 MiB 大小限制。");
    process.exitCode = 1;
  });
}
