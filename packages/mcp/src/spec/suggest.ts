// "Did you mean" helpers shared by catalog-name and param-name validation.

/** Known mistaken spellings of params (what authors type → what the catalog calls it). */
const PARAM_ALIASES: Record<string, string> = {
  key: "code",
  keycode: "code",
  keyCode: "code",
  button: "target",
  text: "value",
  pos: "position",
  attribute: "name",
  attr: "name",
  player: "as",
};

/** Levenshtein distance between two strings. */
export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** The closest of `names` to `name` when it is close enough to be a typo, else null. */
export function closest(name: string, names: string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const n of names) {
    const d = levenshtein(name.toLowerCase(), n.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best && bestD <= Math.max(2, Math.floor(name.length / 4)) ? best : null;
}

/** Suffix for an unknown catalog name: a typo fix, the namespace's entries, or a pointer to list_actions. */
export function suggest(name: string, names: string[]): string {
  const best = closest(name, names);
  if (best) return ` — did you mean "${best}"?`;
  const ns = name.split(".")[0];
  const same = names.filter((n) => n.startsWith(`${ns}.`));
  return same.length ? ` (${ns}.* has: ${same.join(", ")})` : " (see list_actions)";
}

/** Suffix for an unknown param: a known alias first (`key` → `code`), then a typo fix, then the allowed list. */
export function suggestParam(key: string, allowed: string[]): string {
  const alias = PARAM_ALIASES[key];
  if (alias && allowed.includes(alias)) return ` — did you mean "${alias}"?`;
  const best = closest(key, allowed);
  if (best) return ` — did you mean "${best}"?`;
  return allowed.length ? ` (allowed: ${allowed.join(", ")})` : " (it takes no params)";
}
