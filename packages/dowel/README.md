# @doweljs/core

Type-complete dependency injection for TypeScript.

- **The compiler checks completeness.** A container can't be built while a slot it needs is unbound, can't be opened without its scope's values, and can't resolve a node it can't see. These are type errors that name what is missing and who needs it.
- **Async only at the edges.** `build()` and `open()` return promises; `get()` never does. Independent async services start concurrently, and a failed build disposes what it already created.
- **Scope is inferred.** Depend on a request-scoped slot and your service lives per request too. Capturing a shorter-lived value in a longer-lived service is a compile error.
- **Ownership is explicit.** A service disposes exactly the resources it adopts, and a resource can't have two owners.
- **Child work is injectable.** An _execution_ hands a service a typed runner for jobs and message handlers, each run in its own short-lived container.
- **No decorators, reflection or proxies.** Plain values, about 9 KB minified and gzipped, and a `get()` of about 40–50 ns.
- **Evolvable.** A container built from new code can take over from a running one: work in flight finishes on the old code, new work reaches the new, and state is handed over. Vite and `bun --hot` reload this way.

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

Remove `.bind(Logger, …)` and `build()` stops being callable. Its type becomes `MissingBindings<{ Logger: "Users" }>`: the missing slot, and what needs it.

## Concepts

### Slots

A slot is a named gap the container fills: a name and a type, with no implementation. Slots are the only open points in a graph; everything else is wired automatically.

```ts
// Bound once per container.
const Logger = slot('Logger')<LoggerApi>()

// Supplied each time a container for PerRequest opens.
const PerRequest = scope('request')
const Request = slot('Request', { scope: PerRequest })<IncomingRequest>()

// Collects contributions into a readonly array.
const Middleware = slot('Middleware', { many: true })<Middleware>()
```

Names must be unique within a container. The type system identifies nodes by name, and so does a successor resolving the nodes of the containers it took over from.

### Services

A service lists its dependencies as values. Its requirements, its scope and whether it is async are all inferred from them.

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

The service's type carries its whole subgraph. Hover `Users` to see the record the compiler reasons about:

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

A service has one instance per container of its scope: one in the app's container for root-scope services, one in each opened container for scoped ones. There are no other lifetimes.

The only option is `scope`. It places a service deeper than its dependencies imply, such as one unit of work per request although it only needs the database. Placing it shallower is a compile error.

#### Resources and disposal

The factory's context mirrors `AsyncDisposableStack`:

- `ctx.use(resource)` adopts a `Disposable` or `AsyncDisposable` and returns it.
- `ctx.adopt(value, dispose)` adopts anything else, with the function that disposes it.
- `ctx.defer(fn)` runs a callback at disposal.
- `ctx.signal` aborts when the instance's disposal starts, even if its factory is still running. Pass it to slow startup work: `connect(url, { signal: ctx.signal })`.

Only what a factory adopts is disposed. Returning a disposable value doesn't hand it to the container, and adopting a value another service already owns is an error.

Disposal runs last-in-first-out, inner scopes before outer ones, one scope at a time. It waits for factories still running, so their instances are disposed before what they depend on. A factory that ignores its signal and never settles keeps disposal waiting.

#### Effects

A root-scope service starts what must not run twice, such as consuming a queue or listening on a port, with `ctx.whileActive(start)` rather than in its factory:

```ts
const Server = service('Server', { handler: Handler }, ({ handler }, ctx) => {
	ctx.whileActive((previous) => {
		const server = listen(handler, { socket: socketFrom(previous) })
		return () => server.release()
	})
})
```

`start` runs once the container is built, and the function it returns runs when the instance is disposed. Its second argument carries the instance's `signal`, which aborts if the instance is disposed while `start` still runs. A stop function that throws may have left what it started running, so that effect is never started again. Factories that run while another container is still active, as a successor's do, start nothing they would have to undo: see [Evolution](#evolution). Register it while the factory runs, one effect per instance; anything else throws `INVALID_EFFECT`.

### Containers

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

What you `provide()` are the container's roots. What they reach outside an execution is created at `build()`; what only an execution reaches is created by the first run that needs it (see [Executions](#executions)), and nothing else is created at all. A binding alone activates nothing: `bind(Cache, RedisCache)` only takes effect once something reachable depends on `Cache`, or `Cache` itself is provided.

If a factory fails, `build()` disposes what it already created, then rejects. Failures during that cleanup are attached to the original error as an `AggregateError`.

Builders are persistent: every call returns a new builder, so a base composition can be shared between tests or environments. Write reusable composition functions generic in the state, so they apply anywhere in a chain:

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

Overrides are exact. Override `Db` with a fake, and nothing that only `Db` needed is required any more; `get(Db)` returns the fake.

### Scopes and containers

A scope is a lifetime shorter than the app's, such as one request. `open()` creates a child container for a scope, and you pass the scope's slots their values as bindings. The graph decides which values are required, so a missing one is a compile error naming the slot and what needs it.

```ts
await using request = await app.open(PerRequest, bind(Request, req))
request.get(CurrentUser) // created once per opened container
request.get(Users) // root-scope services are shared
```

**Always dispose what `open()` returns**, with `await using` or in a `finally`. A container keeps every container opened from it until they are disposed, so that disposing the app can still close them. One dropped without being disposed stays in memory, with everything it created, until its parent is disposed.

What the provided nodes reach in a scope, outside an execution, is created when its container opens, not when first resolved; that is what keeps `get()` synchronous. Keep factories in short-lived scopes cheap, and free of side effects a request may not need. What only an execution reaches is created by the first run that needs it (see [Executions](#executions)).

Scopes nest. Declare them as values, give slots a scope, and open containers one scope at a time:

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

A service lives in the deepest scope among its dependencies. Dependencies on different branches, such as a request-scope slot and a job-scope slot, are rejected where the service is declared.

Scopes are compared by lineage, their names from the root down, so a different scope that happens to share a name can't be opened in its place.

### Executions

Work a service starts and finishes on its own, such as a job, a message handler or a connection, is declared as an execution. It names a scope, an entry node in that scope or above, and the inputs each run supplies. Services depend on it like anything else and receive a runner.

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

Each call to the runner:

1. opens a container for the execution's scope, with the inputs it was given;
2. resolves the entry and hands it to the body;
3. disposes the container once the body settles, whether it returned or threw.

What the entry reaches in the scopes above the run's, and that nothing provided reaches outside an execution, is created on demand: the first run that needs it creates it, in the store of the scope it lives in, which shares it with later runs and disposes it with itself. Concurrent runs share one creation, and one that fails is created again on the next demand, so a misconfigured service fails the runs that need it rather than `build()`. `get()` can't return such a service, and throws `CREATED_ON_DEMAND`; provide it to create it with the container, and to have `build()` fail fast when it can't start.

The runner takes an object with a value for each input, typed from `inputs`. An execution without inputs takes only the body. `build()` isn't callable while the inputs don't cover what the entry needs: `IncompleteExecutions<{ RunJob: "Other" }>`.

A run belongs to the container its runner was resolved from. Disposing that container aborts the `signal` the body receives as its second argument, as in `runJob({ job }, (runner, { signal }) => runner.run(signal))`. It then waits for the body to settle before disposing the run's container and its own instances, so a body never sees what it uses closed beneath it. A body that ignores the signal keeps disposal waiting. Disposal aborts every run beneath the container, in opened containers and nested runs included, before it waits for any of them, so a run that waits on another during shutdown doesn't deadlock. A run whose disposal, or its owner's, starts before its body does never starts the body, and rejects with `DISPOSED`.

A caller cancels a run by passing a `signal` after the body, as in `runJob({ job }, body, { signal: request.signal })` or `{ signal: AbortSignal.timeout(5_000) }`. Aborted before the body starts, the run starts no more factories in its scope, aborts the `ctx.signal` of those still running, disposes what it created and rejects with the signal's reason. What it was waiting for in the scopes above keeps going for whoever shares it. Aborted while the body runs, it aborts the body's `signal` with the same reason, and the runs it opened beneath it too; the run still waits for the body and settles as the body does, so a body can return partial results or throw `signal.reason`. A run started beneath a cancelled one is cancelled from the start and never runs its body, so a body that needs to clean up after an abort does it itself, or in `ctx.defer`.

### Multi-bindings

```ts
const Middleware = slot('Middleware', { many: true })<Middleware>()
const Server = service('Server', { middleware: Middleware }, ({ middleware }) =>
	createServer(middleware),
)

container().provide(Server).contribute(Middleware, Auth).contribute(Middleware, Cors).build()
```

Contributions resolve to a readonly array, in the order they were contributed. A multi-binding never needs binding: with no contributions it resolves to `[]`. Contributing a service brings that service's own requirements into the container. `override()` on a multi-binding replaces the whole set.

### Introspection

`app.inspect()` and `request.inspect()` describe every node: its scope, dependencies, binding and instance status. [`@doweljs/devtools`](../devtools) shows the same, live, on the Vite dev server.

## Errors

Runtime errors are `DowelError`s with a stable `code`, such as `UNBOUND_SLOT`, `CAPTIVE_DEPENDENCY`, `CYCLE`, `INVALID_SCOPE` or `DISPOSED`. Messages include the dependency path:

```text
Slot 'Logger' is not bound. Needed by Api → Users → Logger.
```

Well-typed code rarely reaches them. They are a safety net for `any` and for dynamic composition.

## Evolution

`@doweljs/core/evolve` lets a container built from new code take over from a running one, without stopping the work in flight. Each container of such a lineage is a _generation_.

```ts
import { prepare } from '@doweljs/core/evolve'

const candidate = await prepare(app, nextBuilder) // `app` keeps running meanwhile
candidate.container.get(Health).check() // try the candidate before it takes over
const { generation, container, retired } = await candidate.activate({ drain: 30_000 })
```

`prepare(previous, next)` builds `next` as a _candidate_. Everything `build()` would create exists, and a factory that fails rejects as `build()` does, but no effect has started and `previous` keeps serving. `discard()` disposes a candidate without activating it.

`activate()` makes the candidate the active generation:

1. `previous` stops its effects, newest first. What each stop function returns is its _hand-over_.
2. The candidate starts its effects in creation order. Each `start` receives the hand-over of the service of the same name in `previous`, or `undefined`. A hand-over nothing claims passes on to the next generation.
3. `previous` forwards whatever it is asked to the candidate, its `superseded` signal included, which is then the candidate's. `get()` and `open()` reach the candidate, by name, so code still holding `previous` or its nodes reaches the new generation. A runner taken from `previous` starts each run on whichever generation is active by then.
4. Runs and containers opened from `previous` before that point finish on it, nested runs included: work is never split across two versions of the code. Their `superseded` signal aborts, so a long-running body can return early for its caller to start it again. Once they have finished, or after `drain` milliseconds, when what is left is cancelled, `previous` is disposed. `retired` settles when it is, and the generations still draining behind it too.

`activate({ timeout })` bounds how long each effect may take to stop or start. One that overruns fails the activation the same way, and an effect that overran its stop is never started again, since it may still hold what it started. Without a limit, the default, an effect that never settles holds the activation up. If either container is disposed while this happens, the candidate does not take over: a disposed predecessor takes the candidate with it, and a disposed candidate leaves the predecessor running. If an effect of the candidate fails to start, the ones that started stop again, `previous` resumes its effects with what they handed back, the candidate is disposed, and `activate()` rejects with `ACTIVATION_FAILED`. If one of `previous`'s effects fails to stop, it resumes the same way.

**Keep the container, not the services you get from it.** The container and the runners `get()` returns forward to the latest generation, but an instance `get()` returned belongs to the generation that created it. Nothing pins that generation for it, so it is disposed once its runs and opened containers have finished, and what the instance adopted, such as a connection, is closed. Call `get()` again where the instance is used, or reach it through a run.

Generations are numbered: 1 for a container `build()` returns, one more for each successor, in `activation.generation` and the second argument effects receive. The number only grows, so systems outside the process can refuse writes from a generation that was superseded. Disposing any container of a lineage disposes the latest, and the generations still draining behind it.

What is handed over crosses versions of the code, so `previous` is `unknown`: check its shape before use, and hand over plain data or platform objects (a socket, a child process) rather than instances of your own classes, which a reload may have evaluated again.

### Reloading

`hot(store, next)` builds `next` the first time a module is evaluated and has every later evaluation succeed the container built before. `store` is an object that outlives evaluations:

```ts
// Vite: @doweljs/vite accepts the update and shows failures in the error overlay.
export const app = await hot(import.meta.hot?.data, container().provide(Server))

// bun --hot, which evaluates every module again, dowel included.
const app = await hot(globalThis, container().provide(Server))
```

Without a store, as in a production build where `import.meta.hot` is undefined, `hot()` is `next.build()`. Evaluations that overlap evolve one after the other, so two generations never run at once; each effect gets ten seconds to stop or start (`{ timeout }`), so one that never settles fails its evaluation instead of holding up every evaluation after it. If a successor fails, the running container keeps serving, `hot()` rejects, and `onHotFailure()` listeners hear of it. `release(store)` disposes what a store keeps, for a module that is dropped or evaluated from scratch. A superseded generation's runs get five seconds to finish by default (`{ drain }`), and `{ name }` keeps several applications in one store apart. `snapshot()` describes every lineage `hot()` keeps, for [`@doweljs/devtools`](../devtools); `track(app)` shows a container built otherwise there too.

A successor may come from another copy of dowel, as under `bun --hot`, if `hot()` built the container it takes over from or activated it as a successor. Only the containers' public API and plain data cross between generations.

Everything but effects and the `superseded` signals lives in `@doweljs/core/evolve`, so applications that never evolve bundle none of it.

## Design notes

- **Cycles can't be declared.** Dependencies are values, and a `const` can't reference a later one. A cycle can only come from binding a slot to a service that depends on it, from `override()`, or from an execution whose entry reaches the service that runs it. All three are detected at build; the first two are also type errors, which `build()` reports.
- **Type-level cost.** The model is checked against a generated graph of 300 services in ten layers, 144 of them reachable from the roots (`test/types/scale.test-d.ts`). Checking the whole package takes about five seconds on TypeScript 5.9 and four to eight on TypeScript 7, mostly in that test. Builder types stay short because each step is an interface instantiation, not an expanded record.
- **TypeScript 5.9 or later.** Earlier versions, checked down to 5.5, accept small graphs but stop with "type instantiation is excessively deep" on one that size.
- **Declaration emit.** Builder steps over a generic state stay named (`Provide<Provide<S, A>, B>`) instead of expanding the merged graph, so libraries can export generic composition functions with declarations. The types an exported service, builder or container is inferred from are exported for the same reason.
- **Literal types.** TypeScript keeps the literal return types of nested functions during generic inference: `service('S', () => ({ kind: () => 'a' }))` infers `() => "a"`. Annotate the return type when you want a wider one. This is how inference works, not something dowel does.
