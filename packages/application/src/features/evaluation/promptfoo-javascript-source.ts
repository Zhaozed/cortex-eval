import { parse, type Node } from "acorn";

/** Find a return belonging to the script body, not a nested callback or quoted string. */
function hasBodyReturn(node: Node): boolean {
  if (node.type === "ReturnStatement") return true;
  if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type))
    return false;
  return Object.values(node).some((value: unknown) => {
    if (Array.isArray(value)) return value.some(isReturningNode);
    return isReturningNode(value);
  });
}

/** Walk parsed syntax only; never compile or execute user code in the platform process. */
function isReturningNode(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string" &&
    hasBodyReturn(value as Node)
  );
}

/** Mark complete single-line function bodies as multiline, preserving Promptfoo expressions. */
export function materializeJavascriptSource(type: string, value: string): string {
  if (!["javascript", "not-javascript"].includes(type) || value.trimEnd().includes("\n"))
    return value;
  try {
    const program = parse(value, { ecmaVersion: "latest", allowReturnOutsideFunction: true });
    return hasBodyReturn(program) ? `\n${value}` : value;
  } catch {
    // Invalid code still produces an explicit interpreter error; never silently pass it.
    return value;
  }
}
