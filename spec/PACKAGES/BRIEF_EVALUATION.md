# Brief 内容评测

## 职责与边界

Brief 评测复用 Endpoint、Case、Run 和 Report，不新增独立任务或数据表。Daily 与 Meeting 通过冻结 Bundle 的类型分流，共用 Cortex replay Endpoint。此链路验证已采集材料的内容消费，不验证在线取数召回、触发时机、推送投递或真实卡片渲染。

Bundle 是 Cortex 已采集的有界材料快照，不等于用户全部长期记忆。标注来源必须存在于 Bundle。评测执行不读取实时 snapshot。GT 保存在语义评测配置，业务请求只携带 replay 输入，防止答案泄漏。

## 协议与状态

输入和标注协议以 [Brief 合约](../../packages/contracts/src/brief-evaluation-contracts.ts)、[Case 合约](../../packages/contracts/src/case-contracts.ts) 为准。Case 保存时校验类型、来源引用、唯一原子 ID 与容量范围。Bundle 与 GT 随既有 Case 快照和哈希冻结；存储边界见 [存储 Schema](../../packages/storage-sqlite/src/sqlite-brief-evaluation-schema.ts)。

最终内容只读取 replay 的输出文本与卡片，不把 model_input 或 model_result 当成结果。generated、empty 和 fact_only_fallback 是否满足预期由各 Case 配置决定。delivered 必须为 false，界面不将回放描述为真实交付。

## 评分与异常

[原子问题编译器](../../packages/authoring/src/brief-decision-plan.ts) 生成 P0、P1、P2、全局相关性和全材料事实核对问题。[Brief 评测器](../../packages/evaluation-adapters/src/brief-semantic-evaluator.ts) 以代码确定性计算 P0 50%、P1 20%、噪音抑制 30%。P0/P1 空层级不计权重，剩余权重归一化。噪音抑制按 P2 排除判断和全局相关性判断的平均值计算，不等同于输出 token 的信噪比。

确认事实捏造后质量得分为零。容量和生成状态单独作为通过门禁，不任意修改质量分。字符数按 Unicode 码点统计，卡片累计字符串值而非序列化字符或渲染尺寸。

裁判必须返回可解释的判断；事实命中和捏造、噪音出现判断还必须提供能匹配最终输出的引文。UNKNOWN、缺失回答或无效证据由 [错误映射](../../packages/application/src/features/evaluation/brief-evaluation-error.ts) 转为该 Case 的 EVALUATION_ERROR，分数为空，不当作内容零分。[评测编排](../../packages/application/src/features/evaluation/platform-evaluation-service.ts) 继续提交批次结果，用户可沿既有流程重试。取消仍中断；未配置裁判以单 Case 配置错误记录。

JEV 模式复用既有 HTTP JEV Provider，LLM 模式使用冻结的 Run Evaluator；两者均须提供 reason/evidence。只返回选择与概率的服务不能完成本链路的可审计评测。仓库 Mock 验证协议与错误路径，不代表真实供应商能力或端到端联调已验收。

## 界面与验收入口

[Case 编辑器](../../apps/web/src/features/test-suites/brief-case-fields.tsx) 提供材料导入、Daily/Meeting 选择、原子表与容量约束。切换评测模式显式替换语义规则，不静默修改业务输入或通用断言。[Endpoint 预设](../../apps/web/src/features/configurations/brief-endpoint-preset.tsx) 不覆盖部署地址或认证。

[结果视图](../../apps/web/src/features/runs/run-brief-content.tsx) 展示最终文本、卡片 JSON、原子判断与证据；[分类汇总](../../apps/web/src/features/runs/run-brief-summary.tsx) 分别统计 Daily/Meeting，裁判异常不进入质量分母。

验收入口为 [合约测试](../../packages/contracts/test/brief-evaluation-contracts.test.ts)、[评分测试](../../packages/evaluation-adapters/test/brief-semantic-evaluator.test.ts)、[编排隔离测试](../../packages/application/test/brief-evaluation-orchestration.test.ts)、[存储测试](../../packages/storage-sqlite/test/sqlite-brief-roundtrip.test.ts) 和 [界面测试](../../apps/web/test/brief-content.test.tsx)。[接入样例](../../test_suite/brief-content/README.md) 均为合成材料，不包含真实用户记忆。

## 可配置裁判

- `semanticEvaluation.brief.judge`: `JEV | LLM`；不填保持旧 JEV 行为。
- Endpoint 只控制被测生成请求，不能决定裁判。GT 与 judge 不进入 `vars.request_body`。
- JEV 使用既有服务端配置。LLM 使用 Run 中冻结的 Evaluator 配置，复用现有模型配置资源，不引入第二套密钥管理。
- 调度器按 Case 选择一种 Provider，不回退到另一种。LLM 不依赖任何 JEV 环境变量。
- LLM 必须返回严格 JSON、完整且唯一的 questionId、PASS/FAIL/UNKNOWN、reason/evidence；与 JEV 复用原子打分和引文验证。
- LLM 超时按冻结配置限制；取消信号传至客户端。配置缺失、无效结果、UNKNOWN、证据不合格均隔离为单 Case EVALUATION_ERROR。
- Report 显示实际 Provider 与模型；用量归类为语义裁判，避免 LLM 被标成 JEV。
- 单条合成冒烟：[daily.smoke.case.json](../../test_suite/brief-content/daily.smoke.case.json)。仅接线验证，不是质量基线。


## 固定样本重评与 Judge prompt 版本

`brief.judgePrompt` 是可选的评分主指令（1–30000 字符）；缺省使用默认指令。评分数据仍仅包含冻结材料、最终输出、目标与 Rubric，不暴露 model_input。安全约束、结构化返回协议、证据逐字校验不由自定义主指令覆盖。

校准通过 run 的 scoring-only rerun 创建独立版本，支持更换冻结的 LLM 配置、Rubric、主指令和补充指令。输入与生成输出不变，规则差异保存在 Case 级语义评测快照；不使用通用 Rubric Prompt 库替代该快照。仅重评不生成缺失输出：缺输出时先正常执行生成，再以保存的输出做校准。

对比不同规则仅能证明评分变化；判断裁判是否更准确仍需独立人工标注/期望评分作为校准基准。
