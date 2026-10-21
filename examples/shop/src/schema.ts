/**
 * The tables the shop stores, and the record each holds. Storage is typed by
 * this map, so a table cannot be read as the wrong kind of record.
 */

import type { Product } from './domain/catalog'
import type { Order } from './domain/orders'
import type { User } from './domain/users'

export interface Tables {
	readonly products: Product
	readonly users: User
	readonly orders: Order
}
