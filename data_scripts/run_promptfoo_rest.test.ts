import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runPromptfooRestSuite, type PromptfooTestCase } from "./run_promptfoo_rest.ts";

/** Mock server request observed by a test. */
interface ObservedRequest {
  /** Requested URL path. */
  path: string;
  /** Parsed JSON request body. */
  body: unknown;
}

/** Paths for one isolated runner test. */
interface FixturePaths {
  /** Input promptfoo test file. */
  inputPath: string;
  /** REST provider configuration file. */
  providerPath: string;
  /** Generated promptfoo result file. */
  outputPath: string;
}

// Read the complete request body as UTF-8 text.
async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Create isolated JSON fixture paths and write the provider configuration.
async function createFixture(baseUrl: string): Promise<FixturePaths> {
  const directory = await mkdtemp(path.join(tmpdir(), "promptfoo-rest-runner-"));
  const inputPath = path.join(directory, "cases.json");
  const providerPath = path.join(directory, "provider.json");
  const outputPath = path.join(directory, "result.json");

  await writeFile(
    providerPath,
    JSON.stringify({
      url: `${baseUrl}/run/{{vars.task}}`,
      method: "POST",
      headers: { "X-Case": "{{ vars.case_name }}" },
      body: "vars.request_body"
    })
  );
  return { inputPath, providerPath, outputPath };
}

// Build one minimal promptfoo test case.
function buildCase(caseId: string, task: string, value: number): PromptfooTestCase {
  return {
    description: `case-${caseId}`,
    vars: {
      case_name: caseId,
      request_body: { value },
      task
    },
    metadata: { case_id: caseId },
    assert: [{ type: "is-json" }]
  };
}

// Persist JSON with stable formatting for readable failures.
async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// Read a generated promptfoo test array.
async function readResult(filePath: string): Promise<PromptfooTestCase[]> {
  return JSON.parse(await readFile(filePath, "utf8")) as PromptfooTestCase[];
}

test("sends templated JSON requests and stores JSON or text providerOutput", async () => {
  const observed: ObservedRequest[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const bodyText = await readRequestBody(request);
    observed.push({
      path: request.url ?? "",
      body: JSON.parse(bodyText)
    });
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["x-case"], request.url?.split("/").at(-1));

    if (request.url?.endsWith("/text")) {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("plain response");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ parsed_output: { ok: true } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const fixture = await createFixture(`http://127.0.0.1:${address.port}`);
    await writeJson(fixture.inputPath, [
      buildCase("json", "json", 1),
      buildCase("text", "text", 2)
    ]);

    const summary = await runPromptfooRestSuite({ ...fixture, maxConcurrency: 2 });
    const result = await readResult(fixture.outputPath);

    assert.deepEqual(summary, {
      total: 2,
      skipped: 0,
      succeeded: 2,
      failed: 0,
      outputPath: fixture.outputPath
    });
    assert.deepEqual(result[0].providerOutput, { parsed_output: { ok: true } });
    assert.equal(result[1].providerOutput, "plain response");
    assert.deepEqual(
      observed.sort((left, right) => left.path.localeCompare(right.path)),
      [
        { path: "/run/json", body: { value: 1 } },
        { path: "/run/text", body: { value: 2 } }
      ]
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("limits active requests to maxConcurrency", async () => {
  let active = 0;
  let peak = 0;
  const server = createServer(async (_request, response) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active -= 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const fixture = await createFixture(`http://127.0.0.1:${address.port}`);
    await writeJson(
      fixture.inputPath,
      Array.from({ length: 7 }, (_, index) => buildCase(String(index), "json", index))
    );

    await runPromptfooRestSuite({ ...fixture, maxConcurrency: 3 });

    assert.equal(peak, 3);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("resumes successful cases while preserving the current input definition", async () => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ fresh: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const fixture = await createFixture(`http://127.0.0.1:${address.port}`);
    const currentFirst = buildCase("existing", "json", 99);
    currentFirst.assert = [{ type: "equals", value: "current assertion" }];
    await writeJson(fixture.inputPath, [currentFirst, buildCase("remaining", "json", 2)]);
    await writeJson(fixture.outputPath, [
      {
        ...buildCase("existing", "json", 1),
        assert: [{ type: "equals", value: "stale assertion" }],
        providerOutput: { cached: true }
      },
      { ...buildCase("deleted", "json", 3), providerOutput: { stale: true } }
    ]);

    const summary = await runPromptfooRestSuite({ ...fixture, maxConcurrency: 2 });
    const result = await readResult(fixture.outputPath);

    assert.equal(requestCount, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0].vars?.request_body, { value: 99 });
    assert.deepEqual(result[0].assert, [{ type: "equals", value: "current assertion" }]);
    assert.deepEqual(result[0].providerOutput, { cached: true });
    assert.deepEqual(result[1].providerOutput, { fresh: true });

    const forcedSummary = await runPromptfooRestSuite({
      ...fixture,
      maxConcurrency: 2,
      force: true
    });
    const forcedResult = await readResult(fixture.outputPath);
    assert.equal(requestCount, 3);
    assert.equal(forcedSummary.skipped, 0);
    assert.equal(forcedSummary.succeeded, 2);
    assert.deepEqual(forcedResult[0].providerOutput, { fresh: true });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("times out one case and continues with remaining cases", async () => {
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/slow")) {
      setTimeout(() => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
      }, 80);
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ completed: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const fixture = await createFixture(`http://127.0.0.1:${address.port}`);
    await writeJson(fixture.inputPath, [
      buildCase("slow", "slow", 1),
      buildCase("fast", "fast", 2)
    ]);

    const summary = await runPromptfooRestSuite({ ...fixture, maxConcurrency: 2, timeoutMs: 15 });
    const result = await readResult(fixture.outputPath);

    assert.equal(summary.failed, 1);
    assert.equal(summary.succeeded, 1);
    assert.match(result[0].metadata?.rest_run_error?.message ?? "", /15/);
    assert.deepEqual(result[1].providerOutput, { completed: true });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("records failed cases without providerOutput and retries them later", async () => {
  let shouldFail = true;
  const server = createServer((_request, response) => {
    if (shouldFail) {
      response.writeHead(503, { "Content-Type": "text/plain" });
      response.end("temporary failure");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ recovered: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const fixture = await createFixture(`http://127.0.0.1:${address.port}`);
    await writeJson(fixture.inputPath, [buildCase("retry", "json", 1)]);

    const failedSummary = await runPromptfooRestSuite({ ...fixture });
    const failedResult = await readResult(fixture.outputPath);
    assert.equal(failedSummary.failed, 1);
    assert.equal(Object.hasOwn(failedResult[0], "providerOutput"), false);
    assert.equal(failedResult[0].metadata?.rest_run_error?.status, 503);

    shouldFail = false;
    const recoveredSummary = await runPromptfooRestSuite({ ...fixture });
    const recoveredResult = await readResult(fixture.outputPath);
    assert.equal(recoveredSummary.succeeded, 1);
    assert.deepEqual(recoveredResult[0].providerOutput, { recovered: true });
    assert.equal(Object.hasOwn(recoveredResult[0].metadata ?? {}, "rest_run_error"), false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
