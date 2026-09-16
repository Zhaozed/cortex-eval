/* 冒烟桩：验证 build-cases.ts 的取值/门禁/per-case 阈值链路，不是真断言。
 * 与真 rules 同契约：DIMENSION_IDS / dimensionMeta / buildAssertions，硬性 weight=20、质量 weight=1、得分二值。 */
export const DIMENSION_IDS = ["D1.1","D1.2","D1.3","D1.4","D2.1","D2.2","D2.3","D2.4","D2.5","D3.1","D3.2","D3.3","D3.4","D3.5","D4.1","D4.2","D4.3","D4.4","D4.5","D4.6","D4.7","D4.8","D5.1","D5.2","D5.3","D5.4","D5.5","D5.6","D5.7","D5.8","D6.1","D6.2","D6.3","D6.4","D6.5","D6.6","D6.7"];
const QUALITY = new Set(["D4.7", "D4.8", "D5.6"]);
const LAYERS: Record<string, string> = { D1: "意图与路由", D2: "工具编排", D3: "结果真实性", D4: "语音可播报性", D5: "视觉交互 A2UI", D6: "安全与边界" };
export function dimensionMeta(id: string) {
  const layer = id.split(".")[0]!;
  const hard = !QUALITY.has(id);
  return { id, layer, layerName: LAYERS[layer] ?? layer, name: `${id} 桩`, hard, kind: hard ? "HARD" : "SOFT", weight: hard ? 20 : 1, judges: id };
}
export function buildAssertions(ctx: any) {
  const dims: string[] = ctx?.scenario?.dimensions ?? [];
  return dims.map((d) => {
    const meta = dimensionMeta(d);
    return {
      type: "javascript",
      metric: `${meta.hard ? "【硬性】" : "【质量】"}${d} ${meta.name}｜桩断言，只验证构建链路`,
      weight: meta.weight,
      value: `// v2 ${d}\nconst CFG = ${JSON.stringify({ d, caseId: ctx?.caseId })};\nreturn { pass: true, score: 1, reason: "桩：未实判（" + CFG.d + "）" };`
    };
  });
}
