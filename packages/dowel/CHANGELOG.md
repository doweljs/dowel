# @doweljs/core

## 0.6.0

### Minor Changes

- fd6d7d9: feat: declare a service that fills a slot with `Slot.implement()`, which needs no name and stands for the slot it's bound to, or with `Slot.implementAs()` when something refers to it; both check the factory against the slot, and `inspect()` reports the slot a service implements
- 14f1e42: breaking: move `bind()` and `optional()` onto slots, as `Slot.of()` and `Slot.optional()`
- ca008e0: feat: track calls to a service whose instance is a function: disposal aborts `ctx.signal` for calls in flight and waits for them before disposing the instance and its dependencies; pass `{ track: false }` to opt out

### Patch Changes

- 58265a2: fix: report a node typed `any`, such as one a failed import leaves, where it is passed: by key among dependencies and inputs, by option for a scope or entry, and by method at `build()` for `provide()`, `bind()`, `contribute()` and `override()`; nothing else reads it as every name or scope
- 8cb308b: fix: bind a value typed `any`, such as what `JSON.parse()` returns, as a value, instead of leaving `build()` uncallable over a scope that is not one literal name
- 58145ab: fix: list every name in a diagnostic that has several, such as each node that needs a missing slot, instead of the type that computes them
- ad85d41: fix: name a binding typed `any` passed to `open()`, such as one made by a failed import, instead of reporting it as a multi-binding or another scope's slot
- ee5b2d0: fix: keep `undefined` in a slot's or service's type when exactOptionalPropertyTypes is off, so factories, `Infer` and bindings see it

## 0.5.0

### Minor Changes

- f70126c: feat: reject a run whose body succeeded but whose disposal failed with a `DisposalError` that carries the body's result

## 0.4.0

### Minor Changes

- 540bd10: breaking: discontinue `@doweljs/vite` and `@doweljs/devtools`
- 540bd10: breaking: remove hot replacement (`@doweljs/core/hot`); a running application is rebuilt by its platform, not in place
- 603fc86: breaking: compare scopes by identity, reject two distinct scopes sharing a name wherever they meet, and refuse a scope named like one above it

### Patch Changes

- 540bd10: fix: say when a service adopts one resource twice, instead of blaming another service
- 540bd10: fix: throw `DISPOSED` from `inspect()` on a disposed container, as `get()` and `open()` do
- 540bd10: fix: return the same slot from the function `slot()` returns, however often it is called
- 540bd10: fix: reject `open()` when the container it opens from is disposed while its factories run
- 540bd10: fix: refuse `get()`, `open()` and `inspect()` as soon as a container's disposal starts
- 540bd10: fix: reject a value supplied to `open()` for a slot that only shares the name of the one the graph reaches

## 0.3.0

### Minor Changes

- c3cd479: A helper generic in a declaration's name can now use what it declares: pass it as a dependency, an execution's entry or input, a bound slot, a scope or to the builder. Declaring a node with a widened `string`, a pattern or a union is now reported at the name rather than in the declaration's type. When a helper passes such a name on, it is reported where the node is used: as a dependency, entry, input, bound or supplied slot, or a scope or its parent. `build()` reports what a builder is given, and any `string` or pattern name that a container reaches, a node's or a scope's, including one hidden behind a literal-named node. An `any` name is accepted where it is declared but reported wherever it is used, and so is a scope named `root`.

## 0.2.0

### Minor Changes

- 1f8bfdb: Runners take an optional `{ signal }` after the body. Aborted before the body starts, the run stops its scope's factories, disposes what it created and rejects with the signal's reason, leaving shared work above it running for others. Aborted while the body runs, it aborts the body's signal and the runs opened beneath it, and settles as the body does. A run started beneath a cancelled one never runs its body.
- f0b7992: Services reached only through an execution are now created by the first run that needs them, instead of by `build()` or `open()`. They live in the store of their own scope, which shares them with later runs and disposes them; a failed creation fails only the runs that need it and is retried on the next demand. `get()` accepts only what the container creates with itself, and reports the rest as `CreatedOnDemand` in the types and `CREATED_ON_DEMAND` at runtime: provide a service to create it eagerly.

### Patch Changes

- ddf7a1f: Disposal now aborts every run beneath a container, in opened containers and nested runs included, before waiting for any of them, so runs that wait on each other during shutdown no longer deadlock.
- 5278498: A run whose container is disposed after it finished initializing but before its body started no longer runs the body against disposed instances. The body never starts, and the run rejects with `DISPOSED`.

## 0.1.0

### Minor Changes

- First release: type-complete dependency injection for TypeScript, with hot replacement and devtools for Vite.
