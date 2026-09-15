/** Read-only E2E evidence adapters. Raw envelopes and historical hashes stay unchanged. */
export function evidenceObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function evidenceTurns(value: unknown): Record<string, unknown>[] {
  const root = evidenceObject(value);
  if (!Array.isArray(root.turns) || root.turns.length === 0) return [root];
  return root.turns.map((turn) => evidenceObject(evidenceObject(turn).parsed_output));
}
/** UI-only flattened view; retain request identity and authoritative per-turn ordering. */
export function displayEvidence(value: unknown): Record<string, unknown> {
  const root = evidenceObject(value);
  if (!Array.isArray(root.turns) || root.turns.length === 0) return root;
  const turnRecords = root.turns;
  const turns = evidenceTurns(root);
  const result = { ...root };
  for (const field of [
    "timeline",
    "llm_calls",
    "tool_executions",
    "delivered_messages",
    "errors",
    "a2ui",
    "causal_events",
    "planner_rounds"
  ]) {
    result[field] = turns.flatMap((turn, index) => {
      const values = turn[field];
      const req = evidenceObject(turnRecords[index]).req_id;
      return Array.isArray(values)
        ? values.map((item) => ({
            ...evidenceObject(item),
            ...(field === "a2ui" ? {} : { req_id: evidenceObject(item).req_id ?? req }),
            _eval_turn_index: index
          }))
        : [];
    });
  }
  result.routes = turns.map((turn, index) => ({
    ...evidenceObject(turn.route),
    _eval_turn_index: index,
    req_id: evidenceObject(turnRecords[index]).req_id
  }));
  return result;
}
/** Missing historical collection metadata stays unknown, never fabricated as complete. */
export function outboundEvidenceIncomplete(value: unknown): boolean {
  const root = evidenceObject(value);
  return (
    evidenceObject(root.conversation_execution).complete === false ||
    evidenceTurns(root).some((turn) => {
      const capture = evidenceObject(turn.outbound_capture);
      return typeof capture.status === "string" && capture.status !== "COLLECTED";
    })
  );
}
