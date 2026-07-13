import { Readable } from "node:stream";

import { CaseDefinitionWriter } from "@cortex-eval/application/src/features/test-suites/case-definition-writer.ts";
import { CaseExportService } from "@cortex-eval/application/src/features/test-suites/case-export-service.ts";
import { StreamingCaseImportService } from "@cortex-eval/application/src/features/test-suites/streaming-case-import-service.ts";
import { TestSuiteService } from "@cortex-eval/application/src/features/test-suites/test-suite-service.ts";
import { ConfigurationService } from "@cortex-eval/application/src/features/configurations/configuration-service.ts";
import { InMemoryApplicationStore } from "@cortex-eval/application/test/test-support/in-memory-application-store.ts";

import { createApplicationResourceHandlers } from "../src/application-resource-handlers.ts";
import { buildLocalServer, MAX_CASE_IMPORT_BYTES } from "../src/local-server.ts";
import { InMemoryCaseStagingFactory } from "../test/test-support/in-memory-case-staging.ts";
import { InMemoryCaseExportBodyPreparer } from "../test/test-support/in-memory-case-export-staging.ts";

const boundary = "cortex-memory-boundary";
const definition = {
  contractVersion: "cortex.case-definition.v1",
  description: "Memory",
  threshold: 1,
  vars: { task: "route", request_body: {} },
  metadata: {
    case_id: "CASE-MEMORY",
    req_id: "REQ-MEMORY",
    task_id: "TASK-MEMORY",
    business_module: "chat",
    scenario_tag: "smoke"
  },
  assert: [{ type: "contains", metric: "quality", weight: 1 }]
};

let peakRss = process.memoryUsage.rss();
function sample(): void {
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
}

function* payload(): Generator<Buffer, void, void> {
  yield Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="cases.json"\r\n' +
      "Content-Type: application/json\r\n\r\n"
  );
  const item = JSON.stringify(definition);
  yield Buffer.from(`[${item}`);
  let remaining = MAX_CASE_IMPORT_BYTES - Buffer.byteLength(item) - 2;
  const whitespace = Buffer.alloc(1024 * 1024, 0x20);
  while (remaining > 0) {
    sample();
    const size = Math.min(remaining, whitespace.length);
    yield whitespace.subarray(0, size);
    remaining -= size;
  }
  yield Buffer.from("]");
  yield Buffer.from(`\r\n--${boundary}--\r\n`);
}

const store = new InMemoryApplicationStore();
const testSuites = new TestSuiteService(store.dependencies());
const created = await testSuites.create({ name: "Memory", description: "Probe" });
if (!created.ok) throw new Error("MEMORY_PROBE_SUITE_FAILED");
const server = buildLocalServer({
  requestIdGenerator: { nextId: () => "018f0c8e-9f79-7abc-8def-0123456789ab" },
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
await server.ready();
const baselineRss = process.memoryUsage.rss();
peakRss = baselineRss;
const response = await server.inject({
  method: "POST",
  url: `/api/v1/test-suites/${created.suite.id}/import?expectedRevision=0`,
  headers: {
    host: "127.0.0.1:4310",
    "content-type": `multipart/form-data; boundary=${boundary}`
  },
  payload: Readable.from(payload())
});
sample();
await server.close();
if (response.statusCode !== 200) throw new Error("MEMORY_PROBE_IMPORT_FAILED");
process.stdout.write(
  `${JSON.stringify({ baselineRss, peakRss, deltaRss: peakRss - baselineRss })}\n`
);
