import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { load as loadYaml } from "js-yaml";
import {
  A2uiComponentSchema,
  AssertionTemplateSchema,
  AuthoringProfileSchema,
  CapabilitySchema,
  FixtureSchema,
  ToolBindingSchema,
  type A2uiComponent,
  type AssertionTemplate,
  type AuthoringProfile,
  type Capability,
  type Fixture,
  type ToolBinding
} from "./contracts.ts";

async function loadDocuments<T>(
  directory: string,
  schema: { parse(value: unknown): T }
): Promise<T[]> {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && [".yaml", ".yml", ".json"].includes(extname(entry.name)))
    .map((entry) => entry.name)
    .sort();
  const documents: T[] = [];
  for (const file of files) {
    const raw = loadYaml(await readFile(join(directory, file), "utf8"));
    for (const item of Array.isArray(raw) ? raw : [raw]) documents.push(schema.parse(item));
  }
  return documents;
}

export interface AuthoringRegistry {
  readonly profiles: readonly AuthoringProfile[];
  readonly capabilities: readonly Capability[];
  readonly tools: readonly ToolBinding[];
  readonly a2ui: readonly A2uiComponent[];
  readonly assertions: readonly AssertionTemplate[];
  readonly fixtures: readonly Fixture[];
}

export async function loadAuthoringRegistry(root: string): Promise<AuthoringRegistry> {
  const [profiles, capabilities, tools, a2ui, assertions, fixtures] = await Promise.all([
    loadDocuments(join(root, "profiles"), AuthoringProfileSchema),
    loadDocuments(join(root, "capabilities"), CapabilitySchema),
    loadDocuments(join(root, "tools"), ToolBindingSchema),
    loadDocuments(join(root, "a2ui"), A2uiComponentSchema),
    loadDocuments(join(root, "assertions"), AssertionTemplateSchema),
    loadDocuments(join(root, "fixtures"), FixtureSchema)
  ]);
  return { profiles, capabilities, tools, a2ui, assertions, fixtures };
}
