import { expect, test } from 'bun:test'
import { container } from '@doweljs/core'
import { MemoryCache } from '../src/infra/cache'
import { Clock } from '../src/infra/clock'
import { FakeClock } from './support'

test('cache entries expire when the clock reaches their time to live', async () => {
	await using app = await container().provide(MemoryCache).bind(Clock, FakeClock).build()
	const cache = app.get(MemoryCache)
	const clock = app.get(FakeClock)
	const start = clock.now().getTime()
	cache.set('key', 'value', 1000)
	clock.set(new Date(start + 999))
	expect(cache.get('key')).toBe('value')
	clock.set(new Date(start + 1000))
	expect(cache.get('key')).toBeUndefined()
})
