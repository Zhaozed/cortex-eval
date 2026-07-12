import { runRuntimeDoctor, runRuntimeDoctorWithSmoke } from "./runtime-doctor.ts";

if (process.argv.includes("--check-node-only")) {
  runRuntimeDoctor();
} else {
  const report = await runRuntimeDoctorWithSmoke(process.cwd());
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
