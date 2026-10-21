import { describe, expect, test } from 'bun:test'
import { bind, container, DowelError, execution, scope, service, slot } from '../src/index.ts'
import { gate, PerRequest, Request, untyped } from './support.ts'

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
})
