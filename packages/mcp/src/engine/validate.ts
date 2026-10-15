// Full validation pipeline: parse -> JSON Schema -> catalog/semantic compile.
import type { Catalog } from "../spec/catalog.js";
import { loadInput } from "../spec/loader.js";
import { type PathPart, validateSchema } from "../spec/schema.js";
import type { Diagnostic, PlaytestSpec } from "../spec/types.js";
import { compile, type CompileOptions } from "./compile.js";
import type { Plan } from "./plan.js";

export interface ValidationResult {
  ok: boolean;
  spec: PlaytestSpec | null;
  plan: Plan | null;
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

export function validateInput(
  input: unknown,
  catalog: Catalog,
  opts: CompileOptions & { expectName?: string } = {},
): ValidationResult {
  const doc = loadInput(input);
  if (doc.errors.length) return { ok: false, spec: null, plan: null, errors: doc.errors, warnings: [] };
  const finish = (d: Diagnostic & { parts?: PathPart[] }): Diagnostic => {
    const out: Diagnostic = { severity: d.severity, path: d.path, message: d.message };
    const line = d.line ?? (d.parts ? doc.lineOf(d.parts) : undefined);
    if (line !== undefined) out.line = line;
    return out;
  };
  const schemaErrors = validateSchema(doc.value);
  if (schemaErrors.length) {
    return { ok: false, spec: null, plan: null, errors: schemaErrors.map(finish), warnings: [] };
  }
  const spec = doc.value as PlaytestSpec;
  const res = compile(spec, catalog, opts);
  const errors = res.errors.map(finish);
  if (opts.expectName && spec.name !== opts.expectName) {
    errors.unshift({ severity: "error", path: "name", message: `name "${spec.name}" must match the file name "${opts.expectName}"` });
  }
  return {
    ok: errors.length === 0,
    spec,
    plan: errors.length ? null : res.plan,
    errors,
    warnings: res.warnings.map(finish),
  };
}
