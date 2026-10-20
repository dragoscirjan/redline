# TypeScript coding

`coding-ts` adds TypeScript-specific guidance to the generic [`coding`](../coding/SKILL.md) workflow. It applies to `.ts` files and uses the project's compiler, runtime, module, and build configuration.

Load `coding-mts`, `coding-cts`, or `coding-tsx` after this skill when the file extension requires additional semantics.

## Sources

- [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)

Project compiler settings and safe established conventions take precedence.

## Fallback quality tools

When the project has no configured choice, the skill recommends maintained packages from the [Tempel JavaScript Development Toolkit](https://github.com/dragoscirjan/tempel-javascript):

- [`@tempel/vitest`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/vitest)
- [`@tempel/jest`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/jest) when the project uses Jest
- [`@tempel/eslint`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/eslint)
- [`@tempel/prettier`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/prettier)
- [`@tempel/commitlint`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/commitlint) when the repository validates Conventional Commits
- the TypeScript compiler with [`noEmit`](https://www.typescriptlang.org/tsconfig/noEmit.html) when another tool emits code
- [jscpd](https://jscpd.dev/)
- the active package manager's audit command

Do not recommend `@tempel/tsconfig`; it is not currently maintained. Keep compiler settings in the project's own `tsconfig` files. Existing project configuration takes precedence, and the agent must not install or reconfigure tools without human approval.

## Dependency contract

`coding-ts` requires `coding`. The agent resolves it through the active harness's advertised skill names and paths, loads it first, and stops when it is unavailable. The skill does not rely on a harness-specific Skill tool.

## Invocation

Pi:

```text
/skill:coding-ts Update this TypeScript module and run the configured gates.
```

OpenCode:

```text
/coding-ts Update this TypeScript module and run the configured gates.
```

## Files

- [`SKILL.md`](SKILL.md) contains the agent instructions.
- `README.md` documents sources, tools, and composition.

See [issue 17](https://github.com/dragoscirjan/ai/issues/17) for the implementation requirements.
