import { describe, expect, test } from 'bun:test'
import { forget, update } from '../../src/hot.ts'
import { container, DowelError, service } from '../../src/index.ts'
import { gate } from '../support.ts'
import { resetAfterEach } from './support.ts'

resetAfterEach()

describe('module ownership of names', () => {
	test("a forgotten module's nodes do not alias a later node of the same name", async () => {
		const CacheA = service('Cache', () => 'a')
		await update('a.ts', { Cache: CacheA })
		forget('a.ts')
		const CacheB = service('Cache', () => 'b')
		await update('b.ts', { Cache: CacheB })
		const app = await container().provide(CacheB).build()
		await update('b.ts', { Cache: service('Cache', () => 'b2') })
		expect(app.get(CacheB)).toBe('b2')
		expect(() => app.get(CacheA)).toThrow(/not reachable/)
	})

	test('a name a module stops declaring can be declared by another module', async () => {
		const Mailer = service('Mailer', () => 1)
		await update('mailer.ts', { Mailer })
		const app = await container().provide(Mailer).build()
		await update('mailer.ts', {})
		const Moved = service('Mailer', () => 2)
		await expect(update('email.ts', { Mailer: Moved })).resolves.toEqual({
			changed: ['Mailer'],
			rebuilt: 1,
		})
		// Both the stale and the new reference reach the moved declaration.
		expect(app.get(Mailer)).toBe(2)
		expect(app.get(Moved)).toBe(2)
	})

	test('forget() is ordered with queued updates', async () => {
		const Slow = service('Slow', () => 1)
		await update('slow.ts', { Slow })
		await container().provide(Slow).build()
		const held = gate()
		const blocking = update('slow.ts', {
			Slow: service('Slow', async () => {
				await held.promise
				return 2
			}),
		})
		const queued = update('a.ts', { Cache: service('Cache', () => 'a') })
		const forgotten = forget('a.ts')
		held.open()
		await Promise.all([blocking, queued, forgotten])
		await expect(update('b.ts', { Cache: service('Cache', () => 'b') })).resolves.toEqual({
			changed: [],
			rebuilt: 0,
		})
	})

	test('a name declared by two modules is rejected until the first forgets it', async () => {
		const X = service('X', () => 1)
		await update('a.ts', { X })
		const error = await update('b.ts', { X: service('X', () => 2) }).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(DowelError)
		expect((error as DowelError).code).toBe('DUPLICATE')
		expect((error as Error).message).toMatch(/a\.ts and b\.ts/)
		forget('a.ts')
		await expect(update('b.ts', { X: service('X', () => 2) })).resolves.toEqual({
			changed: [],
			rebuilt: 0,
		})
	})
})
