import { message, type MessageKey } from "../../messages/messages.ts";

/** Translate the closed review states at the UI boundary. */
export function reviewStatus(value: string): string {
  return message(`a2ui.${value === "error" ? "errorStatus" : value}` as MessageKey);
}
