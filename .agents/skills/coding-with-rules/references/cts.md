# .cts rules

Prerequisite: Read [TypeScript rules](ts.md) first. If already loaded for this task, do not read it again.

- `.cts` is CommonJS TypeScript. Node-aware compiler modes emit `.cjs` and use `.d.cts` declarations.
- `module`, `moduleResolution`, and `verbatimModuleSyntax` constrain permitted module syntax and emit.
- Preserve public export shapes consumed by CommonJS callers.
- Type-only imports/exports must not remove required runtime loading.
- Dynamic `import()` provides asynchronous ESM interoperability; handle its namespace result explicitly.
- CommonJS initialization is synchronous; top-level `await` is not permitted.
- Preserve package `exports` `require` conditions and avoid duplicate ESM/CommonJS state.
- Type checking, emitted/bundled behavior, published declarations, and execution through the target CommonJS loader are distinct compatibility contracts.

Reference: [TypeScript modules](https://www.typescriptlang.org/docs/handbook/modules/reference.html).
