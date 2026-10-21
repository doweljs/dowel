import { describe, expect, test } from 'bun:test'
import { bind, container, service, slot } from '../src/index.ts'
import { nextTask, PerRequest, Request } from './support.ts'

describe('construction failure', () => {
	test('a failing async factory rejects build() after disposing what was created', async () => {
		const disposed: string[] = []
		const Good = service('Good', async (ctx) => {
			ctx.defer(() => void disposed.push('Good'))
			return 1
		})
		const Bad = service('Bad', { good: Good }, async () => {
			throw new Error('boom')
		})
		await expect(container().provide(Bad).build()).rejects.toThrow('boom')
		expect(disposed).toEqual(['Good'])
	})

	test('a failing sync factory also disposes what was created, before rejecting', async () => {
		const log: string[] = []
		const Good = service('Good', (ctx) => {
			ctx.defer(async () => {
				await nextTask()
				log.push('Good disposed')
			})
			return 1
		})
		const Bad = service('Bad', { g: Good }, () => {
			throw new Error('boom')
		})
		await expect(container().provide(Bad).build()).rejects.toThrow('boom')
		expect(log).toEqual(['Good disposed'])
	})

	test('in-flight siblings settle before cleanup runs', async () => {
		const log: string[] = []
		// Still running when its sibling fails: it finishes only once the failure cancelled it.
		const Slow = service('Slow', async (ctx) => {
			ctx.defer(() => void log.push('slow disposed'))
			await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve))
			log.push('slow ready')
			return 1
		})
		const Bad = service('Bad', async () => {
			throw new Error('boom')
		})
		const Both = service('Both', { slow: Slow, bad: Bad }, () => 1)
		await expect(container().provide(Both).build()).rejects.toThrow('boom')
		expect(log).toEqual(['slow ready', 'slow disposed'])
	})

	test('a failing factory still runs the disposers it registered', async () => {
		const log: string[] = []
		const Bad = service('Bad', (ctx) => {
			ctx.defer(() => void log.push('bad'))
			throw new Error('boom')
		})
		await expect(container().provide(Bad).build()).rejects.toThrow('boom')
		expect(log).toEqual(['bad'])
	})

	test('cleanup failures ride along with the original failure', async () => {
		const Good = service('Good', (ctx) => {
			ctx.defer(() => {
				throw new Error('cleanup failed')
			})
			return 1
		})
		const Bad = service('Bad', { g: Good }, async () => {
			throw new Error('boom')
		})
		const error = await container()
			.provide(Bad)
			.build()
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(AggregateError)
		expect((error as AggregateError).errors.map((e) => (e as Error).message)).toEqual([
			'boom',
			'cleanup failed',
		])
	})

	test('open() failures dispose the opened container and leave its parent usable', async () => {
		const log: string[] = []
		const Fine = service('Fine', { req: Request }, (_, ctx) => {
			ctx.defer(() => void log.push('fine'))
			return 1
		})
		const Broken = service('Broken', { req: Request, fine: Fine }, async () => {
			throw new Error('nope')
		})
		const app = await container().provide(Broken).build()
		await expect(app.open(PerRequest, bind(Request, { url: '/' }))).rejects.toThrow('nope')
		expect(log).toEqual(['fine'])
		await expect(app.open(PerRequest, bind(Request, { url: '/' }))).rejects.toThrow('nope')
		await app.dispose()
	})

	test('a synchronous failure stops initialization before independent services start', async () => {
		const started: string[] = []
		const First = service('First', () => {
			throw new Error('first failed')
		})
		const Second = service('Second', () => {
			started.push('Second')
			return 2
		})
		await expect(container().provide(First, Second).build()).rejects.toThrow('first failed')
		expect(started).toEqual([])
	})

	test('a failure aborts the signals of factories still running', async () => {
		const aborted: string[] = []
		// Generic in the name, so each service it declares keeps its literal name.
		const waitsForAbort = <N extends string>(name: N) =>
			service(name, (ctx) => {
				return new Promise<never>((_, reject) => {
					ctx.signal.addEventListener('abort', () => {
						aborted.push(name)
						reject(ctx.signal.reason)
					})
				})
			})
		const Patient = waitsForAbort('Patient')
		const ThrowsNow = service('ThrowsNow', () => {
			throw new Error('sync failure')
		})
		await expect(container().provide(Patient, ThrowsNow).build()).rejects.toThrow('sync failure')

		const Waiting = waitsForAbort('Waiting')
		const FailsLater = service('FailsLater', async () => {
			throw new Error('async failure')
		})
		await expect(container().provide(Waiting, FailsLater).build()).rejects.toThrow('async failure')
		expect(aborted).toEqual(['Patient', 'Waiting'])
	})

	test('a factory waiting on a dependency never runs once initialization failed', async () => {
		const log: string[] = []
		// Finishes only once the failure below cancelled it, so its dependent is released afterwards.
		const Slow = service('Slow', async (ctx) => {
			await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve))
			ctx.defer(() => void log.push('Slow disposed'))
			return 1
		})
		const Waiting = service('Waiting', { slow: Slow }, () => {
			log.push('Waiting created')
			return 2
		})
		const Failing = service('Failing', async () => {
			throw new Error('boom')
		})
		await expect(container().provide(Waiting, Failing).build()).rejects.toThrow('boom')
		expect(log).toEqual(['Slow disposed'])
	})

	test("a later sibling's cleanup failure rides along with the first failure", async () => {
		const Failing = service('Failing', async () => {
			throw new Error('boom')
		})
		// Stops when the failure above cancels it, and fails to clean up after itself.
		const Sibling = service('Sibling', async (ctx) => {
			ctx.defer(() => {
				throw new Error('sibling cleanup failed')
			})
			await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve))
			throw ctx.signal.reason
		})
		const Dependent = service('Dependent', { failing: Failing }, ({ failing }) => failing)
		const error = await container()
			.provide(Dependent, Sibling)
			.build()
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(AggregateError)
		// The original failure first, the cleanup failure after it, and neither the cancellation
		// nor the original failure again as the dependent reported it.
		expect((error as AggregateError).errors.map((e) => (e as Error).message)).toEqual([
			'boom',
			'sibling cleanup failed',
		])
	})

	test('a bound promise reaches factories as the promise itself', async () => {
		const Pending = slot('Pending')<Promise<number>>()
		// Wrapped, since a factory's own returned promise is awaited.
		const Reader = service('Reader', { pending: Pending }, ({ pending }) => ({ pending }))
		const promise = Promise.resolve(1)
		const app = await container().provide(Reader).bind(Pending, promise).build()
		expect(app.get(Reader).pending).toBe(promise)
	})

	test('ctx.use() accepts a callable disposable', async () => {
		const log: string[] = []
		const handle = Object.assign(() => 'called', {
			[Symbol.dispose]: () => void log.push('disposed'),
		})
		const Holder = service('Holder', (ctx) => ctx.use(handle))
		const app = await container().provide(Holder).build()
		expect(app.get(Holder)()).toBe('called')
		await app.dispose()
		expect(log).toEqual(['disposed'])
	})
})
