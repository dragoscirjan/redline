import { defineConfig } from 'vitepress';

/** Deployment base path for the published site; local builds keep '/'. */
const base = process.env.DOCS_BASE ?? '/';

export default defineConfig({
  title: 'Redline',
  description: 'AI code reviews for local Git changes and GitHub pull requests.',
  base,
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: 'Get started', link: '/get-started/' },
      {
        text: 'Guides',
        items: [
          { text: 'Review a change', link: '/commands' },
          { text: 'Run with Docker', link: '/docker-workers' },
          { text: 'Set up GitHub Actions', link: '/get-started/github-actions' },
          { text: 'Read the results', link: '/results' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI options', link: '/local-cli' },
          { text: 'GitHub workflow', link: '/reusable-review-workflow' },
          { text: 'JSON-RPC protocol', link: '/stdio-protocol' },
          { text: 'Roadmap', link: '/roadmap' },
        ],
      },
    ],
    search: { provider: 'local' },
    outline: [2, 3],
    socialLinks: [{ icon: 'github', link: 'https://github.com/dragoscirjan/redline' }],
    sidebar: [
      {
        text: 'Get started',
        items: [
          { text: 'Install Redline', link: '/get-started/' },
          { text: 'Run your first review', link: '/get-started/first-review' },
          { text: 'Connect a model', link: '/get-started/configuration' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Common commands', link: '/commands' },
          { text: 'Run with Docker', link: '/docker-workers' },
          { text: 'Read the results', link: '/results' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
      {
        text: 'GitHub Actions',
        collapsed: true,
        items: [
          { text: 'Set up PR reviews', link: '/get-started/github-actions' },
          { text: 'Reusable workflow reference', link: '/reusable-review-workflow' },
          { text: 'Action reference', link: '/github-composite-action' },
          { text: 'Dogfood reviews', link: '/dogfood-review' },
          { text: 'Code-index action', link: '/code-index-action' },
        ],
      },
      {
        text: 'Reference',
        collapsed: true,
        items: [
          { text: 'CLI options and behavior', link: '/local-cli' },
          { text: 'Stdio JSON-RPC protocol', link: '/stdio-protocol' },
          { text: 'Review eligibility', link: '/review-eligibility' },
          { text: 'Review output schema', link: '/review-reporting' },
          { text: 'Review environment contract', link: '/runnable-review-configuration' },
        ],
      },
      {
        text: 'Project and architecture',
        collapsed: true,
        items: [
          { text: 'Roadmap', link: '/roadmap' },
          { text: 'Application architecture', link: '/portable-architecture' },
          { text: 'Harness executor', link: '/harness-executor' },
          { text: 'Code intelligence', link: '/code-intelligence' },
        ],
      },
      {
        text: 'Benchmarks and maintenance',
        collapsed: true,
        items: [
          { text: 'Review quality', link: '/review-quality-benchmark' },
          { text: 'Performance', link: '/performance-benchmark' },
          { text: 'Checkout', link: '/checkout-benchmark' },
          { text: 'Model execution', link: '/model-execution-benchmark' },
          { text: 'Release operations', link: '/local-cli#release-operations' },
        ],
      },
    ],
  },
});
