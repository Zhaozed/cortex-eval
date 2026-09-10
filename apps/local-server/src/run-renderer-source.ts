import { isIP } from "node:net";

/** Source is derived only from the Run's frozen Endpoint, never Case output or current settings. */
export type RunRendererSource =
  | { kind: "directory"; root: string; identity: string }
  | { kind: "http"; baseUrl: string; identity: string };

export function runRendererSource(
  endpoint: string,
  localRoot: string | undefined
): RunRendererSource {
  const url = new URL(endpoint);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    /[{}]/.test(url.host)
  )
    throw new Error("A2UI_ENDPOINT_INVALID");
  const local =
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "[::1]" ||
    (isIP(url.hostname) === 4 && url.hostname.startsWith("127."));
  if (local && localRoot)
    return { kind: "directory", root: localRoot, identity: `${url.origin} → ${localRoot}` };
  // Cortex's deployed Web UI is mounted at /web_ui; standalone local Cortex uses /static.
  const prefix = url.pathname.includes("/web_ui/")
    ? url.pathname.slice(0, url.pathname.indexOf("/web_ui/") + "/web_ui/".length)
    : local
      ? "/"
      : "/web_ui/";
  const baseUrl = new URL(`${prefix}static/`, url.origin).href;
  return { kind: "http", baseUrl, identity: baseUrl };
}
