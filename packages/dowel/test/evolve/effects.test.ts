import { describe, expect, test } from 'bun:test'
import { prepare } from '../../src/evolve.ts'
import {
	bind,
	container,
	execution,
	type ServiceContext,
	scope,
	service,
	slot,
} from '../../src/index.ts'
import { nextTask, PerRequest, Request } from '../support.ts'

/** A port that a successor takes over from its predecessor. */
function port(events: string[], tag: string) {
	return service('Port', (ctx) => {
		ctx.whileActive((previous, { generation }) => {
			events.push(`${tag} starts generation ${generation} from ${String(previous)}`)
			return () => {
				events.push(`${tag} stops`)
				return `socket of ${tag}`
			}
		})
		return tag
	})
}

describe('effects', () => {
	test('an effect starts once the container is built, and stops when it is disposed', async () => {
		const events: string[] = []
		const app = await container().provide(port(events, 'a')).build()
		expect(events).toEqual(['a starts generation 1 from undefined'])

		await app.dispose()
		expect(events).toEqual(['a starts generation 1 from undefined', 'a stops'])
	})

	test("a successor's effect starts from what its predecessor's handed over", async () => {
		const events: string[] = []
		const first = await container().provide(port(events, 'a')).build()
		const candidate = await prepare(first, container().provide(port(events, 'b')))
		expect(events).toEqual(['a starts generation 1 from undefined'])

		await candidate.activate()
		expect(events).toEqual([
			'a starts generation 1 from undefined',
			'a stops',
			'b starts generation 2 from socket of a',
		])
		await first.dispose()
	})

	test('a hand-over nothing claims passes on to the next generation', async () => {
		const events: string[] = []
		const Other = service('Other', () => 'other')
		const first = await container().provide(port(events, 'a')).build()
		await (await prepare(first, container().provide(Other))).activate()
		await (await prepare(first, container().provide(port(events, 'c')))).activate()

		expect(events.at(-1)).toBe('c starts generation 3 from socket of a')
		await first.dispose()
	})

	test('an effect that fails to start rolls the activation back, and the predecessor resumes', async () => {
		const events: string[] = []
		const Failing = service('Failing', { port: port(events, 'b') }, (_, ctx) => {
			ctx.whileActive(() => {
				throw new Error('cannot start')
			})
		})
		const first = await container().provide(port(events, 'a')).build()
		const candidate = await prepare(first, container().provide(Failing))

		const failure = await candidate.activate().catch((error: unknown) => error)
		expect(failure).toMatchObject({
			code: 'ACTIVATION_FAILED',
			cause: expect.objectContaining({ message: 'cannot start' }),
		})
		expect(events).toEqual([
			'a starts generation 1 from undefined',
			'a stops',
			'b starts generation 2 from socket of a',
			'b stops',
			'a starts generation 1 from socket of b',
		])
		expect(() => candidate.container.get(Failing)).toThrow(
			expect.objectContaining({ code: 'DISPOSED' }) as never,
		)
		expect((await (await prepare(first, container())).activate()).generation).toBe(2)
		await first.dispose()
	})

	test('an effect that fails to stop keeps its generation running, without starting it again', async () => {
		const events: string[] = []
		const Stubborn = service('Stubborn', (ctx) => {
			ctx.whileActive(() => {
				events.push('stubborn starts')
				return () => {
					throw new Error('cannot stop')
				}
			})
			return 'stubborn'
		})
		const first = await container().provide(Stubborn).build()

		const failure = await (await prepare(first, container().provide(port(events, 'b'))))
			.activate()
			.catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(AggregateError)
		const [activation, ...cleanup] = (failure as AggregateError).errors
		expect(activation).toMatchObject({
			code: 'ACTIVATION_FAILED',
			cause: expect.objectContaining({ message: 'cannot stop' }),
		})
		expect(cleanup).toEqual([
			expect.objectContaining({ message: expect.stringContaining('not started again') }),
		])
		expect(events).toEqual(['stubborn starts'])
		expect(first.get(Stubborn)).toBe('stubborn')
		await first.dispose()
	})

	test('a candidate starts no effect until it is activated', async () => {
		const events: string[] = []
		const first = await container().build()
		const candidate = await prepare(first, container().provide(port(events, 'b')))
		expect(events).toEqual([])

		await candidate.discard()
		expect(events).toEqual([])
		await first.dispose()
	})

	test('a build whose effect fails to start fails, disposing what it created', async () => {
		const events: string[] = []
		const Failing = service('Failing', { port: port(events, 'a') }, (_, ctx) => {
			ctx.whileActive(() => {
				throw new Error('cannot start')
			})
		})

		await expect(container().provide(Failing).build()).rejects.toThrow('cannot start')
		expect(events).toEqual(['a starts generation 1 from undefined', 'a stops'])
	})

	test('an instance a run creates while its generation is active starts its effect first', async () => {
		const events: string[] = []
		const JobScope = scope('job')
		const Input = slot('Input', { scope: JobScope })<boolean>()
		const Watcher = service('Watcher', { fail: Input }, ({ fail }) => fail)
		const Job = execution('Job', { scope: JobScope, entry: Watcher, inputs: { fail: Input } })
		const Lazy = service('Lazy', (ctx) => {
			ctx.whileActive(() => {
				events.push('lazy starts')
				if (events.length === 1) throw new Error('first start fails')
			})
			return 'lazy'
		})
		const Uses = service('Uses', { fail: Input, lazy: Lazy }, ({ fail }) => fail)
		const UseLazy = execution('UseLazy', { scope: JobScope, entry: Uses, inputs: { fail: Input } })
		const app = await container().provide(Job, UseLazy).build()

		await expect(app.get(UseLazy)({ fail: false }, () => 'ran')).rejects.toThrow(
			'first start fails',
		)
		expect(await app.get(UseLazy)({ fail: false }, () => 'ran')).toBe('ran')
		expect(events).toEqual(['lazy starts', 'lazy starts'])
		await app.dispose()
	})

	test('only root-scope services run effects, one each', async () => {
		const Scoped = service('Scoped', { request: Request }, (_, ctx) => {
			ctx.whileActive(() => {})
		})
		const Twice = service('Twice', (ctx) => {
			ctx.whileActive(() => {})
			ctx.whileActive(() => {})
		})
		const app = await container().provide(Scoped).build()

		await expect(app.open(PerRequest, bind(Request, { url: '/' }))).rejects.toMatchObject({
			code: 'INVALID_EFFECT',
		})
		await expect(container().provide(Twice).build()).rejects.toMatchObject({
			code: 'INVALID_EFFECT',
		})
		await app.dispose()
	})

	test('disposing a container stops an effect a run is still starting, through its signal', async () => {
		const started: string[] = []
		const JobScope = scope('job')
		const Input = slot('Input', { scope: JobScope })<number>()
		const Lazy = service('Lazy', (ctx) => {
			ctx.whileActive((_, { signal }) => {
				started.push('lazy')
				return new Promise((_, reject) => {
					signal.addEventListener('abort', () => reject(signal.reason))
				})
			})
		})
		const Uses = service('Uses', { input: Input, lazy: Lazy }, ({ input }) => input)
		const Use = execution('Use', { scope: JobScope, entry: Uses, inputs: { input: Input } })
		const app = await container().provide(Use).build()
		const running = app
			.get(Use)({ input: 1 }, (n) => n)
			.catch((error: unknown) => error)
		await nextTask()
		expect(started).toEqual(['lazy'])

		await app.dispose()
		expect(await running).toMatchObject({ code: 'DISPOSED' })
	})

	test('an effect that never starts fails the activation after the timeout, and the predecessor resumes', async () => {
		const events: string[] = []
		const Never = service('Never', (ctx) => {
			// Ignores even its signal, so disposing the candidate goes on in the background.
			ctx.whileActive(() => new Promise(() => {}))
		})
		const first = await container().provide(port(events, 'a')).build()
		const candidate = await prepare(first, container().provide(Never))

		const failure = await candidate.activate({ timeout: 20 }).catch((error: unknown) => error)
		const [activation] = failure instanceof AggregateError ? failure.errors : [failure]
		expect(activation).toMatchObject({
			code: 'ACTIVATION_FAILED',
			cause: expect.objectContaining({ message: expect.stringContaining('did not start') }),
		})
		expect(events.at(-1)).toBe('a starts generation 1 from socket of a')
		await first.dispose()
	})

	test('a start given up on hands what it took back to the predecessor', async () => {
		const events: string[] = []
		const HungPort = service('Port', (ctx) => {
			ctx.whileActive(() => new Promise(() => {}))
		})
		const first = await container().provide(port(events, 'a')).build()

		const failure = await (await prepare(first, container().provide(HungPort)))
			.activate({ timeout: 20 })
			.catch((error: unknown) => error)
		expect(failure).toBeDefined()
		expect(events.at(-1)).toBe('a starts generation 1 from socket of a')
		await first.dispose()
	})

	test('an effect is registered while the factory runs, not after', async () => {
		let kept: ServiceContext | undefined
		const Late = service('Late', (ctx) => {
			kept = ctx
			return 'late'
		})
		const app = await container().provide(Late).build()

		expect(() => kept!.whileActive(() => {})).toThrow(
			expect.objectContaining({ code: 'INVALID_EFFECT' }) as never,
		)
		await app.dispose()
	})
})
