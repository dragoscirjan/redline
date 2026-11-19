# .mts rules

Prerequisite: Read [TypeScript rules](ts.md) first. If already loaded for this task, do not read it again.

- `.mts` is ECMAScript-module TypeScript. Node-aware compiler modes emit `.mjs` and use `.d.mts` declarations.
- `module` and `moduleResolution` define resolution and emit. Node.js rules must not be assumed for bundlers, browsers, Deno, or Bun.
- Runtime import specifiers target the emitted environment. Node-aware output can require the emitted extension rather than `.mts`.
- `import type` and `export type` must match emit and `verbatimModuleSyntax` settings.
- CommonJS globals and synchronous `require` are not native ESM features.
- Use supported `import.meta` for module metadata.
- Preserve explicit CommonJS interoperability and conditional package exports.
- Top-level `await` affects evaluation order and startup.
- Type checking, emitted/bundled behavior, published declarations, and execution through the target ESM loader are distinct compatibility contracts.

Reference: [TypeScript modules](https://www.typescriptlang.org/docs/handbook/modules/reference.html).
