import { describe, expect, test } from 'bun:test'
import { hot, onHotFailure, prepare, release, snapshot, track } from '../../src/evolve.ts'
import { container, service, slot } from '../../src/index.ts'
import { gate, nextTask } from '../support.ts'

const Version = slot('Version')<number>()
const Reader = service('Reader', { version: Version }, ({ version }) => version)
const builder = (version: number) => container().provide(Reader).bind(Version, version)

describe('hot()', () => {
	test('without a store, it builds', async () => {
		const app = await hot(undefined, builder(1))
		expect(app.get(Reader)).toBe(1)
		await app.dispose()
	})

	test('it builds once, then has each evaluation succeed the container built before', async () => {
		const store = {}
		const first = await hot(store, builder(1))
		const second = await hot(store, builder(2))

		expect(second).not.toBe(first)
		expect(first.get(Reader)).toBe(2)
		expect(second.get(Reader)).toBe(2)
		await second.dispose()
	})

	test('a failed evaluation keeps the previous container, and devtools see why until one succeeds', async () => {
		const store = {}
		const first = await hot(store, builder(1), { name: 'failing' })
		const Broken = service('Broken', () => {
			throw new Error('broken factory')
		})
		const ids = new Set(snapshot().map((lineage) => lineage.id))

		await expect(hot(store, builder(2).provide(Broken), { name: 'failing' })).rejects.toThrow(
			'broken factory',
		)
		expect(first.get(Reader)).toBe(1)
		const failed = snapshot().find((lineage) => ids.has(lineage.id) && lineage.failure !== null)
		expect(failed?.failure).toContain('broken factory')
		expect(failed?.generation).toBe(1)

		await hot(store, builder(3), { name: 'failing' })
		const recovered = snapshot().find((lineage) => lineage.id === failed?.id)
		expect(recovered).toMatchObject({ failure: null, generation: 2 })
		expect(first.get(Reader)).toBe(3)
		await first.dispose()
		expect(snapshot().some((lineage) => lineage.id === failed?.id)).toBe(false)
	})

	test('names keep the lineages of one store apart', async () => {
		const store = {}
		const one = await hot(store, builder(1), { name: 'one' })
		const other = await hot(store, builder(10), { name: 'other' })
		await hot(store, builder(2), { name: 'one' })

		expect(one.get(Reader)).toBe(2)
		expect(other.get(Reader)).toBe(10)
		await one.dispose()
		await other.dispose()
	})

	test('a container that was disposed is built again rather than succeeded', async () => {
		const store = {}
		const first = await hot(store, builder(1))
		await first.dispose()
		const second = await hot(store, builder(2))

		expect(second.get(Reader)).toBe(2)
		expect(() => first.get(Reader)).toThrow(expect.objectContaining({ code: 'DISPOSED' }) as never)
		await second.dispose()
	})

	test('listeners hear of every failure, and one that fails hides nothing', async () => {
		const store = {}
		const heard: string[] = []
		const stopFailing = onHotFailure(() => {
			throw new Error('listener broke')
		})
		const stop = onHotFailure((failure) => heard.push(`${failure.name}: ${failure.message}`))
		const first = await hot(store, builder(1), { name: 'heard' })
		const consoleError = console.error
		console.error = () => {}

		try {
			await expect(
				hot(store, builder(2).provide(service('Broken', () => Promise.reject(new Error('no')))), {
					name: 'heard',
				}),
			).rejects.toThrow('no')
		} finally {
			console.error = consoleError
			stop()
			stopFailing()
		}
		expect(heard).toEqual(['heard: no'])
		await first.dispose()
	})

	test('track() shows a container built without hot() in devtools, following its successors', async () => {
		const app = await builder(1).build()
		const before = new Set(snapshot().map((lineage) => lineage.id))
		track(app)
		track(app)
		const added = snapshot().filter((lineage) => !before.has(lineage.id))
		expect(added).toHaveLength(1)
		expect(added[0]).toMatchObject({ generation: 1, failure: null })

		await (await prepare(app, builder(2))).activate()
		expect(snapshot().find((lineage) => lineage.id === added[0]?.id)?.generation).toBe(2)
		await app.dispose()
		expect(snapshot().some((lineage) => lineage.id === added[0]?.id)).toBe(false)
	})

	/** A port whose first stop waits for `held`, counting how many generations hold it at once. */
	function heldPort(held: Promise<void>) {
		const counts = { active: 0, most: 0 }
		let first = true
		const Port = service('Port', (ctx) => {
			ctx.whileActive(() => {
				counts.active++
				counts.most = Math.max(counts.most, counts.active)
				return async () => {
					if (first) {
						first = false
						await held
					}
					counts.active--
				}
			})
		})
		return { counts, compose: (version: number) => builder(version).provide(Port) }
	}

	test('devtools keep an application while it hands over to a successor', async () => {
		const held = gate()
		const { compose } = heldPort(held.promise)
		const store = {}
		const first = await hot(store, compose(1), { name: 'handing-over' })
		const id = snapshot().find((lineage) => lineage.nodes.some((node) => node.name === 'Port'))?.id
		const evolving = hot(store, compose(2), { name: 'handing-over' })
		await nextTask()

		expect(snapshot().some((lineage) => lineage.id === id)).toBe(true)
		held.open()
		await evolving
		expect(snapshot().find((lineage) => lineage.id === id)?.generation).toBe(2)
		await first.dispose()
	})

	test('evaluations that overlap evolve one after the other, never running two generations at once', async () => {
		const held = gate()
		const { counts, compose } = heldPort(held.promise)
		const store = {}
		const first = await hot(store, compose(1), { name: 'overlapping' })
		const second = hot(store, compose(2), { name: 'overlapping' })
		const third = hot(store, compose(3), { name: 'overlapping' })
		await nextTask()
		held.open()

		await second
		const latest = await third
		expect(counts.most).toBe(1)
		expect(latest.get(Reader)).toBe(3)
		expect(first.get(Reader)).toBe(3)
		await first.dispose()
	})

	test('release() disposes what a store keeps, and the next hot() builds afresh', async () => {
		const store = {}
		const first = await hot(store, builder(1), { name: 'released' })
		await release(store)

		expect(() => first.get(Reader)).toThrow(expect.objectContaining({ code: 'DISPOSED' }) as never)
		const next = await hot(store, builder(2), { name: 'released' })
		expect(next).not.toBe(first)
		expect(next.get(Reader)).toBe(2)
		await next.dispose()
	})

	test('a stop function that never returns fails its evaluation after the timeout, and the next one goes ahead', async () => {
		const events: string[] = []
		// Only the first stop hangs, so that disposing the lineage at the end can finish.
		let hangs = true
		const Stuck = service('Stuck', (ctx) => {
			ctx.whileActive((previous) => {
				events.push(`stuck starts from ${String(previous)}`)
				return () => {
					if (!hangs) return
					hangs = false
					return new Promise(() => {})
				}
			})
		})
		const store = {}
		const options = { name: 'stuck', timeout: 20 }
		const first = await hot(store, builder(1).provide(Stuck), options)
		const consoleError = console.error
		console.error = () => {}

		try {
			const failure = await hot(store, builder(2).provide(Stuck), options).catch(
				(error: unknown) => error,
			)
			const [activation] = (failure as AggregateError).errors
			expect(activation).toMatchObject({
				code: 'ACTIVATION_FAILED',
				cause: expect.objectContaining({ message: expect.stringContaining('did not stop') }),
			})
			expect(first.get(Reader)).toBe(1)

			const next = await hot(store, builder(3).provide(Stuck), options)
			expect(next.get(Reader)).toBe(3)
			expect(events).toEqual(['stuck starts from undefined', 'stuck starts from undefined'])
		} finally {
			console.error = consoleError
		}
		await first.dispose()
	})

	test('the first build gives its effects the same time limit, so a stuck one does not hold up the next', async () => {
		let hangs = true
		const Starting = service('Starting', (ctx) => {
			ctx.whileActive(() => {
				if (!hangs) return
				hangs = false
				return new Promise(() => {})
			})
		})
		const store = {}
		const options = { name: 'stuck-first', timeout: 20 }

		const failure = await hot(store, builder(1).provide(Starting), options).catch(
			(error: unknown) => error,
		)
		// With what its disposal, going on in the background, adds.
		const [first] = failure instanceof AggregateError ? failure.errors : [failure]
		expect(first).toMatchObject({ code: 'ACTIVATION_FAILED' })
		const app = await hot(store, builder(2).provide(Starting), options)
		expect(app.get(Reader)).toBe(2)
		await app.dispose()
	})

	test('devtools see an application again once it is built after being disposed', async () => {
		const store = {}
		const first = await hot(store, builder(1), { name: 'rebuilt' })
		const id = snapshot().find(
			(lineage) => lineage.nodes.length > 0 && lineage.generation === 1,
		)?.id
		await first.dispose()
		expect(snapshot().some((lineage) => lineage.id === id)).toBe(false)

		const second = await hot(store, builder(2), { name: 'rebuilt' })
		expect(snapshot().find((lineage) => lineage.id === id)?.generation).toBe(1)
		await second.dispose()
	})
})
