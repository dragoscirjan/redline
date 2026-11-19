# .pyi rules

Prerequisite: Read [Python rules](py.md) first. If already loaded for this task, do not read it again.

- Stubs are declarative runtime-interface definitions, not implementations. No runtime side effects or executable work beyond conditions allowed by the typing specification.
- Module names, exports, decorators, signatures, positional-only/keyword-only parameters, defaults, attributes, inheritance, and typed exception contracts must match the runtime.
- Overloads express real call-shape relationships. Prefer precise generics, protocols, and narrow unions to broad `Any` or overlapping overloads.
- Use `...` for defaults whose concrete values are not part of the type contract.
- Version/platform branches are justified only by actual interface differences. Syntax and typing features must support the selected Python/checker versions.
- Preserve intentional re-exports and public/private API boundaries.
- Stub and implementation interfaces must remain synchronized; type-checking success alone does not prove runtime parity.
- Accepted and rejected typing examples define static call compatibility.
- Interface-parity fallback: `stubtest` only where compatible with the selected checker and package.

References: [typing specification](https://typing.python.org/en/latest/spec/), [stub-writing guide](https://typing.python.org/en/latest/guides/writing_stubs.html).
