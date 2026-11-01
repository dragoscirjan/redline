/** Trusted release preflight. A registry failure never means a version is available. */
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function assertNpmVersionAvailable(
  name: string,
  packageVersion: string,
  requestedVersion: string,
  request: typeof fetch = fetch,
): Promise<void> {
  if (name !== '@dragoscirjan/redline' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(requestedVersion)
    || requestedVersion !== packageVersion) throw new Error('requested version must match the scoped package version');
  const response = await request(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(requestedVersion)}`, {
    signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
  await response.body?.cancel();
  if (response.status === 200) throw new Error('npm version already exists; published versions are immutable');
  if (response.status !== 404) throw new Error('npm version availability could not be established');
}

/** Only the publication hook requires consumed notes; version PRs run before this hook. */
export async function assertPublishOnlyChangesets(directory: string | URL): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (!entries.some(entry => entry.name === 'config.json' && entry.isFile())
    || entries.some(entry => !entry.isFile() || !['config.json', 'README.md'].includes(entry.name))) {
    throw new Error('consume pending Changesets in a reviewed version change before publishing');
  }
}

/** Only regular Markdown notes can request version-PR mode; unknown/prerelease state fails closed. */
export async function classifyReleaseChangesets(directory: string | URL): Promise<'version' | 'publish'> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (!entries.some(entry => entry.name === 'config.json' && entry.isFile())) throw new Error('Missing regular Changesets configuration');
  let pending = false;
  for (const entry of entries) {
    if (!entry.isFile()) throw new Error('Changesets entries must be regular files');
    if (entry.name === 'config.json' || entry.name === 'README.md') continue;
    if (!entry.name.endsWith('.md')) throw new Error('Unknown or prerelease Changesets state');
    pending = true;
  }
  return pending ? 'version' : 'publish';
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const metadata: { name: string; version: string } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    await assertPublishOnlyChangesets(new URL('../../.changeset/', import.meta.url));
    await assertNpmVersionAvailable(metadata.name, metadata.version, process.argv[2] ?? metadata.version);
  } catch {
    process.stderr.write('release preflight failed: version mismatch, pending Changesets, existing version, or registry unavailable\n');
    process.exitCode = 1;
  }
}
