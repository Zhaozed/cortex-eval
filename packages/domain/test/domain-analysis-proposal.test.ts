import { describe, expect, it } from "vitest";

import { validateAnalysisResult, type AnalysisProposalDraft } from "../src/domain-analysis.ts";

describe("Analysis Proposal 判别联合", () => {
  const validResult = {
    classification: "LABEL_ERROR" as const,
    confidence: 0.9,
    evidence: ["invalid label"],
    explanation: "wrong expected value",
    recommendedAction: "fix case"
  };

  it("接受单个完整 Proposal", () => {
    expect(
      validateAnalysisResult({
        classification: "PARAMETER_VARIANCE",
        confidence: 0.8,
        evidence: ["tool args are equivalent"],
        explanation: "equivalent query",
        recommendedAction: "replace assertion",
        proposal: {
          action: "REPLACE_ASSERTION",
          baseDefinitionHash: "a".repeat(64),
          targetAssertionIndex: 1,
          targetAssertionDefinitionHash: "b".repeat(64),
          assertion: { type: "equals", metric: "tool", value: "new" }
        }
      }).ok
    ).toBe(true);
  });

  it("拒绝动作与 Payload 错配", () => {
    expect(
      validateAnalysisResult({
        classification: "LABEL_ERROR",
        confidence: 0.9,
        evidence: ["invalid label"],
        explanation: "wrong expected value",
        recommendedAction: "remove assertion",
        proposal: {
          action: "REMOVE_ASSERTION",
          baseDefinitionHash: "a".repeat(64),
          targetAssertionIndex: 0,
          targetAssertionDefinitionHash: "b".repeat(64),
          assertion: { type: "equals", metric: "unexpected", value: "extra" }
        } as AnalysisProposalDraft
      })
    ).toEqual({
      ok: false,
      error: { code: "ANALYSIS_PROPOSAL_INVALID", path: "proposal.assertion" }
    });
  });

  it("拒绝每一种不完整或互相冲突的 Proposal 形状", () => {
    const hash = "a".repeat(64);
    const targetHash = "b".repeat(64);
    const assertion = { type: "equals", metric: "answer", value: "ok" };
    const invalid = [
      { action: "REPLACE_CASE" as const, baseDefinitionHash: "bad" },
      { action: "REPLACE_CASE" as const, baseDefinitionHash: hash },
      {
        action: "REPLACE_CASE" as const,
        baseDefinitionHash: hash,
        casePayload: {},
        assertion
      },
      { action: "ADD_ASSERTION" as const, baseDefinitionHash: hash, targetAssertionIndex: 0 },
      {
        action: "ADD_ASSERTION" as const,
        baseDefinitionHash: hash,
        targetAssertionIndex: 0,
        assertion,
        casePayload: {}
      },
      {
        action: "REPLACE_ASSERTION" as const,
        baseDefinitionHash: hash,
        targetAssertionIndex: 0,
        targetAssertionDefinitionHash: targetHash,
        assertion,
        casePayload: {}
      },
      {
        action: "REMOVE_ASSERTION" as const,
        baseDefinitionHash: hash,
        targetAssertionDefinitionHash: targetHash
      },
      {
        action: "REMOVE_ASSERTION" as const,
        baseDefinitionHash: hash,
        targetAssertionIndex: 0,
        targetAssertionDefinitionHash: "bad",
        casePayload: {}
      },
      {
        action: "REMOVE_ASSERTION" as const,
        baseDefinitionHash: hash,
        targetAssertionIndex: -1,
        targetAssertionDefinitionHash: targetHash
      }
    ];
    for (const proposal of invalid) {
      expect(
        validateAnalysisResult({
          ...validResult,
          proposal: proposal as AnalysisProposalDraft
        }).ok
      ).toBe(false);
    }
  });

  it("接受无 Proposal 以及其余三种完整动作", () => {
    const hash = "a".repeat(64);
    const targetHash = "b".repeat(64);
    const assertion = { type: "equals", metric: "answer", value: "ok" };
    expect(validateAnalysisResult(validResult).ok).toBe(true);
    const proposals = [
      { action: "REPLACE_CASE" as const, baseDefinitionHash: hash, casePayload: {} },
      {
        action: "ADD_ASSERTION" as const,
        baseDefinitionHash: hash,
        targetAssertionIndex: 0,
        assertion
      },
      {
        action: "REMOVE_ASSERTION" as const,
        baseDefinitionHash: hash,
        targetAssertionIndex: 0,
        targetAssertionDefinitionHash: targetHash
      }
    ];
    for (const proposal of proposals) {
      expect(validateAnalysisResult({ ...validResult, proposal }).ok).toBe(true);
    }
  });

  it("逐项拒绝无效分析正文", () => {
    const invalid = [
      { confidence: Number.NaN },
      { confidence: -0.1 },
      { confidence: 1.1 },
      { evidence: [] },
      { evidence: [" "] },
      { explanation: " " },
      { recommendedAction: " " }
    ];
    for (const override of invalid) {
      expect(validateAnalysisResult({ ...validResult, ...override }).ok).toBe(false);
    }
  });
});
