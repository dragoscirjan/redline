# POSIX shell rules

## Portability

- `/bin/sh` means the project's POSIX-compatible implementation, not Bash. A `.sh` suffix does not establish the interpreter.
- Syntax and utility options must exist on every supported target. Arrays, `[[ ... ]]`, process substitution, `source`, `function`, and `local` are not portable POSIX features.
- Quote parameter and command substitutions unless field splitting or pathname expansion is intentional. Preserve positional arguments with `"$@"`.
- Prefer `printf` for predictable output. Use `read -r` and deliberate `IFS` settings for field parsing.
- Distinguish empty and unset values. Parameter expansion must not depend on accidental `set -u` behavior.
- Under the POSIX contract, pipeline status is the last command's status. Pipeline subshells may prevent variable changes from reaching later code.

## Failure and process boundaries

- `set -e` and `set -u` depend on command position, functions, subshells, and conditionals; `pipefail` cannot be assumed portable. Use explicit status handling at recoverable boundaries.
- Cleanup must retain the original failure status. Signal handling and traps must tolerate repeated cleanup and the target shell's actual `EXIT` semantics.
- Build argument lists with positional parameters and direct invocation, not `eval` or concatenated shell source.
- Quote here-document delimiters when expansion is not intended. Shell tracing and process arguments can expose secrets.
- `PATH`, sourced files, locale, working directory, and environment variables affect executable and data interpretation.
- Temporary files need appropriate `umask`, unpredictable names, ownership checks where relevant, and immediate cleanup registration. Validate symlinks and archive members before privileged filesystem operations.

## Tool defaults

- Formatting: [shfmt](https://github.com/mvdan/sh) in POSIX-compatible mode.
- Analysis: [ShellCheck](https://www.shellcheck.net/) with the actual dialect.
- Syntax: each supported POSIX shell; a Bash-only check does not establish portability.
- Behavior tests: [ShellSpec](https://shellspec.info/), including whitespace, globs, option-like arguments, signals, locale, cleanup, and subshell behavior.
- Dependency auditing depends on the package or image ecosystem; there is no universal shell audit.

References: [POSIX Shell Command Language](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html). The [Google Shell Style Guide](https://google.github.io/styleguide/shellguide.html) is Bash-oriented and applies only where compatible.
