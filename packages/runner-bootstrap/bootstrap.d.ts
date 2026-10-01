export const MAX_BOOTSTRAP_ENVELOPE_BYTES: number;
export const OPENCODE_COORDINATOR_SESSION_ID: 'redline-coordinator';

export interface BootstrapEnvelope {
  readonly version: 1;
  readonly backend: 'pi' | 'opencode';
  readonly prompt: string;
  readonly model: {
    readonly provider: string;
    readonly endpoint: string;
    readonly model: string;
    readonly credential: string;
  };
}

export interface RuntimePlan {
  readonly directories: readonly string[];
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  readonly command: '/usr/local/bin/pi' | '/usr/local/bin/opencode';
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly prompt: string;
}

export function parseBootstrapEnvelope(
  serialized: string,
  expectedBackend: 'pi' | 'opencode',
): BootstrapEnvelope;
export function buildPiRuntime(envelope: BootstrapEnvelope): RuntimePlan;
export function buildOpenCodeRuntime(envelope: BootstrapEnvelope): RuntimePlan;
export function main(arguments_?: readonly string[]): Promise<number>;
