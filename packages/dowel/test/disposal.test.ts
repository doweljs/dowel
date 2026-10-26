import { describe, expect, test } from 'bun:test'
import { bind, container, type DowelError, service, slot } from '../src/index.ts'
import { gate, nextTask, PerRequest, Request, untyped } from './support.ts'

describe('ownership and disposal', () => {
	test('disposers run in reverse creation order, scopes before the root', async () => {
		const log: string[] = []
		const A = service('A', (ctx) => {
			ctx.defer(() => void log.push('A'))
			return 'a'
		})
		const B = service('B', { a: A }, (_, ctx) => {
			ctx.defer(() => void log.push('B'))
			return 'b'
		})
		const S = service('S', { b: B, req: Request }, (_, ctx) => {
			ctx.defer(() => void log.push('S'))
			return 's'
		})
		const app = await container().provide(S).build()
		const child = await app.open(PerRequest, bind(Request, { url: '/' }))
		child.get(S)
		await app.dispose()
		expect(log).toEqual(['S', 'B', 'A'])
	})

	test('returned instances are not disposed automatically; ownership is explicit', async () => {
		const log: string[] = []
		const Resource = service('Resource', () => ({ [Symbol.dispose]: () => void log.push('auto') }))
		const Forwarder = service('Forwarder', { r: Resource }, ({ r }) => r)
		await using app = await container().provide(Forwarder).build()
		app.get(Forwarder)
		await app.dispose()
		expect(log).toEqual([])
	})

	test('use() adopts disposables, adopt() anything, defer() callbacks, all last-in-first-out', async () => {
		const log: string[] = []
		const Svc = service('Svc', (ctx) => {
			ctx.defer(() => void log.push('defer'))
			const handle = ctx.adopt({ id: 1 }, (h) => void log.push(`adopt ${h.id}`))
			const res = ctx.use({ [Symbol.asyncDispose]: async () => void log.push('use') })
			return { handle, res }
		})
		const app = await container().provide(Svc).build()
		expect(app.get(Svc).handle.id).toBe(1)
		await app.dispose()
		expect(log).toEqual(['use', 'adopt 1', 'defer'])
	})

	test('use() rejects values without a disposal method', async () => {
		const Bad = service('Bad', (ctx) => ctx.use({} as Disposable))
		await expect(container().provide(Bad).build()).rejects.toThrow(/Symbol.dispose/)
	})

	test('a resource has one owner', async () => {
		const shared = { [Symbol.dispose]: () => {} }
		const First = service('First', (ctx) => ctx.use(shared))
		const Second = service('Second', { f: First }, ({ f }, ctx) => ctx.use(f))
		await expect(container().provide(Second).build()).rejects.toThrow(
			/another service already owns/,
		)
	})

	test('a resource may be adopted again once its owner was disposed', async () => {
		const Req = slot('Req', { scope: PerRequest })<number>()
		const shared = { closed: 0, [Symbol.dispose]() {} }
		const Holder = service('Holder', { req: Req }, (_, ctx) => ctx.use(shared))
		const app = await container().provide(Holder).build()
		const first = await app.open(PerRequest, bind(Req, 1))
		expect(first.get(Holder)).toBe(shared)
		await expect(untyped(app).open(PerRequest, bind(Req, 2))).rejects.toThrow(/already owns/)
		await first.dispose()
		expect((await app.open(PerRequest, bind(Req, 3))).get(Holder)).toBe(shared)
	})

	test('disposing an opened container removes it from its parent', async () => {
		const log: string[] = []
		const S = service('S', { req: Request }, (_, ctx) => {
			ctx.defer(() => void log.push('S'))
			return 1
		})
		const app = await container().provide(S).build()
		const child = await app.open(PerRequest, bind(Request, { url: '/' }))
		await child.dispose()
		await child.dispose()
		await app.dispose()
		expect(log).toEqual(['S'])
		expect(() => child.get(S)).toThrow(/disposed/)
		await expect(untyped(app).open(PerRequest, bind(Request, { url: '/' }))).rejects.toThrow(
			/disposed/,
		)
	})

	test('all disposers run even when some fail', async () => {
		const log: string[] = []
		const A = service('A', (ctx) => {
			ctx.defer(() => void log.push('A'))
			return 1
		})
		const B = service('B', { a: A }, (_, ctx) => {
			ctx.defer(() => {
				throw new Error('B failed')
			})
			return 2
		})
		const app = await container().provide(B).build()
		const error = await app.dispose().catch((e: unknown) => e)
		expect(error).toBeInstanceOf(AggregateError)
		expect(log).toEqual(['A'])
	})

	test('dispose() refuses new scopes immediately, even while disposers run', async () => {
		const Req = slot('Req', { scope: PerRequest })<number>()
		const release = gate()
		const Slow = service('Slow', { req: Req }, (_, ctx) => {
			ctx.defer(() => release.promise)
			return 1
		})
		const app = await container().provide(Slow).build()
		await app.open(PerRequest, bind(Req, 1))
		const disposing = app.dispose()
		await expect(untyped(app).open(PerRequest, bind(Req, 2))).rejects.toThrow(/disposed/)
		release.open()
		await disposing
	})

	test('an opened container already disposing still finishes before its parent disposes', async () => {
		const log: string[] = []
		const Pool = service('Pool', (ctx) => {
			ctx.defer(() => void log.push('pool closed'))
			return {}
		})
		const Tx = service('Tx', { pool: Pool, req: Request }, (_, ctx) => {
			ctx.defer(async () => {
				await nextTask()
				log.push('tx flushed')
			})
			return {}
		})
		const app = await container().provide(Tx).build()
		const child = await app.open(PerRequest, bind(Request, { url: '/' }))
		child.get(Tx)
		await Promise.all([child.dispose(), app.dispose()])
		expect(log).toEqual(['tx flushed', 'pool closed'])
	})

	test('disposal waits for initializations still in flight', async () => {
		const log: string[] = []
		const Pool = service('Pool', (ctx) => {
			ctx.defer(() => void log.push('pool closed'))
			return {}
		})
		const started = gate()
		const release = gate()
		const Slow = service('Slow', { pool: Pool, req: Request }, async (_, ctx) => {
			started.open()
			await release.promise
			ctx.defer(() => void log.push('slow disposed'))
			return {}
		})
		const app = await container().provide(Slow).build()
		const opening = app.open(PerRequest, bind(Request, { url: '/' }))
		await started.promise
		const disposing = app.dispose()
		release.open()
		await disposing
		expect(log).toEqual(['slow disposed', 'pool closed'])
		await expect(opening).rejects.toThrow(/disposed/)
	})

	test('ctx.signal aborts when the owner is disposed during startup', async () => {
		let reason: unknown
		const started = gate()
		const Connect = service('Connect', { req: Request }, (_, ctx) => {
			started.open()
			return new Promise<never>((_, reject) => {
				ctx.signal.addEventListener('abort', () => {
					reason = ctx.signal.reason
					reject(ctx.signal.reason)
				})
			})
		})
		const app = await container().provide(Connect).build()
		const opening = app.open(PerRequest, bind(Request, { url: '/' }))
		await started.promise
		await app.dispose()
		expect((reason as DowelError).code).toBe('DISPOSED')
		await expect(opening).rejects.toThrow(/'request' was disposed while it opened/)
	})

	test('a context refuses new resources once its instance is disposed', async () => {
		let saved: any
		const Keeper = service('Keeper', (ctx) => {
			saved = ctx
			return 1
		})
		const app = await container().provide(Keeper).build()
		await app.dispose()
		expect(saved.signal.aborted).toBe(true)
		expect(() => saved.defer(() => {})).toThrow(/has been disposed/)
		expect(() => saved.adopt({}, () => {})).toThrow(/has been disposed/)
	})

	test('disposing the container while a scope opens rejects the open', async () => {
		const Sync = service('Sync', { req: Request }, ({ req }) => req.url)
		const app = await container().provide(Sync).build()
		const opening = app.open(PerRequest, bind(Request, { url: '/' }))
		const disposal = app.dispose()
		await expect(opening).rejects.toThrow(/Scope 'request' was disposed while it opened/)
		await disposal
	})

	test('a container refuses work as soon as its disposal starts', async () => {
		const Sync = service('Sync', { req: Request }, ({ req }) => req.url)
		const app = await container().provide(Sync).build()
		const request = await app.open(PerRequest, bind(Request, { url: '/' }))
		const disposal = request.dispose()
		expect(() => request.get(Sync)).toThrow(/has been disposed/)
		expect(() => request.inspect()).toThrow(/has been disposed/)
		await disposal
		await app.dispose()
	})

	test('a service adopting one resource twice is told so', async () => {
		const Twice = service('Twice', (ctx) => {
			const resource = { [Symbol.dispose]: () => {} }
			ctx.use(resource)
			ctx.use(resource)
		})
		await expect(container().provide(Twice).build()).rejects.toThrow(
			/Service 'Twice' adopted the same resource twice/,
		)
	})
})
