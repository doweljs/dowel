/**
 * Exports one of every kind of thing users declare or build, so compiling
 * this with declarations on checks that each inferred type can be named
 * from the package entry alone.
 */
import {
	bind,
	type ContainerBuilder,
	type ContainerState,
	container,
	execution,
	optional,
	scope,
	service,
	slot,
} from '@doweljs/core'

export interface Logger {
	info(message: string): void
}

export const Log = slot('Log')<Logger>()
export const Session = scope('session')
export const PerRequest = scope('request', Session)
export const Req = slot('Req', { scope: PerRequest })<{ url: string }>()
export const Plugins = slot('Plugins', { many: true })<string>()

export const Db = service('Db', async (ctx) => {
	const pool = { query: (sql: string) => [sql], close: async () => {} }
	return ctx.adopt(pool, (p) => p.close())
})
export const Users = service('Users', { db: Db, log: Log, plugins: Plugins }, ({ db }) => ({
	list: () => db.query('select'),
}))
export const Current = service('Current', { req: Req, log: optional(Log) }, ({ req }) => req.url)
export const UnitOfWork = service('UnitOfWork', { db: Db }, ({ db }) => db, { scope: PerRequest })

export const Job = scope('job')
export const Input = slot('Input', { scope: Job })<number>()
export const Runner = service('Runner', { input: Input, users: Users }, ({ input }) => input)
export const Run = execution('Run', { scope: Job, entry: Runner, inputs: { input: Input } })
export const Plain = execution('Plain', { scope: Job, entry: Users })

export const consoleLog = bind(Log, console)
export const infra = <S extends ContainerState>(b: ContainerBuilder<S>) => b.bind(Log, console)
export const fakeDb = <S extends ContainerState>(b: ContainerBuilder<S>) =>
	b.override(Db, { query: (sql: string) => [sql], close: async () => {} })
export const builder = container()
	.with(infra)
	.provide(Users, Current, UnitOfWork, Run, Plain)
	.contribute(Plugins, 'a')
export const testing = builder.with(fakeDb)

export const app = await builder.build()
export const session = await app.open(Session)
export const request = await session.open(PerRequest, bind(Req, { url: '/' }))
export const run = app.get(Run)
