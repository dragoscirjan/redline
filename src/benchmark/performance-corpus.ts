import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseBenchmarkFixture, type BenchmarkFixture } from './benchmark.js';

const PERFORMANCE_CORPUS_VERSION = 1 as const;
const FILE_COUNT = 20;
const MAX_CORPUS_BYTES = 64 * 1024;
const FILE_ID = /^\d{6}$/u;
const REVISION = /^[0-9a-f]{40}$/u;

export const PERFORMANCE_FILE_CATEGORIES = [
  'typescript',
  'test',
  'configuration',
  'documentation',
  'large-source',
  'generated-like',
] as const;
export type PerformanceFileCategory = (typeof PERFORMANCE_FILE_CATEGORIES)[number];

type FixtureFormat = 'typescript' | 'json' | 'yaml' | 'markdown';
type IndexStatus = 'complete' | 'unsupported';

export interface PerformanceCorpusFile {
  readonly id: string;
  readonly path: string;
  readonly category: PerformanceFileCategory;
  readonly format: FixtureFormat;
  readonly lines: number;
  readonly changeLine: number;
  readonly durationMs: number;
  readonly indexStatus: IndexStatus;
}

export interface PerformanceCorpus {
  readonly version: typeof PERFORMANCE_CORPUS_VERSION;
  readonly id: string;
  readonly title: string;
  readonly files: readonly PerformanceCorpusFile[];
  readonly fixture: BenchmarkFixture;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown key: ${key}`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new Error(`${label} is missing key: ${key}`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function repositoryPath(value: unknown, label: string): string {
  const path = text(value, label);
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${label} must be a normalized repository-relative path`);
  }
  return path;
}

function sourceLines(file: PerformanceCorpusFile, changed: boolean): string[] {
  const replacement = changed ? 'head-value' : 'base-value';
  if (file.format === 'json') {
    const properties = Array.from({ length: file.lines - 2 }, (_, index) => {
      const line = index + 2;
      const value = line === file.changeLine ? replacement : `value-${line}`;
      const comma = index === file.lines - 3 ? '' : ',';
      return `  "key-${line}": "${value}"${comma}`;
    });
    return ['{', ...properties, '}'];
  }
  if (file.format === 'yaml') {
    return Array.from({ length: file.lines }, (_, index) => {
      const line = index + 1;
      return line === file.changeLine ? `benchmark-setting: ${replacement}` : `# benchmark context line ${line}`;
    });
  }
  if (file.format === 'markdown') {
    return Array.from({ length: file.lines }, (_, index) => {
      const line = index + 1;
      if (line === 1) return '# Performance fixture';
      return line === file.changeLine
        ? `Benchmark behavior is ${replacement}.`
        : `Benchmark documentation context line ${line}.`;
    });
  }
  return Array.from({ length: file.lines }, (_, index) => {
    const line = index + 1;
    return line === file.changeLine
      ? `export const benchmarkValue${file.id} = '${replacement}';`
      : `// benchmark TypeScript context line ${line}`;
  });
}

function fixtureFile(file: PerformanceCorpusFile): {
  readonly id: string;
  readonly path: string;
  readonly status: 'M';
  readonly base: string;
  readonly head: string;
  readonly diff: string;
} {
  const baseLines = sourceLines(file, false);
  const headLines = sourceLines(file, true);
  const oldLine = baseLines[file.changeLine - 1];
  const newLine = headLines[file.changeLine - 1];
  if (oldLine === undefined || newLine === undefined) throw new Error(`performance file ${file.path} change line is missing`);
  return {
    id: file.id,
    path: file.path,
    status: 'M',
    base: `${baseLines.join('\n')}\n`,
    head: `${headLines.join('\n')}\n`,
    diff: [
      `--- a/${file.path}`,
      `+++ b/${file.path}`,
      `@@ -${file.changeLine} +${file.changeLine} @@`,
      `-${oldLine}`,
      `+${newLine}`,
      '',
    ].join('\n'),
  };
}

function parseFile(value: unknown, index: number): PerformanceCorpusFile {
  const label = `performance corpus.files[${index}]`;
  const input = record(value, label);
  exactKeys(input, ['id', 'path', 'category', 'format', 'lines', 'changeLine', 'durationMs', 'indexStatus'], label);
  const id = text(input['id'], `${label}.id`);
  if (!FILE_ID.test(id)) throw new Error(`${label}.id must contain six digits`);
  const category = input['category'];
  if (!(PERFORMANCE_FILE_CATEGORIES as readonly unknown[]).includes(category)) {
    throw new Error(`${label}.category is unsupported`);
  }
  const format = input['format'];
  if (format !== 'typescript' && format !== 'json' && format !== 'yaml' && format !== 'markdown') {
    throw new Error(`${label}.format is unsupported`);
  }
  const indexStatus = input['indexStatus'];
  if (indexStatus !== 'complete' && indexStatus !== 'unsupported') {
    throw new Error(`${label}.indexStatus is unsupported`);
  }
  const lines = integer(input['lines'], `${label}.lines`, 4, 600);
  const changeLine = integer(input['changeLine'], `${label}.changeLine`, 2, lines - 1);
  return {
    id,
    path: repositoryPath(input['path'], `${label}.path`),
    category: category as PerformanceFileCategory,
    format,
    lines,
    changeLine,
    durationMs: integer(input['durationMs'], `${label}.durationMs`, 0, 30 * 60 * 1_000),
    indexStatus,
  };
}

function parseCorpus(value: unknown): PerformanceCorpus {
  const input = record(value, 'performance corpus');
  exactKeys(input, ['version', 'id', 'title', 'baseRevision', 'headRevision', 'files'], 'performance corpus');
  if (input['version'] !== PERFORMANCE_CORPUS_VERSION) {
    throw new Error(`performance corpus.version must be ${PERFORMANCE_CORPUS_VERSION}`);
  }
  const baseRevision = text(input['baseRevision'], 'performance corpus.baseRevision');
  const headRevision = text(input['headRevision'], 'performance corpus.headRevision');
  if (!REVISION.test(baseRevision) || !REVISION.test(headRevision) || baseRevision === headRevision) {
    throw new Error('performance corpus revisions must be distinct 40-character lowercase hex strings');
  }
  if (!Array.isArray(input['files']) || input['files'].length !== FILE_COUNT) {
    throw new Error(`performance corpus must contain exactly ${FILE_COUNT} files`);
  }
  const files = input['files'].map(parseFile);
  if (new Set(files.map((file) => file.id)).size !== files.length) throw new Error('performance corpus file IDs must be unique');
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error('performance corpus file paths must be unique');
  for (const category of PERFORMANCE_FILE_CATEGORIES) {
    if (!files.some((file) => file.category === category)) {
      throw new Error(`performance corpus must include category ${category}`);
    }
  }
  const responses = files.map((file) => ({
    fileId: file.id,
    durationMs: file.durationMs,
    document: { version: 3, fileId: file.id, outcome: 'clean', findings: [] },
  }));
  const fixture = parseBenchmarkFixture({
    version: 2,
    id: text(input['id'], 'performance corpus.id'),
    title: text(input['title'], 'performance corpus.title'),
    kind: 'clean',
    baseRevision,
    headRevision,
    files: files.map(fixtureFile),
    additionalHeadFiles: {},
    expectedIssues: [],
    recordings: [
      { mode: 'file-only', responses, judgments: [] },
      {
        mode: 'indexed-context',
        responses,
        judgments: [],
        codeContext: {
          version: 1,
          provider: { id: 'cgc', version: '0.5.7' },
          repository: 'benchmark/redline',
          revision: headRevision,
          status: 'partial',
          files: [...files]
            .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
            .map((file) => ({ changedPath: file.path, status: file.indexStatus, related: [] })),
          diagnostics: [{
            level: 'info',
            code: 'performance-corpus',
            message: 'Fixed provider-neutral context for the deterministic performance corpus.',
          }],
          timings: { installationMs: 0, restoreMs: 0, indexMs: 0, queryMs: 0, saveMs: null },
        },
      },
    ],
  });
  return {
    version: PERFORMANCE_CORPUS_VERSION,
    id: fixture.id,
    title: fixture.title,
    files,
    fixture,
  };
}

export async function loadPerformanceCorpus(path: string): Promise<PerformanceCorpus> {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(absolute) !== absolute) {
    throw new Error('performance corpus must be a regular file without symbolic links');
  }
  if (info.size > MAX_CORPUS_BYTES) throw new Error('performance corpus exceeds its byte limit');
  return parseCorpus(JSON.parse(await readFile(absolute, 'utf8')) as unknown);
}
