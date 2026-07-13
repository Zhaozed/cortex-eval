import type { CaseDefinitionV1 } from "@cortex-eval/contracts/src/case-contracts.ts";

import { message } from "../../messages/messages.ts";

/** Create one valid editable Case template without persisting it. */
export function createDefaultCaseDefinition(): CaseDefinitionV1 {
  const suffix = crypto.randomUUID().slice(0, 8);
  const caseKey = `case-${suffix}`;
  return {
    contractVersion: "cortex.case-definition.v1",
    description: message("caseCreate.defaultDescription"),
    threshold: 1,
    vars: { task: message("caseCreate.defaultTask"), request_body: {} },
    metadata: {
      case_id: caseKey,
      req_id: `req-${suffix}`,
      task_id: `task-${suffix}`,
      business_module: message("caseCreate.defaultModule"),
      scenario_tag: message("caseCreate.defaultScenario")
    },
    assert: [{ type: "equals", metric: "default", value: true }]
  };
}
