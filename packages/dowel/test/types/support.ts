/** Fixtures shared by the type-level tests. */

import { scope, service, slot } from '../../src/index.ts'

/** Groups assertions like a runtime test; the type tests are checked by tsc and never run. */
export function test(_name: string, _body: () => unknown): void {}

export interface LoggerApi {
	info(message: string): void
}

export const Logger = slot('Logger')<LoggerApi>()
export const PerRequest = scope('request')
export const Request = slot('Request', { scope: PerRequest })<{ url: string }>()
export const Session = slot('Session', { scope: PerRequest })<{ userId: string }>()

export const Config = service('Config', () => ({ dbUrl: 'postgres://' }))
export const Db = service('Db', { config: Config }, async ({ config }) => ({
	query: (s: string) => [config.dbUrl, s],
}))
export const Users = service('Users', { db: Db, log: Logger }, ({ db, log }) => ({
	list: () => {
		log.info('listing')
		return db.query('select')
	},
}))
export const CurrentUser = service(
	'CurrentUser',
	{ req: Request, users: Users },
	({ req, users }) => ({
		req,
		all: users.list(),
	}),
)
