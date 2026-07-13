import seedJson from "../seed/development-seed.json" with { type: "json" };
import { z } from "zod";

import type { CaseDefinitionWriter } from "@cortex-eval/application/src/features/test-suites/case-definition-writer.ts";
import type { TestSuiteService } from "@cortex-eval/application/src/features/test-suites/test-suite-service.ts";
import type { ConfigurationService } from "@cortex-eval/application/src/features/configurations/configuration-service.ts";
import { CaseDefinitionV1Schema } from "@cortex-eval/contracts/src/case-contracts.ts";
import {
  CreateAnalysisPromptRequestV1Schema,
  CreateEndpointConfigRequestV1Schema,
  CreateLlmConfigRequestV1Schema,
  CreateRubricPromptRequestV1Schema
} from "@cortex-eval/contracts/src/resource-api-contracts.ts";

import {
  mapAnalysisPromptDefinitionFromV1,
  mapCaseDefinitionFromV1,
  mapEndpointDefinitionFromV1,
  mapLlmDefinitionFromV1,
  mapPromptDefinitionFromV1
} from "./resource-dto-mappers.ts";

const DevelopmentSeedV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.development-seed.v1"),
  suite: z.strictObject({
    name: z.string().trim().min(1),
    description: z.string(),
    cases: z.array(CaseDefinitionV1Schema)
  }),
  endpointConfigs: z.array(CreateEndpointConfigRequestV1Schema),
  llmConfigs: z.array(CreateLlmConfigRequestV1Schema),
  rubricPrompts: z.array(CreateRubricPromptRequestV1Schema),
  analysisPrompts: z.array(CreateAnalysisPromptRequestV1Schema)
});

const DEVELOPMENT_SEED = DevelopmentSeedV1Schema.parse(seedJson);

/** Services used only by the explicit development Seed flow. */
export interface DevelopmentSeedServices {
  /** Test Suite use cases. */
  readonly testSuites: TestSuiteService;
  /** Shared Case writer. */
  readonly cases: CaseDefinitionWriter;
  /** Configuration use cases. */
  readonly configurations: ConfigurationService;
}

// Throw only a stable internal Seed failure code without resource content.
function seedFailure(): never {
  throw new Error("DEVELOPMENT_SEED_FAILED");
}

/** Insert missing named development resources without updating any existing resource. */
export async function applyDevelopmentSeed(services: DevelopmentSeedServices): Promise<void> {
  const createConfigurations = async (): Promise<void> => {
    const existing = new Set(
      (
        await Promise.all([
          services.configurations.list("ENDPOINT"),
          services.configurations.list("LLM"),
          services.configurations.list("LLM_RUBRIC_PROMPT"),
          services.configurations.list("CASE_ANALYSIS_PROMPT")
        ])
      )
        .flat()
        .map((item) => `${item.kind}:${item.name}`)
    );
    for (const item of DEVELOPMENT_SEED.rubricPrompts) {
      if (existing.has(`LLM_RUBRIC_PROMPT:${item.name}`)) continue;
      const result = await services.configurations.create({
        kind: "LLM_RUBRIC_PROMPT",
        name: item.name,
        definition: mapPromptDefinitionFromV1(item.definition)
      });
      if (!result.ok) seedFailure();
    }
    for (const item of DEVELOPMENT_SEED.endpointConfigs) {
      if (existing.has(`ENDPOINT:${item.name}`)) continue;
      const result = await services.configurations.create({
        kind: "ENDPOINT",
        name: item.name,
        definition: mapEndpointDefinitionFromV1(item.definition)
      });
      if (!result.ok) seedFailure();
    }
    for (const item of DEVELOPMENT_SEED.llmConfigs) {
      if (existing.has(`LLM:${item.name}`)) continue;
      const result = await services.configurations.create({
        kind: "LLM",
        name: item.name,
        definition: mapLlmDefinitionFromV1(item.definition)
      });
      if (!result.ok) seedFailure();
    }
    for (const item of DEVELOPMENT_SEED.analysisPrompts) {
      if (existing.has(`CASE_ANALYSIS_PROMPT:${item.name}`)) continue;
      const result = await services.configurations.create({
        kind: "CASE_ANALYSIS_PROMPT",
        name: item.name,
        definition: mapAnalysisPromptDefinitionFromV1(item.definition)
      });
      if (!result.ok) seedFailure();
    }
  };

  await createConfigurations();
  const existingSuite = (await services.testSuites.list()).find(
    (item) => item.name === DEVELOPMENT_SEED.suite.name
  );
  if (existingSuite !== undefined) return;
  const created = await services.testSuites.create({
    name: DEVELOPMENT_SEED.suite.name,
    description: DEVELOPMENT_SEED.suite.description
  });
  if (!created.ok) seedFailure();
  const imported = await services.cases.replaceAllCases({
    suiteId: created.suite.id,
    expectedSuiteRevision: created.suite.revision,
    definitions: DEVELOPMENT_SEED.suite.cases.map(mapCaseDefinitionFromV1)
  });
  if (!imported.ok) seedFailure();
}
