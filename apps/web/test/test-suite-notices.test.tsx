// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  CaseImportErrorNotice,
  SuiteConflictNotice
} from "../src/features/test-suites/test-suite-notices.tsx";
import { CaseDeleteDialog } from "../src/features/test-suites/case-delete-dialog.tsx";
import { CaseImportDialog } from "../src/features/test-suites/case-import-dialog.tsx";
import { ApiClientError } from "../src/lib/api-client.ts";

describe("测试集错误与冲突提示", () => {
  it("导入错误缺少项身份时只显示稳定回滚事实", () => {
    render(<CaseImportErrorNotice error={new ApiClientError("CASE_IMPORT_CANCELLED")} />);

    expect(screen.getByText("导入失败，原有 Cases 未被修改。")).toBeInTheDocument();
  });

  it("导入项没有字段路径时显示顺序、Case ID 和原因码", () => {
    render(
      <CaseImportErrorNotice
        error={
          new ApiClientError("CASE_IMPORT_ITEM_INVALID", {
            importIndex: 0,
            caseKey: "case-001",
            causeCode: "CASE_ID_DUPLICATE"
          })
        }
      />
    );

    expect(
      screen.getByText("第 1 项（Case ID：case-001）无效（CASE_ID_DUPLICATE）。")
    ).toBeInTheDocument();
  });

  it("Suite 冲突提示把两个显式决策交给页面流程", async () => {
    const onRetry = vi.fn();
    const onAccept = vi.fn();
    render(
      <SuiteConflictNotice
        conflict={{
          draft: { name: "本地", description: "本地说明" },
          serverSnapshot: { name: "远端", description: "远端说明", revision: 2 }
        }}
        onRetry={onRetry}
        onAccept={onAccept}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "使用最新 Revision 重试" }));
    await userEvent.click(screen.getByRole("button", { name: "放弃 Draft，采用服务端版本" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it("Case 导入和删除请求在途时取消按钮与生命周期门禁一致", () => {
    const importView = render(
      <CaseImportDialog
        file={new File(["[]"], "cases.json", { type: "application/json" })}
        pending
        caseCount={1}
        error={null}
        conflict={null}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    importView.unmount();

    render(
      <CaseDeleteDialog
        caseKey="case-1"
        pending
        error={null}
        conflict={null}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  });
});
