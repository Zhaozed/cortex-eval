// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { CaseImportDialog } from "../src/features/test-suites/case-import-dialog.tsx";
import { createResourceApi, type CaseImportPreview } from "../src/lib/resource-api.ts";
import { ApiClientError } from "../src/lib/api-client.ts";
import { suite, suiteId } from "./test-suite-detail-page-test-fixture.ts";

const preview = (revision = 5): CaseImportPreview => ({
  count: 1,
  suite: { ...suite, revision },
  preview: { added: 0, removed: 0, modified: 0, unchanged: 1, reordered: 0 }
});
it("预检完成才可确认，文件和 Revision 改变后旧预检不得提交", async () => {
  const checks: { resolve: (value: CaseImportPreview) => void; signal: AbortSignal }[] = [];
  const previewCases = vi.fn(
    (_suite: string, _revision: number, _file: File, signal: AbortSignal) =>
      new Promise<CaseImportPreview>((resolve) => checks.push({ resolve, signal }))
  );
  const api = { ...createResourceApi(), previewCases };
  const props = {
    api,
    suiteId,
    revision: 5,
    file: new File(["[]"], "one.json"),
    onRefreshSuite: vi.fn(),
    caseCount: 1,
    error: null,
    conflict: null,
    pending: false,
    onOpenChange: vi.fn(),
    onConfirm: vi.fn()
  };
  const view = render(<CaseImportDialog {...props} />);
  const confirm = () => screen.getByRole("button", { name: "确认导入并替换" });
  expect(confirm()).toBeDisabled();
  checks[0]!.resolve(preview());
  await waitFor(() => expect(confirm()).toBeEnabled());
  const file = new File(["[]"], "two.json");
  view.rerender(<CaseImportDialog {...props} file={file} />);
  expect(checks[0]!.signal.aborted).toBe(true);
  expect(confirm()).toBeDisabled();
  view.rerender(<CaseImportDialog {...props} file={file} revision={6} />);
  checks[1]!.resolve(preview());
  expect(confirm()).toBeDisabled();
  checks[2]!.resolve(preview(6));
  await waitFor(() => expect(confirm()).toBeEnabled());
  await userEvent.click(confirm());
  expect(props.onConfirm).toHaveBeenCalledWith(file, 6);
});
it("配置错误显示中文原因且禁止确认", async () => {
  const api = {
    ...createResourceApi(),
    previewCases: vi
      .fn()
      .mockRejectedValue(
        new ApiClientError("CASE_IMPORT_ITEM_INVALID", {
          issueCode: "UNKNOWN_TYPE",
          importIndex: 0,
          caseKey: "bad",
          fieldPath: "assert.0.type"
        })
      )
  };
  render(
    <CaseImportDialog
      api={api}
      suiteId={suiteId}
      revision={5}
      file={new File(["[]"], "bad.json")}
      onRefreshSuite={vi.fn()}
      caseCount={1}
      error={null}
      conflict={null}
      pending={false}
      onOpenChange={vi.fn()}
      onConfirm={vi.fn()}
    />
  );
  expect(await screen.findByText(/未识别的断言类型/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认导入并替换" })).toBeDisabled();
});
