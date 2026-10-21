// Editorial regression checks; these do not certify ASD-STE100 compliance.
import { readFile, readdir } from 'node:fs/promises';
import { createMarkdownRenderer } from 'vitepress';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectProse, proseFromInline } from './docs-language-rules.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const md = await createMarkdownRenderer(root);
const excluded = new Set(['architecture.md', 'implementation-brief.md']);
const files = (await readdir(path.join(root, 'docs'))).filter(f => f.endsWith('.md') && !excluded.has(f));
files.push(...(await readdir(path.join(root, 'docs/reference'))).filter(f => f.endsWith('.md')).map(f => `reference/${f}`));
let total = 0;
let short = 0;
let failed = false;
let findings = 0;
for (const file of files) {
  let text = await readFile(path.join(root, 'docs', file), 'utf8');
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const units = [];
  if (frontmatter) {
    // Include visible homepage copy, but not routes or asset names.
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = line.match(/^\s*(?:- )?(?:title|text|tagline|details|linkText|alt):\s*(.+)$/);
      if (match) units.push(match[1]);
    }
    text = text.slice(frontmatter[0].length);
  }
  const tokens = md.parse(text, {});
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'inline' || tokens[i - 1]?.type === 'heading_open') continue;
    // Count a literal identifier or code expression as one technical unit.
    const plain = proseFromInline(tokens[i]);
    units.push(plain);
  }
  for (const unit of units) {
    for (const finding of inspectProse(unit)) {
      console.error(`${file}: ${finding.rule}: "${finding.match}". ${finding.advice}\n  ${unit}`);
      findings++;
      failed = true;
    }
  }
  const sentences = units.flatMap(t => t.split(/(?<=[.!?])\s+(?=[A-Z0-9`])/)).filter(t => /[a-z]/i.test(t));
  const long = sentences.filter(s => s.trim().split(/\s+/).length > 20);
  const count = sentences.length;
  const passed = count - long.length;
  const rate = count ? passed / count : 1;
  total += count; short += passed;
  console.log(`${file}: ${passed}/${count} units at most 20 words (${(rate * 100).toFixed(1)}%)`);
  if (process.argv.includes('--details')) for (const s of long) console.log(`  ${s.trim().split(/\s+/).length}: ${s}`);
  if (rate < .75) failed = true;
}
console.log(`Total: ${short}/${total} units at most 20 words (${(short / total * 100).toFixed(1)}%).`);
console.log('Scope: visible Markdown prose, table cells, and homepage copy. Excludes headings, code blocks, and raw schemas.');
console.log(`Vocabulary and grammar regression findings: ${findings}.`);
console.log('These selected checks do not measure full ASD-STE100 compliance. See .github/STE-REVIEW.md for the manual review and scope.');
if (failed) process.exitCode = 1;
