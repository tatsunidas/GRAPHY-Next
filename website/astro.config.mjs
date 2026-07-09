// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// GRAPHY family site. Static output, deployed to graphy.vis-ionary.com.
// i18n is wired for a future English pass; Phase 1 ships Japanese content only
// (all copy lives in src/data/site.ts so translation is a later, isolated task).
export default defineConfig({
  site: 'https://graphy.vis-ionary.com',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  i18n: {
    defaultLocale: 'ja',
    locales: ['ja', 'en'],
    routing: { prefixDefaultLocale: false },
  },
  integrations: [sitemap()],
});
