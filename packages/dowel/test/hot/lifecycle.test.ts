import { describe, expect, test } from 'bun:test'
import { update } from '../../src/hot.ts'
import { container, service } from '../../src/index.ts'
import { hooks } from '../../src/runtime/hooks.ts'
import { gate, nextTask } from '../support.ts'
import { resetAfterEach } from './support.ts'

resetAfterEach()

describe('ordering and container lifecycle', () => {
	test('async replacements are awaited', async () => {
		const Slow = service('Slow', async () => 1)
		await update('slow.ts', { Slow })
		const app = await container().provide(Slow).build()
		const Slow2 = service('Slow', async () => 2)
		await update('slow.ts', { Slow: Slow2 })
		expect(app.get(Slow)).toBe(2)
	})

	test('concurrent updates are applied in sequence', async () => {
		const disposed: string[] = []
		const A = service('A', (ctx) => {
			ctx.defer(() => void disposed.push('A'))
			return 1
		})
		const B = service('B', (ctx) => {
			ctx.defer(() => void disposed.push('B'))
			return 1
		})
		await update('a.ts', { A })
		await update('b.ts', { B })
		const app = await container().provide(A, B).build()

		const A2 = service('A', async (ctx) => {
			ctx.defer(() => void disposed.push('A'))
			await nextTask()
			return 2
		})
		const B2 = service('B', async (ctx) => {
			ctx.defer(() => void disposed.push('B'))
			await nextTask()
			return 2
		})
		await Promise.all([update('a.ts', { A: A2 }), update('b.ts', { B: B2 })])
		expect(app.get(A)).toBe(2)
		expect(app.get(B)).toBe(2)
		expect(disposed.sort()).toEqual(['A', 'B'])
	})

	test('a container disposed while a replacement initializes is left disposed', async () => {
		const disposed: string[] = []
		const Slow = service('Slow', (ctx) => {
			ctx.defer(() => void disposed.push('Slow 1'))
			return 1
		})
		await update('slow.ts', { Slow })
		const app = await container().provide(Slow).build()

		const initializing = gate()
		const release = gate()
		const Slow2 = service('Slow', async (ctx) => {
			ctx.defer(() => void disposed.push('Slow 2'))
			initializing.open()
			await release.promise
			return 2
		})
		const updating = update('slow.ts', { Slow: Slow2 })
		await initializing.promise
		const disposing = app.dispose()
		release.open()
		await disposing
		// Disposal waited for the proposal to be discarded.
		expect(disposed).toEqual(['Slow 1', 'Slow 2'])
		await updating
		expect(() => app.get(Slow)).toThrow(/disposed/)
	})

	test('disposing right after a commit waits for the old generation to be torn down', async () => {
		const log: string[] = []
		const tearingDown = gate()
		const release = gate()
		const Svc = service('Svc', (ctx) => {
			ctx.defer(async () => {
				tearingDown.open()
				await release.promise
				log.push('old disposed')
			})
			return 1
		})
		await update('svc.ts', { Svc })
		const app = await container().provide(Svc).build()
		const updating = update('svc.ts', { Svc: service('Svc', () => 2) })
		await tearingDown.promise
		expect(app.get(Svc)).toBe(2)
		let disposed = false
		const disposing = app.dispose().then(() => {
			disposed = true
		})
		await nextTask()
		expect(disposed).toBe(false)
		release.open()
		await disposing
		expect(log).toEqual(['old disposed'])
		await updating
	})

	test('an update during build() is applied once the container has initialized', async () => {
		let created = 0
		const disposed: string[] = []
		const release = gate()
		const Db = service('Db', async (ctx) => {
			created++
			ctx.defer(() => void disposed.push('Db'))
			await release.promise
			return 'db'
		})
		const Other = service('Other', () => 1)
		await update('db.ts', { Db })
		await update('other.ts', { Other })
		const building = container().provide(Db, Other).build()
		const rebuilding = gate()
		const Other2 = service('Other', () => {
			rebuilding.open()
			return 2
		})
		await update('other.ts', { Other: Other2 })
		release.open()
		const app = await building
		// The deferred rebuild is under way, and a later update is queued after its commit.
		await rebuilding.promise
		await update('flush.ts', {})
		expect(created).toBe(1)
		expect(disposed).toEqual([])
		expect(app.get(Db)).toBe('db')
		expect(app.get(Other)).toBe(2)
	})

	test('a container stuck initializing does not hold up updates to others', async () => {
		const held = gate()
		const Hang = service('Hang', async () => {
			await held.promise
			return 1
		})
		const Shared = service('Shared', () => 1)
		await update('hang.ts', { Hang })
		await update('shared.ts', { Shared })
		const stuck = container().provide(Hang, Shared).build()
		const app = await container().provide(Shared).build()
		await update('shared.ts', { Shared: service('Shared', () => 2) })
		expect(app.get(Shared)).toBe(2)
		held.open()
		await stuck
	})

	test('containers dropped without being disposed are not kept alive', async () => {
		const Dropped = service('Dropped', () => 1)
		await update('dropped.ts', { Dropped })
		const before = [...hooks.containers].length
		await (async () => {
			await container().provide(Dropped).build()
		})()
		// A weak reference keeps its target alive until the task that created it ends, and one
		// collection may not reach it, so give the collector a few rounds.
		for (let round = 0; round < 10 && [...hooks.containers].length > before; round++) {
			await nextTask()
			Bun.gc(true)
		}
		expect([...hooks.containers].length).toBe(before)
	})
})
