import { assertionDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import type {
  AnalysisProposalDraft,
  ReplaceAssertionProposalDraft
} from "@cortex-eval/domain/src/domain-analysis.ts";
import type {
  AssertionDefinition,
  CaseDefinition
} from "@cortex-eval/domain/src/domain-evaluation.ts";
import {
  hashAssertionDefinition,
  hashCaseDefinition
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { describe, expect, it } from "vitest";

import { applyAnalysisProposal } from "../src/features/case-analysis/analysis-proposal-applier.ts";

function assertion(value: string): AssertionDefinition {
  return { type: "equals", metric: "answer", weight: 1, value };
}

function definition(
  assertions: readonly AssertionDefinition[] = [assertion("old")]
): CaseDefinition {
  return {
    caseKey: "case-1",
    description: "Case",
    threshold: 1,
    task: "reply",
    requestBody: { input: "hello" },
    metadata: {
      requestId: "req-1",
      taskId: "task-1",
      businessModule: "chat",
      scenarioTag: "normal"
    },
    assertions
  };
}

function caseHash(value: CaseDefinition): string {
  return hashCaseDefinition({
    contractVersion: "cortex.case-definition.v1",
    caseKey: value.caseKey,
    definition: {
      contractVersion: "cortex.case-definition.v1",
      description: value.description,
      threshold: value.threshold,
      vars: { task: value.task, request_body: value.requestBody },
      metadata: {
        case_id: value.caseKey,
        req_id: value.metadata.requestId,
        task_id: value.metadata.taskId,
        business_module: value.metadata.businessModule,
        scenario_tag: value.metadata.scenarioTag
      },
      assert: value.assertions.map(assertionDefinitionJson)
    }
  });
}

function assertionHash(value: AssertionDefinition): string {
  return hashAssertionDefinition({
    contractVersion: "cortex.assertion-definition.v1",
    definition: assertionDefinitionJson(value)
  });
}

describe("applyAnalysisProposal", () => {
  it("按判别动作生成完整 Case，保留稳定身份并支持尾部插入", () => {
    const current = definition();
    const baseDefinitionHash = caseHash(current);
    const added = applyAnalysisProposal(current, baseDefinitionHash, {
      action: "ADD_ASSERTION",
      baseDefinitionHash,
      targetAssertionIndex: 1,
      assertion: assertion("added")
    });
    expect(added).toEqual({
      ok: true,
      definition: definition([assertion("old"), assertion("added")])
    });

    const replacement: AnalysisProposalDraft = {
      action: "REPLACE_CASE",
      baseDefinitionHash,
      casePayload: { ...current, description: "replacement" }
    };
    expect(applyAnalysisProposal(current, baseDefinitionHash, replacement)).toMatchObject({
      ok: true,
      definition: { caseKey: "case-1", description: "replacement" }
    });
  });

  it("替换和删除 Assertion 时校验冻结索引与 Definition Hash", () => {
    const first = assertion("first");
    const second = assertion("second");
    const current = definition([first, second]);
    const baseDefinitionHash = caseHash(current);
    const proposal: ReplaceAssertionProposalDraft = {
      action: "REPLACE_ASSERTION",
      baseDefinitionHash,
      targetAssertionIndex: 1,
      targetAssertionDefinitionHash: assertionHash(second),
      assertion: assertion("new")
    };
    expect(applyAnalysisProposal(current, baseDefinitionHash, proposal)).toEqual({
      ok: true,
      definition: definition([first, assertion("new")])
    });
    expect(
      applyAnalysisProposal(current, baseDefinitionHash, {
        action: "REMOVE_ASSERTION",
        baseDefinitionHash,
        targetAssertionIndex: 0,
        targetAssertionDefinitionHash: assertionHash(first)
      })
    ).toEqual({ ok: true, definition: definition([second]) });

    expect(
      applyAnalysisProposal(current, baseDefinitionHash, {
        ...proposal,
        targetAssertionDefinitionHash: "0".repeat(64)
      })
    ).toEqual({ ok: false, reason: "TARGET_ASSERTION_CONFLICT" });
  });

  it("拒绝过期 Base、越界目标和改变 Case 身份的完整替换", () => {
    const current = definition();
    const baseDefinitionHash = caseHash(current);
    expect(
      applyAnalysisProposal(current, "0".repeat(64), {
        action: "ADD_ASSERTION",
        baseDefinitionHash: "0".repeat(64),
        targetAssertionIndex: 0,
        assertion: assertion("new")
      })
    ).toEqual({ ok: false, reason: "BASE_DEFINITION_CONFLICT" });
    expect(
      applyAnalysisProposal(current, baseDefinitionHash, {
        action: "ADD_ASSERTION",
        baseDefinitionHash,
        targetAssertionIndex: 2,
        assertion: assertion("new")
      })
    ).toEqual({ ok: false, reason: "TARGET_ASSERTION_CONFLICT" });
    expect(
      applyAnalysisProposal(current, baseDefinitionHash, {
        action: "REPLACE_CASE",
        baseDefinitionHash,
        casePayload: { ...current, caseKey: "case-2" }
      })
    ).toEqual({ ok: false, reason: "CASE_IDENTITY_CONFLICT" });
  });
});
