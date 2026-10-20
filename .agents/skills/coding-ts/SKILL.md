---
name: coding-ts
description: Write, refactor, review, or test TypeScript in .ts files with precise types, runtime-safe boundaries, project compiler settings, and complete quality gates. Use for TypeScript work and combine with coding-mts, coding-cts, or coding-tsx when those extension semantics apply.
compatibility: Requires the coding skill and the TypeScript compiler and runtime toolchain selected by the project.
metadata:
  author: dragoscirjan
  version: "1.0"
  opencode/slash: "true"
---

# TypeScript coding

Apply the generic `coding` workflow, then apply the TypeScript-specific rules in this skill.

## Load the dependency

Locate the advertised `coding` skill by exact name and path. If it is not already loaded, read its `SKILL.md` before continuing.

If `coding` is unavailable, stop and ask the human to install or expose it. Do not install it automatically, copy its instructions into this skill, or assume its contents from memory.

For `.mts`, `.cts`, or `.tsx` files, also load the matching extension skill after this one.

## Follow project and language guidance

Inspect `package.json`, the lockfile, every applicable `tsconfig` file, runtime and module declarations, build configuration, lint and formatter configuration, tests, and CI before editing.

Use the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) and the [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html) as primary references. Apply them through the project's compiler options, runtime constraints, and established conventions.

## Model types precisely

- Preserve the project's supported TypeScript version and compiler settings.
- Prefer compiler inference for clear local values. Write explicit types at public, cross-module, serialized, and dependency-injection boundaries.
- Prefer `unknown` to `any` for values that need validation. Narrow before use.
- Avoid unchecked type assertions, non-null assertions, and suppression comments. Use them only with a documented invariant that the compiler cannot express.
- Model alternatives with discriminated unions when they make invalid states harder to represent.
- Preserve null and undefined semantics. Do not hide a missing-value problem with an assertion.
- Use `readonly`, immutable transformations, and pure functions when they simplify ownership and state flow.
- Keep generic parameters meaningful and constrained. Do not generalize a concrete operation without a real caller need.
- Keep exported types stable unless the approved task changes the API.
- Use type-only imports and exports where they clarify runtime boundaries and match project compiler settings.

## Keep runtime boundaries safe

TypeScript types are erased. Validate untrusted values from JSON, environment variables, network requests, storage, messages, and JavaScript dependencies before treating them as typed data.

- Keep validation near the trust boundary.
- Do not cast an unvalidated object merely to satisfy the compiler.
- Preserve error causes and narrow caught values before reading properties.
- Avoid prototype-sensitive object operations on attacker-controlled keys.
- Keep secrets out of browser bundles, source maps, logs, declarations, and exceptions.
- Audit direct and transitive packages with the active package manager.

## Test and run TypeScript gates

Use the project's scripts and tools first. When the project has no configured choice, prefer the maintained shared configurations from the [Tempel JavaScript Development Toolkit](https://github.com/dragoscirjan/tempel-javascript) and ask before installing them:

- [`@tempel/vitest`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/vitest) for the Vitest fallback
- [`@tempel/jest`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/jest) when the project has chosen Jest instead of Vitest
- [`@tempel/eslint`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/eslint) for ESLint
- [`@tempel/prettier`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/prettier) for Prettier
- [`@tempel/commitlint`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/commitlint) when the repository validates Conventional Commits
- the TypeScript compiler with [`noEmit`](https://www.typescriptlang.org/tsconfig/noEmit.html) for type checking when another tool emits code
- [jscpd](https://jscpd.dev/) for duplicate detection
- the active package manager's audit command for dependency vulnerabilities

Do not recommend `@tempel/tsconfig`; it is not currently maintained. Keep TypeScript compiler configuration project-owned and use the project's `tsconfig` files directly. Tempel recommendations do not override existing project configuration.

Test observable runtime behavior, not only type relationships. Add compile-time type tests only when they protect an intentional public type contract.

Apply only project-defined thresholds. Report every applicable gate as passed, failed, not run, or unsupported. Never describe an unavailable or unexecuted gate as passed.
