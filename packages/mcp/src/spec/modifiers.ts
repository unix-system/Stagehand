// Step modifier names (docs/spec.md "Modifiers"). Any other key of a do/wait/expect step is a param of the
// action or condition, so a param that shares a name with a modifier can only be passed under `with:`.

export const COMMON_MODIFIERS = ["as", "on", "timeout", "soft", "label", "if"] as const;

/** Every modifier any verb accepts; a param with one of these names collides. */
export const ALL_MODIFIERS: ReadonlySet<string> = new Set([...COMMON_MODIFIERS, "save", "with", "within"]);

/** Params of a catalog entry whose names are also step modifiers. */
export function collidingParams(params: Record<string, unknown> | undefined): string[] {
  const props = (params?.properties as Record<string, unknown> | undefined) ?? {};
  return Object.keys(props).filter((k) => ALL_MODIFIERS.has(k));
}
