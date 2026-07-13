/** Resolve one Fetch input without relying on Object's default stringification. */
export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Read only the string request bodies emitted by the JSON API client. */
export function requestBody(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "";
}
