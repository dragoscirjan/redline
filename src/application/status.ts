/** Report implemented capabilities without implying that reviews work. */
export interface ApplicationStatus {
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

export function applicationStatus(version: string): ApplicationStatus {
  return {
    version, initiative: '4.0', phase: 'scaffold', review: 'not-implemented',
    modelRuntime: 'not-implemented', mcp: 'not-implemented', publication: 'not-implemented',
    localExecutable: 'node-or-bun', standaloneBinary: 'not-implemented', docker: 'scaffold-only',
  };
}
