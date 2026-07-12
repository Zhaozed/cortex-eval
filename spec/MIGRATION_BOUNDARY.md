# 迁移边界

## 文档职责

本文档记录当前 SQLite 本地版通过 Canonical Export 能提供的迁移事实，以及未来平台化必须重新设计的边界。当前只定义目标契约，代码落地状态由 [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md) 说明。

## 可直接导出的事实

Canonical Export v1 导出当前测试集与 Cases、当前配置与 Prompts、历史冻结 Runs、Case/Eval 规范化结果、当前 Analysis、Contract Versions 和 Artifact 预期元数据。Secret 只保留环境变量引用名称，Raw Evidence 默认不内嵌。

导出使用版本化 Manifest、稳定排序的 Canonical JSONL、RFC 8785 和 SHA-256。读回必须完成计数、引用、实体 Hash 和文件 Hash 四类对账。Raw Artifact 缺失不阻止导出，但必须标记 `present=false` 并保留预期 Hash 与大小。

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

P1 已冻结 Canonical Export v1 的请求默认值、Manifest、Canonical Entity JSONL Record、Artifact 存在性和四类对账结果 Schema。导出执行、读回和性能门禁仍属于 P10。

## 目标代码与测试入口

- 目标阶段：[tasks/P10_FINAL_HARDENING.md](../tasks/P10_FINAL_HARDENING.md)
- 协议事实：[packages/contracts/src/canonical-export-contracts.ts](../packages/contracts/src/canonical-export-contracts.ts)
- 目标代码：`packages/contracts`、`packages/application`、`apps/cli`、`apps/local-server`
- 代码和测试尚未落地；落地后必须替换为真实入口。
