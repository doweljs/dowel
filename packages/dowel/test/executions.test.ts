import { describe, expect, test } from 'bun:test'
import {
	bind,
	container,
	DowelError,
	execution,
	optional,
	scope,
	service,
	slot,
} from '../src/index.ts'
import { gate, Logger, memoryLogger, nextTask, PerRequest, Request, untyped } from './support.ts'

describe('executions', () => {
	const JobScope = scope('job')
	const JobInput = slot('JobInput', { scope: JobScope })<{ id: string }>()
	const Clock = service('Clock', () => ({ now: () => 42 }))
	const log: string[] = []
	const JobRunner = service(
		'JobRunner',
		{ input: JobInput, clock: Clock },
		({ input, clock }, ctx) => {
			ctx.defer(() => void log.push(`disposed ${input.id}`))
			return { run: () => `${input.id}@${clock.now()}` }
		},
	)
	const Job = execution('Job', { scope: JobScope, entry: JobRunner, inputs: { input: JobInput } })
	const Scheduler = service('Scheduler', { job: Job }, ({ job }) => ({
		schedule: (id: string) => job({ input: { id } }, (runner) => runner.run()),
	}))

	test('a service launches child work through an injected runner, disposed after the body', async () => {
		log.length = 0
		const app = await container().provide(Scheduler).build()
		expect(await app.get(Scheduler).schedule('a')).toBe('a@42')
		expect(await app.get(Scheduler).schedule('b')).toBe('b@42')
		expect(log).toEqual(['disposed a', 'disposed b'])
		expect(app.get(Job)).toBeInstanceOf(Function)
		expect(Job.scope).toBe('root')
	})

	test('the body may be async and its failure still disposes the run', async () => {
		log.length = 0
		const app = await container().provide(Scheduler).build()
		await expect(
			app.get(Job)({ input: { id: 'x' } }, async () => {
				await nextTask()
				throw new Error('body failed')
			}),
		).rejects.toThrow('body failed')
		expect(log).toEqual(['disposed x'])
	})

	test('disposing the parent aborts a running body and waits for it before disposing beneath it', async () => {
		log.length = 0
		const app = await container().provide(Scheduler).build()
		const started = gate()
		const running = app.get(Job)({ input: { id: 'long' } }, (runner, { signal }) => {
			started.open()
			return new Promise<string>((resolve) => {
				signal.addEventListener('abort', () => {
					log.push(`aborted, ${runner.run()}`)
					resolve('stopped')
				})
			})
		})
		await started.promise
		await app.dispose()
		expect(log).toEqual(['aborted, long@42', 'disposed long'])
		expect(await running).toBe('stopped')
	})

	test('a failing body keeps its error first when cleanup fails too', async () => {
		const Fragile = service('Fragile', { input: JobInput }, (_, ctx) => {
			ctx.defer(() => {
				throw new Error('cleanup failed')
			})
			return 1
		})
		const Run = execution('Run', { scope: JobScope, entry: Fragile, inputs: { input: JobInput } })
		const app = await container().provide(Run).build()
		const error = await app
			.get(Run)({ input: { id: 'x' } }, () => {
				throw new Error('body failed')
			})
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(AggregateError)
		expect((error as AggregateError).message).toMatch(/^Execution 'Run' failed/)
		expect((error as AggregateError).errors.map((e: Error) => e.message)).toEqual([
			'body failed',
			'cleanup failed',
		])
	})

	test("a body resumed during its parent's disposal still finds its resources open", async () => {
		const events: string[] = []
		const Pool = service('Pool', (ctx) => {
			const pool = { open: true }
			ctx.defer(() => {
				pool.open = false
				events.push('pool closed')
			})
			return pool
		})
		const Worker = service('Worker', { pool: Pool, input: JobInput }, ({ pool }) => pool)
		const Work = execution('Work', { scope: JobScope, entry: Worker, inputs: { input: JobInput } })
		const app = await container().provide(Work).build()
		const started = gate()
		const held = gate()
		const running = app.get(Work)({ input: { id: 'gated' } }, async (pool) => {
			started.open()
			await held.promise
			events.push(`body sees pool open: ${pool.open}`)
		})
		await started.promise
		// Disposal starts at once: the parent is disposed and waits for the body.
		const disposing = app.dispose()
		held.open()
		await disposing
		await running
		expect(events).toEqual(['body sees pool open: true', 'pool closed'])
	})

	test("disposing the parent waits for a run's scope to finish cleaning up", async () => {
		const events: string[] = []
		const cleaning = gate()
		const release = gate()
		const Held = service('Held', { input: JobInput }, (_deps, ctx) => {
			ctx.defer(async () => {
				cleaning.open()
				await release.promise
				events.push('run scope cleaned up')
			})
			return {}
		})
		const HeldJob = execution('HeldJob', {
			scope: JobScope,
			entry: Held,
			inputs: { input: JobInput },
		})
		const app = await container().provide(HeldJob).build()
		const running = app.get(HeldJob)({ input: { id: 'held' } }, () => 'done')
		await cleaning.promise
		const disposing = app.dispose().then(() => void events.push('parent disposed'))
		// Pending reactions all run before the next task, so a parent that did not wait would be done.
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(events).toEqual([])
		release.open()
		await Promise.all([running, disposing])
		expect(events).toEqual(['run scope cleaned up', 'parent disposed'])
	})

	test('a run disposed before its body starts never starts it', async () => {
		const events: string[] = []
		const Disposed = service('Disposed', { input: JobInput }, ({ input }, ctx) => {
			ctx.defer(() => void events.push('entry disposed'))
			return input.id
		})
		const Short = execution('Short', {
			scope: JobScope,
			entry: Disposed,
			inputs: { input: JobInput },
		})
		// Disposal starts at every point from the call until well after the body would have started.
		for (let ticks = 0; ticks < 10; ticks++) {
			events.length = 0
			const app = await container().provide(Short).build()
			const running = app.get(Short)({ input: { id: 'x' } }, () => void events.push('body ran'))
			for (let i = 0; i < ticks; i++) await Promise.resolve()
			await app.dispose()
			const outcome = await running.then(
				() => 'ran',
				(error: unknown) => (error instanceof DowelError ? error.code : error),
			)
			if (outcome === 'DISPOSED') expect(events).not.toContain('body ran')
			else expect(events).toEqual(['body ran', 'entry disposed'])
		}
	})

	test('declared inputs must cover what the entry needs', async () => {
		const Other = slot('Other', { scope: JobScope })<number>()
		const Needy = service('Needy', { input: JobInput, other: Other }, (d) => d)
		const Incomplete = execution('Incomplete', {
			scope: JobScope,
			entry: Needy,
			inputs: { input: JobInput },
		})
		await expect(untyped(container().provide(Incomplete)).build()).rejects.toThrow(/needs 'Other'/)
		expect(() =>
			execution('Bad', { scope: JobScope, entry: Needy, inputs: untyped({ request: Request }) }),
		).toThrow(/not 'job'/)
	})

	test('a run takes its inputs by key and rejects keys the execution does not declare', async () => {
		const Echo = service('Echo', { input: JobInput }, ({ input }) => input.id)
		const Run = execution('Run', { scope: JobScope, entry: Echo, inputs: { input: JobInput } })
		const app = await container().provide(Run).build()
		const run = app.get(Run)
		expect(await run({ input: { id: 'a' } }, (id) => id)).toBe('a')
		await expect(untyped(run)({}, (id: string) => id)).rejects.toThrow(
			"Execution 'Run' needs a value for its input 'input' (slot 'JobInput').",
		)
		await expect(
			untyped(run)({ input: { id: 'a' }, extra: 1 }, (id: string) => id),
		).rejects.toThrow("Execution 'Run' has no input 'extra'. Its inputs are 'input'.")
		await expect(untyped(run)((id: string) => id)).rejects.toThrow(/an object of its inputs/)
	})

	test('an execution without inputs runs with only a body', async () => {
		const Plain = execution('Plain', { scope: JobScope, entry: Logger })
		const app = await container().provide(Plain).bind(Logger, memoryLogger()).build()
		const log = await app.get(Plain)((logger) => logger)
		expect(log.lines).toEqual([])
	})

	test('one slot cannot be two inputs', () => {
		expect(() =>
			execution('Twice', {
				scope: JobScope,
				entry: JobRunner,
				inputs: { a: JobInput, b: JobInput },
			}),
		).toThrow("Execution 'Twice' lists 'JobInput' as both input 'a' and input 'b'.")
	})

	test('executions take part in cycle detection', async () => {
		const Back = slot('Back')<unknown>()
		const Loop = service('Loop', { input: JobInput, back: Back }, (d) => d)
		const Exec = execution('Exec', { scope: JobScope, entry: Loop, inputs: { input: JobInput } })
		const Sched = service('Sched', { exec: Exec }, (d) => d)
		await expect(untyped(container().provide(Sched)).bind(Back, Sched).build()).rejects.toThrow(
			/cycle/i,
		)
	})

	test('executions at one scope supply and build only what their own entry needs', async () => {
		const built: string[] = []
		const X = slot('X', { scope: JobScope })<number>()
		const Y = slot('Y', { scope: JobScope })<number>()
		const EX = service('EX', { x: X }, ({ x }) => {
			built.push('EX')
			return x
		})
		const EY = service('EY', { y: Y }, ({ y }) => {
			built.push('EY')
			return y
		})
		const RX = execution('RX', { scope: JobScope, entry: EX, inputs: { x: X } })
		const RY = execution('RY', { scope: JobScope, entry: EY, inputs: { y: Y } })
		const app = await container().provide(RX).provide(RY).build()
		expect(await app.get(RX)({ x: 1 }, (x) => x)).toBe(1)
		expect(await app.get(RY)({ y: 2 }, (y) => y)).toBe(2)
		expect(built).toEqual(['EX', 'EY'])
	})

	test('the entry may live above the execution scope', async () => {
		const ClockJob = execution('ClockJob', { scope: JobScope, entry: Clock })
		const app = await container().provide(ClockJob).build()
		expect(await app.get(ClockJob)((clock) => clock.now())).toBe(42)
	})

	test('a nested execution supplies its own inputs', async () => {
		const Inner = execution('Inner', {
			scope: JobScope,
			entry: JobRunner,
			inputs: { input: JobInput },
		})
		const Outer = service('Outer', { inner: Inner }, ({ inner }) => ({
			run: () => inner({ input: { id: 'inner' } }, (runner) => runner.run()),
		}))
		const OuterJob = execution('OuterJob', { scope: JobScope, entry: Outer })
		const app = await container().provide(OuterJob).build()
		expect(await app.get(OuterJob)((outer) => outer.run())).toBe('inner@42')
	})

	test('a runner called after its frame was disposed rejects with DISPOSED', async () => {
		const app = await container().provide(Scheduler).build()
		const run = app.get(Job)
		await app.dispose()
		await expect(run({ input: { id: 'late' } }, (runner) => runner.run())).rejects.toThrow(
			/disposed/,
		)
	})

	test('an input cannot also be bound at build(), and open() cannot supply a bound slot', async () => {
		await expect(
			untyped(container().provide(Scheduler)).bind(JobInput, { id: 'default' }).build(),
		).rejects.toThrow(/input of execution 'Job'/)
		const Bound = slot('Bound', { scope: JobScope })<number>()
		const Reader = service('Reader', { bound: Bound }, ({ bound }) => bound)
		const app = await container().provide(Reader).bind(Bound, 1).build()
		await expect(untyped(app).open(JobScope, bind(Bound, 2))).rejects.toThrow(/bound at build/)
	})

	test('scopes reject values for slots they cannot supply', async () => {
		const JobSlot = slot('JobSlot', { scope: JobScope })<number>()
		const Flag = slot('Flag')<boolean>()
		const Uses = service('Uses', { job: JobSlot, flag: optional(Flag) }, (d) => d, {
			scope: JobScope,
		})
		const app = await container().provide(Uses).build()
		await expect(untyped(app).open(PerRequest, bind(JobSlot, 1))).rejects.toThrow(
			/lives in scope 'job', so opening 'request' cannot supply it/,
		)
		await expect(untyped(app).open(JobScope, bind(JobSlot, 1), bind(Flag, true))).rejects.toThrow(
			/lives in scope 'root'.*Bind it at build/,
		)
	})

	test('a multi-binding cannot be an execution input', () => {
		const Items = slot('Items', { scope: JobScope, many: true })<number>()
		expect(() =>
			execution('ManyInput', {
				scope: JobScope,
				entry: JobRunner,
				inputs: { items: untyped(Items) },
			}),
		).toThrow(/multi-binding 'Items'/)
	})
})
