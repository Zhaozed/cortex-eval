import type {
  LiveMemoryMemoryDirectoryItemV1,
  MemoryEvaluationCaseV1,
  MemoryEvaluationInputV1
} from "@cortex-eval/contracts/src/memory-evaluation-contracts.ts";
import type {
  LiveMemoryEntityDirectoryV1,
  LiveMemoryEvaluationCandidateV1,
  LiveMemoryObservationV1,
  LiveMemoryReplaySnapshotV1
} from "@cortex-eval/contracts/src/live-memory-evaluation-contracts.ts";
import type {
  CortexAgentLiveMemoryClient,
  ReplayConsolidateInput,
  ReplayObservationExtractInput
} from "./cortex-agent-live-memory-client.ts";

export type MemoryEvaluationReplayMode = "NONE" | "EXTRACT" | "CONSOLIDATE" | "ALL";

export interface CortexAgentMemoryEvaluationClient {
  readonly getCandidate: CortexAgentLiveMemoryClient["getCandidate"];
  readonly listObservations: CortexAgentLiveMemoryClient["listObservations"];
  readonly listMemories: CortexAgentLiveMemoryClient["listMemories"];
  readonly listEntities: CortexAgentLiveMemoryClient["listEntities"];
  readonly listReplaySnapshots: CortexAgentLiveMemoryClient["listReplaySnapshots"];
  readonly replayObservationExtract: CortexAgentLiveMemoryClient["replayObservationExtract"];
  readonly replayConsolidate: CortexAgentLiveMemoryClient["replayConsolidate"];
}

export interface CortexAgentMemoryEvaluationRunnerOptions {
  readonly pageSize?: number;
  /** Replay invokes the Cortex-Agent LLM and is deliberately opt-in. */
  readonly replayMode?: MemoryEvaluationReplayMode;
  readonly replayLang?: string;
}

export interface CortexAgentMemoryEvaluationRunnerInput {
  readonly caseDefinition: MemoryEvaluationCaseV1;
  readonly options?: CortexAgentMemoryEvaluationRunnerOptions;
}

function asArray<T>(value: readonly T[]): T[] {
  return [...value];
}

/** Aggregates all memory-related Cortex-Agent APIs into one scorer input. */
export class CortexAgentMemoryEvaluationRunner {
  readonly #client: CortexAgentMemoryEvaluationClient;
  readonly #pageSize: number;
  readonly #replayMode: MemoryEvaluationReplayMode;
  readonly #replayLang: string | undefined;

  constructor(
    client: CortexAgentMemoryEvaluationClient,
    options: CortexAgentMemoryEvaluationRunnerOptions = {}
  ) {
    this.#client = client;
    this.#pageSize = options.pageSize ?? 200;
    this.#replayMode = options.replayMode ?? "NONE";
    this.#replayLang = options.replayLang;
    if (!Number.isInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 500) {
      throw new Error("MEMORY_EVALUATION_PAGE_SIZE_INVALID");
    }
  }

  get replayMode(): MemoryEvaluationReplayMode {
    return this.#replayMode;
  }

  async collect(input: CortexAgentMemoryEvaluationRunnerInput): Promise<MemoryEvaluationInputV1> {
    const definition = input.caseDefinition;
    const runId = definition.runId;
    const [candidate, observations, memories, entities, replaySnapshots] = await Promise.all([
      definition.candidateId === undefined
        ? Promise.resolve<LiveMemoryEvaluationCandidateV1 | null>(null)
        : this.#client.getCandidate(definition.candidateId),
      this.#listObservations(definition.ownerUserId, runId),
      this.#listMemories(definition.ownerUserId),
      this.#client.listEntities({ ownerUserId: definition.ownerUserId, limit: 500 }),
      this.#client.listReplaySnapshots({ ownerUserId: definition.ownerUserId, limit: 500 })
    ]);

    const replayResults: unknown[] = [];
    const warnings: string[] = [];
    if (this.#replayMode !== "NONE") {
      for (const snapshot of replaySnapshots.items) {
        if (
          snapshot.snapshot_kind === "OBSERVATION_EXTRACT" &&
          this.#replayMode !== "CONSOLIDATE"
        ) {
          const workUnitRef = snapshot.work_unit_ref;
          const sourceToolId = snapshot.source_tool_id;
          const providerId = snapshot.provider_id;
          const accountId = snapshot.account_id;
          const authorizationCategoryId = snapshot.authorization_category_id;
          if (
            typeof workUnitRef !== "string" ||
            typeof sourceToolId !== "string" ||
            typeof providerId !== "string" ||
            typeof accountId !== "string" ||
            typeof authorizationCategoryId !== "string"
          ) {
            warnings.push(`REPLAY_SNAPSHOT_INCOMPLETE:${snapshot.run_id}`);
            continue;
          }
          replayResults.push(
            await this.#client.replayObservationExtract({
              ownerUserId: definition.ownerUserId,
              runId: snapshot.run_id,
              workUnitRef,
              sourceToolId,
              providerId,
              accountId,
              authorizationCategoryId,
              ...(this.#replayLang === undefined ? {} : { lang: this.#replayLang })
            } satisfies ReplayObservationExtractInput)
          );
        }
        if (snapshot.snapshot_kind === "GLOBAL_CONSOLIDATE" && this.#replayMode !== "EXTRACT") {
          replayResults.push(
            await this.#client.replayConsolidate({
              ownerUserId: definition.ownerUserId,
              runId: snapshot.run_id,
              ...(this.#replayLang === undefined ? {} : { lang: this.#replayLang })
            } satisfies ReplayConsolidateInput)
          );
        }
      }
    }

    return {
      caseDefinition: definition,
      candidate,
      observations: asArray(observations),
      memories: asArray(memories),
      entities,
      replaySnapshots: asArray(replaySnapshots.items),
      replayResults,
      warnings
    };
  }

  async #listObservations(
    ownerUserId: number,
    runId: string | undefined
  ): Promise<LiveMemoryObservationV1[]> {
    const items: LiveMemoryObservationV1[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#client.listObservations({
        ownerUserId,
        ...(runId === undefined ? {} : { runId }),
        limit: this.#pageSize,
        ...(cursor === undefined ? {} : { cursor })
      });
      items.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    return items;
  }

  async #listMemories(ownerUserId: number): Promise<LiveMemoryMemoryDirectoryItemV1[]> {
    const items: LiveMemoryMemoryDirectoryItemV1[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#client.listMemories({
        ownerUserId,
        limit: this.#pageSize,
        ...(cursor === undefined ? {} : { cursor })
      });
      items.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    return items;
  }
}

export type { LiveMemoryEntityDirectoryV1, LiveMemoryReplaySnapshotV1 };
