// Duration and value normalization (docs/spec.md "Values").
const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m)$/;
const VAR_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

export function isDurationString(v: unknown): v is string {
  return typeof v === "string" && DURATION_RE.test(v);
}

/** Parse "250ms" | "10s" | "1.5m" | seconds (number) into integer milliseconds. */
export function parseDuration(v: unknown): number {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) throw new Error(`invalid duration ${v}`);
    return Math.round(v * 1000);
  }
  if (typeof v === "string") {
    const m = DURATION_RE.exec(v);
    if (m) {
      const n = Number(m[1]);
      const unit = m[2];
      return Math.round(unit === "ms" ? n : unit === "s" ? n * 1000 : n * 60_000);
    }
  }
  throw new Error(`invalid duration ${JSON.stringify(v)} (use "250ms", "10s", "1.5m" or seconds)`);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${+(ms / 1000).toFixed(2)}s`;
  return `${+(ms / 60_000).toFixed(2)}m`;
}

/** Returns the var name for a whole-value "$name" reference, else null. */
export function varRefName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = VAR_RE.exec(v);
  return m ? m[1]! : null;
}

/** Collect every "$name" leaf referenced in a JSON value. */
export function collectVarRefs(v: unknown, out: Set<string> = new Set()): Set<string> {
  const n = varRefName(v);
  if (n) out.add(n);
  else if (Array.isArray(v)) for (const x of v) collectVarRefs(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) collectVarRefs(x, out);
  return out;
}

/** Substitute whole-value "$name" leaves with known vars; unknown refs are left as-is. */
export function substituteVars(v: unknown, vars: Record<string, unknown>): unknown {
  const n = varRefName(v);
  if (n) return Object.prototype.hasOwnProperty.call(vars, n) ? vars[n] : v;
  if (Array.isArray(v)) return v.map((x) => substituteVars(x, vars));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = substituteVars(x, vars);
    return o;
  }
  return v;
}

/** Lua-style falsiness used by `if`: nil, false, 0, "" are falsy. */
export function isTruthy(v: unknown): boolean {
  return !(v === undefined || v === null || v === false || v === 0 || v === "");
}
