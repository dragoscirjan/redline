import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runVerificationBenchmark } from './verification-benchmark.ts';

const root = resolve('benchmark/review-quality');
const extension = resolve(root, 'verification-v1');
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--output')) {
  throw new Error('usage: verification-cli [--output <report.json>]');
}
const report = await runVerificationBenchmark(
  resolve(root, 'v2'), extension, resolve(extension, 'dispositions.json'),
);
for (const mode of ['file-only', 'indexed-context'] as const) {
  const cases = report.cases.filter((item) => item.mode === mode);
  const sum = (key: 'creditedIssues' | 'falsePositives' | 'reviewDurationMs', stage: 'discovery' | 'verified'): number =>
    cases.reduce((total, item) => total + item[stage][key], 0);
  console.log(`${mode}: credited ${sum('creditedIssues', 'discovery')}→${sum('creditedIssues', 'verified')}; `
    + `false positives ${sum('falsePositives', 'discovery')}→${sum('falsePositives', 'verified')}; `
    + `recorded duration ${sum('reviewDurationMs', 'discovery')}→${sum('reviewDurationMs', 'verified')} ms`);
}
console.log(`Scripted pipeline gate: ${report.gate.passedOnScriptedRecordings ? 'pass' : 'fail'}; `
  + `production activation: blocked (${report.gate.activationReason})`);
if (args.length === 2) await writeFile(resolve(args[1] as string), `${JSON.stringify(report, null, 2)}\n`);
if (!report.gate.passedOnScriptedRecordings) process.exitCode = 1;
