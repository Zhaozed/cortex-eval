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
it("keeps repeated snapshot updates and later display cards in the replay", () => {
  const payloads = [
    {
      messages: [
        { createSurface: { surfaceId: "infoChip" } },
        {
          updateComponents: {
            surfaceId: "infoChip",
            components: [{ id: "root", component: "InfoChip" }]
          }
        },
        { updateDataModel: { surfaceId: "infoChip", value: { text: "搜索中" } } }
      ]
    },
    {
      messages: [
        { createSurface: { surfaceId: "infoChip" } },
        {
          updateComponents: {
            surfaceId: "infoChip",
            components: [{ id: "root", component: "InfoChip" }]
          }
        },
        { updateDataModel: { surfaceId: "infoChip", value: { text: "已完成" } } }
      ]
    },
    {
      messages: [
        { createSurface: { surfaceId: "tasks" } },
        {
          updateComponents: { surfaceId: "tasks", components: [{ id: "root", component: "Card" }] }
        },
        { updateDataModel: { surfaceId: "tasks", value: { title: "发布方案 V2｜正式版" } } }
      ]
    }
  ];
  const original = JSON.stringify(payloads);
  const frames = cardReplayFrames(payloads);
  const second = payloads[1];
  if (!second) throw new Error("test fixture missing second payload");
  const chipFrame = frames.find((f) => f.batch === 1 && f.surface === "infoChip");
  expect(chipFrame?.payloads).toEqual([
    payloads[0],
    {
      messages: [
        { updateComponents: second.messages[1]!.updateComponents },
        { updateDataModel: second.messages[2]!.updateDataModel }
      ]
    }
  ]);
  const displayFrame = frames.find((f) => f.batch === 2 && f.surface === "tasks");
  expect(displayFrame?.payloads).toEqual([payloads[2]]);
  expect(frames.at(-1)?.payloads.flatMap((p) => p.messages)).toHaveLength(8);
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
