// Daemon-side evaluation of log.* conditions (scope "all") over captured log events.
import type { LogRecord } from "./types.js";

const CLASSES: Record<string, string> = {
  a: "A-Za-z",
  d: "0-9",
  l: "a-z",
  s: "\\s",
  u: "A-Z",
  w: "A-Za-z0-9",
  x: "A-Fa-f0-9",
  p: "!-\\/:-@\\[-`{-~",
  c: "\\x00-\\x1f",
};

function escapeRe(c: string): string {
  return /[\\^$.*+?()[\]{}|/-]/.test(c) ? `\\${c}` : c;
}

/** Convert a Lua pattern to an equivalent JS RegExp (classes, sets, anchors, quantifiers incl. lazy `-`). */
export function luaPatternToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  let atomEnd = false;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "%" && i + 1 < pattern.length) {
      const k = pattern[i + 1]!;
      const cls = CLASSES[k.toLowerCase()];
      if (cls) out += k === k.toLowerCase() ? `[${cls}]` : `[^${cls}]`;
      else out += escapeRe(k);
      i += 2;
      atomEnd = true;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      let set = "[";
      if (pattern[j] === "^") {
        set += "^";
        j++;
      }
      let first = true;
      while (j < pattern.length && (pattern[j] !== "]" || first)) {
        const d = pattern[j]!;
        first = false;
        if (d === "%" && j + 1 < pattern.length) {
          const k = pattern[j + 1]!;
          const cls = CLASSES[k.toLowerCase()];
          set += cls && k === k.toLowerCase() ? cls : escapeRe(k);
          j += 2;
          continue;
        }
        set += d === "\\" || d === "[" ? `\\${d}` : d;
        j++;
      }
      out += `${set}]`;
      i = j + 1;
      atomEnd = true;
      continue;
    }
    if (c === "^" && i === 0) out += "^";
    else if (c === "$" && i === pattern.length - 1) out += "$";
    else if (c === "." ) out += "[\\s\\S]";
    else if ((c === "*" || c === "+" || c === "?") && atomEnd) out += c;
    else if (c === "-" && atomEnd) out += "*?";
    else if (c === "(" || c === ")") out += c;
    else out += escapeRe(c);
    atomEnd = !(c === "(" || c === "^" || ((c === "*" || c === "+" || c === "?" || c === "-") && atomEnd));
    i++;
  }
  return new RegExp(out);
}

export interface LogEvalResult {
  ok: boolean;
  expected: unknown;
  actual: unknown;
  reason: string;
}

export function evaluateLogCondition(name: string, params: Record<string, unknown>, logs: LogRecord[]): LogEvalResult {
  if (name === "log.noErrors") {
    const errors = logs.filter((l) => l.level === "error");
    return {
      ok: errors.length === 0,
      expected: { errors: 0 },
      actual: { errors: errors.length, messages: errors.slice(0, 5).map((l) => `${l.role}: ${l.message}`) },
      reason: `${errors.length} error(s) logged since the run started`,
    };
  }
  const level = typeof params.level === "string" ? params.level : "any";
  const pattern = String(params.pattern ?? "");
  let re: RegExp;
  try {
    re = luaPatternToRegExp(pattern);
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  const pool = logs.filter((l) => level === "any" || l.level === level);
  const hit = pool.find((l) => re.test(l.message));
  return {
    ok: !!hit,
    expected: { pattern, level },
    actual: hit
      ? { matched: true, message: hit.message }
      : { matched: false, recent: pool.slice(-5).map((l) => `[${l.level}] ${l.message}`) },
    reason: `no ${level === "any" ? "" : `${level} `}log line matched "${pattern}"`,
  };
}
