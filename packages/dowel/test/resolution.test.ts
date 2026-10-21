import { describe, expect, test } from 'bun:test'
import { container, optional, service, slot } from '../src/index.ts'
import { gate, Logger, memoryLogger, nextTask, untyped } from './support.ts'

describe('resolution', () => {
	test('wires concrete services automatically and binds slots', async () => {
		const Config = service('Config', () => ({ greeting: 'hi' }))
		const Greeter = service('Greeter', { config: Config, log: Logger }, ({ config, log }) => ({
			greet: (name: string) => {
				log.info(`greeting ${name}`)
				return `${config.greeting} ${name}`
			},
		}))
		const app = await container().provide(Greeter).bind(Logger, memoryLogger()).build()

		expect(app.get(Greeter).greet('jack')).toBe('hi jack')
		expect(app.get(Logger).lines).toEqual(['greeting jack'])
		expect(app.get(Config)).toBe(app.get(Config))
	})

	test('instances are created once, at build()', async () => {
		let created = 0
		const Counter = service('Counter', () => ({ id: ++created }))
		const app = await container().provide(Counter).build()
		expect(created).toBe(1)
		expect(app.get(Counter)).toBe(app.get(Counter))
		expect(created).toBe(1)
	})

	test('optional slots resolve to undefined when unbound', async () => {
		const Metrics = slot('Metrics')<{ count(): void }>()
		const Svc = service('Svc', { metrics: optional(Metrics) }, ({ metrics }) => ({
			has: metrics !== undefined,
		}))
		expect((await container().provide(Svc).build()).get(Svc).has).toBe(false)
		expect(
			(
				await container()
					.provide(Svc)
					.bind(Metrics, { count() {} })
					.build()
			).get(Svc).has,
		).toBe(true)
		const app = await container().provide(Svc).build()
		expect(app.get(Metrics)).toBeUndefined()
		expect(app.inspect().find((n) => n.name === 'Metrics')).toMatchObject({
			binding: { kind: 'absent' },
		})
	})

	test('a slot can be bound to a service with its own dependencies', async () => {
		const Prefix = service('Prefix', () => '[app]')
		const PrefixedLogger = service('PrefixedLogger', { prefix: Prefix }, ({ prefix }) => {
			const inner = memoryLogger()
			return { lines: inner.lines, info: (m: string) => inner.info(`${prefix} ${m}`) }
		})
		const app = await container().provide(Logger).bind(Logger, PrefixedLogger).build()
		app.get(Logger).info('x')
		expect(app.get(Logger).lines).toEqual(['[app] x'])
		expect(app.get(PrefixedLogger)).toBe(app.get(Logger))
		expect(app.get(Prefix)).toBe('[app]')
	})

	test('use() applies a composition function', async () => {
		const Svc = service('Svc', { log: Logger }, ({ log }) => log)
		const app = await container()
			.with((b) => b.bind(Logger, memoryLogger()))
			.provide(Svc)
			.build()
		expect(app.get(Svc)).toBe(app.get(Logger))
	})

	test('builders are immutable', async () => {
		const base = container().provide(service('S', { log: Logger }, ({ log }) => log))
		const a = base.bind(Logger, memoryLogger())
		const b = base.bind(Logger, memoryLogger())
		expect(a).not.toBe(base)
		expect((await a.build()).get(Logger)).not.toBe((await b.build()).get(Logger))
	})
})

describe('activation', () => {
	test('only roots and what they reach are activated; unreached bindings never run', async () => {
		let created = 0
		const Unused = slot('Unused')<number>()
		const Expensive = service('Expensive', () => ++created)
		const Used = service('Used', () => 1)
		const app = await container().provide(Used).bind(Unused, Expensive).build()
		expect(created).toBe(0)
		expect(() => untyped(app).get(Unused)).toThrow(/not reachable/)
		expect(() => untyped(app).get(Expensive)).toThrow(/not reachable/)

		// Providing the slot itself activates its binding.
		const activated = await container().provide(Used, Unused).bind(Unused, Expensive).build()
		expect(created).toBe(1)
		expect(activated.get(Unused)).toBe(1)
	})
})

describe('async', () => {
	test('async factories are awaited by build() and resolved synchronously afterwards', async () => {
		const Db = service('Db', async () => {
			await nextTask()
			return { ready: true }
		})
		const Users = service('Users', { db: Db }, ({ db }) => ({ ok: db.ready }))
		const app = await container().provide(Users).build()
		expect(app.get(Users).ok).toBe(true)
		expect(app.get(Db).ready).toBe(true)
	})

	test('independent async services initialize concurrently', async () => {
		const order: string[] = []
		const bEnded = gate()
		// A can only finish once B has, so it cannot run to completion before B starts.
		const A = service('A', async () => {
			order.push('A:start')
			await bEnded.promise
			order.push('A:end')
			return 'A'
		})
		const B = service('B', async () => {
			order.push('B:start')
			await nextTask()
			order.push('B:end')
			bEnded.open()
			return 'B'
		})
		const Both = service('Both', { a: A, b: B }, ({ a, b }) => a + b)
		const app = await container().provide(Both).build()
		expect(order.slice(0, 2)).toEqual(['A:start', 'B:start'])
		expect(order.at(-1)).toBe('A:end')
		expect(app.get(Both)).toBe('AB')
	})

	test('a sync service between async ones is initialized in order', async () => {
		const Conn = service('Conn', async () => ({ url: 'db' }))
		const Repo = service('Repo', { conn: Conn }, ({ conn }) => ({ url: conn.url }))
		const Warm = service('Warm', { repo: Repo }, async ({ repo }) => `${repo.url}!`)
		const app = await container().provide(Warm).build()
		expect(app.get(Warm)).toBe('db!')
	})
})
