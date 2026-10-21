import { optional, service } from '@doweljs/core'
import { Database, type Transaction } from '../infra/database'
import { IdGenerator } from '../infra/ids'
import { type Charge, PaymentGateway } from '../infra/payments'
import { Queue } from '../infra/queue'
import { Logger, Metrics } from '../logging'
import { PricingService, type Product } from './catalog'

/** What a customer asks for. */
export interface OrderItem {
	readonly productId: string
	readonly quantity: number
}

export interface OrderLine extends OrderItem {
	readonly unitCents: number
}

export interface Order {
	readonly id: string
	readonly userId: string
	readonly lines: readonly OrderLine[]
	readonly totalCents: number
	/** `pending` while the card is charged; `failed` when charging it threw. */
	readonly status: 'pending' | 'paid' | 'declined' | 'failed'
	readonly chargeId: string | null
}

/**
 * Checks and combines what a customer asked for: at least one item, each a
 * positive whole quantity, and one item per product.
 */
export function normalizeItems(items: readonly OrderItem[]): OrderItem[] {
	if (items.length === 0) throw new Error('An order needs at least one item.')
	const quantities = new Map<string, number>()
	for (const { productId, quantity } of items) {
		const total = (quantities.get(productId) ?? 0) + quantity
		if (!Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isSafeInteger(total)) {
			throw new Error(
				`The quantity of ${productId} must be a positive whole number; got ${quantity}.`,
			)
		}
		quantities.set(productId, total)
	}
	return [...quantities].map(([productId, quantity]) => ({ productId, quantity }))
}

/** Prices items against the products they name, each of which must exist and have the stock. */
export function priceItems(
	items: readonly OrderItem[],
	products: ReadonlyMap<string, Product>,
	price: (product: Product) => number,
): { lines: OrderLine[]; totalCents: number } {
	const lines = items.map(({ productId, quantity }): OrderLine => {
		const product = products.get(productId)
		if (product === undefined) throw new Error(`Unknown product ${productId}.`)
		if (product.stock < quantity) throw new Error(`Out of stock: ${product.name}.`)
		return { productId, quantity, unitCents: price(product) }
	})
	return { lines, totalCents: lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0) }
}

export const OrderRepository = service('OrderRepository', { db: Database }, ({ db }) => ({
	forUser: (userId: string) => db.table('orders').find({ userId }),
}))

export const OrderService = service(
	'OrderService',
	{
		orders: OrderRepository,
		pricing: PricingService,
		payments: PaymentGateway,
		queue: Queue,
		ids: IdGenerator,
		log: Logger,
		metrics: optional(Metrics),
		db: Database,
	},
	({ orders, pricing, payments, queue, ids, log, metrics, db }) => {
		const logger = log.child('orders')

		/** Prices the order and takes its stock in one transaction, so checkouts cannot oversell. */
		const reserve = (userId: string, items: readonly OrderItem[]): Promise<Order> =>
			db.transaction(async (tx) => {
				const products = await productsOf(tx, items)
				const { lines, totalCents } = priceItems(items, products, pricing.price)
				await adjustStock(tx, lines, -1)
				const order: Order = {
					id: ids.next('ord'),
					userId,
					lines,
					totalCents,
					status: 'pending',
					chargeId: null,
				}
				await tx.table('orders').insert(order)
				return order
			})

		/** Records how charging went, and gives back the stock of an order that was not paid. */
		const settle = (pending: Order, charge: Charge | null): Promise<Order> =>
			db.transaction(async (tx) => {
				const status =
					charge === null ? 'failed' : charge.status === 'succeeded' ? 'paid' : 'declined'
				if (status !== 'paid') await adjustStock(tx, pending.lines, +1)
				const outcome = { status, chargeId: charge?.id ?? null } as const
				await tx.table('orders').update(pending.id, outcome)
				return { ...pending, ...outcome }
			})

		return {
			/**
			 * Places an order. The card is charged outside any transaction, since
			 * rolling one back could not refund it: the stock is reserved first,
			 * and given back if the charge is declined or fails.
			 */
			place: async (userId: string, requested: readonly OrderItem[]): Promise<Order> => {
				const pending = await reserve(userId, normalizeItems(requested))
				let charge: Charge
				try {
					charge = await payments.charge(userId, pending.totalCents)
				} catch (error) {
					await settle(pending, null)
					throw error
				}
				const order = await settle(pending, charge)
				// Announced only once the payment is recorded.
				if (order.status === 'paid')
					await queue.enqueue({ kind: 'order.paid', orderId: order.id, userId })
				metrics?.increment(`orders.${order.status}`)
				logger.info('placed', { id: order.id, status: order.status, totalCents: order.totalCents })
				return order
			},
			history: orders.forUser,
		}
	},
)

async function productsOf(
	tx: Transaction,
	items: readonly OrderItem[],
): Promise<Map<string, Product>> {
	const products = new Map<string, Product>()
	for (const { productId } of items) {
		const product = await tx.table('products').get(productId)
		if (product !== undefined) products.set(productId, product)
	}
	return products
}

/** Takes (`-1`) or gives back (`+1`) the stock of each line. */
async function adjustStock(
	tx: Transaction,
	lines: readonly OrderLine[],
	direction: -1 | 1,
): Promise<void> {
	for (const { productId, quantity } of lines) {
		const product = await tx.table('products').get(productId)
		if (product !== undefined) {
			await tx.table('products').update(productId, { stock: product.stock + direction * quantity })
		}
	}
}
