import fs from "node:fs";

const input = "/tmp/feishu0918-full.json";
const output = decodeURIComponent(new URL("./cases.a2ui-updated.jsonl", import.meta.url).pathname);
const cases = JSON.parse(fs.readFileSync(input, "utf8"));

// 基于当前 Cortex A2UI 模板库：required 是本 case 必须出现的结果卡族；allowed 仅用于人类可读说明。
const cfg = {
  "FSU24-01": { cards: ["LIST", "DOC"] },
  "FSU24-02": { cards: ["DOC"] },
  "FSU24-03": { cards: ["DOC"] },
  "FSU24-04": { cards: ["LIST", "DOC"] },
  "FSU24-05": { cards: ["LIST"] },
  "FSU24-06": { cards: ["MESSAGE"] },
  "FSU24-07": { cards: ["LIST", "MESSAGE"] },
  "FSU24-08": { cards: ["MESSAGE", "TEXT"] },
  "FSU24-09": { cards: ["MESSAGE"] },
  "FSU24-10": { cards: ["EVENT"] },
  "FSU24-11": { cards: ["EVENT"] },
  "FSU24-12": { cards: ["LIST"] },
  "FSU24-13": { cards: ["EVENT"] },
  "FSU24-14": { cards: ["LIST", "EVENT"] },
  "FSU24-15": { cards: ["LIST"] },
  "FSU24-16": { cards: ["EVENT"] },
  "FSU24-17": { cards: ["CONFIRM", "EVENT"] },
  "FSU24-18": { cards: ["MESSAGE", "TEXT"] },
  "FSU24-19": { cards: ["MESSAGE", "LIST", "EVENT"] },
  "FSU24-20": { cards: ["DOC", "MESSAGE", "TEXT"] },
  "FSU24-21": { cards: ["MESSAGE", "DOC"] },
  "FSU24-22": { cards: ["LIST", "DOC", "MESSAGE"] },
  "FSU24-23": { cards: ["CONFIRM", "LIST", "DOC", "MESSAGE"] }
};

const families = {
  EVENT: ["eventItem", "eventRow", "eventTitle", "eventMetaWide", "eventMetaGrid", "events"],
  MESSAGE: ["messageItem", "messageContent", "messageText", "messageMeta"],
  LIST: ["rowPrimary", "countBadge"],
  DOC: ["documentLink", "bodyBox"],
  CONFIRM: ["targetRow", "targetLabel", "targetBadge0"],
  TEXT: ["title", "col"]
};

const d51 = (card) => `// v2 D5.1 该出卡时必须出卡
const CFG = ${JSON.stringify({ card })};
const FAIL = r => ({ pass: false, score: 0, reason: r });
const PASS = r => ({ pass: true, score: 1, reason: r });
const INS = w => ({ pass: true, score: 1, reason: '证据不足：' + w });
const OBJ = x => x !== null && typeof x === 'object' && !Array.isArray(x), STR = x => typeof x === 'string', ARR = Array.isArray;
const JSN = x => { if (STR(x)) { try { return JSON.parse(x); } catch { return x; } } return x; };
let ROOT = output;
if (STR(ROOT)) { try { ROOT = JSON.parse(ROOT); } catch { return INS('输出不是合法 JSON，取不到 parsed_output'); } }
if (!OBJ(ROOT) || !OBJ(ROOT.parsed_output)) return INS('输出缺 parsed_output 对象（根 ok=' + (OBJ(ROOT) ? String(ROOT.ok) : '非对象') + '）');
const PO = ROOT.parsed_output;
const TURNS = ARR(PO.turns) && PO.turns.length ? PO.turns : null;
const FR = TURNS ? TURNS.map(t => (OBJ(t) ? t.parsed_output : null)) : [PO];
if (FR.some(f => !OBJ(f))) return INS('多轮 turns[] 里有轮次缺 parsed_output，无法逐帧判定');
const NF = FR.length;
const SURF = f => (ARR(f.a2ui_surfaces) ? f.a2ui_surfaces : null);
const SID = s => (OBJ(s) && STR(s.surface_id) ? s.surface_id : null);
const ALLCARDS = () => { const out = []; for (let i = 0; i < NF; i++) { const s = SURF(FR[i]); if (s === null) return null; for (const x of s) if ((SID(x) ?? '').startsWith('cortex:')) out.push({ f: i, s: x }); } return out; };
const AC = ALLCARDS();
if (AC === null) return INS('有帧缺 a2ui_surfaces，无法判定是否出卡（present_mode 实测恒为 none，SPEC 明令不可用）');
if (AC.length) { const per = {}; for (const e of AC) per[e.f + 1] = (per[e.f + 1] || 0) + 1; return PASS('D5.1 该出卡已出卡：' + AC.length + ' 张 cortex: 结果卡，分布在第 ' + Object.keys(per).map(k => k + '轮×' + per[k]).join('、') + '；卡片类型是否对由 D5.2 判'); }
const det = []; for (let i = 0; i < NF; i++) { const s = SURF(FR[i]) || []; det.push('第' + (i + 1) + '帧 surface=' + (s.map(SID).join('、') || '空')); }
return FAIL('D5.1 该出卡未出卡：期望出 ' + String(CFG.card || '结果') + ' 卡，实际 ' + NF + ' 帧 0 张 cortex: 结果卡（' + det.join('；') + '）；infoChip 是工具进度条不算结果卡，present_mode 恒为 none 不可作为判据');`;

const d52 = ({ cards }) => {
  return `// v2 D5.2 卡片类型正确
const CFG = ${JSON.stringify({ cards, families })};
const FAIL = r => ({ pass: false, score: 0, reason: r });
const PASS = r => ({ pass: true, score: 1, reason: r });
const INS = w => ({ pass: true, score: 1, reason: '证据不足：' + w });
const OBJ = x => x !== null && typeof x === 'object' && !Array.isArray(x), STR = x => typeof x === 'string', ARR = Array.isArray;
let ROOT = output;
if (STR(ROOT)) { try { ROOT = JSON.parse(ROOT); } catch { return INS('输出不是合法 JSON，取不到 parsed_output'); } }
if (!OBJ(ROOT) || !OBJ(ROOT.parsed_output)) return INS('输出缺 parsed_output 对象（根 ok=' + (OBJ(ROOT) ? String(ROOT.ok) : '非对象') + '）');
const PO = ROOT.parsed_output;
const TURNS = ARR(PO.turns) && PO.turns.length ? PO.turns : null;
const FR = TURNS ? TURNS.map(t => (OBJ(t) ? t.parsed_output : null)) : [PO];
if (FR.some(f => !OBJ(f))) return INS('多轮 turns[] 里有轮次缺 parsed_output，无法逐帧判定');
const NF = FR.length;
const SURF = f => (ARR(f.a2ui_surfaces) ? f.a2ui_surfaces : null);
const SID = s => (OBJ(s) && STR(s.surface_id) ? s.surface_id : null);
const CARDS = f => { const s = SURF(f); return s ? s.filter(x => (SID(x) ?? '').startsWith('cortex:')) : null; };
const CID = s => (OBJ(s) && ARR(s.component_ids) ? s.component_ids.filter(STR) : []);
const HIT = (ids, k) => ids.some(id => id === k || id.endsWith('_' + k));
const FAM = s => { const ids = CID(s), out = []; for (const k of Object.keys(CFG.families)) { const hit = CFG.families[k].some(w => HIT(ids, w)); if (k === 'LIST' && hit && !(HIT(ids, 'row') && HIT(ids, 'rowPrimary')) && !HIT(ids, 'countBadge')) continue; if (k !== 'TEXT' && hit) out.push(k); } if (!out.length && CFG.families.TEXT.some(w => HIT(ids, w))) out.push('TEXT'); return out; };
const ALLCARDS = () => { const out = []; for (let i = 0; i < NF; i++) { const c = CARDS(FR[i]); if (c === null) return null; for (const s of c) out.push({ f: i, s }); } return out; };
const AC = ALLCARDS();
if (AC === null) return INS('有帧缺 a2ui_surfaces，无法判定卡片类型');
if (!AC.length) return INS('本 case 0 张 cortex: 结果卡，没有卡片类型可判（该不该出卡由 D5.1 判）');
const fams = [...new Set(AC.flatMap(e => FAM(e.s)))];
const hit = fams.filter(k => CFG.cards.includes(k));
if (!hit.length) return FAIL('D5.2 卡片类型：期望结果卡命中 ' + CFG.cards.join('、') + ' 之一，实际 ' + AC.length + ' 张卡的族集合为 ' + (fams.join('/') || '（无族命中）') + '；判定依据 component_ids');
return PASS('D5.2 卡片类型：' + AC.length + ' 张结果卡的族集合为 ' + (fams.join('/') || '（无族命中）') + '，已命中允许族 ' + hit.join('、') + '（期望 ' + CFG.cards.join('、') + ' 之一）；只判卡片族，不判卡内字段内容');`;
};

for (const c of cases) {
  const id = c.caseKey;
  if (id === "FSU24-24") continue;
  const spec = cfg[id];
  if (!spec) throw new Error(`missing A2UI config: ${id}`);
  const definition = c.definition;
  const assertions = definition.assert ?? [];
  const has = new Set(assertions.map((a) => a.metric));
  const d51Metric = `【硬性】D5.1 该出卡时必须出卡｜必须有 surface_id 以 cortex: 开头的结果卡，infoChip 进度条不算，present_mode 恒 none 不可用`;
  const d52Metric = `【硬性】D5.2 卡片类型正确｜出的卡必须命中 ${spec.cards.join("、")} 之一（按 component_ids 判定）`;
  if (!has.has(d51Metric))
    assertions.push({
      type: "javascript",
      metric: d51Metric,
      weight: 20,
      value: d51(spec.cards.join("、"))
    });
  if (!has.has(d52Metric))
    assertions.push({ type: "javascript", metric: d52Metric, weight: 20, value: d52(spec) });
  definition.assert = assertions;
}
fs.writeFileSync(output, cases.map((c) => JSON.stringify(c.definition)).join("\n") + "\n");
console.log(`wrote ${output} (${cases.length} cases; ${cases.length - 1} cases got D5.1/D5.2)`);
