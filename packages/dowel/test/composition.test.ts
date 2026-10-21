import { describe, expect, test } from 'bun:test'
import {
	bind,
	container,
	DowelError,
	execution,
	optional,
	scope,
	service,
	slot,
} from '../src/index.ts'
import { Logger, memoryLogger, Request, untyped } from './support.ts'

describe('multi-bindings', () => {
	const Middleware = slot('Middleware', { many: true })<(input: string) => string>()
	const Chain = service('Chain', { middleware: Middleware }, ({ middleware }) => ({
		run: (input: string) => middleware.reduce((acc, m) => m(acc), input),
	}))

	test('contributions resolve in order; an empty set is fine', async () => {
		expect((await container().provide(Chain).build()).get(Chain).run('x')).toBe('x')
		const Upper = service('Upper', () => (s: string) => s.toUpperCase())
		const app = await container()
			.provide(Chain)
			.contribute(Middleware, Upper)
			.contribute(Middleware, (s) => `${s}!`)
			.build()
		expect(app.get(Chain).run('hi')).toBe('HI!')
		expect(app.get(Middleware)).toHaveLength(2)
	})

	test('a multi-binding can be overridden wholesale', async () => {
		const Upper = service('Upper', () => (s: string) => s.toUpperCase())
		const app = await container()
			.provide(Chain)
			.contribute(Middleware, Upper)
			.override(Middleware, [(s: string) => `[${s}]`])
			.build()
		expect(app.get(Chain).run('a')).toBe('[a]')
	})

	test('a multi-binding without contributions can be overridden too', async () => {
		const app = await container()
			.provide(Chain)
			.override(Middleware, [(s: string) => `<${s}>`])
			.build()
		expect(app.get(Chain).run('a')).toBe('<a>')
	})

	test('contribute() rejects ordinary slots and duplicate contributions', () => {
		expect(() => untyped(container()).contribute(Logger, memoryLogger())).toThrow(
			/not a multi-binding/,
		)
		const Upper = service('Upper', () => (s: string) => s.toUpperCase())
		expect(() => container().contribute(Middleware, Upper).contribute(Middleware, Upper)).toThrow(
			/already contributed/,
		)
	})
})

describe('overrides', () => {
	const Config = slot('Config')<{ url: string }>()
	const Db = service('Db', { config: Config }, ({ config }) => ({
		query: (): string => config.url,
	}))
	const Users = service('Users', { db: Db }, ({ db }) => ({ list: () => db.query() }))

	test('override a service with a value, dropping what only it needed', async () => {
		const app = await container()
			.provide(Users)
			.override(Db, { query: () => 'fake' })
			.build()
		expect(app.get(Users).list()).toBe('fake')
		expect(app.get(Db).query()).toBe('fake')
	})

	test('override a service with a service', async () => {
		let realCreated = false
		const Real = service('Real', () => {
			realCreated = true
			return { query: (): string => 'real' }
		})
		const Consumer = service('Consumer', { db: Real }, ({ db }) => db.query())
		const Fake = service('Fake', () => ({ query: (): string => 'fake' }))
		const app = await container().provide(Consumer).override(Real, Fake).build()
		expect(app.get(Consumer)).toBe('fake')
		expect(app.get(Real)).toBe(app.get(Fake))
		expect(realCreated).toBe(false)
		const byName = new Map(app.inspect().map((n) => [n.name, n]))
		expect(byName.get('Real')).toMatchObject({
			kind: 'service',
			binding: { kind: 'service', name: 'Fake' },
		})
	})

	test('a later provide() does not undo an override', async () => {
		const A = service('A', () => 1)
		const AsyncA = service('AsyncA', async () => 2)
		const B = service('B', { a: A }, ({ a }) => a)
		const app = await container().provide(A).override(A, AsyncA).provide(B).build()
		expect(app.get(B)).toBe(2)
	})

	test('override a slot binding', async () => {
		const Svc = service('Svc', { log: Logger }, ({ log }) => log)
		const replacement = memoryLogger()
		const app = await container()
			.provide(Svc)
			.bind(Logger, memoryLogger())
			.override(Logger, replacement)
			.build()
		expect(app.get(Svc)).toBe(replacement)
	})

	test('override targets must be in the graph; self-overrides and cycles are rejected', async () => {
		const Other = service('Other', () => 1)
		const base = container().provide(Users).bind(Config, { url: 'x' })
		await expect(untyped(base).override(Other, 2).build()).rejects.toThrow(/not reachable/)
		await expect(untyped(base).override(Logger, memoryLogger()).build()).rejects.toThrow(
			/not bound/,
		)
		const A = service('A', () => 1)
		expect(() => untyped(container().provide(A)).override(A, A)).toThrow(/cannot override itself/)
		const B = service('B', { a: A }, ({ a }) => a + 1)
		const C = service('C', () => 3)
		await expect(
			untyped(container().provide(B)).override(A, C).override(C, B).build(),
		).rejects.toThrow(/cycle/i)
	})
})

describe('validation', () => {
	test('unbound root slots fail at build with the dependency path', async () => {
		const Inner = service('Inner', { log: Logger }, ({ log }) => log)
		const Outer = service('Outer', { inner: Inner }, ({ inner }) => inner)
		await expect(untyped(container().provide(Outer)).build()).rejects.toThrow(
			"Slot 'Logger' is not bound. Needed by Outer → Inner → Logger.",
		)
	})

	test('a required edge keeps a slot required even when another edge is optional', async () => {
		const Metrics = slot('Metrics')<number>()
		const Loose = service('Loose', { m: optional(Metrics) }, ({ m }) => m)
		const Strict = service('Strict', { m: Metrics }, ({ m }) => m)
		await expect(untyped(container().provide(Loose, Strict)).build()).rejects.toThrow(/not bound/)
		const Both = service('Both', { a: Metrics, b: optional(Metrics) }, ({ a }) => a)
		await expect(untyped(container().provide(Both)).build()).rejects.toThrow(/not bound/)
	})

	test('binding a root slot to a scoped service is rejected', () => {
		const Scoped = service('Scoped', { req: Request }, () => memoryLogger())
		expect(() => bind(Logger, untyped(Scoped))).toThrow(DowelError)
	})

	test('duplicate bindings and names are rejected', async () => {
		expect(() =>
			container().bind(Logger, memoryLogger()).provide(bind(Logger, memoryLogger())),
		).toThrow(/already bound/)
		const A = service('Same', () => 1)
		const B = service('Same', () => 2)
		const Both = service('Both', { a: A, b: B }, ({ a, b }) => a + b)
		await expect(untyped(container().provide(Both)).build()).rejects.toThrow(/named 'Same'/)
	})

	test('get() rejects unknown nodes with a helpful message', async () => {
		const Known = service('Known', () => 1)
		const Unknown = service('Unknown', () => 2)
		const app = await container().provide(Known).build()
		expect(() => untyped(app).get(Unknown)).toThrow(/not reachable/)
		expect(() => untyped(app).get({})).toThrow(DowelError)
		expect(() => untyped(app).get(container())).toThrow(/dowel node/)
	})

	test('error codes are stable', async () => {
		const error = await untyped(container().provide(service('S', { log: Logger }, () => 1)))
			.build()
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(DowelError)
		expect((error as DowelError).code).toBe('UNBOUND_SLOT')
	})
})

describe('declaration rules mirror the types', () => {
	// The same cases types.test-d.ts asserts at the type level, checked at runtime.
	test('scope inference', () => {
		const SessionScope = scope('session')
		const RequestScope = scope('request', SessionScope)
		const Sess = slot('Sess', { scope: SessionScope })<number>()
		const Req = slot('Req', { scope: RequestScope })<number>()
		const Root = service('Root', () => 1)
		expect(Root.scope).toBe('root')
		const Deep = service('Deep', { sess: Sess, req: Req, root: Root }, (d) => d)
		expect(Deep.scope).toBe('request')
		const Explicit = service('Explicit', { root: Root }, (d) => d, { scope: RequestScope })
		expect(Explicit.scope).toBe('request')
		const Job = execution('Job', { scope: RequestScope, entry: Deep, inputs: { req: Req } })
		expect(Job.scope).toBe('session')
	})

	test('build works detached from its builder', async () => {
		const { build } = container().provide(service('Detached', () => 1))
		const app = await build()
		expect(app.inspect()[0]!.name).toBe('Detached')
	})

	test("the container's own scope name is reserved", () => {
		expect(() => scope('root' as string, scope('outer'))).toThrow(/reserved/)
	})

	test('only services and values can stand in for a node', () => {
		const Other = slot('Other')<{ info(message: string): void }>()
		expect(() => bind(Logger, untyped(Other))).toThrow(/Slot 'Other' cannot stand in/)
	})

	test('nodes from another copy of dowel are named as such', () => {
		const foreign = Object.freeze({
			'~kind': 'slot',
			name: 'Foreign',
			[Symbol('dowel.internal')]: { kind: 'slot', id: 0, name: 'Foreign' },
		})
		expect(() => bind(untyped(foreign), 1)).toThrow(/different copy of dowel/)
	})

	test('a service keeps the dependencies it was declared with', async () => {
		const deps: Record<string, unknown> = { log: Logger }
		const Logs = service('Logs', deps as { log: typeof Logger }, ({ log }) => log)
		Object.assign(deps, { req: Request })
		const app = await container().provide(Logs).bind(Logger, memoryLogger()).build()
		expect(app.get(Logs)).toHaveProperty('info')
	})

	test('an explicit scope on another branch is reported as such', () => {
		const Left = scope('left')
		const Right = scope('right')
		const OnLeft = slot('OnLeft', { scope: Left })<number>()
		expect(() => service('Cross', { l: OnLeft }, (d) => d, { scope: untyped(Right) })).toThrow(
			/different scope branch/,
		)
	})
})
