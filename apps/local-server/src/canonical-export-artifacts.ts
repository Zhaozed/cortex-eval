import type { CanonicalExpectedArtifact } from "@cortex-eval/application/src/features/canonical-export/canonical-export-projection-service.ts";
import {
  canonicalRunRawEvidenceExportPath,
  type CanonicalExportManifestV1
} from "@cortex-eval/contracts/src/canonical-export-contracts.ts";
import { SecureWorkPackageDirectory } from "@cortex-eval/work-package/src/secure-work-package-directory.ts";
import { createHash } from "node:crypto";

import type { CanonicalExportWorkspace } from "./canonical-export-workspace.ts";

type CanonicalArtifact = CanonicalExportManifestV1["artifacts"][number];

interface ArtifactFacts {
  /** SHA-256 calculated from the stable source descriptor. */
  readonly sha256: string;
  /** Exact bytes consumed from the stable source descriptor. */
  readonly sizeBytes: number;
}

// Build the exact binary ordering identity required by the Manifest contract.
function artifactIdentity(artifact: CanonicalExpectedArtifact): string {
  return `${artifact.owner.type}\u0000${artifact.owner.key.id}\u0000${artifact.kind}`;
}

// Return the deterministic destination used only for opted-in Raw evidence.
function rawExportPath(artifact: CanonicalExpectedArtifact): string {
  return canonicalRunRawEvidenceExportPath(artifact.owner.key.id);
}

// Consume one stable source file without materializing it in memory.
async function hashSource(
  directory: SecureWorkPackageDirectory,
  artifact: CanonicalExpectedArtifact
): Promise<ArtifactFacts> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of directory.streamFile(artifact.sourcePath, artifact.expectedSizeBytes)) {
    hash.update(chunk);
    sizeBytes += chunk.byteLength;
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

// Preserve expected metadata while making an unavailable source explicit.
function unavailableArtifact(artifact: CanonicalExpectedArtifact): CanonicalArtifact {
  return {
    owner: artifact.owner,
    kind: artifact.kind,
    sourcePath: artifact.sourcePath,
    included: false,
    exportPath: null,
    expectedSha256: artifact.expectedSha256,
    expectedSizeBytes: artifact.expectedSizeBytes,
    present: false,
    actualSha256: null,
    actualSizeBytes: null
  };
}

// Decide whether computed bytes are exactly the persisted immutable Artifact.
function matchesExpected(artifact: CanonicalExpectedArtifact, facts: ArtifactFacts): boolean {
  return facts.sha256 === artifact.expectedSha256 && facts.sizeBytes === artifact.expectedSizeBytes;
}

// Validate one source and optionally copy the only currently includable Artifact kind.
async function collectOne(
  directory: SecureWorkPackageDirectory,
  workspace: CanonicalExportWorkspace,
  artifact: CanonicalExpectedArtifact,
  includeRawEvidence: boolean
): Promise<CanonicalArtifact> {
  const shouldInclude = includeRawEvidence && artifact.kind === "RAW_PROMPTFOO_EVIDENCE";
  if (!shouldInclude) {
    const facts = await hashSource(directory, artifact);
    if (!matchesExpected(artifact, facts)) return unavailableArtifact(artifact);
    return {
      owner: artifact.owner,
      kind: artifact.kind,
      sourcePath: artifact.sourcePath,
      included: false,
      exportPath: null,
      expectedSha256: artifact.expectedSha256,
      expectedSizeBytes: artifact.expectedSizeBytes,
      present: true,
      actualSha256: facts.sha256,
      actualSizeBytes: facts.sizeBytes
    };
  }

  const exportPath = rawExportPath(artifact);
  const facts = await workspace.writeBinary(
    exportPath,
    directory.streamFile(artifact.sourcePath, artifact.expectedSizeBytes)
  );
  if (!matchesExpected(artifact, facts)) {
    await workspace.remove(exportPath);
    return unavailableArtifact(artifact);
  }
  return {
    owner: artifact.owner,
    kind: artifact.kind,
    sourcePath: artifact.sourcePath,
    included: true,
    exportPath,
    expectedSha256: artifact.expectedSha256,
    expectedSizeBytes: artifact.expectedSizeBytes,
    present: true,
    actualSha256: facts.sha256,
    actualSizeBytes: facts.sizeBytes
  };
}

/**
 * Resolve Artifact source availability independently from Raw inclusion.
 * Missing, changed, linked or otherwise unsafe source files remain migration metadata and do not
 * abort the normalized entity export.
 */
export async function collectCanonicalArtifacts(
  artifactRoot: string,
  workspace: CanonicalExportWorkspace,
  dirtyArtifacts: readonly CanonicalExpectedArtifact[],
  includeRawEvidence: boolean
): Promise<readonly CanonicalArtifact[]> {
  const artifacts = [...dirtyArtifacts].sort((left, right) => {
    const leftIdentity = artifactIdentity(left);
    const rightIdentity = artifactIdentity(right);
    if (leftIdentity === rightIdentity) return 0;
    return leftIdentity < rightIdentity ? -1 : 1;
  });
  for (let index = 1; index < artifacts.length; index += 1) {
    const previous = artifacts[index - 1];
    const current = artifacts[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      artifactIdentity(previous) === artifactIdentity(current)
    ) {
      throw new Error("CANONICAL_ARTIFACT_DUPLICATE");
    }
  }

  let directory: SecureWorkPackageDirectory;
  try {
    directory = await SecureWorkPackageDirectory.open(artifactRoot);
  } catch {
    return artifacts.map(unavailableArtifact);
  }

  try {
    const collected: CanonicalArtifact[] = [];
    for (const artifact of artifacts) {
      try {
        collected.push(await collectOne(directory, workspace, artifact, includeRawEvidence));
      } catch {
        collected.push(unavailableArtifact(artifact));
      }
    }
    return collected;
  } finally {
    directory.close();
  }
}
