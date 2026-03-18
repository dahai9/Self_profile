// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	site: 'https://dahai9.github.io',
	base: '/Self_profile',
	integrations: [mdx(), sitemap()],
});
