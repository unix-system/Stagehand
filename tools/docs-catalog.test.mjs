import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderCatalog } from './docs-catalog.mjs';

const catalog = JSON.parse(await readFile(new URL('../schema/catalog.json', import.meta.url), 'utf8'));
test('every catalog entry has one stable anchor and ordering is independent of input', () => {
  const pages = renderCatalog(catalog);
  assert.deepEqual(pages, renderCatalog({ ...catalog, entries: [...catalog.entries].reverse() }));
  for (const e of catalog.entries) {
    const text = pages.get(`${e.name.split('.')[0]}.md`);
    assert.equal(text.split(`{#${e.name.toLowerCase().replace('.', '-')}}`).length - 1, 1);
    assert.ok(text.includes(JSON.stringify(e.params, null, 2)));
  }
});
test('parameters, complete schemas, returns and untrusted Markdown are preserved safely', () => {
  const entry = { name: 'example.test', kind: 'action', contexts: ['server'], default: 'server',
    actor: 'required', summary: '<script> {{bad}} | *text*', notes: 'a\nb',
    params: { type: 'object', properties: { required: { type: 'string', enum: ['a|b', '```'] }, optional: { anyOf: [{ type: 'number', minimum: 2 }, { type: 'null' }] } }, required: ['required'] },
    returns: { type: 'object', properties: { result: { type: 'boolean' } } } };
  const text = renderCatalog({ entries: [entry] }).get('example.md');
  assert.ok(text.includes('| required | Yes |'));
  assert.ok(text.includes('| optional | No |'));
  assert.ok(text.includes(JSON.stringify(entry.params, null, 2)));
  assert.ok(text.includes(JSON.stringify(entry.returns, null, 2)));
  assert.ok(text.includes('````json'));
  assert.ok(!text.includes('<script>'));
  assert.ok(!text.includes('{{bad}}'));
  assert.ok(text.includes('a<br>b'));
  assert.throws(() => renderCatalog({ entries: [entry, entry] }), /duplicate/);
});
