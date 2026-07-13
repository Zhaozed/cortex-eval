import {
  AnalysisPromptPreviewV1Schema,
  CaseDetailV1Schema,
  CaseExportV1Schema,
  CaseImportSuccessV1Schema,
  CaseMutationV1Schema,
  CasePageV1Schema,
  ConfigurationPageV1Schema,
  ConfigurationProbeSuccessV1Schema,
  ConfigurationResourceV1Schema,
  type CreateCaseRequestV1Schema,
  RubricPromptPreviewV1Schema,
  RubricPromptReferencesV1Schema,
  TestSuiteDetailV1Schema,
  TestSuiteImpactV1Schema,
  TestSuitePageV1Schema,
  type AnalysisPromptDefinitionV1Schema,
  type PromptDefinitionV1Schema,
  type UpdateCaseRequestV1Schema
} from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import type {
  EndpointConfigV1Schema,
  LlmConfigV1Schema
} from "@cortex-eval/contracts/src/provider-contracts.ts";
import type { QueryClient, QueryFunction, UseQueryOptions } from "@tanstack/react-query";
import type { z } from "zod";

import { apiRequestEmpty, apiRequestJson, buildApiSearch } from "./api-client.ts";

/** Current Configuration families exposed by the P3 Local API. */
export type ConfigurationKind = "ENDPOINT" | "LLM" | "LLM_RUBRIC_PROMPT" | "CASE_ANALYSIS_PROMPT";

/** Endpoint definition accepted by the resource client. */
export type EndpointDefinition = z.infer<typeof EndpointConfigV1Schema>;
/** LLM definition accepted by the resource client. */
export type LlmDefinition = z.infer<typeof LlmConfigV1Schema>;
/** Rubric Prompt definition accepted by the resource client. */
export type RubricPromptDefinition = z.infer<typeof PromptDefinitionV1Schema>;
/** Analysis Prompt definition accepted by the resource client. */
export type AnalysisPromptDefinition = z.infer<typeof AnalysisPromptDefinitionV1Schema>;

/** Definition selected by one Configuration discriminator. */
export type ConfigurationDefinition<Kind extends ConfigurationKind> = Kind extends "ENDPOINT"
  ? EndpointDefinition
  : Kind extends "LLM"
    ? LlmDefinition
    : Kind extends "LLM_RUBRIC_PROMPT"
      ? RubricPromptDefinition
      : AnalysisPromptDefinition;

type TestSuitePage = z.infer<typeof TestSuitePageV1Schema>;
/** One boundary-validated Test Suite detail from the Local API. */
export type TestSuiteDetail = z.infer<typeof TestSuiteDetailV1Schema>;
type TestSuiteImpact = z.infer<typeof TestSuiteImpactV1Schema>;
type CasePage = z.infer<typeof CasePageV1Schema>;
/** One boundary-validated Case detail from the Local API. */
export type CaseDetail = z.infer<typeof CaseDetailV1Schema>;
/** Contracts-valid payload for creating one Case. */
type CreateCaseRequest = z.infer<typeof CreateCaseRequestV1Schema>;
/** Contracts-valid payload for replacing one Case. */
type UpdateCaseRequest = z.infer<typeof UpdateCaseRequestV1Schema>;
type CaseMutation = z.infer<typeof CaseMutationV1Schema>;
type CaseImportSuccess = z.infer<typeof CaseImportSuccessV1Schema>;
type CaseExport = z.infer<typeof CaseExportV1Schema>;
type ConfigurationPage = z.infer<typeof ConfigurationPageV1Schema>;
/** One boundary-validated Configuration resource from the Local API. */
export type ConfigurationResource = z.infer<typeof ConfigurationResourceV1Schema>;
type ConfigurationProbeSuccess = z.infer<typeof ConfigurationProbeSuccessV1Schema>;
type RubricPromptReferences = z.infer<typeof RubricPromptReferencesV1Schema>;
type RubricPromptPreview = z.infer<typeof RubricPromptPreviewV1Schema>;
type AnalysisPromptPreview = z.infer<typeof AnalysisPromptPreviewV1Schema>;

/** Cursor arguments shared by small resource lists. */
export interface ResourcePageInput {
  /** Requested server page size. */
  readonly limit: number;
  /** Current opaque cursor. */
  readonly cursor: string | null;
}

/** Case search and filter arguments mapped to the Local API. */
export interface CasePageInput extends ResourcePageInput {
  /** Case Key literal substring. */
  readonly caseKey: string;
  /** Description literal substring. */
  readonly description: string;
  /** Business modules with OR semantics. */
  readonly businessModules: readonly string[];
  /** Scenario tags with OR semantics. */
  readonly scenarioTags: readonly string[];
  /** Assertion types with OR semantics. */
  readonly assertionTypes: readonly string[];
  /** Metric names with OR semantics. */
  readonly metrics: readonly string[];
}

/** Boundary-validating operations exposed to the current Web features. */
export interface ResourceApi {
  /** List one cursor page of Test Suites. */
  readonly listTestSuites: (
    input: ResourcePageInput,
    signal: AbortSignal
  ) => Promise<TestSuitePage>;
  /** Create one empty Test Suite. */
  readonly createTestSuite: (
    input: { readonly name: string; readonly description: string },
    signal: AbortSignal
  ) => Promise<TestSuiteDetail>;
  /** Read one current Test Suite. */
  readonly getTestSuite: (suiteId: string, signal: AbortSignal) => Promise<TestSuiteDetail>;
  /** Conditionally update Test Suite metadata. */
  readonly updateTestSuite: (
    suiteId: string,
    input: {
      readonly name: string;
      readonly description: string;
      readonly expectedRevision: number;
    },
    signal: AbortSignal
  ) => Promise<TestSuiteDetail>;
  /** Read Test Suite deletion impact. */
  readonly getTestSuiteImpact: (suiteId: string, signal: AbortSignal) => Promise<TestSuiteImpact>;
  /** Conditionally delete one Test Suite. */
  readonly deleteTestSuite: (
    suiteId: string,
    expectedRevision: number,
    signal: AbortSignal
  ) => Promise<void>;
  /** List one filtered cursor page of Cases. */
  readonly listCases: (
    suiteId: string,
    input: CasePageInput,
    signal: AbortSignal
  ) => Promise<CasePage>;
  /** Read one current Case. */
  readonly getCase: (suiteId: string, caseKey: string, signal: AbortSignal) => Promise<CaseDetail>;
  /** Create one current Case. */
  readonly createCase: (
    suiteId: string,
    input: CreateCaseRequest,
    signal: AbortSignal
  ) => Promise<CaseMutation>;
  /** Conditionally replace one Case. */
  readonly updateCase: (
    suiteId: string,
    caseKey: string,
    input: UpdateCaseRequest,
    signal: AbortSignal
  ) => Promise<CaseMutation>;
  /** Copy one Case under a new key. */
  readonly copyCase: (
    suiteId: string,
    caseKey: string,
    input: { readonly expectedSuiteRevision: number; readonly newCaseKey: string },
    signal: AbortSignal
  ) => Promise<CaseMutation>;
  /** Conditionally delete one Case. */
  readonly deleteCase: (
    suiteId: string,
    caseKey: string,
    expectedSuiteRevision: number,
    expectedCaseRevision: number,
    signal: AbortSignal
  ) => Promise<void>;
  /** Atomically import one bounded Case array. */
  readonly importCases: (
    suiteId: string,
    expectedRevision: number,
    file: File,
    signal: AbortSignal
  ) => Promise<CaseImportSuccess>;
  /** Export one Revision-consistent Case array. */
  readonly exportCases: (suiteId: string, signal: AbortSignal) => Promise<CaseExport>;
  /** List one cursor page of a Configuration family. */
  readonly listConfigurations: (
    kind: ConfigurationKind,
    input: ResourcePageInput,
    signal: AbortSignal
  ) => Promise<ConfigurationPage>;
  /** Read one current Configuration. */
  readonly getConfiguration: (
    kind: ConfigurationKind,
    id: string,
    signal: AbortSignal
  ) => Promise<ConfigurationResource>;
  /** Create one typed Configuration. */
  readonly createConfiguration: <Kind extends ConfigurationKind>(
    kind: Kind,
    input: { readonly name: string; readonly definition: ConfigurationDefinition<Kind> },
    signal: AbortSignal
  ) => Promise<ConfigurationResource>;
  /** Conditionally update one typed Configuration. */
  readonly updateConfiguration: <Kind extends ConfigurationKind>(
    kind: Kind,
    id: string,
    input: {
      readonly name: string;
      readonly definition: ConfigurationDefinition<Kind>;
      readonly expectedRevision: number;
    },
    signal: AbortSignal
  ) => Promise<ConfigurationResource>;
  /** Conditionally delete one Configuration. */
  readonly deleteConfiguration: (
    kind: ConfigurationKind,
    id: string,
    revision: number,
    signal: AbortSignal
  ) => Promise<void>;
  /** Validate one unsaved Endpoint definition. */
  readonly validateEndpoint: (
    definition: EndpointDefinition,
    signal: AbortSignal
  ) => Promise<ConfigurationProbeSuccess>;
  /** Validate one unsaved LLM definition. */
  readonly validateLlm: (
    definition: LlmDefinition,
    signal: AbortSignal
  ) => Promise<ConfigurationProbeSuccess>;
  /** List current Case references to one Rubric Prompt. */
  readonly listRubricPromptReferences: (
    id: string,
    signal: AbortSignal
  ) => Promise<RubricPromptReferences>;
  /** Preview rendered Rubric Prompt messages. */
  readonly previewRubricPrompt: (
    definition: RubricPromptDefinition,
    signal: AbortSignal
  ) => Promise<RubricPromptPreview>;
  /** Preview Analysis Prompt variables. */
  readonly previewAnalysisPrompt: (
    definition: AnalysisPromptDefinition,
    signal: AbortSignal
  ) => Promise<AnalysisPromptPreview>;
}

type TestSuitePageQueryKey = readonly ["test-suites", "list", ResourcePageInput];

/** Fully executable Test Suite query options. */
export interface TestSuitePageQueryOptions extends UseQueryOptions<
  TestSuitePage,
  Error,
  TestSuitePage,
  TestSuitePageQueryKey
> {
  /** Stable list query identity. */
  readonly queryKey: TestSuitePageQueryKey;
  /** Abort-aware query function required by every caller. */
  readonly queryFn: QueryFunction<TestSuitePage, TestSuitePageQueryKey>;
}

const CONFIGURATION_PATHS: Readonly<Record<ConfigurationKind, string>> = {
  ENDPOINT: "endpoint-configs",
  LLM: "llm-configs",
  LLM_RUBRIC_PROMPT: "llm-rubric-prompts",
  CASE_ANALYSIS_PROMPT: "case-analysis-prompts"
};

// Encode one untrusted path segment as data, never route syntax.
function segment(value: string): string {
  return encodeURIComponent(value);
}

// Build one JSON request with explicit same-origin content type.
function jsonRequest(method: "POST" | "PUT", body: unknown, signal: AbortSignal): RequestInit {
  return {
    method,
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

// Add deterministic query parameters only when a value is present.
function withSearch(path: string, values: Parameters<typeof buildApiSearch>[0]): string {
  const search = buildApiSearch(values).toString();
  return search.length === 0 ? path : `${path}?${search}`;
}

// Bind one Suite response to the identity fixed by its request path.
function matchesTestSuiteIdentity(suite: TestSuiteDetail, suiteId: string): boolean {
  return suite.id === suiteId;
}

// Bind one complete Case response to its Suite, key and embedded Definition identity.
function matchesCaseIdentity(resource: CaseDetail, suiteId: string, caseKey: string): boolean {
  return (
    resource.suiteId === suiteId &&
    resource.caseKey === caseKey &&
    resource.definition.metadata.case_id === caseKey
  );
}

// Bind both resources returned by a Case mutation to the requested aggregate identity.
function matchesCaseMutationIdentity(
  mutation: CaseMutation,
  suiteId: string,
  caseKey: string
): boolean {
  return (
    matchesTestSuiteIdentity(mutation.suite, suiteId) &&
    matchesCaseIdentity(mutation.case, suiteId, caseKey)
  );
}

// Bind one Configuration response to the requested family and optional stable ID.
function matchesConfigurationIdentity(
  resource: ConfigurationResource,
  kind: ConfigurationKind,
  id: string | null
): boolean {
  return resource.kind === kind && (id === null || resource.id === id);
}

/** Create a Contracts-validating same-origin resource API. */
export function createResourceApi(fetcher: typeof fetch = fetch): ResourceApi {
  return {
    // List one cursor page of current Test Suites.
    listTestSuites(input: ResourcePageInput, signal: AbortSignal): Promise<TestSuitePage> {
      return apiRequestJson(
        withSearch("/api/v1/test-suites", {
          limit: input.limit,
          cursor: input.cursor
        }),
        TestSuitePageV1Schema,
        { signal },
        fetcher
      );
    },
    // Create one empty current Test Suite.
    createTestSuite(
      input: { readonly name: string; readonly description: string },
      signal: AbortSignal
    ): Promise<TestSuiteDetail> {
      return apiRequestJson(
        "/api/v1/test-suites",
        TestSuiteDetailV1Schema,
        jsonRequest("POST", input, signal),
        fetcher
      );
    },
    // Read one current Test Suite detail.
    getTestSuite(suiteId: string, signal: AbortSignal): Promise<TestSuiteDetail> {
      return apiRequestJson(
        `/api/v1/test-suites/${segment(suiteId)}`,
        TestSuiteDetailV1Schema,
        { signal },
        fetcher,
        (detail) => matchesTestSuiteIdentity(detail, suiteId)
      );
    },
    // Conditionally update one current Test Suite.
    updateTestSuite(
      suiteId: string,
      input: {
        readonly name: string;
        readonly description: string;
        readonly expectedRevision: number;
      },
      signal: AbortSignal
    ): Promise<TestSuiteDetail> {
      return apiRequestJson(
        `/api/v1/test-suites/${segment(suiteId)}`,
        TestSuiteDetailV1Schema,
        jsonRequest("PUT", input, signal),
        fetcher,
        (detail) => matchesTestSuiteIdentity(detail, suiteId)
      );
    },
    // Read deletion impact before confirmation.
    getTestSuiteImpact(suiteId: string, signal: AbortSignal): Promise<TestSuiteImpact> {
      return apiRequestJson(
        `/api/v1/test-suites/${segment(suiteId)}/impact`,
        TestSuiteImpactV1Schema,
        { signal },
        fetcher
      );
    },
    // Conditionally delete one current Test Suite.
    deleteTestSuite(suiteId: string, expectedRevision: number, signal: AbortSignal): Promise<void> {
      return apiRequestEmpty(
        withSearch(`/api/v1/test-suites/${segment(suiteId)}`, { expectedRevision }),
        { method: "DELETE", signal },
        fetcher
      );
    },
    // List one server-filtered cursor page of Cases.
    listCases(suiteId: string, input: CasePageInput, signal: AbortSignal): Promise<CasePage> {
      return apiRequestJson(
        withSearch(`/api/v1/test-suites/${segment(suiteId)}/cases`, {
          limit: input.limit,
          cursor: input.cursor,
          caseKey: input.caseKey,
          description: input.description,
          businessModule: input.businessModules,
          scenarioTag: input.scenarioTags,
          assertionType: input.assertionTypes,
          metric: input.metrics
        }),
        CasePageV1Schema,
        { signal },
        fetcher,
        (page) => page.items.every((item) => item.suiteId === suiteId)
      );
    },
    // Read one complete current Case.
    getCase(suiteId: string, caseKey: string, signal: AbortSignal): Promise<CaseDetail> {
      return apiRequestJson(
        `/api/v1/test-suites/${segment(suiteId)}/cases/${segment(caseKey)}`,
        CaseDetailV1Schema,
        { signal },
        fetcher,
        (detail) => matchesCaseIdentity(detail, suiteId, caseKey)
      );
    },
    // Create one current Case through the shared writer.
    createCase(
      suiteId: string,
      input: CreateCaseRequest,
      signal: AbortSignal
    ): Promise<CaseMutation> {
      return apiRequestJson(
        `/api/v1/test-suites/${segment(suiteId)}/cases`,
        CaseMutationV1Schema,
        jsonRequest("POST", input, signal),
        fetcher,
        (mutation) =>
          matchesCaseMutationIdentity(mutation, suiteId, input.definition.metadata.case_id)
      );
    },
    // Conditionally replace one current Case definition.
    updateCase(
      suiteId: string,
      caseKey: string,
      input: UpdateCaseRequest,
      signal: AbortSignal
    ): Promise<CaseMutation> {
      return apiRequestJson(
        `/api/v1/test-suites/${segment(suiteId)}/cases/${segment(caseKey)}`,
        CaseMutationV1Schema,
        jsonRequest("PUT", input, signal),
        fetcher,
        (mutation) =>
          input.definition.metadata.case_id === caseKey &&
          matchesCaseMutationIdentity(mutation, suiteId, caseKey)
      );
    },
    // Copy one current Case under a new business key.
    copyCase(
      suiteId: string,
      caseKey: string,
      input: { readonly expectedSuiteRevision: number; readonly newCaseKey: string },
      signal: AbortSignal
    ): Promise<CaseMutation> {
      return apiRequestJson(
        `/api/v1/test-suites/${segment(suiteId)}/cases/${segment(caseKey)}/copy`,
        CaseMutationV1Schema,
        jsonRequest("POST", input, signal),
        fetcher,
        (mutation) => matchesCaseMutationIdentity(mutation, suiteId, input.newCaseKey)
      );
    },
    // Conditionally delete one current Case.
    deleteCase(
      suiteId: string,
      caseKey: string,
      expectedSuiteRevision: number,
      expectedCaseRevision: number,
      signal: AbortSignal
    ): Promise<void> {
      return apiRequestEmpty(
        withSearch(`/api/v1/test-suites/${segment(suiteId)}/cases/${segment(caseKey)}`, {
          expectedSuiteRevision,
          expectedCaseRevision
        }),
        { method: "DELETE", signal },
        fetcher
      );
    },
    // Atomically import one JSON Case array through multipart.
    importCases(
      suiteId: string,
      expectedRevision: number,
      file: File,
      signal: AbortSignal
    ): Promise<CaseImportSuccess> {
      const body = new FormData();
      body.append("file", file);
      return apiRequestJson(
        withSearch(`/api/v1/test-suites/${segment(suiteId)}/import`, { expectedRevision }),
        CaseImportSuccessV1Schema,
        { method: "POST", body, signal },
        fetcher,
        (result) => matchesTestSuiteIdentity(result.suite, suiteId)
      );
    },
    // Read one Revision-consistent full Case export.
    exportCases(suiteId: string, signal: AbortSignal): Promise<CaseExport> {
      return apiRequestJson(
        `/api/v1/test-suites/${segment(suiteId)}/export`,
        CaseExportV1Schema,
        { signal },
        fetcher
      );
    },
    // List one cursor page of a Configuration family.
    listConfigurations(
      kind: ConfigurationKind,
      input: ResourcePageInput,
      signal: AbortSignal
    ): Promise<ConfigurationPage> {
      return apiRequestJson(
        withSearch(`/api/v1/${CONFIGURATION_PATHS[kind]}`, {
          limit: input.limit,
          cursor: input.cursor
        }),
        ConfigurationPageV1Schema,
        { signal },
        fetcher,
        (page) => page.items.every((item) => item.kind === kind)
      );
    },
    // Read one current Configuration resource.
    getConfiguration(
      kind: ConfigurationKind,
      id: string,
      signal: AbortSignal
    ): Promise<ConfigurationResource> {
      return apiRequestJson(
        `/api/v1/${CONFIGURATION_PATHS[kind]}/${segment(id)}`,
        ConfigurationResourceV1Schema,
        { signal },
        fetcher,
        (resource) => matchesConfigurationIdentity(resource, kind, id)
      );
    },
    // Create one current Configuration resource.
    createConfiguration<Kind extends ConfigurationKind>(
      kind: Kind,
      input: { readonly name: string; readonly definition: ConfigurationDefinition<Kind> },
      signal: AbortSignal
    ): Promise<ConfigurationResource> {
      return apiRequestJson(
        `/api/v1/${CONFIGURATION_PATHS[kind]}`,
        ConfigurationResourceV1Schema,
        jsonRequest("POST", input, signal),
        fetcher,
        (resource) => matchesConfigurationIdentity(resource, kind, null)
      );
    },
    // Conditionally update one current Configuration resource.
    updateConfiguration<Kind extends ConfigurationKind>(
      kind: Kind,
      id: string,
      input: {
        readonly name: string;
        readonly definition: ConfigurationDefinition<Kind>;
        readonly expectedRevision: number;
      },
      signal: AbortSignal
    ): Promise<ConfigurationResource> {
      return apiRequestJson(
        `/api/v1/${CONFIGURATION_PATHS[kind]}/${segment(id)}`,
        ConfigurationResourceV1Schema,
        jsonRequest("PUT", input, signal),
        fetcher,
        (resource) => matchesConfigurationIdentity(resource, kind, id)
      );
    },
    // Conditionally delete one current Configuration resource.
    deleteConfiguration(
      kind: ConfigurationKind,
      id: string,
      revision: number,
      signal: AbortSignal
    ): Promise<void> {
      return apiRequestEmpty(
        withSearch(`/api/v1/${CONFIGURATION_PATHS[kind]}/${segment(id)}`, {
          expectedRevision: revision
        }),
        { method: "DELETE", signal },
        fetcher
      );
    },
    // Validate Endpoint availability without saving.
    validateEndpoint(
      definition: EndpointDefinition,
      signal: AbortSignal
    ): Promise<ConfigurationProbeSuccess> {
      return apiRequestJson(
        "/api/v1/endpoint-configs/validate",
        ConfigurationProbeSuccessV1Schema,
        jsonRequest("POST", { definition }, signal),
        fetcher
      );
    },
    // Validate LLM availability without saving.
    validateLlm(
      definition: LlmDefinition,
      signal: AbortSignal
    ): Promise<ConfigurationProbeSuccess> {
      return apiRequestJson(
        "/api/v1/llm-configs/validate",
        ConfigurationProbeSuccessV1Schema,
        jsonRequest("POST", { definition }, signal),
        fetcher
      );
    },
    // Read current Case references before Rubric Prompt changes.
    listRubricPromptReferences(id: string, signal: AbortSignal): Promise<RubricPromptReferences> {
      return apiRequestJson(
        `/api/v1/llm-rubric-prompts/${segment(id)}/references`,
        RubricPromptReferencesV1Schema,
        { signal },
        fetcher
      );
    },
    // Preview Rubric Prompt messages without saving.
    previewRubricPrompt(
      definition: RubricPromptDefinition,
      signal: AbortSignal
    ): Promise<RubricPromptPreview> {
      return apiRequestJson(
        "/api/v1/llm-rubric-prompts/preview",
        RubricPromptPreviewV1Schema,
        jsonRequest("POST", { definition }, signal),
        fetcher
      );
    },
    // Preview actual Analysis Prompt variables without saving.
    previewAnalysisPrompt(
      definition: AnalysisPromptDefinition,
      signal: AbortSignal
    ): Promise<AnalysisPromptPreview> {
      return apiRequestJson(
        "/api/v1/case-analysis-prompts/preview",
        AnalysisPromptPreviewV1Schema,
        jsonRequest("POST", { definition }, signal),
        fetcher
      );
    }
  };
}

/** Stable TanStack query keys grouped by invalidation scope. */
export const resourceKeys = {
  // All P4 Dashboard resource count queries.
  dashboard: () => ["dashboard", "resources"] as const,
  // Every Test Suite list query regardless of cursor.
  testSuiteLists: () => ["test-suites", "list"] as const,
  // One current Test Suite detail.
  testSuiteDetail: (suiteId: string) => ["test-suites", "detail", suiteId] as const,
  // Every Case list and detail query below one Suite.
  caseResources: (suiteId: string) => ["test-suites", suiteId, "cases"] as const,
  // Every Case detail query below one Suite.
  caseDetails: (suiteId: string) => [...resourceKeys.caseResources(suiteId), "detail"] as const,
  // Every Case list query below one Suite.
  caseLists: (suiteId: string) => [...resourceKeys.caseResources(suiteId), "list"] as const,
  // One current Case detail.
  caseDetail: (suiteId: string, caseKey: string) =>
    ["test-suites", suiteId, "cases", "detail", caseKey] as const,
  // Every list query for one Configuration family.
  configurationLists: (kind: ConfigurationKind) => ["configurations", kind, "list"] as const,
  // One current Configuration detail.
  configurationDetail: (kind: ConfigurationKind, id: string) =>
    ["configurations", kind, "detail", id] as const
};

/** Build one abortable Test Suite page query. */
export function testSuitePageQuery(
  api: ResourceApi,
  input: ResourcePageInput
): TestSuitePageQueryOptions {
  return {
    queryKey: [...resourceKeys.testSuiteLists(), input] as const,
    queryFn: ({ signal }) => api.listTestSuites(input, signal)
  };
}

/** Synchronize one Test Suite Snapshot into its detail and loaded list caches. */
export function synchronizeTestSuiteSnapshot(
  queryClient: QueryClient,
  suite: TestSuiteDetail
): void {
  queryClient.setQueryData(resourceKeys.testSuiteDetail(suite.id), suite);
  queryClient.setQueriesData<TestSuitePage>(
    { queryKey: resourceKeys.testSuiteLists() },
    (page): TestSuitePage | undefined => {
      if (page === undefined) return undefined;
      return {
        ...page,
        items: page.items.map((item) =>
          item.id === suite.id
            ? {
                id: suite.id,
                name: suite.name,
                description: suite.description,
                caseCount: suite.caseCount,
                revision: suite.revision,
                updatedAt: suite.updatedAt
              }
            : item
        )
      };
    }
  );
}

/** Synchronize one Case Snapshot into every loaded list while preserving its visible detail Draft. */
export function synchronizeCaseListSnapshot(queryClient: QueryClient, resource: CaseDetail): void {
  queryClient.setQueriesData<CasePage>(
    { queryKey: resourceKeys.caseLists(resource.suiteId) },
    (page): CasePage | undefined => {
      if (page === undefined) return undefined;
      return {
        ...page,
        items: page.items.map((item) =>
          item.caseKey === resource.caseKey
            ? {
                id: resource.id,
                suiteId: resource.suiteId,
                caseKey: resource.caseKey,
                ordinal: resource.ordinal,
                description: resource.description,
                businessModule: resource.businessModule,
                scenarioTag: resource.scenarioTag,
                assertionTypes: resource.assertionTypes,
                metrics: resource.metrics,
                revision: resource.revision,
                updatedAt: resource.updatedAt
              }
            : item
        )
      };
    }
  );
}

/** Synchronize one Case Snapshot into its detail and every loaded Case list. */
export function synchronizeCaseSnapshot(queryClient: QueryClient, resource: CaseDetail): void {
  queryClient.setQueryData(resourceKeys.caseDetail(resource.suiteId, resource.caseKey), resource);
  synchronizeCaseListSnapshot(queryClient, resource);
}

/** Precisely invalidate Test Suite mutation consumers. */
export async function invalidateTestSuiteMutation(
  queryClient: QueryClient,
  suiteId: string
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: resourceKeys.dashboard() }),
    queryClient.invalidateQueries({ queryKey: resourceKeys.testSuiteLists() }),
    queryClient.invalidateQueries({ queryKey: resourceKeys.testSuiteDetail(suiteId) })
  ]);
}

/** Remove deleted Suite-owned facts and refresh surviving aggregate consumers. */
export async function invalidateTestSuiteDeletion(
  queryClient: QueryClient,
  suiteId: string
): Promise<void> {
  queryClient.removeQueries({ queryKey: resourceKeys.testSuiteDetail(suiteId), exact: true });
  queryClient.removeQueries({ queryKey: resourceKeys.caseResources(suiteId) });
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: resourceKeys.dashboard() }),
    queryClient.invalidateQueries({ queryKey: resourceKeys.testSuiteLists() })
  ]);
}

/** Precisely invalidate Configuration mutation consumers. */
export async function invalidateConfigurationMutation(
  queryClient: QueryClient,
  kind: ConfigurationKind,
  id: string
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: resourceKeys.dashboard() }),
    queryClient.invalidateQueries({ queryKey: resourceKeys.configurationLists(kind) }),
    queryClient.invalidateQueries({ queryKey: resourceKeys.configurationDetail(kind, id) })
  ]);
}

/** Synchronize one refetched server Snapshot into detail and loaded list caches. */
export function synchronizeConfigurationSnapshot(
  queryClient: QueryClient,
  resource: ConfigurationResource
): void {
  queryClient.setQueryData(resourceKeys.configurationDetail(resource.kind, resource.id), resource);
  queryClient.setQueriesData<ConfigurationPage>(
    { queryKey: resourceKeys.configurationLists(resource.kind) },
    (page): ConfigurationPage | undefined => {
      if (page === undefined) return undefined;
      return {
        ...page,
        items: page.items.map((item) =>
          item.id === resource.id
            ? {
                kind: resource.kind,
                id: resource.id,
                name: resource.name,
                revision: resource.revision,
                updatedAt: resource.updatedAt
              }
            : item
        )
      };
    }
  );
}

/** Remove a deleted Configuration detail and refresh surviving aggregate consumers. */
export async function invalidateConfigurationDeletion(
  queryClient: QueryClient,
  kind: ConfigurationKind,
  id: string
): Promise<void> {
  queryClient.removeQueries({ queryKey: resourceKeys.configurationDetail(kind, id), exact: true });
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: resourceKeys.dashboard() }),
    queryClient.invalidateQueries({ queryKey: resourceKeys.configurationLists(kind) })
  ]);
}

/** Precisely invalidate Case mutation consumers and its aggregate Suite. */
export async function invalidateCaseMutation(
  queryClient: QueryClient,
  suiteId: string,
  caseKey: string
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: resourceKeys.dashboard() }),
    queryClient.invalidateQueries({ queryKey: resourceKeys.testSuiteLists() }),
    queryClient.invalidateQueries({ queryKey: resourceKeys.testSuiteDetail(suiteId) }),
    queryClient.invalidateQueries({ queryKey: resourceKeys.caseLists(suiteId) }),
    queryClient.invalidateQueries({ queryKey: resourceKeys.caseDetail(suiteId, caseKey) })
  ]);
}

/** Remove one deleted Case detail before refreshing aggregate consumers. */
export async function invalidateCaseDeletion(
  queryClient: QueryClient,
  suiteId: string,
  caseKey: string
): Promise<void> {
  queryClient.removeQueries({ queryKey: resourceKeys.caseDetail(suiteId, caseKey), exact: true });
  await invalidateCaseMutation(queryClient, suiteId, caseKey);
}

/** Remove all replaced Case details before refreshing aggregate consumers. */
export async function invalidateCaseReplacement(
  queryClient: QueryClient,
  suiteId: string
): Promise<void> {
  queryClient.removeQueries({ queryKey: resourceKeys.caseDetails(suiteId) });
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: resourceKeys.dashboard() }),
    queryClient.invalidateQueries({ queryKey: resourceKeys.testSuiteLists() }),
    queryClient.invalidateQueries({ queryKey: resourceKeys.testSuiteDetail(suiteId) }),
    queryClient.invalidateQueries({ queryKey: resourceKeys.caseLists(suiteId) })
  ]);
}
