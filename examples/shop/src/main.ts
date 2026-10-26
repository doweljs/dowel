import { bind } from '@doweljs/core'
import { appBuilder } from './container'
import { CatalogService, ProductRepository } from './domain/catalog'
import { NotificationService } from './domain/notifications'
import { UserService } from './domain/users'
import { type Charge, PaymentGateway } from './infra/payments'
import { Logger, Metrics } from './logging'
import { Checkout, PerRequest, Request, Session } from './request'

const out = document.getElementById('out')
if (out === null) throw new Error('index.html has no #out element.')
out.textContent = ''
const print = (title: string, value: unknown) => {
	out.textContent += `\n== ${title}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`
}

// Stripe is not reachable from a demo page, so the payment gateway is
// overridden with one that approves every charge. Everything else is the
// production composition.
let charges = 0
const approveAll: PaymentGateway = {
	charge: async (_customerId, amountCents): Promise<Charge> => ({
		id: `ch_demo_${charges++}`,
		amountCents,
		status: 'succeeded',
	}),
}

const app = await appBuilder({
	env: 'development',
	databaseUrl: 'memory://shop',
	stripeKey: 'sk_live_demo',
	smtpHost: 'smtp.example',
	currency: 'USD',
})
	.override(PaymentGateway, approveAll)
	.build()

// Every edit evaluates this module again: the container built before is
// disposed, and the edited code builds the next one. The devtools see each.
if (import.meta.hot) {
	const { track } = await import('@doweljs/devtools/client')
	track(app)
	import.meta.hot.accept()
	import.meta.hot.dispose(() => app.dispose())
}

await app.get(ProductRepository).seed([
	{ id: 'p_tee', name: 'T-shirt', priceCents: 2500, stock: 10 },
	{ id: 'p_mug', name: 'Mug', priceCents: 1200, stock: 2 },
])
const alice = await app.get(UserService).register('alice@example.com', 'Alice')
print('catalog', await app.get(CatalogService).list())

// One scope per request. Scoped slots are supplied here; everything that
// depends on them is created per request and disposed with its container.
{
	await using request = await app.open(
		PerRequest,
		bind(Request, { id: 'req_1', method: 'POST', path: '/checkout', headers: {} }),
		bind(Session, { userId: alice.id }),
	)
	print('order', await request.get(Checkout).placeOrder([{ productId: 'p_tee', quantity: 2 }]))
}

print('delivered receipts', await app.get(NotificationService).deliverPending())
print('metrics', app.get(Metrics).snapshot())
print('log', app.get(Logger).lines.join('\n'))
