// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	site: 'https://dahai9.github.io',
	base: '/Sea_of_Bits',
	integrations: [mdx(), sitemap()],
});
