import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const workflow = async (): Promise<string> => (await readFile(new URL('../.github/workflows/docker.yml', import.meta.url), 'utf8')).replace(/\r\n?/gu, '\n');
function script(source: string, name: string): string {
  const step = source.split('      - name: ' + name + '\n')[1]?.split('\n      - ')[0];
  const value = step?.split('        run: |\n')[1];
  if (value === undefined) throw new Error('Missing workflow script: ' + name);
  return value.split('\n').map(line => line.slice(10)).join('\n');
}
const digest = (character: string): string => 'sha256:' + character.repeat(64);
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'redline-image-publish-')); roots.push(root); return root;
}

describe('native image publication', () => {
  it.each(['\n', '\r\n'])('tests native images before cached attested export, then only merges digests (%j)', async newline => {
    const source = (await workflow()).replace(/\n/gu, newline).replace(/\r\n/gu, '\n');
    const native = source.split('\n  publish:\n')[0] ?? '';
    const publish = source.split('\n  publish:\n')[1] ?? '';
    expect(source).not.toContain('setup-qemu-action');
    expect(native.match(/platforms: linux\/\$\{\{ matrix.arch \}\}/gu)).toHaveLength(2);
    expect(native).toContain('load: true');
    expect(native).toContain('push-by-digest=true');
    expect(native).toContain('provenance: true'); expect(native).toContain('sbom: true');
    expect(native.match(/SOURCE_DATE_EPOCH=\$\{\{ steps.version.outputs.epoch \}\}/gu)).toHaveLength(2);
    expect(native.indexOf('Test real harnesses')).toBeLessThan(native.indexOf('docker/login-action@'));
    expect(native.indexOf('Test real harnesses')).toBeLessThan(native.indexOf('id: push'));
    expect(native.indexOf('Record the tested image digest')).toBeLessThan(native.indexOf('actions/upload-artifact@'));
    expect(native).toContain('overwrite: true');
    expect(native).not.toContain('github.run_attempt');
    expect(publish).toContain('needs: test');
    expect(publish).toContain('merge-multiple: true');
    expect(publish).toContain('pattern: native-digest-*');
    expect(publish).not.toContain('build-push-action');
    expect(publish).not.toContain('docker build ');
    expect(publish).toContain('docker buildx imagetools create');
  });

  it.runIf(process.platform === 'linux').each(['matching', 'different', 'empty', 'invalid', 'missing-platform'])('records only a matching tested image config and valid digest: %s', async mode => {
    const root = await directory();
    await writeFile(join(root, 'docker'), `#!${process.execPath}
const ref = process.argv.at(-1);
const value = ref.endsWith('@' + process.env.DIGEST)
  ? { manifests: [{ platform: { os: 'linux', architecture: process.env.PLATFORM }, digest: ${JSON.stringify(digest('d'))} }] }
  : { config: { digest: process.env.PUBLISHED_ID } };
console.log(JSON.stringify(value));
`, { mode: 0o700 });
    const prelude = 'docker() { "$FIXTURE_ROOT/docker" "$@"; };\n';
    const result = spawnSync('bash', ['-c', prelude + script(await workflow(), 'Record the tested image digest')], {
      env: { PATH: process.env.PATH, FIXTURE_ROOT: root, TESTED_ID: mode === 'empty' ? '' : digest('a'),
        PUBLISHED_ID: mode === 'different' ? digest('b') : digest('a'),
        DIGEST: mode === 'invalid' ? '--malformed' : digest('c'), DIGEST_DIR: join(root, 'digests'), ARCH: 'amd64',
        IMAGE: 'ghcr.io/example/redline', PLATFORM: mode === 'missing-platform' ? 'unknown' : 'amd64' },
      encoding: 'utf8', timeout: 3000,
    });
    if (mode === 'matching') expect(result.status, result.stderr).toBe(0);
    else expect(result.status, result.stderr).not.toBe(0);
    expect(await readFile(join(root, 'digests/amd64'), 'utf8').catch(() => '')).toBe(mode === 'matching' ? digest('c') + '\n' : '');
  });

  it.runIf(process.platform === 'linux').each(['valid', 'missing', 'malformed', 'duplicate'])('merges exactly two validated digest references: %s', async mode => {
    const root = await directory(); await mkdir(join(root, 'digests'));
    await writeFile(join(root, 'digests/amd64'), digest('a') + '\n');
    if (mode !== 'missing') await writeFile(join(root, 'digests/arm64'),
      (mode === 'malformed' ? '$(exit 77)' : mode === 'duplicate' ? digest('a') : digest('b')) + '\n');
    await writeFile(join(root, 'docker'), `#!${process.execPath}
require('node:fs').appendFileSync(process.env.FIXTURE_ROOT + '/calls', JSON.stringify(process.argv.slice(2)) + '\\n');
`, { mode: 0o700 });
    const prelude = 'docker() { "$FIXTURE_ROOT/docker" "$@"; };\n';
    const result = spawnSync('bash', ['-c', prelude + script(await workflow(), 'Publish the multi-platform version tag')], {
      env: { PATH: process.env.PATH, FIXTURE_ROOT: root, DIGEST_DIR: join(root, 'digests'), IMAGE: 'ghcr.io/example/redline', VERSION: '1.2.1' },
      encoding: 'utf8', timeout: 3000,
    });
    expect(result.status, result.stderr).toBe(mode === 'valid' ? 0 : 1);
    const calls = (await readFile(join(root, 'calls'), 'utf8').catch(() => '')).trim();
    if (mode !== 'valid') expect(calls).toBe('');
    else expect(JSON.parse(calls.split('\n')[0] ?? 'null')).toEqual([
      'buildx', 'imagetools', 'create', '--tag', 'ghcr.io/example/redline:1.2.1',
      'ghcr.io/example/redline@' + digest('a'), 'ghcr.io/example/redline@' + digest('b'),
    ]);
  });
});
