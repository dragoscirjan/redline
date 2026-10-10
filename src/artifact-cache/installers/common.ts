import { join } from 'node:path';
import { parseInstalledToolManifest, parseReviewToolDescriptor } from '../contracts.js';
import { inspectInstalledToolManifest } from '../tool-tree.js';
import type { ToolCommandRunner } from '../tool-transport.js';
import type {
  CacheDiagnostic,
  ReviewToolDescriptor,
  ToolInstallationResult,
  ToolValidationRequest,
  ToolValidationResult,
} from '../types.js';

const MAX_DIAGNOSTIC_MESSAGE_BYTES = 4_096;

export function diagnostic(
  level: CacheDiagnostic['level'],
  code: string,
  message: string,
): CacheDiagnostic {
  const bytes = Buffer.from(message, 'utf8');
  const bounded = bytes.byteLength <= MAX_DIAGNOSTIC_MESSAGE_BYTES
    ? message
    : `${bytes.subarray(0, MAX_DIAGNOSTIC_MESSAGE_BYTES).toString('utf8')}…`;
  return { level, code, message: bounded };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function failedInstallation(
  startedAt: number,
  code: string,
  error: unknown,
  status: 'failed' | 'timed-out' | 'unavailable' = 'failed',
): ToolInstallationResult {
  return {
    status,
    diagnostics: [diagnostic('error', code, errorMessage(error))],
    durationMs: performance.now() - startedAt,
  };
}

export function toolEnvironment(
  workDirectory: string,
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  return {
    ...environment,
    HOME: join(workDirectory, 'home'),
    USERPROFILE: join(workDirectory, 'home'),
    npm_config_audit: 'false',
    npm_config_cache: join(workDirectory, 'npm-cache'),
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

function manifestsMatch(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function commandFailureMessage(result: {
  readonly error?: string | undefined;
  readonly stdout: string;
  readonly stderr: string;
}): string {
  return [result.error, result.stderr, result.stdout].filter((value) => value !== undefined && value.length > 0).join('\n')
    || 'tool health probe failed without diagnostics';
}

export interface InstalledToolValidationOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Absolute trusted runtime used to launch a script probe. */
  readonly runtimeExecutable?: string;
}

export async function validateInstalledTool(
  runner: ToolCommandRunner,
  request: ToolValidationRequest,
  options: InstalledToolValidationOptions,
): Promise<ToolValidationResult> {
  const startedAt = performance.now();
  try {
    const descriptor = parseReviewToolDescriptor(request.descriptor);
    const expectedManifest = parseInstalledToolManifest(request.manifest);
    const actualManifest = await inspectInstalledToolManifest(
      descriptor,
      request.installationDirectory,
      expectedManifest.executablePaths,
    );
    if (!manifestsMatch(actualManifest, expectedManifest)) {
      return {
        status: 'invalid',
        diagnostics: [diagnostic('warning', 'tool-manifest-mismatch', 'installed tool files do not match the manifest')],
        durationMs: performance.now() - startedAt,
      };
    }
    const executable = join(
      request.installationDirectory,
      ...descriptor.healthProbe.executable.split('/'),
    );
    const result = await runner.run({
      command: options.runtimeExecutable ?? executable,
      args: options.runtimeExecutable === undefined
        ? descriptor.healthProbe.args
        : [executable, ...descriptor.healthProbe.args],
      cwd: request.installationDirectory,
      env: options.environment,
      timeoutMs: request.timeoutMs,
    });
    if (result.timedOut) {
      return {
        status: 'timed-out',
        diagnostics: [diagnostic('warning', 'tool-health-timed-out', 'tool health probe timed out')],
        durationMs: performance.now() - startedAt,
      };
    }
    if (result.code === null) {
      return {
        status: 'unavailable',
        diagnostics: [diagnostic('warning', 'tool-health-unavailable', commandFailureMessage(result))],
        durationMs: performance.now() - startedAt,
      };
    }
    const outputMatches = descriptor.healthProbe.expectedOutput === undefined
      || result.stdout.trim() === descriptor.healthProbe.expectedOutput;
    if (
      result.code !== descriptor.healthProbe.expectedExitCode
      || result.stdoutTruncated
      || !outputMatches
    ) {
      return {
        status: 'invalid',
        diagnostics: [diagnostic('warning', 'tool-health-invalid', commandFailureMessage(result))],
        durationMs: performance.now() - startedAt,
      };
    }
    return { status: 'valid', diagnostics: [], durationMs: performance.now() - startedAt };
  } catch (error) {
    return {
      status: 'invalid',
      diagnostics: [diagnostic('warning', 'tool-validation-failed', errorMessage(error))],
      durationMs: performance.now() - startedAt,
    };
  }
}

export function assertIndexerDescriptor(
  descriptor: ReviewToolDescriptor,
  id: string,
): ReviewToolDescriptor {
  const parsed = parseReviewToolDescriptor(descriptor);
  if (parsed.id !== id || parsed.family !== 'code-indexer' || parsed.providerId !== id) {
    throw new Error(`installer ${id} received an incompatible tool descriptor`);
  }
  return parsed;
}
