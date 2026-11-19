# Zig rules

## Allocation and errors

- Compiler version, target, optimization mode, and safety mode determine language and library behavior.
- Pass allocators explicitly and define who frees returned memory.
- Pair acquisition with `defer` or `errdefer` at the ownership boundary; cleanup order and successful ownership transfer matter.
- Model absence, failure, and alternatives with optionals, error unions, and tagged unions.
- Panics and `unreachable` require proven invariants, not recoverable input or allocation failure.
- Keep error sets explicit and `comptime` work deterministic and bounded.
- Preserve exported ABI, layout, dependency hashes, and build metadata.

## Memory and native boundaries

- Validate lengths, indexes, casts, alignments, sentinel assumptions, and arithmetic before allocation or memory access.
- Initialize storage before reading. Pointer/slice lifetime and provenance must survive reallocations and foreign calls.
- Isolate pointer casts, manual layout, unchecked arithmetic, and disabled safety checks behind documented invariants.
- Handle out-of-memory, partial initialization, I/O failure, and cleanup without assuming allocation succeeds.
- Thread safety includes synchronization, atomics, and allocator-sharing contracts.
- Parsing and C ABI boundaries require valid lengths, ownership, and layout assumptions.

## Tool defaults

- Formatting: `zig fmt --check`.
- Builds: `zig build` for selected targets/modes.
- Tests: `zig test`, or `zig build test` when the build graph owns configuration.
- Compiler diagnostics and runtime safety checks are complementary, not substitutes for behavior tests.
- Relevant cases include allocation failure, cleanup order, error unions, safety modes, target-specific behavior, and C interoperability.
- There is no universal separate static-analysis or dependency-audit fallback; support depends on the selected toolchain.

References: version-matched [Zig language reference](https://ziglang.org/documentation/master/), [style guide](https://ziglang.org/documentation/master/#Style-Guide), and [build-system guide](https://ziglang.org/learn/build-system/).
