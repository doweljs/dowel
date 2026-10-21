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
// The hot subpath resolves too; importing it last keeps hot replacement out of the run above.
const hot = await import('@doweljs/core/hot')
if (typeof hot.update !== 'function') throw new Error('@doweljs/core/hot does not export update()')
