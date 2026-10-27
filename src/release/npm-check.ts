/** Trusted release preflight. A registry failure never means a version is available. */
import { readFile } from 'node:fs/promises';
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const metadata: { name: string; version: string } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    await assertNpmVersionAvailable(metadata.name, metadata.version, process.argv[2] ?? '');
  } catch {
    process.stderr.write('release preflight failed: version mismatch, existing version, or registry unavailable\n');
    process.exitCode = 1;
  }
}
