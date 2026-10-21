/**
 * Type-level tests, checked by `tsc` and never executed: many of the calls
 * below are deliberately invalid and would throw at runtime.
 */
import { expectTypeOf } from 'bun:test'
import {
	bind,
	type CompositionIssues,
	type Container,
	type ContainerBuilder,
	type ContainerState,
	container,
	type Infer,
	type MissingBindings,
	service,
	slot,
} from '../../src/index.ts'
import { Config, Logger, test, Users } from './support.ts'

test('multi-bindings', () => {
	type Middleware = (next: () => void) => void
	const Middleware = slot('Middleware', { many: true })<Middleware>()
	const Auth = service('Auth', { log: Logger }, (): Middleware => (next) => next())
	const Server = service('Server', { middleware: Middleware }, ({ middleware }) => middleware)
	expectTypeOf<Infer<typeof Middleware>>().toEqualTypeOf<readonly Middleware[]>()
	expectTypeOf<Infer<typeof Server>>().toEqualTypeOf<readonly Middleware[]>()

	// Never required: a set may be empty.
	void (async () => {
		const empty = await container().provide(Server).build()
		expectTypeOf(empty.get(Middleware)).toEqualTypeOf<readonly Middleware[]>()
		const full = await container()
			.provide(Server)
			.contribute(Middleware, Auth)
			.contribute(Middleware, (next) => next())
			.bind(Logger, { info() {} })
			.build()
		expectTypeOf(full.get(Server)).toEqualTypeOf<readonly Middleware[]>()
	})()
	// Contributing Auth pulls its own requirements in.
	// @ts-expect-error: Logger is now required
	container().provide(Server).contribute(Middleware, Auth).build()
	// @ts-expect-error: wrong item type
	bind(Middleware, 1)
})

test('build is only callable when every reachable root slot is bound, and says who needs what', () => {
	const incomplete = container().provide(Users)
	expectTypeOf(incomplete.build).toEqualTypeOf<MissingBindings<{ readonly Logger: 'Users' }>>()
	// @ts-expect-error: not callable
	incomplete.build()

	const complete = incomplete.bind(Logger, { info() {} })
	expectTypeOf(complete.build).toBeFunction()
	expectTypeOf(complete.build()).resolves.toMatchTypeOf<Container<any>>()
})

test('activation: bindings are not roots', () => {
	const Expensive = service('Expensive', { log: Logger }, () => 1)
	const Unused = slot('Unused')<number>()
	// Binding Unused to Expensive makes neither reachable, so Logger is not required...
	const app = container().provide(Config).bind(Unused, Expensive).build()
	void (async () => {
		const built = await app
		// @ts-expect-error: ...and the slot cannot be resolved.
		built.get(Unused)
	})()
	// Providing the slot activates it and brings Logger in.
	// @ts-expect-error: Logger missing
	container().provide(Config, Unused).bind(Unused, Expensive).build()
	void (async () => {
		const built = await container()
			.provide(Unused)
			.bind(Unused, Expensive)
			.bind(Logger, { info() {} })
			.build()
		expectTypeOf(built.get(Unused)).toEqualTypeOf<number>()
	})()
})

test('overrides are exact and survive later provides', () => {
	const ApiKey = slot('ApiKey')<string>()
	const Remote = service('Remote', { key: ApiKey }, ({ key }) => ({ fetch: () => key }))
	const Client = service('Client', { remote: Remote }, ({ remote }) => remote.fetch())

	// @ts-expect-error: ApiKey missing
	container().provide(Client).build()
	const Fake = service('FakeRemote', () => ({ fetch: (): string => 'fake' }))
	void (async () => {
		const app = await container().provide(Client).override(Remote, Fake).build()
		expectTypeOf(app.get(Client)).toEqualTypeOf<string>()
		expectTypeOf(app.get(Remote).fetch).toEqualTypeOf<() => string>()
		// @ts-expect-error: not reachable
		app.get(ApiKey)

		// A later provide() of something that depends on Remote keeps the override.
		const Later = service('Later', { remote: Remote }, ({ remote }) => remote)
		const kept = await container().provide(Client).override(Remote, Fake).provide(Later).build()
		expectTypeOf(kept.get(Later).fetch).toEqualTypeOf<() => string>()
	})()

	container()
		.provide(Client)
		.override(Remote, { fetch: () => 'value' })
		.build()
	// @ts-expect-error: wrong shape
	container().provide(Client).override(Remote, { nope: true })
	// An override is checked against the finished composition, so it may come first.
	const Mailer = service('Mailer', () => ({ send() {} }))
	const early = container()
		.override(Mailer, { send() {} })
		.provide(Mailer)
	expectTypeOf(early.build).toBeFunction()
	expectTypeOf(
		container()
			.provide(Client)
			.override(Mailer, { send() {} }).build,
	).toEqualTypeOf<CompositionIssues<"'Mailer' is overridden but nothing provided reaches it">>()
})

test('build() reports bindings made twice and dependency cycles', () => {
	expectTypeOf(
		container()
			.provide(Users)
			.bind(Logger, { info() {} })
			.bind(Logger, { info() {} }).build,
	).toEqualTypeOf<
		CompositionIssues<"'Logger' is bound twice; use override() to replace a binding">
	>()

	const Plugins = slot('Plugins', { many: true })<string>()
	const Plugin = service('Plugin', () => 'p')
	expectTypeOf(
		container().provide(Plugins).contribute(Plugins, Plugin).contribute(Plugins, Plugin).build,
	).toEqualTypeOf<CompositionIssues<"'Plugin' is contributed to 'Plugins' twice">>()
	// Values may be contributed any number of times.
	expectTypeOf(
		container().provide(Plugins).contribute(Plugins, 'a').contribute(Plugins, 'a').build,
	).toBeFunction()

	const A = service('A', () => 1)
	const B = service('B', { a: A }, ({ a }) => a + 1)
	expectTypeOf(container().provide(B).override(A, B).build).toEqualTypeOf<
		CompositionIssues<"'A' depends on itself through 'B'">
	>()
	const Port = slot('Port')<number>()
	const UsesPort = service('UsesPort', { port: Port }, ({ port }) => port)
	expectTypeOf(container().provide(UsesPort).bind(Port, UsesPort).build).toEqualTypeOf<
		CompositionIssues<"'Port' depends on itself through 'UsesPort'">
	>()
})

test('with() applies composition functions', () => {
	const infra = <S extends ContainerState>(b: ContainerBuilder<S>) => b.bind(Logger, { info() {} })
	const app = container().with(infra).provide(Users)
	expectTypeOf(app.build).toBeFunction()
	// Overrides work in generic compositions too: they are checked when the state is known.
	const fakeConfig = <S extends ContainerState>(b: ContainerBuilder<S>) =>
		b.override(Config, { dbUrl: 'memory://' })
	expectTypeOf(
		container()
			.provide(Users)
			.bind(Logger, { info() {} })
			.with(fakeConfig).build,
	).toBeFunction()
	const inline = container().with((b) => b.bind(Logger, { info() {} }).provide(Users))
	expectTypeOf(inline.build).toBeFunction()
})
