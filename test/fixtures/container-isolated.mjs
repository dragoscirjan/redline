// Exercise the unchanged isolated Actions engine, not the native Docker CLI profile.
import { mkdir } from 'node:fs/promises';
import { parseLocalOptions } from '/opt/redline/src/local/options.ts';
import { GitRevisionSource } from '/opt/redline/src/local/git-source.ts';
import { CompositeReporter, ReviewApplication } from '/opt/redline/src/application/review.ts';

const options = await parseLocalOptions(process.argv.slice(2), process.env, '/repository');
if (options.output === undefined) throw new Error('The isolated fixture requires an output directory');
await mkdir(options.output, { mode: 0o700 });
const reporter = new CompositeReporter([{
  id: 'isolated-fixture', async preflight() {}, async complete() {},
  /** Emit only the fixture's planned and completed review events for the container integration assertions. */
  progress(event) {
    if (event.kind === 'analysis-status') for (const integration of event.integrations) {
      if (integration.status !== 'ready') process.stderr.write(integration.component + ' ' + integration.status + '\n');
    }
  },
}]);
const application = new ReviewApplication({
  source: new GitRevisionSource(options, process.env, options.output), reporter,
});
const result = await application.run({ environment: { ...options.environment, outputDirectory: options.output } }, new AbortController().signal);
process.exitCode = result.exitCode;
