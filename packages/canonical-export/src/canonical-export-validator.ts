import { createHash } from "node:crypto";

import {
  CanonicalEntityRecordV1Schema,
  CanonicalExportManifestV1Schema,
  CanonicalExportReconciliationV1Schema,
  type CanonicalEntityRecordV1,
  type CanonicalExportManifestV1,
  type CanonicalExportReconciliationV1
} from "@cortex-eval/contracts/src/canonical-export-contracts.ts";
import {
  sha256CanonicalJson,
  type DomainJsonObject
} from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import type { SecureWorkPackageDirectory } from "@cortex-eval/work-package/src/secure-work-package-directory.ts";

const MAXIMUM_ENTITY_LINE_BYTES = 96 * 1024 * 1024;

interface FileFacts {
  /** SHA-256 over all consumed bytes. */
  readonly sha256: string;
  /** Exact bytes consumed. */
  readonly sizeBytes: number;
}

// Return one PASS/FAIL result without weakening its exact checked count.
function check(status: boolean, checked: number): { status: "PASS" | "FAIL"; checked: number } {
  return { status: status ? "PASS" : "FAIL", checked };
}

// Copy an entity key into the pure canonical hash boundary.
function keyJson(entityKey: CanonicalEntityRecordV1["entityKey"]): DomainJsonObject {
  return "id" in entityKey
    ? { id: entityKey.id }
    : { runId: entityKey.runId, caseKey: entityKey.caseKey };
}

// Build one exact type-qualified identity for ordering and reference lookup.
function qualifiedKey(
  entityType: CanonicalEntityRecordV1["entityType"],
  entityKey: CanonicalEntityRecordV1["entityKey"]
): string {
  const key =
    "id" in entityKey
      ? `id\u0000${entityKey.id}`
      : `result\u0000${entityKey.runId}\u0000${entityKey.caseKey}`;
  return `${entityType}\u0000${key}`;
}

// Recompute the semantic hash from every identity and reference-bearing fact.
function entityHash(record: CanonicalEntityRecordV1): string {
  return sha256CanonicalJson({
    entityType: record.entityType,
    entityKey: keyJson(record.entityKey),
    payload: record.payload,
    references: record.references.map((reference) => ({
      entityType: reference.entityType,
      entityKey: keyJson(reference.entityKey)
    }))
  });
}

// Stream one entity file once while hashing exact bytes and enforcing LF termination.
async function* entityLines(
  directory: SecureWorkPackageDirectory,
  path: string,
  maximumBytes: number,
  facts: { hash: ReturnType<typeof createHash>; sizeBytes: number }
): AsyncGenerator<string> {
  let pending: Buffer = Buffer.alloc(0);
  for await (const chunk of directory.streamFile(path, maximumBytes)) {
    facts.hash.update(chunk);
    facts.sizeBytes += chunk.byteLength;
    pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
    let newline = pending.indexOf(0x0a);
    while (newline >= 0) {
      if (newline + 1 > MAXIMUM_ENTITY_LINE_BYTES) {
        throw new Error("CANONICAL_ENTITY_LINE_TOO_LARGE");
      }
      const line = pending.subarray(0, newline);
      if (line.byteLength === 0) throw new Error("CANONICAL_ENTITY_LINE_INVALID");
      yield new TextDecoder("utf-8", { fatal: true }).decode(line);
      pending = pending.subarray(newline + 1);
      newline = pending.indexOf(0x0a);
    }
    if (pending.byteLength + 1 > MAXIMUM_ENTITY_LINE_BYTES) {
      throw new Error("CANONICAL_ENTITY_LINE_TOO_LARGE");
    }
  }
  if (pending.byteLength !== 0) throw new Error("CANONICAL_ENTITY_STREAM_TRUNCATED");
}

// Hash one immutable non-entity file without loading it into memory.
async function hashFile(
  directory: SecureWorkPackageDirectory,
  path: string,
  maximumBytes: number
): Promise<FileFacts> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of directory.streamFile(path, maximumBytes)) {
    hash.update(chunk);
    sizeBytes += chunk.byteLength;
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

/** Independently reopen one export and recompute all four reconciliation classes. */
export async function reconcileCanonicalExportDirectory(
  directory: SecureWorkPackageDirectory,
  dirtyManifest: CanonicalExportManifestV1
): Promise<CanonicalExportReconciliationV1> {
  const manifest = CanonicalExportManifestV1Schema.parse(dirtyManifest);
  const availableKeys = new Set<string>();
  const references: CanonicalEntityRecordV1["references"][number][] = [];
  let countsPass = true;
  let entityHashesPass = true;
  let fileHashesPass = true;
  let countsChecked = 0;
  let entityHashesChecked = 0;
  let fileHashesChecked = 0;

  for (const file of manifest.entityFiles) {
    let observedCount = 0;
    let previousKey: string | null = null;
    const facts = { hash: createHash("sha256"), sizeBytes: 0 };
    fileHashesChecked += 1;
    try {
      for await (const line of entityLines(directory, file.path, file.sizeBytes, facts)) {
        observedCount += 1;
        const record = CanonicalEntityRecordV1Schema.parse(JSON.parse(line) as unknown);
        if (record.entityType !== file.entityType) countsPass = false;
        const currentKey = qualifiedKey(record.entityType, record.entityKey);
        if (previousKey !== null && currentKey <= previousKey) countsPass = false;
        previousKey = currentKey;
        availableKeys.add(currentKey);
        references.push(...record.references);
        entityHashesChecked += 1;
        if (entityHash(record) !== record.entityHash) entityHashesPass = false;
      }
      const sha256 = facts.hash.digest("hex");
      if (sha256 !== file.sha256 || facts.sizeBytes !== file.sizeBytes) fileHashesPass = false;
    } catch {
      countsPass = false;
      entityHashesPass = false;
      fileHashesPass = false;
    }
    countsChecked += observedCount;
    if (observedCount !== file.count) countsPass = false;
  }

  for (const artifact of manifest.artifacts) {
    if (
      artifact.exportPath === null ||
      artifact.actualSha256 === null ||
      artifact.actualSizeBytes === null
    ) {
      continue;
    }
    fileHashesChecked += 1;
    try {
      const facts = await hashFile(directory, artifact.exportPath, artifact.actualSizeBytes);
      if (facts.sha256 !== artifact.actualSha256 || facts.sizeBytes !== artifact.actualSizeBytes) {
        fileHashesPass = false;
      }
    } catch {
      fileHashesPass = false;
    }
  }

  let referencesPass = true;
  for (const reference of references) {
    if (!availableKeys.has(qualifiedKey(reference.entityType, reference.entityKey))) {
      referencesPass = false;
    }
  }
  return CanonicalExportReconciliationV1Schema.parse({
    contractVersion: "cortex.canonical-export-reconciliation.v1",
    exportId: manifest.exportId,
    checks: {
      counts: check(countsPass, countsChecked),
      references: check(referencesPass, references.length),
      entityHashes: check(entityHashesPass, entityHashesChecked),
      fileHashes: check(fileHashesPass, fileHashesChecked)
    }
  });
}
