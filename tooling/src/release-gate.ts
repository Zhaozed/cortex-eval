import { pathToFileURL } from "node:url";

import type { RuntimeDoctorSmokeReport } from "./runtime-doctor.ts";

/** Stable release-host facts recorded without environment values. */
export interface ReleaseEnvironmentFact {
  /** Supported operating-system family. */
  readonly platform: NodeJS.Platform;
  /** Supported CPU architecture. */
  readonly architecture: string;
  /** Operating-system version. */
  readonly osVersion: string;
  /** CPU model. */
  readonly cpu: string;
  /** Available logical CPU count. */
  readonly logicalCores: number;
  /** Installed physical memory. */
  readonly totalMemoryBytes: number;
  /** Free memory at gate start. */
  readonly freeMemoryBytes: number;
  /** Exact Node version without a leading v. */
  readonly nodeVersion: string;
  /** Exact pnpm version. */
  readonly pnpmVersion: string;
  /** Native SQLite version. */
  readonly sqliteVersion: string;
  /** Exact Promptfoo version. */
  readonly promptfooVersion: string;
}

/** Parsed production dependency vulnerability counts. */
export interface ProductionAuditFact {
  /** Exact safe command identity. */
  readonly command: "pnpm audit --prod --audit-level=high --json --registry=https://registry.npmjs.org";
  /** Advisory counts by severity. */
  readonly vulnerabilities: {
    readonly low: number;
    readonly moderate: number;
    readonly high: number;
    readonly critical: number;
  };
}

/** One real Promptfoo llm-rubric execution fact. */
export interface GeminiRubricSmokeFact {
  /** Provider used by the frozen Evaluator. */
  readonly provider: "GOOGLE_GEMINI";
  /** Exact frozen Evaluator model identifier. */
  readonly model: string;
  /** Exact Promptfoo assertion family. */
  readonly assertionType: "llm-rubric";
  /** Exact external Promptfoo version. */
  readonly promptfooVersion: "0.121.18";
  /** Provider invocation count; retries are forbidden. */
  readonly providerAttempts: number;
  /** Imported component facts proving Assertion execution. */
  readonly componentResults: number;
  /** Native Promptfoo success or assertion-fail status. */
  readonly exitCode: 0 | 100;
}

/** One real direct Gemini Analyzer structured-output fact. */
export interface GeminiAnalyzerSmokeFact {
  /** Provider used by the frozen Analyzer. */
  readonly provider: "GOOGLE_GEMINI";
  /** Exact frozen Analyzer model identifier. */
  readonly model: string;
  /** Provider invocation count; retries are forbidden. */
  readonly providerAttempts: number;
  /** Strict parsed output contract. */
  readonly outputContractVersion: "cortex.analysis-output.v1";
  /** Non-empty structured Evidence count. */
  readonly structuredEvidenceCount: number;
}

/** Explicit external operations used by the release orchestration. */
export interface ReleaseGateDependencies {
  /** Inspect the current host and locked toolchain. */
  readonly environment: () => Promise<ReleaseEnvironmentFact>;
  /** Audit only production dependency reachability. */
  readonly audit: () => Promise<ProductionAuditFact>;
  /** Run interpreter discovery plus real Python/Ruby inline smokes. */
  readonly runtimeDoctor: () => Promise<RuntimeDoctorSmokeReport>;
  /** Run exactly one real Promptfoo llm-rubric Case. */
  readonly rubric: () => Promise<GeminiRubricSmokeFact>;
  /** Run exactly one real direct Analyzer structured call. */
  readonly analyzer: () => Promise<GeminiAnalyzerSmokeFact>;
}

/** Complete facts emitted only after every release gate passes. */
export interface ReleaseGateReport {
  /** Report schema identity. */
  readonly contractVersion: "cortex.release-gate-report.v1";
  /** Current supported host facts. */
  readonly environment: ReleaseEnvironmentFact;
  /** Production dependency audit facts. */
  readonly audit: ProductionAuditFact;
  /** Runtime Doctor facts including both inline language smokes. */
  readonly runtimeDoctor: RuntimeDoctorSmokeReport;
  /** Non-deterministic live provider facts. */
  readonly live: {
    readonly rubric: GeminiRubricSmokeFact;
    readonly analyzer: GeminiAnalyzerSmokeFact;
  };
}

// Reject an environment outside the only platform actually supported by current requirements.
function validateEnvironment(value: ReleaseEnvironmentFact): void {
  if (
    value.platform !== "darwin" ||
    value.architecture !== "arm64" ||
    value.logicalCores < 4 ||
    value.totalMemoryBytes < 8 * 1024 * 1024 * 1024 ||
    value.nodeVersion.split(".")[0] !== "24" ||
    value.promptfooVersion !== "0.121.18"
  ) {
    throw new Error("RELEASE_PLATFORM_UNSUPPORTED");
  }
}

// Fail closed when the package manager reports an exploitable production advisory.
function validateAudit(value: ProductionAuditFact): void {
  if (value.vulnerabilities.high !== 0 || value.vulnerabilities.critical !== 0) {
    throw new Error("RELEASE_AUDIT_FAILED");
  }
}

// Verify that the doctor used the same fixed Promptfoo runtime and both interpreters really ran.
function validateRuntimeDoctor(value: RuntimeDoctorSmokeReport): void {
  if (
    value.promptfooVersion !== "0.121.18" ||
    value.pythonInlineAssertion.exitCode !== 0 ||
    value.pythonInlineAssertion.componentResults < 1 ||
    value.rubyInlineAssertion.exitCode !== 0 ||
    value.rubyInlineAssertion.componentResults < 1
  ) {
    throw new Error("RELEASE_RUNTIME_DOCTOR_FAILED");
  }
}

// Prove the live rubric traversed Promptfoo once without an automatic provider retry.
function validateRubric(value: GeminiRubricSmokeFact): void {
  if (value.model.trim() === "" || value.providerAttempts !== 1 || value.componentResults < 1) {
    throw new Error("RELEASE_RUBRIC_INVALID");
  }
}

// Prove the live Analyzer returned the strict structured Evidence contract in one attempt.
function validateAnalyzer(value: GeminiAnalyzerSmokeFact): void {
  if (
    value.model.trim() === "" ||
    value.providerAttempts !== 1 ||
    value.structuredEvidenceCount < 1
  ) {
    throw new Error("RELEASE_ANALYZER_INVALID");
  }
}

/** Execute every non-optional release gate in a single ordered invocation. */
export async function runReleaseGate(
  dependencies: ReleaseGateDependencies
): Promise<ReleaseGateReport> {
  const environment = await dependencies.environment();
  validateEnvironment(environment);
  const audit = await dependencies.audit();
  validateAudit(audit);
  const runtimeDoctor = await dependencies.runtimeDoctor();
  validateRuntimeDoctor(runtimeDoctor);
  const rubric = await dependencies.rubric();
  validateRubric(rubric);
  const analyzer = await dependencies.analyzer();
  validateAnalyzer(analyzer);
  return {
    contractVersion: "cortex.release-gate-report.v1",
    environment,
    audit,
    runtimeDoctor,
    live: { rubric, analyzer }
  };
}

// Keep imports side-effect free so deterministic tests can inject every external operation.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { createProductionReleaseGateDependencies } = await import("./release-gate-production.ts");
  const report = await runReleaseGate(createProductionReleaseGateDependencies(process.cwd()));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
