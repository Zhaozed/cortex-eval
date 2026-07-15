import { describe, expect, it } from "vitest";

import {
  CanonicalExportProjectionService,
  type CanonicalEntityFileSink,
  type CanonicalEntityType,
  type CanonicalSnapshotReader,
  type CanonicalSourceEntity,
  type CanonicalWrittenFileFacts
} from "../src/features/canonical-export/canonical-export-projection-service.ts";

const ID_A = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const ID_B = "018f1e2d-3c4b-7abc-8def-0123456789ac";
const HASH = "a".repeat(64);

function source(records: readonly CanonicalSourceEntity[]): CanonicalSnapshotReader {
  return {
    stream: async function* (
      entityType: CanonicalEntityType
    ): AsyncGenerator<CanonicalSourceEntity> {
      await Promise.resolve();
      for (const record of records) {
        if (record.entityType === entityType) yield record;
      }
    }
  };
}

function sink(linesByType: Map<string, string[]>): CanonicalEntityFileSink {
  return {
    write: async (entityType, lines): Promise<CanonicalWrittenFileFacts> => {
      const collected: string[] = [];
      for await (const line of lines) collected.push(line);
      linesByType.set(entityType, collected);
      return { sha256: HASH, sizeBytes: collected.join("").length };
    }
  };
}

describe("Canonical Export Projection Service", () => {
  it("按固定实体顺序写出稳定 Record，并校验显式引用", async () => {
    const records: readonly CanonicalSourceEntity[] = [
      {
        entityType: "TEST_SUITE",
        entityKey: { id: ID_A },
        payload: { id: ID_A, name: "Suite" },
        references: []
      },
      {
        entityType: "TEST_CASE",
        entityKey: { id: ID_B },
        payload: { id: ID_B, suiteId: ID_A, caseKey: "case-1" },
        references: [{ entityType: "TEST_SUITE", entityKey: { id: ID_A } }]
      },
      {
        entityType: "CASE_RESULT",
        entityKey: { runId: ID_A, caseKey: "case-1" },
        payload: { runId: ID_A, caseKey: "case-1", status: "SUCCEEDED" },
        references: [{ entityType: "RUN", entityKey: { id: ID_A } }]
      },
      {
        entityType: "RUN",
        entityKey: { id: ID_A },
        payload: { id: ID_A, status: "COMPLETED" },
        references: []
      }
    ];
    const lines = new Map<string, string[]>();

    const result = await new CanonicalExportProjectionService().project(
      source(records),
      sink(lines)
    );

    expect(result.entityFiles).toHaveLength(10);
    expect(result.countsChecked).toBe(4);
    expect(result.referencesChecked).toBe(2);
    const caseResult = JSON.parse(lines.get("CASE_RESULT")?.[0] ?? "null") as {
      entityKey: unknown;
      entityHash: string;
      references: unknown;
    };
    expect(caseResult.entityKey).toEqual({ runId: ID_A, caseKey: "case-1" });
    expect(caseResult.entityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(caseResult.references).toEqual([{ entityType: "RUN", entityKey: { id: ID_A } }]);
  });

  it("拒绝同类型非二进制升序和重复 Key", async () => {
    const unordered: readonly CanonicalSourceEntity[] = [
      {
        entityType: "TEST_SUITE",
        entityKey: { id: ID_B },
        payload: { id: ID_B },
        references: []
      },
      {
        entityType: "TEST_SUITE",
        entityKey: { id: ID_A },
        payload: { id: ID_A },
        references: []
      }
    ];

    await expect(
      new CanonicalExportProjectionService().project(source(unordered), sink(new Map()))
    ).rejects.toThrow("CANONICAL_ENTITY_ORDER_INVALID");
  });

  it("拒绝断裂强引用，不把外部 Execution 身份冒充实体引用", async () => {
    const records: readonly CanonicalSourceEntity[] = [
      {
        entityType: "TEST_CASE",
        entityKey: { id: ID_B },
        payload: { id: ID_B, externalExecutionId: ID_A },
        references: [{ entityType: "TEST_SUITE", entityKey: { id: ID_A } }]
      }
    ];

    await expect(
      new CanonicalExportProjectionService().project(source(records), sink(new Map()))
    ).rejects.toThrow("CANONICAL_REFERENCE_MISSING");
  });

  it("拒绝单个实体内重复引用", async () => {
    const reference = { entityType: "TEST_SUITE" as const, entityKey: { id: ID_A } };
    const records: readonly CanonicalSourceEntity[] = [
      {
        entityType: "TEST_SUITE",
        entityKey: { id: ID_A },
        payload: { id: ID_A },
        references: []
      },
      {
        entityType: "TEST_CASE",
        entityKey: { id: ID_B },
        payload: { id: ID_B },
        references: [reference, reference]
      }
    ];

    await expect(
      new CanonicalExportProjectionService().project(source(records), sink(new Map()))
    ).rejects.toThrow("CANONICAL_REFERENCE_DUPLICATE");
  });

  it("按类型和复合身份对多个引用稳定排序", async () => {
    const records: readonly CanonicalSourceEntity[] = [
      {
        entityType: "TEST_SUITE",
        entityKey: { id: ID_A },
        payload: { id: ID_A },
        references: []
      },
      {
        entityType: "RUN",
        entityKey: { id: ID_B },
        payload: { id: ID_B },
        references: []
      },
      {
        entityType: "CASE_RESULT",
        entityKey: { runId: ID_B, caseKey: "case-1" },
        payload: { runId: ID_B, caseKey: "case-1" },
        references: [
          { entityType: "TEST_SUITE", entityKey: { id: ID_A } },
          { entityType: "RUN", entityKey: { id: ID_B } }
        ]
      }
    ];
    const lines = new Map<string, string[]>();

    await new CanonicalExportProjectionService().project(source(records), sink(lines));

    const record = JSON.parse(lines.get("CASE_RESULT")?.[0] ?? "null") as {
      references: unknown;
    };
    expect(record.references).toEqual([
      { entityType: "RUN", entityKey: { id: ID_B } },
      { entityType: "TEST_SUITE", entityKey: { id: ID_A } }
    ]);
  });
});
