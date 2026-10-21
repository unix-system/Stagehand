import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarkdownRenderer } from 'vitepress';
import { inspectProse, proseFromInline } from './docs-language-rules.mjs';

test('vocabulary checks distinguish approved noun uses from reviewed verb/adjective uses', () => {
  assert.deepEqual(inspectProse('The display shows the result. Do a check for errors. Complete the test.'), []);
  for (const text of ['Check the result.', 'The report displays a value.', 'Read the complete schema.', 'This requires a client.']) {
    assert.ok(inspectProse(text).some(f => f.rule.startsWith('vocabulary-')), text);
  }
});
test('grammar checks catch complex tenses, action gerunds, contractions and repeated articles', () => {
  for (const text of ['It has been captured.', 'Studio is running a test.', 'After copying the file, restart Studio.', "It doesn't stop.", 'Use a a hook.']) {
    assert.ok(inspectProse(text).some(f => f.rule.startsWith('grammar-')), text);
  }
  assert.deepEqual(inspectProse('The remaining steps use the missing parameter. The plugin is installed.'), []);
});
test('Markdown extraction checks link labels but protects code, URLs, schemas and anchors', async () => {
  const md = await createMarkdownRenderer(process.cwd());
  const tokens = md.parse('Use `require(module)` and [the display](https://example.com/requires).\n\n```json\n{"description":"This requires a value."}\n```\n\n[Check the result](./result.md).', {});
  const prose = tokens.filter(t => t.type === 'inline').map(proseFromInline);
  assert.deepEqual(inspectProse(prose[0]), []);
  assert.equal(prose.flatMap(inspectProse).length, 1);
});
