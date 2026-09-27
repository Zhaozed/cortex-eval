import { describe, expect, it } from "vitest";

import { CortexAgentLiveMemoryClient } from "../src/cortex-agent-live-memory-client.ts";

const candidate = {
  candidate_id: "candidate-1",
  client_request_id: "request-1",
  case_type: "MAIL_DRAFT",
  launch_mode: "AUTO",
  requested_profile_id: null,
  status: "CAPTURED",
  current_run_id: "run-1",
  rubric_version: "memory-rubric.v1",
  rubric_sha256: "sha256",
  captured_at: "2026-09-22T00:00:00+00:00",
  expires_at: "2026-09-23T00:00:00+00:00",
  original_task_input: { task: "draft" },
  available_memory: { text: "Alice" },
  live_mem_process_output: { selected_memory_refs: ["memory-1"] },
  final_output: "done"
};

const memory = {
  memory_ref: "memory-1",
  domain: "PERSON",
  subject_ref: "person-1",
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
};

describe("Cortex-Agent live memory client", () => {
  it("parses candidate, flat observations and paged memories", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const client = new CortexAgentLiveMemoryClient(
      { baseUrl: "http://cortex-agent.test/", bearerToken: "token" },
      {
        fetchImpl: (input, init): Promise<Response> => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          requests.push({ url, init });
          if (url.includes("/candidates/")) {
            return Promise.resolve(new Response(JSON.stringify(candidate), { status: 200 }));
          }
          if (url.includes("/observations")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  items: [
                    {
                      domain: "PERSON",
                      memory_kind: "person.preference",
                      evidence_type: "EXPLICIT",
                      fact: "Alice prefers concise updates",
                      person_emails: ["alice@example.com"],
                      observed_at: "2026-09-22T00:00:00+00:00",
                      resolution_run_id: "run-1",
                      disposition: "CREATE",
                      reason: null,
                      target_mutation_type: "MEMORY_CREATE",
                      target_memory_ref: null,
                      input_evidence_type: "EXPLICIT",
                      input_observed_at: null
                    }
                  ],
                  next_cursor: null,
                  catalog_marker: "marker-1"
                }),
                { status: 200 }
              )
            );
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({ items: [memory], next_cursor: "next", catalog_marker: "marker-1" }),
              { status: 200 }
            )
          );
        }
      }
    );

    const result = await Promise.all([
      client.getCandidate("candidate-1"),
      client.listObservations({ ownerUserId: 7, runId: "run-1", limit: 10 }),
      client.listMemories({ ownerUserId: 7, limit: 1, cursor: "cursor-1" })
    ]);

    expect(result[0].candidate_id).toBe("candidate-1");
    expect(result[1].items[0]?.fact).toBe("Alice prefers concise updates");
    expect(result[2].next_cursor).toBe("next");
    expect(requests[1]?.url).toContain("owner_user_id=7");
    expect(requests[1]?.url).toContain("run_id=run-1");
    expect(requests[2]?.url).toContain("cursor=cursor-1");
    expect((requests[0]?.init?.headers as Record<string, string>).authorization).toBe(
      "Bearer token"
    );
  });

  it("surfaces API errors and rejects invalid responses", async () => {
    const apiErrorClient = new CortexAgentLiveMemoryClient(
      { baseUrl: "http://cortex-agent.test" },
      {
        fetchImpl: (): Promise<Response> =>
          Promise.resolve(
            new Response(JSON.stringify({ error_code: "OWNER_FORBIDDEN" }), { status: 403 })
          )
      }
    );
    await expect(apiErrorClient.listEntities({ ownerUserId: 7 })).rejects.toMatchObject({
      code: "API_ERROR",
      status: 403
    });

    const invalidClient = new CortexAgentLiveMemoryClient(
      { baseUrl: "http://cortex-agent.test" },
      {
        fetchImpl: (): Promise<Response> =>
          Promise.resolve(new Response(JSON.stringify({ nope: true }), { status: 200 }))
      }
    );
    await expect(invalidClient.getCandidate("candidate-1")).rejects.toMatchObject({
      code: "RESPONSE_INVALID",
      status: 200
    });
  });
});
