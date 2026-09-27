import {
  LiveMemoryEntityDirectoryV1Schema,
  LiveMemoryEvaluationApiErrorV1Schema,
  LiveMemoryEvaluationCandidateV1Schema,
  LiveMemoryExtractResultV1Schema,
  LiveMemoryGlobalResultV1Schema,
  LiveMemoryMemoryPageV1Schema,
  LiveMemoryObservationPageV1Schema,
  LiveMemoryReplaySnapshotListV1Schema,
  type LiveMemoryEntityDirectoryV1,
  type LiveMemoryEvaluationCandidateV1,
  type LiveMemoryExtractResultV1,
  type LiveMemoryGlobalResultV1,
  type LiveMemoryMemoryPageV1,
  type LiveMemoryObservationPageV1,
  type LiveMemoryReplaySnapshotListV1
} from "@cortex-eval/contracts/src/live-memory-evaluation-contracts.ts";

export interface CortexAgentLiveMemoryClientConfig {
  readonly baseUrl: string;
  readonly bearerToken?: string;
  readonly timeoutMs?: number;
}

export interface CortexAgentLiveMemoryClientDependencies {
  readonly fetchImpl?: typeof fetch;
}

export interface ReplayObservationExtractInput {
  readonly ownerUserId: number;
  readonly runId: string;
  readonly workUnitRef: string;
  readonly sourceToolId: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly authorizationCategoryId: string;
  readonly reqId?: string;
  readonly lang?: string;
}

export interface ReplayConsolidateInput {
  readonly ownerUserId: number;
  readonly runId: string;
  readonly lang?: string;
}

interface ParseObject<T> {
  readonly parse: (value: unknown) => T;
}

type ResponseParser<T> = ((value: unknown) => T | { success: boolean; data?: T }) | ParseObject<T>;

export class CortexAgentLiveMemoryClientError extends Error {
  readonly code: "CONFIG_INVALID" | "HTTP_FAILED" | "API_ERROR" | "RESPONSE_INVALID" | "TIMEOUT";
  readonly status: number | null;

  constructor(code: CortexAgentLiveMemoryClientError["code"], status: number | null = null) {
    super(code);
    this.name = "CortexAgentLiveMemoryClientError";
    this.code = code;
    this.status = status;
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new CortexAgentLiveMemoryClientError("CONFIG_INVALID");
  try {
    const url = new URL(trimmed);
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new CortexAgentLiveMemoryClientError("CONFIG_INVALID");
  }
}

function query(params: Record<string, string | number | undefined>): string {
  const value = new URLSearchParams();
  for (const [key, item] of Object.entries(params)) {
    if (item !== undefined) value.set(key, String(item));
  }
  const encoded = value.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

export class CortexAgentLiveMemoryClient {
  readonly #baseUrl: string;
  readonly #bearerToken: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(
    config: CortexAgentLiveMemoryClientConfig,
    dependencies: CortexAgentLiveMemoryClientDependencies = {}
  ) {
    this.#baseUrl = normalizeBaseUrl(config.baseUrl);
    const bearerToken = config.bearerToken?.trim();
    this.#bearerToken = bearerToken === undefined || bearerToken === "" ? undefined : bearerToken;
    this.#timeoutMs = config.timeoutMs ?? 60_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new CortexAgentLiveMemoryClientError("CONFIG_INVALID");
    }
    this.#fetch = dependencies.fetchImpl ?? fetch;
  }

  async getCandidate(candidateId: string): Promise<LiveMemoryEvaluationCandidateV1> {
    return this.#get(
      `/api/live-memory-evaluation/candidates/${encodeURIComponent(candidateId)}`,
      LiveMemoryEvaluationCandidateV1Schema
    );
  }

  async listObservations(input: {
    readonly ownerUserId: number;
    readonly runId?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<LiveMemoryObservationPageV1> {
    return this.#get(
      `/api/live-memory/observations${query({
        owner_user_id: input.ownerUserId,
        run_id: input.runId,
        limit: input.limit,
        cursor: input.cursor
      })}`,
      LiveMemoryObservationPageV1Schema
    );
  }

  async listMemories(input: {
    readonly ownerUserId: number;
    readonly domain?: "USER" | "PERSON" | "PROJECT";
    readonly keyword?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<LiveMemoryMemoryPageV1> {
    return this.#get(
      `/api/live-memory/memories${query({
        owner_user_id: input.ownerUserId,
        domain: input.domain,
        keyword: input.keyword,
        limit: input.limit,
        cursor: input.cursor
      })}`,
      LiveMemoryMemoryPageV1Schema
    );
  }

  async listEntities(input: {
    readonly ownerUserId: number;
    readonly limit?: number;
  }): Promise<LiveMemoryEntityDirectoryV1> {
    return this.#get(
      `/api/live-memory/entities${query({
        owner_user_id: input.ownerUserId,
        limit: input.limit
      })}`,
      LiveMemoryEntityDirectoryV1Schema
    );
  }

  async listReplaySnapshots(input: {
    readonly ownerUserId: number;
    readonly limit?: number;
  }): Promise<LiveMemoryReplaySnapshotListV1> {
    return this.#get(
      `/api/live-memory/replay/snapshots${query({
        owner_user_id: input.ownerUserId,
        limit: input.limit
      })}`,
      LiveMemoryReplaySnapshotListV1Schema
    );
  }

  async replayObservationExtract(
    input: ReplayObservationExtractInput
  ): Promise<LiveMemoryExtractResultV1> {
    return this.#post(
      "/api/live-memory/replay/observation-extract",
      {
        owner_user_id: input.ownerUserId,
        run_id: input.runId,
        work_unit_ref: input.workUnitRef,
        source_tool_id: input.sourceToolId,
        provider_id: input.providerId,
        account_id: input.accountId,
        authorization_category_id: input.authorizationCategoryId,
        ...(input.reqId === undefined ? {} : { req_id: input.reqId }),
        ...(input.lang === undefined ? {} : { lang: input.lang })
      },
      LiveMemoryExtractResultV1Schema
    );
  }

  async replayConsolidate(input: ReplayConsolidateInput): Promise<LiveMemoryGlobalResultV1> {
    return this.#post(
      "/api/live-memory/replay/consolidate",
      {
        owner_user_id: input.ownerUserId,
        run_id: input.runId,
        ...(input.lang === undefined ? {} : { lang: input.lang })
      },
      LiveMemoryGlobalResultV1Schema
    );
  }

  async getRun(runId: string, ownerUserId: number): Promise<unknown> {
    return this.#get(
      `/api/live-memory/runs/${encodeURIComponent(runId)}${query({ owner_user_id: ownerUserId })}`,
      (value) => value
    );
  }

  async #get<T>(path: string, parser: ResponseParser<T>): Promise<T> {
    return this.#request("GET", path, undefined, parser);
  }

  async #post<T>(
    path: string,
    body: Record<string, unknown>,
    parser: ResponseParser<T>
  ): Promise<T> {
    return this.#request("POST", path, body, parser);
  }

  async #request<T>(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | undefined,
    parser: ResponseParser<T>
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.#bearerToken !== undefined) headers.authorization = `Bearer ${this.#bearerToken}`;
    try {
      const requestInit: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined) requestInit.body = JSON.stringify(body);
      const response = await this.#fetch(`${this.#baseUrl}${path}`, requestInit);
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const apiError = LiveMemoryEvaluationApiErrorV1Schema.safeParse(payload);
        if (apiError.success) {
          throw new CortexAgentLiveMemoryClientError("API_ERROR", response.status);
        }
        throw new CortexAgentLiveMemoryClientError("HTTP_FAILED", response.status);
      }
      let parsed: T | { success: boolean; data?: T };
      try {
        parsed = typeof parser === "function" ? parser(payload) : parser.parse(payload);
      } catch {
        throw new CortexAgentLiveMemoryClientError("RESPONSE_INVALID", response.status);
      }
      if (typeof parsed === "object" && parsed !== null && "success" in parsed) {
        if (!parsed.success || !("data" in parsed)) {
          throw new CortexAgentLiveMemoryClientError("RESPONSE_INVALID", response.status);
        }
        return parsed.data;
      }
      return parsed;
    } catch (error) {
      if (error instanceof CortexAgentLiveMemoryClientError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new CortexAgentLiveMemoryClientError("TIMEOUT");
      }
      throw new CortexAgentLiveMemoryClientError("HTTP_FAILED");
    } finally {
      clearTimeout(timeout);
    }
  }
}
