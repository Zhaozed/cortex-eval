// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { expect, it } from "vitest";
import { CaseRequestFields } from "../src/features/test-suites/case-request-fields.tsx";

function Form(): ReactElement {
  const [text, setText] = useState(
    JSON.stringify({ text: "test", uid: { __cortex_eval_int64: "2075490654049271808" } })
  );
  return (
    <>
      <CaseRequestFields text={text} onChange={setText} error={false} rawRef={null} />
      <output data-testid="body">{text}</output>
    </>
  );
}
it("requires explicit client selection and preserves account precision when switching modes", () => {
  render(<Form />);
  fireEvent.click(screen.getByText("Cortex E2E 会话模式（仅适用于 /eval/e2e）"));
  const select = screen.getByLabelText("执行模式");
  expect(select).toHaveValue("");
  fireEvent.change(select, { target: { value: "client" } });
  expect(JSON.parse(screen.getByTestId("body").textContent ?? "{}")).toEqual({
    text: "test",
    uid: { __cortex_eval_int64: "2075490654049271808" },
    execution_mode: "client"
  });
  fireEvent.change(select, { target: { value: "" } });
  expect(JSON.parse(screen.getByTestId("body").textContent ?? "{}")).not.toHaveProperty(
    "execution_mode"
  );
});
