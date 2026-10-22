import { describe, expect, test } from 'bun:test'
import { update } from '../../src/hot.ts'
import { container, execution, scope, service, slot } from '../../src/index.ts'
import { gate } from '../support.ts'
import { resetAfterEach } from './support.ts'

resetAfterEach()

describe('executions across replacements', () => {
	test('a service holding a runner is carried over, and its runs use the new generation', async () => {
		const Job = scope('job')
		const JobInput = slot('JobInput', { scope: Job })<string>()
		const Db = service('Db', () => ({ query: (id: string) => `row ${id}` }))
		const Runner = service('Runner', { input: JobInput, db: Db }, ({ input, db }) =>
			db.query(input),
		)
		const RunJob = execution('RunJob', { scope: Job, entry: Runner, inputs: { input: JobInput } })
		// Holds an exclusive resource, so it could not be recreated while the old instance lives.
		let listening = 0
		const Server = service('Server', { runJob: RunJob }, ({ runJob }, ctx) => {
			if (listening > 0) throw new Error('port in use')
			listening++
			ctx.defer(() => void listening--)
			return { handle: (id: string) => runJob({ input: id }, (row) => row) }
		})
		const Other = service('Other', () => 1)
		await update('scopes.ts', { Job, JobInput, Db })
		await update('runner.ts', { Runner })
		await update('server.ts', { RunJob, Server })
		await update('other.ts', { Other })
		const app = await container().provide(Server, Other).build()
		const server = app.get(Server)

		await update('other.ts', { Other: service('Other', () => 2) })
		expect(app.get(Server)).toBe(server)
		expect(await server.handle('a')).toBe('row a')

		const Runner2 = service('Runner', { input: JobInput, db: Db }, ({ input, db }) =>
			db.query(input).toUpperCase(),
		)
		await update('runner.ts', { Runner: Runner2 })
		expect(app.get(Server)).toBe(server)
		expect(await server.handle('b')).toBe('ROW B')
		expect(listening).toBe(1)
	})

	test('a discarded proposal disposes the runs it started', async () => {
		const log: string[] = []
		const Job = scope('job')
		const JobInput = slot('JobInput', { scope: Job })<string>()
		const Worker = service('Worker', { input: JobInput }, ({ input }, ctx) => {
			ctx.defer(() => void log.push(`worker ${input} disposed`))
			return input
		})
		const RunJob = execution('RunJob', { scope: Job, entry: Worker, inputs: { input: JobInput } })
		await update('jobs.ts', { Job, JobInput, Worker, RunJob })
		const Starter1 = service('Starter', () => 1)
		const Broken1 = service('Broken', () => 1)
		await update('m.ts', { Starter: Starter1, Broken: Broken1 })
		const app = await container().provide(Starter1, Broken1).build()

		const running = gate()
		const Starter = service('Starter', { run: RunJob }, ({ run }) => {
			run({ input: 'x' }, (_, { signal }) => {
				running.open()
				return new Promise((_, reject) =>
					signal.addEventListener('abort', () => reject(signal.reason)),
				)
			}).catch(() => {})
			return 2
		})
		// Fails once the run is under way, so discarding the proposal disposes it.
		const Broken = service('Broken', async () => {
			await running.promise
			throw new Error('broken')
		})
		await expect(update('m.ts', { Starter, Broken })).rejects.toThrow('broken')
		expect(log).toEqual(['worker x disposed'])
		expect(app.get(Starter1)).toBe(1)
	})

	test('an execution re-declared against a reloaded scope accepts inputs declared with the old one', async () => {
		const Job = scope('job')
		await update('scopes.ts', { Job })
		const JobInput = slot('JobInput', { scope: Job })<string>()
		await update('slots.ts', { JobInput })
		const declare = (job: typeof Job, version: number) => {
			const Runner = service('Runner', { input: JobInput }, ({ input }) => `${input}${version}`)
			const RunJob = execution('RunJob', { scope: job, entry: Runner, inputs: { input: JobInput } })
			const Scheduler = service('Scheduler', { runJob: RunJob }, ({ runJob }) => ({
				go: (id: string) => runJob({ input: id }, (out) => out),
			}))
			return { Runner, RunJob, Scheduler }
		}
		const v1 = declare(Job, 1)
		await update('jobs.ts', v1)
		const app = await container().provide(v1.Scheduler).build()

		const Job2 = scope('job')
		await update('scopes.ts', { Job: Job2 })
		await update('jobs.ts', declare(Job2, 2))
		expect(await app.get(v1.Scheduler).go('x')).toBe('x2')
	})

	test('a run that ignores its signal does not hold up later updates', async () => {
		const Job = scope('job')
		const JobInput = slot('JobInput', { scope: Job })<string>()
		const Worker = service('Worker', { input: JobInput }, ({ input }) => input)
		const RunJob = execution('RunJob', { scope: Job, entry: Worker, inputs: { input: JobInput } })
		const held = gate()
		const started = gate()
		const Starter = service('Starter', { run: RunJob }, ({ run }) => ({
			start: () =>
				run({ input: 'stubborn' }, () => {
					started.open()
					return held.promise
				}),
		}))
		const Other = service('Other', () => 1)
		await update('jobs.ts', { Job, JobInput, Worker, RunJob, Starter })
		await update('other.ts', { Other })
		const app = await container().provide(Starter, Other).build()
		const running = app.get(Starter).start()
		await started.promise

		let firstDone = false
		const first = update('other.ts', { Other: service('Other', () => 2) }).then(() => {
			firstDone = true
		})
		// Committed: the container runs the new generation while the old one waits for the run.
		await update('other.ts', { Other: service('Other', () => 3) })
		expect(app.get(Other)).toBe(3)
		expect(firstDone).toBe(false)

		held.open()
		await first
		await running
	})

	test('a run held open while a deferred rebuild tears down does not hold up later updates', async () => {
		const Job = scope('job')
		const JobInput = slot('JobInput', { scope: Job })<string>()
		const Worker = service('Worker', { input: JobInput }, ({ input }) => input)
		const RunJob = execution('RunJob', { scope: Job, entry: Worker, inputs: { input: JobInput } })
		const held = gate()
		const ready = gate()
		// Starts a run that will not finish, then finishes initializing when the test says so.
		const Starter = service('Starter', { run: RunJob }, async ({ run }) => {
			void run({ input: 'stubborn' }, () => held.promise)
			await ready.promise
			return 1
		})
		const Other = service('Other', () => 1)
		await update('jobs.ts', { Job, JobInput, Worker, RunJob, Starter })
		await update('other.ts', { Other })
		const building = container().provide(Starter, Other).build()

		// Re-declared while the container initializes, so it is rebuilt once ready.
		const rebuilding = gate()
		const Starter2 = service('Starter', { run: RunJob }, () => {
			rebuilding.open()
			return 2
		})
		await update('jobs.ts', { Job, JobInput, Worker, RunJob, Starter: Starter2 })
		ready.open()
		const app = await building
		await rebuilding.promise

		// Tearing down the old generation waits for the held run; this update does not.
		await update('other.ts', { Other: service('Other', () => 2) })
		expect(app.get(Starter)).toBe(2)
		expect(app.get(Other)).toBe(2)
		held.open()
	})

	test('a service a run created on demand is carried over when unchanged', async () => {
		const Job = scope('job')
		let created = 0
		const Mailer = service('Mailer', () => ({ id: ++created }))
		const Send = execution('Send', { scope: Job, entry: Mailer })
		const Api = service(
			'Api',
			{ send: Send },
			({ send }) =>
				() =>
					send((mailer) => mailer.id),
		)
		const Other = service('Other', () => 1)
		await update('mail.ts', { Job, Mailer, Send, Api })
		await update('other.ts', { Other })
		const app = await container().provide(Api, Other).build()
		expect(created).toBe(0)
		expect(await app.get(Api)()).toBe(1)

		await update('other.ts', { Other: service('Other', () => 2) })
		expect(await app.get(Api)()).toBe(1)
		expect(created).toBe(1)
	})

	test('a service a run creates on demand while an update initializes is carried over', async () => {
		const Job = scope('job')
		let created = 0
		const Mailer = service('Mailer', () => ({ id: ++created }))
		const Send = execution('Send', { scope: Job, entry: Mailer })
		const Api = service(
			'Api',
			{ send: Send },
			({ send }) =>
				() =>
					send((mailer) => mailer.id),
		)
		const Other = service('Other', () => 1)
		await update('mail.ts', { Job, Mailer, Send, Api })
		await update('other.ts', { Other })
		const app = await container().provide(Api, Other).build()

		const held = gate()
		const initializing = gate()
		const updating = update('other.ts', {
			Other: service('Other', async () => {
				initializing.open()
				await held.promise
				return 2
			}),
		})
		await initializing.promise
		// The run uses the committed generation while the proposal is still initializing.
		expect(await app.get(Api)()).toBe(1)
		held.open()
		await updating
		expect(app.get(Other)).toBe(2)
		expect(await app.get(Api)()).toBe(1)
		expect(created).toBe(1)
	})

	test('an instance created on demand during an update is not carried over with a replaced dependency', async () => {
		const Job = scope('job')
		const Db = service('Db', (ctx) => {
			const db = { closed: false }
			ctx.defer(() => {
				db.closed = true
			})
			return db
		})
		const Repo = service('Repo', { db: Db }, ({ db }) => ({ db }))
		const Query = execution('Query', { scope: Job, entry: Repo })
		const Api = service(
			'Api',
			{ query: Query },
			({ query }) =>
				() =>
					query((repo) => repo.db),
		)
		const Other = service('Other', () => 1)
		await update('repo.ts', { Job, Db, Repo, Query, Api })
		await update('other.ts', { Other })
		const app = await container().provide(Api, Other).build()

		// Other now depends on Db, so the proposal creates its own Db eagerly.
		const held = gate()
		const initializing = gate()
		const updating = update('other.ts', {
			Other: service('Other', { db: Db }, async () => {
				initializing.open()
				await held.promise
				return 2
			}),
		})
		await initializing.promise
		// Meanwhile a run creates Db and Repo on demand in the committed generation.
		const old = await app.get(Api)()
		held.open()
		await updating
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(old.closed).toBe(true)
		// Repo was created anew with the new generation's Db, not carried with the closed one.
		const current = await app.get(Api)()
		expect(current.closed).toBe(false)
		expect(current).not.toBe(old)
	})

	test('an update waits for what a run is still creating on demand, and carries it', async () => {
		const Job = scope('job')
		let created = 0
		const starting = gate()
		const ready = gate()
		const Mailer = service('Mailer', async () => {
			const id = ++created
			starting.open()
			await ready.promise
			return { id }
		})
		const Send = execution('Send', { scope: Job, entry: Mailer })
		const Api = service(
			'Api',
			{ send: Send },
			({ send }) =>
				() =>
					send((mailer) => mailer.id),
		)
		const Other = service('Other', () => 1)
		await update('mail.ts', { Job, Mailer, Send, Api })
		await update('other.ts', { Other })
		const app = await container().provide(Api, Other).build()
		const first = app.get(Api)()
		await starting.promise
		const updating = update('other.ts', { Other: service('Other', () => 2) })
		await new Promise((resolve) => setTimeout(resolve, 0))
		ready.open()
		await updating
		// The run belongs to the replaced generation, whose teardown may dispose it before its body.
		const outcome: unknown = await first.then(
			(id) => id,
			(error: { code?: string }) => error.code,
		)
		expect<unknown[]>([1, 'DISPOSED']).toContain(outcome)
		expect(await app.get(Api)()).toBe(1)
		expect(created).toBe(1)
	})

	test('an instance the proposal is still creating is not also carried over', async () => {
		const Job = scope('job')
		let created = 0
		const disposed: number[] = []
		const proposalHeld = gate()
		const Mailer = service('Mailer', async (ctx) => {
			const id = ++created
			// The first creation is the proposal's, which a run starts and does not wait for.
			if (id === 1) await proposalHeld.promise
			ctx.defer(() => void disposed.push(id))
			return { id }
		})
		const Send = execution('Send', { scope: Job, entry: Mailer })
		const Api = service(
			'Api',
			{ send: Send },
			({ send }) =>
				() =>
					send((mailer) => mailer.id),
		)
		const Other = service('Other', () => 1)
		await update('mail.ts', { Job, Mailer, Send, Api })
		await update('other.ts', { Other })
		const app = await container().provide(Api, Other).build()

		const held = gate()
		const initializing = gate()
		let proposalRun: Promise<number> | undefined
		const updating = update('other.ts', {
			Other: service('Other', { send: Send }, async ({ send }) => {
				proposalRun = send((mailer) => mailer.id)
				initializing.open()
				await held.promise
				return 2
			}),
		})
		await initializing.promise
		// The committed generation creates its own Mailer meanwhile.
		expect(await app.get(Api)()).toBe(2)
		held.open()
		await updating
		proposalHeld.open()
		expect(await proposalRun).toBe(1)
		await new Promise((resolve) => setTimeout(resolve, 0))
		// The committed generation's Mailer was not carried, so its teardown disposed it.
		expect(disposed).toEqual([2])
		expect(await app.get(Api)()).toBe(1)
	})
})
