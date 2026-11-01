import { scope, service, slot } from '@doweljs/core'
import { type OrderItem, Orders } from './domain/orders'
import { Accounts, type User } from './domain/users'
import { Logger } from './logging'

export interface IncomingRequest {
	readonly id: string
	readonly method: string
	readonly path: string
	readonly headers: Readonly<Record<string, string>>
}

export interface CurrentSession {
	readonly userId: string | null
}

/** One scope per request. */
export const PerRequest = scope('request')

/** Supplied when a container for a request opens; everything below becomes per-request automatically. */
export const CurrentRequest = slot('CurrentRequest', { scope: PerRequest })<IncomingRequest>()
export const CurrentSession = slot('CurrentSession', { scope: PerRequest })<CurrentSession>()

export const RequestLogger = service(
	'RequestLogger',
	{ log: Logger, req: CurrentRequest },
	({ log, req }) => log.child(`${req.method} ${req.path} [${req.id}]`),
)

export const CurrentUser = service(
	'CurrentUser',
	{ session: CurrentSession, users: Accounts, log: RequestLogger },
	async ({ session, users, log }): Promise<User | null> => {
		if (!session.userId) return null
		const user = (await users.find(session.userId)) ?? null
		log.info('resolved user', { user: user?.email ?? null })
		return user
	},
)

export const Authorization = service('Authorization', { user: CurrentUser }, ({ user }) => ({
	require: (role: User['roles'][number]) => {
		if (!user) throw new Error('Not signed in')
		if (!user.roles.includes(role)) throw new Error(`Requires role ${role}`)
		return user
	},
}))

/** Per-request facade used by route handlers. */
export const Checkout = service(
	'Checkout',
	{ auth: Authorization, orders: Orders, log: RequestLogger },
	({ auth, orders, log }) => ({
		placeOrder: async (items: readonly OrderItem[]) => {
			const user = auth.require('customer')
			const order = await orders.place(user.id, items)
			log.info('checkout complete', { order: order.id })
			return order
		},
	}),
)
