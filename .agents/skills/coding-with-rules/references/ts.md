# TypeScript rules

## Type contracts

- The supported TypeScript version and `tsconfig` settings define type-checking, module, and emit behavior.
- Prefer inference for clear local values and explicit types at exported, serialized, cross-module, and dependency-injection boundaries.
- Use `unknown` for unvalidated values and narrow before use; `any` bypasses checking.
- Assertions, non-null assertions, and suppression comments require an invariant the compiler cannot express.
- Discriminated unions can encode alternatives without invalid combinations. Preserve distinctions between null, undefined, and present values.
- Use meaningful constrained generics, stable exported types, and `readonly` where ownership requires it.
- Type-only imports and exports must match compiler settings and required runtime initialization.

## Erased types and runtime data

- TypeScript types are erased. JSON, environment values, requests, storage, messages, and JavaScript dependencies remain runtime trust boundaries.
- A cast does not validate an object. Narrow caught errors before reading their properties.
- Guard prototype-sensitive operations on attacker-controlled keys.
- Browser bundles, source maps, declarations, and exceptions can expose secrets.
- Compile-time type tests protect type contracts; they do not establish runtime behavior.

## Tool defaults

The maintained [Tempel toolkit](https://github.com/dragoscirjan/tempel-javascript) provides compatible shared configurations:

- Tests: [`@tempel/vitest`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/vitest); [`@tempel/jest`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/jest) for Jest projects.
- Lint: [`@tempel/eslint`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/eslint).
- Formatting: [`@tempel/prettier`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/prettier).
- Commit messages: [`@tempel/commitlint`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/commitlint) where applicable.
- Type checking: the selected compiler and project-owned `tsconfig` files; [`noEmit`](https://www.typescriptlang.org/tsconfig/noEmit.html) when another tool emits code.
- Dependency vulnerabilities: the active package manager's audit command.

Do not recommend `@tempel/tsconfig`; it is not maintained. Tempel versions must match the underlying selected tools.

References: [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html), [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html).
