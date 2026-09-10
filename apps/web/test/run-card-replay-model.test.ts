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
