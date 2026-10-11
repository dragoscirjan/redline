import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type {
  HarnessExecutor,
  HarnessPrompt,
  HarnessRun,
  HarnessSettings,
  PreparedHarness,
} from '../harness-executor/types.js';
import { parseDuration } from '../duration.js';
import type { ReviewEnvironment } from '../review/environment.js';
import { parseChangedLines, type ChangedLines } from '../review/report.js';
import { runFileReviews } from '../review/runner.js';
import type { FileReviewRecord, FindingSide } from '../review/types.js';

const BENCHMARK_VERSION = 1 as const;
const FIXTURE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FILE_ID = /^\d{6}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const MODES = ['file-only'] as const;

type BenchmarkMode = (typeof MODES)[number];
type FixtureKind = 'defect' | 'clean';
type CoverageStatus = 'complete' | 'partial' | 'unavailable';

interface FixtureFile {
  readonly id: string;
  readonly path: string;
  readonly status: 'M';
  readonly base: string;
  readonly head: string;
  readonly diff: string;
}

interface EvidenceLocation {
  readonly path: string;
  readonly side: FindingSide;
  readonly startLine: number;
  readonly endLine: number;
}

interface ExpectedIssue {
  readonly id: string;
  readonly title: string;
  readonly locations: readonly EvidenceLocation[];
}

interface RecordedResponse {
  readonly fileId: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly durationMs: number;
}

interface FindingJudgment {
  readonly fileId: string;
  readonly findingIndex: number;
  readonly expectedIssueId: string | null;
}

interface FixtureRecording {
  readonly mode: BenchmarkMode;
  readonly responses: readonly RecordedResponse[];
  readonly judgments: readonly FindingJudgment[];
}

export interface BenchmarkFixture {
  readonly version: typeof BENCHMARK_VERSION;
  readonly id: string;
  readonly title: string;
  readonly kind: FixtureKind;
  readonly baseRevision: string;
  readonly headRevision: string;
  readonly files: readonly FixtureFile[];
  readonly additionalHeadFiles: Readonly<Record<string, string>>;
  readonly expectedIssues: readonly ExpectedIssue[];
  readonly recordings: readonly FixtureRecording[];
}

interface CorpusManifest {
  readonly version: typeof BENCHMARK_VERSION;
  readonly fixtures: readonly string[];
}

export interface BenchmarkCaseResult {
  readonly fixtureId: string;
  readonly title: string;
  readonly kind: FixtureKind;
  readonly coverage: CoverageStatus;
  readonly expectedIssues: number;
  readonly rootCauseMatches: number;
  readonly creditedIssues: number;
  readonly unmatchedIssueIds: readonly string[];
  readonly uncreditedIssueIds: readonly string[];
  readonly findings: number;
  readonly falsePositives: number;
  readonly duplicateFindings: number;
  readonly claimedMatches: number;
  readonly validEvidenceMatches: number;
  readonly promptBytes: number;
  readonly reviewDurationMs: number;
}

export interface BenchmarkModeResult {
  readonly mode: BenchmarkMode;
  readonly fixtures: number;
  readonly expectedIssues: number;
  readonly rootCauseMatches: number;
  readonly creditedIssues: number;
  readonly findings: number;
  readonly falsePositives: number;
  readonly duplicateFindings: number;
  readonly cleanFixtures: number;
  readonly cleanFixturesWithFalsePositives: number;
  readonly claimedMatches: number;
  readonly validEvidenceMatches: number;
  readonly promptBytes: number;
  readonly reviewDurationMs: number;
  readonly cases: readonly BenchmarkCaseResult[];
}

export interface BenchmarkReport {
  readonly version: typeof BENCHMARK_VERSION;
  readonly corpusVersion: typeof BENCHMARK_VERSION;
  readonly modes: readonly BenchmarkModeResult[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function string(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (parsed.length === 0) throw new Error(`${label} must be a non-empty string`);
  return parsed;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be an integer greater than or equal to ${minimum}`);
  }
  return value as number;
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

function repositoryPath(value: unknown, label: string): string {
  const path = string(value, label);
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${label} must be a normalized repository-relative path`);
  }
  return path;
}

function parseLocation(value: unknown, label: string): EvidenceLocation {
  const input = record(value, label);
  exactKeys(input, ['path', 'side', 'startLine', 'endLine'], label);
  const side = input['side'];
  if (side !== 'LEFT' && side !== 'RIGHT') throw new Error(`${label}.side must be LEFT or RIGHT`);
  const startLine = integer(input['startLine'], `${label}.startLine`, 1);
  const endLine = integer(input['endLine'], `${label}.endLine`, 1);
  if (endLine < startLine) throw new Error(`${label}.endLine must not precede startLine`);
  return { path: repositoryPath(input['path'], `${label}.path`), side, startLine, endLine };
}

function parseFixtureFile(value: unknown, label: string): FixtureFile {
  const input = record(value, label);
  exactKeys(input, ['id', 'path', 'status', 'base', 'head', 'diff'], label);
  const id = string(input['id'], `${label}.id`);
  if (!FILE_ID.test(id)) throw new Error(`${label}.id must contain six digits`);
  if (input['status'] !== 'M') throw new Error(`${label}.status must be M`);
  return {
    id,
    path: repositoryPath(input['path'], `${label}.path`),
    status: 'M',
    base: text(input['base'], `${label}.base`),
    head: text(input['head'], `${label}.head`),
    diff: string(input['diff'], `${label}.diff`),
  };
}

function parseExpectedIssue(value: unknown, label: string): ExpectedIssue {
  const input = record(value, label);
  exactKeys(input, ['id', 'title', 'locations'], label);
  const id = string(input['id'], `${label}.id`);
  if (!FIXTURE_ID.test(id)) throw new Error(`${label}.id must be a lowercase slug`);
  const locations = array(input['locations'], `${label}.locations`).map((item, index) =>
    parseLocation(item, `${label}.locations[${index}]`));
  if (locations.length === 0) throw new Error(`${label}.locations must not be empty`);
  return { id, title: string(input['title'], `${label}.title`), locations };
}

function parseRecording(value: unknown, label: string): FixtureRecording {
  const input = record(value, label);
  exactKeys(input, ['mode', 'responses', 'judgments'], label);
  const mode = input['mode'];
  if (!MODES.includes(mode as BenchmarkMode)) throw new Error(`${label}.mode is unsupported`);
  const responses = array(input['responses'], `${label}.responses`).map((item, index): RecordedResponse => {
    const response = record(item, `${label}.responses[${index}]`);
    exactKeys(response, ['fileId', 'document', 'durationMs'], `${label}.responses[${index}]`);
    const fileId = string(response['fileId'], `${label}.responses[${index}].fileId`);
    if (!FILE_ID.test(fileId)) throw new Error(`${label}.responses[${index}].fileId must contain six digits`);
    return {
      fileId,
      document: record(response['document'], `${label}.responses[${index}].document`),
      durationMs: integer(response['durationMs'], `${label}.responses[${index}].durationMs`),
    };
  });
  const judgments = array(input['judgments'], `${label}.judgments`).map((item, index): FindingJudgment => {
    const judgment = record(item, `${label}.judgments[${index}]`);
    exactKeys(judgment, ['fileId', 'findingIndex', 'expectedIssueId'], `${label}.judgments[${index}]`);
    const fileId = string(judgment['fileId'], `${label}.judgments[${index}].fileId`);
    if (!FILE_ID.test(fileId)) throw new Error(`${label}.judgments[${index}].fileId must contain six digits`);
    return {
      fileId,
      findingIndex: integer(judgment['findingIndex'], `${label}.judgments[${index}].findingIndex`),
      expectedIssueId: judgment['expectedIssueId'] === null
        ? null
        : string(judgment['expectedIssueId'], `${label}.judgments[${index}].expectedIssueId`),
    };
  });
  return { mode: mode as BenchmarkMode, responses, judgments };
}

export function parseBenchmarkFixture(value: unknown): BenchmarkFixture {
  const input = record(value, 'benchmark fixture');
  exactKeys(input, [
    'version',
    'id',
    'title',
    'kind',
    'baseRevision',
    'headRevision',
    'files',
    'additionalHeadFiles',
    'expectedIssues',
    'recordings',
  ], 'benchmark fixture');
  if (input['version'] !== BENCHMARK_VERSION) throw new Error(`benchmark fixture.version must be ${BENCHMARK_VERSION}`);
  const id = string(input['id'], 'benchmark fixture.id');
  if (!FIXTURE_ID.test(id)) throw new Error('benchmark fixture.id must be a lowercase slug');
  const kind = input['kind'];
  if (kind !== 'defect' && kind !== 'clean') throw new Error('benchmark fixture.kind must be defect or clean');
  const baseRevision = string(input['baseRevision'], 'benchmark fixture.baseRevision');
  const headRevision = string(input['headRevision'], 'benchmark fixture.headRevision');
  if (!REVISION.test(baseRevision) || !REVISION.test(headRevision) || baseRevision === headRevision) {
    throw new Error('benchmark fixture revisions must be distinct 40-character lowercase hex strings');
  }
  const files = array(input['files'], 'benchmark fixture.files').map((item, index) =>
    parseFixtureFile(item, `benchmark fixture.files[${index}]`));
  if (files.length === 0) throw new Error('benchmark fixture.files must not be empty');
  const fileIds = new Set(files.map((file) => file.id));
  if (fileIds.size !== files.length) throw new Error('benchmark fixture file IDs must be unique');
  const filePaths = new Set(files.map((file) => file.path));
  if (filePaths.size !== files.length) throw new Error('benchmark fixture file paths must be unique');
  const changedByPath = new Map(files.map((file) => [file.path, applyFixtureDiff(file)]));
  const headInput = record(input['additionalHeadFiles'], 'benchmark fixture.additionalHeadFiles');
  const additionalHeadFiles = Object.fromEntries(
    Object.entries(headInput).map(([path, content]) => [
      repositoryPath(path, 'benchmark fixture.additionalHeadFiles path'),
      text(content, `benchmark fixture.additionalHeadFiles.${path}`),
    ]),
  );
  for (const path of Object.keys(additionalHeadFiles)) {
    if (filePaths.has(path)) throw new Error(`benchmark additional head file duplicates changed path ${path}`);
  }
  const expectedIssues = array(input['expectedIssues'], 'benchmark fixture.expectedIssues').map((item, index) =>
    parseExpectedIssue(item, `benchmark fixture.expectedIssues[${index}]`));
  if (kind === 'clean' && expectedIssues.length > 0) throw new Error('clean benchmark fixtures cannot declare expected issues');
  if (kind === 'defect' && expectedIssues.length === 0) throw new Error('defect benchmark fixtures require expected issues');
  const issueIds = new Set(expectedIssues.map((issue) => issue.id));
  if (issueIds.size !== expectedIssues.length) throw new Error('benchmark expected issue IDs must be unique');
  for (const issue of expectedIssues) {
    for (const location of issue.locations) {
      const changed = changedByPath.get(location.path);
      if (changed === undefined) {
        throw new Error(`benchmark expected issue ${issue.id} references unchanged path ${location.path}`);
      }
      const lines = location.side === 'RIGHT' ? changed.right : changed.left;
      const hasChangedLine = [...lines.keys()].some((line) => line >= location.startLine && line <= location.endLine);
      if (!hasChangedLine) {
        throw new Error(`benchmark expected issue ${issue.id} location contains no changed ${location.side} line`);
      }
    }
  }
  const recordings = array(input['recordings'], 'benchmark fixture.recordings').map((item, index) =>
    parseRecording(item, `benchmark fixture.recordings[${index}]`));
  if (recordings.length === 0) throw new Error('benchmark fixture.recordings must not be empty');
  const modes = new Set(recordings.map((recording) => recording.mode));
  if (modes.size !== recordings.length) throw new Error('benchmark fixture recording modes must be unique');
  for (const recording of recordings) {
    if (recording.responses.length !== files.length) {
      throw new Error(`benchmark fixture ${id} ${recording.mode} recording must contain one response per file`);
    }
    const responseIds = recording.responses.map((response) => response.fileId);
    if (new Set(responseIds).size !== responseIds.length) {
      throw new Error(`benchmark fixture ${id} ${recording.mode} response file IDs must be unique`);
    }
    for (const [index, response] of recording.responses.entries()) {
      if (!fileIds.has(response.fileId)) throw new Error(`benchmark fixture ${id} references unknown response file ${response.fileId}`);
      if (response.fileId !== files[index]?.id) {
        throw new Error(`benchmark fixture ${id} ${recording.mode} responses must follow manifest file order`);
      }
    }
    for (const judgment of recording.judgments) {
      if (!fileIds.has(judgment.fileId)) throw new Error(`benchmark fixture ${id} references unknown judgment file ${judgment.fileId}`);
      if (judgment.expectedIssueId !== null && !issueIds.has(judgment.expectedIssueId)) {
        throw new Error(`benchmark fixture ${id} references unknown expected issue ${judgment.expectedIssueId}`);
      }
    }
  }
  return {
    version: BENCHMARK_VERSION,
    id,
    title: string(input['title'], 'benchmark fixture.title'),
    kind,
    baseRevision,
    headRevision,
    files,
    additionalHeadFiles,
    expectedIssues,
    recordings,
  };
}

function parseCorpus(value: unknown): CorpusManifest {
  const input = record(value, 'benchmark corpus');
  exactKeys(input, ['version', 'fixtures'], 'benchmark corpus');
  if (input['version'] !== BENCHMARK_VERSION) throw new Error(`benchmark corpus.version must be ${BENCHMARK_VERSION}`);
  const fixtures = array(input['fixtures'], 'benchmark corpus.fixtures').map((item, index) =>
    repositoryPath(item, `benchmark corpus.fixtures[${index}]`));
  if (fixtures.length === 0) throw new Error('benchmark corpus.fixtures must not be empty');
  if (new Set(fixtures).size !== fixtures.length) throw new Error('benchmark corpus fixture paths must be unique');
  return { version: BENCHMARK_VERSION, fixtures };
}

function sourceLines(content: string): { readonly lines: readonly string[]; readonly finalNewline: boolean } {
  const finalNewline = content.endsWith('\n');
  return {
    lines: (finalNewline ? content.slice(0, -1) : content).split('\n'),
    finalNewline,
  };
}

function applyFixtureDiff(file: FixtureFile): ChangedLines {
  const base = sourceLines(file.base);
  const head = sourceLines(file.head);
  if (base.finalNewline !== head.finalNewline) {
    throw new Error(`benchmark fixture file ${file.path} changes final-newline state, which v1 does not support`);
  }
  const output: string[] = [];
  let baseCursor = 0;
  let foundHunk = false;
  const diffLines = file.diff.split('\n');
  for (let index = 0; index < diffLines.length; index += 1) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(diffLines[index] ?? '');
    if (header === null) continue;
    foundHunk = true;
    const oldStart = Number.parseInt(header[1] as string, 10);
    const oldCount = header[2] === undefined ? 1 : Number.parseInt(header[2], 10);
    const newCount = header[4] === undefined ? 1 : Number.parseInt(header[4], 10);
    const targetCursor = oldStart === 0 ? 0 : oldStart - 1;
    if (targetCursor < baseCursor || targetCursor > base.lines.length) {
      throw new Error(`benchmark fixture file ${file.path} contains an invalid or overlapping hunk`);
    }
    output.push(...base.lines.slice(baseCursor, targetCursor));
    baseCursor = targetCursor;
    let consumedOld = 0;
    let producedNew = 0;
    while (index + 1 < diffLines.length) {
      const candidate = diffLines[index + 1] ?? '';
      if (candidate.startsWith('@@ ')) break;
      const marker = candidate[0];
      if (marker !== ' ' && marker !== '-' && marker !== '+' && marker !== '\\') break;
      index += 1;
      if (marker === '\\') continue;
      const content = candidate.slice(1);
      if (marker === ' ' || marker === '-') {
        if (base.lines[baseCursor] !== content) {
          throw new Error(`benchmark fixture file ${file.path} diff does not match its base source`);
        }
        baseCursor += 1;
        consumedOld += 1;
      }
      if (marker === ' ' || marker === '+') {
        output.push(content);
        producedNew += 1;
      }
    }
    if (consumedOld !== oldCount || producedNew !== newCount) {
      throw new Error(`benchmark fixture file ${file.path} hunk counts do not match its contents`);
    }
  }
  if (!foundHunk) throw new Error(`benchmark fixture file ${file.path} diff contains no hunks`);
  output.push(...base.lines.slice(baseCursor));
  if (JSON.stringify(output) !== JSON.stringify(head.lines)) {
    throw new Error(`benchmark fixture file ${file.path} diff does not produce its head source`);
  }
  return parseChangedLines(file.diff, file.path);
}

async function readCheckedJson(root: string, relativePath: string): Promise<unknown> {
  const candidate = resolve(root, ...relativePath.split('/'));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`benchmark corpus path escapes its root: ${relativePath}`);
  }
  const actual = await realpath(candidate);
  if (actual !== candidate) throw new Error(`benchmark corpus path must not use symbolic links: ${relativePath}`);
  const metadata = await lstat(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`benchmark corpus path is not a regular file: ${relativePath}`);
  }
  return JSON.parse(await readFile(candidate, 'utf8')) as unknown;
}

class RecordedExecutor implements HarnessExecutor {
  readonly harness = 'echo' as const;
  readonly #responses: readonly RecordedResponse[];
  #index = 0;
  promptBytes = 0;

  constructor(responses: readonly RecordedResponse[]) {
    this.#responses = responses;
  }

  async prepare(settings: HarnessSettings): Promise<PreparedHarness> {
    return { harness: this.harness, model: settings.model, description: 'recorded benchmark responses' };
  }

  async execute(_prepared: PreparedHarness, prompt: HarnessPrompt): Promise<HarnessRun> {
    const response = this.#responses[this.#index++];
    if (response === undefined) throw new Error('recorded benchmark executor ran out of responses');
    this.promptBytes += Buffer.byteLength(prompt.system, 'utf8') + Buffer.byteLength(prompt.user, 'utf8');
    return {
      status: 'succeeded',
      harness: this.harness,
      exitCode: 0,
      text: JSON.stringify(response.document),
      diagnostic: '',
      durationMs: response.durationMs,
    };
  }
}

async function writeFixtureFile(root: string, path: string, content: string): Promise<void> {
  const destination = join(root, ...path.split('/'));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
}

async function materializeFixture(fixture: BenchmarkFixture, root: string): Promise<{ review: string; source: string; output: string }> {
  const review = join(root, 'review');
  const source = join(root, 'source');
  const output = join(root, 'output');
  await mkdir(join(review, 'diffs'), { recursive: true });
  await mkdir(join(review, 'base-files'), { recursive: true });
  await mkdir(source, { recursive: true });
  const manifestFiles = [];
  for (const file of fixture.files) {
    const diffFile = `diffs/${file.id}.diff`;
    const baseFile = `base-files/${file.id}`;
    await writeFixtureFile(review, diffFile, file.diff);
    await writeFixtureFile(review, baseFile, file.base);
    await writeFixtureFile(source, file.path, file.head);
    manifestFiles.push({
      id: file.id,
      status: file.status,
      oldPath: file.path,
      newPath: file.path,
      similarity: null,
      additions: file.diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
      deletions: file.diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
      binary: false,
      reviewed: true,
      diffFile,
      baseFile,
    });
  }
  for (const [path, content] of Object.entries(fixture.additionalHeadFiles)) {
    await writeFixtureFile(source, path, content);
  }
  await writeFile(join(review, 'manifest.json'), `${JSON.stringify({
    version: 1,
    base: fixture.baseRevision,
    head: fixture.headRevision,
    files: manifestFiles,
  }, null, 2)}\n`);
  await writeFile(join(review, 'revisions.txt'), `base=${fixture.baseRevision}\nhead=${fixture.headRevision}\n`);
  return { review, source, output };
}

function coverage(records: readonly FileReviewRecord[]): CoverageStatus {
  const omitted = records.filter((item) => item.outcome === 'omitted').length;
  if (omitted === 0) return 'complete';
  return omitted === records.length ? 'unavailable' : 'partial';
}

function findingKey(fileId: string, findingIndex: number): string {
  return `${fileId}:${findingIndex}`;
}

function locationMatches(record: FileReviewRecord, findingIndex: number, issue: ExpectedIssue): boolean {
  const finding = record.findings[findingIndex];
  if (finding === undefined) return false;
  return issue.locations.some((location) =>
    location.path === record.path
    && location.side === finding.side
    && finding.startLine >= location.startLine
    && finding.endLine <= location.endLine);
}

export function scoreBenchmarkCase(
  fixture: BenchmarkFixture,
  recording: FixtureRecording,
  records: readonly FileReviewRecord[],
  promptBytes: number,
): BenchmarkCaseResult {
  const recordsById = new Map(records.map((item) => [item.fileId, item]));
  const findings = records.reduce((total, item) => total + item.findings.length, 0);
  const judgments = new Map<string, FindingJudgment>();
  for (const judgment of recording.judgments) {
    const key = findingKey(judgment.fileId, judgment.findingIndex);
    if (judgments.has(key)) throw new Error(`benchmark fixture ${fixture.id} contains duplicate judgment ${key}`);
    judgments.set(key, judgment);
  }
  const expectedById = new Map(fixture.expectedIssues.map((issue) => [issue.id, issue]));
  const matched = new Set<string>();
  const credited = new Set<string>();
  let falsePositives = 0;
  let duplicateFindings = 0;
  let claimedMatches = 0;
  let validEvidenceMatches = 0;
  for (const recordValue of records) {
    recordValue.findings.forEach((_finding, findingIndex) => {
      const key = findingKey(recordValue.fileId, findingIndex);
      const judgment = judgments.get(key);
      if (judgment === undefined) throw new Error(`benchmark fixture ${fixture.id} has no judgment for finding ${key}`);
      if (judgment.expectedIssueId === null) {
        falsePositives += 1;
        return;
      }
      claimedMatches += 1;
      const issue = expectedById.get(judgment.expectedIssueId);
      if (issue === undefined) throw new Error(`benchmark fixture ${fixture.id} judgment references missing issue`);
      if (matched.has(issue.id)) duplicateFindings += 1;
      matched.add(issue.id);
      if (locationMatches(recordValue, findingIndex, issue)) {
        validEvidenceMatches += 1;
        credited.add(issue.id);
      }
    });
  }
  for (const judgment of recording.judgments) {
    const recordValue = recordsById.get(judgment.fileId);
    if (recordValue === undefined || recordValue.findings[judgment.findingIndex] === undefined) {
      throw new Error(`benchmark fixture ${fixture.id} judgment references missing finding ${findingKey(judgment.fileId, judgment.findingIndex)}`);
    }
  }
  const issueIds = fixture.expectedIssues.map((issue) => issue.id);
  return {
    fixtureId: fixture.id,
    title: fixture.title,
    kind: fixture.kind,
    coverage: coverage(records),
    expectedIssues: fixture.expectedIssues.length,
    rootCauseMatches: matched.size,
    creditedIssues: credited.size,
    unmatchedIssueIds: issueIds.filter((id) => !matched.has(id)),
    uncreditedIssueIds: issueIds.filter((id) => !credited.has(id)),
    findings,
    falsePositives,
    duplicateFindings,
    claimedMatches,
    validEvidenceMatches,
    promptBytes,
    reviewDurationMs: records.reduce((total, item) => total + item.durationMs, 0),
  };
}

async function runRecording(fixture: BenchmarkFixture, recording: FixtureRecording): Promise<BenchmarkCaseResult> {
  const root = await mkdtemp(join(tmpdir(), `redline-benchmark-${fixture.id}-`));
  try {
    const paths = await materializeFixture(fixture, root);
    const executor = new RecordedExecutor(recording.responses);
    const environment: ReviewEnvironment = {
      harness: 'echo',
      reviewDirectory: paths.review,
      sourceDirectory: paths.source,
      outputDirectory: paths.output,
      codeContext: undefined,
      model: { provider: 'benchmark', endpoint: 'http://127.0.0.1', model: 'recorded', auth: 'none' },
      credential: undefined,
      findingScope: 'defects',
      timeout: parseDuration('1m'),
    };
    const result = await runFileReviews({ environment, executor });
    return scoreBenchmarkCase(fixture, recording, result.records, executor.promptBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function aggregateMode(mode: BenchmarkMode, cases: readonly BenchmarkCaseResult[]): BenchmarkModeResult {
  return {
    mode,
    fixtures: cases.length,
    expectedIssues: cases.reduce((total, item) => total + item.expectedIssues, 0),
    rootCauseMatches: cases.reduce((total, item) => total + item.rootCauseMatches, 0),
    creditedIssues: cases.reduce((total, item) => total + item.creditedIssues, 0),
    findings: cases.reduce((total, item) => total + item.findings, 0),
    falsePositives: cases.reduce((total, item) => total + item.falsePositives, 0),
    duplicateFindings: cases.reduce((total, item) => total + item.duplicateFindings, 0),
    cleanFixtures: cases.filter((item) => item.kind === 'clean').length,
    cleanFixturesWithFalsePositives: cases.filter((item) => item.kind === 'clean' && item.falsePositives > 0).length,
    claimedMatches: cases.reduce((total, item) => total + item.claimedMatches, 0),
    validEvidenceMatches: cases.reduce((total, item) => total + item.validEvidenceMatches, 0),
    promptBytes: cases.reduce((total, item) => total + item.promptBytes, 0),
    reviewDurationMs: cases.reduce((total, item) => total + item.reviewDurationMs, 0),
    cases,
  };
}

export async function runRecordedBenchmark(corpusDirectory: string): Promise<BenchmarkReport> {
  const requestedRoot = resolve(corpusDirectory);
  const rootMetadata = await lstat(requestedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('benchmark corpus root must be a regular directory');
  }
  const root = await realpath(requestedRoot);
  if (root !== requestedRoot) throw new Error('benchmark corpus root must not use symbolic links');
  const corpus = parseCorpus(await readCheckedJson(root, 'corpus.json'));
  const fixtures: BenchmarkFixture[] = [];
  for (const fixturePath of corpus.fixtures) {
    fixtures.push(parseBenchmarkFixture(await readCheckedJson(root, fixturePath)));
  }
  const ids = new Set(fixtures.map((fixture) => fixture.id));
  if (ids.size !== fixtures.length) throw new Error('benchmark fixture IDs must be unique across the corpus');
  const casesByMode = new Map<BenchmarkMode, BenchmarkCaseResult[]>();
  for (const fixture of fixtures) {
    for (const recording of fixture.recordings) {
      const results = casesByMode.get(recording.mode) ?? [];
      results.push(await runRecording(fixture, recording));
      casesByMode.set(recording.mode, results);
    }
  }
  const modes = MODES
    .filter((mode) => casesByMode.has(mode))
    .map((mode) => aggregateMode(mode, casesByMode.get(mode) ?? []));
  return { version: BENCHMARK_VERSION, corpusVersion: corpus.version, modes };
}

function fraction(numerator: number, denominator: number): string {
  const percentage = denominator === 0 ? 'n/a' : `${((numerator / denominator) * 100).toFixed(1)}%`;
  return `${numerator}/${denominator} (${percentage})`;
}

export function renderBenchmarkMarkdown(report: BenchmarkReport): string {
  const lines = ['# Review-quality benchmark', ''];
  for (const mode of report.modes) {
    lines.push(
      `## ${mode.mode}`,
      '',
      `- Fixtures: ${mode.fixtures}`,
      `- Root-cause recall: ${fraction(mode.rootCauseMatches, mode.expectedIssues)}`,
      `- Credited issue recall: ${fraction(mode.creditedIssues, mode.expectedIssues)}`,
      `- False positives: ${mode.falsePositives}`,
      `- Duplicate findings: ${mode.duplicateFindings}`,
      `- Clean fixtures with false positives: ${fraction(mode.cleanFixturesWithFalsePositives, mode.cleanFixtures)}`,
      `- Evidence accuracy for claimed matches: ${fraction(mode.validEvidenceMatches, mode.claimedMatches)}`,
      `- Total prompt: ${mode.promptBytes} bytes`,
      `- Recorded review duration: ${mode.reviewDurationMs} ms`,
      '',
      '| Fixture | Kind | Coverage | Expected | Root matches | Credited | Findings | False positives | Duplicates | Prompt bytes | Duration ms |',
      '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const item of mode.cases) {
      lines.push(`| ${item.fixtureId} | ${item.kind} | ${item.coverage} | ${item.expectedIssues} | ${item.rootCauseMatches} | ${item.creditedIssues} | ${item.findings} | ${item.falsePositives} | ${item.duplicateFindings} | ${item.promptBytes} | ${item.reviewDurationMs} |`);
    }
    lines.push('');
  }
  lines.push(
    '## Interpretation',
    '',
    'This report evaluates checked-in responses and human judgments. It verifies the fixture, scoring, and reporting contracts without measuring a live model or code indexer.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

export async function writeBenchmarkReport(report: BenchmarkReport, outputDirectory: string): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(outputDirectory, 'report.md'), renderBenchmarkMarkdown(report));
}
