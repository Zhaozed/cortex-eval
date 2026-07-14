import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { AssertionSchema } from "promptfoo";

import {
  discoverPromptfooAssertionTypes,
  loadAssertionCapabilityMatrix,
  mapCapabilityComponentIdentity,
  validateCapabilityAssertion,
  validateCapabilityMatrix,
  validateCapabilitySourceEvidence
} from "../src/promptfoo-capabilities.ts";

describe("Promptfoo 0.121.18 Assertion 能力矩阵", () => {
  it("与固定版本源码事实集双向一致，并覆盖 not-* 与 Assertion Set", async () => {
    const sourceTypes = await discoverPromptfooAssertionTypes(process.cwd());
    const matrix = await loadAssertionCapabilityMatrix(process.cwd());
    const validation = validateCapabilityMatrix(sourceTypes, matrix);

    expect(validation).toEqual({ missing: [], unknown: [] });
    expect(matrix.some((item) => item.type.startsWith("not-"))).toBe(true);
    expect(matrix.some((item) => item.kind === "ASSERTION_SET")).toBe(true);
  });

  it("每个能力都声明正例、拒绝边界与 Importer 对齐探针", async () => {
    const matrix = await loadAssertionCapabilityMatrix(process.cwd());
    for (const capability of matrix) {
      expect(capability.probes.positive).not.toBe("");
      expect(capability.probes.invalidOrCapabilityError).not.toBe("");
      expect(capability.probes.importerAlignment).not.toBe("");
      expect(capability.payload.acceptedKinds.length).toBeGreaterThan(0);
      expect(capability.dependencies.length).toBeGreaterThanOrEqual(0);
      expect(capability.rejectionBoundaries.length).toBeGreaterThan(0);
      expect(capability.importerAlignment).toEqual({
        resultPath: "gradingResult.componentResults",
        keys: ["caseKey", "ordinal", "assertionIndex", "definitionHash"]
      });
      expect(AssertionSchema.safeParse(capability.schemaProbe).success).toBe(true);
      expect(validateCapabilityAssertion(capability, capability.schemaProbe)).toBeNull();
      if (
        capability.payload.acceptedKinds.includes("BOOLEAN") ||
        capability.payload.acceptedKinds.includes("PLUGIN_DEFINED")
      ) {
        expect(
          validateCapabilityAssertion(capability, { ...capability.schemaProbe, value: true })
        ).toBeNull();
      } else {
        expect(
          validateCapabilityAssertion(capability, { ...capability.schemaProbe, value: true })
        ).toBe("CAPABILITY_PAYLOAD_KIND");
      }
      expect(
        validateCapabilityAssertion(capability, {
          ...capability.schemaProbe,
          value: "file://outside.js"
        })
      ).toBe("FILE_REFERENCE");
      expect(
        validateCapabilityAssertion(capability, {
          ...capability.schemaProbe,
          value: "package:external:assertion"
        })
      ).toBe("EXTERNAL_MODULE");
      expect(
        validateCapabilityAssertion(capability, {
          ...capability.schemaProbe,
          provider: "openai:gpt-4.1"
        })
      ).toBe("PROVIDER_OVERRIDE");
      expect(
        mapCapabilityComponentIdentity(
          capability,
          { assertion: { type: capability.schemaProbe.type } },
          { caseKey: "case", ordinal: 1, assertionIndex: 2, definitionHash: "hash" }
        )
      ).toEqual({ caseKey: "case", ordinal: 1, assertionIndex: 2, definitionHash: "hash" });
    }
    await expect(validateCapabilitySourceEvidence(process.cwd(), matrix)).resolves.toEqual([]);
    const wrongHandlerMatrix = matrix.map((item) =>
      item.type === "equals" ? { ...item, sourceEvidence: "handleContains" } : item
    );
    await expect(
      validateCapabilitySourceEvidence(process.cwd(), wrongHandlerMatrix)
    ).resolves.toEqual(["equals"]);

    expect(matrix.find((item) => item.type === "is-json")?.payload).toEqual({
      acceptedKinds: ["NONE", "STRING", "OBJECT"],
      valueRequired: false,
      thresholdRequired: false
    });
    expect(matrix.find((item) => item.type === "word-count")?.payload.acceptedKinds).toEqual([
      "STRING",
      "NUMBER",
      "OBJECT"
    ]);
    expect(matrix.find((item) => item.type === "max-score")?.payload).toEqual({
      acceptedKinds: ["NONE", "OBJECT", "ARRAY"],
      valueRequired: false,
      thresholdRequired: false
    });
    expect(matrix.find((item) => item.type === "select-best")?.dependencies).toContain(
      "PROMPTFOO_EVALUATOR_PROVIDER"
    );
    expect(matrix.find((item) => item.type === "select-best")?.dependencies).toContain(
      "PROMPTFOO_MULTI_OUTPUT_TEST"
    );
    expect(matrix.find((item) => item.type === "max-score")?.dependencies).toContain(
      "PROMPTFOO_MULTI_OUTPUT_TEST"
    );
    expect(matrix.find((item) => item.type === "equals")?.payload.acceptedKinds).toContain(
      "BOOLEAN"
    );
    expect(matrix.find((item) => item.type === "contains-any")?.payload.acceptedKinds).toContain(
      "ARRAY"
    );
    expect(matrix.find((item) => item.type === "llm-rubric")?.payload.acceptedKinds).toContain(
      "STRING_LIST"
    );
    expect(matrix.find((item) => item.type === "search-rubric")?.payload.acceptedKinds).toEqual([
      "STRING",
      "STRING_LIST",
      "NUMBER",
      "BOOLEAN",
      "OBJECT",
      "ARRAY"
    ]);
    const containsAny = matrix.find((item) => item.type === "contains-any");
    if (containsAny === undefined) {
      throw new Error("TEST_CAPABILITY_CONTAINS_ANY");
    }
    expect(
      validateCapabilityAssertion(containsAny, { type: "contains-any", value: [42, 99] })
    ).toBeNull();
  });

  it("双向报告遗漏和未知类型", () => {
    expect(
      validateCapabilityMatrix(
        ["equals", "contains"],
        [
          {
            type: "equals",
            kind: "ASSERTION",
            probes: { positive: "p", invalidOrCapabilityError: "i", importerAlignment: "a" }
          },
          {
            type: "unknown",
            kind: "ASSERTION",
            probes: { positive: "p", invalidOrCapabilityError: "i", importerAlignment: "a" }
          }
        ]
      )
    ).toEqual({ missing: ["contains"], unknown: ["unknown"] });
  });

  it("拒绝缺失显式契约、错误对齐和重复类型的能力事实", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-capability-matrix-"));
    const factsDirectory = join(root, "tooling/facts");
    await mkdir(factsDirectory, { recursive: true });
    const writeFacts = async (value: unknown): Promise<void> => {
      await writeFile(
        join(factsDirectory, "promptfoo-0.121.18-capabilities.json"),
        JSON.stringify(value),
        "utf8"
      );
    };
    const valid = {
      type: "equals",
      kind: "ASSERTION",
      payload: {
        acceptedKinds: ["STRING"],
        valueRequired: true,
        thresholdRequired: false
      },
      dependencies: [],
      rejectionBoundaries: ["FILE_REFERENCE"],
      schemaProbe: { type: "equals", value: "expected" },
      sourceEvidence: "handleEquals",
      importerAlignment: {
        resultPath: "gradingResult.componentResults",
        keys: ["caseKey", "ordinal", "assertionIndex", "definitionHash"]
      },
      probes: {
        positive: "positive",
        invalidOrCapabilityError: "invalid",
        importerAlignment: "alignment"
      }
    };
    try {
      const invalidCases: readonly [unknown, string][] = [
        [{}, "PROMPTFOO_MATRIX_VERSION"],
        [{ version: "0.121.18", capabilities: [null] }, "PROMPTFOO_MATRIX_CAPABILITY:0"],
        [
          { version: "0.121.18", capabilities: [{ ...valid, type: "" }] },
          "PROMPTFOO_MATRIX_TYPE:0"
        ],
        [
          { version: "0.121.18", capabilities: [{ ...valid, kind: "UNKNOWN" }] },
          "PROMPTFOO_MATRIX_KIND:equals"
        ],
        [
          { version: "0.121.18", capabilities: [{ ...valid, payload: {} }] },
          "PROMPTFOO_MATRIX_PAYLOAD:equals"
        ],
        [
          { version: "0.121.18", capabilities: [{ ...valid, schemaProbe: {} }] },
          "PROMPTFOO_MATRIX_SCHEMA_PROBE:equals"
        ],
        [
          { version: "0.121.18", capabilities: [{ ...valid, sourceEvidence: "" }] },
          "PROMPTFOO_MATRIX_SOURCE_EVIDENCE:equals"
        ],
        [
          { version: "0.121.18", capabilities: [{ ...valid, importerAlignment: {} }] },
          "PROMPTFOO_MATRIX_IMPORTER:equals"
        ],
        [
          { version: "0.121.18", capabilities: [{ ...valid, probes: {} }] },
          "PROMPTFOO_MATRIX_PROBES:equals"
        ],
        [
          { version: "0.121.18", capabilities: [{ ...valid, dependencies: [1] }] },
          "PROMPTFOO_MATRIX_DEPENDENCIES:equals"
        ],
        [
          { version: "0.121.18", capabilities: [{ ...valid, rejectionBoundaries: [] }] },
          "PROMPTFOO_MATRIX_REJECTIONS:equals"
        ],
        [{ version: "0.121.18", capabilities: [valid, valid] }, "PROMPTFOO_MATRIX_DUPLICATE_TYPE"]
      ];
      for (const [facts, error] of invalidCases) {
        await writeFacts(facts);
        await expect(loadAssertionCapabilityMatrix(root)).rejects.toThrow(error);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
