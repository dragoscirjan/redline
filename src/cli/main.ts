import { readFile } from 'node:fs/promises';
import { Command, CommanderError } from 'commander';
import { scaffoldStatus } from '../application/status.ts';

/** The package metadata is local distribution input, not model or repository content. */
async function packageVersion(): Promise<string> {
  const metadata: unknown = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  if (metadata === null || typeof metadata !== 'object'
    || !('version' in metadata) || typeof metadata.version !== 'string') {
    throw new Error('Invalid package metadata');
  }
  return metadata.version;
}

/** No review/configuration/model/tool work is performed by this scaffold entrypoint. */
export async function main(args: readonly string[] = process.argv.slice(2), _environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  let exitCode = 0;
  try {
    const version = await packageVersion();
    const command = new Command()
      .name('redline')
      .description('Initiative 4.0 scaffold. Review execution is not implemented.')
      .version(version)
      .exitOverride()
      .configureOutput({
        outputError: (_message, write) => write('redline: invalid command or option; run redline --help\n'),
      });
    command.command('status')
      .description('Show implemented and unavailable capabilities')
      .option('--json', 'Print machine-readable scaffold status')
      .action((options: { json?: boolean }) => {
        process.stdout.write(options.json === true
          ? JSON.stringify(scaffoldStatus(version)) + '\n'
          : 'Redline Initiative 4.0: scaffold\nReview, model, MCP and publication execution are not implemented.\nLocal execution uses Node or Bun; a standalone binary is not implemented.\nDocker delivery is scaffold-only.\n');
      });
    for (const name of ['review', 'rpc']) {
      command.command(name)
        .description('Unavailable during Initiative 4.0 scaffolding')
        .allowUnknownOption()
        .allowExcessArguments()
        .action(() => {
          process.stderr.write('redline: ' + name + ' execution is not implemented in the Initiative 4.0 scaffold\n');
          exitCode = 2;
        });
    }
    command.action(() => { command.outputHelp(); });
    await command.parseAsync([...args], { from: 'user' });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    process.stderr.write('redline: scaffold command failed\n');
    return 1;
  }
}
