const suiteId = "018f0f4e-7b7a-7cc0-8000-000000000001";
const caseId = "018f0f4e-7b7a-7cc0-8000-000000000002";
const timestamp = "2026-07-13T00:00:00.000Z";
const suite = {
  id: suiteId,
  name: "客服回归集",
  description: "核心客服场景",
  caseCount: 1,
  suiteHash: "a".repeat(64),
  revision: 5,
  createdAt: timestamp,
  updatedAt: timestamp
};
const definition = {
  contractVersion: "cortex.case-definition.v1",
  description: "原 Case 描述",
  threshold: 0.8,
  vars: { task: "回答", request_body: {} },
  metadata: {
    case_id: "case-001",
    req_id: "req-001",
    task_id: "task-001",
    business_module: "客服",
    scenario_tag: "正常"
  },
  assert: [{ type: "equals", metric: "quality", value: "ok" }]
} as const;
const summary = {
  id: caseId,
  suiteId,
  caseKey: "case-001",
  ordinal: 0,
  description: definition.description,
  businessModule: "客服",
  scenarioTag: "正常",
  assertionTypes: ["equals"],
  metrics: ["quality"],
  revision: 3,
  updatedAt: timestamp
};
const detail = {
  ...summary,
  definition,
  definitionHash: "b".repeat(64),
  rubricPromptKeys: [],
  createdAt: timestamp
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export { definition, detail, response, suite, suiteId, summary };
