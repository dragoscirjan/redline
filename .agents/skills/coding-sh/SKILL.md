---
name: coding-sh
description: Write, refactor, review, or test portable POSIX shell with explicit interpreter constraints, safe quoting and expansion, reliable status and cleanup handling, command-injection defenses, and project-first quality gates. Use for .sh files and shell fragments that must run under a POSIX-compatible sh.
compatibility: Requires the coding skill and the POSIX-compatible shell, operating systems, utilities, and analysis tools selected by the project.
metadata:
  author: dragoscirjan
  version: "1.0"
  opencode/slash: "true"
---

# POSIX shell coding

Apply the generic `coding` workflow, then apply the POSIX shell-specific rules in this skill.

## Load the dependency

Locate the advertised `coding` skill by exact name and path. If it is not already loaded, read its `SKILL.md` before continuing.

If `coding` is unavailable, stop and ask the human to install or expose it. Do not install it automatically, copy its instructions into this skill, or assume its contents from memory.

## Confirm the portability contract

Inspect the shebang, invoking process, container or host images, supported operating systems, available utilities, shell options, formatter and lint configuration, tests, and CI before editing. A `.sh` extension does not prove which shell runs the file. Treat `/bin/sh` as the project's documented POSIX-compatible implementation, not as Bash.

Use the current [POSIX Shell Command Language](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html) as the portability authority. Use the [Google Shell Style Guide](https://google.github.io/styleguide/shellguide.html) only where its Bash-oriented advice is compatible with the project's POSIX contract. Project conventions and target-shell behavior take precedence.

## Write portable shell

- Use only syntax and utility options available on every declared target. Do not use arrays, `[[ ... ]]`, process substitution, `source`, `function`, `local`, or other non-POSIX features in portable code.
- Quote parameter and command substitutions unless intentional field splitting or pathname expansion is required and documented. Preserve argument boundaries with `"$@"`.
- Use `printf` for predictable output. Use `read -r` and control `IFS` deliberately when parsing fields.
- Treat empty and unset states explicitly. Use parameter expansion deliberately rather than relying on accidental `set -u` behavior.
- Keep functions small and distinguish command output from exit status. Remember that pipeline status is the last command's status under POSIX shell.
- Avoid loops in pipeline subshells when later code depends on mutated state.
- Create temporary resources safely for the supported platform, set restrictive permissions when needed, and register cleanup immediately with `trap`.
- Preserve command-line behavior, output, exit codes, environment contracts, and supported platforms unless the approved task changes them.

## Handle failures deliberately

Do not add `set -e`, `set -u`, or a non-POSIX `pipefail` option mechanically. Their behavior depends on command position, subshells, functions, conditionals, and the selected shell. Follow project policy, use explicit status checks at recoverable boundaries, and test every option-dependent path.

Keep the original failure status when cleanup runs. Make signal handling and traps idempotent, and do not assume `EXIT` trap behavior beyond the selected shell's contract.

## Enforce shell security boundaries

- Keep untrusted values out of shell source and command strings. Do not use `eval` to reconstruct argument lists.
- Build commands with positional parameters and direct invocation instead of concatenated strings. Use an end-of-options marker only when the called utility supports it.
- Validate paths, filenames, archive members, glob results, and symlink behavior before privileged filesystem operations.
- Quote here-document delimiters when expansion is not required. Keep secrets out of arguments visible to other processes, tracing, logs, and error output.
- Treat sourced files, executable lookup through `PATH`, environment variables, locale, and current working directory as trust boundaries.
- Set an appropriate `umask` before creating sensitive files. Avoid predictable temporary names and check ownership and permissions where security depends on them.
- Bound retries, reads, generated arguments, and recursion when inputs can consume resources.

## Test and run POSIX shell gates

Use the project's commands, selected shells, and configured tools first. When the project has no configured choice, ask before installing or configuring these fallbacks:

- [ShellSpec](https://shellspec.info/) for focused and broader behavior tests
- [shfmt](https://github.com/mvdan/sh) in the project's POSIX-compatible mode for formatting
- [ShellCheck](https://www.shellcheck.net/) with the project-selected shell dialect for static analysis
- syntax checks with each supported POSIX shell
- [jscpd](https://jscpd.dev/) as the duplicate detector when the project has no configured alternative

Test quoting, empty and whitespace-containing values, glob characters, option-like arguments, failures, signals, cleanup, pipeline and subshell behavior, locale differences, and every supported shell. Do not use a Bash-only check as proof of POSIX portability.

Shell scripts do not have one universal dependency-vulnerability audit. Report that category as unsupported when the project has no suitable package or image audit; do not claim that linting or tests satisfy it.

Apply only project-defined thresholds. Report every applicable gate as passed, failed, not run, or unsupported.
