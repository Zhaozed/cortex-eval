import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CaseDefinitionV1Schema } from "@cortex-eval/contracts/src/case-contracts.ts";
import { buildFromMarkdown } from "../src/builder.ts";
import { loadAuthoringRegistry } from "../src/registry.ts";

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cortex-authoring-"));
  for (const dir of ["profiles", "capabilities", "tools", "a2ui", "assertions", "fixtures"])
    await mkdir(join(root, dir));
  await writeFile(
    join(root, "profiles", "dev.yaml"),
    `id: dev-validation\nversion: 1.0.0\ndescription: dev\ncase_id_template: "{{id}}"\nrequired_sections: ["背景与目标", "用户的话"]\nrequired_capabilities: [document.search]\nrequired_assertion_templates: [agent-executions]\nrequire_fixtures: false\nrequire_evidence: true\na2ui_capture: false\n`
  );
  await writeFile(
    join(root, "capabilities", "document.yaml"),
    `id: document.search\nversion: 1.0.0\ndomain: feishu\ndescription: search\ntool_id: feishu.search_docs\nevidence_paths: [parsed_output.tool_executions]\nread_only: true\n`
  );
  await writeFile(
    join(root, "tools", "feishu.yaml"),
    `id: feishu.search_docs\nversion: 1.0.0\nruntime_name: search_docs\ndescription: search documents\n`
  );
  await writeFile(join(root, "a2ui", "empty.yaml"), "[]\n");
  await writeFile(
    join(root, "assertions", "agent.yaml"),
    `id: agent-executions\nversion: 1.0.0\ntype: agent-executions\ndescription: executions\nblocking: true\n`
  );
  await writeFile(join(root, "fixtures", "empty.yaml"), "[]\n");
  return root;
}

describe("authoring builder", () => {
  it("parses a source and creates a blocked readiness report when runtime names are unresolved", async () => {
    const root = await fixtureRoot();
    const source = join(root, "D01.md");
    await writeFile(
      source,
      `# D01 搜索文档\n\n## 1. 背景与目标\n搜索文档。\n\n## 3. 用户的话\n“帮我搜索文档”\n\n## 4. Agent 期望链路\n调用 unknown_search_docs。`
    );
    const output = await buildFromMarkdown({
      sourcePath: source,
      profileId: "dev-validation",
      registry: await loadAuthoringRegistry(root)
    });
    expect(output.ir.capabilities).toContain("document.search");
    expect(output.readiness.status).toBe("BLOCKED");
    expect(output.readiness.issues.map((item) => item.code)).toContain("TOOL_UNRESOLVED");
    expect(output.cases).toHaveLength(0);
  });
  it("emits executable cases only after registry binding is complete", async () => {
    const root = await fixtureRoot();
    const source = join(root, "D02.md");
    await writeFile(
      source,
      `# D02 搜索文档\n\n## 1. 背景与目标\n搜索文档。\n\n## 3. 用户的话\n“帮我搜索文档”\n\n## 4. 分支矩阵\n唯一命中。\n\n## 5. Agent 期望链路\n调用 search_docs。\n\n## 6. 验收关注点\n检查真实调用证据。`
    );
    const output = await buildFromMarkdown({
      sourcePath: source,
      profileId: "dev-validation",
      registry: await loadAuthoringRegistry(root)
    });
    expect(output.readiness.status).toBe("READY");
    expect(output.cases).toHaveLength(1);
    expect(() => CaseDefinitionV1Schema.parse(output.cases[0])).not.toThrow();
  });
});
