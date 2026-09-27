import { describe, expect, it } from "vitest";

import {
  MEMORY_EVALUATION_CONTRACT_V1,
  MemoryEvaluationCaseV1Schema,
  type MemoryEvaluationInputV1
} from "@cortex-eval/contracts/src/memory-evaluation-contracts.ts";
import { scoreMemoryEvaluation } from "../src/memory-evaluation-scorer.ts";

function input(): MemoryEvaluationInputV1 {
  const caseDefinition = MemoryEvaluationCaseV1Schema.parse({
    contractVersion: MEMORY_EVALUATION_CONTRACT_V1,
    caseId: "memory-1",
    ownerUserId: 7,
    sourceRecords: [{ sourceRecordId: "mail-1", sourceType: "mail", content: "Alice" }],
    expectedObservations: [
      {
        observationId: "obs-1",
        domain: "PERSON",
        memoryKind: "person.preference",
        fact: "Alice prefers concise updates",
        personEmails: ["alice@example.com"]
      }
    ],
    expectedPersonLinks: [
      { observationId: "obs-1", emails: ["alice@example.com"], personRef: "lm_person_a" }
    ],
    expectedProjectLinks: [],
    expectedConsolidation: [
      {
        mutationId: "mutation-1",
        domain: "PERSON",
        memoryKind: "person.preference",
        mutationType: "MEMORY_CREATE",
        content: "Alice prefers concise updates"
      }
    ],
    expectedMemoryState: [
      {
        memoryRef: "lm_memory_a",
        domain: "PERSON",
        subjectRef: "lm_person_a",
        memoryKind: "person.preference",
        content: "Alice prefers concise updates"
      }
    ],
    expectedRetrieval: { requiredKeywords: ["Alice"] },
    expectedConsumption: { requiredClaims: ["Alice prefers concise updates"] }
  });
  return {
    caseDefinition,
    candidate: {
      candidate_id: "candidate-1",
      case_type: "MAIL_DRAFT",
      original_task_input: {},
      available_memory: { text: "Alice" },
      live_mem_process_output: {},
      final_output: "Alice prefers concise updates"
    },
    observations: [
      {
        domain: "PERSON",
        memory_kind: "person.preference",
        evidence_type: "EXPLICIT",
        fact: "Alice prefers concise updates",
        person_emails: ["alice@example.com"],
        observed_at: "2026-09-22T00:00:00+00:00"
      }
    ],
    memories: [
      {
        memory_ref: "lm_memory_a",
        domain: "PERSON",
        subject_ref: "lm_person_a",
        subject_label: "Alice",
        subject_last_interaction_at: null,
        person_name: "Alice",
        person_emails: ["alice@example.com"],
        person_sources: [],
        memory_kind: "person.preference",
        content: "Alice prefers concise updates",
        status: "ACTIVE",
        revision: 1,
        created_at: "2026-09-22T00:00:00+00:00",
        updated_at: "2026-09-22T00:00:00+00:00"
      }
    ],
    entities: {
      persons: [{ person_ref: "lm_person_a", last_interaction_at: null }],
      memories: [
        {
          memory_ref: "lm_memory_a",
          domain: "PERSON",
          memory_kind: "person.preference",
          content: "Alice prefers concise updates"
        }
      ],
      projects: [],
      project_persons: []
    },
    replaySnapshots: [],
    replayResults: [
      {
        mutations: [
          {
            domain: "PERSON",
            memory_kind: "person.preference",
            mutation_type: "MEMORY_CREATE",
            content: "Alice prefers concise updates"
          }
        ]
      }
    ],
    warnings: []
  };
}

describe("memory evaluation scorer", () => {
  it("scores the observation, resolution, consolidation, state and consumption chain", () => {
    const result = scoreMemoryEvaluation(input());
    expect(result.observationExtraction.f1).toBe(1);
    expect(result.personResolution.recall).toBe(1);
    expect(result.consolidation.f1).toBe(1);
    expect(result.memoryState.f1).toBe(1);
    expect(result.retrieval.f1).toBe(1);
    expect(result.consumption.f1).toBe(1);
    expect(result.safety.passed).toBe(true);
  });

  it("does not give credit for a forbidden memory or answer claim", () => {
    const value = input();
    const caseDefinition = MemoryEvaluationCaseV1Schema.parse({
      ...value.caseDefinition,
      expectedRetrieval: { forbiddenKeywords: ["secret"] },
      expectedConsumption: { forbiddenClaims: ["secret"] }
    });
    const result = scoreMemoryEvaluation({
      ...value,
      caseDefinition,
      candidate: {
        ...(value.candidate as Record<string, unknown>),
        available_memory: { text: "secret" },
        final_output: "secret"
      }
    });
    expect(result.retrieval.f1).toBe(0);
    expect(result.consumption.f1).toBe(0);
  });
});
