import { describe, expect, test } from 'bun:test'
import { container, type DowelError, execution, scope, service, slot } from '../src/index.ts'
import { gate } from './support.ts'

describe('function instances', () => {
	test('disposal waits for calls in flight before disposing what they use', async () => {
		const order: string[] = []
		const Dep = service('Dep', (ctx) => {
			ctx.defer(() => void order.push('dependency disposed'))
			return { ready: true }
		})
		const held = gate()
		const Call = service('Call', { dep: Dep }, ({ dep }, ctx) => {
			ctx.defer(() => void order.push('call service disposed'))
			return async () => {
				await held.promise
				order.push(dep.ready ? 'call finished' : 'call saw a disposed dependency')
			}
		})
		const app = await container().provide(Call).build()
		const call = app.get(Call)()
		const disposing = app.dispose()
		await Bun.sleep(5)
		expect(order).toEqual([])
		held.open()
		await disposing
		await call
		expect(order).toEqual(['call finished', 'call service disposed', 'dependency disposed'])
	})

	test('disposal aborts the signal first, so a call that listens ends promptly', async () => {
		const Wait = service(
			'Wait',
			(ctx) => () =>
				new Promise<never>((_, reject) =>
					ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }),
				),
		)
		const app = await container().provide(Wait).build()
		const call = app.get(Wait)()
		await app.dispose()
		await expect(call).rejects.toMatchObject({ code: 'DISPOSED' } satisfies Partial<DowelError>)
	})

	test('a dependent gets the tracked function too, and a run beneath an owner drains through it', async () => {
		const Op = scope('op')
		const Key = slot('Key', { scope: Op })<string>()
		// Scoped to the run, so the run's disposal is what aborts and drains it.
		const Wait = service(
			'Wait',
			(ctx) => () =>
				new Promise<string>((resolve) =>
					ctx.signal.addEventListener('abort', () => resolve('stopped'), { once: true }),
				),
			{ scope: Op },
		)
		const Uses = service('Uses', { wait: Wait, key: Key }, ({ wait }) => ({ wait }))
		const Run = execution('Run', { scope: Op, entry: Uses, inputs: { key: Key } })
		const app = await container().provide(Run).build()
		const run = app.get(Run)({ key: 'a' }, (uses) => uses.wait())
		await Bun.sleep(5)
		await app.dispose()
		expect(await run).toBe('stopped')
	})

	test('a call that starts while its container is being disposed starts aborted', async () => {
		const Op = scope('op')
		const Key = slot('Key', { scope: Op })<string>()
		const Wait = service(
			'Wait',
			(ctx) => () =>
				new Promise<string>((resolve) => {
					if (ctx.signal.aborted) resolve('started aborted')
					ctx.signal.addEventListener('abort', () => resolve('stopped'), { once: true })
				}),
			{ scope: Op },
		)
		const Uses = service('Uses', { wait: Wait, key: Key }, ({ wait }) => ({ wait }))
		const Run = execution('Run', { scope: Op, entry: Uses, inputs: { key: Key } })
		const app = await container().provide(Run).build()
		const run = app.get(Run)({ key: 'a' }, async (uses, { signal }) => {
			await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
			return uses.wait()
		})
		await Bun.sleep(5)
		await app.dispose()
		expect(await run).toBe('started aborted')
	})

	test('a call after disposal still runs, with its signal aborted, as a retained object would', async () => {
		const Fn = service('Fn', (ctx) => async () => ctx.signal.aborted)
		const app = await container().provide(Fn).build()
		const fn = app.get(Fn)
		await app.dispose()
		expect(await fn()).toBe(true)
	})

	test('passes results, this, properties and construction through unchanged', async () => {
		function Point(this: { x: number }, x: number) {
			this.x = x
		}
		const sync = Object.assign((n: number) => n * 2, { label: 'double' })
		const Double = service('Double', () => sync)
		const Make = service('Make', () => Point)
		const Method = service(
			'Method',
			() =>
				function (this: { base: number }, n: number) {
					return this.base + n
				},
		)
		const app = await container().provide(Double, Make, Method).build()
		expect(app.get(Double)(2)).toBe(4)
		expect(app.get(Double).label).toBe('double')
		expect(new (app.get(Make) as unknown as new (x: number) => { x: number })(3).x).toBe(3)
		expect(app.get(Method).call({ base: 10 }, 1)).toBe(11)
	})

	test('track: false leaves calls to their callers', async () => {
		const held = gate()
		const Free = service('Free', {}, () => () => held.promise, { track: false })
		const app = await container().provide(Free).build()
		const call = app.get(Free)()
		await app.dispose()
		held.open()
		await call
	})

	test('a function bound with Slot.of() belongs to the binder, so it is never tracked', async () => {
		const held = gate()
		const Fn = slot('Fn')<() => Promise<void>>()
		const fn = () => held.promise
		const Uses = service('Uses', { fn: Fn }, ({ fn }) => ({ fn }))
		const app = await container().provide(Fn.of(fn), Uses).build()
		expect(app.get(Uses).fn).toBe(fn)
		const call = app.get(Uses).fn()
		await app.dispose()
		held.open()
		await call
	})
})
