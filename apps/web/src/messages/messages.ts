import zhCn from "./zh-CN.json" with { type: "json" };

/** Keys available in the current simplified-Chinese UI catalog. */
export type MessageKey = keyof typeof zhCn;

/** Read one compile-time checked UI message. */
export function message(key: MessageKey): string {
  return zhCn[key];
}

/** Replace named placeholders in one checked catalog message. */
export function formatMessage(
  key: MessageKey,
  values: Readonly<Record<string, string | number>>
): string {
  let result = message(key);
  for (const [name, value] of Object.entries(values)) {
    result = result.replaceAll(`{${name}}`, String(value));
  }
  return result;
}
