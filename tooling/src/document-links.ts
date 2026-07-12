import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

/** Broken local Markdown link. */
export interface BrokenDocumentLink {
  /** Document containing the link. */
  source: string;
  /** Link target as written. */
  target: string;
}

const ROOT_DOCUMENTS = new Set(["README.md", "REQ.md", "TECH.md", "SPEC_DOC.md"]);
const LOCAL_LINK = /\[[^\]]*]\((?!https?:|mailto:|#)([^)]+)\)/g;

// Collect Markdown documents that form the constrained fact source.
async function collectDocuments(root: string): Promise<string[]> {
  const documents: string[] = [];
  for (const name of ROOT_DOCUMENTS) {
    const path = resolve(root, name);
    try {
      if ((await stat(path)).isFile()) {
        documents.push(path);
      }
    } catch {
      if (name !== "README.md") {
        documents.push(path);
      }
    }
  }
  for (const directoryName of ["spec", "tasks"]) {
    const directory = resolve(root, directoryName);
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        documents.push(resolve(entry.parentPath, entry.name));
      }
    }
  }
  return documents;
}

// Return all missing local links without hiding missing root facts.
export async function collectBrokenDocumentLinks(root: string): Promise<BrokenDocumentLink[]> {
  const documents = await collectDocuments(root);
  const broken: BrokenDocumentLink[] = [];
  for (const document of documents) {
    let content: string;
    try {
      content = await readFile(document, "utf8");
    } catch {
      broken.push({ source: relative(root, document), target: relative(root, document) });
      continue;
    }
    for (const match of content.matchAll(LOCAL_LINK)) {
      const target = match[1]?.split("#", 1)[0]?.trim();
      if (!target) {
        continue;
      }
      try {
        await stat(resolve(dirname(document), target));
      } catch {
        broken.push({ source: relative(root, document), target });
      }
    }
  }
  return broken.sort((left, right) =>
    `${left.source}:${left.target}`.localeCompare(`${right.source}:${right.target}`)
  );
}
