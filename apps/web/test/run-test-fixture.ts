import type {
  PlatformRunDetail,
  PlatformRunPage,
  RunCaseDetail,
  RunCasePage,
  RunEvalPage,
  RunPreflight,
  RunProgress,
  RunReportCase,
  RunReportOverview
} from "../src/lib/run-api.ts";

/** Stable Run fixture identity. */
export const RUN_ID = "018f0f4e-7b7a-7cc0-8000-000000000001";
/** Stable Suite fixture identity. */
export const SUITE_ID = "018f0f4e-7b7a-7cc0-8000-000000000002";
/** Stable Endpoint fixture identity. */
export const ENDPOINT_ID = "018f0f4e-7b7a-7cc0-8000-000000000003";
/** Stable Evaluator fixture identity. */
export const EVALUATOR_ID = "018f0f4e-7b7a-7cc0-8000-000000000004";
/** Stable timestamp shared by fixtures. */
export const RUN_TIME = "2026-07-13T00:00:00.000Z";
const HASH = "a".repeat(64);

/** Build one valid platform Run detail with selected progress overrides. */
export function runDetail(
  overrides: Partial<
    Pick<
      PlatformRunDetail,
      | "status"
      | "stage"
      | "lockRevision"
      | "rest"
      | "evaluation"
      | "cancelRequestedAt"
      | "startedAt"
    >
  > = {}
): PlatformRunDetail {
  return {
    id: RUN_ID,
    sourceType: "PLATFORM",
    sourceRunId: null,
    rerunMode: "NONE",
    suite: { id: SUITE_ID, name: "客服回归集", hash: HASH, caseCount: 3 },
    endpoint: {
      sourceId: ENDPOINT_ID,
      name: "客服 Endpoint",
      configHash: HASH,
      config: {
        contractVersion: "cortex.endpoint-config.v1",
        urlTemplate: "https://example.test/tasks/{{vars.task}}",
        method: "POST",
        headers: {},
        bodySelector: "/request_body",
        timeoutMs: 60_000,
        defaultConcurrency: 4
      }
    },
    evaluator: {
      sourceId: EVALUATOR_ID,
      name: "Gemini Evaluator",
      configHash: HASH,
      config: {
        contractVersion: "cortex.llm-config.v1",
        providerType: "GOOGLE_GEMINI",
        model: "gemini-2.5-flash",
        thinkingLevel: "LOW",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 1024,
        timeoutMs: 60_000,
        structuredOutput: "JSON_OBJECT",
        apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" }
      }
    },
    rubricPrompts: [{ promptKey: "quality", name: "质量", promptHash: HASH }],
    promptfooVersion: "0.121.18",
    contractVersions: {
      runSnapshot: "cortex.run-snapshot.v1",
      caseDefinition: "cortex.case-definition.v1",
      platformRestResults: "cortex.platform-rest-results.v1"
    },
    runContextHash: HASH,
    runExecutionLimits: {
      contractVersion: "cortex.run-execution-limits.v1",
      restConcurrency: 4,
      evalConcurrency: 2
    },
    runMode: "STAGED",
    status: overrides.status ?? "READY",
    stage: overrides.stage ?? "REST",
    lockRevision: overrides.lockRevision ?? 0,
    cancelRequestedAt: overrides.cancelRequestedAt ?? null,
    rest: overrides.rest ?? { total: 3, completed: 0, succeeded: 0, error: 0 },
    evaluation: overrides.evaluation ?? {
      total: 3,
      completed: 0,
      passed: 0,
      failed: 0,
      error: 0,
      notEvaluated: 0
    },
    artifactManifest: {
      contractVersion: "cortex.artifact-manifest.v1",
      owner: { kind: "RUN", id: RUN_ID },
      artifacts: []
    },
    artifactAvailability: [],
    errorCode: null,
    startedAt: overrides.startedAt ?? null,
    completedAt: null,
    createdAt: RUN_TIME,
    updatedAt: RUN_TIME
  };
}

/** Valid Run preflight fixture. */
export const runPreflight: RunPreflight = {
  suiteId: SUITE_ID,
  endpointConfigId: ENDPOINT_ID,
  evaluatorConfigId: EVALUATOR_ID,
  caseCount: 3,
  rubricPromptKeys: ["quality"],
  requiredEnvKeys: { REST: ["REST_TOKEN"], EVALUATION: ["GEMINI_API_KEY"] },
  endpointTimeoutMs: 60_000,
  defaultRunExecutionLimits: {
    contractVersion: "cortex.run-execution-limits.v1",
    restConcurrency: 4,
    evalConcurrency: 2
  }
};

/** Build one recent Run page fixture. */
export function runPage(detail = runDetail()): PlatformRunPage {
  return {
    items: [
      {
        id: detail.id,
        sourceType: detail.sourceType,
        suiteId: detail.suite.id,
        suiteName: detail.suite.name,
        runMode: detail.runMode,
        status: detail.status,
        stage: detail.stage,
        lockRevision: detail.lockRevision,
        cancelRequestedAt: detail.cancelRequestedAt,
        rest: detail.rest,
        evaluation: detail.evaluation,
        createdAt: detail.createdAt,
        updatedAt: detail.updatedAt
      }
    ],
    nextCursor: null
  };
}

/** Valid successful REST Case detail fixture. */
export const runCaseDetail: RunCaseDetail = {
  runId: RUN_ID,
  caseKey: "case-1",
  ordinal: 0,
  caseDefinitionHash: HASH,
  definition: {
    contractVersion: "cortex.case-definition.v1",
    description: "客服请求",
    threshold: 1,
    vars: { task: "route", request_body: { input: "你好" } },
    metadata: {
      req_id: "req-1",
      task_id: "task-1",
      case_id: "case-1",
      business_module: "客服",
      scenario_tag: "smoke"
    },
    assert: [{ type: "equals", metric: "quality", value: true, weight: 1 }]
  },
  status: "SUCCEEDED",
  httpStatus: 200,
  providerOutput: {
    ok: true,
    task_name: "route",
    resolved_config: {},
    parsed_output: { reply: "你好" }
  },
  error: null,
  durationMs: 25,
  completedAt: RUN_TIME,
  resultHash: HASH
};

/** Valid one-item REST Case page fixture. */
export const runCasePage: RunCasePage = {
  items: [
    {
      runId: RUN_ID,
      caseKey: "case-1",
      ordinal: 0,
      status: "SUCCEEDED",
      httpStatus: 200,
      errorType: null,
      durationMs: 25,
      completedAt: RUN_TIME,
      resultHash: HASH
    }
  ],
  nextCursor: null
};

/** Valid observed and Evaluation-error page fixture. */
export const runEvalPage: RunEvalPage = {
  items: [
    {
      runId: RUN_ID,
      createdAt: RUN_TIME,
      updatedAt: RUN_TIME,
      result: {
        caseKey: "case-1",
        ordinal: 0,
        status: "PASS",
        promptfooSuccess: true,
        score: 1,
        reason: "匹配成功",
        evaluationError: null,
        assertions: [
          {
            index: 0,
            definitionHash: HASH,
            type: "equals",
            metric: "quality",
            weight: 1,
            status: "PASS",
            score: 1,
            reason: "断言匹配"
          }
        ],
        diffs: [],
        metrics: [{ metric: "quality", status: "PASS" }],
        latencyMs: null,
        tokenUsage: null,
        cost: null,
        rawEvidence: {
          present: true,
          path: `runs/${RUN_ID}/promptfoo-raw.json`,
          expectedSha256: HASH,
          expectedSizeBytes: 128
        },
        evalResultHash: HASH,
        finalCaseResultHash: HASH,
        provenance: null
      }
    },
    {
      runId: RUN_ID,
      createdAt: RUN_TIME,
      updatedAt: RUN_TIME,
      result: {
        caseKey: "case-2",
        ordinal: 1,
        status: "EVALUATION_ERROR",
        promptfooSuccess: null,
        score: null,
        reason: null,
        evaluationError: { code: "EVALUATOR_TIMEOUT" },
        assertions: [],
        diffs: [],
        metrics: [{ metric: "quality", status: "ERROR" }],
        latencyMs: null,
        tokenUsage: null,
        cost: null,
        rawEvidence: {
          present: true,
          path: `runs/${RUN_ID}/promptfoo-raw.json`,
          expectedSha256: HASH,
          expectedSizeBytes: 128
        },
        evalResultHash: HASH,
        finalCaseResultHash: HASH,
        provenance: null
      }
    }
  ],
  nextCursor: null
};

// Read the deterministic first Evaluation fixture without using a type assertion.
function reportEvaluation(): RunEvalPage["items"][number]["result"] {
  const item = runEvalPage.items[0];
  if (item === undefined) throw new Error("RUN_EVAL_FIXTURE_MISSING");
  return item.result;
}

/** Complete imported Report overview fixture. */
export const runReportOverview: RunReportOverview = {
  runId: RUN_ID,
  sourceType: "OFFLINE_IMPORT",
  sourceRunId: null,
  rerunMode: "NONE",
  completedAt: RUN_TIME,
  context: {
    contractVersion: "cortex.report-context.v1",
    runContextHash: HASH,
    suite: { sourceId: SUITE_ID, name: "客服回归集", suiteHash: HASH },
    endpoint: {
      sourceId: ENDPOINT_ID,
      name: "客服 Endpoint",
      configHash: HASH,
      config: runDetail().endpoint.config
    },
    evaluator: {
      sourceId: EVALUATOR_ID,
      name: "Gemini Evaluator",
      configHash: HASH,
      config: runDetail().evaluator.config
    },
    rubricPrompts: [],
    promptfooVersion: "0.121.18",
    runExecutionLimits: runDetail().runExecutionLimits
  },
  evaluationContextHash: HASH,
  evaluationResultSetHash: HASH,
  reportResultSetHash: HASH,
  summary: {
    total: 1,
    restSucceeded: 1,
    restError: 0,
    evalPass: 1,
    evalFail: 0,
    evalError: 0,
    notEvaluated: 0,
    effectivePassRate: 1,
    evaluatedPassRate: 1,
    coverageRate: 1
  },
  byMetric: [
    {
      metric: "quality",
      pass: 1,
      fail: 0,
      error: 0,
      skipped: 0,
      notEvaluated: 0,
      passRate: 1
    }
  ],
  artifactAvailability: [
    {
      kind: "RAW_PROMPTFOO_EVIDENCE",
      path: `executions/${RUN_ID}/promptfoo-raw.json`,
      status: "MISSING"
    }
  ]
};

/** Complete normalized Report Case fixture with one Assertion and missing Raw evidence. */
export const runReportCase: RunReportCase = {
  caseKey: "case-1",
  ordinal: 0,
  definitionHash: HASH,
  definition: runCaseDetail.definition,
  rest: {
    caseKey: "case-1",
    ordinal: 0,
    caseDefinitionHash: HASH,
    status: "SUCCEEDED",
    httpStatus: 200,
    providerOutput: runCaseDetail.providerOutput,
    durationMs: runCaseDetail.durationMs,
    completedAt: RUN_TIME,
    resultHash: HASH,
    provenance: null
  },
  evaluation: reportEvaluation(),
  rawEvidenceStatus: "MISSING"
};

/** Convert one detail into its mutation progress projection. */
export function runProgress(detail: PlatformRunDetail): RunProgress {
  return {
    runId: detail.id,
    status: detail.status,
    stage: detail.stage,
    lockRevision: detail.lockRevision,
    cancelRequestedAt: detail.cancelRequestedAt,
    rest: detail.rest,
    evaluation: detail.evaluation,
    updatedAt: detail.updatedAt
  };
}
