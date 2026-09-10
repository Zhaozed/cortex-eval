// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { RETURN_PATH_KEY, returnFromRun } from "../src/lib/return-navigation.ts";

afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

it.each(["/", "/runs", "/runs?cursor=next"])("returns to the actual app entry from %s", (from) => {
  window.history.replaceState(
    { [RETURN_PATH_KEY]: from, cortexEvalHistoryPosition: 1 },
    "",
    "/runs/run-1"
  );
  const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
  const navigate = vi.fn();
  returnFromRun(navigate);
  expect(back).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
});

it.each([
  null,
  {},
  { [RETURN_PATH_KEY]: "//other.example", cortexEvalHistoryPosition: 1 },
  { [RETURN_PATH_KEY]: "/", cortexEvalHistoryPosition: 0 }
])("falls back safely for direct or unowned entries", (state) => {
  window.history.replaceState(state, "", "/runs/run-1");
  const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
  const navigate = vi.fn();
  returnFromRun(navigate);
  expect(navigate).toHaveBeenCalledWith("/runs");
  expect(back).not.toHaveBeenCalled();
});
