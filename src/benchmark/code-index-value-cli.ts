import { resolve } from 'node:path';
import { writeCodeIndexValueReport } from './code-index-value.ts';

interface Options {
  readonly capture: string;
  readonly json: string;
  readonly markdown: string;
}

function options(arguments_: readonly string[]): Options {
  let capture = resolve('benchmark/code-index-value/v1/capture.json');
  let json = resolve('benchmark/code-index-value/v1/report.json');
  let markdown = resolve('benchmark/code-index-value/v1/report.md');
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`missing value for ${argument ?? 'argument'}`);
    if (argument === '--capture') capture = resolve(value);
    else if (argument === '--json') json = resolve(value);
    else if (argument === '--markdown') markdown = resolve(value);
    else throw new Error(`unsupported argument: ${argument}`);
    index += 1;
  }
  return { capture, json, markdown };
}

async function main(): Promise<void> {
  const selected = options(process.argv.slice(2));
  await writeCodeIndexValueReport(selected.capture, selected.json, selected.markdown);
  process.stdout.write(`${selected.json}\n${selected.markdown}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`code-index value report: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
