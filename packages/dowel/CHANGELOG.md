# @doweljs/core

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
