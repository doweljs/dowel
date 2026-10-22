import { describe, expect, test } from 'bun:test'
import { bind, container, DowelError, execution, scope, service, slot } from '../src/index.ts'
import { hotAccess } from '../src/runtime/hooks.ts'
import { gate, nextTask, PerRequest, Request, untyped } from './support.ts'

describe('services reached only through executions', () => {
	const JobScope = scope('job')
	const To = slot('To', { scope: JobScope })<string>()

	/** `Mailer` is reached only through `Send`; `Clock` is reached from `Api` directly. */
	function fixture(mailer: () => Promise<void> = async () => {}) {
		const events: string[] = []
		const Mailer = service('Mailer', async (ctx) => {
			events.push('mailer created')
			await mailer()
			ctx.defer(() => void events.push('mailer disposed'))
			return { send: (to: string) => `sent to ${to}` }
		})
		const Sender = service(
			'Sender',
			{ mailer: Mailer, to: To },
			({ mailer, to }) =>
				() =>
					mailer.send(to),
		)
		const Send = execution('Send', { scope: JobScope, entry: Sender, inputs: { to: To } })
		const Clock = service('Clock', (ctx) => {
			events.push('clock created')
			ctx.defer(() => void events.push('clock disposed'))
			return {}
		})
		const Api = service('Api', { send: Send, clock: Clock }, ({ send }) => ({
			send: (to: string) => send({ to }, (sender) => sender()),
		}))
		return { events, Mailer, Api }
	}

	test('build() leaves them to the first run that needs them, and later runs share it', async () => {
		const { events, Api } = fixture()
		const app = await container().provide(Api).build()
		expect(events).toEqual(['clock created'])
		expect(await app.get(Api).send('a')).toBe('sent to a')
		expect(await app.get(Api).send('b')).toBe('sent to b')
		expect(events).toEqual(['clock created', 'mailer created'])
		await app.dispose()
		// It belongs to the container, which disposes it in reverse creation order.
		expect(events.slice(2)).toEqual(['mailer disposed', 'clock disposed'])
	})

	test('concurrent first runs share one creation', async () => {
		const { events, Api } = fixture()
		const app = await container().provide(Api).build()
		const api = app.get(Api)
		expect(await Promise.all([api.send('a'), api.send('b')])).toEqual(['sent to a', 'sent to b'])
		expect(events.filter((event) => event === 'mailer created')).toHaveLength(1)
	})

	test('one that fails to start fails only the runs that need it, and is created again on the next demand', async () => {
		let attempts = 0
		const { events, Api } = fixture(async () => {
			if (++attempts === 1) throw new Error('mail server down')
		})
		const app = await container().provide(Api).build()
		await expect(app.get(Api).send('a')).rejects.toThrow('mail server down')
		expect(await app.get(Api).send('b')).toBe('sent to b')
		expect(attempts).toBe(2)
		await app.dispose()
		expect(events).toEqual([
			'clock created',
			'mailer created',
			'mailer created',
			'mailer disposed',
			'clock disposed',
		])
	})

	test('provided, one is created with the container and get() returns it', async () => {
		const { events, Mailer, Api } = fixture()
		const app = await container().provide(Api, Mailer).build()
		expect(events).toEqual(['mailer created', 'clock created'])
		expect(app.get(Mailer).send('c')).toBe('sent to c')
	})

	test('get() refuses one, since nothing created it with the container', async () => {
		const { Mailer, Api } = fixture()
		const app = await container().provide(Api).build()
		expect(() => untyped(app).get(Mailer)).toThrow(
			/'Mailer' is reached only through an execution.*Provide it/,
		)
	})

	test('in an opened scope, a run creates one in that scope, which disposes it', async () => {
		const events: string[] = []
		const Task = scope('task', PerRequest)
		const Audit = service('Audit', { request: Request }, ({ request }, ctx) => {
			events.push(`audit created for ${request.url}`)
			ctx.defer(() => void events.push('audit disposed'))
			return (what: string) => `${request.url}: ${what}`
		})
		const Record = execution('Record', { scope: Task, entry: Audit })
		const Handler = service('Handler', { request: Request, record: Record }, ({ record }) => ({
			handle: () => record((audit) => audit('handled')),
		}))
		const app = await container().provide(Handler).build()
		const request = await app.open(PerRequest, bind(Request, { url: '/a' }))
		expect(events).toEqual([])
		expect(await request.get(Handler).handle()).toBe('/a: handled')
		expect(await request.get(Handler).handle()).toBe('/a: handled')
		expect(events).toEqual(['audit created for /a'])
		await request.dispose()
		expect(events).toEqual(['audit created for /a', 'audit disposed'])
		await app.dispose()
	})

	test('disposing the container while a run creates one aborts it, waits for it and rejects the run', async () => {
		const starting = gate()
		const Slow = service('Slow', async (ctx) => {
			starting.open()
			await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve))
			return 'slow'
		})
		const Use = execution('Use', { scope: JobScope, entry: Slow })
		const app = await container().provide(Use).build()
		const running = app.get(Use)((slow) => slow)
		await starting.promise
		await app.dispose()
		const error = await running.then(
			() => null,
			(failure: unknown) => failure,
		)
		expect(error).toBeInstanceOf(DowelError)
		expect((error as DowelError).code).toBe('DISPOSED')
	})

	test('get() still returns values and runners only an execution reaches', async () => {
		const Config = slot('Config')<{ from: string }>()
		const Task = scope('task', PerRequest)
		const Audit = service('Audit', { config: Config, request: Request }, (deps) => deps)
		const Record = execution('Record', { scope: Task, entry: Audit })
		const Inner = execution('Inner', { scope: JobScope, entry: Config })
		const Outer = service('Outer', { inner: Inner }, ({ inner }) => inner)
		const OuterJob = execution('OuterJob', { scope: JobScope, entry: Outer })
		const Handler = service(
			'Handler',
			{ request: Request, record: Record, job: OuterJob },
			() => ({}),
		)
		const app = await container().provide(Handler).bind(Config, { from: 'config' }).build()
		expect(app.get(Config)).toEqual({ from: 'config' })
		expect(app.get(Inner)).toBeInstanceOf(Function)
		const request = await app.open(PerRequest, bind(Request, { url: '/a' }))
		expect(request.get(Request)).toEqual({ url: '/a' })
	})

	test('disposing the owner of a run waiting on a shared creation stops the wait, not the creation', async () => {
		let created = 0
		const starting = gate()
		const ready = gate()
		const Pool = service('Pool', async () => {
			created++
			starting.open()
			await ready.promise
			return 'pool'
		})
		const Task = scope('task', PerRequest)
		const Query = execution('Query', { scope: Task, entry: Pool })
		const Handler = service('Handler', { request: Request, query: Query }, ({ query }) => query)
		const app = await container().provide(Handler).build()
		const first = await app.open(PerRequest, bind(Request, { url: '/a' }))
		const waiting = first.get(Handler)((pool) => pool)
		await starting.promise
		// Disposal neither waits for the shared creation nor aborts it.
		await first.dispose()
		await expect(waiting).rejects.toThrow(/disposed before its body started/)
		ready.open()
		const second = await app.open(PerRequest, bind(Request, { url: '/b' }))
		expect(await second.get(Handler)((pool) => pool)).toBe('pool')
		expect(created).toBe(1)
	})

	test('a run leaves to a nested run what only the nested entry reaches', async () => {
		let attempts = 0
		const Smtp = service('Smtp', () => {
			attempts++
			throw new Error('bad credentials')
		})
		const Sub = scope('sub', JobScope)
		const Mail = execution('Mail', { scope: Sub, entry: Smtp })
		const Worker = service('Worker', { mail: Mail, to: To }, ({ mail, to }) => ({
			report: () => `no mail for ${to}`,
			mail: () => mail((smtp) => smtp),
		}))
		const Work = execution('Work', { scope: JobScope, entry: Worker, inputs: { to: To } })
		const app = await container().provide(Work).build()
		expect(await app.get(Work)({ to: 'a' }, (worker) => worker.report())).toBe('no mail for a')
		expect(attempts).toBe(0)
		await expect(app.get(Work)({ to: 'b' }, (worker) => worker.mail())).rejects.toThrow(
			'bad credentials',
		)
	})

	test("a run leaves to a nested run what only the nested entry reaches in the run's own scope", async () => {
		let attempts = 0
		const Smtp = service('Smtp', { to: To }, ({ to }) => {
			attempts++
			if (to === 'bad') throw new Error('bad credentials')
			return { send: () => `mailed ${to}` }
		})
		const Sub = scope('sub', JobScope)
		const Mail = execution('Mail', { scope: Sub, entry: Smtp })
		const Worker = service('Worker', { mail: Mail, to: To }, ({ mail, to }) => ({
			report: () => `report for ${to}`,
			mail: () => mail((smtp) => smtp.send()),
		}))
		const Work = execution('Work', { scope: JobScope, entry: Worker, inputs: { to: To } })
		const app = await container().provide(Work).build()
		expect(await app.get(Work)({ to: 'bad' }, (worker) => worker.report())).toBe('report for bad')
		expect(attempts).toBe(0)
		// Created in the outer run's store, which the nested runs share.
		expect(
			await app.get(Work)({ to: 'a' }, async (worker) => [
				await worker.mail(),
				await worker.mail(),
			]),
		).toEqual(['mailed a', 'mailed a'])
		expect(attempts).toBe(1)
	})

	test('what a run creates on demand in different scopes starts at once', async () => {
		const poolStarted = gate()
		const poolReady = gate()
		const auditStarted = gate()
		const Pool = service('Pool', async () => {
			poolStarted.open()
			await poolReady.promise
			return 'pool'
		})
		const Audit = service('Audit', { request: Request }, async ({ request }) => {
			auditStarted.open()
			return request.url
		})
		const Task = scope('task', PerRequest)
		const Both = service('Both', { pool: Pool, audit: Audit }, (deps) => deps)
		const Query = execution('Query', { scope: Task, entry: Both })
		const Handler = service('Handler', { request: Request, query: Query }, ({ query }) => query)
		const app = await container().provide(Handler).build()
		const request = await app.open(PerRequest, bind(Request, { url: '/a' }))
		const running = request.get(Handler)((both) => both)
		// The request-scoped service does not wait for the slow root one to finish.
		await Promise.all([poolStarted.promise, auditStarted.promise])
		poolReady.open()
		expect(await running).toEqual({ pool: 'pool', audit: '/a' })
	})

	test('get() reports a service in a scope it cannot see as not visible, before anything else', async () => {
		const Task = scope('task', PerRequest)
		const Audit = service('Audit', { request: Request }, ({ request }) => request.url)
		const Record = execution('Record', { scope: Task, entry: Audit })
		const Handler = service('Handler', { request: Request, record: Record }, () => ({}))
		const app = await container().provide(Handler).build()
		expect(() => untyped(app).get(Audit)).toThrow(/not visible from 'root'/)
	})

	test('a dependency failing synchronously leaves nothing unhandled or half-started behind', async () => {
		const unhandled: unknown[] = []
		const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
		process.on('unhandledRejection', onUnhandled)
		try {
			const Pool = service('Pool', async () => 'pool')
			const Broken = service('Broken', () => {
				throw new Error('misconfigured')
			})
			const Top = service('Top', { broken: Broken }, (deps) => deps)
			const Entry = service('Entry', { to: To, pool: Pool, top: Top }, (deps) => deps)
			const Use = execution('Use', { scope: JobScope, entry: Entry, inputs: { to: To } })
			const app = await container().provide(Use).build()
			for (const to of ['a', 'b', 'c']) {
				await expect(app.get(Use)({ to }, () => {})).rejects.toThrow('misconfigured')
			}
			await nextTask()
			expect(unhandled).toEqual([])
			// Retried on every run, the root does not keep a record of each failed attempt.
			expect(untyped(app)[hotAccess].root.starting.size).toBe(0)
		} finally {
			process.off('unhandledRejection', onUnhandled)
		}
	})

	test('get() reports one with its own error code', async () => {
		const { Mailer, Api } = fixture()
		const app = await container().provide(Api).build()
		let error: unknown
		try {
			untyped(app).get(Mailer)
		} catch (failure) {
			error = failure
		}
		expect((error as DowelError).code).toBe('CREATED_ON_DEMAND')
	})
})
