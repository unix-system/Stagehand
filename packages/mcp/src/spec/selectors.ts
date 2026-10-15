// Selector grammar (docs/spec.md EBNF). The daemon only checks syntax; nodes resolve.

export interface Predicate {
  attribute: boolean;
  key: string;
  value: string | number | boolean;
}

export interface Segment {
  /** Literal child name, or null for a wildcard. */
  name: string | null;
  wildcard: "*" | "**" | null;
  filter: Predicate[];
}

export type Selector =
  | { kind: "var"; name: string; all: boolean }
  | { kind: "tag"; tag: string; all: boolean }
  | {
      kind: "actor";
      actor: string;
      root: "player" | "character" | "gui" | "backpack" | null;
      segments: Segment[];
      all: boolean;
    }
  | { kind: "path"; segments: Segment[]; all: boolean };

export class SelectorError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.name = "SelectorError";
    this.position = position;
  }
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;
const ACTOR_ROOTS = new Set(["player", "character", "gui", "backpack"]);

class Cursor {
  i = 0;
  constructor(readonly s: string) {}
  get done(): boolean {
    return this.i >= this.s.length;
  }
  peek(n = 0): string {
    return this.s.charAt(this.i + n);
  }
  startsWith(t: string): boolean {
    return this.s.startsWith(t, this.i);
  }
  fail(msg: string): never {
    throw new SelectorError(`${msg} at position ${this.i} in selector "${this.s}"`, this.i);
  }
  expect(ch: string): void {
    if (this.peek() !== ch) this.fail(`expected "${ch}"`);
    this.i++;
  }
  ident(what = "identifier"): string {
    const start = this.i;
    if (!IDENT_START.test(this.peek())) this.fail(`expected ${what}`);
    this.i++;
    while (!this.done && IDENT_CHAR.test(this.peek())) this.i++;
    return this.s.slice(start, this.i);
  }
}

/** Parse a selector string. Throws SelectorError with a position on bad syntax. */
export function parseSelector(input: string): Selector {
  if (typeof input !== "string" || input.length === 0) throw new SelectorError("empty selector", 0);
  let text = input;
  let all = false;
  if (text.endsWith("[]")) {
    all = true;
    text = text.slice(0, -2);
    if (!text) throw new SelectorError(`selector "${input}" has nothing before "[]"`, 0);
  }
  const c = new Cursor(text);
  let sel: Selector;
  if (c.startsWith("$")) {
    c.i++;
    const name = c.ident("variable name after $");
    sel = { kind: "var", name, all };
  } else if (c.startsWith("tag:")) {
    c.i += 4;
    const start = c.i;
    while (!c.done && c.peek() !== "[") c.i++;
    const tag = text.slice(start, c.i);
    if (!tag) c.fail("expected tag name after tag:");
    sel = { kind: "tag", tag, all };
  } else if (c.startsWith("@")) {
    c.i++;
    const actor = c.ident("actor name after @");
    type Root = "player" | "character" | "gui" | "backpack";
    let root: Root | null = null;
    const segments: Segment[] = [];
    if (!c.done) {
      c.expect(".");
      const rs = c.i;
      const r = c.ident("actor root (player | character | gui | backpack)");
      if (!ACTOR_ROOTS.has(r)) {
        c.i = rs;
        c.fail(`unknown actor root "${r}" (expected player | character | gui | backpack)`);
      }
      root = r as Root;
      while (!c.done) {
        c.expect(".");
        segments.push(segment(c));
      }
    }
    sel = { kind: "actor", actor, root, segments, all };
  } else {
    if (c.startsWith("game.")) c.i += 5;
    const segments: Segment[] = [segment(c)];
    while (!c.done) {
      c.expect(".");
      segments.push(segment(c));
    }
    sel = { kind: "path", segments, all };
  }
  if (!c.done) c.fail("unexpected character");
  return sel;
}

function segment(c: Cursor): Segment {
  let name: string | null = null;
  let wildcard: "*" | "**" | null = null;
  if (c.startsWith("**")) {
    wildcard = "**";
    c.i += 2;
  } else if (c.startsWith("*")) {
    wildcard = "*";
    c.i += 1;
  } else if (c.peek() === "'") {
    c.i++;
    const start = c.i;
    while (!c.done && c.peek() !== "'") c.i++;
    if (c.done) c.fail("unterminated quoted name");
    name = c.s.slice(start, c.i);
    c.i++;
  } else {
    name = c.ident("name (quote names with spaces, dots or symbols: 'My Part')");
  }
  const filter: Predicate[] = [];
  if (c.peek() === "[") {
    c.i++;
    do {
      if (c.peek() === ",") c.i++;
      let attribute = false;
      if (c.peek() === "@") {
        attribute = true;
        c.i++;
      }
      const key = c.ident("property or @attribute name in filter");
      c.expect("=");
      const start = c.i;
      while (!c.done && c.peek() !== "," && c.peek() !== "]") c.i++;
      if (c.done) c.fail('unterminated filter, expected "]"');
      filter.push({ attribute, key, value: literal(c.s.slice(start, c.i)) });
    } while (c.peek() === ",");
    c.expect("]");
  }
  return { name, wildcard, filter };
}

function literal(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/** True when the string parses as a selector. */
export function isValidSelector(s: string): boolean {
  try {
    parseSelector(s);
    return true;
  } catch {
    return false;
  }
}

/** Render a parsed selector back to canonical text. */
export function formatSelector(sel: Selector): string {
  const seg = (s: Segment) => {
    const base =
      s.wildcard ?? (s.name !== null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s.name) ? s.name : `'${s.name ?? ""}'`);
    const f = s.filter.length
      ? `[${s.filter.map((p) => `${p.attribute ? "@" : ""}${p.key}=${String(p.value)}`).join(",")}]`
      : "";
    return base + f;
  };
  const suffix = sel.all ? "[]" : "";
  switch (sel.kind) {
    case "var":
      return `$${sel.name}${suffix}`;
    case "tag":
      return `tag:${sel.tag}${suffix}`;
    case "actor":
      return `@${sel.actor}${sel.root ? `.${sel.root}` : ""}${sel.segments.map((s) => `.${seg(s)}`).join("")}${suffix}`;
    case "path":
      return sel.segments.map(seg).join(".") + suffix;
  }
}
