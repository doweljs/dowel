import { describe, expect, test } from 'bun:test'
import type { Infer } from '@doweljs/core'
import { type Product, ProductRepository } from '../src/domain/catalog'
import { normalizeItems, OrderService, priceItems } from '../src/domain/orders'
import { PaymentGateway } from '../src/infra/payments'
import { FakePaymentGateway, startTestApp, testApp } from './support'

const thing: Product = { id: 'p', name: 'Thing', priceCents: 1000, stock: 3 }

describe('order rules', () => {
	test('quantities must be positive whole numbers', () => {
		for (const quantity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => normalizeItems([{ productId: 'p', quantity }])).toThrow('positive whole number')
		}
		expect(() => normalizeItems([])).toThrow('at least one item')
	})

	test('repeated products are combined into one item', () => {
		expect(
			normalizeItems([
				{ productId: 'p', quantity: 1 },
				{ productId: 'q', quantity: 2 },
				{ productId: 'p', quantity: 3 },
			]),
		).toEqual([
			{ productId: 'p', quantity: 4 },
			{ productId: 'q', quantity: 2 },
		])
	})

	test('pricing checks each product exists and has the stock', () => {
		const products = new Map([['p', thing]])
		const price = (product: Product) => product.priceCents
		expect(priceItems([{ productId: 'p', quantity: 2 }], products, price)).toEqual({
			lines: [{ productId: 'p', quantity: 2, unitCents: 1000 }],
			totalCents: 2000,
		})
		expect(() => priceItems([{ productId: 'p', quantity: 4 }], products, price)).toThrow(
			'Out of stock',
		)
		expect(() => priceItems([{ productId: 'x', quantity: 1 }], products, price)).toThrow(
			'Unknown product',
		)
	})
})

describe('placing orders', () => {
	type Products = Infer<typeof ProductRepository>
	const stock = async (products: Products) => (await products.byId('p'))?.stock

	test('an invalid order charges nothing and changes nothing', async () => {
		await using app = await startTestApp()
		await app.get(ProductRepository).seed([thing])
		const orders = app.get(OrderService)
		await expect(orders.place('u', [{ productId: 'p', quantity: -2 }])).rejects.toThrow(
			'positive whole number',
		)
		// Two lines that each fit, but not together.
		await expect(
			orders.place('u', [
				{ productId: 'p', quantity: 2 },
				{ productId: 'p', quantity: 2 },
			]),
		).rejects.toThrow('Out of stock')
		expect(app.get(FakePaymentGateway).charges).toEqual([])
		expect(await stock(app.get(ProductRepository))).toBe(3)
		expect(await orders.history('u')).toEqual([])
	})

	test('concurrent checkouts cannot sell more than is in stock', async () => {
		await using app = await startTestApp()
		await app.get(ProductRepository).seed([thing])
		const orders = app.get(OrderService)
		const results = await Promise.allSettled(
			[2, 2].map((quantity) => orders.place('u', [{ productId: 'p', quantity }])),
		)
		expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
		expect(await stock(app.get(ProductRepository))).toBe(1)
		expect(app.get(FakePaymentGateway).charges).toHaveLength(1)
	})

	test('a charge that fails gives the stock back, and records the order as failed', async () => {
		const unreachable: PaymentGateway = {
			charge: async () => {
				throw new Error('payment provider unreachable')
			},
		}
		await using app = await testApp().override(PaymentGateway, unreachable).build()
		await app.get(ProductRepository).seed([thing])
		const orders = app.get(OrderService)
		await expect(orders.place('u', [{ productId: 'p', quantity: 1 }])).rejects.toThrow(
			'unreachable',
		)
		expect(await stock(app.get(ProductRepository))).toBe(3)
		expect((await orders.history('u')).map((order) => order.status)).toEqual(['failed'])
	})
})
