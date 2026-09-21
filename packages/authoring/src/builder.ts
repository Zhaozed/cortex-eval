import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  agentExecutionAssertion,
  agentReplyAssertion
} from "@cortex-eval/contracts/src/assertion-rules/agent-rules.ts";
import {
  CASE_DEFINITION_V1,
  CaseDefinitionV1Schema
} from "@cortex-eval/contracts/src/case-contracts.ts";
import { parseMarkdownSource } from "./source-parser.ts";
import type { BuildOutput, CaseSpecIr, ReadinessIssue, ReadinessReport } from "./contracts.ts";
import type { AuthoringRegistry } from "./registry.ts";

function issue(code: ReadinessIssue["code"], message: string, path?: string): ReadinessIssue {
  return { code, message, blocking: true, ...(path === undefined ? {} : { path }) };
}

function caseId(template: string, sourceId: string, branch: string): string {
  return template
    .replaceAll("{{source_id}}", sourceId)
    .replaceAll("{{branch}}", branch)
    .replaceAll("{{id}}", `${sourceId}-${branch}`);
}

function sourceId(sourcePath: string): string {
  return basename(sourcePath)
    .replace(/\.md$/u, "")
    .replace(/[^A-Za-z0-9_-]+/gu, "-");
}

function domainFromSource(sourcePath: string): string {
  const parts = sourcePath.split(/[\\/]/u);
  return parts.at(-2) ?? "unknown";
}

function meaningfulSection(content: string | undefined): boolean {
  if (content === undefined) return false;
  const normalized = content
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/^[|\-: ]+$/gmu, "")
    .replace(/^[*-]\s*$/gmu, "")
    .trim();
  return normalized.length > 0;
}

function assertionTemplates(
  registry: AuthoringRegistry,
  profile: AuthoringRegistry["profiles"][number]
): AuthoringRegistry["assertions"] {
  return profile.required_assertion_templates
    .map((id) => registry.assertions.find((item) => item.id === id))
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
}

export async function buildFromMarkdown(input: {
  readonly sourcePath: string;
  readonly profileId: string;
  readonly registry: AuthoringRegistry;
}): Promise<BuildOutput> {
  const markdown = await readFile(input.sourcePath, "utf8");
  const source = parseMarkdownSource(input.sourcePath, markdown);
  const profile = input.registry.profiles.find((item) => item.id === input.profileId);
  if (!profile) throw new Error(`AUTHORING_PROFILE_NOT_FOUND:${input.profileId}`);

  const id = sourceId(input.sourcePath);
  const capabilities = [
    ...new Set([...profile.required_capabilities, ...source.detectedCapabilities])
  ];
  const resolvedCapabilities = capabilities
    .map((capabilityId) => input.registry.capabilities.find((item) => item.id === capabilityId))
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
  const capabilityBindings = resolvedCapabilities
    .map((capability) => {
      const tool = input.registry.tools.find((candidate) => candidate.id === capability.tool_id);
      return tool === undefined
        ? null
        : { capability: capability.id, tool: tool.id, runtimeName: tool.runtime_name };
    })
    .filter(
      (binding): binding is { capability: string; tool: string; runtimeName: string } =>
        binding !== null
    );
  const runtimeTools = capabilityBindings.map((binding) => binding.runtimeName);
  const resolvedA2ui = source.detectedA2ui
    .map((component) =>
      input.registry.a2ui.find(
        (item) => item.runtime_component === component || item.id === component
      )
    )
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
  const templates = assertionTemplates(input.registry, profile);
  const fixtures = source.branches
    .map((branch) =>
      input.registry.fixtures.find((item) => item.branch === branch && item.status === "available")
    )
    .filter((item): item is NonNullable<typeof item> => item !== undefined);

  const issues: ReadinessIssue[] = [];
  for (const required of profile.required_sections) {
    const section = Object.entries(source.sections).find(([name]) => name.includes(required));
    if (section === undefined) {
      issues.push(issue("SOURCE_SECTION_MISSING", `业务规范缺少必填章节：${required}`, required));
    } else if (!meaningfulSection(section[1])) {
      issues.push(
        issue("SOURCE_SECTION_EMPTY", `业务规范章节没有填写有效内容：${required}`, required)
      );
    }
  }
  if (!source.userInput)
    issues.push(issue("USER_INPUT_MISSING", "未能从“用户的话”章节提取用户输入"));
  if (
    profile.required_sections.some((section) => section.includes("分支矩阵")) &&
    source.branches.length === 0
  )
    issues.push(issue("BRANCHES_MISSING", "分支矩阵中未识别到可覆盖的业务情况", "分支矩阵"));
  for (const capabilityId of capabilities) {
    const capability = input.registry.capabilities.find((item) => item.id === capabilityId);
    if (capability === undefined) {
      issues.push(issue("CAPABILITY_UNRESOLVED", `语义能力未注册：${capabilityId}`, capabilityId));
    } else if (!input.registry.tools.some((tool) => tool.id === capability.tool_id)) {
      issues.push(
        issue(
          "TOOL_UNRESOLVED",
          `语义能力没有可用的工具绑定：${capabilityId} -> ${capability.tool_id}`,
          capability.tool_id
        )
      );
    }
  }
  for (const tool of source.detectedTools.filter(
    (value) => value.includes("search") || value.includes("get_")
  )) {
    if (!runtimeTools.includes(tool))
      issues.push(issue("TOOL_UNRESOLVED", `文档中的运行时工具无法绑定到 Registry：${tool}`, tool));
  }
  for (const component of source.detectedA2ui) {
    if (!resolvedA2ui.some((item) => item.runtime_component === component || item.id === component))
      issues.push(issue("A2UI_UNRESOLVED", `A2UI 组件未注册：${component}`, component));
  }
  for (const required of profile.required_assertion_templates) {
    if (!input.registry.assertions.some((item) => item.id === required))
      issues.push(issue("ASSERTION_TEMPLATE_MISSING", `断言模板未注册：${required}`, required));
  }
  if (profile.require_fixtures) {
    for (const branch of source.branches) {
      if (!fixtures.some((fixture) => fixture.branch === branch))
        issues.push(issue("FIXTURE_MISSING", `分支缺少可用 Fixture：${branch}`, branch));
    }
  }
  if (profile.require_evidence && !source.requiresEvidence)
    issues.push(issue("EVIDENCE_UNAVAILABLE", "规范未声明可采集的验收证据"));

  const ir: CaseSpecIr = {
    id,
    title: source.title,
    sourcePath: input.sourcePath,
    profile: { id: profile.id, version: profile.version },
    domain: domainFromSource(input.sourcePath),
    userInput: source.userInput,
    capabilities,
    branches: source.branches,
    branchMatrix: source.branchMatrix,
    detectedTools: source.detectedTools,
    detectedA2ui: source.detectedA2ui,
    constraints: { readOnly: source.readOnlyExpectation, requiresEvidence: source.requiresEvidence }
  };
  const readiness: ReadinessReport = {
    status: issues.length === 0 ? "READY" : "BLOCKED",
    sourcePath: input.sourcePath,
    profile: `${profile.id}@${profile.version}`,
    issues,
    resolved: {
      capabilities: resolvedCapabilities.map((item) => `${item.id}@${item.version}`),
      capabilityBindings,
      runtimeTools,
      a2ui: resolvedA2ui.map((item) => `${item.id}@${item.version}`),
      fixtures: fixtures.map((item) => `${item.id}@${item.version}`),
      assertionTemplates: templates.map((item) => `${item.id}@${item.version}`)
    }
  };

  const userInput = source.userInput;
  let cases: readonly Record<string, unknown>[] = [];
  if (readiness.status === "READY" && userInput !== null) {
    const generated = source.branches.map((branch) =>
      makeCase({ ir, profile, branch, userInput, runtimeTools })
    );
    const generatedIds = generated.map((item) => (item.metadata as { case_id: string }).case_id);
    if (
      new Set(generatedIds).size !== generatedIds.length ||
      generated.length !== source.branches.length
    ) {
      issues.push(issue("GENERATED_CASE_INVALID", "生成的 Case 数量或 ID 与分支不一致"));
    }
    for (const candidate of generated) {
      try {
        CaseDefinitionV1Schema.parse(candidate);
      } catch (error) {
        issues.push(
          issue(
            "GENERATED_CASE_INVALID",
            `生成的 Case 不符合当前 Case 契约：${error instanceof Error ? error.message : String(error)}`
          )
        );
        break;
      }
    }
    if (issues.length === 0) cases = generated;
  }
  const finalReadiness: ReadinessReport =
    issues.length === 0 ? readiness : { ...readiness, status: "BLOCKED", issues };
  return {
    ir,
    readiness: finalReadiness,
    cases,
    manifest: {
      generator: "@cortex-eval/authoring@0.1.0",
      profile: `${profile.id}@${profile.version}`,
      sourcePath: input.sourcePath,
      readiness: finalReadiness.status,
      caseIds: cases.map((item) => (item.metadata as { case_id: string }).case_id)
    }
  };
}

function makeCase(input: {
  readonly ir: CaseSpecIr;
  readonly profile: AuthoringRegistry["profiles"][number];
  readonly branch: string;
  readonly userInput: string;
  readonly runtimeTools: readonly string[];
}): Record<string, unknown> {
  const caseKey = caseId(input.profile.case_id_template, input.ir.id, input.branch);
  const execution = input.runtimeTools.map((tool) => ({
    tool,
    args: {},
    outcome: "success" as const
  }));
  const assertion =
    input.runtimeTools.length > 0
      ? agentExecutionAssertion(execution)
      : agentReplyAssertion({ type: "NOTICE", delivered: false });
  return {
    contractVersion: CASE_DEFINITION_V1,
    description: `${input.ir.title}｜${input.branch}`,
    threshold: input.profile.default_threshold,
    vars: {
      task: input.userInput,
      request_body: {
        lang: "zh-Hans",
        timezone: "Asia/Shanghai",
        conversation: [{ role: "user", text: input.userInput }]
      }
    },
    metadata: {
      case_id: caseKey,
      req_id: `${input.ir.id}-${input.branch}`,
      task_id: `${input.ir.id}-${input.branch}`,
      business_module: input.ir.domain,
      scenario_tag: `${input.ir.id}-${input.branch}`,
      a2ui_capture: input.profile.a2ui_capture
    },
    assert: [assertion]
  };
}

export function resolvePath(root: string, path: string): string {
  return resolve(root, path);
}
