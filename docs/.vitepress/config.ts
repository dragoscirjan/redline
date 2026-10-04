import { defineConfig } from 'vitepress';

/** Deployment base path for the published site; local builds keep '/'. */
const base = process.env.DOCS_BASE ?? '/';

// Navigation follows reader tasks: adopt the action, then understand the
// pipeline behind it.
export default defineConfig({
  title: 'Redline',
  description: 'Automated pull request review for GitHub, Forgejo, and Gitea',
  base,
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Adopt', link: '/reusable-review-workflow' },
      { text: 'Reference', link: '/github-composite-action' },
    ],
    sidebar: [
      {
        text: 'Adopt',
        items: [
          { text: 'Reusable review workflow', link: '/reusable-review-workflow' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'GitHub composite action', link: '/github-composite-action' },
          { text: 'Runnable review configuration', link: '/runnable-review-configuration' },
          { text: 'Container staging', link: '/container-staging' },
          { text: 'Review reporting', link: '/review-reporting' },
          { text: 'Candidate runner images', link: '/candidate-runner-images' },
        ],
      },
    ],
  },
});