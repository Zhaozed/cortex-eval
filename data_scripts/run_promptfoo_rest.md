# Promptfoo REST 运行器

该脚本读取 promptfoo 测试数组和 REST provider 配置，并将接口响应写入每条测试的 `providerOutput`。生成文件仍是 promptfoo 测试数组，可以直接作为 `tests` 输入执行断言。

## 命令行运行

在仓库根目录执行：

```bash
npx tsx data_scripts/run_promptfoo_rest.ts
```

默认路径：

- 输入：`test_suite/current/cases/loona_promptfoo_tests.json`
- provider：`test_suite/current/provider.json`
- 输出：`test_suite/current/run_result/loona_promptfoo_tests.json`

常用参数：

```bash
npx tsx data_scripts/run_promptfoo_rest.ts \
  --max-concurrency 8 \
  --timeout-ms 60000
```

`--max-concurrency` 限制单进程内同时进行的请求数。`--force` 忽略已有 `providerOutput` 并重跑全部测试。`--input`、`--provider`、`--output` 可以覆盖默认路径。

## 模块调用

```ts
import { runPromptfooRestSuite } from "./data_scripts/run_promptfoo_rest.ts";

const result = await runPromptfooRestSuite({
  maxConcurrency: 8,
  timeoutMs: 60_000
});
```

模块调用不输出日志，返回 `{ total, skipped, succeeded, failed, outputPath }` 汇总对象。

## 续跑与错误处理

每个请求完成后都会原子更新输出文件。再次运行时，脚本按 `metadata.case_id`、`description`、数组位置的优先级匹配已有结果：

- 已有 `providerOutput` 的测试直接跳过。
- 没有 `providerOutput` 的测试继续请求，包括上次失败的测试。
- 输出始终以当前输入测试为准，只复用已有响应，不保留已从输入删除的测试，也不覆盖当前 `vars`、`assert` 或其他配置。
- HTTP 非 2xx、超时和网络错误写入 `metadata.rest_run_error`，不写 `providerOutput`，其他测试继续运行。

命令行运行中只要存在失败测试，脚本仍会完成输出，但进程退出码为 `1`。

## Promptfoo Eval

REST 返回合法 JSON 时，`providerOutput` 保存为 JSON 值；否则保存为文本。要让现有配置对结果文件直接执行 eval，将其 `tests` 指向：

```yaml
tests: file://run_result/loona_promptfoo_tests.json
```

promptfoo 检测到测试项中的 `providerOutput` 后，不再调用 provider，而是直接执行该测试项的断言。

仅在运行汇总中的 `failed` 为 `0` 时对结果文件执行 eval。部分失败的结果中，失败测试没有 `providerOutput`；如果忽略命令行退出码继续 eval，promptfoo 可能对这些测试重新调用配置中的 provider。
