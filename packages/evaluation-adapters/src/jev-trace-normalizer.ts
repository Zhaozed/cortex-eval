import type { JsonValue } from "@cortex-eval/contracts/src/contracts-primitives.ts";
import {
  AgentTraceV1Schema,
  AGENT_TRACE_V1,
  type AgentTraceV1
} from "@cortex-eval/contracts/src/semantic-evaluation-contracts.ts";

export class TraceNormalizationError extends Error {
  constructor(code: "TRACE_INPUT_INVALID" | "TRACE_TASK_MISSING") {
    super(code);
    this.name = "TraceNormalizationError";
  }
}

type Dict = Record<string, unknown>;

function object(value: unknown): Dict | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Dict)
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const MAX_EVIDENCE_TEXT_CHARS = 800;
const MAX_EVIDENCE_ARRAY_ITEMS = 16;
const MAX_EVIDENCE_OBJECT_KEYS = 20;
const MAX_EVIDENCE_DEPTH = 4;
const MAX_TRACE_MESSAGES = 24;
const MAX_TRACE_TOOL_CALLS = 40;
const MAX_TRACE_PLANNER_STEPS = 40;

function boundedText(value: string, limit = MAX_EVIDENCE_TEXT_CHARS): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…[truncated ${value.length - limit} chars]`;
}

/** Convert untrusted evidence into a bounded JSON value before sending it to an evaluator. */
function jsonValue(value: unknown, depth = 0): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return boundedText(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (depth >= MAX_EVIDENCE_DEPTH) return "[truncated: max evidence depth]";
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_EVIDENCE_ARRAY_ITEMS)
      .map((item) => jsonValue(item, depth + 1));
    if (value.length > MAX_EVIDENCE_ARRAY_ITEMS) {
      items.push(`[truncated: ${value.length - MAX_EVIDENCE_ARRAY_ITEMS} more items]`);
    }
    return items;
  }
  const source = object(value);
  if (source === null) return Object.prototype.toString.call(value);
  const entries = Object.entries(source)
    .slice(0, MAX_EVIDENCE_OBJECT_KEYS)
    .map(([key, item]) => [boundedText(key, 200), jsonValue(item, depth + 1)] as const);
  if (Object.keys(source).length > MAX_EVIDENCE_OBJECT_KEYS) {
    entries.push([
      "__truncated_keys__",
      `[truncated: ${Object.keys(source).length - MAX_EVIDENCE_OBJECT_KEYS} more keys]`
    ]);
  }
  return Object.fromEntries(entries);
}

function jsonObject(value: unknown): Record<string, JsonValue> {
  const parsed = object(value);
  return parsed === null ? {} : (jsonValue(parsed) as Record<string, JsonValue>);
}

function textFrom(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const item = object(value);
  return string(item?.text) ?? string(item?.content) ?? string(item?.message);
}

function parsedRoot(input: unknown): { root: Dict; parsed: Dict; warnings: string[] } {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new TraceNormalizationError("TRACE_INPUT_INVALID");
    }
  }
  const root = object(value);
  if (root === null) throw new TraceNormalizationError("TRACE_INPUT_INVALID");
  const parsed = object(root.parsed_output) ?? root;
  const warnings: string[] = [];
  if (root.parsed_output === undefined)
    warnings.push("未发现parsed_output，使用输入对象作为 Trace 根节点");
  return { root, parsed, warnings };
}

function normalizeMessages(root: Dict, parsed: Dict): AgentTraceV1["messages"] {
  const source = Array.isArray(root.conversation)
    ? root.conversation
    : Array.isArray(parsed.messages)
      ? parsed.messages
      : Array.isArray(parsed.turns)
        ? parsed.turns
        : [];
  return source.slice(0, MAX_TRACE_MESSAGES).flatMap((item) => {
    const value = object(item);
    const text = textFrom(item);
    if (text === undefined) return [];
    const roleValue = string(value?.role) ?? (value?.speaker === "user" ? "user" : "assistant");
    const role = ["system", "user", "assistant", "tool"].includes(roleValue)
      ? (roleValue as "system" | "user" | "assistant" | "tool")
      : "assistant";
    return [{ role, text: boundedText(text), visibleToUser: value?.visibleToUser !== false }];
  });
}

function normalizeToolCalls(parsed: Dict): AgentTraceV1["toolCalls"] {
  const executions = Array.isArray(parsed.tool_executions) ? parsed.tool_executions : [];
  return executions
    .flatMap((execution, executionIndex) => {
      const item = object(execution);
      const calls = Array.isArray(item?.calls) ? item.calls : [];
      return calls.flatMap((call, callIndex) => {
        const value = object(call);
        const name = string(value?.name) ?? string(value?.tool_name);
        if (name === undefined) return [];
        const id =
          string(value?.tool_request_id) ??
          string(item?.tool_request_id) ??
          `tool-${executionIndex + 1}-${callIndex + 1}`;
        const args = object(value?.param) ?? object(value?.args_json) ?? {};
        const terminals = Array.isArray(item?.terminals) ? item.terminals : [];
        const terminal = object(terminals[callIndex]);
        const result = terminal?.tool_result;
        const error = string(value?.error) ?? string(object(result)?.error);
        const outcomeValue = (
          string(value?.outcome) ??
          string(item?.outcome) ??
          string(item?.status) ??
          string(object(terminal)?.tool_result)?.toLowerCase()
        )?.toLowerCase();
        const normalizedOutcome =
          outcomeValue === "succeeded" || outcomeValue === "success"
            ? "success"
            : outcomeValue === "failed" || outcomeValue === "failure" || outcomeValue === "error"
              ? "failure"
              : outcomeValue === "timeout" || outcomeValue === "timed_out"
                ? "timeout"
                : outcomeValue === "cancelled" || outcomeValue === "canceled"
                  ? "cancelled"
                  : undefined;
        const outcome: AgentTraceV1["toolCalls"][number]["outcome"] =
          normalizedOutcome ?? (error === undefined ? "unknown" : "failure");
        return [
          {
            id,
            name,
            args: jsonObject(args),
            outcome,
            ...(result === undefined ? {} : { result: jsonValue(result) }),
            ...(error === undefined ? {} : { error }),
            ...(string(value?.retry_of) === undefined ? {} : { retryOf: string(value?.retry_of) }),
            ...(number(value?.started_at_ms) === undefined
              ? {}
              : { startedAtMs: number(value?.started_at_ms) }),
            ...(number(value?.ended_at_ms) === undefined
              ? {}
              : { endedAtMs: number(value?.ended_at_ms) }),
            ...(number(value?.duration_ms) === undefined
              ? {}
              : { durationMs: number(value?.duration_ms) })
          }
        ];
      });
    })
    .slice(0, MAX_TRACE_TOOL_CALLS);
}

function summarizeA2ui(parsed: Dict): JsonValue {
  const surfaces = Array.isArray(parsed.user_view && object(parsed.user_view)?.a2ui_surfaces)
    ? (object(parsed.user_view)?.a2ui_surfaces as unknown[])
    : [];
  const surfaceSummary = surfaces.slice(0, 20).flatMap((item) => {
    const surface = object(item);
    if (surface === null) return [];
    const components = object(surface.components);
    const componentNames =
      components === null
        ? []
        : Object.values(components)
            .flatMap((component) => {
              const value = object(component);
              return string(value?.component) ? [string(value?.component) as string] : [];
            })
            .slice(0, 50);
    return [
      {
        surfaceId: string(surface.surface_id),
        catalogId: string(surface.catalog_id),
        componentNames,
        operations: Array.isArray(surface.operations) ? surface.operations.slice(0, 20) : [],
        frameCount: number(surface.frame_count)
      }
    ];
  });
  const sourceTools = Array.isArray(parsed.a2ui_source_tools)
    ? parsed.a2ui_source_tools.slice(0, 20)
    : [];
  const surfaceIds = Array.isArray(parsed.a2ui_surface_ids)
    ? parsed.a2ui_surface_ids.slice(0, 20)
    : [];
  return jsonValue({
    surfaceCount: surfaces.length,
    surfaceIds,
    sourceTools,
    surfaces: surfaceSummary,
    validation: parsed.a2ui_validation
  });
}

function compactRawEvidence(root: Dict, parsed: Dict): Record<string, JsonValue> {
  const finalOutput = object(parsed.final_output);
  return jsonObject({
    sourceKeys: Object.keys(parsed).sort().slice(0, 80),
    request: parsed.request,
    requestIdentity: parsed.request_identity,
    route: parsed.route ?? parsed.intent,
    taskSnapshot: parsed.task_snapshot,
    coverage: parsed.coverage,
    errors: parsed.errors,
    replyText: parsed.reply_text ?? finalOutput?.text,
    replyType: parsed.reply_type ?? finalOutput?.kind,
    a2ui: summarizeA2ui(parsed),
    schemaVersion: parsed.schema_version,
    supported: parsed.supported,
    unsupportedReason: parsed.unsupported_reason,
    rootHadParsedOutput: root.parsed_output !== undefined
  });
}

function normalizeA2ui(parsed: Dict): AgentTraceV1["a2ui"] {
  const source = Array.isArray(parsed.a2ui)
    ? parsed.a2ui
    : Array.isArray(parsed.a2ui_events)
      ? parsed.a2ui_events
      : [];
  const direct: AgentTraceV1["a2ui"] = source.flatMap((item, index): AgentTraceV1["a2ui"] => {
    const value = object(item);
    if (value === null) return [];
    const messages = Array.isArray(value.messages) ? value.messages : [];
    if (messages.length > 0) {
      return messages.flatMap((message, messageIndex): AgentTraceV1["a2ui"] => {
        const envelope = object(message);
        if (envelope === null) return [];
        const create = object(envelope.createSurface);
        const update = object(envelope.updateComponents);
        const data = object(envelope.updateDataModel);
        if (create !== null) {
          return [
            {
              id: string(create.surfaceId) ?? `a2ui-${index + 1}-${messageIndex + 1}`,
              component: "surface",
              event: "emitted" as const,
              payload: jsonValue({ catalogId: create.catalogId, surfaceId: create.surfaceId })
            }
          ];
        }
        if (update !== null) {
          const components = Array.isArray(update.components) ? update.components : [];
          return components.flatMap((component, componentIndex): AgentTraceV1["a2ui"] => {
            const componentValue = object(component);
            const componentName = string(componentValue?.component);
            if (componentName === undefined) return [];
            return [
              {
                id: string(componentValue?.id) ?? `a2ui-${index + 1}-${componentIndex + 1}`,
                component: componentName,
                event: "emitted" as const,
                payload: jsonValue({
                  surfaceId: update.surfaceId,
                  sourceToolName: value.source_tool_name
                })
              }
            ];
          });
        }
        if (data !== null) {
          return [
            {
              id: string(data.surfaceId) ?? `a2ui-${index + 1}-${messageIndex + 1}`,
              component: "data-model",
              event: "updated" as const,
              payload: jsonValue({
                surfaceId: data.surfaceId,
                sourceToolName: value.source_tool_name
              })
            }
          ];
        }
        return [];
      });
    }
    const component = string(value.component) ?? string(value.component_type) ?? string(value.type);
    if (component === undefined) return [];
    const eventValue = string(value.event) ?? "emitted";
    const event = ["emitted", "rendered", "updated", "dismissed", "action"].includes(eventValue)
      ? (eventValue as "emitted" | "rendered" | "updated" | "dismissed" | "action")
      : "emitted";
    return [
      {
        id: string(value.id) ?? `a2ui-${index + 1}`,
        component,
        event,
        ...(number(value.timestamp_ms) === undefined
          ? {}
          : { timestampMs: number(value.timestamp_ms) }),
        ...(value.payload === undefined ? {} : { payload: jsonValue(value.payload) })
      }
    ];
  });
  return direct.slice(0, 100);
}

/** Convert current provider output into the stable Trace contract consumed by JEV. */
export function normalizeAgentTrace(
  input: unknown,
  options: { readonly task?: string } = {}
): AgentTraceV1 {
  const { root, parsed, warnings } = parsedRoot(input);
  const taskValue =
    options.task ?? string(root.task) ?? string(parsed.task) ?? textFrom(root.request);
  if (taskValue === undefined) throw new TraceNormalizationError("TRACE_TASK_MISSING");
  const task = boundedText(taskValue);

  const finalOutput = object(parsed.final_output);
  const finalAnswer =
    string(root.final_answer) ??
    string(root.finalAnswer) ??
    string(parsed.final_answer) ??
    string(parsed.finalAnswer) ??
    string(parsed.reply_text) ??
    textFrom(finalOutput) ??
    textFrom(parsed.answer) ??
    "";
  const boundedFinalAnswer = boundedText(finalAnswer);
  const durationMs =
    number(root.duration_ms) ??
    number(root.durationMs) ??
    number(root.latency_ms) ??
    number(parsed.duration_ms);
  const firstResponseMs = number(root.first_response_ms) ?? number(parsed.first_response_ms);
  const route = object(parsed.route);
  const routeFacts = object(route?.facts);
  const selectedRoute =
    string(object(parsed.router)?.selected) ??
    string(object(parsed.routing)?.selected) ??
    string(route?.selected) ??
    string(route?.decision) ??
    string(routeFacts?.domain) ??
    string(parsed.intent);
  const planner = object(parsed.planner) ?? object(parsed.plan);
  const steps = Array.isArray(planner?.steps)
    ? planner.steps
        .flatMap((step) => (typeof step === "string" ? [boundedText(step)] : []))
        .slice(0, MAX_TRACE_PLANNER_STEPS)
    : [];
  const plannerStatus = string(planner?.status);
  const status = ["completed", "failed", "partial", "unknown"].includes(plannerStatus ?? "")
    ? (plannerStatus as "completed" | "failed" | "partial" | "unknown")
    : "unknown";

  const messages = normalizeMessages(root, parsed);
  const toolCalls = normalizeToolCalls(parsed);
  const a2ui = normalizeA2ui(parsed);
  const facts = {
    calledTools: [...new Set(toolCalls.map((call) => call.name))],
    toolCallCount: toolCalls.length,
    failedToolCallCount: toolCalls.filter((call) =>
      ["failure", "timeout", "cancelled"].includes(call.outcome)
    ).length,
    retryCount: toolCalls.filter((call) => call.retryOf !== undefined).length,
    a2uiComponents: [...new Set(a2ui.map((item) => item.component))],
    a2uiEventCount: a2ui.length,
    hasToolTimestamps: toolCalls.some(
      (call) => call.startedAtMs !== undefined || call.endedAtMs !== undefined
    ),
    hasA2uiTimestamps: a2ui.some((item) => item.timestampMs !== undefined)
  };

  return AgentTraceV1Schema.parse({
    contractVersion: AGENT_TRACE_V1,
    task,
    messages,
    router: {
      ...(selectedRoute === undefined ? {} : { selected: selectedRoute }),
      candidates: Array.isArray(routeFacts?.tools)
        ? routeFacts.tools.flatMap((item) => (typeof item === "string" ? [item] : []))
        : []
    },
    planner: { steps, status },
    toolCalls,
    a2ui,
    facts,
    finalAnswer: boundedFinalAnswer,
    timing: {
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(firstResponseMs === undefined ? {} : { firstResponseMs })
    },
    raw: compactRawEvidence(root, parsed),
    normalizationWarnings: warnings
  });
}
