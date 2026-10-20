import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  CONFLICT: 3,
  ENVIRONMENT: 4,
  COMMAND: 5,
  IO: 6,
} as const);

export type Vcs = "git" | "jj";
export type OutputFormat = "json" | "text";

export interface OptionDefinition {
  type: "boolean" | "string";
  required?: boolean;
  choices?: readonly string[];
  default?: string | boolean;
}

export type ParsedArgs = Record<string, string | boolean | undefined>;
export type OptionDefinitions = Record<string, OptionDefinition>;

export interface CommandOptions {
  allowFailure?: boolean;
  errorCode?: number;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface GitWorktree {
  worktree: string;
  HEAD?: string;
  branch?: string;
  bare?: true;
  detached?: true;
  locked?: true | string;
  prunable?: true | string;
  [key: string]: string | true | undefined;
}

export interface JjWorkspace {
  name: string;
  target: string;
}

export interface RepositoryContext {
  currentRoot: string;
  primaryRoot: string;
  worktrees?: GitWorktree[];
  workspaces?: JjWorkspace[];
}

export interface WorkspaceLayout {
  repositoryName: string;
  workspaceName: string;
  workspaceRoot: string;
  workspacePath: string;
}

export interface BaseRevision {
  expression: string;
  commit: string;
}

interface BunRuntime {
  which(tool: string): string | null;
}

export class WorkspaceError extends Error {
  readonly code: number;
  readonly details?: unknown;

  constructor(message: string, code: number = EXIT.IO, details: unknown = undefined) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.details = details;
  }
}

function getBunRuntime(): BunRuntime | undefined {
  return (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
}

export function requireBun(): void {
  if (typeof getBunRuntime()?.which !== "function") {
    throw new WorkspaceError(
      "Bun is required to run this workspace helper; install Bun and invoke the script with bun",
      EXIT.ENVIRONMENT,
    );
  }
}

export function parseArgs(argv: string[], definitions: OptionDefinitions): ParsedArgs {
  const values: ParsedArgs = {};
  for (const [name, definition] of Object.entries(definitions)) {
    if (Object.hasOwn(definition, "default")) values[name] = definition.default;
    else if (definition.type === "boolean") values[name] = false;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new WorkspaceError(`Unexpected positional argument: ${token}`, EXIT.USAGE);
    }
    const name = token.slice(2);
    const definition = definitions[name];
    if (!definition) throw new WorkspaceError(`Unknown option: ${token}`, EXIT.USAGE);
    if (definition.type === "boolean") {
      values[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new WorkspaceError(`Option ${token} requires a value`, EXIT.USAGE);
    }
    index += 1;
    if (definition.choices && !definition.choices.includes(value)) {
      throw new WorkspaceError(
        `Option ${token} must be one of: ${definition.choices.join(", ")}`,
        EXIT.USAGE,
      );
    }
    values[name] = value;
  }

  if (!values.help) {
    for (const [name, definition] of Object.entries(definitions)) {
      if (definition.required && !values[name]) {
        throw new WorkspaceError(`Missing required option: --${name}`, EXIT.USAGE);
      }
    }
    if (values.apply && values["dry-run"]) {
      throw new WorkspaceError("Use either --dry-run or --apply, not both", EXIT.USAGE);
    }
    if (values.apply && !values.confirm) {
      throw new WorkspaceError("--apply requires --confirm after the plan is approved", EXIT.USAGE);
    }
    if (values.confirm && !values.apply) {
      throw new WorkspaceError("--confirm is valid only with --apply", EXIT.USAGE);
    }
  }
  return values;
}

function redact(value: string): string {
  return value
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1<redacted>@")
    .replace(
      /([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*=)[^\s]+/gi,
      "$1<redacted>",
    );
}

export function command(
  cwd: string,
  executable: string,
  args: string[],
  options: CommandOptions = {},
): CommandResult {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    shell: false,
    maxBuffer: 20 * 1024 * 1024,
  });
  const normalized = {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    const diagnostic = redact(`${normalized.stdout}${normalized.stderr}`.trim()).slice(0, 4000);
    throw new WorkspaceError(
      `Command failed: ${executable} ${args.join(" ")}${diagnostic ? `\n${diagnostic}` : ""}`,
      options.errorCode ?? EXIT.COMMAND,
      { status: result.status, error: result.error?.message },
    );
  }
  return normalized;
}

export function requireTool(tool: Vcs): void {
  requireBun();
  if (!getBunRuntime()?.which(tool)) {
    throw new WorkspaceError(`${tool} is required but was not found in PATH`, EXIT.ENVIRONMENT);
  }
}

function requireJjVersion(directory: string): void {
  const result = command(directory, "jj", ["--version"], { allowFailure: true });
  const match = result.stdout.match(/\b(\d+)\.(\d+)(?:\.(\d+))?/);
  if (result.status !== 0 || !match) {
    throw new WorkspaceError("Could not determine the Jujutsu version", EXIT.ENVIRONMENT);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 0 && minor < 38) {
    throw new WorkspaceError("Jujutsu 0.38 or newer is required", EXIT.ENVIRONMENT);
  }
}

export function resolveDirectory(input: string): string {
  const directory = resolve(input);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new WorkspaceError(`Start path is not a directory: ${directory}`, EXIT.ENVIRONMENT);
  }
  return realpathSync(directory);
}

export function canonicalIfExists(input: string): string {
  return existsSync(input) ? realpathSync(input) : resolve(input);
}

export function isContained(parent: string, target: string): boolean {
  const rel = relative(parent, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function assertSafeBranch(branch: string): string {
  if (
    !branch ||
    branch.startsWith("-") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    !/^[A-Za-z0-9._/-]+$/.test(branch)
  ) {
    throw new WorkspaceError(
      "--branch must be a safe full branch or bookmark name",
      EXIT.USAGE,
    );
  }
  const leaf = branch.split("/").at(-1);
  if (!leaf || leaf === "." || leaf === "..") {
    throw new WorkspaceError("--branch must have a safe final path component", EXIT.USAGE);
  }
  return leaf;
}

export function parseGitWorktrees(output: string): GitWorktree[] {
  const records: GitWorktree[] = [];
  let record: Partial<GitWorktree> = {};
  for (const token of output.split("\0")) {
    if (token === "") {
      if (record.worktree) records.push(record as GitWorktree);
      record = {};
      continue;
    }
    const separator = token.indexOf(" ");
    const key = separator < 0 ? token : token.slice(0, separator);
    const value = separator < 0 ? true : token.slice(separator + 1);
    record[key] = value;
  }
  if (record.worktree) records.push(record as GitWorktree);
  return records;
}

export function listGitWorktrees(repository: string): GitWorktree[] {
  const result = command(repository, "git", ["worktree", "list", "--porcelain", "-z"]);
  return parseGitWorktrees(result.stdout);
}

function gitPrimaryRoot(start: string): RepositoryContext {
  const current = command(start, "git", ["rev-parse", "--show-toplevel"], {
    errorCode: EXIT.ENVIRONMENT,
  }).stdout.trim();
  const worktrees = listGitWorktrees(current);
  if (worktrees.length === 0) {
    throw new WorkspaceError("Git did not report a primary worktree", EXIT.ENVIRONMENT);
  }
  return {
    currentRoot: realpathSync(current),
    primaryRoot: realpathSync(worktrees[0].worktree),
    worktrees,
  };
}

export function parseNulPairs(output: string): JjWorkspace[] {
  const tokens = output.split("\0").filter((token) => token !== "");
  const pairs: JjWorkspace[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    pairs.push({ name: tokens[index], target: tokens[index + 1] });
  }
  return pairs;
}

export function listJjWorkspaces(repository: string): JjWorkspace[] {
  const template = 'name ++ "\\0" ++ target.commit_id() ++ "\\0"';
  const result = command(repository, "jj", [
    "workspace",
    "list",
    "--ignore-working-copy",
    "-T",
    template,
  ]);
  return parseNulPairs(result.stdout);
}

export function listJjBookmarks(repository: string): string[] {
  const template = 'if(remote, "", name ++ "\\0")';
  const result = command(repository, "jj", [
    "bookmark",
    "list",
    "--all-remotes",
    "--ignore-working-copy",
    "-T",
    template,
  ]);
  return result.stdout.split("\0").filter(Boolean);
}

export function resolveJjRevision(repository: string, revision: string): string {
  const count = command(repository, "jj", [
    "log",
    "--ignore-working-copy",
    "-r",
    revision,
    "--no-graph",
    "-T",
    'commit_id ++ "\\n"',
  ], { allowFailure: true });
  if (count.status !== 0) {
    throw new WorkspaceError(`Cannot resolve Jujutsu revision: ${revision}`, EXIT.CONFLICT);
  }
  const commits = count.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (commits.length !== 1) {
    throw new WorkspaceError(`Jujutsu revision must resolve to one commit: ${revision}`, EXIT.CONFLICT);
  }
  return commits[0];
}

function jjPrimaryRoot(start: string): RepositoryContext {
  const currentRoot = command(start, "jj", ["workspace", "root"], {
    errorCode: EXIT.ENVIRONMENT,
  }).stdout.trim();
  const primary = command(currentRoot, "jj", [
    "workspace",
    "root",
    "--name",
    "default",
    "--ignore-working-copy",
  ], { allowFailure: true });
  if (primary.status !== 0) {
    throw new WorkspaceError(
      "Could not resolve the Jujutsu default workspace root",
      EXIT.ENVIRONMENT,
    );
  }
  const primaryRoot = primary.stdout.trim();
  return {
    currentRoot: realpathSync(currentRoot),
    primaryRoot: realpathSync(primaryRoot),
    workspaces: listJjWorkspaces(primaryRoot),
  };
}

export function detectRepository(vcs: Vcs, start = process.cwd()): RepositoryContext {
  requireTool(vcs);
  const directory = resolveDirectory(start);
  if (vcs === "jj") requireJjVersion(directory);
  return vcs === "git" ? gitPrimaryRoot(directory) : jjPrimaryRoot(directory);
}

export function deriveLayout(primaryRoot: string, branch: string): WorkspaceLayout {
  const workspaceName = assertSafeBranch(branch);
  const repositoryName = basename(primaryRoot);
  if (!repositoryName || repositoryName === "." || repositoryName === "..") {
    throw new WorkspaceError("Could not derive a safe repository name", EXIT.ENVIRONMENT);
  }
  const workspaceRoot = resolve(dirname(primaryRoot), `${repositoryName}--workspaces`);
  const workspacePath = resolve(workspaceRoot, workspaceName);
  if (!isContained(workspaceRoot, workspacePath) || isContained(primaryRoot, workspacePath)) {
    throw new WorkspaceError("Derived workspace path is unsafe", EXIT.CONFLICT);
  }
  if (existsSync(workspaceRoot) && lstatSync(workspaceRoot).isSymbolicLink()) {
    throw new WorkspaceError(`Workspace root is a symlink: ${workspaceRoot}`, EXIT.CONFLICT);
  }
  return { repositoryName, workspaceName, workspaceRoot, workspacePath };
}

export function ensureWorkspaceRoot(layout: WorkspaceLayout): void {
  if (!existsSync(layout.workspaceRoot)) mkdirSync(layout.workspaceRoot, { recursive: true });
  const canonicalRoot = realpathSync(layout.workspaceRoot);
  if (canonicalRoot !== layout.workspaceRoot) {
    throw new WorkspaceError(
      `Workspace root resolves unexpectedly: ${canonicalRoot}`,
      EXIT.CONFLICT,
    );
  }
}

export function gitBase(repository: string, requested?: string): BaseRevision {
  let base = requested;
  if (!base) {
    const remote = command(repository, "git", [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ], { allowFailure: true });
    if (remote.status === 0) base = remote.stdout.trim();
  }
  if (!base) {
    const current = command(repository, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      allowFailure: true,
    });
    if (current.status === 0) base = current.stdout.trim();
  }
  if (!base) {
    throw new WorkspaceError("Could not detect the Git base; pass --base", EXIT.ENVIRONMENT);
  }
  const resolved = command(repository, "git", ["rev-parse", "--verify", `${base}^{commit}`], {
    allowFailure: true,
  });
  if (resolved.status !== 0) {
    throw new WorkspaceError(`Cannot resolve Git base: ${base}`, EXIT.CONFLICT);
  }
  return { expression: base, commit: resolved.stdout.trim() };
}

export function jjBase(repository: string, requested?: string): BaseRevision {
  const expression = requested || "trunk()";
  return { expression, commit: resolveJjRevision(repository, expression) };
}

export function operationStateGit(workspacePath: string): string[] {
  const names = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-merge",
    "rebase-apply",
  ];
  const active: string[] = [];
  for (const name of names) {
    const result = command(workspacePath, "git", ["rev-parse", "--git-path", name]);
    const target = resolve(workspacePath, result.stdout.trim());
    if (existsSync(target)) active.push(name);
  }
  return active;
}

export function planId(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new WorkspaceError("Could not serialize the workspace plan", EXIT.IO);
  }
  return createHash("sha256").update(serialized).digest("hex");
}

type DataRecord = Record<string, unknown>;

function asRecord(value: unknown): DataRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as DataRecord
    : undefined;
}

function asRecords(value: unknown): DataRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is DataRecord => item !== undefined)
    : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function printCommands(value: unknown): void {
  for (const item of asRecords(value)) {
    const executable = text(item.command);
    const args = Array.isArray(item.args)
      ? item.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const cwd = text(item.cwd);
    if (executable) {
      process.stdout.write(
        `- command: ${executable} ${args.join(" ")}${cwd ? ` (cwd: ${cwd})` : ""}\n`,
      );
    }
  }
}

function printItems(label: string, value: unknown): void {
  for (const item of asRecords(value)) {
    const identity = text(item.name) ?? text(item.branch) ?? text(item.bookmark) ?? "unknown";
    const details = [text(item.path), text(item.reason)].filter(
      (detail): detail is string => detail !== undefined,
    );
    process.stdout.write(`- ${label}: ${identity}${details.length ? ` (${details.join("; ")})` : ""}\n`);
  }
}

export function emit(result: DataRecord, format: OutputFormat = "json"): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const repository = asRecord(result.repository);
  const nested = asRecord(result.result);
  process.stdout.write(`${String(result.mode).toUpperCase()} ${String(result.skill)}\n`);
  process.stdout.write(`Repository: ${text(repository?.primaryRoot) ?? "unknown"}\n`);
  process.stdout.write(`Workspace root: ${text(result.workspaceRoot) ?? "unknown"}\n`);
  if (text(result.planId)) process.stdout.write(`Plan ID: ${text(result.planId)}\n`);
  const topBase = asRecord(result.base);
  if (topBase) {
    process.stdout.write(
      `Base: ${text(topBase.expression) ?? "unknown"} (${text(topBase.commit) ?? "unknown"})\n`,
    );
  }

  if (nested && text(nested.workspacePath)) {
    const base = asRecord(nested.base);
    process.stdout.write(`VCS: ${text(nested.vcs) ?? "unknown"}\n`);
    process.stdout.write(`Action: ${text(nested.action) ?? "unknown"}\n`);
    process.stdout.write(`Branch/bookmark: ${text(nested.branch) ?? "unknown"}\n`);
    process.stdout.write(
      `Base: ${text(base?.expression) ?? "unknown"} (${text(base?.commit) ?? "unknown"})\n`,
    );
    process.stdout.write(`Workspace: ${text(nested.workspacePath)}\n`);
    process.stdout.write(`Status: ${text(nested.status) ?? "unknown"}\n`);
    printCommands(nested.commands);
  }

  printItems("eligible", result.eligible);
  printItems("stale", result.stale);
  printItems("skipped", result.skipped);
  printCommands(result.operations);

  if (nested) {
    printItems("removed", nested.removed);
    printItems("retained", nested.retained);
    printItems("failed", nested.failed);
  }
}

export function handleError(error: unknown, help?: string): void {
  const normalized = error instanceof WorkspaceError
    ? error
    : new WorkspaceError(error instanceof Error ? error.message : String(error), EXIT.IO);
  process.stderr.write(`${normalized.name}: ${normalized.message}\n`);
  if (normalized.details) process.stderr.write(`${JSON.stringify(normalized.details)}\n`);
  if (normalized.code === EXIT.USAGE && help) process.stderr.write(`\n${help}\n`);
  process.exitCode = normalized.code;
}
