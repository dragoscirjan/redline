#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { generateReviewEligibilityReport } from './review-eligibility.ts';

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (args.length !== 3) {
    process.stderr.write('Usage: review-eligibility-cli <capture.json> <report.json> <report.md>\n');
    return 2;
  }
  try {
    await generateReviewEligibilityReport(args[0] as string, args[1] as string, args[2] as string);
    return 0;
  } catch (error) {
    process.stderr.write(`review-eligibility-benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
