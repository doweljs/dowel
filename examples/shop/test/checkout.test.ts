import { describe, expect, test } from 'bun:test'
import { bind, type Infer } from '@doweljs/core'
import { ProductRepository } from '../src/domain/catalog'
import { NotificationService } from '../src/domain/notifications'
import type { OrderItem } from '../src/domain/orders'
import { UserService } from '../src/domain/users'
import { type Charge, PaymentGateway } from '../src/infra/payments'
import { Metrics } from '../src/logging'
import { Checkout, PerRequest, Request, Session } from '../src/request'
import {
	FakeClock,
	FakeMailer,
	FakePaymentGateway,
	startTestApp,
	type TestApp,
	testApp,
} from './support'

/** A product in stock and a registered customer. */
async function seed(products: Infer<typeof ProductRepository>, users: Infer<typeof UserService>) {
	await products.seed([{ id: 'p', name: 'Thing', priceCents: 1000, stock: 5 }])
	return users.register('a@example.com', 'A')
}

async function checkout(app: TestApp, userId: string | null, items: readonly OrderItem[]) {
	await using request = await app.open(
		PerRequest,
		bind(Request, { id: 'req', method: 'POST', path: '/checkout', headers: {} }),
		bind(Session, { userId }),
	)
	return request.get(Checkout).placeOrder(items)
}

describe('checkout', () => {
	test('places an order, charges the card and emails a receipt', async () => {
		await using app = await startTestApp()
		const user = await seed(app.get(ProductRepository), app.get(UserService))

		const order = await checkout(app, user.id, [{ productId: 'p', quantity: 2 }])
		expect(order).toMatchObject({ status: 'paid', totalCents: 2000, chargeId: 'ch_fake_0' })
		expect((await app.get(ProductRepository).byId('p'))?.stock).toBe(3)

		expect(await app.get(NotificationService).deliverPending()).toBe(1)
		expect(app.get(FakeMailer).sent).toEqual([
			{ to: 'a@example.com', subject: `Receipt for ${order.id}`, body: 'Thanks, A!' },
		])
		expect(app.get(Metrics).snapshot()).toMatchObject({ 'orders.paid': 1, 'users.registered': 1 })
	})

	test('a declined charge gives the stock back and sends no receipt', async () => {
		const declining: PaymentGateway = {
			charge: async (_customerId, amountCents): Promise<Charge> => ({
				id: 'ch_no',
				amountCents,
				status: 'declined',
			}),
		}
		// Builders are persistent: one test swaps the gateway without touching the others.
		await using app = await testApp().override(PaymentGateway, declining).build()
		const user = await seed(app.get(ProductRepository), app.get(UserService))

		await using request = await app.open(
			PerRequest,
			bind(Request, { id: 'req', method: 'POST', path: '/checkout', headers: {} }),
			bind(Session, { userId: user.id }),
		)
		const order = await request.get(Checkout).placeOrder([{ productId: 'p', quantity: 1 }])
		expect(order.status).toBe('declined')
		expect((await app.get(ProductRepository).byId('p'))?.stock).toBe(5)
		expect(await app.get(NotificationService).deliverPending()).toBe(0)
	})

	test('night-time dynamic pricing is driven by the fake clock', async () => {
		await using app = await startTestApp()
		const user = await seed(app.get(ProductRepository), app.get(UserService))
		app.get(FakeClock).set(new Date('2026-01-01T23:30:00Z'))

		const order = await checkout(app, user.id, [{ productId: 'p', quantity: 1 }])
		expect(order.totalCents).toBe(900)
		expect(app.get(FakePaymentGateway).charges.map((charge) => charge.amountCents)).toEqual([900])
	})

	test('anonymous sessions cannot check out', async () => {
		await using app = await startTestApp()
		await expect(checkout(app, null, [{ productId: 'p', quantity: 1 }])).rejects.toThrow(
			'Not signed in',
		)
	})
})
