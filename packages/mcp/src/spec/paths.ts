// Locate the shared schema files: the repo's schema/ (fresh) or the copy bundled into dist/schema at build.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/** Directory holding catalog.json and playtest.schema.json. */
export function schemaDir(): string {
  if (cached) return cached;
  const override = process.env.STAGEHAND_SCHEMA_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    override,
    // src/spec or dist/spec -> packages/mcp -> repo root /schema
    path.resolve(here, "../../../../schema"),
    // bundled copy: dist/schema (here = dist/spec)
    path.resolve(here, "../schema"),
    path.resolve(here, "../../dist/schema"),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (existsSync(path.join(c, "catalog.json")) && existsSync(path.join(c, "playtest.schema.json"))) {
      cached = c;
      return c;
    }
  }
  throw new Error(`stagehand-mcp: cannot find schema/catalog.json (looked in ${candidates.join(", ")})`);
}

export function readSchemaJson<T>(file: "catalog.json" | "playtest.schema.json"): T {
  return JSON.parse(readFileSync(path.join(schemaDir(), file), "utf8")) as T;
}
