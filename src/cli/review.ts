import { main as run } from './main.ts';

/** Preserve the public executable name without silently invoking the archived reviewer. */
export async function main(args: readonly string[] = process.argv.slice(2), environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  return run(['review', ...args], environment);
}
