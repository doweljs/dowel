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

const Config = service('Config', () => ({ dbUrl: process.env.DATABASE_URL! }))
const Db = service('Db', { config: Config }, async ({ config }, ctx) =>
	ctx.adopt(await connect(config.dbUrl), (client) => client.close()),
)
const Users = service('Users', { db: Db, log: Logger }, ({ db, log }) => ({
	list: () => {
		log.info('listing users')
		return db.query('select * from users')
	},
}))

const app = await container().provide(Users).bind(Logger, { info: console.log }).build()

app.get(Users).list()
await app.dispose()
```

Remove `.bind(Logger, …)` and `build()` stops being callable: its type becomes `MissingBindings<{ Logger: "Users" }>`.

## Slots

A slot is a named, typed gap the container fills. Slots are the only open points in a graph; everything else is wired automatically.

```ts
// Bound once per container.
const Logger = slot('Logger')<LoggerApi>()

// Supplied each time a container for PerRequest opens.
const PerRequest = scope('request')
const Request = slot('Request', { scope: PerRequest })<IncomingRequest>()

// Collects contributions into a readonly array.
const Middleware = slot('Middleware', { many: true })<Middleware>()
```

Names are unique within a container: the type system identifies nodes by name.

## Services

A service lists its dependencies as values. Its requirements, its scope and whether it is async follow from them.

```ts
const Users = service(
	'Users',
	{ db: Db, log: Logger, metrics: optional(Metrics) },
	({ db, log, metrics }, ctx) => {
		ctx.defer(() => log.info('Users disposed'))
		return {
			list() {
				metrics?.increment('users.list')
				return db.query('select * from users')
			},
		}
	},
)
```

Hover `Users` to see the graph the compiler reasons about:

```ts
Service<UsersApi, {
	name: 'Users'; scope: 'root'; above: never
	graph: {
		Users:   { kind: 'service'; scope: 'root'; deps: 'Db' | 'Logger' | 'Metrics'; optional: 'Metrics'; … }
		Db:      { kind: 'service'; scope: 'root'; deps: 'Config'; … }
		Config:  { kind: 'service'; scope: 'root'; deps: never; … }
		Logger:  { kind: 'slot';     scope: 'root'; … }
		Metrics: { kind: 'slot';     scope: 'root'; … }
	}
}>
```

A service has one instance per container of its scope. The only option, `scope`, places a service deeper than its dependencies imply, such as one unit of work per request although it only needs the database; shallower is a compile error.

### Resources and disposal

The factory's context mirrors `AsyncDisposableStack`:

- `ctx.use(resource)` adopts a `Disposable` or `AsyncDisposable` and returns it.
- `ctx.adopt(value, dispose)` adopts anything else, with its disposer.
- `ctx.defer(fn)` runs a callback at disposal.
- `ctx.signal` aborts when the instance's disposal starts, even while its factory still runs. Pass it to slow startup work: `connect(url, { signal: ctx.signal })`.

Only what a factory adopts is disposed; adopting what another service owns is an error. Disposal runs last-in-first-out, inner scopes before outer ones, and waits for factories still running.

## Containers

```ts
const app = await container()
	.provide(Users, Mailer) // services; their dependencies are discovered
	.bind(Logger, PinoLogger) // a slot to a service…
	.bind(Config, { port: 3000 }) // …or to a value
	.contribute(Middleware, Cors) // one item of a multi-binding
	.with(infrastructure) // apply a composition function
	.override(Db, fakeDb) // replace a node in the graph (tests)
	.build()
```

`provide()` names the roots. What they reach outside an execution is created at `build()`; what only an execution reaches is created by the first run that needs it (see [Executions](#executions)). A binding takes effect only once something reachable depends on its slot.

If a factory fails, `build()` disposes what it created and rejects; cleanup failures ride along in an `AggregateError`.

Builders are persistent: every call returns a new builder. Write reusable compositions generic in the state, so they apply anywhere in a chain:

```ts
const infrastructure = <S extends ContainerState>(b: ContainerBuilder<S>) =>
	b.bind(Logger, ConsoleLogger).bind(Database, SqlDatabase)

container().with(infrastructure).bind(Config, config).provide(Checkout).build()
```

`get()` is typed against what the container creates:

```ts
app.get(Users) // UsersApi
app.get(Mailer) // error: NotProvided<"Mailer">
app.get(Current) // error: NotVisible<"Current", "request">
app.get(Smtp) // error: CreatedOnDemand<"Smtp">, reached only through an execution
```

Overrides are exact: override `Db` with a fake, and nothing that only `Db` needed is required any more.

## Scopes

A scope is a lifetime shorter than the app's, such as one request. `open()` creates a child container for it, with the scope's slots bound to values; a missing value is a compile error naming the slot and what needs it.

```ts
await using request = await app.open(PerRequest, bind(Request, req))
request.get(CurrentUser) // created once per opened container
request.get(Users) // root-scope services are shared
```

**Always dispose what `open()` returns**, with `await using` or in a `finally`. A container keeps what it opened until that is disposed, so a dropped one lives on until its parent is disposed.

What the roots reach in a scope is created when its container opens, which is what keeps `get()` synchronous. Keep scoped factories cheap.

Scopes nest:

```ts
export const Session = scope('session')
export const Request = scope('request', Session)

const Sess = slot('Sess', { scope: Session })<SessionData>()
const Req = slot('Req', { scope: Request })<IncomingRequest>()

const Cart = service('Cart', { sess: Sess }, …)                  // lives in 'session'
const Handler = service('Handler', { req: Req, cart: Cart }, …)  // lives in 'request'

await using session = await app.open(Session, bind(Sess, data))
await using request = await session.open(Request, bind(Req, req))
request.get(Handler)   // sees request, session and root
session.get(Handler)   // error: NotVisible<"Handler", "request">
app.open(Request, …)   // error: NotChildScope<"request", "root">
```

A service lives in the deepest scope among its dependencies; dependencies on different branches are rejected where it is declared. Declare each scope once and import it where it is used: two scopes sharing a name are rejected wherever they meet.

## Executions

Work a service starts and finishes on its own, such as a job or a message handler, is an execution: a scope, an entry in that scope or above, and the inputs each run supplies. Dependents receive a runner.

```ts
const Job = scope('job')
const JobInput = slot('JobInput', { scope: Job })<{ id: string }>()
const JobRunner = service('JobRunner', { input: JobInput, db: Db }, ({ input, db }) => ({
	run: () => db.process(input.id),
}))

const RunJob = execution('RunJob', { scope: Job, entry: JobRunner, inputs: { job: JobInput } })

const Scheduler = service('Scheduler', { runJob: RunJob }, ({ runJob }) => ({
	schedule: (id: string) => runJob({ job: { id } }, (runner) => runner.run()),
}))
```

Each run opens a container for the scope with the given inputs, hands the entry to the body, and disposes the container once the body settles. An execution without inputs takes only the body. `build()` isn't callable while the inputs don't cover what the entry needs: `IncompleteExecutions<{ RunJob: "Other" }>`.

What the entry reaches above the run's scope, and nothing provided reaches, is created by the first run that needs it, shared with later runs and disposed with its scope; a failed creation is retried on the next demand. `get()` refuses such a service with `CREATED_ON_DEMAND`; provide it to create it with the container.

A run belongs to the container its runner was resolved from. Disposing that container aborts the `signal` the body receives as its second argument, waits for the body to settle, then disposes the run. Every run beneath is aborted before any is waited for, so runs that wait on each other don't deadlock. A run whose owner is disposed before its body starts rejects with `DISPOSED`. A run whose body succeeds but whose disposal fails rejects with a `DisposalError` (`DISPOSAL_FAILED`): the body's result is on `value` and the disposal failure on `cause`, so a caller that must not repeat committed work can log it and carry on.

A caller cancels a run with `{ signal }` after the body, as in `runJob({ job }, body, { signal: AbortSignal.timeout(5_000) })`. Aborted before the body starts, the run disposes what it created and rejects with the signal's reason; aborted while the body runs, the body's `signal` aborts with that reason and the run settles as the body does. A run started beneath a cancelled one never runs its body.

## Multi-bindings

```ts
const Middleware = slot('Middleware', { many: true })<Middleware>()
const Server = service('Server', { middleware: Middleware }, ({ middleware }) =>
	createServer(middleware),
)

container().provide(Server).contribute(Middleware, Auth).contribute(Middleware, Cors).build()
```

Contributions resolve to a readonly array, in order; with none, to `[]`. `override()` on a multi-binding replaces the whole set.

## Introspection

`inspect()` describes every node: its scope, dependencies, binding and instance status.

## Errors

Runtime errors are `DowelError`s with a stable `code`, such as `UNBOUND_SLOT`, `CAPTIVE_DEPENDENCY`, `CYCLE` or `DISPOSED`, and name the dependency path:

```text
Slot 'Logger' is not bound. Needed by Api → Users → Logger.
```

Well-typed code rarely reaches them; they are the safety net for `any` and dynamic composition.

## Notes

- **Cycles** can only come from a binding, an override or an execution whose entry reaches the service that runs it. All are rejected at build; the first two by the types too.
- **TypeScript 5.9 or later** is required.
- **Literal types.** TypeScript keeps nested functions' literal return types under inference: `service('S', () => ({ kind: () => 'a' }))` infers `() => "a"`. Annotate the return type when you want a wider one.
