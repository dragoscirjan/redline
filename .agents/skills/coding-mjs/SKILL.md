---
name: coding-mjs
description: Write, refactor, review, or test .mjs JavaScript with ECMAScript-module loading, runtime-aware specifiers, import metadata, top-level await discipline, and CommonJS interoperability. Use whenever an .mjs file is changed.
compatibility: Requires the coding and coding-js skills and an ECMAScript-module runtime supported by the project.
metadata:
  author: dragoscirjan
  version: "1.0"
  opencode/slash: "true"
---

# MJS coding

Apply `coding`, then `coding-js`, then this extension-specific guidance.

## Load dependencies

Locate the advertised `coding` and `coding-js` skills by exact name and path. Read their `SKILL.md` files in that order unless they are already loaded.

If either dependency is unavailable, stop and ask the human to install or expose it. Do not install it automatically, duplicate its instructions, or rely on a harness-specific Skill tool.

## Preserve ECMAScript-module semantics

Use the [MDN modules guide](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules) and the project's runtime documentation. For Node.js package behavior, use the [Node.js packages documentation](https://nodejs.org/api/packages.html).

- Treat `.mjs` as an ECMAScript module regardless of the nearest Node.js `package.json` `type` field.
- Use `import` and `export`. Do not introduce `require`, `module.exports`, `exports`, `__filename`, or `__dirname` as if they were native ESM globals.
- Use `import.meta` and URL-aware APIs for module-relative resources when the runtime supports them.
- Follow the target runtime's specifier and file-extension rules. Do not rewrite specifiers based on one runtime's behavior when the project supports another.
- Keep package `exports` and conditional-export behavior compatible with existing consumers.
- Add a CommonJS interoperability boundary only when a real dependency requires one. Make default and named export conversion explicit.
- Use top-level `await` only when module evaluation order and startup latency are acceptable.
- Avoid dual-package state: do not expose separate ESM and CommonJS instances that should share identity or state.

Run the inherited JavaScript gates and test the module through the project's real ESM loader, not only through a transformed test environment.
