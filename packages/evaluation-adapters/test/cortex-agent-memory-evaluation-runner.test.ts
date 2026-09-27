import { describe, expect, it, vi } from "vitest";

import {
  MEMORY_EVALUATION_CONTRACT_V1,
  MemoryEvaluationCaseV1Schema
} from "@cortex-eval/contracts/src/memory-evaluation-contracts.ts";
import { CortexAgentMemoryEvaluationRunner } from "../src/cortex-agent-memory-evaluation-runner.ts";
import type { CortexAgentMemoryEvaluationClient } from "../src/cortex-agent-memory-evaluation-runner.ts";

function definition(): ReturnType<typeof MemoryEvaluationCaseV1Schema.parse> {
  return MemoryEvaluationCaseV1Schema.parse({
    contractVersion: MEMORY_EVALUATION_CONTRACT_V1,
    caseId: "runner-1",
    ownerUserId: 7,
    candidateId: "candidate-1",
    sourceRecords: [{ sourceRecordId: "source-1", sourceType: "mail", content: "hello" }],
    expectedObservations: []
  });
}

describe("Cortex-Agent memory evaluation runner", () => {
  it("paginates observations and memories and keeps replay off by default", async () => {
    const client = {
      getCandidate: vi.fn().mockResolvedValue({ candidate_id: "candidate-1" }),
      listObservations: vi
        .fn()
        .mockResolvedValueOnce({ items: [], next_cursor: "obs-next", catalog_marker: "1" })
        .mockResolvedValueOnce({ items: [], next_cursor: null, catalog_marker: "1" }),
      listMemories: vi
        .fn()
        .mockResolvedValueOnce({ items: [], next_cursor: "mem-next", catalog_marker: "1" })
        .mockResolvedValueOnce({ items: [], next_cursor: null, catalog_marker: "1" }),
      listEntities: vi.fn().mockResolvedValue({ persons: [], memories: [], projects: [], project_persons: [] }),
      listReplaySnapshots: vi.fn().mockResolvedValue({ items: [] }),
      replayObservationExtract: vi.fn(),
      replayConsolidate: vi.fn()
    } satisfies CortexAgentMemoryEvaluationClient;

    const result = await new CortexAgentMemoryEvaluationRunner(client, { pageSize: 1 }).collect({
      caseDefinition: definition()
    });

    expect(client.listObservations).toHaveBeenCalledTimes(2);
    expect(client.listMemories).toHaveBeenCalledTimes(2);
    expect(client.replayObservationExtract).not.toHaveBeenCalled();
    expect(client.replayConsolidate).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([]);
  });

  it("only replays saved snapshots when explicitly requested", async () => {
    const client = {
      getCandidate: vi.fn().mockResolvedValue(null),
      listObservations: vi.fn().mockResolvedValue({ items: [], next_cursor: null, catalog_marker: "1" }),
      listMemories: vi.fn().mockResolvedValue({ items: [], next_cursor: null, catalog_marker: "1" }),
      listEntities: vi.fn().mockResolvedValue({ persons: [], memories: [], projects: [], project_persons: [] }),
      listReplaySnapshots: vi.fn().mockResolvedValue({
        items: [
          {
            run_id: "run-1",
            snapshot_kind: "GLOBAL_CONSOLIDATE",
            work_unit_ref: null,
            source_tool_id: null,
            provider_id: null,
            account_id: null,
            authorization_category_id: null,
            updated_at: "2026-09-22T00:00:00+00:00"
          }
        ]
      }),
      replayObservationExtract: vi.fn(),
      replayConsolidate: vi.fn().mockResolvedValue({ mutations: [] })
    } satisfies CortexAgentMemoryEvaluationClient;

    await new CortexAgentMemoryEvaluationRunner(client, { replayMode: "ALL", replayLang: "zh-Hans" }).collect({
      caseDefinition: definition()
    });
    expect(client.replayConsolidate).toHaveBeenCalledWith({ ownerUserId: 7, runId: "run-1", lang: "zh-Hans" });
  });
});
