import { service } from '@doweljs/core'
import { Cache } from '../infra/cache'
import { Database } from '../infra/database'
import { IdGenerator } from '../infra/ids'
import { Logger, Metrics } from '../logging'

export interface User {
	readonly id: string
	readonly email: string
	readonly name: string
	readonly roles: readonly ('customer' | 'admin')[]
}

export const UserRepository = service(
	'UserRepository',
	{ db: Database, cache: Cache },
	({ db, cache }) => ({
		byId: async (id: string): Promise<User | undefined> => {
			const cached = cache.get<User>(`user:${id}`)
			if (cached) return cached
			const user = await db.table('users').get(id)
			if (user) cache.set(`user:${id}`, user)
			return user
		},
	}),
)

export const UserService = service(
	'UserService',
	{ users: UserRepository, db: Database, ids: IdGenerator, log: Logger, metrics: Metrics },
	({ users, db, ids, log, metrics }) => {
		const logger = log.child('users')
		return {
			/** Registers a user with a new id, unless the email has one already: emails are unique. */
			register: async (email: string, name: string): Promise<User> => {
				const { user, created } = await db.transaction(async (tx) => {
					const [existing] = await tx.table('users').find({ email })
					if (existing) return { user: existing, created: false }
					const user: User = { id: ids.next('usr'), email, name, roles: ['customer'] }
					await tx.table('users').insert(user)
					return { user, created: true }
				})
				if (created) {
					metrics.increment('users.registered')
					logger.info('registered', { email })
				}
				return user
			},
			find: users.byId,
		}
	},
)
