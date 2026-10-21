import { defineConfig } from 'vitepress';
import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../../schema/catalog.json', import.meta.url), 'utf8'));
const namespaces = [...new Set<string>(catalog.entries.map((e: { name: string }) => e.name.split('.')[0]))].sort();

export default defineConfig({
  title: 'Stagehand',
  description: 'Write YAML playtests. Run them in Roblox Studio through an MCP server. Read results for each step.',
  base: '/Stagehand/',
  cleanUrls: false,
  srcExclude: ['architecture.md', 'implementation-brief.md'],
  ignoreDeadLinks: false,
  lastUpdated: true,
  head: [['meta', { name: 'theme-color', content: '#211b2b' }], ['link', { rel: 'icon', type: 'image/svg+xml', href: '/Stagehand/logo.svg' }]],
  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: 'Getting Started', link: '/quickstart' },
      { text: 'Guides', link: '/writing-tests' },
      { text: 'Reference', link: '/reference/' },
      { text: 'Internals', link: '/protocol' },
    ],
    sidebar: [
      { text: 'Getting Started', items: [{ text: 'Quickstart', link: '/quickstart' }, { text: 'Studio plugin', link: '/plugin' }] },
      { text: 'Guides', items: [{ text: 'Writing playtests', link: '/writing-tests' }, { text: 'Game hooks', link: '/game-hooks' }] },
      { text: 'Reference', items: [{ text: 'Playtest specification', link: '/spec' }, { text: 'MCP server and tools', link: '/mcp' }, { text: 'Actions and conditions', link: '/reference/' }, ...namespaces.map(name => ({ text: name, link: `/reference/${name}` }))] },
      { text: 'Internals', collapsed: true, items: [{ text: 'Broker protocol', link: '/protocol' }, { text: 'Architecture (repository)', link: 'https://github.com/unix-system/Stagehand/blob/main/docs/architecture.md' }] },
    ],
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/unix-system/Stagehand' }],
    outline: [2, 3],
    footer: { message: 'Automatic playtests for Roblox Studio.', copyright: 'Stagehand · MIT license' },
  },
});
