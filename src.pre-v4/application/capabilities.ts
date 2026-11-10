/** Explicit capabilities, not dynamically loaded repository plugins. */
export const VCS_IDS = ['git', 'jj', 'mercurial'] as const;
export type VcsId = (typeof VCS_IDS)[number];
export const REPORTER_IDS = ['cli', 'github', 'forgejo', 'gitea', 'gitlab', 'bitbucket'] as const;
export type ReporterId = (typeof REPORTER_IDS)[number];

export class CapabilityError extends Error {}

export function requireCapability(kind: 'vcs' | 'reporter', id: string): void {
  const known: readonly string[] = kind === 'vcs' ? VCS_IDS : REPORTER_IDS;
  if (!known.includes(id)) throw new CapabilityError(`unknown ${kind}; choose ${known.join('|')}`);
  if (id !== (kind === 'vcs' ? 'git' : 'cli')) {
    throw new CapabilityError(`${kind} ${id} is not implemented in the local CLI`);
  }
}
