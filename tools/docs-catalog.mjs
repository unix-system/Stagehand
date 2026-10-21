import { readFile, mkdir, readdir, unlink, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const language = JSON.parse(await readFile(path.join(root, 'docs/.vitepress/catalog-language.json'), 'utf8'));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const escapeText = (value) => String(value).replace(/[&<>"'`|{}\[\]*_\\]/g,
  c => `&#${c.codePointAt(0)};`).replace(/\r?\n/g, '<br>');
const jsonBlock = value => {
  const json = JSON.stringify(value, null, 2);
  const fence = '`'.repeat(Math.max(3, ...Array.from(json.matchAll(/`+/g), m => m[0].length + 1)));
  return `${fence}json\n${json}\n${fence}`;
};

export function renderCatalog(catalog) {
  const groups = new Map();
  const names = new Set();
  for (const entry of [...catalog.entries].sort((a, b) => compare(a.name, b.name))) {
    if (!/^[a-zA-Z_][\w]*\.[a-zA-Z_][\w]*$/.test(entry.name) || names.has(entry.name)) {
      throw new Error(`Invalid or duplicate catalog name: ${entry.name}`);
    }
    names.add(entry.name);
    const namespace = entry.name.split('.')[0];
    if (!groups.has(namespace)) groups.set(namespace, []);
    groups.get(namespace).push(entry);
  }
  const pages = new Map();
  let index = '# Actions and conditions\n\nThe built-in catalog supplies this reference. Use actions with `do`. Use conditions with `wait` or `expect`. Use `list_actions` to find live `game.*` hooks. See the [game-hooks guide](../game-hooks.md).\n\n';
  for (const [namespace, entries] of groups) {
    index += `- [${namespace}](${namespace}.md) — ${entries.length} entries\n`;
    let page = `# ${namespace}\n\nThis page lists built-in actions and conditions in the ${namespace} namespace.\n\n`;
    for (const e of entries) {
      const wording = language[e.name];
      if (wording && wording.source !== e.summary) throw new Error(`Review reference wording after catalog change: ${e.name}`);
      page += `## ${e.name} {#${e.name.toLowerCase().replace('.', '-')}}\n\n${escapeText(wording?.summary ?? e.summary ?? '')}\n\n`;
      page += `**Kind:** ${escapeText(e.kind)} · **Contexts:** ${escapeText(e.contexts.join(', '))} · **Default:** ${escapeText(e.default)} · **Actor:** ${escapeText(e.actor ?? 'optional')}\n\n`;
      const properties = Object.entries(e.params?.properties ?? {}).sort(([a], [b]) => compare(a, b));
      if (properties.length) {
        page += '| Parameter | Required | Type | Description |\n| --- | --- | --- | --- |\n';
        for (const [name, spec] of properties) {
          const parameterWording = wording?.parameters?.[name];
          if (parameterWording && parameterWording.source !== spec.description) throw new Error(`Review parameter wording after catalog change: ${e.name}.${name}`);
          page += `| ${escapeText(name)} | ${e.params.required?.includes(name) ? 'Yes' : 'No'} | ${escapeText(spec.type ?? (spec.enum ? 'enum' : 'See schema'))} | ${escapeText(parameterWording?.description ?? spec.description ?? spec.format ?? 'See schema below')} |\n`;
        }
        page += '\n';
      } else page += 'No named parameters.\n\n';
      for (const name of Object.keys(wording?.parameters ?? {})) {
        if (!Object.hasOwn(e.params?.properties ?? {}, name)) throw new Error(`Review removed parameter wording: ${e.name}.${name}`);
      }
      if (e.params) page += `::: details Full parameter schema and constraints\n${jsonBlock(e.params)}\n:::\n\n`;
      if (e.returns !== undefined) page += `### Return value\n\nUse \`save\` to store the result.\n\n${jsonBlock(e.returns)}\n\n`;
      if (e.notes) {
        const notes = e.notes === 'Uses the step `timeout` as its budget; no timeout param.'
          ? 'This action uses the step timeout. It has no separate timeout parameter.'
          : e.notes === 'Escape and other keys Roblox reserves never reach the game; drive menus with gui.click or a game.* hook.'
            ? 'Roblox reserves Escape and other menu keys. These keys do not reach the game. Use gui.click or a game hook for menus.'
            : typeof e.notes === 'string' ? e.notes : JSON.stringify(e.notes);
        page += `**Notes:** ${escapeText(notes)}\n\n`;
      }
    }
    pages.set(`${namespace}.md`, page);
  }
  pages.set('index.md', index);
  return pages;
}

export async function generate() {
  await mkdir(path.join(root, 'docs/public'), { recursive: true });
  await copyFile(path.join(root, 'docs/logo.svg'), path.join(root, 'docs/public/logo.svg'));
  const catalog = JSON.parse(await readFile(path.join(root, 'schema/catalog.json'), 'utf8'));
  const pages = renderCatalog(catalog);
  const output = path.join(root, 'docs/reference');
  await mkdir(output, { recursive: true });
  for (const file of await readdir(output)) {
    if (file.endsWith('.md') && !pages.has(file)) await unlink(path.join(output, file));
  }
  for (const [file, content] of pages) await writeFile(path.join(output, file), content);
  console.log(`Generated ${pages.size} reference pages for ${catalog.entries.length} catalog entries.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generate();
