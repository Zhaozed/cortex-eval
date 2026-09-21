import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  DiagnosticReportSchema,
  type DiagnosticReport,
  type DiagnosticReportListItem
} from "@cortex-eval/contracts/src/diagnostic-report-contracts.ts";

export const diagnosticActive = (value: { status: string }): boolean =>
  value.status === "QUEUED" || value.status === "RUNNING";

/** Dedicated sidecar; never writes original Run/Report/Case records. Atomic per-version files. */
export class DiagnosticReportStore {
  constructor(readonly root: string) {}
  private directory(runId: string): string {
    return join(this.root, z.uuid().parse(runId));
  }
  async save(value: DiagnosticReport): Promise<void> {
    const report = DiagnosticReportSchema.parse(value);
    const dir = this.directory(report.runId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, `${report.id}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(report), { flag: "wx", mode: 0o600 });
    await rename(temporary, join(dir, `${report.id}.json`));
  }
  async get(runId: string, id: string): Promise<DiagnosticReport> {
    try {
      const report = DiagnosticReportSchema.parse(
        JSON.parse(
          await readFile(join(this.directory(runId), `${z.uuid().parse(id)}.json`), "utf8")
        )
      );
      if (report.runId !== runId || report.id !== id) throw new Error("DIAG_NOT_FOUND");
      return report;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("DIAG_NOT_FOUND", { cause: error });
      throw error;
    }
  }
  async list(runId: string): Promise<DiagnosticReportListItem[]> {
    let entries: string[];
    try {
      entries = await readdir(this.directory(runId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const results: DiagnosticReportListItem[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json") || !z.uuid().safeParse(name.slice(0, -5)).success) continue;
      const { snapshot, ...summary } = await this.get(runId, name.slice(0, -5));
      void snapshot;
      results.push(summary);
    }
    return results.sort((a, b) => b.version - a.version);
  }
  /** A stopped process cannot leave immortal jobs; original partial facts are retained. */
  async recover(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const runId of await readdir(this.root)) {
      if (!z.uuid().safeParse(runId).success) continue;
      for (const value of await this.list(runId)) {
        if (!diagnosticActive(value)) continue;
        const report = await this.get(runId, value.id);
        report.status = "FAILED";
        report.phase = "DONE";
        report.completedAt = new Date().toISOString();
        report.error = "服务中断，归因未完成。已保留结果，请生成新版本。";
        await this.save(report);
      }
    }
  }
}
