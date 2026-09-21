import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { dump as dumpYaml } from "js-yaml";
import { buildFromMarkdown } from "../../packages/authoring/src/builder.ts";
import { loadAuthoringRegistry } from "../../packages/authoring/src/registry.ts";

interface Options {
  readonly source: string;
  readonly profile: string;
  readonly registry: string;
  readonly output: string;
  readonly allowBlocked: boolean;
}

function option(args: readonly string[], name: string, fallback?: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value.startsWith("--")) {
    if (fallback !== undefined) return fallback;
    throw new Error(`缺少参数：${name}`);
  }
  return value;
}

function parseArgs(args: readonly string[]): Options {
  return {
    source: option(args, "--source"),
    profile: option(args, "--profile"),
    registry: option(args, "--registry", "authoring"),
    output: option(args, "--output", "."),
    allowBlocked: args.includes("--allow-blocked")
  };
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

const root = resolve(process.cwd());
const options = parseArgs(process.argv.slice(2));
const sourcePath = resolve(root, options.source);
const registryPath = resolve(root, options.registry);
const outputPath = resolve(root, options.output);
const sourceBasename = sourcePath.split(/[\\/]/u).at(-1);
if (sourceBasename === undefined) throw new Error("AUTHORING_SOURCE_PATH_INVALID");
const sourceId = sourceBasename.replace(/\.md$/u, "");
const result = await buildFromMarkdown({
  sourcePath,
  profileId: options.profile,
  registry: await loadAuthoringRegistry(registryPath)
});
const specDir = resolve(outputPath, "evaluation_specs", sourceId);
const generatedDir = resolve(outputPath, "generated", sourceId);
await writeText(resolve(specDir, "spec.ir.yaml"), dumpYaml(result.ir));
await writeText(resolve(specDir, "readiness.yaml"), dumpYaml(result.readiness));
await writeText(resolve(specDir, "manifest.yaml"), dumpYaml(result.manifest));
await writeText(resolve(specDir, "bindings.yaml"), dumpYaml(result.readiness.resolved));
if (result.cases.length > 0) {
  await writeText(
    resolve(generatedDir, "cases.jsonl"),
    `${result.cases.map((item) => JSON.stringify(item)).join("\n")}\n`
  );
}
console.log(
  JSON.stringify(
    {
      status: result.readiness.status,
      source: options.source,
      profile: options.profile,
      cases: result.cases.length,
      issues: result.readiness.issues
    },
    null,
    2
  )
);
if (result.readiness.status === "BLOCKED" && !options.allowBlocked) process.exitCode = 2;
