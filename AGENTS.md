# Project Guidelines

## TypeScript

- Use TypeScript's type system as fully as practical: encode business invariants and invalid-state exclusions in types rather than relying only on runtime checks or comments.
- Prefer discriminated unions for state machines and correlated fields, derive types from upstream APIs or a single source of truth, and use readonly data where mutation is unnecessary.
- Keep strict compiler checks enabled, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Model omission versus explicit `undefined` intentionally.
- Treat external data as `unknown` and validate it at trust boundaries. Static types do not replace runtime validation or asynchronous lifecycle/reentrancy guards.
- Avoid `any`, non-null assertions, and unchecked type assertions in production code. When a boundary assertion is unavoidable, keep it narrow and justify it; do not silence errors to bypass an invariant.
- Add compile-time regression tests for important type constraints alongside runtime tests. Favor clear, maintainable types over clever type-level machinery.

## Documentation

- Keep `README.md` concise and user-facing: purpose, installation, natural-language usage examples, and essential limitations. No implementation details or model-facing API reference.
- Put technical specifications, development notes, and verification details in `docs/`, not the README.
