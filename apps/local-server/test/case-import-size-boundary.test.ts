import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CaseDefinitionWriter } from "@cortex-eval/application/src/features/test-suites/case-definition-writer.ts";
import { CaseExportService } from "@cortex-eval/application/src/features/test-suites/case-export-service.ts";
import { StreamingCaseImportService } from "@cortex-eval/application/src/features/test-suites/streaming-case-import-service.ts";
import { TestSuiteService } from "@cortex-eval/application/src/features/test-suites/test-suite-service.ts";
import { ConfigurationService } from "@cortex-eval/application/src/features/configurations/configuration-service.ts";
import { InMemoryApplicationStore } from "@cortex-eval/application/test/test-support/in-memory-application-store.ts";

import { createApplicationResourceHandlers } from "../src/application-resource-handlers.ts";
import { buildLocalServer, MAX_CASE_IMPORT_BYTES } from "../src/local-server.ts";
import { InMemoryCaseStagingFactory } from "./test-support/in-memory-case-staging.ts";
import { InMemoryCaseExportBodyPreparer } from "./test-support/in-memory-case-export-staging.ts";

const boundary = "cortex-size-boundary";
const headers = {
  host: "127.0.0.1:4310",
  "content-type": `multipart/form-data; boundary=${boundary}`
};
const definition = {
  contractVersion: "cortex.case-definition.v1",
  description: "Boundary",
  threshold: 1,
  vars: { task: "route", request_body: {} },
  metadata: {
    case_id: "CASE-BOUNDARY",
    req_id: "REQ-BOUNDARY",
    task_id: "TASK-BOUNDARY",
    business_module: "chat",
    scenario_tag: "smoke"
  },
  assert: [{ type: "contains", metric: "quality", weight: 1 }]
};

// Generate one exact-size top-level JSON array without retaining its whitespace padding.
function* multipartPayload(fileBytes: number): Generator<Buffer, void, void> {
  yield Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="cases.json"\r\n' +
      "Content-Type: application/json\r\n\r\n"
  );
  const item = JSON.stringify(definition);
  yield Buffer.from(`[${item}]`);
  let remaining = fileBytes - Buffer.byteLength(item) - 2;
  const whitespace = Buffer.alloc(1024 * 1024, 0x20);
  while (remaining > 0) {
    const size = Math.min(remaining, whitespace.length);
    yield whitespace.subarray(0, size);
    remaining -= size;
  }
  yield Buffer.from(`\r\n--${boundary}--\r\n`);
}

describe("Case import 200 MiB boundary", () => {
  const store = new InMemoryApplicationStore();
  const testSuites = new TestSuiteService(store.dependencies());
  const server = buildLocalServer({
    requestIdGenerator: {
      nextId: () => "018f0c8e-9f79-7abc-8def-0123456789ab"
    },
    resourceHandlers: createApplicationResourceHandlers({
      testSuites,
      cases: new CaseDefinitionWriter(store.dependencies()),
      caseExports: new CaseExportService({ transactionManager: store }),
      caseExportBodies: new InMemoryCaseExportBodyPreparer(),
      caseImports: new StreamingCaseImportService({
        ...store.dependencies(),
        stagingFactory: new InMemoryCaseStagingFactory(store)
      }),
      configurations: new ConfigurationService(store.configurationDependencies())
    })
  });

  beforeAll(async () => {
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  async function importSize(
    fileBytes: number,
    name: string
  ): Promise<{
    readonly response: Awaited<ReturnType<typeof server.inject>>;
    readonly suiteId: string;
  }> {
    const created = await testSuites.create({ name, description: "Boundary" });
    if (!created.ok) throw new Error("TEST_SUITE_CREATE_FAILED");
    const response = await server.inject({
      method: "POST",
      url: `/api/v1/test-suites/${created.suite.id}/import?expectedRevision=0`,
      headers,
      payload: Readable.from(multipartPayload(fileBytes))
    });
    return { response, suiteId: created.suite.id };
  }

  it("接受 200 MiB-1", async () => {
    const { response } = await importSize(MAX_CASE_IMPORT_BYTES - 1, "Below");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ count: 1 });
  }, 120_000);

  it("接受恰好 200 MiB", async () => {
    const { response } = await importSize(MAX_CASE_IMPORT_BYTES, "Exact");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ count: 1 });
  }, 120_000);

  it("合法数组先结束且尾随空白达到 200 MiB+1 时拒绝并且不提交 Case", async () => {
    const { response, suiteId } = await importSize(MAX_CASE_IMPORT_BYTES + 1, "Above");
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: "CASE_IMPORT_TOO_LARGE" } });
    expect(await testSuites.getCase(suiteId, "CASE-BOUNDARY")).toBeNull();
  }, 120_000);
});
