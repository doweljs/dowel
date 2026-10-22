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

	/** A body that settles only once its signal aborts. */
	const untilAborted =
		(events: string[], id: string) =>
		(_runner: unknown, { signal }: { signal: AbortSignal }) =>
			new Promise<void>((resolve) => {
				signal.addEventListener('abort', () => {
					events.push(`${id} aborted`)
					resolve()
				})
			})

	test('disposal aborts every run before waiting for any, so a run may wait on an older one', async () => {
		const events: string[] = []
		const app = await container().provide(Job).build()
		const job = app.get(Job)
		const producer = job({ input: { id: 'producer' } }, untilAborted(events, 'producer'))
		// The newer run is waited for first, and finishes only once the older one stops.
		const consumer = job({ input: { id: 'consumer' } }, async () => {
			await producer
			events.push('consumer drained')
		})
		await nextTask()
		await app.dispose()
		await consumer
		expect(events).toEqual(['producer aborted', 'consumer drained'])
	})

	test('disposal aborts runs in every opened container before waiting for any', async () => {
		const events: string[] = []
		const Task = scope('task', PerRequest)
		const RequestJob = execution('RequestJob', { scope: Task, entry: Clock })
		const app = await container().provide(RequestJob).build()
		const first = await app.open(PerRequest, bind(Request, { url: '/first' }))
		const second = await app.open(PerRequest, bind(Request, { url: '/second' }))
		const producer = first.get(RequestJob)(untilAborted(events, 'producer'))
		// The newer container is disposed first, and its run waits on a run in the older one.
		const consumer = second.get(RequestJob)(async () => {
			await producer
			events.push('consumer drained')
		})
		await nextTask()
		await app.dispose()
		await consumer
		expect(events).toEqual(['producer aborted', 'consumer drained'])
	})

	test('disposal aborts runs nested in a run before waiting for its body', async () => {
		const events: string[] = []
		const SubTask = scope('subtask', JobScope)
		// Lives in the job scope, so its runs belong to the outer run.
		const InnerJob = execution('InnerJob', { scope: SubTask, entry: Clock })
		const Nested = service('Nested', { inner: InnerJob }, ({ inner }) => inner)
		const OuterJob = execution('OuterJob', { scope: JobScope, entry: Nested })
		const app = await container().provide(OuterJob).build()
		// The outer body ignores its own signal and waits for the inner run.
		const outer = app.get(OuterJob)(async (inner) => {
			await inner(untilAborted(events, 'inner'))
			events.push('outer done')
		})
		await nextTask()
		await app.dispose()
		await outer
		expect(events).toEqual(['inner aborted', 'outer done'])
	})

	test("a run that finishes on its own leaves its body's signal alone", async () => {
		const app = await container().provide(Job).build()
		const signals: AbortSignal[] = []
		await app.get(Job)(
			{ input: { id: 'done' } },
			(_runner, { signal }) => void signals.push(signal),
		)
		await expect(
			app.get(Job)({ input: { id: 'failed' } }, (_runner, { signal }) => {
				signals.push(signal)
				throw new Error('body failed')
			}),
		).rejects.toThrow('body failed')
		expect(signals.map((signal) => signal.aborted)).toEqual([false, false])
	})

	/** A job whose entry keeps starting until `opened` settles, or, if `honour`, its signal aborts. */
	function startingJob(events: string[], opened: Promise<void>, honour: boolean) {
		const starting = gate()
		const Starting = service('Starting', { input: JobInput }, async ({ input }, ctx) => {
			starting.open()
			const aborted = new Promise<void>((resolve) => {
				ctx.signal.addEventListener('abort', () => {
					events.push(`${input.id} factory aborted`)
					resolve()
				})
			})
			await (honour ? Promise.race([opened, aborted]) : opened)
			return input.id
		})
		const StartingJob = execution('StartingJob', {
			scope: JobScope,
			entry: Starting,
			inputs: { input: JobInput },
		})
		return { starting: starting.promise, StartingJob }
	}

	test('disposal aborts factories still starting in runs before waiting for any run', async () => {
		const events: string[] = []
		const { starting, StartingJob } = startingJob(events, new Promise<void>(() => {}), true)
		const app = await container().provide(StartingJob, Job).build()
		const older = app.get(StartingJob)({ input: { id: 'older' } }, () => {
			events.push('older body ran')
		})
		await starting
		// The newer run is waited for first, and finishes only once the older one settles.
		const newer = app.get(Job)({ input: { id: 'newer' } }, () => older.catch(() => {}))
		await nextTask()
		await app.dispose()
		await expect(older).rejects.toThrow(/disposed before its body started/)
		await newer
		expect(events).toEqual(['older factory aborted'])
	})

	test('a run whose owner started disposing never starts its body, even before disposal reaches it', async () => {
		const events: string[] = []
		const opened = gate()
		const { starting, StartingJob } = startingJob(events, opened.promise, false)
		const app = await container().provide(StartingJob, Job).build()
		const older = app.get(StartingJob)({ input: { id: 'older' } }, () => {
			events.push('older body ran')
		})
		// Handled now: it rejects while the test still waits on disposal.
		older.catch(() => {})
		await starting
		const release = gate()
		const newer = app.get(Job)({ input: { id: 'newer' } }, () => release.promise)
		await nextTask()
		const disposing = app.dispose()
		// The older run finishes starting while disposal still waits for the newer body.
		opened.open()
		await nextTask()
		release.open()
		await disposing
		await newer
		await expect(older).rejects.toThrow(/disposed before its body started/)
		expect(events).not.toContain('older body ran')
	})

	test('a body that starts disposing its owner synchronously is still waited for', async () => {
		const events: string[] = []
		const Res = service('Res', { input: JobInput }, (_deps, ctx) => {
			const res = { open: true }
			ctx.defer(() => {
				res.open = false
				events.push('res disposed')
			})
			return res
		})
		const UseRes = execution('UseRes', { scope: JobScope, entry: Res, inputs: { input: JobInput } })
		const app = await container().provide(UseRes).build()
		let disposing: Promise<void> | undefined
		await app.get(UseRes)({ input: { id: 'x' } }, async (res) => {
			disposing = app.dispose()
			await nextTask()
			events.push(`used, open: ${res.open}`)
		})
		await disposing
		expect(events).toEqual(['used, open: true', 'res disposed'])
	})

	test('a run aborted while it opens reports the disposal, however its factory fails on the abort', async () => {
		const starting = gate()
		const Connect = service('Connect', { input: JobInput }, (_deps, ctx) => {
			starting.open()
			return new Promise((_resolve, reject) => {
				ctx.signal.addEventListener('abort', () =>
					reject(new DOMException('The operation was aborted.', 'AbortError')),
				)
			})
		})
		const ConnectJob = execution('ConnectJob', {
			scope: JobScope,
			entry: Connect,
			inputs: { input: JobInput },
		})
		const app = await container().provide(ConnectJob).build()
		const running = app.get(ConnectJob)({ input: { id: 'x' } }, () => 'ran')
		running.catch(() => {})
		await starting.promise
		await app.dispose()
		const error = await running.then(
			() => null,
			(failure: unknown) => failure,
		)
		expect((error as DowelError).code).toBe('DISPOSED')
		expect((error as Error).message).toMatch(/disposed before its body started/)
	})

	test('a run disposed before its body starts reports the disposal first when cleanup fails too', async () => {
		const opened = gate()
		const Leaky = service('Leaky', { input: JobInput }, async (_deps, ctx) => {
			ctx.defer(() => {
				throw new Error('cleanup failed')
			})
			await opened.promise
			return {}
		})
		const LeakyJob = execution('LeakyJob', {
			scope: JobScope,
			entry: Leaky,
			inputs: { input: JobInput },
		})
		const app = await container().provide(LeakyJob).build()
		const running = app.get(LeakyJob)({ input: { id: 'x' } }, () => 'ran')
		running.catch(() => {})
		await nextTask()
		const disposing = app.dispose().catch(() => {})
		// The factory ignores the abort and finishes; the body never starts.
		opened.open()
		await disposing
		const error = (await running.then(
			() => null,
			(failure: unknown) => failure,
		)) as AggregateError
		expect(error).toBeInstanceOf(AggregateError)
		expect((error.errors[0] as DowelError).code).toBe('DISPOSED')
		expect((error.errors[1] as Error).message).toBe('cleanup failed')
	})

	test("a body's signal names its run, with its own reason each time the run is disposed", async () => {
		const reasons: unknown[] = []
		for (let i = 0; i < 2; i++) {
			const app = await container().provide(Job).build()
			const started = gate()
			const running = app.get(Job)({ input: { id: 'x' } }, async (_runner, { signal }) => {
				started.open()
				await new Promise((resolve) => signal.addEventListener('abort', resolve))
				reasons.push(signal.reason)
			})
			await started.promise
			await app.dispose()
			await running
		}
		const [first, second] = reasons as Error[]
		expect(first!.message).toBe("Execution 'Job' is being disposed.")
		expect((first!.cause as Error).message).toBe("Scope 'root' is being disposed.")
		// One disposal's error is not another's, so neither carries the other's stack or tags.
		expect(second).not.toBe(first)
		expect(second!.cause).not.toBe(first!.cause)
	})

	test("a run stopped by a sibling's failure says so, not that it was disposed", async () => {
		const Task = scope('siblingTask')
		const Noop = service('Noop', () => 0)
		const Work = execution('Work', { scope: Task, entry: Noop })
		let stopped: unknown
		const Starter = service('Starter', { work: Work }, async ({ work }) => {
			await work(() => 'ran').catch((error: unknown) => {
				stopped = error
			})
		})
		const Broken = service('Broken', () => {
			throw new Error('misconfigured')
		})
		await expect(container().provide(Starter, Broken).build()).rejects.toThrow('misconfigured')
		expect((stopped as Error).message).toBe(
			"Execution 'Work' did not start: Scope 'root' stopped starting services after one failed.",
		)
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
