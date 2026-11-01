# @doweljs/core

Type-complete dependency injection for TypeScript.

- **The compiler checks completeness.** A container can't be built with a slot unbound, opened without its scope's values, or asked for a node it can't see. The type errors name what is missing and who needs it.
- **Async only at the edges.** `build()` and `open()` return promises; `get()` never does. Independent async services start concurrently.
- **Scope is inferred.** Depend on a request-scoped slot and your service lives per request. Capturing a shorter-lived value in a longer-lived service is a compile error.
- **Ownership is explicit.** A service disposes exactly what it adopts, and a resource has one owner.
- **Child work is injectable.** An _execution_ hands a service a typed runner; each run gets its own short-lived container.
- **No decorators, reflection or proxies.** About 9 KB minified and gzipped; `get()` takes about 40 ns.

```ts
import { container, service, slot } from '@doweljs/core'

const Logger = slot('Logger')<{ info(message: string): void }>()
const Config = slot('Config')<{ dbUrl: string }>()

const Database = service('Database', { config: Config }, async ({ config }, ctx) =>
	ctx.adopt(await connect(config.dbUrl), (client) => client.close()),
)
const UserDirectory = service('UserDirectory', { db: Database, log: Logger }, ({ db, log }) => ({
	list: () => {
		log.info('listing users')
		return db.query('select * from users')
	},
}))

const app = await container()
	.provide(UserDirectory)
	.bind(Config, { dbUrl: process.env.DATABASE_URL! })
	.bind(Logger, console)
	.build()

app.get(UserDirectory).list()
await app.dispose()
```

Remove `.bind(Logger, …)` and `build()` stops being callable: its type becomes `MissingBindings<{ Logger: "UserDirectory" }>`.

## Slots

A slot is a named, typed gap the container fills. Slots are the only open points in a graph; everything else is wired automatically.

```ts
// Bound once per container.
const Logger = slot('Logger')<LoggerApi>()

// Supplied each time a container for PerRequest opens.
const PerRequest = scope('request')
const CurrentRequest = slot('CurrentRequest', { scope: PerRequest })<IncomingRequest>()

// Collects contributions into a readonly array.
const Middleware = slot('Middleware', { many: true })<Middleware>()
```

Names are unique within a container: the type system identifies nodes by name.

A slot also carries what can be done with it:

- `CurrentRequest.of(req)` binds it to a value or a service for `open()`, or contributes one item to a multi-binding.
- `Metrics.optional()` depends on it without requiring it bound.
- `Logger.implement(deps?, factory)` and `Logger.implementAs(name, deps?, factory)` declare a service that fills it: see [Implementing a slot](#implementing-a-slot).

## Services

A service lists its dependencies as values. Its requirements, its scope and whether it is async follow from them.

```ts
const UserDirectory = service(
	'UserDirectory',
	{ db: Database, log: Logger, metrics: Metrics.optional() },
	({ db, log, metrics }, ctx) => {
		ctx.defer(() => log.info('UserDirectory disposed'))
		return {
			list() {
				metrics?.increment('users.list')
				return db.query('select * from users')
			},
		}
	},
)
```

Hover `UserDirectory` to see the graph the compiler reasons about:

```ts
Service<UserDirectoryApi, {
	name: 'UserDirectory'; scope: 'root'; above: never
	graph: {
		UserDirectory: { kind: 'service'; scope: 'root'; deps: 'Database' | 'Logger' | 'Metrics'; optional: 'Metrics'; … }
		Database:      { kind: 'service'; scope: 'root'; deps: 'Config'; … }
		Config:        { kind: 'slot';    scope: 'root'; … }
		Logger:        { kind: 'slot';    scope: 'root'; … }
		Metrics:       { kind: 'slot';    scope: 'root'; … }
	}
}>
```

A service has one instance per container of its scope. The `scope` option places a service deeper than its dependencies imply, such as one unit of work per request although it only needs the database; shallower is a compile error.

### Implementing a slot

A service that fills a slot can be declared from the slot. Its factory's result is checked against the slot, so the factory needs no annotations and a mismatch is reported where it's declared:

```ts
const LinkStore = slot('LinkStore')<{ get(code: string): Promise<Link | undefined> }>()

const MemoryLinkStore = LinkStore.implement(() => {
	const links = new Map<string, Link>()
	return { get: async (code) => links.get(code) } // code: string
})

container().bind(LinkStore, MemoryLinkStore)
```

`implement()` needs no name: the implementation stands for the slot it's bound to. Its dependencies are listed under that slot, so a missing one reads `MissingBindings<{ Config: "LinkStore" }>`. It can fill any slot its type fits, or several, as one instance; for a multi-binding slot, it's one item. It has no identity of its own, so nothing can depend on it, provide, resolve or override it; `inspect()` and runtime errors show it as `LinkStore (implementation)`.

When something must refer to the implementation itself, name it with `implementAs()`. It's then an ordinary service that keeps its own type, so a test fake can offer controls the slot doesn't have:

```ts
const FakeClock = Clock.implementAs('FakeClock', () => {
	let now = 0
	return { now: () => now, set: (to: number) => void (now = to) }
})

app.get(FakeClock).set(1_000)
```

Without dependencies, neither takes options: pass `{}` as the dependencies to give a `scope`. `inspect()` reports the slot each service implements.

### Resources and disposal

The factory's context mirrors `AsyncDisposableStack`:

- `ctx.use(resource)` adopts a `Disposable` or `AsyncDisposable` and returns it.
- `ctx.adopt(value, dispose)` adopts anything else, with its disposer.
- `ctx.defer(fn)` runs a callback at disposal.
- `ctx.signal` aborts when the instance's disposal starts, even while its factory still runs. Pass it to slow startup work: `connect(url, { signal: ctx.signal })`.

Only what a factory adopts is disposed; adopting what another service owns is an error. Disposal runs last-in-first-out, inner scopes before outer ones, and waits for factories still running.

### Function services

A service whose instance is a function is an operation its callers run, and disposal waits for those runs as it does for runs of an [execution](#executions):

```ts
const Exec = service('Exec', { spawn: Spawn }, ({ spawn }, ctx) => async (command: string) => {
	const child = spawn(command, { signal: ctx.signal })
	return await child.result
}, { scope: Operation })
```

Each call that returns a promise is tracked until it settles. Once the container's disposal starts, `ctx.signal` aborts for calls in flight and for calls that start after; the instance's disposal waits for its calls before its own disposers run and its dependencies are disposed, then refuses further calls with `DISPOSED`. Results, `this`, properties and `new` pass through unchanged.

Pass `{ track: false }` when callers own what a call starts, such as a stream it returns. A function bound with `Slot.of()` is the binder's and is never tracked.

## Containers

```ts
const app = await container()
	.provide(UserDirectory, Mailer) // services; their dependencies are discovered
	.bind(Logger, PinoLogger) // a slot to a service…
	.bind(Config, { port: 3000 }) // …or to a value
	.contribute(Middleware, CorsMiddleware) // one item of a multi-binding
	.with(infrastructure) // apply a composition function
	.override(Database, fakeDatabase) // replace a node in the graph (tests)
	.build()
```

`provide()` names the roots. What they reach outside an execution is created at `build()`; what only an execution reaches is created by the first run that needs it (see [Executions](#executions)). A binding takes effect only once something reachable depends on its slot.

If a factory fails, `build()` disposes what it created and rejects; cleanup failures ride along in an `AggregateError`.

Builders are persistent: every call returns a new builder. Write reusable compositions generic in the state, so they apply anywhere in a chain:

```ts
const infrastructure = <S extends ContainerState>(b: ContainerBuilder<S>) =>
	b.bind(Logger, ConsoleLogger).bind(Mailer, SmtpMailer)

container().with(infrastructure).bind(Config, config).provide(Checkout).build()
```

`get()` is typed against what the container creates:

```ts
app.get(UserDirectory) // UserDirectoryApi
app.get(Mailer) // error: NotProvided<"Mailer">
app.get(CurrentUser) // error: NotVisible<"CurrentUser", "request">
app.get(SmtpConnection) // error: CreatedOnDemand<"SmtpConnection">, reached only through an execution
```

Overrides are exact: override `Database` with a fake, and nothing that only `Database` needed is required any more.

## Scopes

A scope is a lifetime shorter than the app's, such as one request. `open()` creates a child container for it, with the scope's slots bound to values; a missing value is a compile error naming the slot and what needs it.

```ts
await using request = await app.open(PerRequest, CurrentRequest.of(req))
request.get(CurrentUser) // created once per opened container
request.get(UserDirectory) // root-scope services are shared
```

**Always dispose what `open()` returns**, with `await using` or in a `finally`. A container keeps what it opened until that is disposed, so a dropped one lives on until its parent is disposed.

What the roots reach in a scope is created when its container opens, which is what keeps `get()` synchronous. Keep scoped factories cheap.

Scopes nest:

```ts
export const PerSession = scope('session')
export const PerRequest = scope('request', PerSession)

const CurrentSession = slot('CurrentSession', { scope: PerSession })<SessionData>()
const CurrentRequest = slot('CurrentRequest', { scope: PerRequest })<IncomingRequest>()

const Cart = service('Cart', { session: CurrentSession }, …)                               // lives in 'session'
const RequestHandler = service('RequestHandler', { request: CurrentRequest, cart: Cart }, …) // lives in 'request'

await using session = await app.open(PerSession, CurrentSession.of(data))
await using request = await session.open(PerRequest, CurrentRequest.of(req))
request.get(RequestHandler)   // sees request, session and root
session.get(RequestHandler)   // error: NotVisible<"RequestHandler", "request">
app.open(PerRequest, …)       // error: NotChildScope<"request", "root">
```

A service lives in the deepest scope among its dependencies; dependencies on different branches are rejected where it is declared. Declare each scope once and import it where it is used: two scopes sharing a name are rejected wherever they meet.

## Executions

Work a service starts and finishes on its own, such as a job or a message handler, is an execution: a scope, an entry in that scope or above, and the inputs each run supplies. Dependents receive a runner.

```ts
const PerJob = scope('job')
const CurrentJob = slot('CurrentJob', { scope: PerJob })<{ id: string }>()
const JobProcessor = service('JobProcessor', { job: CurrentJob, db: Database }, ({ job, db }) => ({
	run: () => db.process(job.id),
}))

const ProcessJob = execution('ProcessJob', {
	scope: PerJob,
	entry: JobProcessor,
	inputs: { job: CurrentJob },
})

const JobScheduler = service('JobScheduler', { processJob: ProcessJob }, ({ processJob }) => ({
	schedule: (id: string) => processJob({ job: { id } }, (processor) => processor.run()),
}))
```

Each run opens a container for the scope with the given inputs, hands the entry to the body, and disposes the container once the body settles. An execution without inputs takes only the body. `build()` isn't callable while the inputs don't cover what the entry needs: `IncompleteExecutions<{ ProcessJob: "Other" }>`.

What the entry reaches above the run's scope, and nothing provided reaches, is created by the first run that needs it, shared with later runs and disposed with its scope; a failed creation is retried on the next demand. `get()` refuses such a service with `CREATED_ON_DEMAND`; provide it to create it with the container.

A run belongs to the container its runner was resolved from. Disposing that container aborts the `signal` of the context the body receives as its second argument, `(entry, { signal })`, waits for the body to settle, then disposes the run. Every run beneath is aborted before any is waited for, so runs that wait on each other don't deadlock. A run whose owner is disposed before its body starts rejects with `DISPOSED`. A run whose body succeeds but whose disposal fails rejects with a `DisposalError` (`DISPOSAL_FAILED`): the body's result is on `value` and the disposal failure on `cause`, so a caller that must not repeat committed work can log it and carry on.

A caller cancels a run with `{ signal }` after the body, as in `processJob({ job }, body, { signal: AbortSignal.timeout(5_000) })`. Aborted before the body starts, the run disposes what it created and rejects with the signal's reason; aborted while the body runs, the body's `signal` aborts with that reason and the run settles as the body does. A run started beneath a cancelled one never runs its body.

## Multi-bindings

```ts
const Middleware = slot('Middleware', { many: true })<Middleware>()
const Server = service('Server', { middleware: Middleware }, ({ middleware }) =>
	createServer(middleware),
)

container()
	.provide(Server)
	.contribute(Middleware, AuthMiddleware)
	.contribute(Middleware, CorsMiddleware)
	.build()
```

Contributions resolve to a readonly array, in order; with none, to `[]`. `override()` on a multi-binding replaces the whole set.

## Introspection

`inspect()` describes every node: its scope, dependencies, binding, the slot it implements and instance status.

## Errors

Runtime errors are `DowelError`s with a stable `code`, such as `UNBOUND_SLOT`, `CAPTIVE_DEPENDENCY`, `CYCLE` or `DISPOSED`, and name the dependency path:

```text
Slot 'Logger' is not bound. Needed by Api → UserDirectory → Logger.
```

Well-typed code rarely reaches them; they are the safety net for `any` and dynamic composition.

## Notes

- **Cycles** can only come from a binding, an override or an execution whose entry reaches the service that runs it. All are rejected at build; the first two by the types too.
- **TypeScript 5.9 or later** is required.
- **Literal types.** TypeScript keeps nested functions' literal return types under inference: `service('S', () => ({ kind: () => 'a' }))` infers `() => "a"`. Annotate the return type when you want a wider one.
