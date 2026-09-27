# Brief 内容评测接入

## 1. 配置被测接口

在平台「配置」创建 Endpoint，点击「使用 Brief replay 参数预设」，填写已部署 Cortex 的 `POST /eval/e2e/brief/replay` 完整地址及认证。Daily / Meeting 共用此配置，由请求里的 `bundle.brief_type` 区分。

预设只修改名称、Body Selector、超时与并发，不改地址或凭据。请求 Body Selector 必须为 `/request_body`，超时为 150000 ms，建议首次并发为 1。参考 [endpoint.config.json](endpoint.config.json)；localhost 只是占位，不表示服务已启动。若修改请求的生成超时，Endpoint 超时也需相应调整。

## 2. 准备 Case

分别建立 Daily Brief、Meeting Brief 测试集。可导入 [daily.cases.jsonl](daily.cases.jsonl) 和 [meeting.cases.jsonl](meeting.cases.jsonl)，或在 Case 的高级 JSON 编辑器粘贴 [daily.case.json](daily.case.json)、[meeting.case.json](meeting.case.json)。样例只有合成材料，适合验证接线，不代表真实模型质量基线。

在 Case 编辑器选择「Brief 内容评测」与类型。材料区接受 Bundle、完整 replay 请求或成功 snapshot 响应，也可上传 JSON。替换为经授权脱敏的材料，再填写 P0 必要事实、P1 补充事实、P2 应排除内容及 Bundle 内的 JSON pointer 来源。

材料是已采集的有界快照，不是全部 LiveMem。需要验证前置取数召回时，应另建采集层评测，不用此内容评测的分数代替。

GT 必须放在 `semanticEvaluation.brief`；`vars.request_body` 只含 replay 参数。现有通用检查不会被静默覆盖；可显式点击「替换为 Brief replay 基础检查」。评分使用 P0 50%、P1 20%、噪音抑制 30%，空层级重新归一化；幻觉置零；容量与生成状态独立门禁。阈值可逐 Case 设置。

## 3. 配置裁判并运行

Case 编辑器的「内容裁判」选择 **JEV / LLM**，保存到 `semanticEvaluation.brief.judge`。旧 Case 未填写时仍走 JEV，保持兼容；GT、打分、幻觉门禁和证据规则不随裁判选择变化，不自动 fallback。

| 选择 | 配置来源 | 运行行为 |
| --- | --- | --- |
| JEV | 既有服务端 `CORTEX_JEV_ENDPOINT`、`CORTEX_JEV_MODEL`、`CORTEX_JEV_API_KEY_ENV` | Run Evaluator 不会替换 JEV；缺配置报错 |
| LLM | 创建 Run 时选择的 Evaluator（现有模型配置） | 使用冻结的模型、服务地址、密钥引用、超时；不调用 JEV |

`CORTEX_JEV_API_KEY_ENV` 填密钥变量名，不是 Key。LLM 复用已有 OpenAI-compatible / Gemini 客户端；凭据均留在服务端，Case 不复制密钥。Case 中旧 `semanticEvaluation.model` 仅对 JEV 有效，LLM 使用 Run 冻结模型。

两种裁判均须返回逐项 PASS/FAIL/UNKNOWN 及理由。事实命中与捏造/噪音出现须有最终输出中的逐字引文。仅返回选项或概率、不提供要求的证据时显示 EVALUATION_ERROR，而非质量零分。配置成功不等于已完成真实供应商验收。

运行后查看最终文本、卡片 JSON、原子判断、裁判类型/模型及来源。卡片 JSON 不是终端实际渲染效果。UNKNOWN、缺项、无效 JSON、超时和证据不足均为评测异常；确认幻觉才置零。

## 查看 Case 详情

测试集列表中点击 Case ID 或「查看详情」，可只读查看输入材料、原子 GT、内容裁判、生成与容量约束及完整 JSON；不会保存用例或触发评测。需要修改时关闭详情，再点击「编辑」。

## 4. 单条冒烟

导入 [daily.smoke.cases.jsonl](daily.smoke.cases.jsonl)（完整 Case 见 [daily.smoke.case.json](daily.smoke.case.json)）。默认 LLM，可在 Case 编辑器切换 JEV。

- Endpoint：使用你已有的 Cortex Brief replay 配置；本地服务为 `http://127.0.0.1:8080/eval/e2e/brief/replay`，Body Selector `/request_body`。
- LLM 模式：Run Evaluator 选择一个真实可用的模型配置，不能选占位的 noop Evaluator。
- 输入：冻结的合成记忆，一条今日 Atlas 承诺、一条深色界面偏好噪音。
- P0：提醒确认 20 个核心案例；提醒确认脱敏权限。P2：不把深色界面偏好当今日重点。
- 生成须为 `generated`，降级或空内容不能冒充正常生成。
- 首轮仅 1 条、并发 1。运行会调用 Cortex 生成模型和所选裁判，可能产生费用。

这是接线与人工核验样例，不是正式 Golden Set，也不预设被测模型必须通过。

## 交付边界

正式质量基线需另行采集授权脱敏材料并标注。本功能不自动采集真实用户数据；冒烟 Case 可通过平台导入，真实模型运行由用户启动。Snapshot 在线采集按钮、标注人员分工审核和自动抽检工作流未新增；先通过测试接口获取脱敏 JSON，再导入当前编辑器。
