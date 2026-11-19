# Rust rules

## Ownership and APIs

- Edition, minimum supported Rust version, features, target triples, and workspace policy define compatibility.
- Express ownership, borrowing, mutability, and lifetimes directly. Cloning, reference counting, interior mutability, and `'static` bounds must serve actual contracts.
- Distinguish absence from failure. Preserve error identity/context and handle each `Result`; externally influenced paths need proven invariants before `unwrap`, `expect`, or unreachable assertions.
- Feature combinations must be coherent. Do not blindly enable mutually exclusive features.
- Preserve trait contracts, public semver expectations, serialization formats, and the workspace/application/library `Cargo.lock` policy.

## Unsafe and concurrency boundaries

- Keep unavoidable `unsafe` behind the smallest practical safe abstraction with explicit preconditions.
- Check pointer validity, alignment, initialization, aliasing, provenance, layout, and lifetime.
- Unsafe `Send` and `Sync` implementations must hold for all reachable mutable state.
- Avoid holding locks across blocking or async suspension unless the contract requires it.
- Build scripts, procedural macros, activated features, and native libraries execute code or expand the trusted dependency surface.
- Panic messages and debug formatting can expose sensitive data.

## Tool defaults

- Formatting: `cargo fmt --check` with [rustfmt](https://github.com/rust-lang/rustfmt).
- Compilation: `cargo check` for selected targets/features.
- Tests: `cargo test`, including relevant documentation tests.
- Analysis: [Clippy](https://doc.rust-lang.org/clippy/) with the configured lint policy.
- Vulnerabilities: [cargo audit](https://rustsec.org/).
- Dependency policy: [cargo deny](https://embarkstudios.github.io/cargo-deny/).
- Relevant cases include ownership transitions, panic/error paths, feature combinations, concurrency, and unsafe invariants.

References: [Rust Style Guide](https://doc.rust-lang.org/style-guide/), [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/), [Cargo Book](https://doc.rust-lang.org/cargo/), [Rustonomicon](https://doc.rust-lang.org/nomicon/).
