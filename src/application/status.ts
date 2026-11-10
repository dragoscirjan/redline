/** Scaffold capabilities are explicit so entrypoints cannot imply working reviews. */
export interface ScaffoldStatus {
  readonly version: string;
  readonly initiative: '4.0';
  readonly phase: 'scaffold';
  readonly review: 'not-implemented';
  readonly modelRuntime: 'not-implemented';
  readonly mcp: 'not-implemented';
  readonly publication: 'not-implemented';
  readonly localExecutable: 'node-or-bun';
  readonly standaloneBinary: 'not-implemented';
  readonly docker: 'scaffold-only';
}

export function scaffoldStatus(version: string): ScaffoldStatus {
  return {
    version, initiative: '4.0', phase: 'scaffold', review: 'not-implemented',
    modelRuntime: 'not-implemented', mcp: 'not-implemented', publication: 'not-implemented',
    localExecutable: 'node-or-bun', standaloneBinary: 'not-implemented', docker: 'scaffold-only',
  };
}
