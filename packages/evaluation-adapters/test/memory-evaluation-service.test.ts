import { describe, expect, it, vi } from "vitest";

import {
  MEMORY_EVALUATION_CONTRACT_V1,
  MemoryEvaluationCaseV1Schema,
  type MemoryEvaluationCaseV1
} from "@cortex-eval/contracts/src/memory-evaluation-contracts.ts";
import { CortexAgentMemoryEvaluationRunner } from "../src/cortex-agent-memory-evaluation-runner.ts";
import { MemoryEvaluationService } from "../src/memory-evaluation-service.ts";
import type { CortexAgentMemoryEvaluationClient } from "../src/cortex-agent-memory-evaluation-runner.ts";

function definition(): MemoryEvaluationCaseV1 {
  return MemoryEvaluationCaseV1Schema.parse({
    contractVersion: MEMORY_EVALUATION_CONTRACT_V1,
    caseId: "service-1",
    ownerUserId: 7,
    sourceRecords: [{ sourceRecordId: "source-1", sourceType: "mail", content: "hello" }],
    expectedObservations: []
  });
}

function client(): CortexAgentMemoryEvaluationClient {
  return {
    getCandidate: vi.fn().mockResolvedValue(null),
    listObservations: vi
      .fn()
      .mockResolvedValue({ items: [], next_cursor: null, catalog_marker: "1" }),
    listMemories: vi.fn().mockResolvedValue({ items: [], next_cursor: null, catalog_marker: "1" }),
    listEntities: vi
      .fn()
      .mockResolvedValue({ persons: [], memories: [], projects: [], project_persons: [] }),
    listReplaySnapshots: vi.fn().mockResolvedValue({ items: [] }),
    replayObservationExtract: vi.fn(),
    replayConsolidate: vi.fn()
  };
}

describe("MemoryEvaluationService", () => {
  it("collects and scores through one stable entry point without replay cost by default", async () => {
    const result = await new MemoryEvaluationService({
      runner: new CortexAgentMemoryEvaluationRunner(client())
    }).evaluate(definition());

    expect(result.report.caseId).toBe("service-1");
    expect(result.report.replayMode).toBe("NONE");
    expect(result.report.replayRequestCount).toBe(0);
    expect(result.report.costRisk).toBe("NONE");
    expect(result.report.scores.observationExtraction.f1).toBe(1);
  });

  it("marks explicit replay as a cost-bearing evaluation", async () => {
    const replaySnapshots = vi.fn().mockResolvedValue({
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
    });
    const replayConsolidate = vi.fn().mockResolvedValue({ mutations: [] });
    const replayClient: CortexAgentMemoryEvaluationClient = {
      ...client(),
      listReplaySnapshots: replaySnapshots,
      replayConsolidate
    };

    const result = await new MemoryEvaluationService({
      runner: new CortexAgentMemoryEvaluationRunner(replayClient, { replayMode: "CONSOLIDATE" })
    }).evaluate(definition());

    expect(result.report.replayMode).toBe("CONSOLIDATE");
    expect(result.report.replayRequestCount).toBe(1);
    expect(result.report.costRisk).toBe("LOW");
  });
});
