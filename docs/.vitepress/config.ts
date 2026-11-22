import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Redline',
  description: 'Initiative 4.0 implementation, Git capture and remaining review-engine work.',
  base: process.env.DOCS_BASE ?? '/',
  themeConfig: {
    nav: [
      { text: 'Local command', link: '/' },
      { text: 'Git capture', link: '/capture' },
      { text: 'Architecture', link: '/architecture' },
    ],
    sidebar: [
      { text: 'Local command', link: '/' },
      { text: 'Git capture', link: '/capture' },
      { text: 'Architecture and limits', link: '/architecture' },
    ],
  },
});
