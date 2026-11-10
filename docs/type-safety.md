# Type-safety design and verification

The project uses strict TypeScript to encode business invariants, not only object shapes. External tool arguments, persisted historical data, and package JSON remain untrusted at runtime.

## Invariants

- `SpawnInput` combines an action-specific payload with `ModelSelection`: provider/model are both present or both omitted. Optional `never` fields exclude send-only options and prevent mixed-action payloads from slipping through intermediate variables.
- `SendInput` excludes spawn configuration. `ParsedSendInput` additionally guarantees that `followUp` is a boolean after parsing.
- Inputs, configuration snapshots, submission metadata, and reports are readonly. This is a compile-time API contract, not runtime freezing; snapshots still copy primitive values before asynchronous startup.
- Thinking levels and RPC dispositions derive from SDK types. A compile-time regression check also verifies that the runtime thinking-level list covers exactly the SDK union.
- A reservation's `Lifecycle` is a discriminated union. Only `ready` carries a guaranteed usable child. Cleanup resources are tracked separately because a synchronous factory or subscription callback can re-enter shutdown before returning a resource. Cleanup defers one microtask to capture those late assignments.
- Renderer callbacks are checked against the concrete tool schema without `any`; historical and partially streamed call arguments are intentionally accepted as `unknown` and inspected defensively.
- Package manifests are parsed as `unknown` and structurally validated before fields are used.

## Compiler checks

In addition to `strict`, `tsconfig.json` enables:

- `noUncheckedIndexedAccess`: indexed array/string access may be absent.
- `exactOptionalPropertyTypes`: omitted fields differ from explicitly assigned `undefined`. Explicit `undefined` is allowed only where the API intentionally supports it, such as captured optional parent context and cleared resource slots.
- `noImplicitReturns` and `noFallthroughCasesInSwitch`: control-flow mistakes are reported.
- `noUnusedLocals`, `noUnusedParameters`, and `noImplicitOverride`: catch unused declarations and require explicit overrides if inheritance is introduced.

`tests/types.typecheck.ts` is included by TypeScript but excluded from the runtime test filename pattern. Its intentional `@ts-expect-error` cases make typecheck fail if important constraints are weakened. Run:

```sh
npm run typecheck
npm test
```

Runtime tests remain essential. TypeScript does not prove nonblank strings, unique child names, RPC readiness, or the absence of reentrant shutdown across an `await`. Boundary validation and current-record checks must not be removed merely because a caller has a static type.
