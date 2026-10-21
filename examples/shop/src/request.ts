import { scope, service, slot } from '@doweljs/core'
import { type OrderItem, OrderService } from './domain/orders'
import { type User, UserService } from './domain/users'
import { Logger } from './logging'

export interface IncomingRequest {
	readonly id: string
	readonly method: string
	readonly path: string
	readonly headers: Readonly<Record<string, string>>
}

export interface Session {
	readonly userId: string | null
}

/** One scope per request. */
export const PerRequest = scope('request')

/** Supplied when a container for a request opens; everything below becomes per-request automatically. */
export const Request = slot('Request', { scope: PerRequest })<IncomingRequest>()
export const Session = slot('Session', { scope: PerRequest })<Session>()

export const RequestLogger = service(
	'RequestLogger',
	{ log: Logger, req: Request },
	({ log, req }) => log.child(`${req.method} ${req.path} [${req.id}]`),
)

export const CurrentUser = service(
	'CurrentUser',
	{ session: Session, users: UserService, log: RequestLogger },
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
	{ auth: Authorization, orders: OrderService, log: RequestLogger },
	({ auth, orders, log }) => ({
		placeOrder: async (items: readonly OrderItem[]) => {
			const user = auth.require('customer')
			const order = await orders.place(user.id, items)
			log.info('checkout complete', { order: order.id })
			return order
		},
	}),
)
