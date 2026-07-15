import { describe, expect, it } from "vitest";
import { CliDataExportEventV1Schema } from "../src/cli-contracts.ts";

import {
  CANONICAL_ENTITY_FILES_V1,
  CANONICAL_EXPORT_CONTENT_TYPE,
  CanonicalEntityRecordV1Schema,
  CanonicalExportEventV1Schema,
  CanonicalExportManifestV1Schema,
  CanonicalExportRequestV1Schema,
  CanonicalExportReconciliationV1Schema
} from "../src/canonical-export-contracts.ts";

const ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const HASH = "d".repeat(64);
const TIME = "2026-07-13T01:02:03.004Z";

describe("Canonical Export v1", () => {
  it("冻结 data export CLI 成功与错误机器事件", () => {
    expect(
      CliDataExportEventV1Schema.parse({
        contractVersion: "cortex.cli-data-export-event.v1",
        type: "DATA_EXPORTED",
        exportId: ID,
        manifestSha256: HASH,
        targetPath: "/tmp/export"
      }).type
    ).toBe("DATA_EXPORTED");
    const failure = CliDataExportEventV1Schema.parse({
      contractVersion: "cortex.cli-data-export-event.v1",
      type: "COMMAND_ERROR",
      command: "data export",
      code: "REQUEST_ABORTED",
      exitCode: 130
    });
    expect(failure.type).toBe("COMMAND_ERROR");
    if (failure.type !== "COMMAND_ERROR") throw new Error("TEST_CONTRACT_INVALID");
    expect(failure.exitCode).toBe(130);
  });

  it("请求默认不内嵌 Raw Evidence，但允许调用方显式选择", () => {
    expect(CanonicalExportRequestV1Schema.parse({}).rawEvidenceIncluded).toBe(false);
    expect(
      CanonicalExportRequestV1Schema.parse({ rawEvidenceIncluded: true }).rawEvidenceIncluded
    ).toBe(true);
  });

  it("冻结稳定 JSONL 文件、合约版本和缺失 Raw Artifact 元数据", () => {
    const entityFiles = CANONICAL_ENTITY_FILES_V1.map((file) => ({
      ...file,
      count: file.entityType === "TEST_CASE" ? 1 : 0,
      sha256: HASH,
      sizeBytes: file.entityType === "TEST_CASE" ? 100 : 0
    }));
    const value = {
      contractVersion: "cortex.canonical-export-manifest.v1",
      exportId: ID,
      createdAt: TIME,
      rawEvidenceIncluded: true,
      contractVersions: {
        canonicalExport: "cortex.canonical-export-manifest.v1",
        caseDefinition: "cortex.case-definition.v1"
      },
      entityFiles,
      artifacts: [
        {
          owner: { type: "RUN", key: { id: ID } },
          kind: "RAW_PROMPTFOO_EVIDENCE",
          sourcePath: "runs/raw.jsonl",
          included: false,
          exportPath: null,
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
        entityKey: { id: ID },
        entityHash: HASH,
        payload: { caseKey: "case-1" },
        references: [{ entityType: "TEST_SUITE", entityKey: { id: ID } }]
      }).entityHash
    ).toBe(HASH);
    expect(
      CanonicalExportManifestV1Schema.safeParse({
        ...value,
        entityFiles: [...value.entityFiles].reverse(),
        artifacts: [value.artifacts[0], value.artifacts[0]]
      }).success
    ).toBe(false);
  });

  it("Case/Eval Result 使用显式复合键，其余实体使用 UUID 键", () => {
    expect(
      CanonicalEntityRecordV1Schema.parse({
        contractVersion: "cortex.canonical-entity-record.v1",
        entityType: "CASE_RESULT",
        entityKey: { runId: ID, caseKey: "case-1" },
        entityHash: HASH,
        payload: { status: "SUCCEEDED" },
        references: [{ entityType: "RUN", entityKey: { id: ID } }]
      }).entityKey
    ).toEqual({ runId: ID, caseKey: "case-1" });
    expect(
      CanonicalEntityRecordV1Schema.safeParse({
        contractVersion: "cortex.canonical-entity-record.v1",
        entityType: "EVAL_RESULT",
        entityId: ID,
        entityHash: HASH,
        payload: { status: "PASS" },
        references: []
      }).success
    ).toBe(false);
  });

  it("区分源 Artifact 可用性与是否复制进导出", () => {
    const files = CANONICAL_ENTITY_FILES_V1.map((file) => ({
      ...file,
      count: 0,
      sha256: HASH,
      sizeBytes: 0
    }));
    const base = {
      contractVersion: "cortex.canonical-export-manifest.v1",
      exportId: ID,
      createdAt: TIME,
      rawEvidenceIncluded: true,
      contractVersions: { canonicalExport: "cortex.canonical-export-manifest.v1" },
      entityFiles: files,
      artifacts: []
    };
    expect(
      CanonicalExportManifestV1Schema.safeParse({
        ...base,
        artifacts: [
          {
            owner: { type: "RUN", key: { id: ID } },
            kind: "RAW_PROMPTFOO_EVIDENCE",
            sourcePath: "runs/raw.jsonl",
            included: true,
            exportPath: "artifacts/raw.jsonl",
            expectedSha256: HASH,
            expectedSizeBytes: 10,
            present: false,
            actualSha256: null,
            actualSizeBytes: null
          }
        ]
      }).success
    ).toBe(false);

    const presentOnly = {
      owner: { type: "RUN", key: { id: ID } },
      kind: "REPORT_JSON",
      sourcePath: "runs/report.json",
      included: false,
      exportPath: null,
      expectedSha256: HASH,
      expectedSizeBytes: 10,
      present: true,
      actualSha256: HASH,
      actualSizeBytes: 10
    };
    expect(
      CanonicalExportManifestV1Schema.parse({ ...base, artifacts: [presentOnly] }).artifacts[0]
    ).toMatchObject({ present: true, included: false });
    expect(
      CanonicalExportManifestV1Schema.parse({
        ...base,
        artifacts: [
          {
            ...presentOnly,
            kind: "RAW_PROMPTFOO_EVIDENCE",
            included: true,
            exportPath: `artifacts/runs/${ID}/raw-promptfoo-evidence.bin`
          }
        ]
      }).artifacts[0]
    ).toMatchObject({ present: true, included: true });

    const includedRaw = {
      ...presentOnly,
      kind: "RAW_PROMPTFOO_EVIDENCE",
      included: true,
      exportPath: `artifacts/runs/${ID}/raw-promptfoo-evidence.bin`
    };
    expect(
      CanonicalExportManifestV1Schema.safeParse({
        ...base,
        rawEvidenceIncluded: false,
        artifacts: [includedRaw]
      }).success
    ).toBe(false);
    expect(
      CanonicalExportManifestV1Schema.safeParse({
        ...base,
        artifacts: [{ ...includedRaw, kind: "REPORT_JSON" }]
      }).success
    ).toBe(false);
    expect(
      CanonicalExportManifestV1Schema.safeParse({
        ...base,
        artifacts: [{ ...includedRaw, exportPath: "artifacts/raw.jsonl" }]
      }).success
    ).toBe(false);
  });

  it("冻结独立 Canonical Export NDJSON 传输事件和 Content-Type", () => {
    expect(CANONICAL_EXPORT_CONTENT_TYPE).toBe("application/x-ndjson; charset=utf-8");
    const start = CanonicalExportEventV1Schema.parse({
      type: "EXPORT_START",
      exportId: ID,
      manifest: { path: "manifest.json", sha256: HASH, sizeBytes: 10 }
    });
    expect(start.type).toBe("EXPORT_START");
    if (start.type !== "EXPORT_START") throw new Error("EXPORT_START_EXPECTED");
    expect(start.exportId).toBe(ID);
    expect(
      CanonicalExportEventV1Schema.parse({
        type: "EXPORT_END",
        exportId: ID,
        reconciliation: { path: "reconciliation.json", sha256: HASH, sizeBytes: 10 }
      }).type
    ).toBe("EXPORT_END");
    expect(
      [
        {
          type: "FILE_START",
          file: { path: "entities/test-suites.jsonl", sha256: HASH, sizeBytes: 0 }
        },
        {
          type: "FILE_CHUNK",
          path: "entities/test-suites.jsonl",
          sequence: 0,
          dataBase64: "eA=="
        },
        { type: "FILE_END", path: "entities/test-suites.jsonl" }
      ].map((event) => CanonicalExportEventV1Schema.parse(event).type)
    ).toEqual(["FILE_START", "FILE_CHUNK", "FILE_END"]);
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
    expect(
      CanonicalExportReconciliationV1Schema.parse({
        ...value,
        checks: {
          ...value.checks,
          references: { status: "FAIL", checked: 1 },
          entityHashes: { status: "FAIL", checked: 1 }
        }
      }).checks
    ).toMatchObject({ references: { status: "FAIL" }, entityHashes: { status: "FAIL" } });
  });
});
