// Narrow regression checks from the editorial review, not an STE parser or dictionary.
// Each pattern deliberately targets a use whose part of speech is unambiguous.
export const languageRules = [
  ['vocabulary-check-verb', /(?<!\ba )\bcheck(?:s|ing)?\s+(?:that|whether|the|a|an|for|available|localhost|plugin|both|server-owned)\b/gi,
    'Dictionary: CHECK is a noun. Use make sure, examine, validate, or do a check, according to meaning.'],
  ['vocabulary-display-verb', /\b(?:displays|displaying|displayed|display pressed)\b/gi,
    'Dictionary: DISPLAY is a noun. Use show for the verb.'],
  ['vocabulary-complete-adjective', /\bcomplete\s+(?:format|schema|parameter|playtest|run|expansion|variable|document)\b/gi,
    'Dictionary: COMPLETE is a verb. Use full for this adjective.'],
  ['vocabulary-alternatives', /\b(?:concurrently|therefore|alternatively|requires?|requiring)\b/gi,
    'Dictionary: use at the same time, thus, as an alternative, or need/necessary, according to meaning.'],
  ['vocabulary-within', /\bwithin\s+(?:the|a|an|\d)/gi,
    'Dictionary: use in for location; use before the time limit or in ... or less for duration.'],
  ['grammar-perfect-progressive', /\b(?:(?:has|have|had) (?:been|restarted)|(?:is|are|was|were) being|(?:is|are|was|were) running)\b/gi,
    'Rules 3.2–3.4: use a simple tense or describe the state.'],
  ['grammar-action-ing', /\b(?:before|after|without)\s+(?:using|copying|saving|running|launching|writing|checking)\b/gi,
    'Rule 3.5: write a clause with a subject and a simple verb.'],
  ['grammar-contraction', /\b(?:isn't|aren't|don't|doesn't|can't|won't|it's|you'll|you're)\b/gi,
    'Rule 4.2: write the full words.'],
  ['grammar-repeated-word', /\b(a|an|the|to|of|and)\s+\1\b/gi,
    'Remove the repeated word.'],
];

export function inspectProse(text) {
  return languageRules.flatMap(([rule, pattern, advice]) =>
    [...text.matchAll(new RegExp(pattern))].map(match => ({ rule, match: match[0], advice })));
}

export function proseFromInline(token) {
  return (token.children ?? []).map(t => {
    if (t.type === 'code_inline') return ' TECHNICALTERM ';
    if (t.type === 'text') return t.content;
    if (t.type === 'softbreak' || t.type === 'hardbreak') return ' ';
    return '';
  }).join('');
}
