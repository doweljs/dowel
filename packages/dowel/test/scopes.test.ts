import { describe, expect, test } from 'bun:test'
import { bind, container, optional, scope, service, slot } from '../src/index.ts'
import { Logger, memoryLogger, nextTask, PerRequest, Request, untyped } from './support.ts'

describe('scopes', () => {
	const Current = service('Current', { req: Request, log: Logger }, ({ req, log }) => {
		log.info(`scope ${req.url}`)
		return { url: req.url }
	})

	test('scoped slots are supplied per opened container, and scoped services cached per container', async () => {
		const app = await container().provide(Current).bind(Logger, memoryLogger()).build()
		const a = await app.open(PerRequest, bind(Request, { url: '/a' }))
		const b = await app.open(PerRequest, bind(Request, { url: '/b' }))
		expect(a.get(Current).url).toBe('/a')
		expect(a.get(Current)).toBe(a.get(Current))
		expect(b.get(Current).url).toBe('/b')
		expect(a.get(Request).url).toBe('/a')
		expect(a.get(Logger)).toBe(app.get(Logger))
		expect(app.get(Logger).lines).toEqual(['scope /a', 'scope /b'])
	})

	test('scoped services cannot be resolved from the root', async () => {
		const app = await container().provide(Current).bind(Logger, memoryLogger()).build()
		expect(() => untyped(app).get(Current)).toThrow(/scope 'request'/)
		expect(() => untyped(app).get(Request)).toThrow(/scope 'request'/)
	})

	test('open() requires every unbound scoped slot and only accepts values', async () => {
		const app = await container().provide(Current).bind(Logger, memoryLogger()).build()
		await expect(untyped(app).open(PerRequest)).rejects.toThrow(/Slot 'Request' needs a value/)
		const Impl = service('Impl', () => ({ url: '/' }))
		await expect(untyped(app).open(PerRequest, bind(Request, Impl))).rejects.toThrow(/carry values/)
	})

	test('scoped slots bound at build time need not be supplied', async () => {
		const app = await container()
			.provide(Current)
			.bind(Logger, memoryLogger())
			.bind(Request, { url: '/fixed' })
			.build()
		expect((await app.open(PerRequest)).get(Current).url).toBe('/fixed')
	})

	test('async scoped services are awaited by open()', async () => {
		const Session = service('Session', { req: Request }, async ({ req }) => {
			await nextTask()
			return { id: `s:${req.url}` }
		})
		const app = await container().provide(Session).build()
		const child = await app.open(PerRequest, bind(Request, { url: '/x' }))
		expect(child.get(Session).id).toBe('s:/x')
	})

	test('a service can be placed in a deeper scope than its dependencies', async () => {
		let created = 0
		const UnitOfWork = service('UnitOfWork', () => ({ id: ++created }), { scope: PerRequest })
		const app = await container().provide(UnitOfWork).build()
		const a = await app.open(PerRequest)
		const b = await app.open(PerRequest)
		expect(a.get(UnitOfWork).id).toBe(1)
		expect(a.get(UnitOfWork).id).toBe(1)
		expect(b.get(UnitOfWork).id).toBe(2)
	})

	test('optional scoped slots may be omitted from open()', async () => {
		const Session = slot('Session', { scope: PerRequest })<{ userId: string }>()
		const Svc = service(
			'Svc',
			{ session: optional(Session) },
			({ session }) => session?.userId ?? 'anon',
		)
		const app = await container().provide(Svc).build()
		expect((await app.open(PerRequest)).get(Svc)).toBe('anon')
		expect((await app.open(PerRequest, bind(Session, { userId: 'u1' }))).get(Svc)).toBe('u1')

		// A required usage elsewhere makes the value required again.
		const Strict = service('Strict', { session: Session }, ({ session }) => session.userId)
		const both = await container().provide(Svc, Strict).build()
		await expect(untyped(both).open(PerRequest)).rejects.toThrow(/needs a value/)
	})
})

describe('nested scopes', () => {
	const SessionScope = scope('session')
	const RequestScope = scope('request', SessionScope)
	const Sess = slot('Sess', { scope: SessionScope })<{ id: string }>()
	const Req = slot('Req', { scope: RequestScope })<{ url: string }>()
	const Cart = service('Cart', { sess: Sess }, ({ sess }, ctx) => {
		const items: string[] = []
		ctx.defer(() => void items.splice(0))
		return { id: sess.id, items }
	})
	const Handler = service('Handler', { req: Req, cart: Cart }, ({ req, cart }) => ({
		handle: () => {
			cart.items.push(req.url)
			return cart.items.length
		},
	}))

	test('session-scope instances are shared by the request scopes beneath them', async () => {
		const app = await container().provide(Handler).build()
		const session = await app.open(SessionScope, bind(Sess, { id: 's1' }))
		const r1 = await session.open(RequestScope, bind(Req, { url: '/a' }))
		const r2 = await session.open(RequestScope, bind(Req, { url: '/b' }))
		expect(r1.get(Handler).handle()).toBe(1)
		expect(r2.get(Handler).handle()).toBe(2)
		expect(r1.get(Cart)).toBe(r2.get(Cart))
		expect(r1.get(Cart)).toBe(session.get(Cart))
		expect(Cart.scope).toBe('session')
		expect(Handler.scope).toBe('request')

		const other = await app.open(SessionScope, bind(Sess, { id: 's2' }))
		expect(other.get(Cart)).not.toBe(session.get(Cart))
	})

	test('scopes must be opened in order', async () => {
		const app = await container().provide(Handler).build()
		await expect(untyped(app).open(RequestScope, bind(Req, { url: '/' }))).rejects.toThrow(
			/not a child of 'root'/,
		)
		const session = await app.open(SessionScope, bind(Sess, { id: 's' }))
		await expect(untyped(session).open(SessionScope, bind(Sess, { id: 's' }))).rejects.toThrow(
			/not a child of 'session'/,
		)
		expect(() => untyped(session).get(Handler)).toThrow(/not visible from 'session'/)
	})

	test('another scope with the same name is not the declared child either', async () => {
		const Impostor = scope('request')
		const app = await container().provide(Handler).build()
		const session = await app.open(SessionScope, bind(Sess, { id: 's' }))
		await expect(untyped(session).open(Impostor)).rejects.toThrow(/not a child of 'session'/)
	})

	test('two distinct scopes sharing a name are rejected wherever they meet', async () => {
		const Impostor = scope('request')
		const Fake = service('Fake', () => ({ url: '/' }), { scope: Impostor })
		// Standing in for a node of the other scope.
		expect(() => bind(Req, untyped(Fake))).toThrow(
			/The implementation of 'Req' meets two distinct scopes named 'request'/,
		)
		// Declared in one, depending on the other.
		expect(() =>
			service('Mixed', untyped({ req: Req }), (d: unknown) => d, { scope: untyped(Impostor) }),
		).toThrow(/Service 'Mixed' meets two distinct scopes named 'request'/)
		// Opened in place of the one the container was built with, from the right parent.
		const Twin = scope('request', SessionScope)
		const app = await container().provide(Handler).build()
		const session = await app.open(SessionScope, bind(Sess, { id: 's' }))
		await expect(untyped(session).open(Twin)).rejects.toThrow(
			/Opening scope 'request' meets two distinct scopes named 'request'/,
		)
		// A namesake ancestor is caught too.
		const OtherSession = scope('session')
		const Nested = scope('request', OtherSession)
		await expect(untyped(session).open(Nested)).rejects.toThrow(
			/Opening scope 'request' meets two distinct scopes named 'session'/,
		)
		await app.dispose()
	})

	test('a scope cannot take the name of a scope above it', () => {
		const Outer = scope('x')
		expect(() => scope('x', Outer)).toThrow(/already the name of a scope above it/)
		expect(() => scope('x', scope('y', Outer))).toThrow(/already the name of a scope above it/)
	})

	test('disposal is children first, then dependents before dependencies, in sequence', async () => {
		const log: string[] = []
		const Tracked = service('Tracked', { req: Req }, ({ req }, ctx) => {
			ctx.defer(async () => {
				await nextTask()
				log.push(`req ${req.url}`)
			})
			return 1
		})
		const Shared = service('Shared', { sess: Sess }, (_, ctx) => {
			ctx.defer(() => void log.push('session'))
			return 1
		})
		const Both = service('Both', { t: Tracked, s: Shared }, () => 1)
		const app = await container().provide(Both).build()
		const session = await app.open(SessionScope, bind(Sess, { id: 's' }))
		;(await session.open(RequestScope, bind(Req, { url: '/a' }))).get(Both)
		;(await session.open(RequestScope, bind(Req, { url: '/b' }))).get(Both)
		await app.dispose()
		expect(log).toEqual(['req /b', 'req /a', 'session'])
	})

	test('declaration-time checks across scopes', () => {
		const JobScope = scope('job')
		const Job = slot('Job', { scope: JobScope })<number>()
		expect(() => service('Mixed', untyped({ req: Req, job: Job }), (d: unknown) => d)).toThrow(
			/different scope branches/,
		)
		expect(() =>
			service('Shallow', { req: Req }, (d) => d, { scope: untyped(SessionScope) }),
		).toThrow(/below it/)
		expect(() => bind(Sess, untyped(service('Deep', { req: Req }, () => ({ id: '' }))))).toThrow(
			/which 'Sess' in 'session' cannot see/,
		)
	})

	test('two distinct scopes with one name are rejected when they meet in a declaration, or in a container', async () => {
		const A = scope('x')
		const B = scope('x')
		const Ta = slot('Ta', { scope: A })<number>()
		const Tb = slot('Tb', { scope: B })<number>()
		expect(() => service('S', untyped({ a: Ta, b: Tb }), () => 1)).toThrow(
			/Service 'S' meets two distinct scopes named 'x'/,
		)
		const Sa = service('Sa', { a: Ta }, () => 1)
		const Sb = service('Sb', { b: Tb }, () => 1)
		await expect(untyped(container().provide(Sa, Sb)).build()).rejects.toThrow(
			/The container meets two distinct scopes named 'x'/,
		)
	})
})
