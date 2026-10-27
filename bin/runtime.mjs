/** Load only this trusted package's erasable TypeScript, including under node_modules. */
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';

export async function run(entry) {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    process.stderr.write('redline requires Node.js 24 or newer\n');
    process.exitCode = 2;
    return;
  }
  const sourceRoot = new URL('../src/', import.meta.url).href;
  const hook = nodeModule.registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith(sourceRoot) || !url.endsWith('.ts')) return nextLoad(url, context);
      const source = nodeModule.stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'strip', sourceUrl: url });
      return { format: 'module', source, shortCircuit: true };
    },
  });
  try {
    const { main } = await import(new URL(entry, import.meta.url).href);
    process.exitCode = await main();
  } finally { hook.deregister(); }
}
