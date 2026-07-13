import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { generateLocalOpenApiJson } from "../src/local-openapi.ts";

describe("Local API OpenAPI drift", () => {
  it("提交的 OpenAPI JSON 与真实 P3 Route/Schema 字节级一致", async () => {
    const generated = await generateLocalOpenApiJson();
    const committed = await readFile(
      new URL("../../apps/local-server/openapi.json", import.meta.url),
      "utf8"
    );
    expect(committed).toBe(generated);
    expect(generated).not.toMatch(/\/runs|execution|report|event-stream/i);
  });
});
