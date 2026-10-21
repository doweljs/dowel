import { describe, expect, test } from 'bun:test'
import { snapshot, update } from '../../src/hot.ts'
import { bind, container, scope, service, slot } from '../../src/index.ts'
import { PerRequest } from '../support.ts'
import { Logger, resetAfterEach } from './support.ts'

resetAfterEach()

describe('what a replacement replaces', () => {
	test('a re-evaluated module and its dependents are recreated; other modules survive', async () => {
		const disposed: string[] = []
		const Db = service('Db', (ctx) => {
			ctx.defer(() => void disposed.push('Db'))
			return { id: Math.random() }
		})
		const Users = service('Users', { db: Db }, ({ db }, ctx) => {
			ctx.defer(() => void disposed.push('Users'))
			return { db, version: 1 }
		})
		const Api = service('Api', { users: Users }, ({ users }, ctx) => {
			ctx.defer(() => void disposed.push('Api'))
			return { users }
		})
		await update('db.ts', { Db })
		await update('users.ts', { Users, Api })

		const app = await container().provide(Api).build()
		const db = app.get(Db)
		expect(app.get(Api).users.version).toBe(1)

		// users.ts is re-evaluated: both of its declarations are new objects.
		const Users2 = service('Users', { db: Db }, ({ db }, ctx) => {
			ctx.defer(() => void disposed.push('Users'))
			return { db, version: 2 }
		})
		const Api2 = service('Api', { users: Users2 }, ({ users }, ctx) => {
			ctx.defer(() => void disposed.push('Api'))
			return { users }
		})
		const result = await update('users.ts', { Users: Users2, Api: Api2 })
		expect(result.changed).toEqual(['Users', 'Api'])
		expect(result.rebuilt).toBe(1)

		expect(disposed).toEqual(['Api', 'Users'])
		// Stale references (from modules that were not re-evaluated) still work.
		expect(app.get(Api).users.version).toBe(2)
		expect(app.get(Users).version).toBe(2)
		expect(app.get(Db)).toBe(db)
		// Fresh references work too.
		expect(app.get(Users2)).toBe(app.get(Users))
		expect(snapshot().map((c) => c.status)).toEqual([{ state: 'current', error: null }])
	})

	test('a re-evaluated module is replaced even when a declaration looks the same', async () => {
		// The factory text is identical; what changed is module state it closes over.
		let greeting = 'hi'
		const Greeter = service('Greeter', () => () => greeting)
		await update('greeter.ts', { Greeter })
		const app = await container().provide(Greeter).build()
		expect(app.get(Greeter)()).toBe('hi')

		greeting = 'hello'
		const Greeter2 = service('Greeter', () => () => greeting)
		const result = await update('greeter.ts', { Greeter: Greeter2 })
		expect(result.changed).toEqual(['Greeter'])
		expect(app.get(Greeter)()).toBe('hello')
	})

	test('containers that use nothing from the module are left alone', async () => {
		let created = 0
		const A = service('A', () => ++created)
		const B = service('B', () => 1)
		await update('a.ts', { A })
		await update('b.ts', { B })
		await container().provide(A).build()
		const result = await update('b.ts', { B: service('B', () => 2) })
		expect(result).toEqual({ changed: ['B'], rebuilt: 0 })
		expect(created).toBe(1)
	})

	test('scopes are disposed and later scopes use the new graph', async () => {
		const Request = slot('Request', { scope: PerRequest })<{ url: string }>()
		const Current = service('Current', { req: Request }, ({ req }) => ({ url: req.url, v: 1 }))
		await update('current.ts', { Request, Current })
		const app = await container().provide(Current).build()
		const child = await app.open(PerRequest, bind(Request, { url: '/a' }))
		expect(child.get(Current).v).toBe(1)

		const Request2 = slot('Request', { scope: PerRequest })<{ url: string }>()
		const Current2 = service('Current', { req: Request2 }, ({ req }) => ({ url: req.url, v: 2 }))
		await update('current.ts', { Request: Request2, Current: Current2 })

		expect(() => child.get(Current)).toThrow(/disposed/)
		expect((await app.open(PerRequest, bind(Request2, { url: '/b' }))).get(Current).v).toBe(2)
	})

	test('re-declared scopes are matched by name', async () => {
		const Session = scope('session')
		const Sess = slot('Sess', { scope: Session })<{ id: string }>()
		const Cart = service('Cart', { sess: Sess }, ({ sess }) => ({ id: sess.id, v: 1 }))
		await update('cart.ts', { Session, Sess, Cart })
		const app = await container().provide(Cart).build()
		expect((await app.open(Session, bind(Sess, { id: 'a' }))).get(Cart).v).toBe(1)

		const Session2 = scope('session')
		const Sess2 = slot('Sess', { scope: Session2 })<{ id: string }>()
		const Cart2 = service('Cart', { sess: Sess2 }, ({ sess }) => ({ id: sess.id, v: 2 }))
		await update('cart.ts', { Session: Session2, Sess: Sess2, Cart: Cart2 })
		// Both the old and the new scope object open the same scope.
		expect((await app.open(Session, bind(Sess, { id: 'b' }))).get(Cart).v).toBe(2)
		expect((await app.open(Session2, bind(Sess2, { id: 'c' }))).get(Cart2).v).toBe(2)
	})

	test('bindings follow re-declared slots', async () => {
		const Svc = service('Svc', { log: Logger }, ({ log }) => ({ log, v: 1 }))
		await update('svc.ts', { Logger, Svc })
		const logger = { info() {} }
		const app = await container().provide(Svc).bind(Logger, logger).build()

		const Logger2 = slot('Logger')<{ info(message: string): void }>()
		const Svc2 = service('Svc', { log: Logger2 }, ({ log }) => ({ log, v: 2 }))
		await update('svc.ts', { Logger: Logger2, Svc: Svc2 })
		expect(app.get(Svc).v).toBe(2)
		expect(app.get(Svc).log).toBe(logger)
		expect(app.get(Logger2)).toBe(logger)
	})

	test('re-declaring a parent scope keeps child scopes and services from other modules valid', async () => {
		const Req = scope('req')
		await update('scopes.ts', { Req })
		const Tx = scope('tx', Req)
		const A = service('A', () => 'a', { scope: Req })
		const B = service('B', { a: A }, ({ a }) => `${a}b`, { scope: Tx })
		await update('tx.ts', { Tx, A, B })
		const app = await container().provide(B).build()

		// Only scopes.ts is re-evaluated: Tx still points at the old Req.
		await update('scopes.ts', { Req: scope('req') })
		const req = await app.open(Req)
		const tx = await req.open(Tx)
		expect(tx.get(B)).toBe('ab')
	})

	test("edits to an override's replacement are picked up", async () => {
		const Real = service('Real', () => 'real')
		const Fake = service('Fake', () => 'fake1')
		await update('real.ts', { Real })
		await update('fake.ts', { Fake })
		const app = await container().provide(Real).override(Real, Fake).build()
		expect(app.get(Real)).toBe('fake1')
		await update('fake.ts', { Fake: service('Fake', () => 'fake2') })
		expect(app.get(Real)).toBe('fake2')
	})

	test('a multi-binding with value contributions is carried over when nothing it uses changed', async () => {
		const Routes = slot('Routes', { many: true })<string>()
		let created = 0
		const Server = service('Server', { routes: Routes }, ({ routes }) => {
			created++
			return routes
		})
		const Other = service('Other', () => 1)
		await update('server.ts', { Routes, Server })
		await update('other.ts', { Other })
		const app = await container().provide(Server, Other).contribute(Routes, '/a').build()
		await update('other.ts', { Other: service('Other', () => 2) })
		expect(created).toBe(1)
		expect(app.get(Server)).toEqual(['/a'])
	})

	test('a container built after an update uses the latest declarations', async () => {
		const X = service('X', () => 1)
		await update('x.ts', { X })
		const X2 = service('X', () => 2)
		await update('x.ts', { X: X2 })
		// Built from a module that still holds the first X.
		const app = await container().provide(X).build()
		expect(app.get(X)).toBe(2)
		expect(app.get(X2)).toBe(2)
	})

	test('a first registration of what a container already uses does not rebuild it', async () => {
		const Early = service('Early', () => 1)
		const app = await container().provide(Early).build()
		await expect(update('early.ts', { Early })).resolves.toEqual({ changed: [], rebuilt: 0 })
		expect(app.get(Early)).toBe(1)
	})
})
