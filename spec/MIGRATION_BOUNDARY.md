# 迁移边界

## 文档职责

本文档记录当前 SQLite 本地版通过已落地的 Canonical Export 能提供的迁移事实，以及未来平台化必须重新设计的边界。代码状态由 [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md) 说明。

## 可直接导出的事实

Canonical Export v1 导出当前测试集与 Cases、当前配置与 Prompts、历史冻结 Runs、Case/Eval 规范化结果、当前 Analysis、Contract Versions 和 Artifact 预期元数据。Secret 只保留环境变量引用名称，Raw Evidence 默认不内嵌。

导出使用版本化 Manifest、稳定排序的 Canonical JSONL、RFC 8785 和 SHA-256。具有 UUID 主键的资源、Run 和当前 Analysis 使用 `{ id }`；Case Result 与 Eval Result 使用真实 `{ runId, caseKey }` 复合身份。Local Server 在打开成功响应前、CLI 接收端在原子发布前，分别从磁盘完成计数、引用、实体 Hash 和文件 Hash 四类对账。Raw Artifact 缺失或内容不匹配不阻止规范化实体导出，但必须标记 `present=false` 并保留预期 Hash 与大小；`present` 表示源文件验证可用，`included` 只表示是否复制进本次导出。

SQLite 只在 `backup()` 期间持有短一致性边界，之后从 0600 owner-only 只读副本流式投影，避免长读事务阻塞主库写入。Storage 在投影前复用当前 Configuration、Case、Run、REST、Eval 与 Analysis Mapper 清洗持久脏数据；LLM 只输出 Env Secret 引用，不输出展开值。传输使用独立 `EXPORT_*` 事件，不复用 Work Package `PACKAGE_*` 身份。CLI 在目标父目录创建带 Owner/PID 启动身份的 staging，验证完整事件顺序、Hash、Manifest 和独立重算结果后才原子发布。

## 必须重新设计的边界

- Tenant Context 和租户内唯一约束。
- 用户认证、授权、审计和多人协作。
- 多实例调度、持久任务队列、Worker、租约和分布式取消。
- Secret Manager、租户 Secret 授权和轮换。
- 外置 Artifact 存储、生命周期、访问控制和完整性校验。
- 资源版本、Attempt 历史、数据保留与合规策略。

## 明确不承诺

未来迁移不能只替换 SQLite Adapter。Application、Contracts、Storage Schema、唯一约束、运行状态和安全模型都允许因平台需求演进。

当前 Goal 不实现 PostgreSQL、Canonical Import、多用户、认证授权、Worker、任务队列、Secret Manager、外置 Artifact Store 或备份恢复。

P1 冻结的 Canonical Export v1 已在 P10 按真实复合身份和独立 Transport 补齐。导出执行、双重读回、API/CLI、原子发布、确定性性能与安全门禁，以及同一次发布调用中的两项真实 Gemini Smoke 均已完成。

## 目标代码与测试入口

- 目标阶段：[tasks/P10_FINAL_HARDENING.md](../tasks/P10_FINAL_HARDENING.md)
- 协议事实：[packages/contracts/src/canonical-export-contracts.ts](../packages/contracts/src/canonical-export-contracts.ts)
- Application 投影：[canonical-export-projection-service.ts](../packages/application/src/features/canonical-export/canonical-export-projection-service.ts)
- SQLite 快照：[sqlite-canonical-export-snapshot.ts](../packages/storage-sqlite/src/sqlite-canonical-export-snapshot.ts)
- 独立接收与对账：[packages/canonical-export/src](../packages/canonical-export/src)
- Local Server 编排：[canonical-export-service.ts](../apps/local-server/src/canonical-export-service.ts)
- CLI HTTP 与发布：[data-export-command-service.ts](../apps/cli/src/data-export-command-service.ts)
- 测试入口：[canonical-export-receiver.test.ts](../packages/canonical-export/test/canonical-export-receiver.test.ts)、[canonical-export-runtime.test.ts](../apps/local-server/test/canonical-export-runtime.test.ts)、[data-export-command-service.test.ts](../apps/cli/test/data-export-command-service.test.ts)
