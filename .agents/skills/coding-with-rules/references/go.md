# Go rules

## Values, errors, and concurrency

- `go.mod`, `go.work`, toolchain/version directives, build tags, target files, and cgo policy define the supported build contract.
- Design useful zero values. Distinguish nil behavior, ownership, mutation, and aliasing for slices, maps, pointers, channels, and function values.
- Define interfaces at the consuming boundary where appropriate; keep packages and exported APIs cohesive.
- Return contextual errors with wrapping that preserves `errors.Is` and `errors.As`. Logging and returning the same error need a deliberate ownership boundary.
- Propagate `context.Context` through operation boundaries and honor cancellation and deadlines. Store contexts only when an API specifically requires it.
- Each goroutine needs an owner, termination condition, and cancellation path. Channel closure belongs to its owner, not arbitrary receivers.
- Synchronization must preserve invariants without depending on scheduling, sleeps, or map behavior.
- Preserve wire formats, exported error contracts, flags, and module compatibility.

## Standard-library and module boundaries

- Bound HTTP bodies, decoding, decompression, allocation, retries, and concurrency.
- Use parameterized queries and context-appropriate standard-library templates.
- Use `exec.Command` or its context-aware equivalent with separate arguments, not untrusted shell source.
- HTTP clients and servers need appropriate timeouts, limits, TLS settings, and shutdown behavior.
- Validate archive entries, symlinks, redirects, and outbound destinations where containment matters.
- Replacements, generators, cgo libraries, build tools, and transitive modules are executable or supply-chain dependencies.
- `go mod tidy`, upgrades, and `go generate` mutate project inputs or outputs; they are not read-only validation commands.

## Tool defaults

- Formatting: [gofmt](https://pkg.go.dev/cmd/gofmt).
- Tests: `go test`; race detection, fuzzing, tags, and target matrices depend on supported targets.
- Analysis: `go vet` and [Staticcheck](https://staticcheck.dev/).
- Vulnerabilities: [govulncheck](https://go.dev/security/vuln/).
- Module integrity: `go mod verify`, distinct from vulnerability auditing.
- Relevant cases include nil/zero values, cancellation, goroutine termination, races, and build-tag combinations.

References: [official Go documentation](https://go.dev/doc/), [Google Go Style Guide](https://google.github.io/styleguide/go/). [Effective Go](https://go.dev/doc/effective_go) does not cover the complete modern ecosystem.
