// YAML/JSON loading with line numbers for diagnostics.
import { readFile } from "node:fs/promises";
import YAML, { LineCounter, isNode } from "yaml";
import type { Diagnostic } from "./types.js";
import type { PathPart } from "./schema.js";

export interface LoadedDocument {
  value: unknown;
  errors: Diagnostic[];
  /** Map a path into the document to a 1-based line number (YAML/JSON text inputs only). */
  lineOf: (parts: PathPart[]) => number | undefined;
  text: string | null;
}

/** Parse YAML (canonical) or JSON text. JSON is valid YAML 1.2, so one parser handles both. */
export function parseText(text: string): LoadedDocument {
  const lineCounter = new LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter, prettyErrors: true, uniqueKeys: true });
  const errors: Diagnostic[] = doc.errors.map((e) => ({
    severity: "error" as const,
    path: "(document)",
    message: `YAML: ${e.message.split("\n")[0]}`,
    line: e.linePos?.[0]?.line,
  }));
  const value = errors.length ? undefined : doc.toJS({ maxAliasCount: 100 });
  return {
    value,
    errors,
    text,
    lineOf: (parts) => {
      try {
        const node = doc.getIn(parts, true);
        if (isNode(node) && node.range) return lineCounter.linePos(node.range[0]).line;
      } catch {
        /* ignore */
      }
      return undefined;
    },
  };
}

/** Accept a YAML/JSON string or an already-parsed object. */
export function loadInput(input: unknown): LoadedDocument {
  if (typeof input === "string") return parseText(input);
  return { value: input, errors: [], text: null, lineOf: () => undefined };
}

export async function loadFile(file: string): Promise<LoadedDocument> {
  return parseText(await readFile(file, "utf8"));
}

export function stringifySpec(value: unknown): string {
  return YAML.stringify(value, { lineWidth: 0, flowCollectionPadding: true });
}
