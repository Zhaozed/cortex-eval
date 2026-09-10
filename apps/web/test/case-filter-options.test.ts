import { describe, expect, it, vi } from "vitest";

import { loadCaseFilterOptions } from "../src/features/test-suites/case-filter-options.ts";
import { createResourceApi } from "../src/lib/resource-api.ts";
import { response, suiteId, summary } from "./test-suite-detail-page-test-fixture.ts";
import { requestUrl } from "./request-fixture.ts";

describe("整个测试集的筛选枚举", () => {
  it("读完整分页、去重、保留带逗号的单个标签，不携带当前筛选", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ items: [summary], nextCursor: "next" }))
      .mockResolvedValueOnce(
        response({
          items: [
            {
              ...summary,
              businessModule: "待办",
              scenarioTag: "边界,跨日",
              assertionTypes: ["javascript", "equals"],
              metrics: ["执行"]
            }
          ],
          nextCursor: null
        })
      );
    const result = await loadCaseFilterOptions(
      createResourceApi(fetcher),
      suiteId,
      new AbortController().signal
    );
    expect(result.businessModules).toEqual(["客服", "待办"]);
    expect(result.scenarioTags).toContain("边界,跨日");
    expect(result.assertionTypes).toEqual(["equals", "javascript"]);
    expect(result.metrics).toEqual(["quality", "执行"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const second = fetcher.mock.calls[1];
    if (!second) throw new Error("SECOND_PAGE_REQUIRED");
    const url = requestUrl(second[0]);
    expect(url).toContain("cursor=next");
    expect(url).not.toContain("businessModule");
  });
  it("重复游标报错而非无限请求或返回不完整枚举", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(response({ items: [summary], nextCursor: "same" }))
      );
    await expect(
      loadCaseFilterOptions(createResourceApi(fetcher), suiteId, new AbortController().signal)
    ).rejects.toThrow("CASE_FILTER_CURSOR_REPEATED");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("取消和分页失败不返回部分成功", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      loadCaseFilterOptions(createResourceApi(fetcher), suiteId, controller.signal)
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher
      .mockResolvedValueOnce(response({ items: [summary], nextCursor: "next" }))
      .mockRejectedValueOnce(new Error("offline"));
    await expect(
      loadCaseFilterOptions(createResourceApi(fetcher), suiteId, new AbortController().signal)
    ).rejects.toThrow();
  });
});
