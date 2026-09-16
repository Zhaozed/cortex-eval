# 飞书功能场景 E2E 评测集

**仅原始33条：文档6 + 消息7 + 日程8 + 组合12。已导入平台，但当前是锁定预览版，尚不能执行验收。**

## 当前交付

| 项目 | 状态 |
|---|---|
| 飞书专属测试集 | 飞书功能场景 E2E｜原始33条；ID `01a0a319-d701-73bb-ba2c-7e4f45833c7f`；33条已导入并回读确认 |
| Endpoint | 飞书 E2E｜本地8080｜串行；ID `01a0a312-3729-775a-bab0-540700ebe873` |
| 请求 | `POST http://127.0.0.1:8080/eval/e2e`，JSON，`bodySelector=/request_body` |
| 超时/并发 | 600秒 / 1；Case每轮240秒以内，两轮总预算留出出站采集余量 |
| 账号 | `2075490654049271808`（int64标记序列化，不使用JS浮点） |
| 授权范围 | 联系人秦宇龙、飞书测试群、本人；日程邀请本人和秦宇龙 |
| 文档 | 以「飞书测试文档-auto」为来源，修改默认在Case独立副本中做，保留原文 |
| 执行日 | 2026-09-15，Asia/Shanghai；会议时段在准备时查询，不硬编码已过去的时间 |
| 当前阻塞 | 本UID在8080服务的Router授权目录中，15个飞书工具未授权 |
| 实际业务执行 | 0/33；未发送测试消息，未创建/修改文档或日程；未执行Judge |

### 已核实的阻塞，不是猜测

2026-09-15 11:17（Asia/Shanghai）只读预检返回可消费轨迹，但Router选择CHAT，实际工具调用0次。其真实输入中的“未授权工具”目录包含15个飞书工具。请求ID：`493a39b6abc34308b9ce1865d8d1e2a0`。

因此只能确认**本服务未给该UID提供飞书授权**，不能据此说文档不存在或判飞书功能失败。没有使用其他CLI身份绕过Cortex账号。需要先让该UID的飞书授权在8080服务生效，再重新核对资源。

## 文件

| 文件 | 内容 |
|---|---|
| `评测集说明与用例.md` | 33条对应原文的前置、Prompt、逐轮工具、验收与清理 |
| `cases.draft.jsonl` | 平台已导入的33条锁定预览Case，非可执行版 |
| `scenarios.json` / `source-index.json` | 调整后的33条 / 保持不变的原文索引 |
| `source-cases.txt` | 用户原文副本，未改动 |
| `suite-config.json` / `endpoint-config.json` | 用户已提供信息 / 实际Endpoint配置 |
| `preparation-plan.json` / `batches.json` | 前置顺序、每例创建/读取/修改/取消链及运行顺序 |
| `preflight.py` / `preflight-report.json` | 可重跑的只读核对 / 本次实际阻塞证据摘要 |
| `build-cases.ts` / `assertions.ts` / `verify-cases.ts` | 导入构建器 / 冻结断言 / 离线合成验证 |
| `bindings.example.json` / `fixture.example.json` | 内部真实证据绑定格式，不是要求用户填写的材料表 |
| `人工验收记录.csv` | 33行人工UI、按钮及原生资源验收记录，当前均未执行 |
| `.local/` | 私有API回执和完整预检轨迹；已gitignore，不提交 |

## 前置与CRUD安排

| 阶段 | 操作 | 失败处理 |
|---|---|---|
| P00 授权核对 | 使用指定UID查询飞书本人 | 当前阻塞；禁止继续写入 |
| P01 资源定位 | 秦宇龙、飞书测试群/成员、测试文档、已有可写日历、真实会议室 | 同名不猜，保留候选 |
| P02 文档前置 | 从测试文档创建Case独立副本，补测试段落/备选子块，回读冻结 | 保留用户原文；不提前完成D03/X08被测创建 |
| P03 消息前置 | 在授权对象准备并回读真实消息和线程，记录ID/全文/发送人 | 不冒充秦宇龙，不为凑20条刷屏 |
| P04 日程前置 | 创建独立“测试”原会、检查人员和真实房间、按ID回读 | 无房间/权限则相关Case阻塞，不用location假装预约 |
| Freeze | 从工具真实结果绑定ID、完整blocks/attendees及未来时段，生成ready | 没证据不解锁；不手改标志假装就绪 |
| Eval | 专用Endpoint，串行执行各Case | 前置失败不发请求，写结果未知先只读回查，不盲目Retry |
| Cleanup | 经确认按资源清单精确取消测试日程并检查房间释放 | 本期没有文档/消息删除工具，留原生飞书人工清理 |

- 准备与清理是Case外步骤，**不增加评测Case数量**。当前仅完成规划，没有执行前置创建。
- 每例使用独立fixture；建议顺序不等于平台依赖调度，不能依赖“上一个Case刚创建的ID”。本例多轮仍保留真实上下文。
- D01按原文允许的“唯一命中”路径适配用户提供的文档，不额外制造重名资源。M01保留按资源类型查询，不强造同名用户。
- X11/X12保持只读/能力边界性质，不能为了凑CRUD而给测试轮添加写入。
- 若秦宇龙就是本人，X09“两名接收人”前置不成立，不能重复发送两遍冒充覆盖。
- 全群邀约若涉及本人和秦宇龙之外的成员，需扩展邀约授权；不能把“可向群发消息”当作“可邀请群里所有人”。
- 需要秦宇龙发言的消息场景必须采用他的真实测试消息；缺少则记录前置不足，不能伪造发言。
- 本期工具可以发现/预约已有会议室，**不能创建实体会议室或新日历**。用户授权不等于工具已支持。

## 预览锁与生成可执行版

`cases.draft.jsonl`保留真实UID、Prompt和断言，但使用`execution_mode=client`且不提供sid。已实测8080入口在Router之前返回`EVAL_E2E_CLIENT_CONTEXT_REQUIRED`。这是真正的执行前门禁，断言里的失败项只是二次标记，不能用评估阶段断言阻止REST副作用。

**不要手工补sid解锁草稿。** 授权及前置准备完成后，由真实证据生成`bindings.local.json`，再用构建器生成新的`cases.ready.jsonl`。ready：单轮isolated、多轮client且每例独立sid；请求不同时传text/conversation。sid可由本地生成非空唯一字符串，但不同sid不证明服务端完全隔离；同账号禁止并发和混入其他客户端操作。

```bash
cd '/Users/joey/Documents/cortex测评/cortex-eval'
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
# 授权修复后只读重查；该脚本不创建fixture、不导入、不自动运行Case。
python3 test_suite/feishu-e2e/preflight.py
# 在真实前置资源创建、核验并绑定之后：
pnpm exec tsx test_suite/feishu-e2e/build-cases.ts --bindings test_suite/feishu-e2e/bindings.local.json
# 离线验证当前草稿，不调用Agent/Judge：
pnpm cases:validate test_suite/feishu-e2e/cases.draft.jsonl
pnpm exec tsx test_suite/feishu-e2e/verify-cases.ts
```

导入是**完整替换**，只替换本飞书测试集；先dryRun预检并核对revision，不覆盖已有待办/Notion测试集。Endpoint不裁剪响应，保存完整E2E信封；平台是在创建Run时选择Endpoint，不虚构Suite已持久绑定Endpoint。

## 验收口径

| 判定层 | 依据 |
|---|---|
| 硬规则 | 每轮真实calls/唯一终态/参数/provider、允许写工具及次数、写后原ID回读关联 |
| 真实交付 | 每轮final_output和delivered_messages的req_id/内容一致 |
| 业务Judge | 对照真实基线、写前后顺序、完整正文/人员/房间保留、来源与错误披露 |
| UI协议Judge | 实际出站A2UI数据，不以Planner计划、空数组或HTTP200当成功 |
| 人工验收 | 原生资源核验、视觉渲染、真实按钮确认/取消/改正文；文本确认不等于按钮验收 |

全部Case `threshold=1`；正常Case四项验收均须通过。草稿另带未绑定失败项。自动评分不代替真实按钮/原生资源核验。

结论分开记录PASS、产品FAIL、BLOCKED、EVIDENCE_INSUFFICIENT、EVALUATION_ERROR；覆盖分母保留33。当前没有业务通过率，不将授权阻塞或离线检查通过当作产品通过。

离线结果：33条平台契约预检通过；1126项合成检查通过。真实验证仅有一次只读授权预检及一次入口安全门禁检查，非33条验收。
