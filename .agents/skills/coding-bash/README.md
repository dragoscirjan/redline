# Bash coding

`coding-bash` adds Bash 4-or-newer semantics. Apply [`coding`](../coding/SKILL.md), then [`coding-sh`](../coding-sh/SKILL.md), then this wrapper.

The skill has a hard minimum of Bash 4.0. The agent verifies the interpreter on every supported target and stops for a decision when any target resolves an older Bash.

## Routing

Select this skill from the interpreter contract, not from the filename suffix. Apply it to `.sh` and extensionless files when the shebang, invoking command, sourced Bash context, project configuration, or lint directives establish Bash. Treat Bash-only syntax as supporting evidence. Stop and ask when these signals conflict or remain ambiguous.

## Scope

The wrapper covers only Bash-specific concerns:

- indexed and associative arrays
- `[[ ... ]]`, arithmetic contexts, extended globs, and regular-expression matching
- process substitution, `mapfile`, namerefs, and version-gated features
- `BASH_SOURCE`, `FUNCNAME`, `PIPESTATUS`, options, traps, and sourced-script state
- pipeline, subshell, process-substitution, job, and coprocess behavior
- [ShellCheck](https://www.shellcheck.net/) with the Bash dialect selected explicitly, regardless of a `.sh` suffix
- Bats-core and Bash 4+-version syntax checks

It inherits quoting, injection, cleanup, POSIX-baseline, shfmt, and jscpd guidance from `coding-sh` instead of duplicating it.

## Sources

- [GNU Bash Manual](https://www.gnu.org/software/bash/manual/bash.html)
- [Google Shell Style Guide](https://google.github.io/styleguide/shellguide.html)

## Dependency contract

`coding-bash` requires `coding` and `coding-sh`. The agent resolves both through advertised skill names and paths, loads them in that order, and stops when either is unavailable. The skill does not rely on a harness-specific Skill tool.

## Invocation

Pi:

```text
/skill:coding-bash Update this Bash script and run the configured gates.
```

OpenCode:

```text
/coding-bash Update this Bash script and run the configured gates.
```

## Files

- [`SKILL.md`](SKILL.md) contains the agent instructions.
- `README.md` documents scope and composition.

See [issue 25](https://github.com/dragoscirjan/ai/issues/25) for the implementation requirements.
