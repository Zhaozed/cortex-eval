# Brief 内容评测接入

## 1. 配置被测接口

在平台「配置」创建 Endpoint，点击「使用 Brief replay 参数预设」，填写已部署 Cortex 的 `POST /eval/e2e/brief/replay` 完整地址及认证。Daily / Meeting 共用此配置，由请求里的 `bundle.brief_type` 区分。

预设只修改名称、Body Selector、超时与并发，不改地址或凭据。请求 Body Selector 必须为 `/request_body`，超时为 150000 ms，并发为 2。参考 [endpoint.config.json](endpoint.config.json)；localhost 只是占位，不表示服务已启动。若修改请求的生成超时，Endpoint 超时也需相应调整。

## 2. 准备 Case

分别建立 Daily Brief、Meeting Brief 测试集。可导入 [daily.cases.jsonl](daily.cases.jsonl) 和 [meeting.cases.jsonl](meeting.cases.jsonl)，或在 Case 的高级 JSON 编辑器粘贴 [daily.case.json](daily.case.json)、[meeting.case.json](meeting.case.json)。样例只有合成材料，适合验证接线，不代表真实模型质量基线。

在 Case 编辑器选择「Brief 内容评测」与类型。材料区接受 Bundle、完整 replay 请求或成功 snapshot 响应，也可上传 JSON。替换为经授权脱敏的材料，再填写 P0 必要事实、P1 补充事实、P2 应排除内容及 Bundle 内的 JSON pointer 来源。

材料是已采集的有界快照，不是全部 LiveMem。需要验证前置取数召回时，应另建采集层评测，不用此内容评测的分数代替。

GT 必须放在 `semanticEvaluation.brief`；`vars.request_body` 只含 replay 参数。现有通用检查不会被静默覆盖；可显式点击「替换为 Brief replay 基础检查」。评分使用 P0 50%、P1 20%、噪音抑制 30%，空层级重新归一化；幻觉置零；容量与生成状态独立门禁。阈值可逐 Case 设置。

## 3. 配置裁判并运行

既有服务端语义裁判使用 `CORTEX_JEV_ENDPOINT`、`CORTEX_JEV_MODEL`、`CORTEX_JEV_API_KEY_ENV`。后者填写存放 Key 的环境变量名，而不是 Key 本身；对应变量也必须在服务进程中设置。Case 的语义评测走这条裁判链，不能把普通 Run Evaluator 的配置当作已配置 JEV。运行配置页仍沿用现有 Evaluator 选择流程。

裁判须兼容平台既有 JEV HTTP 协议，返回 PASS/FAIL/UNKNOWN 及 reason/evidence。事实命中与捏造/噪音出现的引文必须来自最终输出。仅返回概率或选项的服务会得到 EVALUATION_ERROR，而不是可靠的 Brief 分数。真实服务返回证据的能力尚未在本次改造中验证，正式批量评测前先跑两条人工可核验样本。

运行后在结果页查看最终文本、卡片 JSON、原子判断及来源，并查看 Daily/Meeting 分类汇总。卡片 JSON 不是终端实际渲染效果。UNKNOWN、缺失回答和证据不足显示评测异常，不计为零分；确认幻觉才会置零。

## 交付边界

本次不自动创建数据库配置、不部署 Cortex、不采集真实用户数据、不发起付费模型请求。Snapshot 在线采集按钮、标注人员分工审核和自动抽检工作流未新增；先通过测试接口获取脱敏 JSON，再导入当前编辑器。
