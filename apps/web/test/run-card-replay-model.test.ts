import { expect, it } from "vitest";
import { cardReplayFrames } from "../src/features/runs/run-card-replay-model.ts";
it("preserves incremental prefixes, separates surfaces and never mutates saved evidence", () => {
  const first = {
    messages: [
      { createSurface: { surfaceId: "tasks" } },
      { updateComponents: { surfaceId: "tasks", components: [{ id: "root" }] } }
    ]
  };
  const second = {
    messages: [
      { updateDataModel: { surfaceId: "tasks", value: { count: 2 } } },
      { createSurface: { surfaceId: "calendar" } }
    ]
  };
  const source = [first, second];
  const saved = JSON.stringify(source);
  const frames = cardReplayFrames(source);
  expect(frames.map((f) => [f.batch, f.surface])).toEqual([
    [0, "tasks"],
    [1, "tasks"],
    [1, "calendar"],
    [1, null]
  ]);
  expect(frames[1]?.payloads).toEqual([first, { messages: [second.messages[0]] }]);
  expect(frames[2]?.payloads).toEqual([{ messages: [second.messages[1]] }]);
  expect(JSON.stringify(source)).toBe(saved);
});
it("retains prior stages while deletion-only updates do not become broken empty cards", () => {
  const frames = cardReplayFrames([
    { messages: [{ createSurface: { surfaceId: "a" } }] },
    { messages: [{ deleteSurface: { surfaceId: "a" } }] }
  ]);
  expect(frames).toHaveLength(1);
  expect(frames[0]?.batch).toBe(0);
});
it("replays repeated IDs as separate incarnations while preserving later deltas and other surfaces", () => {
  const create = (surfaceId: string) => ({ createSurface: { surfaceId } });
  const update = (surfaceId: string, value: number) => ({ updateDataModel: { surfaceId, value } });
  const payloads = [
    { messages: [create("chip"), update("chip", 1), create("tasks")] },
    { messages: [create("chip"), update("chip", 2)] },
    { messages: [update("chip", 3)] }
  ];
  const original = JSON.stringify(payloads);
  const frames = cardReplayFrames(payloads);
  expect(frames[0]?.payloads).toEqual([{ messages: [create("chip"), update("chip", 1)] }]);
  expect(frames.find((f) => f.batch === 1 && f.surface === "chip")?.payloads).toEqual([
    payloads[1]
  ]);
  expect(frames.at(-1)?.payloads).toEqual([
    { messages: [create("tasks")] },
    payloads[1],
    payloads[2]
  ]);
  expect(JSON.stringify(payloads)).toBe(original);
});

it("isolates identical surface IDs across conversation turns", () => {
  const frames = cardReplayFrames([
    {
      _eval_turn_index: 0,
      messages: [
        { createSurface: { surfaceId: "same", catalogId: "a" } },
        { updateDataModel: { surfaceId: "same", value: { title: "first" } } }
      ]
    },
    {
      _eval_turn_index: 1,
      messages: [
        { createSurface: { surfaceId: "same", catalogId: "a" } },
        { updateDataModel: { surfaceId: "same", value: { title: "second" } } }
      ]
    }
  ]);
  expect(frames).toHaveLength(2);
  expect(frames[0]?.label).toContain("第 1 轮");
  expect(frames[1]?.label).toContain("第 2 轮");
  expect(JSON.stringify(frames[1]?.payloads)).not.toContain("first");
});
