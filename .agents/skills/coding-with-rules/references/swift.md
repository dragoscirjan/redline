# Swift rules

## Values and memory

- Language mode, toolchain, SDK, deployment target, and availability policy define usable APIs.
- Prefer structs/enums for independent values; classes and actors express identity, shared lifetime, inheritance, or isolation.
- Handle optionals explicitly. Force unwraps, force casts, and implicitly unwrapped optionals require a locally proven invariant.
- Preserve throwing contracts and error causes; recoverable errors must not become traps.
- Choose concrete, opaque, existential, protocol, and generic types to match actual call contracts.
- Closure captures need explicit ownership. Break retain cycles; `unowned` requires guaranteed lifetime dominance.
- Preserve ABI/library evolution, package products, Codable formats, and persisted data.

## Concurrency and interop

- Prefer structured concurrency with task ownership, cancellation, and bounded lifetimes. Detached tasks require intentional isolation.
- Do not block cooperative executors with synchronous waits or CPU work without an explicit executor boundary.
- Respect actor/global-actor isolation and UI main-actor requirements.
- `Sendable` is a safety contract. Every `@unchecked Sendable` conformance needs an invariant covering reachable mutable state.
- Resume checked continuations exactly once on each path and preserve cancellation through callback bridges.
- Decodable structure alone does not establish valid values. Bound collections, recursion, decompression, and concurrent work.
- Unsafe pointers require valid lifetime and alignment. Isolate C, Objective-C, C++, and unmanaged-memory interfaces.
- Secrets belong in appropriate platform facilities, not client-readable resources or packages.

## Tool defaults

- SwiftPM builds/tests: `swift build`, `swift test`.
- Xcode builds/tests: the project's `xcodebuild` schemes, configurations, and destinations.
- Framework: [Swift Testing](https://developer.apple.com/documentation/testing) or XCTest according to toolchain support.
- Formatting: [swift-format](https://github.com/swiftlang/swift-format).
- Analysis: [SwiftLint](https://github.com/realm/SwiftLint), compiler warnings, and configured concurrency checks.
- Relevant cases include reentrancy, cancellation, actor isolation, retain cycles, continuation completion, platform availability, and interop.
- There is no universal vulnerability-audit command for every Swift package/project type.

References: [Swift language](https://docs.swift.org/swift-book/documentation/the-swift-programming-language/), [API Design Guidelines](https://www.swift.org/documentation/api-design-guidelines/), [SwiftPM](https://docs.swift.org/package-manager/).
