# Bash rules

## Interpreter and state

- Baseline: Bash 4.0 or newer on every target, including interpreters resolved through `/usr/bin/env`. Older targets require an explicit baseline decision.
- The shebang, invocation, sourcing context, or project configuration establishes Bash—not a `.sh` suffix or Bash-only syntax in a script declared as POSIX.
- A sourced function shares its caller's shell options, traps, working directory, and globals. Restore state that must not escape the function.
- `BASH_SOURCE`, `FUNCNAME`, and `PIPESTATUS` describe Bash execution state; their interpretation depends on sourced versus executed mode.

## Expansion and execution

- Quote expansions unless splitting or globbing is intentional. Preserve argument boundaries with arrays and quoted `"${array[@]}"`; `"${array[*]}"` has different semantics.
- Use `[[ ... ]]` for Bash conditionals and arithmetic contexts for numeric operations. Distinguish literal strings, globs, and regular-expression operands.
- Indexed and associative arrays, process substitution, `mapfile`, `readarray`, namerefs, extended globs, and parameter expansions must match the minimum supported Bash version.
- Pipelines, command substitution, and process substitution can create subshells. Their state changes and failures do not automatically reach the parent.
- `pipefail` changes pipeline status; it does not make `errexit` reliable in every command position. Check recoverable failures explicitly.
- Cleanup traps must preserve failure status and handle signals correctly in both sourced and executed modes.
- Never evaluate untrusted shell text. Option-like arguments need `--` where the invoked utility supports it; tracing and process arguments can expose secrets.

## Tool defaults

- Formatting: shfmt in Bash mode.
- Analysis: [ShellCheck](https://www.shellcheck.net/) with Bash selected explicitly.
- Syntax: `bash -n` using the minimum supported Bash version.
- Behavior tests: [Bats-core](https://bats-core.readthedocs.io/). Relevant cases include empty array elements, pipeline failures, process substitution, sourced-state restoration, traps, signals, jobs, and coprocesses.

References: [GNU Bash Manual](https://www.gnu.org/software/bash/manual/bash.html), [Google Shell Style Guide](https://google.github.io/styleguide/shellguide.html).
