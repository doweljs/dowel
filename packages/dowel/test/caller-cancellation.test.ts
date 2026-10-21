import { describe, expect, test } from 'bun:test'
import { bind, container, execution, scope, service, slot } from '../src/index.ts'
import { gate, PerRequest, Request, untyped } from './support.ts'

describe('caller cancellation', () => {
	const Task = scope('task')
	const TaskId = slot('TaskId', { scope: Task })<string>()

	/** A task scope whose services log their lifecycle; `Slow` starts only once `opened` opens. */
	function fixture() {
		const events: string[] = []
		const starting = gate()
		const opened = gate()
		const Fast = service('Fast', { id: TaskId }, ({ id }, ctx) => {
			ctx.defer(() => void events.push('fast disposed'))
			return id
		})
		const Slow = service('Slow', { fast: Fast }, async ({ fast }, ctx) => {
			ctx.signal.addEventListener('abort', () => void events.push('slow aborted'))
			starting.open()
			await opened.promise
			ctx.defer(() => void events.push('slow disposed'))
			return fast
		})
		const After = service('After', { slow: Slow }, ({ slow }) => {
			events.push('after created')
			return slow
		})
		const TaskJob = execution('TaskJob', { scope: Task, entry: After, inputs: { id: TaskId } })
		return { events, starting, opened, TaskJob }
	}

	/** Settles once `signal` aborts. */
	const aborted = (signal: AbortSignal): Promise<void> =>
		new Promise((resolve) => signal.addEventListener('abort', () => resolve()))

	test('a run called with an aborted signal rejects with its reason and creates nothing', async () => {
		const { events, TaskJob } = fixture()
		const app = await container().provide(TaskJob).build()
		const reason = new Error('gave up')
		const body = (): void => void events.push('body ran')
		await expect(
			app.get(TaskJob)({ id: 'a' }, body, { signal: AbortSignal.abort(reason) }),
		).rejects.toBe(reason)
		expect(events).toEqual([])
	})

	test('aborting while it opens stops its factories, disposes what was created, and skips the body', async () => {
		const { events, starting, opened, TaskJob } = fixture()
		const app = await container().provide(TaskJob).build()
		const caller = new AbortController()
		const reason = new Error('client went away')
		const run = app.get(TaskJob)({ id: 'a' }, () => void events.push('body ran'), {
			signal: caller.signal,
		})
		await starting.promise
		caller.abort(reason)
		// The factory ignores its signal; the run still waits for it before disposing.
		opened.open()
		await expect(run).rejects.toBe(reason)
		expect(events).toEqual(['slow aborted', 'slow disposed', 'fast disposed'])
		await app.dispose()
	})

	test('a factory that fails with the reason it was aborted with reports just that', async () => {
		const starting = gate()
		const Connection = service('Connection', { id: TaskId }, (_deps, ctx) => {
			starting.open()
			return new Promise((_resolve, reject) => {
				ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason))
			})
		})
		const Connect = execution('Connect', { scope: Task, entry: Connection, inputs: { id: TaskId } })
		const app = await container().provide(Connect).build()
		const caller = new AbortController()
		const reason = new Error('client went away')
		const run = app.get(Connect)({ id: 'a' }, () => {}, { signal: caller.signal })
		await starting.promise
		caller.abort(reason)
		await expect(run).rejects.toBe(reason)
	})

	test('a failure the abort did not cause rides along behind the reason', async () => {
		const starting = gate()
		const Connection = service('Connection', { id: TaskId }, (_deps, ctx) => {
			starting.open()
			return new Promise((_resolve, reject) => {
				ctx.signal.addEventListener('abort', () => reject(new Error('socket closed badly')))
			})
		})
		const Connect = execution('Connect', { scope: Task, entry: Connection, inputs: { id: TaskId } })
		const app = await container().provide(Connect).build()
		const caller = new AbortController()
		const reason = new Error('client went away')
		const run = app.get(Connect)({ id: 'a' }, () => {}, { signal: caller.signal })
		run.catch(() => {})
		await starting.promise
		caller.abort(reason)
		const error = (await run.then(
			() => null,
			(failure: unknown) => failure,
		)) as AggregateError
		expect(error.errors[0]).toBe(reason)
		expect((error.errors[1] as Error).message).toBe('socket closed badly')
	})

	test('a factory that failed before the caller aborted keeps its own error', async () => {
		const slowStarting = gate()
		const release = gate()
		const Broken = service('Broken', { id: TaskId }, async () => {
			throw new Error('misconfigured')
		})
		// Ignores its signal, so the opening is still going when the caller aborts.
		const Slow = service('Slow', { id: TaskId }, async () => {
			slowStarting.open()
			await release.promise
			return 'slow'
		})
		const Both = service('Both', { broken: Broken, slow: Slow }, (deps) => deps)
		const Work = execution('Work', { scope: Task, entry: Both, inputs: { id: TaskId } })
		const app = await container().provide(Work).build()
		const caller = new AbortController()
		const run = app.get(Work)({ id: 'a' }, () => {}, { signal: caller.signal })
		run.catch(() => {})
		await slowStarting.promise
		await new Promise((resolve) => setTimeout(resolve, 0))
		caller.abort(new Error('timed out'))
		release.open()
		await expect(run).rejects.toThrow('misconfigured')
	})

	test('aborted after everything was created but before the body, the run still rejects', async () => {
		const opened = gate()
		const starting = gate()
		const Entry = service('Entry', { id: TaskId }, async ({ id }) => {
			starting.open()
			await opened.promise
			return id
		})
		const Work = execution('Work', { scope: Task, entry: Entry, inputs: { id: TaskId } })
		const app = await container().provide(Work).build()
		const caller = new AbortController()
		const reason = new Error('gave up')
		let ran = false
		const run = app.get(Work)(
			{ id: 'a' },
			() => {
				ran = true
			},
			{ signal: caller.signal },
		)
		await starting.promise
		caller.abort(reason)
		// The factory ignores the abort and finishes, so opening succeeds.
		opened.open()
		await expect(run).rejects.toBe(reason)
		expect(ran).toBe(false)
	})

	test('aborting while the body runs aborts its signal, and the run settles as the body does', async () => {
		const { events, opened, TaskJob } = fixture()
		opened.open()
		const app = await container().provide(TaskJob).build()
		const caller = new AbortController()
		const reason = new Error('timed out')
		const started = gate()
		const run = app.get(TaskJob)(
			{ id: 'a' },
			async (id, { signal }) => {
				started.open()
				await aborted(signal)
				events.push(`body aborted: ${signal.reason === reason}`)
				return `${id} partial`
			},
			{ signal: caller.signal },
		)
		await started.promise
		caller.abort(reason)
		expect(await run).toBe('a partial')
		expect(events).toEqual([
			'after created',
			'body aborted: true',
			'slow aborted',
			'slow disposed',
			'fast disposed',
		])
	})

	test('a body may reject with the reason itself', async () => {
		const { opened, TaskJob } = fixture()
		opened.open()
		const app = await container().provide(TaskJob).build()
		const caller = new AbortController()
		const reason = new Error('stop')
		const run = app.get(TaskJob)(
			{ id: 'a' },
			async (_id, { signal }) => {
				caller.abort(reason)
				signal.throwIfAborted()
			},
			{ signal: caller.signal },
		)
		await expect(run).rejects.toBe(reason)
	})

	describe('beneath a cancelled run', () => {
		const Sub = scope('sub', Task)
		const Inner = service('Inner', { id: TaskId }, ({ id }) => id)
		const Nested = execution('Nested', { scope: Sub, entry: Inner })
		const Outer = service('Outer', { id: TaskId, nested: Nested }, ({ nested }) => nested)
		const OuterJob = execution('OuterJob', { scope: Task, entry: Outer, inputs: { id: TaskId } })

		test('a nested run already going is aborted with the caller’s reason', async () => {
			const app = await container().provide(OuterJob).build()
			const caller = new AbortController()
			const reason = new Error('gave up')
			const started = gate()
			const run = app.get(OuterJob)(
				{ id: 'a' },
				// The outer body ignores its own signal and waits for the nested run.
				(nested) =>
					nested(async (_id, { signal }) => {
						started.open()
						await aborted(signal)
						return signal.reason
					}),
				{ signal: caller.signal },
			)
			await started.promise
			caller.abort(reason)
			expect(await run).toBe(reason)
		})

		test('a nested run started after the abort is born cancelled, and its body never runs', async () => {
			const app = await container().provide(OuterJob).build()
			const caller = new AbortController()
			const reason = new Error('gave up')
			const started = gate()
			let cleanupRan = false
			const run = app.get(OuterJob)(
				{ id: 'a' },
				async (nested, { signal }) => {
					started.open()
					await aborted(signal)
					return nested(() => {
						cleanupRan = true
					}).catch((error: unknown) => error)
				},
				{ signal: caller.signal },
			)
			await started.promise
			caller.abort(reason)
			expect(await run).toBe(reason)
			expect(cleanupRan).toBe(false)
		})
	})

	test('aborting a run that waits on a shared creation stops the wait, not the creation', async () => {
		let created = 0
		const starting = gate()
		const ready = gate()
		const Pool = service('Pool', async () => {
			created++
			starting.open()
			await ready.promise
			return 'pool'
		})
		const Query = execution('Query', { scope: Task, entry: Pool })
		const Handler = service('Handler', { request: Request, query: Query }, ({ query }) => query)
		const app = await container().provide(Query, Handler).build()
		const caller = new AbortController()
		const reason = new Error('client went away')
		const waiting = app.get(Query)((pool) => pool, { signal: caller.signal })
		await starting.promise
		caller.abort(reason)
		await expect(waiting).rejects.toBe(reason)
		ready.open()
		const request = await app.open(PerRequest, bind(Request, { url: '/b' }))
		expect(await request.get(Handler)((pool) => pool)).toBe('pool')
		expect(created).toBe(1)
	})

	test('a run stops listening to the caller once it settles', async () => {
		const { opened, TaskJob } = fixture()
		opened.open()
		const app = await container().provide(TaskJob).build()
		const { signal } = new AbortController()
		let listeners = 0
		const add = signal.addEventListener.bind(signal)
		const remove = signal.removeEventListener.bind(signal)
		signal.addEventListener = (...args: Parameters<typeof add>) => {
			listeners++
			add(...args)
		}
		signal.removeEventListener = (...args: Parameters<typeof remove>) => {
			listeners--
			remove(...args)
		}
		for (const id of ['a', 'b', 'c']) await app.get(TaskJob)({ id }, (value) => value, { signal })
		await expect(
			app.get(TaskJob)({ id: 'd' }, () => Promise.reject(new Error('body failed')), { signal }),
		).rejects.toThrow('body failed')
		expect(listeners).toBe(0)
	})

	test('a signal from another realm or a polyfill works, judged by its shape', async () => {
		const { opened, TaskJob } = fixture()
		opened.open()
		const app = await container().provide(TaskJob).build()
		const target = new EventTarget()
		const foreign = Object.assign(target, { aborted: false, reason: undefined as unknown })
		const reason = new Error('foreign abort')
		const started = gate()
		const run = app.get(TaskJob)(
			{ id: 'a' },
			async (_id, { signal }) => {
				started.open()
				await aborted(signal)
				return signal.reason
			},
			{ signal: untyped(foreign) },
		)
		await started.promise
		foreign.aborted = true
		foreign.reason = reason
		foreign.dispatchEvent(new Event('abort'))
		expect(await run).toBe(reason)
	})

	test('options must carry an AbortSignal', async () => {
		const { opened, TaskJob } = fixture()
		opened.open()
		const app = await container().provide(TaskJob).build()
		const job = untyped(app.get(TaskJob))
		await expect(job({ id: 'a' }, () => {}, { signal: 'nope' })).rejects.toThrow(
			/options that are not an object with an AbortSignal 'signal'/,
		)
		await expect(job({ id: 'a' }, () => {}, 42)).rejects.toThrow(/AbortSignal/)
		expect(await job({ id: 'a' }, () => 'ok', {})).toBe('ok')
		expect(await job({ id: 'a' }, () => 'ok', { signal: undefined })).toBe('ok')
	})
})
