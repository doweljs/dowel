import { describe, expect, test } from 'bun:test'
import { describeFailure, snapshot, update } from '../../src/hot.ts'
import { container, service, slot } from '../../src/index.ts'
import { resetAfterEach } from './support.ts'

resetAfterEach()

describe('failed replacements', () => {
	test('a proposal that fails to compile leaves the container untouched', async () => {
		const Missing = slot('Missing')<number>()
		const Svc = service('Svc', () => 1)
		await update('svc.ts', { Svc })
		const app = await container().provide(Svc).build()

		const Svc2 = service('Svc', { m: Missing }, ({ m }) => m)
		await expect(update('svc.ts', { Svc: Svc2 })).rejects.toThrow(/Slot 'Missing' is not bound/)
		expect(app.get(Svc)).toBe(1)
		expect(snapshot()[0]!.status).toMatchObject({
			state: 'failed',
			error: expect.stringContaining('Missing'),
		})
	})

	test('a proposal that fails to initialize is discarded, and the committed generation keeps running', async () => {
		const log: string[] = []
		const Svc = service('Svc', (ctx) => {
			ctx.defer(() => void log.push('Svc 1 disposed'))
			return 1
		})
		const Other = service('Other', (ctx) => {
			ctx.defer(() => void log.push('Other 1 disposed'))
			return 1
		})
		await update('m.ts', { Svc, Other })
		const app = await container().provide(Svc, Other).build()

		const Svc2 = service('Svc', async () => {
			throw new Error('cannot start')
		})
		const Other2 = service('Other', (ctx) => {
			log.push('Other 2 created')
			ctx.defer(() => void log.push('Other 2 disposed'))
			return 2
		})
		await expect(update('m.ts', { Svc: Svc2, Other: Other2 })).rejects.toThrow('cannot start')
		// Only what the proposal created was disposed; the old instances were never touched.
		expect(log).toEqual(['Other 2 created', 'Other 2 disposed'])
		expect(app.get(Svc)).toBe(1)
		expect(app.get(Other)).toBe(1)
		expect(snapshot()[0]!.status).toMatchObject({ state: 'failed', error: 'cannot start' })

		// The fix is compared with the committed generation, not the failed proposal.
		const Svc3 = service('Svc', () => 3)
		const Other3 = service('Other', () => 3)
		await update('m.ts', { Svc: Svc3, Other: Other3 })
		expect(log.slice(2)).toEqual(['Other 1 disposed', 'Svc 1 disposed'])
		expect(app.get(Svc)).toBe(3)
		expect(snapshot()[0]!.status).toEqual({ state: 'current', error: null })
	})

	test('a failed proposal does not become the baseline for other modules', async () => {
		const A = service('A', () => 1)
		const B = service('B', () => 1)
		await update('a.ts', { A })
		await update('b.ts', { B })
		const app = await container().provide(A, B).build()

		const A2 = service('A', () => {
			throw new Error('broken A')
		})
		await expect(update('a.ts', { A: A2 })).rejects.toThrow('broken A')
		// A later change elsewhere still proposes the broken A, and still fails.
		await expect(update('b.ts', { B: service('B', () => 2) })).rejects.toThrow('broken A')
		expect(app.get(A)).toBe(1)
		expect(app.get(B)).toBe(1)

		await update('a.ts', { A: service('A', () => 3) })
		expect(app.get(A)).toBe(3)
		expect(app.get(B)).toBe(2)
	})

	test('a throwing disposer is reported, and the container is still on the new graph', async () => {
		const Svc = service('Svc', (ctx) => {
			ctx.defer(() => {
				throw new Error('dispose failed')
			})
			return 1
		})
		await update('svc.ts', { Svc })
		const app = await container().provide(Svc).build()
		const Svc2 = service('Svc', () => 2)
		await expect(update('svc.ts', { Svc: Svc2 })).rejects.toThrow(AggregateError)
		expect(app.get(Svc)).toBe(2)
		expect(snapshot()[0]!.status.state).toBe('current')
	})

	test('a teardown failure is reported even when another container failed to rebuild', async () => {
		const Svc = service('Svc', (ctx) => {
			ctx.defer(() => {
				throw new Error('dispose failed')
			})
			return 1
		})
		await update('svc.ts', { Svc })
		const Needy = service('Needy', { svc: Svc }, ({ svc }) => {
			if (svc === 2) throw new Error('cannot use 2')
			return svc
		})
		await update('needy.ts', { Needy })
		await container().provide(Svc).build()
		await container().provide(Needy).build()

		const error = await update('svc.ts', { Svc: service('Svc', () => 2) }).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(AggregateError)
		expect(describeFailure(error)).toContain('cannot use 2')
		expect(describeFailure(error)).toContain('dispose failed')
	})
})
