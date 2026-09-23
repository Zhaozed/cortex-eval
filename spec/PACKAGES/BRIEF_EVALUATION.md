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

裁判必须返回可解释的判断；事实命中和捏造、噪音出现判断还必须提供能匹配最终输出的引文。UNKNOWN、缺失回答或无效证据由 [错误映射](../../packages/application/src/features/evaluation/brief-evaluation-error.ts) 转为该 Case 的 EVALUATION_ERROR，分数为空，不当作内容零分。[评测编排](../../packages/application/src/features/evaluation/platform-evaluation-service.ts) 继续提交批次结果，用户可沿既有流程重试。取消仍中断；未配置裁判仍属于运行配置故障。

当前复用既有 HTTP JEV Provider；其实际服务必须支持返回 reason/evidence。只返回选择与概率的服务不能完成本链路的可审计评测。仓库 Mock 验证协议与错误路径，不代表真实供应商能力或端到端联调已验收。

## 界面与验收入口

[Case 编辑器](../../apps/web/src/features/test-suites/brief-case-fields.tsx) 提供材料导入、Daily/Meeting 选择、原子表与容量约束。切换评测模式显式替换语义规则，不静默修改业务输入或通用断言。[Endpoint 预设](../../apps/web/src/features/configurations/brief-endpoint-preset.tsx) 不覆盖部署地址或认证。

[结果视图](../../apps/web/src/features/runs/run-brief-content.tsx) 展示最终文本、卡片 JSON、原子判断与证据；[分类汇总](../../apps/web/src/features/runs/run-brief-summary.tsx) 分别统计 Daily/Meeting，裁判异常不进入质量分母。

验收入口为 [合约测试](../../packages/contracts/test/brief-evaluation-contracts.test.ts)、[评分测试](../../packages/evaluation-adapters/test/brief-semantic-evaluator.test.ts)、[编排隔离测试](../../packages/application/test/brief-evaluation-orchestration.test.ts)、[存储测试](../../packages/storage-sqlite/test/sqlite-brief-roundtrip.test.ts) 和 [界面测试](../../apps/web/test/brief-content.test.tsx)。[接入样例](../../test_suite/brief-content/README.md) 均为合成材料，不包含真实用户记忆。
