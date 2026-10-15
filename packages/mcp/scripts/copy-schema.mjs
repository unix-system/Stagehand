// Bundle the shared schema files into dist/schema so the published package works outside the repo.
import { copyFileSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.resolve(pkg, "../../schema");
const dst = path.join(pkg, "dist/schema");
mkdirSync(dst, { recursive: true });
for (const f of ["catalog.json", "playtest.schema.json"]) copyFileSync(path.join(src, f), path.join(dst, f));
chmodSync(path.join(pkg, "dist/index.js"), 0o755);
console.log(`copied schema -> ${path.relative(pkg, dst)}`);
