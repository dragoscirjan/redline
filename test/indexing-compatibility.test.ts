import { execaSync } from 'execa';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

/** Older trusted parents resolve the child at the new PR revision, so a no-index descriptor must remain loadable. */
it.each(['cgc', 'gitnexus'])('keeps older Action callers operational without executing %s', async provider => {
  const source = await readFile(new URL('../github/code-index/action.yaml', import.meta.url), 'utf8');
  expect(source).toContain('using: composite'); expect(source).not.toContain('uses:');
  expect(source).not.toContain('run.sh'); expect(source).not.toContain('actions/cache');
  const raw = source.split('      run: |\n')[1];
  if (raw === undefined) throw new Error('compatibility script absent');
  const script = raw.split('\n').map(line => line.startsWith('        ') ? line.slice(8) : line).join('\n');
  const root = await mkdtemp(join(tmpdir(), 'redline-index-compat-'));
  try {
    const path = join(root, 'retired.sh'), output = join(root, 'outputs');
    await writeFile(path, script);
    const env = { PATH: process.env.PATH, REQUESTED_PROVIDER: provider, REQUESTED_MODE: 'review', GITHUB_OUTPUT: output };
    const result = execaSync('bash', [path], { env, extendEnv: false, stripFinalNewline: false, reject: false, timeout: 5000 });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Requested provider ${provider} is not invoked`);
    expect(await readFile(output, 'utf8')).toBe('context-file=\nstatus=unavailable\ncache-hit=false\ncache-save-outcome=skipped\nwarmup-result=retired\n');
    const invalid = execaSync('bash', [path], { env: { ...env, REQUESTED_PROVIDER: 'unapproved' }, extendEnv: false,
      stripFinalNewline: false, reject: false, timeout: 5000 });
    expect(invalid.exitCode).toBe(2); expect(invalid.stdout).toBe('');
  } finally { await rm(root, { recursive: true, force: true }); }
});
