import { describe, expect, test } from 'bun:test'
import { prepare } from '../../src/evolve.ts'
import { container, DowelError, service, slot } from '../../src/index.ts'
import { gate, nextTask, untyped } from '../support.ts'

const Greeting = slot('Greeting')<string>()
const Greeter = service('Greeter', { greeting: Greeting }, ({ greeting }) => ({
	greet: (name: string) => `${greeting}, ${name}`,
}))
const app = (greeting: string) => container().provide(Greeter).bind(Greeting, greeting)

describe('generations', () => {
	test('a candidate is built beside the running container and takes over once activated', async () => {
		const first = await app('Hello').build()
		const candidate = await prepare(first, app('Hi'))

		expect(candidate.container.get(Greeter).greet('Ada')).toBe('Hi, Ada')
		expect(first.get(Greeter).greet('Ada')).toBe('Hello, Ada')

		const activation = await candidate.activate()
		expect(activation.generation).toBe(2)
		expect(activation.container).toBe(candidate.container)
		expect(first.get(Greeter).greet('Ada')).toBe('Hi, Ada')
		await activation.retired
		await first.dispose()
	})

	test('generations count up along a lineage, which any of its containers can be succeeded through', async () => {
		const first = await app('a').build()
		const second = await (await prepare(first, app('b'))).activate()
		const third = await (await prepare(first, app('c'))).activate()

		expect(third.generation).toBe(3)
		expect(second.container.get(Greeter).greet('x')).toBe('c, x')
		await third.container.dispose()
	})

	test('a candidate that fails to build leaves the running container as it was', async () => {
		const first = await app('Hello').build()
		const Broken = service('Broken', () => {
			throw new Error('broken factory')
		})

		await expect(prepare(first, app('Hi').provide(Broken))).rejects.toThrow('broken factory')
		expect(first.get(Greeter).greet('Ada')).toBe('Hello, Ada')
		expect((await (await prepare(first, app('Hi'))).activate()).generation).toBe(2)
		await first.dispose()
	})

	test('a discarded candidate is disposed, and the running container stays active', async () => {
		const disposed: string[] = []
		const Tracked = service('Tracked', (ctx) => {
			ctx.defer(() => void disposed.push('candidate'))
			return 'tracked'
		})
		const first = await app('Hello').build()
		const candidate = await prepare(first, app('Hi').provide(Tracked))

		await candidate.discard()
		expect(disposed).toEqual(['candidate'])
		expect(() => candidate.container.get(Greeter)).toThrow(DowelError)
		expect((await (await prepare(first, app('Hi'))).activate()).generation).toBe(2)
		await first.dispose()
	})

	test('a candidate is activated or discarded once', async () => {
		const first = await app('a').build()
		const candidate = await prepare(first, app('b'))
		await candidate.activate()

		await expect(candidate.activate()).rejects.toMatchObject({ code: 'SUPERSEDED' })
		expect(() => candidate.discard()).toThrow(
			expect.objectContaining({ code: 'SUPERSEDED' }) as never,
		)
		await first.dispose()
	})

	test('of two candidates for one container, the second to activate is refused and discarded', async () => {
		const first = await app('a').build()
		const one = await prepare(first, app('b'))
		const other = await prepare(first, app('c'))
		await one.activate()

		await expect(other.activate()).rejects.toMatchObject({ code: 'SUPERSEDED' })
		expect(() => other.container.get(Greeter)).toThrow(
			expect.objectContaining({ code: 'DISPOSED' }) as never,
		)
		expect(first.get(Greeter).greet('x')).toBe('b, x')
		await first.dispose()
	})

	test('a disposed container cannot be succeeded', async () => {
		const first = await app('a').build()
		await first.dispose()

		await expect(prepare(first, app('b'))).rejects.toMatchObject({ code: 'SUPERSEDED' })
	})

	test('prepare() takes a container and a builder of this copy of dowel', async () => {
		const first = await app('a').build()

		await expect(prepare(untyped({}), app('b'))).rejects.toMatchObject({ code: 'INVALID_NODE' })
		await expect(prepare(first, untyped({ build: () => first }))).rejects.toMatchObject({
			code: 'INVALID_NODE',
		})
		await first.dispose()
	})

	/** A port whose effect logs each start and waits for `held` to stop, as a server finishing requests would. */
	function loggedPort(events: string[], tag: string, held?: Promise<void>) {
		return service('Port', (ctx) => {
			ctx.whileActive((previous) => {
				events.push(`${tag} starts from ${String(previous)}`)
				return async () => {
					await held
					events.push(`${tag} stops`)
					return tag
				}
			})
		})
	}

	test('a candidate disposed before it is activated does not take over', async () => {
		const first = await app('a').build()
		const candidate = await prepare(first, app('b'))
		await candidate.container.dispose()

		await expect(candidate.activate()).rejects.toMatchObject({ code: 'SUPERSEDED' })
		expect(first.get(Greeter).greet('x')).toBe('a, x')
		expect((await (await prepare(first, app('c'))).activate()).generation).toBe(2)
		await first.dispose()
	})

	test('a container disposed while it hands over takes its candidate with it', async () => {
		const events: string[] = []
		const held = gate()
		const first = await container()
			.provide(loggedPort(events, 'a', held.promise))
			.build()
		const candidate = await prepare(first, container().provide(loggedPort(events, 'b')))
		const activation = candidate.activate().catch((error: unknown) => error)
		await nextTask()

		const disposal = first.dispose()
		held.open()
		expect(await activation).toMatchObject({ code: 'SUPERSEDED' })
		await disposal
		expect(events).toEqual(['a starts from undefined', 'a stops'])
		expect(() => untyped(candidate.container).get(Greeter)).toThrow(
			expect.objectContaining({ code: 'DISPOSED' }) as never,
		)
	})

	test('a candidate disposed while its effects start leaves its predecessor running', async () => {
		const events: string[] = []
		const starting = gate()
		const held = gate()
		const Slow = service('Slow', { port: loggedPort(events, 'b') }, (_, ctx) => {
			ctx.whileActive(async () => {
				starting.open()
				await held.promise
			})
		})
		const first = await container().provide(loggedPort(events, 'a')).build()
		const candidate = await prepare(first, container().provide(Slow))
		const activation = candidate.activate().catch((error: unknown) => error)
		await starting.promise

		const disposal = candidate.container.dispose()
		held.open()
		await disposal
		expect(await activation).toMatchObject({ code: 'SUPERSEDED' })
		expect(events).toContain('a starts from a')
		expect((await (await prepare(first, container())).activate()).generation).toBe(2)
		await first.dispose()
	})
})
