import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const CODE_INDEX_VALUE_REPORT_VERSION = 1 as const;

export interface Distribution {
  readonly samples: number;
  readonly minimum: number;
  readonly p50NearestRank: number;
  readonly p95NearestRank: number;
  readonly maximum: number;
}

interface TimingObservation {
  readonly installationMs: number;
  readonly restoreMs: number;
  readonly validationMs: number;
  readonly indexMs: number;
  readonly queryMs: number;
}

interface ProviderObservation {
  readonly condition: 'cold' | 'warm';
  readonly sample: number;
  readonly status: 'complete' | 'partial' | 'unsupported' | 'unavailable';
  readonly files: number;
  readonly supportedFiles: number;
  readonly filesWithRelatedSpans: number;
  readonly relatedSpans: number;
  readonly sourceBytes: number;
  readonly timings: TimingObservation;
  readonly diagnostics: readonly string[];
  readonly wallMs: number;
  readonly cacheSizeBytes: number;
}

interface ProviderCapture {
  readonly version: string;
  readonly license: {
    readonly id: string;
    readonly commercialUse: string;
    readonly url: string;
  };
  readonly distribution: string;
  readonly observations: readonly ProviderObservation[];
}

interface RepositoryClassCapture {
  readonly id: string;
  readonly kind: 'synthetic' | 'real';
  readonly description: string;
  readonly base: string;
  readonly head: string;
  readonly changedPaths: readonly string[];
  readonly samples: Readonly<Record<'cgc' | 'gitnexus', ProviderCapture>>;
}

interface ProductionWarmup {
  readonly source: string;
  readonly revision: string;
  readonly indexMs: number;
  readonly durationMs: number;
  readonly cacheSizeBytes: number;
  readonly result: string;
}

interface QualityEvidence {
  readonly source: string;
  readonly expectedIssues: number;
  readonly fileOnlyCreditedIssues: number;
  readonly indexedCreditedIssues: number;
  readonly fileOnlyFalsePositives: number;
  readonly indexedFalsePositives: number;
  readonly promptBytesAdded: number;
  readonly sourceBytesAdded: number;
  readonly interpretation: string;
}

interface ColdSkipEvidence {
  readonly coveredBy: string;
  readonly diagnostics: readonly string[];
  readonly indexMs: number;
}

interface CodeIndexValueCapture {
  readonly version: 1;
  readonly capturedAt: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly repositoryClasses: readonly RepositoryClassCapture[];
  readonly productionWarmups: Readonly<Record<'cgc' | 'gitnexus', readonly ProductionWarmup[]>>;
  readonly followUp: {
    readonly fixture: string;
    readonly capability: string;
    readonly direction: string;
    readonly providers: Readonly<Record<'cgc' | 'gitnexus', {
      readonly samplesMs: readonly number[];
      readonly source: string;
      readonly status: string;
      readonly sourceConfirmedSpans: number;
    }>>;
  };
  readonly quality: {
    readonly recordedComparison: QualityEvidence;
    readonly liveModel: QualityEvidence;
  };
  readonly coldSkip: {
    readonly unsupportedOnly: ColdSkipEvidence;
    readonly allHeadNewSupported: ColdSkipEvidence;
  };
  readonly recommendation: {
    readonly defaultProvider: 'cgc' | 'gitnexus';
    readonly changeDefault: boolean;
    readonly enableVerification: boolean;
    readonly reason: string;
  };
}

export interface ConditionReport {
  readonly condition: 'cold' | 'warm';
  readonly samples: number;
  readonly statuses: Readonly<Record<'complete' | 'partial' | 'unsupported' | 'unavailable', number>>;
  readonly cacheHits: number;
  readonly cacheHitRate: number;
  readonly supportedFiles: Distribution;
  readonly filesWithRelatedSpans: Distribution;
  readonly relatedSpans: Distribution;
  readonly sourceBytes: Distribution;
  readonly installationMs: Distribution;
  readonly restoreMs: Distribution;
  readonly validationMs: Distribution;
  readonly indexMs: Distribution;
  readonly queryMs: Distribution;
  readonly wallMs: Distribution;
  readonly cacheSizeBytes: Distribution;
  readonly diagnostics: Readonly<Record<string, number>>;
}

export interface ProviderClassReport {
  readonly id: 'cgc' | 'gitnexus';
  readonly version: string;
  readonly license: ProviderCapture['license'];
  readonly distribution: string;
  readonly conditions: readonly ConditionReport[];
  readonly warmIndexP95SavedMs: number;
  readonly warmWallP95SavedMs: number;
}

export interface CodeIndexValueReport {
  readonly version: typeof CODE_INDEX_VALUE_REPORT_VERSION;
  readonly captureVersion: 1;
  readonly capturedAt: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly repositoryClasses: readonly {
    readonly id: string;
    readonly kind: 'synthetic' | 'real';
    readonly description: string;
    readonly changedPaths: readonly string[];
    readonly providers: readonly ProviderClassReport[];
  }[];
  readonly productionWarmups: readonly {
    readonly id: 'cgc' | 'gitnexus';
    readonly samples: number;
    readonly indexMs: Distribution;
    readonly durationMs: Distribution;
    readonly cacheSizeBytes: Distribution;
    readonly sources: readonly string[];
  }[];
  readonly followUp: {
    readonly fixture: string;
    readonly capability: string;
    readonly direction: string;
    readonly providers: readonly {
      readonly id: 'cgc' | 'gitnexus';
      readonly status: string;
      readonly sourceConfirmedSpans: number;
      readonly latencyMs: Distribution;
      readonly source: string;
    }[];
  };
  readonly quality: CodeIndexValueCapture['quality'];
  readonly coldSkip: CodeIndexValueCapture['coldSkip'];
  readonly recommendation: CodeIndexValueCapture['recommendation'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function parseObservation(value: unknown, label: string): ProviderObservation {
  const input = record(value, label);
  const condition = input['condition'];
  if (condition !== 'cold' && condition !== 'warm') throw new Error(`${label}.condition is unsupported`);
  const status = input['status'];
  if (status !== 'complete' && status !== 'partial' && status !== 'unsupported' && status !== 'unavailable') {
    throw new Error(`${label}.status is unsupported`);
  }
  const timings = record(input['timings'], `${label}.timings`);
  const diagnostics = input['diagnostics'];
  if (!Array.isArray(diagnostics) || diagnostics.some((item) => typeof item !== 'string')) {
    throw new Error(`${label}.diagnostics must be a string array`);
  }
  return {
    condition,
    sample: integer(input['sample'], `${label}.sample`),
    status,
    files: integer(input['files'], `${label}.files`),
    supportedFiles: integer(input['supportedFiles'], `${label}.supportedFiles`),
    filesWithRelatedSpans: integer(input['filesWithRelatedSpans'], `${label}.filesWithRelatedSpans`),
    relatedSpans: integer(input['relatedSpans'], `${label}.relatedSpans`),
    sourceBytes: integer(input['sourceBytes'], `${label}.sourceBytes`),
    timings: {
      installationMs: integer(timings['installationMs'], `${label}.timings.installationMs`),
      restoreMs: integer(timings['restoreMs'], `${label}.timings.restoreMs`),
      validationMs: integer(timings['validationMs'], `${label}.timings.validationMs`),
      indexMs: integer(timings['indexMs'], `${label}.timings.indexMs`),
      queryMs: integer(timings['queryMs'], `${label}.timings.queryMs`),
    },
    diagnostics: diagnostics as string[],
    wallMs: integer(input['wallMs'], `${label}.wallMs`),
    cacheSizeBytes: integer(input['cacheSizeBytes'], `${label}.cacheSizeBytes`),
  };
}

function parseProvider(value: unknown, label: string): ProviderCapture {
  const input = record(value, label);
  const license = record(input['license'], `${label}.license`);
  const observations = input['observations'];
  if (!Array.isArray(observations) || observations.length === 0 || observations.length > 40) {
    throw new Error(`${label}.observations must contain 1 through 40 samples`);
  }
  return {
    version: text(input['version'], `${label}.version`),
    license: {
      id: text(license['id'], `${label}.license.id`),
      commercialUse: text(license['commercialUse'], `${label}.license.commercialUse`),
      url: text(license['url'], `${label}.license.url`),
    },
    distribution: text(input['distribution'], `${label}.distribution`),
    observations: observations.map((item, index) => parseObservation(item, `${label}.observations[${index}]`)),
  };
}

function stringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  const input = record(value, label);
  for (const [key, item] of Object.entries(input)) text(item, `${label}.${key}`);
  return input as Record<string, string>;
}

function parseWarmups(value: unknown, label: string): readonly ProductionWarmup[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error(`${label} must contain 1 through 20 samples`);
  }
  return value.map((item, index) => {
    const sampleLabel = `${label}[${index}]`;
    const input = record(item, sampleLabel);
    const result = text(input['result'], `${sampleLabel}.result`);
    if (result !== 'saved') throw new Error(`${sampleLabel}.result must be saved`);
    return {
      source: text(input['source'], `${sampleLabel}.source`),
      revision: text(input['revision'], `${sampleLabel}.revision`),
      indexMs: integer(input['indexMs'], `${sampleLabel}.indexMs`),
      durationMs: integer(input['durationMs'], `${sampleLabel}.durationMs`),
      cacheSizeBytes: integer(input['cacheSizeBytes'], `${sampleLabel}.cacheSizeBytes`),
      result,
    };
  });
}

function parseFollowUpProvider(value: unknown, label: string): CodeIndexValueCapture['followUp']['providers']['cgc'] {
  const input = record(value, label);
  const samples = input['samplesMs'];
  if (!Array.isArray(samples) || samples.length === 0 || samples.length > 20) {
    throw new Error(`${label}.samplesMs must contain 1 through 20 samples`);
  }
  return {
    samplesMs: samples.map((item, index) => integer(item, `${label}.samplesMs[${index}]`)),
    source: text(input['source'], `${label}.source`),
    status: text(input['status'], `${label}.status`),
    sourceConfirmedSpans: integer(input['sourceConfirmedSpans'], `${label}.sourceConfirmedSpans`),
  };
}

function parseQualityEvidence(value: unknown, label: string): QualityEvidence {
  const input = record(value, label);
  return {
    source: text(input['source'], `${label}.source`),
    expectedIssues: integer(input['expectedIssues'], `${label}.expectedIssues`),
    fileOnlyCreditedIssues: integer(input['fileOnlyCreditedIssues'], `${label}.fileOnlyCreditedIssues`),
    indexedCreditedIssues: integer(input['indexedCreditedIssues'], `${label}.indexedCreditedIssues`),
    fileOnlyFalsePositives: integer(input['fileOnlyFalsePositives'], `${label}.fileOnlyFalsePositives`),
    indexedFalsePositives: integer(input['indexedFalsePositives'], `${label}.indexedFalsePositives`),
    promptBytesAdded: integer(input['promptBytesAdded'], `${label}.promptBytesAdded`),
    sourceBytesAdded: integer(input['sourceBytesAdded'], `${label}.sourceBytesAdded`),
    interpretation: text(input['interpretation'], `${label}.interpretation`),
  };
}

function parseColdSkip(value: unknown, label: string): ColdSkipEvidence {
  const input = record(value, label);
  const diagnostics = input['diagnostics'];
  if (!Array.isArray(diagnostics) || diagnostics.length === 0 || diagnostics.some((item) => typeof item !== 'string')) {
    throw new Error(`${label}.diagnostics must be a non-empty string array`);
  }
  return {
    coveredBy: text(input['coveredBy'], `${label}.coveredBy`),
    diagnostics: diagnostics as string[],
    indexMs: integer(input['indexMs'], `${label}.indexMs`),
  };
}

function parseCapture(value: unknown): CodeIndexValueCapture {
  const input = record(value, 'code-index value capture');
  if (input['version'] !== 1) throw new Error('code-index value capture version must be 1');
  const classes = input['repositoryClasses'];
  if (!Array.isArray(classes) || classes.length < 2 || classes.length > 8) {
    throw new Error('code-index value capture must contain 2 through 8 repository classes');
  }
  const repositoryClasses = classes.map((item, index): RepositoryClassCapture => {
    const label = `code-index value capture.repositoryClasses[${index}]`;
    const itemRecord = record(item, label);
    const kind = itemRecord['kind'];
    if (kind !== 'synthetic' && kind !== 'real') throw new Error(`${label}.kind is unsupported`);
    const paths = itemRecord['changedPaths'];
    if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== 'string')) {
      throw new Error(`${label}.changedPaths must be a non-empty string array`);
    }
    const samples = record(itemRecord['samples'], `${label}.samples`);
    return {
      id: text(itemRecord['id'], `${label}.id`),
      kind,
      description: text(itemRecord['description'], `${label}.description`),
      base: text(itemRecord['base'], `${label}.base`),
      head: text(itemRecord['head'], `${label}.head`),
      changedPaths: paths as string[],
      samples: {
        cgc: parseProvider(samples['cgc'], `${label}.samples.cgc`),
        gitnexus: parseProvider(samples['gitnexus'], `${label}.samples.gitnexus`),
      },
    };
  });
  const warmups = record(input['productionWarmups'], 'code-index value capture.productionWarmups');
  const followUp = record(input['followUp'], 'code-index value capture.followUp');
  const followUpProviders = record(followUp['providers'], 'code-index value capture.followUp.providers');
  const quality = record(input['quality'], 'code-index value capture.quality');
  const coldSkip = record(input['coldSkip'], 'code-index value capture.coldSkip');
  const recommendation = record(input['recommendation'], 'code-index value capture.recommendation');
  const defaultProvider = recommendation['defaultProvider'];
  if (defaultProvider !== 'cgc' && defaultProvider !== 'gitnexus') {
    throw new Error('code-index value capture.recommendation.defaultProvider is unsupported');
  }
  if (typeof recommendation['changeDefault'] !== 'boolean' || typeof recommendation['enableVerification'] !== 'boolean') {
    throw new Error('code-index value capture recommendation flags must be boolean');
  }
  return {
    version: 1,
    capturedAt: text(input['capturedAt'], 'code-index value capture.capturedAt'),
    environment: stringRecord(input['environment'], 'code-index value capture.environment'),
    repositoryClasses,
    productionWarmups: {
      cgc: parseWarmups(warmups['cgc'], 'code-index value capture.productionWarmups.cgc'),
      gitnexus: parseWarmups(warmups['gitnexus'], 'code-index value capture.productionWarmups.gitnexus'),
    },
    followUp: {
      fixture: text(followUp['fixture'], 'code-index value capture.followUp.fixture'),
      capability: text(followUp['capability'], 'code-index value capture.followUp.capability'),
      direction: text(followUp['direction'], 'code-index value capture.followUp.direction'),
      providers: {
        cgc: parseFollowUpProvider(followUpProviders['cgc'], 'code-index value capture.followUp.providers.cgc'),
        gitnexus: parseFollowUpProvider(
          followUpProviders['gitnexus'],
          'code-index value capture.followUp.providers.gitnexus',
        ),
      },
    },
    quality: {
      recordedComparison: parseQualityEvidence(
        quality['recordedComparison'],
        'code-index value capture.quality.recordedComparison',
      ),
      liveModel: parseQualityEvidence(quality['liveModel'], 'code-index value capture.quality.liveModel'),
    },
    coldSkip: {
      unsupportedOnly: parseColdSkip(coldSkip['unsupportedOnly'], 'code-index value capture.coldSkip.unsupportedOnly'),
      allHeadNewSupported: parseColdSkip(
        coldSkip['allHeadNewSupported'],
        'code-index value capture.coldSkip.allHeadNewSupported',
      ),
    },
    recommendation: {
      defaultProvider,
      changeDefault: recommendation['changeDefault'],
      enableVerification: recommendation['enableVerification'],
      reason: text(recommendation['reason'], 'code-index value capture.recommendation.reason'),
    },
  };
}

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) throw new Error('distribution requires at least one sample');
  const sorted = [...values].sort((left, right) => left - right);
  const nearestRank = (percentile: number): number => sorted[Math.ceil(percentile * sorted.length) - 1] as number;
  return {
    samples: sorted.length,
    minimum: sorted[0] as number,
    p50NearestRank: nearestRank(0.5),
    p95NearestRank: nearestRank(0.95),
    maximum: sorted.at(-1) as number,
  };
}

function conditionReport(condition: 'cold' | 'warm', observations: readonly ProviderObservation[]): ConditionReport {
  const selected = observations.filter((item) => item.condition === condition);
  if (selected.length === 0) throw new Error(`provider capture lacks ${condition} observations`);
  const statuses = {
    complete: selected.filter((item) => item.status === 'complete').length,
    partial: selected.filter((item) => item.status === 'partial').length,
    unsupported: selected.filter((item) => item.status === 'unsupported').length,
    unavailable: selected.filter((item) => item.status === 'unavailable').length,
  };
  const diagnostics = new Map<string, number>();
  for (const item of selected) {
    for (const code of item.diagnostics) diagnostics.set(code, (diagnostics.get(code) ?? 0) + 1);
  }
  return {
    condition,
    samples: selected.length,
    statuses,
    cacheHits: selected.filter((item) => item.diagnostics.includes('cache-base-revision')).length,
    cacheHitRate: selected.filter((item) => item.diagnostics.includes('cache-base-revision')).length / selected.length,
    supportedFiles: distribution(selected.map((item) => item.supportedFiles)),
    filesWithRelatedSpans: distribution(selected.map((item) => item.filesWithRelatedSpans)),
    relatedSpans: distribution(selected.map((item) => item.relatedSpans)),
    sourceBytes: distribution(selected.map((item) => item.sourceBytes)),
    installationMs: distribution(selected.map((item) => item.timings.installationMs)),
    restoreMs: distribution(selected.map((item) => item.timings.restoreMs)),
    validationMs: distribution(selected.map((item) => item.timings.validationMs)),
    indexMs: distribution(selected.map((item) => item.timings.indexMs)),
    queryMs: distribution(selected.map((item) => item.timings.queryMs)),
    wallMs: distribution(selected.map((item) => item.wallMs)),
    cacheSizeBytes: distribution(selected.map((item) => item.cacheSizeBytes)),
    diagnostics: Object.fromEntries([...diagnostics].sort(([left], [right]) => left.localeCompare(right))),
  };
}

function providerReport(id: 'cgc' | 'gitnexus', capture: ProviderCapture): ProviderClassReport {
  const cold = conditionReport('cold', capture.observations);
  const warm = conditionReport('warm', capture.observations);
  return {
    id,
    version: capture.version,
    license: capture.license,
    distribution: capture.distribution,
    conditions: [cold, warm],
    warmIndexP95SavedMs: cold.indexMs.p95NearestRank - warm.indexMs.p95NearestRank,
    warmWallP95SavedMs: cold.wallMs.p95NearestRank - warm.wallMs.p95NearestRank,
  };
}

export function buildCodeIndexValueReport(value: unknown): CodeIndexValueReport {
  const capture = parseCapture(value);
  const productionWarmups = (['cgc', 'gitnexus'] as const).map((id) => {
    const samples = capture.productionWarmups[id];
    if (!Array.isArray(samples) || samples.length === 0) throw new Error(`production warmups lack ${id} samples`);
    return {
      id,
      samples: samples.length,
      indexMs: distribution(samples.map((item) => integer(item.indexMs, `${id}.indexMs`))),
      durationMs: distribution(samples.map((item) => integer(item.durationMs, `${id}.durationMs`))),
      cacheSizeBytes: distribution(samples.map((item) => integer(item.cacheSizeBytes, `${id}.cacheSizeBytes`))),
      sources: samples.map((item) => text(item.source, `${id}.source`)),
    };
  });
  const followUp = (['cgc', 'gitnexus'] as const).map((id) => {
    const provider = capture.followUp.providers[id];
    return {
      id,
      status: provider.status,
      sourceConfirmedSpans: provider.sourceConfirmedSpans,
      latencyMs: distribution(provider.samplesMs),
      source: provider.source,
    };
  });
  return {
    version: CODE_INDEX_VALUE_REPORT_VERSION,
    captureVersion: 1,
    capturedAt: capture.capturedAt,
    environment: capture.environment,
    repositoryClasses: capture.repositoryClasses.map((item) => ({
      id: item.id,
      kind: item.kind,
      description: item.description,
      changedPaths: item.changedPaths,
      providers: [providerReport('cgc', item.samples.cgc), providerReport('gitnexus', item.samples.gitnexus)],
    })),
    productionWarmups,
    followUp: {
      fixture: capture.followUp.fixture,
      capability: capture.followUp.capability,
      direction: capture.followUp.direction,
      providers: followUp,
    },
    quality: capture.quality,
    coldSkip: capture.coldSkip,
    recommendation: capture.recommendation,
  };
}

function statusText(statuses: ConditionReport['statuses']): string {
  return `complete ${statuses.complete}, partial ${statuses.partial}, unsupported ${statuses.unsupported}, unavailable ${statuses.unavailable}`;
}

export function renderCodeIndexValueMarkdown(report: CodeIndexValueReport): string {
  const localConditions = report.repositoryClasses.flatMap((item) => item.providers.flatMap((provider) => provider.conditions));
  const localSampleCounts = [...new Set(localConditions.map((item) => item.samples))].sort((left, right) => left - right);
  const localSampleText = localSampleCounts.length === 1
    ? `${localSampleCounts[0] === 3 ? 'three' : localSampleCounts[0]} runs`
    : `${localSampleCounts.join('/')} runs`;
  const cgcConditions = report.repositoryClasses.flatMap((item) =>
    item.providers.filter((provider) => provider.id === 'cgc').flatMap((provider) => provider.conditions));
  const cgcSamples = cgcConditions.reduce((total, item) => total + item.samples, 0);
  const cgcPartial = cgcConditions.reduce((total, item) => total + item.statuses.partial, 0);
  const cgcMaximumSpans = Math.max(...cgcConditions.map((item) => item.relatedSpans.maximum));
  const cgcDiagnostics = new Map<string, number>();
  for (const condition of cgcConditions) {
    for (const [code, count] of Object.entries(condition.diagnostics)) {
      cgcDiagnostics.set(code, (cgcDiagnostics.get(code) ?? 0) + count);
    }
  }
  const cgcDiagnosticText = [...cgcDiagnostics]
    .map(([code, count]) => `${code} ${count}`)
    .join(', ') || 'none';
  const lines = [
    '# Code-index value and provider comparison',
    '',
    `Captured at ${report.capturedAt}. Percentiles use nearest rank. Each local cold/warm cell contains ${localSampleText}.`,
    '',
  ];
  for (const repositoryClass of report.repositoryClasses) {
    lines.push(`## ${repositoryClass.id}`, '', repositoryClass.description, '',
      '| Provider | Path | Statuses | Cache hits | Supported files p50/p95 | Files with spans p50/p95 | Spans p50/p95 | Source bytes p50/p95 | Install p50/p95 | Restore p50/p95 | Validate p50/p95 | Index p50/p95 | Query p50/p95 | Wall p50/p95 | Cache bytes p50/p95 |',
      '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const provider of repositoryClass.providers) {
      for (const condition of provider.conditions) {
        lines.push(`| ${provider.id} ${provider.version} | ${condition.condition} | ${statusText(condition.statuses)} | ${condition.cacheHits}/${condition.samples} | ${condition.supportedFiles.p50NearestRank}/${condition.supportedFiles.p95NearestRank} | ${condition.filesWithRelatedSpans.p50NearestRank}/${condition.filesWithRelatedSpans.p95NearestRank} | ${condition.relatedSpans.p50NearestRank}/${condition.relatedSpans.p95NearestRank} | ${condition.sourceBytes.p50NearestRank}/${condition.sourceBytes.p95NearestRank} | ${condition.installationMs.p50NearestRank}/${condition.installationMs.p95NearestRank} ms | ${condition.restoreMs.p50NearestRank}/${condition.restoreMs.p95NearestRank} ms | ${condition.validationMs.p50NearestRank}/${condition.validationMs.p95NearestRank} ms | ${condition.indexMs.p50NearestRank}/${condition.indexMs.p95NearestRank} ms | ${condition.queryMs.p50NearestRank}/${condition.queryMs.p95NearestRank} ms | ${condition.wallMs.p50NearestRank}/${condition.wallMs.p95NearestRank} ms | ${condition.cacheSizeBytes.p50NearestRank}/${condition.cacheSizeBytes.p95NearestRank} bytes |`);
      }
    }
    lines.push('', 'Warm exact-base restoration removed provider indexing in every valid restored sample.', '');
  }
  lines.push('## Production default-branch warmups', '',
    '| Provider | Runs | Index p50/p95 | Total p50/p95 | Cache p50/p95 |',
    '| --- | ---: | ---: | ---: | ---: |');
  for (const provider of report.productionWarmups) {
    lines.push(`| ${provider.id} | ${provider.samples} | ${provider.indexMs.p50NearestRank}/${provider.indexMs.p95NearestRank} ms | ${provider.durationMs.p50NearestRank}/${provider.durationMs.p95NearestRank} ms | ${provider.cacheSizeBytes.p50NearestRank}/${provider.cacheSizeBytes.p95NearestRank} bytes |`);
  }
  lines.push('', '## Bounded follow-up', '',
    '| Provider | Status | Source-confirmed spans | Latency p50/p95 |',
    '| --- | --- | ---: | ---: |');
  for (const provider of report.followUp.providers) {
    lines.push(`| ${provider.id} | ${provider.status} | ${provider.sourceConfirmedSpans} | ${provider.latencyMs.p50NearestRank}/${provider.latencyMs.p95NearestRank} ms |`);
  }
  const recorded = report.quality.recordedComparison;
  const live = report.quality.liveModel;
  lines.push('', '## Review-quality value', '',
    `- Recorded provider-neutral comparison: credited issues ${recorded.fileOnlyCreditedIssues} → ${recorded.indexedCreditedIssues}; false positives ${recorded.fileOnlyFalsePositives} → ${recorded.indexedFalsePositives}; +${recorded.promptBytesAdded} prompt bytes; +${recorded.sourceBytesAdded} source bytes.`,
    `- Historical live-model comparison: credited issues ${live.fileOnlyCreditedIssues} → ${live.indexedCreditedIssues}; false positives ${live.fileOnlyFalsePositives} → ${live.indexedFalsePositives}; +${live.promptBytesAdded} prompt bytes; +${live.sourceBytesAdded} source bytes.`,
    '- Provider capability, model quality, and latency are separate claims. The current live-model capture shows no quality gain.',
    '', '## Provider and policy decision', '',
    `- Default provider: ${report.recommendation.defaultProvider}; changed: ${report.recommendation.changeDefault ? 'yes' : 'no'}.`,
    `- Independent verification activation: ${report.recommendation.enableVerification ? 'enabled' : 'disabled'}.`,
    `- ${report.recommendation.reason}`,
    '', '## Limits', '',
    `- In this capture, local provider distributions contain ${localSampleText} per condition and repository class.`,
    '- Production warmups measure exact-base cache creation, not pull-request cache restoration.',
    '- GitNexus is PolyForm Noncommercial 1.0.0 licensed. Users must confirm that their use satisfies the license.',
    `- In this capture, CGC local samples were partial in ${cgcPartial}/${cgcSamples} runs, had at most ${cgcMaximumSpans} related spans, and recorded diagnostics: ${cgcDiagnosticText}.`,
    '- No indexed-repository code, build, package installer, or Git hook was executed during these measurements.',
    '');
  return lines.join('\n');
}

export async function writeCodeIndexValueReport(
  capturePath: string,
  jsonPath: string,
  markdownPath: string,
): Promise<CodeIndexValueReport> {
  const capture = JSON.parse(await readFile(capturePath, 'utf8')) as unknown;
  const report = buildCodeIndexValueReport(capture);
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    writeFile(markdownPath, `${renderCodeIndexValueMarkdown(report)}\n`),
  ]);
  return report;
}
