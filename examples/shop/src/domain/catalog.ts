import { service } from '@doweljs/core'
import { FeatureFlags } from '../config'
import { Clock } from '../infra/clock'
import { Database } from '../infra/database'

export interface Product {
	readonly id: string
	readonly name: string
	readonly priceCents: number
	readonly stock: number
}

export const ProductRepository = service('ProductRepository', { db: Database }, ({ db }) => ({
	all: () => db.table('products').find(),
	byId: (id: string) => db.table('products').get(id),
	seed: (products: readonly Product[]) =>
		db.transaction(async (tx) => {
			for (const product of products) await tx.table('products').insert(product)
		}),
}))

/** Prices depend on the time of day when dynamic pricing is on, so it needs a clock. */
export const PricingService = service(
	'PricingService',
	{ flags: FeatureFlags, clock: Clock },
	({ flags, clock }) => ({
		price: (product: Product): number => {
			if (!flags.dynamicPricing) return product.priceCents
			const hour = clock.now().getUTCHours()
			return hour >= 22 || hour < 6 ? Math.round(product.priceCents * 0.9) : product.priceCents
		},
	}),
)

export const CatalogService = service(
	'CatalogService',
	{ products: ProductRepository, pricing: PricingService },
	({ products, pricing }) => ({
		list: async () =>
			(await products.all()).map((product) => ({ ...product, priceCents: pricing.price(product) })),
		get: async (id: string) => {
			const product = await products.byId(id)
			return product ? { ...product, priceCents: pricing.price(product) } : undefined
		},
	}),
)
