#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadCheckoutBenchmarkAggregate,
  loadCheckoutBenchmarkProfile,
  validateCheckoutBenchmarkAggregate,
  writeCheckoutBenchmarkReport,
} from './checkout.ts';

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (args.length !== 3) {
    process.stderr.write('Usage: checkout-cli <profile.json> <aggregate.json> <report.md>\n');
    return 2;
  }
  try {
    const profile = await loadCheckoutBenchmarkProfile(resolve(args[0] as string));
    const aggregate = await loadCheckoutBenchmarkAggregate(resolve(args[1] as string));
    validateCheckoutBenchmarkAggregate(profile, aggregate);
    await writeCheckoutBenchmarkReport(resolve(args[2] as string), aggregate);
    return 0;
  } catch (error) {
    process.stderr.write(`checkout-benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
