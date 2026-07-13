import { Readable } from "node:stream";

import type { CaseExportBodyPreparer } from "../../src/case-export-staging.ts";

/** Test-only export preparer that consumes the complete generator before exposing a body. */
export class InMemoryCaseExportBodyPreparer implements CaseExportBodyPreparer {
  /** Materialize test chunks so generator errors occur before the simulated response opens. */
  public async prepare(chunks: AsyncIterable<string>): Promise<Readable> {
    const values: string[] = [];
    for await (const chunk of chunks) values.push(chunk);
    return Readable.from(values, { objectMode: false });
  }
}
