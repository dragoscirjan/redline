import { ToolInstallerRegistry } from '../registry.js';
import type { ToolCommandRunner, ToolDownloader } from '../tool-transport.js';
import { CgcInstaller, type CgcInstallerOptions } from './cgc.js';
import { GitNexusInstaller, type GitNexusInstallerOptions } from './gitnexus.js';

export {
  CGC_VERSION,
  CgcInstaller,
  createCgcDescriptor,
  type CgcInstallerOptions,
} from './cgc.js';
export {
  GITNEXUS_VERSION,
  GitNexusInstaller,
  createGitNexusDescriptor,
  currentToolPlatform,
  type GitNexusInstallerOptions,
} from './gitnexus.js';

export interface CodeIndexerInstallerRegistryOptions {
  readonly runner?: ToolCommandRunner;
  readonly downloader?: ToolDownloader;
  readonly nodeExecutable: string;
  readonly npmExecutable: string;
  readonly tarExecutable: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

/** Immutable registry for the concrete code-indexer acquisition adapters. */
export function createCodeIndexerInstallerRegistry(
  options: CodeIndexerInstallerRegistryOptions,
): ToolInstallerRegistry {
  const shared = {
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.downloader === undefined ? {} : { downloader: options.downloader }),
    environment: { ...options.environment },
  };
  const gitNexusOptions: GitNexusInstallerOptions = {
    ...shared,
    nodeExecutable: options.nodeExecutable,
    npmExecutable: options.npmExecutable,
    tarExecutable: options.tarExecutable,
  };
  const cgcOptions: CgcInstallerOptions = shared;
  return new ToolInstallerRegistry([
    { id: 'cgc', create: () => new CgcInstaller(cgcOptions) },
    { id: 'gitnexus', create: () => new GitNexusInstaller(gitNexusOptions) },
  ]);
}
