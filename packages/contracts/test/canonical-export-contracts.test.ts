import { describe, expect, it } from "vitest";

import {
  CanonicalEntityRecordV1Schema,
  CanonicalExportManifestV1Schema,
  CanonicalExportRequestV1Schema,
  CanonicalExportReconciliationV1Schema
} from "../src/canonical-export-contracts.ts";

const ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const HASH = "d".repeat(64);
const TIME = "2026-07-13T01:02:03.004Z";

describe("Canonical Export v1", () => {
  it("请求默认不内嵌 Raw Evidence，但允许调用方显式选择", () => {
    expect(CanonicalExportRequestV1Schema.parse({}).rawEvidenceIncluded).toBe(false);
    expect(
      CanonicalExportRequestV1Schema.parse({ rawEvidenceIncluded: true }).rawEvidenceIncluded
    ).toBe(true);
  });

  it("冻结稳定 JSONL 文件、合约版本和缺失 Raw Artifact 元数据", () => {
    const value = {
      contractVersion: "cortex.canonical-export-manifest.v1",
      exportId: ID,
      createdAt: TIME,
      rawEvidenceIncluded: true,
      contractVersions: {
        canonicalExport: "cortex.canonical-export-manifest.v1",
        caseDefinition: "cortex.case-definition.v1"
      },
      entityFiles: [
        {
          entityType: "TEST_CASE",
          path: "entities/test-cases.jsonl",
          count: 1,
          sha256: HASH,
          sizeBytes: 100
        }
      ],
      artifacts: [
        {
          ownerType: "RUN",
          ownerId: ID,
          kind: "RAW_PROMPTFOO_EVIDENCE",
          path: "artifacts/raw.json",
          expectedSha256: HASH,
          expectedSizeBytes: 10,
          present: false,
          actualSha256: null,
          actualSizeBytes: null
        }
      ]
    };
    expect(CanonicalExportManifestV1Schema.parse(value).artifacts[0]?.present).toBe(false);
    expect(
      CanonicalEntityRecordV1Schema.parse({
        contractVersion: "cortex.canonical-entity-record.v1",
        entityType: "TEST_CASE",
        entityId: ID,
        entityHash: HASH,
        payload: { caseKey: "case-1" }
      }).entityHash
    ).toBe(HASH);
    expect(
      CanonicalExportManifestV1Schema.safeParse({
        ...value,
        entityFiles: [value.entityFiles[0], value.entityFiles[0]],
        artifacts: [value.artifacts[0], value.artifacts[0]]
      }).success
    ).toBe(false);
  });

  it("显式记录计数、引用、实体哈希和文件哈希四类对账", () => {
    const value = {
      contractVersion: "cortex.canonical-export-reconciliation.v1",
      exportId: ID,
      checks: {
        counts: { status: "PASS", checked: 1 },
        references: { status: "PASS", checked: 2 },
        entityHashes: { status: "PASS", checked: 3 },
        fileHashes: { status: "PASS", checked: 4 }
      }
    };
    expect(CanonicalExportReconciliationV1Schema.parse(value).checks.fileHashes.checked).toBe(4);
  });
});
