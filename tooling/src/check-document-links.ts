import { collectBrokenDocumentLinks } from "./document-links.ts";

const broken = await collectBrokenDocumentLinks(process.cwd());
if (broken.length > 0) {
  process.stderr.write(`${JSON.stringify(broken)}\n`);
  process.exitCode = 1;
}
