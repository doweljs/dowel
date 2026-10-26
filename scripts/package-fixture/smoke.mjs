// Runs the installed package under Node, outside any TypeScript tooling.
import { bind, container, execution, scope, service, slot } from '@doweljs/core'

const PerRequest = scope('request')
const Req = slot('Req', { scope: PerRequest })()
const Job = scope('job')
const Input = slot('Input', { scope: Job })()
const closed = []
const Db = service('Db', async (ctx) => {
	ctx.defer(() => closed.push('db'))
	return { query: (sql) => sql }
})
const Current = service('Current', { req: Req, db: Db }, ({ req, db }) => db.query(req.url))
const Run = execution('Run', {
	scope: Job,
	entry: service('Double', { input: Input }, ({ input }) => input * 2),
	inputs: { input: Input },
})

const app = await container().provide(Current, Run).build()
const request = await app.open(PerRequest, bind(Req, { url: '/a' }))
const results = [request.get(Current), await app.get(Run)({ input: 21 }, (n) => n)]
await request.dispose()
await app.dispose()
const expected = JSON.stringify(['/a', 42, ['db']])
const actual = JSON.stringify([...results, closed])
if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`)

// A successor takes over, with what its predecessor's effect handed over.
const { prepare } = await import('@doweljs/core/evolve')
const port = (tag) =>
	service('Port', (ctx) => {
		ctx.whileActive((previous) => {
			closed.push(`${tag} from ${previous}`)
			return () => tag
		})
		return tag
	})
const first = await container().provide(port('first')).build()
const { container: second, generation } = await (
	await prepare(first, container().provide(port('second')))
).activate()
const evolved = JSON.stringify([generation, first.get(port('any')), closed.slice(1)])
await second.dispose()
if (evolved !== JSON.stringify([2, 'second', ['first from undefined', 'second from first']])) {
	throw new Error(`Evolution went wrong: ${evolved}`)
}
