# Web Test Suites

## 模块职责

该 Feature 提供测试集与 Case 的列表、详情、创建、复制、编辑、删除、导入、导出、搜索、过滤和分页界面。

模块不自行解析 Rubric 引用、计算 Definition Hash 或执行批量写入事务。

## 边界与依赖

页面依赖 Test Suites Application API。表单结构和 JSON 编辑器使用同一保存协议，后端统一执行完整校验。

## 实现状态

目标 Feature 尚未落地。

## 目标代码落点

`apps/web/src/features/test-suites`

## 当前代码事实入口

尚无当前 Web 代码入口。

## 当前样例与测试入口

- [loona_promptfoo_tests.json](../../test_suite/current/cases/loona_promptfoo_tests.json)
- [test_convert_loona_to_promptfoo.py](../../data_scripts/test_convert_loona_to_promptfoo.py)

## 对外接口

列表展示 Case ID、描述、业务模块、场景标签、Assertion 类型、Metrics 和更新时间。支持按 Case ID、描述、业务模块、场景标签、Assertion 类型和 Metric 组合过滤。

Case 编辑器使用共享 Draft。结构化模式编辑公共字段并为每条 Assertion 保留完整 JSON，完整 JSON 模式编辑整个 Case；切换前必须成功解析。锁定 Promptfoo 版本接受的未知字段必须原样保留，不能被表单静默删除。

## 核心流程

用户创建空测试集或导入 JSON，查看服务端分页 Cases，编辑结构化字段或 JSON，并通过同一 API 保存。删除和全量替换前展示影响范围并确认。

## 状态、事务与幂等

URL 或 Feature State 显式保存分页和过滤条件。保存冲突保留用户输入并刷新服务端事实。历史运行快照不随当前 Case 修改或删除变化。

## 错误收敛

单 Case 错误展示字段路径；批量导入错误同时展示 Case 顺序和 Case ID。引用、身份和并发冲突不自动覆盖。

## 观测与验收

千级 Case 列表保持可用。正在运行使用的测试集禁止删除。所有 Case 写入口呈现一致的校验结果。

## 相关测试

目标测试覆盖 CRUD、复制、导入回滚、分页、组合过滤、JSON 与结构化编辑一致性、删除确认和错误定位。
