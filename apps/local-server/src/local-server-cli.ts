import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

import { createLocalServerRuntime } from "./local-server-runtime.ts";

const projectRoot = resolve(process.cwd());
// Persist local-only resource paths across restarts; explicit shell variables take precedence.
try {
  loadEnvFile(resolve(projectRoot, ".cortex-eval", "server.env"));
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
const lifecyclePath = resolve(projectRoot, ".cortex-eval", "logs", "local-server.lifecycle.log");

// Plain crash/signal lifecycle trace that survives silent kills; never throws.
function lifecycle(line: string): void {
  const text = `[${new Date().toISOString()}] pid=${process.pid} ${line}\n`;
  try {
    appendFileSync(lifecyclePath, text, "utf8");
  } catch {
    // Fall back to stderr only when the lifecycle file is unavailable.
  }
  process.stderr.write(text);
}

const runtime = await createLocalServerRuntime({
  projectRoot,
  staticRoot: resolve(projectRoot, "apps", "web", "dist")
});

// Close in protocol order when the local operator stops the foreground server.
async function shutdown(reason: string): Promise<void> {
  lifecycle(`shutting down reason=${reason}`);
  await runtime.close();
  lifecycle(`shut down complete reason=${reason}`);
  process.exit(0);
}

// Every death must leave a trace: bare rejections and exceptions crash Node with
// zero business-log output, which is exactly the "mysterious" death pattern seen
// in production. Record the failure before exiting so the next incident is solvable.
process.on("unhandledRejection", (reason: unknown) => {
  lifecycle(`FATAL unhandledRejection reason=${String(reason)}`);
  process.exit(1);
});
process.on("uncaughtException", (error: Error) => {
  lifecycle(`FATAL uncaughtException stack=${String(error.stack ?? error)}`);
  process.exit(1);
});
// A closed terminal/session sends SIGHUP; the default action dies without a trace.
process.on("SIGHUP", () => void shutdown("SIGHUP"));
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await runtime.listen();
lifecycle(`listening http://127.0.0.1:4310`);

// One RSS/heap heartbeat per minute documents memory growth leading to silent kills.
const heartbeat = setInterval(() => {
  const memory = process.memoryUsage();
  lifecycle(
    `heartbeat rssMiB=${(memory.rss / 1048576).toFixed(0)} heapUsedMiB=${(memory.heapUsed / 1048576).toFixed(0)}`
  );
}, 60_000);
heartbeat.unref();
