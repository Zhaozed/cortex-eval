import { basename } from "node:path";
import type { ParsedSource } from "./contracts.ts";

const CAPABILITY_PATTERNS: readonly [string, RegExp][] = [
  ["document.search", /搜索(?:飞书)?文档|search_docs|文档候选|搜索结果/u],
  ["document.read", /读取(?:选中)?文档|读取文档正文|feishu_get_doc|文档正文/u],
  ["user.profile.lookup", /用户资料|所有者|owner|feishu_get_user_profile/u]
];

const TOOL_PATTERN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi;
const A2UI_PATTERN = /\b(?:list_simple|markdown_title_body|tool_start|tool_fail)\b/g;
const BRANCH_PATTERNS: readonly [string, RegExp][] = [
  ["unique-match", /唯一命中|唯一候选|只找到一篇|仅找到一篇|一个符合/u],
  ["duplicate-match", /多个候选|同名|多项命中|交用户选择|多篇符合|多篇相似/u],
  ["empty-result", /空结果|未找到|成功空结果|搜索不到|没有找到/u],
  ["permission-failure", /权限失败|权限错误|没有权限|无权限/u]
];

function sectionKey(raw: string): string {
  return raw
    .replace(/^\d+[.、)\s]+/u, "")
    .replace(/[：:]/gu, "")
    .trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function parseMarkdownSource(sourcePath: string, markdown: string): ParsedSource {
  const sections: Record<string, string[]> = {};
  let current = "__document__";
  sections[current] = [];
  let title = basename(sourcePath, ".md");

  for (const line of markdown.split(/\r?\n/u)) {
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line.trim());
    if (heading) {
      const headingText = heading[2];
      const headingLevel = heading[1];
      if (headingText === undefined || headingLevel === undefined) continue;
      const normalizedHeading = headingText.trim();
      if (headingLevel.length === 1) title = normalizedHeading;
      current = sectionKey(normalizedHeading);
      sections[current] ??= [];
      continue;
    }
    const section = sections[current];
    if (section !== undefined) section.push(line);
  }

  const text = markdown;
  const sectionText = (pattern: RegExp): string =>
    Object.entries(sections)
      .find(([key]) => pattern.test(key))?.[1]
      ?.join("\n") ?? "";
  const branchMatrix = sectionText(/分支矩阵/u);
  const userSection =
    Object.entries(sections)
      .find(([key]) => /用户的话|用户输入/u.test(key))?.[1]
      ?.join("\n") ?? "";
  const quoted = /[“"]([^”"]+)[”"]/u.exec(userSection)?.[1] ?? null;
  const capabilities = unique(
    CAPABILITY_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([id]) => id)
  );
  const detectedTools = unique(
    (text.match(TOOL_PATTERN) ?? []).filter((value) => value.length > 5)
  );
  const detectedA2ui = unique(text.match(A2UI_PATTERN) ?? []);
  const branchSource = branchMatrix;
  const branches = unique(
    BRANCH_PATTERNS.filter(([, pattern]) => pattern.test(branchSource)).map(([id]) => id)
  );
  const readOnlyExpectation = /不修改|不得修改|只读|禁止写入/u.test(text);
  const requiresEvidence = /验收|证据|真实调用|tool_fail|工具失败/u.test(text);

  return {
    sourcePath,
    title,
    sections: Object.fromEntries(
      Object.entries(sections).map(([key, lines]) => [key, lines.join("\n").trim()])
    ),
    userInput: quoted,
    detectedCapabilities: capabilities,
    detectedTools,
    detectedA2ui,
    branches,
    branchMatrix,
    readOnlyExpectation,
    requiresEvidence
  };
}
