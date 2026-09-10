import { expect, it } from "vitest";
import { RunAutoCaptureRenderer } from "../src/run-auto-capture-renderer.ts";

// Explicit local smoke only: no Agent, Judge, business writes, or production Run evidence.
const root = process.env.CORTEX_A2UI_SMOKE_STATIC_ROOT;
it.skipIf(!root)(
  "production Web viewer captures both isolated carousel views",
  async () => {
    const payload = {
      messages: [
        {
          version: "v0.9",
          createSurface: {
            surfaceId: "smoke",
            surfaceType: "inline",
            catalogId: "https://loona.dm/catalog/v1",
            theme: { name: "dark" },
            sendDataModel: true
          }
        },
        {
          version: "v0.9",
          updateComponents: {
            surfaceId: "smoke",
            components: [
              { id: "root", component: "Column", children: ["cards"] },
              {
                id: "cards",
                component: "Carousel",
                cardWidth: 400,
                cardHeight: 100,
                autoHeight: true,
                controls: true,
                indicator: true,
                currentIndex: { path: "/idx" },
                children: ["card1", "card2"]
              },
              { id: "card1", component: "Card", width: 400, padding: 12, child: "text1" },
              { id: "text1", component: "Text", text: "自动截图隔离验证 · 未调用 Agent" },
              { id: "card2", component: "Card", width: 400, padding: 12, child: "text2" },
              { id: "text2", component: "Text", text: "第二张卡片 · 多图隔离验证" }
            ]
          }
        },
        { version: "v0.9", updateDataModel: { surfaceId: "smoke", path: "/", value: { idx: 0 } } }
      ]
    };
    const renderer = new RunAutoCaptureRenderer(undefined, root);
    const images = await renderer.render({
      payloads: [payload],
      signal: new AbortController().signal
    });
    expect(images.map((image) => image.label)).toEqual(["卡片 1 · 视图 1", "卡片 1 · 视图 2"]);
    expect(new Set(images.map((image) => image.base64)).size).toBe(2);
    for (const image of images) {
      const bytes = Buffer.from(image.base64, "base64");
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(bytes.length).toBeGreaterThan(1000);
    }
  },
  90_000
);
