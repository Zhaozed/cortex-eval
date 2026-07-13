import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { OpenAiCompatibleLlmConfigDefinition } from "@cortex-eval/domain/src/domain-resource-models.ts";

import { SdkLlmProbeClients } from "../src/configuration-probe-adapters.ts";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        })
    )
  );
});

describe("P3 OpenAI-compatible real HTTP probe", () => {
  it("NONE 认证不发送 Authorization，并传递 OFF Thinking", async () => {
    let authorization: string | undefined;
    let requestBody = "";
    const server = createServer((request, response): void => {
      authorization = request.headers.authorization;
      request.setEncoding("utf8");
      request.on("data", (chunk: string): void => {
        requestBody += chunk;
      });
      request.on("end", (): void => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "probe",
            object: "chat.completion",
            created: 1,
            model: "local-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: '{"ok":true}' },
                finish_reason: "stop"
              }
            ]
          })
        );
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("ADDRESS_EXPECTED");
    const definition: OpenAiCompatibleLlmConfigDefinition = {
      providerType: "OPENAI_COMPATIBLE",
      model: "local-model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      auth: { kind: "NONE" },
      thinkingLevel: "OFF",
      temperature: 0,
      topP: 1,
      maxOutputTokens: 64,
      timeoutMs: 1000,
      structuredOutput: "JSON_OBJECT"
    };

    await new SdkLlmProbeClients().probeOpenAiCompatible(
      definition,
      null,
      new AbortController().signal
    );

    expect(authorization).toBeUndefined();
    expect(JSON.parse(requestBody)).toMatchObject({ reasoning_effort: "none" });
  });
});
